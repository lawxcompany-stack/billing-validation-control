import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAttemptStore } from '../../src/attempts/store.mjs';
import { prepareAttempt } from '../../src/attempts/prepare.mjs';
import { resumeRecheck, recheckAttempt } from '../../src/attempts/recheck.mjs';
import { cleanupAttempt } from '../../src/attempts/cleanup.mjs';
import { withExternalFence, withFixtureMutation, withRenewingLease } from '../../src/attempts/lock.mjs';
import { createSnapshot } from '../../src/contracts/attempt.mjs';
import { providerIdempotencyKey } from '../../src/attempts/prepare.mjs';

const environment = {
  database: { projectRef: 'abcdefghijklmnopqrst', branchId: 'validation-child-1' },
  deployment: { id: 'dpl_candidate123', origin: 'https://candidate.vercel.app' },
  stripe: { accountId: 'acct_synthetic123' },
};
const key = { branchId: 'validation-child-1', suite: 'billing', fixtureKey: 'invoice-a' };
const shaA = 'a'.repeat(40);
const shaB = 'b'.repeat(40);
const retentionPolicy = { version: 1, quotas: {
  attempts: 20, databaseRows: 200, authUsers: 20, stripeObjects: 200,
} };
const projection = { attempts: 1, databaseRows: 10, authUsers: 1, stripeObjects: 10 };
const recheckRun = { repository: 'lawxcompany-stack/billing-validation-control',
  ref: 'refs/heads/main', runId: '200', runAttempt: 1 };

function input(attemptId = 'attempt-a', candidateSha = shaA, fixtureKey = 'invoice-a') {
  return { attemptId, key: { ...key, fixtureKey }, candidateSha, workflow: {
    repository: 'lawxcompany-stack/billing-validation-control', ref: 'refs/heads/main',
    runId: '100', runAttempt: 1, runnerLabel: `billing-validation-${'a'.repeat(32)}`,
  }, environment, ttlSeconds: 60, retentionPolicy, projection };
}

function fakeAdapter({ trustedRecovery = true, trustedRetentionReconciler = true } = {}) {
  const attempts = new Map();
  const leases = new Map();
  const reservations = new Map();
  const receipts = new Map();
  let clock = 1000;
  let recovery = { runTerminal: true, runnerRemoved: true, cleanupComplete: true };
  let cleanupVerified = true;
  let retentionReconcilerVerified = trustedRetentionReconciler;
  let tail = Promise.resolve();
  const snapshot = () => ({ attempts: structuredClone(attempts), leases: structuredClone(leases),
    reservations: structuredClone(reservations), receipts: structuredClone(receipts) });
  const sameScope = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const sumUsage = (rows, field) => {
    const total = { attempts: 0, databaseRows: 0, authUsers: 0, stripeObjects: 0 };
    for (const row of rows) for (const key of Object.keys(total)) total[key] += row[field][key];
    return total;
  };
  return {
    attempts, leases, reservations, receipts, advance: (seconds) => { clock += seconds; },
    setRecovery: (value) => { recovery = value; },
    setCleanupVerified: (value) => { cleanupVerified = value; },
    setRetentionReconcilerVerified: (value) => { retentionReconcilerVerified = value; },
    verifyCleanup: async () => cleanupVerified,
    ...(trustedRecovery ? { verifyRecovery: async () => recovery } : {}),
    verifyRetentionReceipt: async () => retentionReconcilerVerified,
    async transaction(fn) {
      const previous = tail;
      let unlock;
      tail = new Promise((resolve) => { unlock = resolve; });
      await previous;
      const before = snapshot();
      const tx = {
        lockAttempt: async () => {},
        lockRetention: async () => {},
        now: () => clock,
        getAttempt: async (id) => structuredClone(attempts.get(id) ?? null),
        putAttempt: async (row) => attempts.set(row.attemptId, structuredClone(row)),
        getLease: async (k) => structuredClone(leases.get(JSON.stringify(k)) ?? null),
        putLease: async (row) => leases.set(JSON.stringify(row.key), structuredClone(row)),
        deleteLease: async (k) => leases.delete(JSON.stringify(k)),
        async getRetentionUsage(scope) {
          const allReservations = [...reservations.values()].filter((row) => sameScope(row.scope, scope));
          const settled = allReservations.filter((row) => receipts.has(row.reservationId));
          const outstanding = allReservations.filter((row) => !receipts.has(row.reservationId));
          const settledReceipts = settled.map((row) => receipts.get(row.reservationId));
          return { committed: sumUsage(settledReceipts, 'retained'),
            reserved: sumUsage(outstanding, 'projection'),
            policyLimits: allReservations[0]?.quotas ?? null };
        },
        async getRetentionReservationByAttempt(id) {
          return structuredClone([...reservations.values()].find((row) => row.attemptId === id) ?? null);
        },
        async getRetentionReservation(id) { return structuredClone(reservations.get(id) ?? null); },
        async getRetentionReceipt(id) { return structuredClone(receipts.get(id) ?? null); },
        async putRetentionReservation(row) {
          if (reservations.has(row.reservationId) || [...reservations.values()].some((item) => item.attemptId === row.attemptId)) {
            throw Object.assign(new Error('reservation_conflict'), { code: 'retention_reservation_conflict' });
          }
          reservations.set(row.reservationId, structuredClone(row));
        },
        async putRetentionReceipt(row) {
          if (!reservations.has(row.reservationId) || receipts.has(row.reservationId)) {
            throw Object.assign(new Error('receipt_conflict'), { code: 'retention_receipt_conflict' });
          }
          receipts.set(row.reservationId, structuredClone(row));
        },
        fixtureMutation: async (f) => f(),
      };
      try { return await fn(tx); }
      catch (error) {
        attempts.clear(); leases.clear(); reservations.clear(); receipts.clear();
        for (const [k, v] of before.attempts) attempts.set(k, v);
        for (const [k, v] of before.leases) leases.set(k, v);
        for (const [k, v] of before.reservations) reservations.set(k, v);
        for (const [k, v] of before.receipts) receipts.set(k, v);
        throw error;
      } finally { unlock(); }
    },
  };
}

test('duplicate prepare is atomic and replay returns the original fence', async () => {
  const store = createAttemptStore(fakeAdapter());
  const [a, b] = await Promise.all([prepareAttempt(store, input()), prepareAttempt(store, input())]);
  assert.equal(a.fence, b.fence);
  assert.equal(a.attemptId, 'attempt-a');
  assert.equal(a.state, 'collecting');
});

test('different candidate SHAs cannot concurrently own one branch/suite/fixture key', async () => {
  const store = createAttemptStore(fakeAdapter());
  const results = await Promise.allSettled([
    prepareAttempt(store, input('attempt-a', shaA)),
    prepareAttempt(store, input('attempt-b', shaB)),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'lease_held');
});

test('different fixtures acquire independently', async () => {
  const store = createAttemptStore(fakeAdapter());
  const [a, b] = await Promise.all([
    prepareAttempt(store, input('attempt-a', shaA, 'invoice-a')),
    prepareAttempt(store, input('attempt-b', shaB, 'invoice-b')),
  ]);
  assert.notEqual(a.fence, b.fence);
});

test('renewal retains the fence and expired owners cannot mutate or release', async () => {
  const adapter = fakeAdapter();
  const store = createAttemptStore(adapter);
  const row = await prepareAttempt(store, input());
  adapter.advance(30);
  const renewed = await store.renew({ attemptId: row.attemptId, fence: row.fence, ttlSeconds: 60 });
  assert.equal(renewed.fence, row.fence);
  adapter.advance(61);
  await assert.rejects(withFixtureMutation(store, row, async () => {}), { code: 'lease_expired' });
  await assert.rejects(cleanupAttempt(store, { attemptId: row.attemptId, fence: row.fence, verified: true }), { code: 'lease_expired' });
});

test('lease survives collect and recheck until verified cleanup', async () => {
  const adapter = fakeAdapter();
  const store = createAttemptStore(adapter);
  const row = await prepareAttempt(store, input());
  const { fence: _fence, ...publicRow } = row;
  const { snapshot, artifact } = createSnapshot({ ...publicRow, state: 'collected',
    resourceIds: ['cus_synthetic'] }, 'artifact-321');
  await store.transition({ attemptId: row.attemptId, fence: row.fence, from: 'collecting', to: 'collected',
    artifact, resourceIds: ['cus_synthetic'] });
  await assert.rejects(prepareAttempt(store, input('attempt-b', shaB)), { code: 'lease_held' });
  const resumed = await resumeRecheck(store, { attemptId: row.attemptId, snapshot, artifact,
    artifactId: artifact.id, artifactDigest: artifact.digest, workflow: row.workflow,
    environment, candidateSha: shaA, currentHeadSha: shaA, recheckRun });
  await assert.rejects(prepareAttempt(store, input('attempt-b', shaB)), { code: 'lease_held' });
  await store.transition({ attemptId: row.attemptId, fence: resumed.fence,
    from: 'rechecking', to: 'complete' });
  adapter.setCleanupVerified(false);
  await assert.rejects(cleanupAttempt(store, { attemptId: row.attemptId, fence: resumed.fence, verified: true }), { code: 'cleanup_unverified' });
  adapter.setCleanupVerified(true);
  await cleanupAttempt(store, { attemptId: row.attemptId, fence: resumed.fence, verified: true });
  assert.equal((await prepareAttempt(store, input('attempt-b', shaB))).attemptId, 'attempt-b');
});

test('same attempt resumes recheck with a new fence only after terminal run and removed runner', async () => {
  const adapter = fakeAdapter();
  const store = createAttemptStore(adapter);
  const row = await prepareAttempt(store, input());
  const { fence: _fence, ...publicRow } = row;
  const { snapshot, artifact } = createSnapshot({ ...publicRow, state: 'collected' }, 'artifact-321');
  await store.transition({ attemptId: row.attemptId, fence: row.fence, from: 'collecting', to: 'collected', artifact });
  adapter.advance(61);
  const request = { attemptId: row.attemptId, artifact, snapshot, artifactId: artifact.id,
    artifactDigest: artifact.digest, workflow: input().workflow, environment,
    candidateSha: shaA, recheckRun, currentHeadSha: shaA };
  adapter.setRecovery({ runTerminal: true, runnerRemoved: false, cleanupComplete: false });
  await assert.rejects(resumeRecheck(store, { ...request, runnerRemoved: false }), { code: 'recovery_unverified' });
  adapter.setRecovery({ runTerminal: false, runnerRemoved: true, cleanupComplete: false });
  await assert.rejects(resumeRecheck(store, { ...request, runTerminal: false }), { code: 'recovery_unverified' });
  adapter.setRecovery({ runTerminal: true, runnerRemoved: true, cleanupComplete: false });
  const resumed = await resumeRecheck(store, request);
  assert.notEqual(resumed.fence, row.fence);
  assert.equal(resumed.state, 'rechecking');
  assert.equal(adapter.leases.get(JSON.stringify(key)).ownerRunId, '200');
  assert.equal(adapter.leases.get(JSON.stringify(key)).candidateSha, shaA);
  await assert.rejects(withExternalFence(store, row, async () => {}), { code: 'lease_fence_lost' });
});

test('collect replay cannot obtain a recheck owner fence', async () => {
  const adapter = fakeAdapter();
  const store = createAttemptStore(adapter);
  const row = await prepareAttempt(store, input());
  const { fence: _fence, ...publicRow } = row;
  const { snapshot, artifact } = createSnapshot({ ...publicRow, state: 'collected' }, 'artifact-321');
  await store.transition({ attemptId: row.attemptId, fence: row.fence,
    from: 'collecting', to: 'collected', artifact });
  const resumed = await resumeRecheck(store, { attemptId: row.attemptId, snapshot, artifact,
    artifactId: artifact.id, artifactDigest: artifact.digest, workflow: row.workflow,
    environment, candidateSha: shaA, currentHeadSha: shaA, recheckRun });
  await assert.rejects(prepareAttempt(store, input()), { code: 'attempt_replay_not_owner' });
  assert.equal(adapter.leases.get(JSON.stringify(key)).fence, resumed.fence);
});

test('takeover after expiry requires terminal run, removed runner and completed cleanup', async () => {
  const adapter = fakeAdapter();
  const store = createAttemptStore(adapter);
  await prepareAttempt(store, input());
  adapter.advance(61);
  const recovery = { runTerminal: true, runnerRemoved: true, cleanupComplete: true };
  for (const bad of [{ ...recovery, runTerminal: false }, { ...recovery, runnerRemoved: false }, { ...recovery, cleanupComplete: false }]) {
    adapter.setRecovery(bad);
    await assert.rejects(prepareAttempt(store, input('attempt-b', shaB)), { code: 'recovery_unverified' });
  }
  adapter.setRecovery(recovery);
  assert.equal((await prepareAttempt(store, input('attempt-b', shaB))).attemptId, 'attempt-b');
});

test('stale owner cannot mutate a fixture, invoke an external mutation or release successor lease', async () => {
  const adapter = fakeAdapter();
  const store = createAttemptStore(adapter);
  const old = await prepareAttempt(store, input());
  adapter.advance(61);
  const fresh = await prepareAttempt(store, input('attempt-b', shaB));
  let mutations = 0;
  await assert.rejects(withFixtureMutation(store, old, async () => { mutations++; }), { code: 'lease_fence_lost' });
  await assert.rejects(withExternalFence(store, old, async () => { mutations++; }), { code: 'lease_fence_lost' });
  await assert.rejects(cleanupAttempt(store, { attemptId: old.attemptId, fence: old.fence, verified: true }), { code: 'lease_fence_lost' });
  assert.equal(mutations, 0);
  assert.equal((await store.getAttempt(fresh.attemptId)).state, 'collecting');
});

test('invalid transition and cancel/timeout hold cleanup pending without releasing lease', async () => {
  const store = createAttemptStore(fakeAdapter());
  const row = await prepareAttempt(store, input());
  await assert.rejects(store.transition({ attemptId: row.attemptId, fence: row.fence, from: 'collecting', to: 'complete' }), { code: 'invalid_transition' });
  const cancelled = await store.transition({ attemptId: row.attemptId, fence: row.fence, from: 'collecting', to: 'cancelled' });
  assert.equal(cancelled.cleanupStatus, 'pending');
  await assert.rejects(prepareAttempt(store, input('attempt-b', shaB)), { code: 'lease_held' });
});

test('timeout retains the lease and cleanup obligation', async () => {
  const store = createAttemptStore(fakeAdapter());
  const row = await prepareAttempt(store, input());
  const timedOut = await store.transition({ attemptId: row.attemptId, fence: row.fence,
    from: 'collecting', to: 'timed_out' });
  assert.equal(timedOut.cleanupStatus, 'pending');
  await assert.rejects(prepareAttempt(store, input('attempt-b', shaB)), { code: 'lease_held' });
});

test('recheck validates the public snapshot against the authoritative row before changing state', async () => {
  const store = createAttemptStore(fakeAdapter());
  const first = await prepareAttempt(store, input());
  const { fence: _fence, ...publicRow } = first;
  const collected = { ...publicRow, state: 'collected', resourceIds: ['cus_synthetic'] };
  const { snapshot, artifact } = createSnapshot(collected, 'artifact-321');
  await store.transition({ attemptId: first.attemptId, fence: first.fence, from: 'collecting',
    to: 'collected', artifact, resourceIds: collected.resourceIds });
  const request = { attemptId: first.attemptId, snapshot, artifactId: artifact.id,
    artifactDigest: artifact.digest, workflow: first.workflow, environment,
    candidateSha: shaA, currentHeadSha: shaA, recheckRun };
  await assert.rejects(recheckAttempt(store, { ...request, artifactId: 'artifact-other' }), { code: 'artifact_identity_mismatch' });
  await assert.rejects(recheckAttempt(store, { ...request, currentHeadSha: shaB }), { code: 'artifact_identity_mismatch' });
  assert.equal((await store.getAttempt(first.attemptId)).state, 'collected');
  assert.equal((await recheckAttempt(store, request)).state, 'rechecking');
});

test('recheck only verifies existing Stripe objects and never calls creation', async () => {
  const store = createAttemptStore(fakeAdapter());
  const first = await prepareAttempt(store, input());
  const { fence: _fence, ...publicRow } = first;
  const collected = { ...publicRow, state: 'collected', resourceIds: ['cus_synthetic'] };
  const { snapshot, artifact } = createSnapshot(collected, 'artifact-321');
  await store.transition({ attemptId: first.attemptId, fence: first.fence, from: 'collecting',
    to: 'collected', artifact, resourceIds: collected.resourceIds });
  let created = 0;
  const stripe = { async verifyExisting(id) { assert.equal(id, 'cus_synthetic'); return true; },
    async createCustomer() { created++; } };
  await recheckAttempt(store, { attemptId: first.attemptId, snapshot, artifactId: artifact.id,
    artifactDigest: artifact.digest, workflow: first.workflow, environment, candidateSha: shaA,
    currentHeadSha: shaA, recheckRun, stripe });
  assert.equal(created, 0);
});

test('provider idempotency keys are distinct by provider, operation, and attempt', () => {
  const a = providerIdempotencyKey('attempt-a', 'stripe', 'create-customer');
  assert.notEqual(a, providerIdempotencyKey('attempt-b', 'stripe', 'create-customer'));
  assert.notEqual(a, providerIdempotencyKey('attempt-a', 'stripe', 'create-invoice'));
  assert.notEqual(a, providerIdempotencyKey('attempt-a', 'other', 'create-customer'));
  assert.equal(a, providerIdempotencyKey('attempt-a', 'stripe', 'create-customer'));
});

test('direct store resume refuses artifact substitution before rotating a fence', async () => {
  const store = createAttemptStore(fakeAdapter());
  const first = await prepareAttempt(store, input());
  const { fence: _fence, ...publicRow } = first;
  const { snapshot, artifact } = createSnapshot({ ...publicRow, state: 'collected' }, 'artifact-321');
  await store.transition({ attemptId: first.attemptId, fence: first.fence,
    from: 'collecting', to: 'collected', artifact });
  await assert.rejects(store.resumeRecheck({ attemptId: first.attemptId, artifact,
    snapshot: { ...snapshot, artifactId: 'artifact-other' }, artifactId: artifact.id,
    artifactDigest: artifact.digest, workflow: first.workflow, environment,
    candidateSha: shaA, currentHeadSha: shaA, recheckRun }),
  { code: 'artifact_identity_mismatch' });
  assert.equal((await store.getAttempt(first.attemptId)).state, 'collected');
});

test('generic transition cannot enter rechecking with the collect fence', async () => {
  const adapter = fakeAdapter();
  const store = createAttemptStore(adapter);
  const row = await prepareAttempt(store, input());
  const { fence: _fence, ...publicRow } = row;
  const { artifact } = createSnapshot({ ...publicRow, state: 'collected' }, 'artifact-321');
  await store.transition({ attemptId: row.attemptId, fence: row.fence,
    from: 'collecting', to: 'collected', artifact });
  await assert.rejects(store.transition({ attemptId: row.attemptId, fence: row.fence,
    from: 'collected', to: 'rechecking' }), { code: 'invalid_transition' });
  assert.equal(adapter.attempts.get(row.attemptId).state, 'collected');
  assert.equal(adapter.leases.get(JSON.stringify(key)).fence, row.fence);
});

test('prepare refuses untrusted metadata fields and malformed stable identities', async () => {
  const store = createAttemptStore(fakeAdapter());
  await assert.rejects(prepareAttempt(store, { ...input(), workflow: { ...input().workflow,
    token: 'sk_test_private' } }), { code: 'attempt_input_invalid' });
  await assert.rejects(prepareAttempt(store, { ...input(), environment: {
    ...environment, stripe: { accountId: 'acct_synthetic123', secret: 'sk_test_private' },
  } }), { code: 'attempt_input_invalid' });
  await assert.rejects(prepareAttempt(store, { ...input(), key: { ...key, suite: 'bad suite' } }),
  { code: 'attempt_input_invalid' });
});

test('collect transition refuses secret-bearing resources and malformed artifact metadata', async () => {
  const store = createAttemptStore(fakeAdapter());
  const row = await prepareAttempt(store, input());
  await assert.rejects(store.transition({ attemptId: row.attemptId, fence: row.fence,
    from: 'collecting', to: 'collected', resourceIds: ['sk_test_private'] }),
  { code: 'attempt_input_invalid' });
  await assert.rejects(store.transition({ attemptId: row.attemptId, fence: row.fence,
    from: 'collecting', to: 'collected', artifact: { id: 'art-1', digest: 'bad' } }),
  { code: 'attempt_input_invalid' });
});

test('collect transition refuses Stripe client secrets before persistence', async () => {
  const adapter = fakeAdapter();
  const store = createAttemptStore(adapter);
  const row = await prepareAttempt(store, input());
  for (const secret of ['pi_123_secret_abc', 'seti_123_secret_abc']) {
    await assert.rejects(store.transition({ attemptId: row.attemptId, fence: row.fence,
      from: 'collecting', to: 'collected', artifact: { id: 'artifact-321',
        digest: 'c'.repeat(64), schema: 1 }, resourceIds: [secret] }),
    { code: 'attempt_input_invalid' });
  }
  assert.deepEqual(adapter.attempts.get(row.attemptId).resourceIds, []);
});

test('failed renewal aborts supervised work', async () => {
  const store = createAttemptStore(fakeAdapter());
  const row = await prepareAttempt(store, input());
  const result = withRenewingLease({ ...store, renew: async () => {
    throw Object.assign(new Error('lost'), { code: 'lease_fence_lost' });
  } }, row, { ttlSeconds: 60, intervalMs: 1, work: (signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  await assert.rejects(result, { code: 'lease_fence_lost' });
});

test('renewal supervision rejects an interval longer than its lease TTL', async () => {
  const store = createAttemptStore(fakeAdapter());
  const row = await prepareAttempt(store, input());
  await assert.rejects(withRenewingLease(store, row, { ttlSeconds: 1, intervalMs: 1000,
    work: async () => 'ran' }), TypeError);
});

test('stalled renewal aborts work before a later renewal can succeed', async () => {
  const store = createAttemptStore(fakeAdapter());
  const row = await prepareAttempt(store, input());
  let renewals = 0;
  const stalledStore = { ...store, async renew() {
    renewals++;
    if (renewals === 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { ...row, expiresAt: 1060, serverNow: 1000 };
    }
    throw Object.assign(new Error('lost'), { code: 'lease_fence_lost' });
  } };
  await assert.rejects(withRenewingLease(stalledStore, row, { ttlSeconds: 60,
    intervalMs: 5, work: (signal) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) }), { code: 'lease_renewal_timeout' });
});

test('renewal supervision uses the confirmed database expiry as its deadline', async () => {
  const store = createAttemptStore(fakeAdapter());
  const row = await prepareAttempt(store, input());
  const shortStore = { ...store, assertFence: async () => ({ ...row,
    expiresAt: 1000.02, serverNow: 1000 }), renew: async () => new Promise(() => {}) };
  await assert.rejects(withRenewingLease(shortStore, row, { ttlSeconds: 60,
    intervalMs: 15, work: (signal) => new Promise((resolve, reject) => {
      const fallback = setTimeout(() => reject(Object.assign(new Error('test timeout'),
        { code: 'test_timeout' })), 100);
      signal.addEventListener('abort', () => { clearTimeout(fallback); reject(signal.reason); },
        { once: true });
    }) }), { code: 'lease_expired' });
});

test('expired confirmed lease never starts supervised work', async () => {
  const store = createAttemptStore(fakeAdapter());
  const row = await prepareAttempt(store, input());
  let started = false;
  const expiredStore = { ...store, assertFence: async () => ({ ...row,
    expiresAt: 1000, serverNow: 1000 }) };
  await assert.rejects(withRenewingLease(expiredStore, row, { ttlSeconds: 60,
    intervalMs: 5, work: async () => { started = true; } }), { code: 'lease_expired' });
  assert.equal(started, false);
});

test('delayed initial confirmation cannot start work after reported expiry', async () => {
  const store = createAttemptStore(fakeAdapter());
  const row = await prepareAttempt(store, input());
  let started = false;
  const delayedStore = { ...store, async assertFence() {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { ...row, expiresAt: 1000.02, serverNow: 1000 };
  } };
  await assert.rejects(withRenewingLease(delayedStore, row, { ttlSeconds: 60,
    intervalMs: 5, work: async () => { started = true; return 'ran'; } }),
  { code: 'lease_expired' });
  assert.equal(started, false);
});

test('delayed renewal response cannot grant already elapsed lease time', async () => {
  const store = createAttemptStore(fakeAdapter());
  const row = await prepareAttempt(store, input());
  let reportRenewal;
  const renewalReported = new Promise((resolve) => { reportRenewal = resolve; });
  let lateMutation = 0;
  const delayedStore = { ...store,
    assertFence: async () => ({ ...row, expiresAt: 1001, serverNow: 1000 }),
    async renew() {
      await new Promise((resolve) => setTimeout(resolve, 50));
      reportRenewal();
      return { ...row, expiresAt: 2000.02, serverNow: 2000 };
    },
  };
  await assert.rejects(withRenewingLease(delayedStore, row, { ttlSeconds: 1,
    intervalMs: 100, work: (signal) => new Promise((resolve, reject) => {
      const fallback = setTimeout(() => reject(Object.assign(new Error('test timeout'),
        { code: 'test_timeout' })), 500);
      signal.addEventListener('abort', () => { clearTimeout(fallback); reject(signal.reason); },
        { once: true });
      renewalReported.then(() => setTimeout(() => {
        if (!signal.aborted) lateMutation++;
      }, 0));
    }) }), { code: 'lease_expired' });
  assert.equal(lateMutation, 0);
});

test('malformed renewal clock values cannot keep supervised work alive', async () => {
  const store = createAttemptStore(fakeAdapter());
  const row = await prepareAttempt(store, input());
  let reportRenewal;
  const renewalReported = new Promise((resolve) => { reportRenewal = resolve; });
  let lateMutation = 0;
  const malformedStore = { ...store,
    assertFence: async () => ({ ...row, expiresAt: 1001, serverNow: 1000 }),
    async renew() {
      reportRenewal();
      return { ...row, expiresAt: '2000.02', serverNow: '2000' };
    },
  };
  await assert.rejects(withRenewingLease(malformedStore, row, { ttlSeconds: 1,
    intervalMs: 5, work: (signal) => new Promise((resolve, reject) => {
      const fallback = setTimeout(() => reject(Object.assign(new Error('test timeout'),
        { code: 'test_timeout' })), 100);
      signal.addEventListener('abort', () => { clearTimeout(fallback); reject(signal.reason); },
        { once: true });
      renewalReported.then(() => setTimeout(() => {
        if (!signal.aborted) lateMutation++;
      }, 0));
    }) }), { code: 'lease_expired' });
  assert.equal(lateMutation, 0);
});

test('caller-supplied recovery flags cannot reclaim a lease without a trusted verifier', async () => {
  const adapter = fakeAdapter({ trustedRecovery: false });
  const store = createAttemptStore(adapter);
  await prepareAttempt(store, input());
  adapter.advance(61);
  await assert.rejects(prepareAttempt(store, { ...input('attempt-b', shaB), recovery: {
    runTerminal: true, runnerRemoved: true, cleanupComplete: true,
  } }), { code: 'recovery_unverified' });
});

test('caller-supplied cleanup flag cannot release a lease without a trusted verifier', async () => {
  const adapter = fakeAdapter();
  adapter.verifyCleanup = undefined;
  const store = createAttemptStore(adapter);
  const row = await prepareAttempt(store, input());
  await store.transition({ attemptId: row.attemptId, fence: row.fence,
    from: 'collecting', to: 'cancelled' });
  await assert.rejects(cleanupAttempt(store, { attemptId: row.attemptId,
    fence: row.fence, verified: true }), { code: 'cleanup_unverified' });
  await assert.rejects(prepareAttempt(store, input('attempt-b', shaB)), { code: 'lease_held' });
});

test('collected attempt cannot release its lease before recheck or cancellation', async () => {
  const store = createAttemptStore(fakeAdapter());
  const row = await prepareAttempt(store, input());
  const { fence: _fence, ...publicRow } = row;
  const { artifact } = createSnapshot({ ...publicRow, state: 'collected' }, 'artifact-321');
  await store.transition({ attemptId: row.attemptId, fence: row.fence,
    from: 'collecting', to: 'collected', artifact });
  await assert.rejects(cleanupAttempt(store, { attemptId: row.attemptId,
    fence: row.fence, verified: true }), { code: 'cleanup_not_terminal' });
});

test('admission refuses missing, unbounded, zero, negative, fractional, or unknown retention quotas before writes', async () => {
  const adapter = fakeAdapter();
  const store = createAttemptStore(adapter);
  const invalid = [
    { retentionPolicy: undefined },
    { retentionPolicy: { version: 1, quotas: { ...retentionPolicy.quotas, stripeObjects: undefined } } },
    { retentionPolicy: { version: 1, quotas: { ...retentionPolicy.quotas, attempts: 0 } } },
    { retentionPolicy: { version: 1, quotas: { ...retentionPolicy.quotas, attempts: -1 } } },
    { retentionPolicy: { version: 1, quotas: { ...retentionPolicy.quotas, attempts: Number.POSITIVE_INFINITY } } },
    { retentionPolicy: { version: 1, quotas: { ...retentionPolicy.quotas, attempts: 1.5 } } },
    { retentionPolicy: { version: 1, quotas: { ...retentionPolicy.quotas, unknown: 1 } } },
    { projection: { ...projection, databaseRows: -1 } },
    { projection: { ...projection, extraRows: 1 } },
  ];
  for (const [index, overrides] of invalid.entries()) {
    await assert.rejects(prepareAttempt(store, { ...input(`invalid-${index}`), ...overrides }),
      { code: 'retention_policy_invalid' });
  }
  assert.equal(adapter.attempts.size, 0);
  assert.equal(adapter.leases.size, 0);
  assert.equal(adapter.reservations.size, 0);
});

test('reservation succeeds exactly at every configured finite quota and refuses projected overflow', async () => {
  const adapter = fakeAdapter();
  const store = createAttemptStore(adapter);
  const policy = { version: 1, quotas: { attempts: 2, databaseRows: 8, authUsers: 2, stripeObjects: 6 } };
  const writes = { attempts: 1, databaseRows: 4, authUsers: 1, stripeObjects: 3 };
  const first = await prepareAttempt(store, { ...input(), retentionPolicy: policy, projection: writes });
  const second = await prepareAttempt(store, { ...input('attempt-b', shaB, 'invoice-b'),
    retentionPolicy: policy, projection: writes });
  assert.deepEqual(second.capacity.projected, policy.quotas);
  assert.deepEqual(second.capacity.remaining, { attempts: 0, databaseRows: 0, authUsers: 0, stripeObjects: 0 });
  await assert.rejects(prepareAttempt(store, { ...input('attempt-c', shaA, 'invoice-c'),
    retentionPolicy: policy, projection: { ...writes, databaseRows: 1 } }),
  { code: 'retention_capacity_exceeded' });
  assert.equal(adapter.reservations.size, 2);
  assert.equal(first.capacity.projected.databaseRows, 4);
});

test('retention limits are pinned to the first immutable reservation in a branch/account scope', async () => {
  const adapter = fakeAdapter();
  const store = createAttemptStore(adapter);
  const firstPolicy = { version: 1, quotas: { attempts: 5, databaseRows: 20, authUsers: 5, stripeObjects: 20 } };
  await prepareAttempt(store, { ...input(), retentionPolicy: firstPolicy });
  const changedPolicy = { version: 1, quotas: { ...firstPolicy.quotas, databaseRows: 1000 } };
  await assert.rejects(prepareAttempt(store, { ...input('attempt-b', shaB, 'invoice-b'),
    retentionPolicy: changedPolicy }), { code: 'retention_policy_mismatch' });
  assert.equal(adapter.reservations.size, 1);
});

test('a post-reservation failure and elapsed lease do not release ambiguous capacity before reconciler receipt', async () => {
  const adapter = fakeAdapter();
  const store = createAttemptStore(adapter);
  const policy = { version: 1, quotas: { attempts: 3, databaseRows: 5, authUsers: 3, stripeObjects: 6 } };
  const writes = { attempts: 1, databaseRows: 4, authUsers: 1, stripeObjects: 2 };
  const owner = await prepareAttempt(store, { ...input(), retentionPolicy: policy, projection: writes });
  let providerAttempts = 0;
  await assert.rejects(store.fixtureMutation(owner, async () => {
    providerAttempts++;
    throw new Error('ambiguous_result');
  }), { message: 'ambiguous_result' });
  assert.equal(providerAttempts, 1);
  adapter.advance(61);
  await assert.rejects(prepareAttempt(store, { ...input('attempt-b', shaB, 'invoice-b'),
    retentionPolicy: policy, projection: writes }), { code: 'retention_capacity_exceeded' });
  assert.equal(adapter.receipts.size, 0);

  adapter.setRetentionReconcilerVerified(false);
  await assert.rejects(store.reconcileReservation({ reservationId: owner.reservationId,
    outcome: 'failed', retained: { attempts: 1, databaseRows: 0, authUsers: 0, stripeObjects: 0 } }),
  { code: 'retention_reconciliation_unverified' });
  assert.equal(adapter.receipts.size, 0);

  adapter.setRetentionReconcilerVerified(true);
  await store.reconcileReservation({ reservationId: owner.reservationId, outcome: 'failed',
    retained: { attempts: 1, databaseRows: 1, authUsers: 0, stripeObjects: 1 } });
  const admitted = await prepareAttempt(store, { ...input('attempt-b', shaB, 'invoice-b'),
    retentionPolicy: policy, projection: writes });
  assert.equal(admitted.capacity.projected.databaseRows, policy.quotas.databaseRows);
  assert.equal(admitted.capacity.projected.stripeObjects, 3);
});

test('retained historical attempt receipts consume quota independently of mutable attempt rows', async () => {
  const adapter = fakeAdapter();
  const store = createAttemptStore(adapter);
  const policy = { version: 1, quotas: { attempts: 1, databaseRows: 20, authUsers: 5, stripeObjects: 20 } };
  const writes = { attempts: 1, databaseRows: 2, authUsers: 1, stripeObjects: 2 };
  const owner = await prepareAttempt(store, { ...input(), retentionPolicy: policy, projection: writes });
  await store.reconcileReservation({ reservationId: owner.reservationId, outcome: 'completed', retained: writes });
  adapter.attempts.delete(owner.attemptId);
  await assert.rejects(prepareAttempt(store, { ...input('attempt-b', shaB, 'invoice-b'),
    retentionPolicy: policy, projection: writes }), { code: 'retention_capacity_exceeded' });
  assert.equal(adapter.receipts.size, 1);
});
