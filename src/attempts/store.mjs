import { randomUUID } from 'node:crypto';
import { validArtifact, validResourceIds, validWorkflow, verifyRecheckSnapshot } from '../contracts/attempt.mjs';
import { isValidExpectedEnvironment } from '../contracts/evidence.mjs';

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

function assertOwner(lease, attemptId, fence, now) {
  if (!lease || lease.attemptId !== attemptId || lease.fence !== fence) refuse('lease_fence_lost');
  if (lease.expiresAt <= now) refuse('lease_expired');
}

export function createAttemptStore(adapter) {
  if (!adapter || typeof adapter.transaction !== 'function') refuse('store_client_invalid');
  return {
    async prepare(input) {
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
        const lease = await tx.getLease(key);
        if (existing) {
          if (!equal(existing.key, key) || existing.candidateSha !== candidateSha ||
              !equal(existing.workflow, workflow) || !equal(existing.environment, environment)) refuse('attempt_replay_mismatch');
          if (lease?.attemptId === attemptId && lease.expiresAt > now) {
            if (existing.state !== 'collecting' || lease.candidateSha !== candidateSha ||
                lease.ownerRepository !== workflow.repository || lease.ownerRef !== workflow.ref ||
                lease.ownerRunId !== workflow.runId ||
                lease.ownerRunAttempt !== workflow.runAttempt) refuse('attempt_replay_not_owner');
            return { ...existing, fence: lease.fence };
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
        const fence = randomUUID();
        const row = { attemptId, key, candidateSha, workflow, environment, state: 'collecting',
          cleanupStatus: 'pending', artifact: null, resourceIds: [], createdAt: now, updatedAt: now };
        await tx.putAttempt(row);
        await tx.putLease({ key, attemptId, fence, expiresAt: now + ttlSeconds,
          candidateSha, ownerRepository: workflow.repository, ownerRef: workflow.ref,
          ownerRunId: workflow.runId, ownerRunAttempt: workflow.runAttempt }, lease?.fence ?? null);
        return { ...row, fence };
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
