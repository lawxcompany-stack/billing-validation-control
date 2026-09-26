import { randomUUID } from 'node:crypto';
import { validArtifact, validResourceIds, validWorkflow, verifyRecheckSnapshot } from '../contracts/attempt.mjs';
import { isValidExpectedEnvironment } from '../contracts/evidence.mjs';
import { RETENTION_QUOTA_KEYS, validateRetentionConfiguration } from './prepare.mjs';

export class AttemptRefusal extends Error {
  constructor(code) { super(code); this.name = 'AttemptRefusal'; this.code = code; }
}

export function refuse(code) { throw new AttemptRefusal(code); }

const transitions = {
  collecting: new Set(['collected', 'cancelled', 'timed_out']),
  collected: new Set(['cancelled', 'timed_out']),
  rechecking: new Set(['complete', 'cancelled', 'timed_out']),
};

function equal(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function safeId(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/.test(value); }
function validKey(key) { return key && ['branchId', 'suite', 'fixtureKey'].every((name) => safeId(key[name])) && Object.keys(key).length === 3; }
function validTtl(value) { return Number.isInteger(value) && value >= 1 && value <= 3600; }

function retentionScope(environment) {
  return { projectRef: environment.database.projectRef, branchId: environment.database.branchId,
    stripeAccountId: environment.stripe.accountId };
}

function ownDataValue(value, key) {
  if (value === null || typeof value !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch { return undefined; }
}

function snapshotUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  let keys;
  try { keys = Reflect.ownKeys(value); } catch { return null; }
  if (keys.length !== RETENTION_QUOTA_KEYS.length ||
      keys.some((key) => typeof key !== 'string' || !RETENTION_QUOTA_KEYS.includes(key))) return null;
  const usage = {};
  for (const key of RETENTION_QUOTA_KEYS) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { return null; }
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable ||
        !Number.isSafeInteger(descriptor.value) || descriptor.value < 0) return null;
    usage[key] = descriptor.value;
  }
  return usage;
}

function sameUsage(left, right) {
  const a = snapshotUsage(left);
  const b = snapshotUsage(right);
  return Boolean(a && b && RETENTION_QUOTA_KEYS.every((key) => a[key] === b[key]));
}

function retentionCapacity(usage, quotas, projection) {
  if (!usage || typeof usage !== 'object') refuse('retention_ledger_invalid');
  let keys;
  try { keys = Reflect.ownKeys(usage); } catch { refuse('retention_ledger_invalid'); }
  if (keys.length !== 3 || keys.some((key) => !['committed', 'reserved', 'policyLimits'].includes(key))) {
    refuse('retention_ledger_invalid');
  }
  const committed = snapshotUsage(ownDataValue(usage, 'committed'));
  const reserved = snapshotUsage(ownDataValue(usage, 'reserved'));
  if (!committed || !reserved) refuse('retention_ledger_invalid');
  const priorPolicy = ownDataValue(usage, 'policyLimits');
  if (priorPolicy !== null) {
    const pinned = snapshotUsage(priorPolicy);
    if (!pinned || RETENTION_QUOTA_KEYS.some((key) => pinned[key] < 1)) refuse('retention_ledger_invalid');
    if (!equal(pinned, quotas)) refuse('retention_policy_mismatch');
  }
  const projected = {};
  const remaining = {};
  for (const key of RETENTION_QUOTA_KEYS) {
    const total = committed[key] + reserved[key] + projection[key];
    if (!Number.isSafeInteger(total)) refuse('retention_ledger_invalid');
    if (total > quotas[key]) refuse('retention_capacity_exceeded');
    projected[key] = total;
    remaining[key] = quotas[key] - total;
  }
  return Object.freeze({ quotas, committed: Object.freeze(committed), reserved: Object.freeze(reserved),
    requested: projection, projected: Object.freeze(projected), remaining: Object.freeze(remaining) });
}

function terminalRequest(input) {
  const keys = ['reservationId', 'outcome', 'retained'];
  if (!input || typeof input !== 'object' || Array.isArray(input)) refuse('retention_receipt_invalid');
  let ownKeys;
  try { ownKeys = Reflect.ownKeys(input); } catch { refuse('retention_receipt_invalid'); }
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) {
    refuse('retention_receipt_invalid');
  }
  const values = Object.create(null);
  try {
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
        refuse('retention_receipt_invalid');
      }
      values[key] = descriptor.value;
    }
  } catch { refuse('retention_receipt_invalid'); }
  const retained = snapshotUsage(values.retained);
  if (!safeId(values.reservationId) || !['completed', 'failed', 'cancelled', 'timed_out'].includes(values.outcome) ||
      !retained || retained.attempts !== 1) refuse('retention_receipt_invalid');
  return { reservationId: values.reservationId, outcome: values.outcome, retained };
}

function assertOwner(lease, attemptId, fence, now) {
  if (!lease || lease.attemptId !== attemptId || lease.fence !== fence) refuse('lease_fence_lost');
  if (lease.expiresAt <= now) refuse('lease_expired');
}

function admissionResult(row, fence, reservation) {
  const result = { ...row, fence };
  Object.defineProperties(result, {
    reservationId: { value: reservation.reservationId, enumerable: false },
    capacity: { value: reservation.capacity, enumerable: false },
  });
  return result;
}

export function createAttemptStore(adapter) {
  if (!adapter || typeof adapter.transaction !== 'function') refuse('store_client_invalid');
  return {
    async prepare(input) {
      const retention = validateRetentionConfiguration(ownDataValue(input, 'retentionPolicy'),
        ownDataValue(input, 'projection'));
      const { attemptId, key, candidateSha, workflow, environment, ttlSeconds } = input ?? {};
      if (!safeId(attemptId) || !validKey(key) || !/^[a-f0-9]{40}$/.test(candidateSha ?? '') ||
          !validTtl(ttlSeconds) || !validWorkflow(workflow) || !isValidExpectedEnvironment(environment) ||
          key.branchId !== environment.database.branchId ||
          (adapter.expectedEnvironment && (
            environment.database.projectRef !== adapter.expectedEnvironment.database.projectRef ||
            environment.database.branchId !== adapter.expectedEnvironment.database.branchId ||
            environment.deployment.id !== adapter.expectedEnvironment.deployment.id ||
            environment.deployment.origin !== adapter.expectedEnvironment.deployment.origin ||
            environment.stripe.accountId !== adapter.expectedEnvironment.stripe.accountId))) {
        refuse('attempt_input_invalid');
      }
      return adapter.transaction(async (tx) => {
        await tx.lockAttempt(attemptId);
        const now = await tx.now();
        const existing = await tx.getAttempt(attemptId);
        if (existing && (!equal(existing.key, key) || existing.candidateSha !== candidateSha ||
            !equal(existing.workflow, workflow) || !equal(existing.environment, environment))) {
          refuse('attempt_replay_mismatch');
        }
        const scope = retentionScope(environment);
        if (typeof tx.lockRetention !== 'function' || typeof tx.getRetentionUsage !== 'function' ||
            typeof tx.getRetentionReservationByAttempt !== 'function' ||
            typeof tx.getRetentionReceipt !== 'function' || typeof tx.putRetentionReservation !== 'function') {
          refuse('retention_store_unavailable');
        }
        await tx.lockRetention(scope);
        const lease = await tx.getLease(key);
        if (existing) {
          if (lease?.attemptId === attemptId && lease.expiresAt > now) {
            if (existing.state !== 'collecting' || lease.candidateSha !== candidateSha ||
                lease.ownerRepository !== workflow.repository || lease.ownerRef !== workflow.ref ||
                lease.ownerRunId !== workflow.runId ||
                lease.ownerRunAttempt !== workflow.runAttempt) refuse('attempt_replay_not_owner');
            const reservation = await tx.getRetentionReservationByAttempt(attemptId);
            if (!reservation) refuse('retention_reservation_missing');
            if (!sameUsage(reservation.quotas, retention.retentionPolicy.quotas) ||
                !sameUsage(reservation.projection, retention.projection)) refuse('attempt_replay_mismatch');
            if (await tx.getRetentionReceipt(reservation.reservationId)) refuse('retention_attempt_settled');
            return admissionResult(existing, lease.fence, reservation);
          }
          refuse('attempt_replay_expired');
        }
        if (lease) {
          if (lease.expiresAt > now) refuse('lease_held');
          const prior = await tx.getAttempt(lease.attemptId);
          if (!prior || !equal(prior.key, key)) refuse('recovery_unverified');
          const recovery = await adapter.verifyRecovery?.({ mode: 'takeover', prior, lease });
          if (recovery?.runTerminal !== true || recovery.runnerRemoved !== true ||
              recovery.cleanupComplete !== true) refuse('recovery_unverified');
          await tx.putAttempt({ ...prior, cleanupStatus: 'complete', updatedAt: now });
        }
        const capacity = retentionCapacity(await tx.getRetentionUsage(scope),
          retention.retentionPolicy.quotas, retention.projection);
        const fence = randomUUID();
        const row = { attemptId, key, candidateSha, workflow, environment, state: 'collecting',
          cleanupStatus: 'pending', artifact: null, resourceIds: [], createdAt: now, updatedAt: now };
        await tx.putAttempt(row);
        const reservation = { reservationId: randomUUID(), attemptId, scope,
          policyVersion: retention.retentionPolicy.version,
          quotas: retention.retentionPolicy.quotas, projection: retention.projection,
          capacity, createdAt: now };
        await tx.putRetentionReservation(reservation);
        await tx.putLease({ key, attemptId, fence, expiresAt: now + ttlSeconds,
          candidateSha, ownerRepository: workflow.repository, ownerRef: workflow.ref,
          ownerRunId: workflow.runId, ownerRunAttempt: workflow.runAttempt }, lease?.fence ?? null);
        return admissionResult(row, fence, reservation);
      });
    },
    async reconcileReservation(input) {
      const request = terminalRequest(input);
      if (typeof adapter.verifyRetentionReceipt !== 'function') refuse('retention_reconciliation_unverified');
      return adapter.transaction(async (tx) => {
        if (typeof tx.getRetentionReservation !== 'function' || typeof tx.getRetentionReceipt !== 'function' ||
            typeof tx.lockRetention !== 'function' || typeof tx.putRetentionReceipt !== 'function') {
          refuse('retention_store_unavailable');
        }
        const reservation = await tx.getRetentionReservation(request.reservationId);
        if (!reservation) refuse('retention_reservation_missing');
        await tx.lockRetention(reservation.scope);
        const existing = await tx.getRetentionReceipt(reservation.reservationId);
        if (existing) {
          if (existing.outcome !== request.outcome || !equal(existing.retained, request.retained)) {
            refuse('retention_already_settled');
          }
          return existing;
        }
        const projection = snapshotUsage(reservation.projection);
        if (!projection) refuse('retention_ledger_invalid');
        for (const key of RETENTION_QUOTA_KEYS) {
          if (request.retained[key] > projection[key]) refuse('retention_receipt_exceeds_reservation');
        }
        const verification = await adapter.verifyRetentionReceipt({ reservation,
          receipt: { reservationId: request.reservationId, attemptId: reservation.attemptId,
            outcome: request.outcome, retained: request.retained } });
        if (verification !== true) refuse('retention_reconciliation_unverified');
        const receipt = { receiptId: randomUUID(), reservationId: reservation.reservationId,
          attemptId: reservation.attemptId, scope: reservation.scope, outcome: request.outcome,
          retained: request.retained, createdAt: await tx.now() };
        await tx.putRetentionReceipt(receipt);
        return receipt;
      });
    },
    async getAttempt(attemptId) { return adapter.transaction((tx) => tx.getAttempt(attemptId)); },
    async assertFence({ attemptId, fence }) {
      return adapter.transaction(async (tx) => {
        await tx.lockAttempt(attemptId);
        const row = await tx.getAttempt(attemptId);
        if (!row) refuse('attempt_missing');
        const lease = await tx.getLease(row.key);
        const now = await tx.now();
        assertOwner(lease, attemptId, fence, now);
        return { ...row, expiresAt: lease.expiresAt, serverNow: now };
      });
    },
    async fixtureMutation({ attemptId, fence }, mutation) {
      return adapter.transaction(async (tx) => {
        await tx.lockAttempt(attemptId);
        const row = await tx.getAttempt(attemptId);
        if (!row) refuse('attempt_missing');
        assertOwner(await tx.getLease(row.key), attemptId, fence, await tx.now());
        return tx.fixtureMutation(mutation);
      });
    },
    async renew({ attemptId, fence, ttlSeconds }) {
      if (!validTtl(ttlSeconds)) refuse('attempt_input_invalid');
      return adapter.transaction(async (tx) => {
        await tx.lockAttempt(attemptId);
        const row = await tx.getAttempt(attemptId);
        if (!row) refuse('attempt_missing');
        const lease = await tx.getLease(row.key);
        const now = await tx.now();
        assertOwner(lease, attemptId, fence, now);
        await tx.putLease({ ...lease, expiresAt: now + ttlSeconds }, fence);
        return { ...row, fence, expiresAt: now + ttlSeconds, serverNow: now };
      });
    },
    async transition({ attemptId, fence, from, to, artifact, resourceIds }) {
      return adapter.transaction(async (tx) => {
        await tx.lockAttempt(attemptId);
        const row = await tx.getAttempt(attemptId);
        if (!row) refuse('attempt_missing');
        assertOwner(await tx.getLease(row.key), attemptId, fence, await tx.now());
        if (row.state !== from || !transitions[from]?.has(to)) refuse('invalid_transition');
        if ((artifact !== undefined && !validArtifact(artifact)) ||
            (resourceIds !== undefined && !validResourceIds(resourceIds)) ||
            (to === 'collected' && !artifact)) refuse('attempt_input_invalid');
        const changed = { ...row, state: to, updatedAt: await tx.now(),
          artifact: artifact ?? row.artifact, resourceIds: resourceIds ?? row.resourceIds };
        await tx.putAttempt(changed);
        return { ...changed, fence };
      });
    },
    async resumeRecheck({ attemptId, artifact, snapshot, artifactId, artifactDigest, workflow,
      environment, candidateSha, currentHeadSha, recheckRun, ttlSeconds = 60 }) {
      return adapter.transaction(async (tx) => {
        await tx.lockAttempt(attemptId);
        const row = await tx.getAttempt(attemptId);
        if (!row || row.state !== 'collected') refuse('invalid_transition');
        const lease = await tx.getLease(row.key);
        const now = await tx.now();
        if (!lease || lease.attemptId !== attemptId) refuse('lease_fence_lost');
        const recovery = await adapter.verifyRecovery?.({ mode: 'resume', prior: row, lease });
        if (recovery?.runTerminal !== true || recovery.runnerRemoved !== true) refuse('recovery_unverified');
        verifyRecheckSnapshot(snapshot, { row, workflow, environment, candidateSha,
          currentHeadSha, artifactId, artifactDigest });
        if (!recheckRun || Object.keys(recheckRun).length !== 4 ||
            recheckRun.repository !== row.workflow.repository || recheckRun.ref !== row.workflow.ref ||
            !/^[1-9][0-9]{0,19}$/.test(recheckRun.runId ?? '') ||
            !Number.isSafeInteger(recheckRun.runAttempt) || recheckRun.runAttempt < 1 ||
            recheckRun.runId === row.workflow.runId) refuse('recheck_identity_mismatch');
        if (!equal(row.workflow, workflow) || !equal(row.environment, environment) ||
            row.candidateSha !== candidateSha || currentHeadSha !== candidateSha ||
            !equal(row.artifact, artifact)) refuse('recheck_identity_mismatch');
        if (!validTtl(ttlSeconds)) refuse('attempt_input_invalid');
        const fence = randomUUID();
        await tx.putLease({ ...lease, fence, expiresAt: now + ttlSeconds,
          candidateSha, ownerRepository: recheckRun.repository, ownerRef: recheckRun.ref,
          ownerRunId: recheckRun.runId, ownerRunAttempt: recheckRun.runAttempt }, lease.fence);
        const changed = { ...row, state: 'rechecking', updatedAt: now };
        await tx.putAttempt(changed);
        return { ...changed, fence };
      });
    },
    async cleanup({ attemptId, fence }) {
      return adapter.transaction(async (tx) => {
        await tx.lockAttempt(attemptId);
        const row = await tx.getAttempt(attemptId);
        if (!row) refuse('attempt_missing');
        const lease = await tx.getLease(row.key);
        assertOwner(lease, attemptId, fence, await tx.now());
        if (!['complete', 'cancelled', 'timed_out'].includes(row.state)) refuse('cleanup_not_terminal');
        if (await adapter.verifyCleanup?.({ row, lease }) !== true) refuse('cleanup_unverified');
        const changed = { ...row, cleanupStatus: 'complete', updatedAt: await tx.now() };
        await tx.putAttempt(changed);
        await tx.deleteLease(row.key, attemptId, fence);
        return changed;
      });
    },
  };
}
