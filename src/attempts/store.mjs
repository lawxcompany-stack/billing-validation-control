import { createHash, randomUUID } from 'node:crypto';
import { validArtifact, validResourceIds, validWorkflow, verifyRecheckSnapshot } from '../contracts/attempt.mjs';
import { isValidExpectedEnvironment } from '../contracts/evidence.mjs';
import { providerIdempotencyKey, RETENTION_QUOTA_KEYS, validateRetentionConfiguration } from './prepare.mjs';

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

function exactDataRecord(value, expectedKeys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  let prototype;
  let keys;
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch { return null; }
  if ((prototype !== Object.prototype && prototype !== null) || keys.length !== expectedKeys.length ||
      keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))) return null;
  const values = Object.create(null);
  try {
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) return null;
      values[key] = descriptor.value;
    }
  } catch { return null; }
  return values;
}

function snapshotEnvironment(value) {
  const fields = exactDataRecord(value, ['database', 'deployment', 'stripe']);
  if (!fields) return null;
  const database = exactDataRecord(fields.database, ['projectRef', 'branchId']);
  const deployment = exactDataRecord(fields.deployment, ['id', 'origin']);
  const stripe = exactDataRecord(fields.stripe, ['accountId']);
  if (!database || !deployment || !stripe) return null;
  const snapshot = Object.freeze({
    database: Object.freeze({ projectRef: database.projectRef, branchId: database.branchId }),
    deployment: Object.freeze({ id: deployment.id, origin: deployment.origin }),
    stripe: Object.freeze({ accountId: stripe.accountId }),
  });
  return isValidExpectedEnvironment(snapshot) ? snapshot : null;
}

function snapshotWorkflow(value) {
  const fields = exactDataRecord(value, ['repository', 'ref', 'runId', 'runAttempt', 'runnerLabel']);
  if (!fields || !validWorkflow(fields)) return null;
  return Object.freeze({ repository: fields.repository, ref: fields.ref, runId: fields.runId,
    runAttempt: fields.runAttempt, runnerLabel: fields.runnerLabel });
}

function expectedEnvironmentSnapshot(adapter) {
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(adapter, 'expectedEnvironment'); }
  catch { refuse('store_client_invalid'); }
  if (!descriptor) {
    let prototype;
    try { prototype = Object.getPrototypeOf(adapter); }
    catch { refuse('store_client_invalid'); }
    while (prototype !== null) {
      let inherited;
      try { inherited = Object.getOwnPropertyDescriptor(prototype, 'expectedEnvironment'); }
      catch { refuse('store_client_invalid'); }
      if (inherited) refuse('store_client_invalid');
      try { prototype = Object.getPrototypeOf(prototype); }
      catch { refuse('store_client_invalid'); }
    }
    return null;
  }
  if (!Object.hasOwn(descriptor, 'value')) refuse('store_client_invalid');
  if (descriptor.value === undefined) return null;
  const snapshot = snapshotEnvironment(descriptor.value);
  if (!snapshot) refuse('store_client_invalid');
  return snapshot;
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

function resourceKeys(environment) {
  return [
    { resourceType: 'supabase_branch', resourceId:
      `${environment.database.projectRef}:${environment.database.branchId}` },
    { resourceType: 'stripe_account', resourceId: environment.stripe.accountId },
  ].sort((a, b) => `${a.resourceType}:${a.resourceId}`.localeCompare(`${b.resourceType}:${b.resourceId}`));
}

function assertResourceOwner(locks, row, lease, attemptId, fence) {
  if (!Array.isArray(locks) || locks.length !== 2) refuse('lease_fence_lost');
  const expected = resourceKeys(row.environment);
  for (const resource of expected) {
    const lock = locks.find((candidate) => candidate.resourceType === resource.resourceType &&
      candidate.resourceId === resource.resourceId);
    if (!lock || lock.attemptId !== attemptId || lock.fence !== fence ||
        lock.candidateSha !== row.candidateSha || lock.workflow?.repository !== lease.ownerRepository ||
        lock.workflow?.ref !== lease.ownerRef || lock.workflow?.runId !== lease.ownerRunId ||
        lock.workflow?.runAttempt !== lease.ownerRunAttempt ||
        lock.workflow?.runnerLabel !== row.workflow.runnerLabel ||
        !equal(lock.environment, row.environment) || lock.expiresAt !== lease.expiresAt) {
      refuse('lease_fence_lost');
    }
  }
}

function stripeIntentRequest(input) {
  const fields = ['attemptId', 'fence', 'candidateSha', 'workflow', 'environment', 'action',
    'operation', 'requestDigest', 'idempotencyKey'];
  const values = exactDataRecord(input, fields);
  if (!values || !safeId(values.attemptId) || typeof values.fence !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(values.fence) || !/^[a-f0-9]{40}$/.test(values.candidateSha ?? '') ||
      !validWorkflow(values.workflow) || !snapshotEnvironment(values.environment) ||
      !['checkout.replay', 'checkout_session.expire', 'subscription.cancel'].includes(values.action) ||
      !safeId(values.operation) || !/^[a-f0-9]{64}$/.test(values.requestDigest ?? '') ||
      values.idempotencyKey !== providerIdempotencyKey(values.attemptId, 'stripe', values.operation)) {
    refuse('stripe_intent_invalid');
  }
  return { ...values, environment: snapshotEnvironment(values.environment), workflow: { ...values.workflow } };
}

function snapshotObservation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  let keys;
  try { keys = Reflect.ownKeys(value); } catch { return null; }
  const required = ['accountId', 'livemode', 'operation', 'requestDigest', 'idempotencyKey', 'resourceIds'];
  const allowed = [...required, 'testClock'];
  if (keys.some((key) => typeof key !== 'string' || !allowed.includes(key)) ||
      required.some((key) => !keys.includes(key)) || (keys.length !== required.length &&
        !(keys.length === allowed.length && keys.includes('testClock')))) return null;
  const fields = exactDataRecord(value, keys);
  if (!fields || typeof fields.accountId !== 'string' || fields.livemode !== false ||
      !safeId(fields.operation) || !/^[a-f0-9]{64}$/.test(fields.requestDigest ?? '') ||
      typeof fields.idempotencyKey !== 'string') return null;
  const resourceIds = snapshotStripeResourceIds(fields.resourceIds);
  if (!resourceIds || resourceIds.length < 1 || new Set(resourceIds).size !== resourceIds.length) return null;
  let testClock;
  if (Object.hasOwn(fields, 'testClock')) {
    const clock = exactDataRecord(fields.testClock, ['id', 'deletes_after']);
    if (!clock || !/^clock_[A-Za-z0-9]+$/.test(clock.id ?? '') ||
        !Number.isSafeInteger(clock.deletes_after) || clock.deletes_after < 1) return null;
    testClock = { id: clock.id, deletes_after: clock.deletes_after };
  }
  return { accountId: fields.accountId, livemode: false, operation: fields.operation,
    requestDigest: fields.requestDigest, idempotencyKey: fields.idempotencyKey,
    resourceIds, ...(testClock ? { testClock } : {}) };
}

function snapshotStripeResourceIds(value) {
  if (!Array.isArray(value) || value.length > 100) return null;
  let prototype;
  let keys;
  try { prototype = Object.getPrototypeOf(value); keys = Reflect.ownKeys(value); }
  catch { return null; }
  if (prototype !== Array.prototype || keys.length !== value.length + 1 || !keys.includes('length')) return null;
  const result = [];
  for (let index = 0; index < value.length; index++) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, String(index)); } catch { return null; }
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true ||
        typeof descriptor.value !== 'string' ||
        !/^(?:cus|in|pi|sub|price|prod|evt|ch|re|pm|seti|cs)_[A-Za-z0-9_]{1,120}$/.test(descriptor.value) ||
        /(?:^|_)secret(?:_|$)/i.test(descriptor.value)) return null;
    result.push(descriptor.value);
  }
  return result;
}

function assertIntentObservation(intent, observation, now) {
  if (!observation || observation.accountId !== intent.accountId || observation.livemode !== false ||
      observation.operation !== intent.operation || observation.requestDigest !== intent.requestDigest ||
      observation.idempotencyKey !== intent.idempotencyKey) refuse('stripe_observation_mismatch');
  if (observation.testClock && observation.testClock.deletes_after <= now) {
    refuse('stripe_reconciliation_window_expired');
  }
}

async function assertFencedOwner(tx, row, lease, attemptId, fence, now) {
  assertOwner(lease, attemptId, fence, now);
  if (typeof tx.getResourceLocks !== 'function') {
    refuse('resource_lock_store_unavailable');
  }
  assertResourceOwner(await tx.getResourceLocks(row.environment), row, lease, attemptId, fence);
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
  const expectedEnvironment = expectedEnvironmentSnapshot(adapter);
  return {
    async prepare(input) {
      const retention = validateRetentionConfiguration(ownDataValue(input, 'retentionPolicy'),
        ownDataValue(input, 'projection'));
      const attemptId = ownDataValue(input, 'attemptId');
      const key = ownDataValue(input, 'key');
      const candidateSha = ownDataValue(input, 'candidateSha');
      const workflow = snapshotWorkflow(ownDataValue(input, 'workflow'));
      const environment = snapshotEnvironment(ownDataValue(input, 'environment'));
      const ttlSeconds = ownDataValue(input, 'ttlSeconds');
      if (!safeId(attemptId) || !validKey(key) || !/^[a-f0-9]{40}$/.test(candidateSha ?? '') ||
          !validTtl(ttlSeconds) || !validWorkflow(workflow) || !isValidExpectedEnvironment(environment) ||
          key.branchId !== environment.database.branchId ||
          (expectedEnvironment && !equal(environment, expectedEnvironment))) {
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
        if (typeof tx.lockResourceLocks !== 'function' || typeof tx.getResourceLocks !== 'function' ||
            typeof tx.putResourceLocks !== 'function' || typeof tx.hasInFlightStripeIntent !== 'function') {
          refuse('resource_lock_store_unavailable');
        }
        await tx.lockRetention(scope);
        await tx.lockResourceLocks(environment);
        if (existing) {
          const lease = await tx.getLease(key);
          if (lease?.attemptId === attemptId && lease.expiresAt > now) {
            if (existing.state !== 'collecting' || lease.candidateSha !== candidateSha ||
                lease.ownerRepository !== workflow.repository || lease.ownerRef !== workflow.ref ||
                lease.ownerRunId !== workflow.runId ||
                lease.ownerRunAttempt !== workflow.runAttempt) refuse('attempt_replay_not_owner');
            assertResourceOwner(await tx.getResourceLocks(environment), existing, lease, attemptId, lease.fence);
            const reservation = await tx.getRetentionReservationByAttempt(attemptId);
            if (!reservation) refuse('retention_reservation_missing');
            if (!sameUsage(reservation.quotas, retention.retentionPolicy.quotas) ||
                !sameUsage(reservation.projection, retention.projection)) refuse('attempt_replay_mismatch');
            if (await tx.getRetentionReceipt(reservation.reservationId)) refuse('retention_attempt_settled');
            return admissionResult(existing, lease.fence, reservation);
          }
          refuse('attempt_replay_expired');
        }
        const capacity = retentionCapacity(await tx.getRetentionUsage(scope),
          retention.retentionPolicy.quotas, retention.projection);
        const lease = await tx.getLease(key);
        if (lease?.expiresAt > now) refuse('lease_held');
        const previousLocks = await tx.getResourceLocks(environment);
        if (!Array.isArray(previousLocks)) refuse('resource_lock_ledger_invalid');
        const priorOwners = new Map();
        for (const lock of previousLocks) {
          const resource = resourceKeys(environment).find((candidate) =>
            candidate.resourceType === lock.resourceType && candidate.resourceId === lock.resourceId);
          if (!resource || !safeId(lock.attemptId) || typeof lock.fence !== 'string' ||
              !Number.isFinite(lock.expiresAt)) refuse('resource_lock_ledger_invalid');
          if (lock.expiresAt > now) refuse('resource_lock_held');
          const prior = await tx.getAttempt(lock.attemptId);
          if (!prior || !equal(prior.environment, lock.environment) ||
              prior.candidateSha !== lock.candidateSha || lock.workflow?.repository !== prior.workflow.repository ||
              lock.workflow?.ref !== prior.workflow.ref || lock.workflow?.runnerLabel !== prior.workflow.runnerLabel) {
            refuse('recovery_unverified');
          }
          const ownerLease = lease?.attemptId === prior.attemptId ? lease : await tx.getLease(prior.key);
          if (!ownerLease || ownerLease.attemptId !== prior.attemptId || ownerLease.fence !== lock.fence ||
              ownerLease.expiresAt !== lock.expiresAt || ownerLease.ownerRepository !== lock.workflow.repository ||
              ownerLease.ownerRef !== lock.workflow.ref || ownerLease.ownerRunId !== lock.workflow.runId ||
              ownerLease.ownerRunAttempt !== lock.workflow.runAttempt) refuse('recovery_unverified');
          priorOwners.set(prior.attemptId, { prior, lock, lease: ownerLease });
        }
        if (lease) {
          if (!previousLocks.some((lock) => lock.attemptId === lease.attemptId && lock.fence === lease.fence)) {
            refuse('recovery_unverified');
          }
          const prior = await tx.getAttempt(lease.attemptId);
          if (!prior || !equal(prior.key, key)) refuse('recovery_unverified');
          priorOwners.set(prior.attemptId, { prior, lease, lock: previousLocks.find((lock) =>
            lock.attemptId === lease.attemptId && lock.fence === lease.fence) });
        }
        for (const { prior, lock, lease: ownerLease } of priorOwners.values()) {
          if (await tx.hasInFlightStripeIntent(prior.attemptId)) refuse('recovery_unverified');
          const recovery = await adapter.verifyRecovery?.({ mode: 'takeover', prior,
            lease: ownerLease, resourceLock: lock });
          if (recovery?.runTerminal !== true || recovery.runnerRemoved !== true ||
              recovery.cleanupComplete !== true) refuse('recovery_unverified');
          const priorReservation = await tx.getRetentionReservationByAttempt(prior.attemptId);
          if (!priorReservation || !await tx.getRetentionReceipt(priorReservation.reservationId)) {
            refuse('recovery_unverified');
          }
          await tx.putAttempt({ ...prior, cleanupStatus: 'complete', updatedAt: now });
        }
        const fence = randomUUID();
        const row = { attemptId, key, candidateSha, workflow, environment, state: 'collecting',
          cleanupStatus: 'pending', artifact: null, resourceIds: [], createdAt: now, updatedAt: now };
        await tx.putAttempt(row);
        await tx.putResourceLocks({ attemptId, fence, candidateSha, workflow, environment,
          expiresAt: now + ttlSeconds }, previousLocks);
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
        const now = await tx.now();
        await tx.lockResourceLocks(row.environment);
        const lease = await tx.getLease(row.key);
        await assertFencedOwner(tx, row, lease, attemptId, fence, now);
        return { ...row, fence, expiresAt: lease.expiresAt, serverNow: now };
      });
    },
    async beginStripeIntent(input) {
      const request = stripeIntentRequest(input);
      return adapter.transaction(async (tx) => {
        await tx.lockAttempt(request.attemptId);
        const row = await tx.getAttempt(request.attemptId);
        if (!row) refuse('attempt_missing');
        if (typeof tx.lockResourceLocks !== 'function' || typeof tx.getResourceLocks !== 'function' ||
            typeof tx.getStripeIntentByOperation !== 'function' || typeof tx.insertStripeIntent !== 'function') {
          refuse('stripe_intent_store_unavailable');
        }
        await tx.lockResourceLocks(row.environment);
        const lease = await tx.getLease(row.key);
        const now = await tx.now();
        await assertFencedOwner(tx, row, lease, request.attemptId, request.fence, now);
        if (row.state === 'rechecking') refuse('recovery_read_only');
        if (request.candidateSha !== row.candidateSha || !equal(request.workflow, row.workflow) ||
            !equal(request.environment, row.environment) ||
            request.environment.stripe.accountId !== row.environment.stripe.accountId) {
          refuse('stripe_intent_identity_mismatch');
        }
        const prior = await tx.getStripeIntentByOperation(request.attemptId, request.operation);
        if (prior) refuse('stripe_intent_unresolved');
        const intent = { intentId: randomUUID(), attemptId: row.attemptId, fence: request.fence,
          candidateSha: row.candidateSha, workflow: row.workflow, environment: row.environment,
          accountId: row.environment.stripe.accountId, action: request.action,
          operation: request.operation, requestDigest: request.requestDigest,
          idempotencyKey: request.idempotencyKey, state: 'in_flight', createdAt: now };
        await tx.insertStripeIntent(intent);
        return intent;
      });
    },
    async getStripeIntent(intentId) {
      if (typeof intentId !== 'string' || !safeId(intentId)) refuse('stripe_intent_invalid');
      return adapter.transaction(async (tx) => {
        if (typeof tx.getStripeIntent !== 'function') refuse('stripe_intent_store_unavailable');
        return tx.getStripeIntent(intentId);
      });
    },
    async listPendingStripeIntents({ attemptId, fence } = {}) {
      if (!safeId(attemptId) || typeof fence !== 'string' || !/^[0-9a-f-]{36}$/i.test(fence)) {
        refuse('stripe_intent_invalid');
      }
      return adapter.transaction(async (tx) => {
        await tx.lockAttempt(attemptId);
        const row = await tx.getAttempt(attemptId);
        if (!row) refuse('attempt_missing');
        if (typeof tx.lockResourceLocks !== 'function' || typeof tx.getResourceLocks !== 'function' ||
            typeof tx.listPendingStripeIntents !== 'function') refuse('stripe_intent_store_unavailable');
        await tx.lockResourceLocks(row.environment);
        const lease = await tx.getLease(row.key);
        await assertFencedOwner(tx, row, lease, attemptId, fence, await tx.now());
        const pending = await tx.listPendingStripeIntents(attemptId);
        if (!Array.isArray(pending) || pending.some((intent) => !intent || intent.attemptId !== attemptId ||
            intent.state !== 'in_flight')) refuse('stripe_intent_store_unavailable');
        return pending.map((intent) => structuredClone(intent));
      });
    },
    async handoffStripeIntentRecovery({ attemptId, fence, ttlSeconds = 60 } = {}) {
      if (!safeId(attemptId) || typeof fence !== 'string' || !/^[0-9a-f-]{36}$/i.test(fence) ||
          !validTtl(ttlSeconds)) refuse('attempt_input_invalid');
      return adapter.transaction(async (tx) => {
        await tx.lockAttempt(attemptId);
        const row = await tx.getAttempt(attemptId);
        if (!row || !['complete', 'cancelled', 'timed_out'].includes(row.state) ||
            row.cleanupStatus === 'complete') refuse('recovery_unverified');
        if (typeof tx.lockResourceLocks !== 'function' || typeof tx.getResourceLocks !== 'function' ||
            typeof tx.listPendingStripeIntents !== 'function' ||
            typeof tx.getRetentionReservationByAttempt !== 'function' ||
            typeof tx.getRetentionReceipt !== 'function' || typeof tx.putLease !== 'function' ||
            typeof tx.putResourceLocks !== 'function') refuse('stripe_intent_store_unavailable');
        await tx.lockResourceLocks(row.environment);
        const lease = await tx.getLease(row.key);
        if (!lease || lease.attemptId !== attemptId || lease.fence !== fence) refuse('lease_fence_lost');
        const locks = await tx.getResourceLocks(row.environment);
        assertResourceOwner(locks, row, lease, attemptId, fence);
        const pendingIntents = await tx.listPendingStripeIntents(attemptId);
        if (!Array.isArray(pendingIntents) || pendingIntents.length === 0 ||
            pendingIntents.some((intent) => !intent || intent.attemptId !== attemptId ||
              intent.state !== 'in_flight')) refuse('recovery_unverified');
        const reservation = await tx.getRetentionReservationByAttempt(attemptId);
        if (!reservation || await tx.getRetentionReceipt(reservation.reservationId)) {
          refuse('recovery_unverified');
        }
        const recovery = await adapter.verifyRecovery?.({ mode: 'stripe-intent-recovery', prior: row,
          lease, resourceLocks: locks, pendingIntents: structuredClone(pendingIntents) });
        if (recovery?.runTerminal !== true || recovery.runnerRemoved !== true) refuse('recovery_unverified');
        const now = await tx.now();
        const nextFence = randomUUID();
        const renewed = { ...lease, fence: nextFence, expiresAt: now + ttlSeconds };
        await tx.putLease(renewed, lease.fence);
        await tx.putResourceLocks({ attemptId, fence: nextFence, candidateSha: row.candidateSha,
          workflow: row.workflow, environment: row.environment, expiresAt: renewed.expiresAt }, locks);
        const changed = { ...row, state: 'rechecking', updatedAt: now };
        await tx.putAttempt(changed);
        return { ...changed, fence: nextFence, expiresAt: renewed.expiresAt, serverNow: now };
      });
    },
    async reconcileStripeIntent({ attemptId, fence, intentId, observation: rawObservation } = {}) {
      if (!safeId(attemptId) || typeof fence !== 'string' || !safeId(intentId)) refuse('stripe_intent_invalid');
      const observation = snapshotObservation(rawObservation);
      if (!observation) refuse('stripe_observation_invalid');
      if (typeof adapter.verifyProviderObservation !== 'function') refuse('stripe_reconciliation_unverified');
      return adapter.transaction(async (tx) => {
        await tx.lockAttempt(attemptId);
        const row = await tx.getAttempt(attemptId);
        if (!row) refuse('attempt_missing');
        if (typeof tx.lockResourceLocks !== 'function' || typeof tx.getResourceLocks !== 'function' ||
            typeof tx.getStripeIntent !== 'function' || typeof tx.getStripeReceipt !== 'function' ||
            typeof tx.putStripeReceipt !== 'function') refuse('stripe_intent_store_unavailable');
        await tx.lockResourceLocks(row.environment);
        const lease = await tx.getLease(row.key);
        const now = await tx.now();
        await assertFencedOwner(tx, row, lease, attemptId, fence, now);
        const intent = await tx.getStripeIntent(intentId);
        if (!intent || intent.attemptId !== attemptId) refuse('stripe_intent_missing');
        if (row.state === 'rechecking' && intent.fence === fence) refuse('recovery_read_only');
        if (await tx.getStripeReceipt(intentId)) refuse('stripe_intent_already_reconciled');
        assertIntentObservation(intent, observation, now);
        const verified = await adapter.verifyProviderObservation({ intent, observation });
        if (verified !== true) refuse('stripe_reconciliation_unverified');
        const observed = { accountId: observation.accountId, livemode: false,
          operation: observation.operation, requestDigest: observation.requestDigest,
          idempotencyKey: observation.idempotencyKey,
          resourceIds: [...observation.resourceIds],
          ...(observation.testClock ? { testClock: observation.testClock } : {}) };
        const observationDigest = createHash('sha256').update(JSON.stringify(observed)).digest('hex');
        const receipt = { receiptId: randomUUID(), intentId, attemptId, fence,
          accountId: intent.accountId, operation: intent.operation,
          requestDigest: intent.requestDigest, idempotencyKey: intent.idempotencyKey,
          observationDigest, resourceIds: observed.resourceIds, observedAt: now };
        await tx.putStripeReceipt(receipt);
        return receipt;
      });
    },
    async fixtureMutation({ attemptId, fence }, mutation) {
      return adapter.transaction(async (tx) => {
        await tx.lockAttempt(attemptId);
        const row = await tx.getAttempt(attemptId);
        if (!row) refuse('attempt_missing');
        await tx.lockResourceLocks(row.environment);
        await assertFencedOwner(tx, row, await tx.getLease(row.key), attemptId, fence, await tx.now());
        if (row.state === 'rechecking') refuse('recovery_read_only');
        return tx.fixtureMutation(mutation);
      });
    },
    async renew({ attemptId, fence, ttlSeconds }) {
      if (!validTtl(ttlSeconds)) refuse('attempt_input_invalid');
      return adapter.transaction(async (tx) => {
        await tx.lockAttempt(attemptId);
        const row = await tx.getAttempt(attemptId);
        if (!row) refuse('attempt_missing');
        await tx.lockResourceLocks(row.environment);
        const lease = await tx.getLease(row.key);
        const now = await tx.now();
        await assertFencedOwner(tx, row, lease, attemptId, fence, now);
        const renewed = { ...lease, expiresAt: now + ttlSeconds };
        await tx.putLease(renewed, fence);
        const resourceLocks = await tx.getResourceLocks(row.environment);
        await tx.putResourceLocks({ attemptId, fence, candidateSha: row.candidateSha,
          workflow: resourceLocks[0]?.workflow, environment: row.environment,
          expiresAt: renewed.expiresAt }, resourceLocks);
        return { ...row, fence, expiresAt: now + ttlSeconds, serverNow: now };
      });
    },
    async transition({ attemptId, fence, from, to, artifact, resourceIds }) {
      return adapter.transaction(async (tx) => {
        await tx.lockAttempt(attemptId);
        const row = await tx.getAttempt(attemptId);
        if (!row) refuse('attempt_missing');
        await tx.lockResourceLocks(row.environment);
        await assertFencedOwner(tx, row, await tx.getLease(row.key), attemptId, fence, await tx.now());
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
        await tx.lockResourceLocks(row.environment);
        const lease = await tx.getLease(row.key);
        const now = await tx.now();
        if (!lease || lease.attemptId !== attemptId) refuse('lease_fence_lost');
        const locks = await tx.getResourceLocks(row.environment);
        assertResourceOwner(locks, row, lease, attemptId, lease.fence);
        if (typeof tx.hasInFlightStripeIntent !== 'function' ||
            await tx.hasInFlightStripeIntent(attemptId)) refuse('recovery_unverified');
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
        const renewed = { ...lease, fence, expiresAt: now + ttlSeconds,
          candidateSha, ownerRepository: recheckRun.repository, ownerRef: recheckRun.ref,
          ownerRunId: recheckRun.runId, ownerRunAttempt: recheckRun.runAttempt };
        await tx.putLease(renewed, lease.fence);
        await tx.putResourceLocks({ attemptId, fence, candidateSha: row.candidateSha,
          workflow: { ...row.workflow, runId: recheckRun.runId, runAttempt: recheckRun.runAttempt },
          environment: row.environment, expiresAt: renewed.expiresAt }, locks);
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
        await tx.lockResourceLocks(row.environment);
        const lease = await tx.getLease(row.key);
        await assertFencedOwner(tx, row, lease, attemptId, fence, await tx.now());
        if (!['complete', 'cancelled', 'timed_out'].includes(row.state)) refuse('cleanup_not_terminal');
        if (typeof tx.hasInFlightStripeIntent !== 'function' || await tx.hasInFlightStripeIntent(attemptId)) {
          refuse('stripe_intent_unresolved');
        }
        if (await adapter.verifyCleanup?.({ row, lease }) !== true) refuse('cleanup_unverified');
        const changed = { ...row, cleanupStatus: 'complete', updatedAt: await tx.now() };
        await tx.putAttempt(changed);
        await tx.deleteLease(row.key, attemptId, fence);
        await tx.deleteResourceLocks({ attemptId, fence, environment: row.environment });
        return changed;
      });
    },
  };
}
