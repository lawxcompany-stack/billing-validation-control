import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createAttemptStore } from '../../src/attempts/store.mjs';
import { prepareAttempt } from '../../src/attempts/prepare.mjs';
import { resumeRecheck, recheckAttempt } from '../../src/attempts/recheck.mjs';
import { cleanupAttempt } from '../../src/attempts/cleanup.mjs';
import { withExternalFence, withFixtureMutation, withRenewingLease } from '../../src/attempts/lock.mjs';
import { createSnapshot } from '../../src/contracts/attempt.mjs';
import { providerIdempotencyKey } from '../../src/attempts/prepare.mjs';
import { runStripeMutation } from '../../src/runtime/stripe.mjs';

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
const cleanupProjection = Object.freeze({ cleanupClaim: 'owned_reversible_provider_fixtures_only',
  databaseBaselineDigest: 'c'.repeat(64), mutatedResourceIds: ['cs_synthetic123'],
  retainedDatabaseResources: [], retainedObjects: [
    { id: 'ch_synthetic123', type: 'charge', status: 'retained_test_financial_object' },
  ], removedDatabaseFixtureCount: 0 });

function input(attemptId = 'attempt-a', candidateSha = shaA, fixtureKey = 'invoice-a') {
  return { attemptId, key: { ...key, fixtureKey }, candidateSha, workflow: {
    repository: 'lawxcompany-stack/billing-validation-control', ref: 'refs/heads/main',
    runId: '100', runAttempt: 1, runnerLabel: `billing-validation-${'a'.repeat(32)}`,
  }, environment, ttlSeconds: 60, retentionPolicy, projection };
}

function fixtureRequest(owner, { caseId = 'payment.approved', rows = 1, suffix = '1' } = {}) {
  const uuid = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
  return { attemptId: owner.attemptId, fence: owner.fence, reservationId: owner.reservationId,
    rows: { databaseRows: rows }, caseId, namespaceId: uuid(Number(suffix)),
    fixtureId: uuid(100 + Number(suffix)), kind: 'catalog' };
}

function fakeAdapter({ trustedRecovery = true, trustedRetentionReconciler = true,
  trustedProviderReconciler = true } = {}) {
  const attempts = new Map();
  const leases = new Map();
  const reservations = new Map();
  const receipts = new Map();
  const resourceLocks = new Map();
  const stripeIntents = new Map();
  const stripeReceipts = new Map();
  const cleanupReceipts = new Map();
  const fixtureCaseClaims = new Map();
  const fixtureResourceClaims = new Map();
  let clock = 1000;
  let recovery = { runTerminal: true, runnerRemoved: true, cleanupComplete: true };
  let cleanupVerified = true;
  let retentionReconcilerVerified = trustedRetentionReconciler;
  let providerReconcilerVerified = trustedProviderReconciler;
  let cleanupReceiptFailure = false;
  let cleanupResourceLockFailure = false;
  const recoveryInputs = [];
  const cleanupSteps = [];
  let tail = Promise.resolve();
  let transactionCount = 0;
  const snapshot = () => ({ attempts: structuredClone(attempts), leases: structuredClone(leases),
    reservations: structuredClone(reservations), receipts: structuredClone(receipts),
    resourceLocks: structuredClone(resourceLocks), stripeIntents: structuredClone(stripeIntents),
    stripeReceipts: structuredClone(stripeReceipts), cleanupReceipts: structuredClone(cleanupReceipts),
    fixtureCaseClaims: structuredClone(fixtureCaseClaims),
    fixtureResourceClaims: structuredClone(fixtureResourceClaims) });
  const sameScope = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const resourceKeys = (value) => [
    { resourceType: 'supabase_branch', resourceId: `${value.database.projectRef}:${value.database.branchId}` },
    { resourceType: 'stripe_account', resourceId: value.stripe.accountId },
  ].sort((a, b) => `${a.resourceType}:${a.resourceId}`.localeCompare(`${b.resourceType}:${b.resourceId}`));
  const resourceMapKey = (resource) => `${resource.resourceType}:${resource.resourceId}`;
  const sumUsage = (rows, field) => {
    const total = { attempts: 0, databaseRows: 0, authUsers: 0, stripeObjects: 0 };
    for (const row of rows) for (const key of Object.keys(total)) total[key] += row[field][key];
    return total;
  };
  return {
    attempts, leases, reservations, receipts, resourceLocks, stripeIntents, stripeReceipts,
    cleanupReceipts, fixtureCaseClaims, fixtureResourceClaims, cleanupSteps,
    recoveryInputs,
    advance: (seconds) => { clock += seconds; },
    transactionCount: () => transactionCount,
    setRecovery: (value) => { recovery = value; },
    setCleanupVerified: (value) => { cleanupVerified = value; },
    setRetentionReconcilerVerified: (value) => { retentionReconcilerVerified = value; },
    setProviderReconcilerVerified: (value) => { providerReconcilerVerified = value; },
    setCleanupReceiptFailure: (value) => { cleanupReceiptFailure = value; },
    setCleanupResourceLockFailure: (value) => { cleanupResourceLockFailure = value; },
    verifyCleanup: async () => cleanupVerified,
    ...(trustedRecovery ? { verifyRecovery: async (input) => {
      recoveryInputs.push(structuredClone(input));
      return recovery;
    } } : {}),
    verifyRetentionReceipt: async () => retentionReconcilerVerified,
    verifyProviderObservation: async () => providerReconcilerVerified,
    async transaction(fn) {
      transactionCount++;
      const previous = tail;
      let unlock;
      tail = new Promise((resolve) => { unlock = resolve; });
      await previous;
      const before = snapshot();
      const tx = {
        lockAttempt: async () => {},
        lockRetention: async () => {},
        lockResourceLocks: async () => {},
        now: () => clock,
        getAttempt: async (id) => structuredClone(attempts.get(id) ?? null),
        putAttempt: async (row) => {
          if (row.cleanupStatus === 'complete') cleanupSteps.push('attempt');
          attempts.set(row.attemptId, structuredClone(row));
        },
        getLease: async (k) => structuredClone(leases.get(JSON.stringify(k)) ?? null),
        async getResourceLocks(ownerEnvironment) {
          return resourceKeys(ownerEnvironment).map((resource) => resourceLocks.get(resourceMapKey(resource)))
            .filter(Boolean).map((row) => structuredClone(row));
        },
        async putResourceLocks(owner, previous) {
          const keys = resourceKeys(owner.environment);
          const current = keys.map((resource) => resourceLocks.get(resourceMapKey(resource))).filter(Boolean);
          if (JSON.stringify(current) !== JSON.stringify(previous)) {
            throw Object.assign(new Error('resource_lock_conflict'), { code: 'resource_lock_held' });
          }
          for (const resource of keys) resourceLocks.set(resourceMapKey(resource), structuredClone({
            ...resource, attemptId: owner.attemptId, fence: owner.fence, expiresAt: owner.expiresAt,
            candidateSha: owner.candidateSha, workflow: owner.workflow, environment: owner.environment,
          }));
        },
        async deleteResourceLocks(owner) {
          if (cleanupResourceLockFailure) {
            cleanupResourceLockFailure = false;
            throw Object.assign(new Error('resource_lock_release_failed'), { code: 'resource_lock_release_failed' });
          }
          cleanupSteps.push('resourceLocks');
          for (const resource of resourceKeys(owner.environment)) {
            const row = resourceLocks.get(resourceMapKey(resource));
            if (row?.attemptId !== owner.attemptId || row.fence !== owner.fence) {
              throw Object.assign(new Error('lease_fence_lost'), { code: 'lease_fence_lost' });
            }
          }
          for (const resource of resourceKeys(owner.environment)) resourceLocks.delete(resourceMapKey(resource));
        },
        async hasInFlightStripeIntent(attemptId) {
          return [...stripeIntents.values()].some((intent) => intent.attemptId === attemptId &&
            !stripeReceipts.has(intent.intentId));
        },
        async getStripeIntent(intentId) {
          return structuredClone(stripeIntents.get(intentId) ?? null);
        },
        async listPendingStripeIntents(attemptId) {
          return [...stripeIntents.values()].filter((intent) => intent.attemptId === attemptId &&
            !stripeReceipts.has(intent.intentId)).map((intent) => structuredClone(intent));
        },
        async getStripeReceipt(intentId) {
          return structuredClone(stripeReceipts.get(intentId) ?? null);
        },
        async getStripeIntentByOperation(attemptId, operation) {
          return structuredClone([...stripeIntents.values()].find((intent) =>
            intent.attemptId === attemptId && intent.operation === operation) ?? null);
        },
        async insertStripeIntent(intent) {
          if ([...stripeIntents.values()].some((item) => item.attemptId === intent.attemptId &&
              item.operation === intent.operation)) {
            throw Object.assign(new Error('stripe_intent_conflict'), { code: 'stripe_intent_unresolved' });
          }
          stripeIntents.set(intent.intentId, structuredClone(intent));
        },
        async putStripeReceipt(receipt) {
          if (stripeReceipts.has(receipt.intentId)) {
            throw Object.assign(new Error('stripe_intent_already_reconciled'), {
              code: 'stripe_intent_already_reconciled',
            });
          }
          stripeReceipts.set(receipt.intentId, structuredClone(receipt));
        },
        putLease: async (row) => leases.set(JSON.stringify(row.key), structuredClone(row)),
        deleteLease: async (k) => {
          cleanupSteps.push('lease');
          return leases.delete(JSON.stringify(k));
        },
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
        async setRetentionFixtureRowsUsed({ reservationId, attemptId, expectedRows, usedRows }) {
          const reservation = reservations.get(reservationId);
          if (!reservation || reservation.attemptId !== attemptId ||
              (reservation.fixtureRowsUsed ?? 0) !== expectedRows ||
              usedRows > reservation.projection.databaseRows) {
            throw Object.assign(new Error('fixture_reservation_insufficient'), {
              code: 'fixture_reservation_insufficient',
            });
          }
          reservations.set(reservationId, { ...reservation, fixtureRowsUsed: usedRows });
        },
        async getRetentionReceipt(id) { return structuredClone(receipts.get(id) ?? null); },
        async getCleanupReceipt(id) { return structuredClone(cleanupReceipts.get(id) ?? null); },
        async putCleanupReceipt(row) {
          if (cleanupReceiptFailure) {
            cleanupReceiptFailure = false;
            throw Object.assign(new Error('cleanup_receipt_insert_failed'), { code: 'cleanup_receipt_insert_failed' });
          }
          if (cleanupReceipts.has(row.attemptId)) {
            throw Object.assign(new Error('cleanup_receipt_conflict'), { code: 'cleanup_receipt_conflict' });
          }
          cleanupSteps.push('receipt');
          cleanupReceipts.set(row.attemptId, structuredClone(row));
        },
        async putRetentionReservation(row) {
          if (reservations.has(row.reservationId) || [...reservations.values()].some((item) => item.attemptId === row.attemptId)) {
            throw Object.assign(new Error('reservation_conflict'), { code: 'retention_reservation_conflict' });
          }
          reservations.set(row.reservationId, structuredClone({ ...row, fixtureRowsUsed: 0 }));
        },
        async putRetentionReceipt(row) {
          if (!reservations.has(row.reservationId) || receipts.has(row.reservationId)) {
            throw Object.assign(new Error('receipt_conflict'), { code: 'retention_receipt_conflict' });
          }
          receipts.set(row.reservationId, structuredClone(row));
        },
        async claimFixtureCase(claim) {
          const caseKey = `${claim.attemptId}:${claim.caseId}`;
          const binding = { attemptId: claim.attemptId, caseId: claim.caseId,
            reservationId: claim.reservationId, fence: claim.fence, candidateSha: claim.candidateSha,
            environment: structuredClone(claim.environment), namespaceId: claim.namespaceId };
          const existing = fixtureCaseClaims.get(caseKey);
          if (existing && JSON.stringify(existing) !== JSON.stringify(binding)) {
            throw Object.assign(new Error('fixture_case_duplicate'), { code: 'fixture_case_duplicate' });
          }
          if (!existing) fixtureCaseClaims.set(caseKey, binding);
          const resourceKey = `${caseKey}:${claim.kind}`;
          if (fixtureResourceClaims.has(resourceKey)) {
            throw Object.assign(new Error('fixture_case_duplicate'), { code: 'fixture_case_duplicate' });
          }
          fixtureResourceClaims.set(resourceKey, { ...binding, kind: claim.kind, fixtureId: claim.fixtureId });
        },
        fixtureMutation: async (f) => f(),
      };
      try { return await fn(tx); }
      catch (error) {
        attempts.clear(); leases.clear(); reservations.clear(); receipts.clear();
        resourceLocks.clear(); stripeIntents.clear(); stripeReceipts.clear(); cleanupReceipts.clear();
        fixtureCaseClaims.clear(); fixtureResourceClaims.clear();
        for (const [k, v] of before.attempts) attempts.set(k, v);
        for (const [k, v] of before.leases) leases.set(k, v);
        for (const [k, v] of before.reservations) reservations.set(k, v);
        for (const [k, v] of before.receipts) receipts.set(k, v);
        for (const [k, v] of before.resourceLocks) resourceLocks.set(k, v);
        for (const [k, v] of before.stripeIntents) stripeIntents.set(k, v);
        for (const [k, v] of before.stripeReceipts) stripeReceipts.set(k, v);
        for (const [k, v] of before.cleanupReceipts) cleanupReceipts.set(k, v);
        for (const [k, v] of before.fixtureCaseClaims) fixtureCaseClaims.set(k, v);
        for (const [k, v] of before.fixtureResourceClaims) fixtureResourceClaims.set(k, v);
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

test('fixture reservation claims are serialized, persisted before the writer, and survive ambiguous writer failure', async () => {
  const adapter = fakeAdapter();
  const store = createAttemptStore(adapter);
  const owner = await prepareAttempt(store, { ...input(),
    projection: { ...projection, databaseRows: 2 } });
  const request = fixtureRequest(owner);
  let writerCalls = 0;

  await assert.rejects(store.fixtureMutationWithReservation(request, async (transaction) => {
    writerCalls++;
    assert.equal(adapter.reservations.get(owner.reservationId).fixtureRowsUsed, 1);
    assert.equal(transaction.reservationLocked, true);
    assert.equal(transaction.reservationValidated, true);
    assert.equal(transaction.reservationStatus, 'active');
    assert.equal(transaction.reservationSettled, false);
    assert.equal(transaction.remainingDatabaseRows, 2);
    throw new Error('ambiguous remote writer outcome');
  }), /ambiguous remote writer outcome/u);

  assert.equal(adapter.reservations.get(owner.reservationId).fixtureRowsUsed, 1);
  const retry = await Promise.allSettled([store.fixtureMutationWithReservation(request, async () => {
    writerCalls++;
  })]);
  assert.equal(retry[0].status, 'rejected');
  assert.equal(retry[0].reason.code, 'fixture_case_duplicate');
  assert.equal(writerCalls, 1);
});

test('fixture reservation validation refuses missing, settled, divergent, insufficient, expired, and recovery-only owners before writing', async () => {
  const cases = [
    { name: 'missing reservation', prepare(adapter, owner) { adapter.reservations.delete(owner.reservationId); },
      code: 'retention_reservation_missing' },
    { name: 'settled reservation', prepare(adapter, owner) {
      adapter.receipts.set(owner.reservationId, { reservationId: owner.reservationId });
    }, code: 'retention_attempt_settled' },
    { name: 'reservation belongs to another attempt', prepare(adapter, owner) {
      const reservation = adapter.reservations.get(owner.reservationId);
      adapter.reservations.set(owner.reservationId, { ...reservation, attemptId: 'attempt-other' });
    }, code: 'fixture_reservation_invalid' },
    { name: 'reservation scope diverges', prepare(adapter, owner) {
      const reservation = adapter.reservations.get(owner.reservationId);
      adapter.reservations.set(owner.reservationId, { ...reservation,
        scope: { ...reservation.scope, branchId: 'other-validation-branch' } });
    }, code: 'fixture_reservation_invalid' },
    { name: 'requested rows exceed reserved projection', rows: { databaseRows: 2 },
      code: 'fixture_reservation_insufficient' },
    { name: 'lease expired', prepare(adapter) { adapter.advance(61); }, code: 'lease_expired' },
    { name: 'recovery-only lease', prepare(adapter, owner) {
      const key = JSON.stringify(owner.key);
      adapter.leases.set(key, { ...adapter.leases.get(key), recoveryOnly: true });
    }, code: 'recovery_read_only' },
  ];

  for (const scenario of cases) {
    const adapter = fakeAdapter();
    const store = createAttemptStore(adapter);
    const owner = await prepareAttempt(store, { ...input(),
      projection: { ...projection, databaseRows: 1 } });
    scenario.prepare?.(adapter, owner);
    let writerCalls = 0;
    await assert.rejects(store.fixtureMutationWithReservation(fixtureRequest(owner, {
      rows: scenario.rows?.databaseRows ?? 1,
    }), async () => { writerCalls++; }),
    { code: scenario.code }, scenario.name);
    assert.equal(writerCalls, 0, scenario.name);
  }
});

test('concurrent fixture reservation claims cannot exceed the persisted row allowance', async () => {
  const adapter = fakeAdapter();
  const store = createAttemptStore(adapter);
  const owner = await prepareAttempt(store, { ...input(),
    projection: { ...projection, databaseRows: 1 } });
  let writerCalls = 0;

  const results = await Promise.allSettled([
    fixtureRequest(owner, { caseId: 'payment.approved', suffix: '1' }),
    fixtureRequest(owner, { caseId: 'payment.declined', suffix: '2' }),
  ].map((request) => store.fixtureMutationWithReservation(request,
    async () => { writerCalls++; return true; })));

  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(results.filter(({ status, reason }) => status === 'rejected' &&
    reason?.code === 'fixture_reservation_insufficient').length, 1);
  assert.equal(writerCalls, 1);
  assert.equal(adapter.reservations.get(owner.reservationId).fixtureRowsUsed, 1);
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

test('different suite and fixture keys sharing one validation branch conflict on global resource locks', async () => {
  const store = createAttemptStore(fakeAdapter());
  await prepareAttempt(store, input('attempt-a', shaA, 'invoice-a'));
  await assert.rejects(prepareAttempt(store, { ...input('attempt-b', shaB, 'invoice-b'),
    key: { ...key, suite: 'billing-replay', fixtureKey: 'invoice-b' } }),
  { code: 'resource_lock_held' });
});

test('attempts sharing only a Stripe account conflict while fully disjoint resources proceed independently', async () => {
  const adapter = fakeAdapter();
  const store = createAttemptStore(adapter);
  await prepareAttempt(store, input());
  await assert.rejects(prepareAttempt(store, { ...input('attempt-b', shaB, 'invoice-b'),
    key: { branchId: 'validation-child-2', suite: 'another-suite', fixtureKey: 'invoice-b' },
    environment: { ...environment, database: { ...environment.database,
      branchId: 'validation-child-2' } } }), { code: 'resource_lock_held' });

  const disjoint = { ...input('attempt-c', shaB, 'invoice-c'),
    key: { branchId: 'validation-child-3', suite: 'another-suite', fixtureKey: 'invoice-c' },
    environment: { database: { ...environment.database, branchId: 'validation-child-3' },
      deployment: { id: 'dpl_othercandidate123', origin: 'https://other-candidate.vercel.app' },
      stripe: { accountId: 'acct_other_synthetic123' } } };
  assert.equal((await prepareAttempt(store, disjoint)).attemptId, 'attempt-c');
});

test('attempts sharing only a Supabase branch conflict across otherwise distinct fixtures', async () => {
  const store = createAttemptStore(fakeAdapter());
  await prepareAttempt(store, input());
  await assert.rejects(prepareAttempt(store, { ...input('attempt-b', shaB, 'invoice-b'),
    key: { ...key, suite: 'billing-other-suite', fixtureKey: 'invoice-b' },
    environment: { ...environment, stripe: { accountId: 'acct_other_synthetic123' } } }),
  { code: 'resource_lock_held' });
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
  await assert.rejects(cleanupAttempt(store, { attemptId: row.attemptId, fence: row.fence,
    projection: cleanupProjection, verified: true }), { code: 'lease_expired' });
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
  await assert.rejects(cleanupAttempt(store, { attemptId: row.attemptId, fence: resumed.fence,
    projection: cleanupProjection, verified: true }), { code: 'cleanup_unverified' });
  adapter.setCleanupVerified(true);
  await cleanupAttempt(store, { attemptId: row.attemptId, fence: resumed.fence,
    projection: cleanupProjection, verified: true });
  assert.equal((await prepareAttempt(store, input('attempt-b', shaB))).attemptId, 'attempt-b');
});

test('cleanup stores a closed projection receipt before terminal state and ownership release', async () => {
  const adapter = fakeAdapter();
  const store = createAttemptStore(adapter);
  const owner = await prepareAttempt(store, input());
  await store.transition({ attemptId: owner.attemptId, fence: owner.fence,
    from: 'collecting', to: 'cancelled' });

  await store.cleanup({ attemptId: owner.attemptId, fence: owner.fence, projection: cleanupProjection });

  const receipt = adapter.cleanupReceipts.get(owner.attemptId);
  assert.equal(receipt.reservationId, owner.reservationId);
  assert.equal(receipt.attemptId, owner.attemptId);
  assert.equal(receipt.fence, owner.fence);
  assert.deepEqual(receipt.environment, environment);
  assert.deepEqual(receipt.projection, cleanupProjection);
  assert.equal(receipt.digest, createHash('sha256').update(JSON.stringify(cleanupProjection)).digest('hex'));
  assert.deepEqual(adapter.cleanupSteps, ['receipt', 'attempt', 'lease', 'resourceLocks']);
  assert.equal((await store.getAttempt(owner.attemptId)).cleanupStatus, 'complete');
  assert.equal(adapter.leases.size, 0);
  assert.equal(adapter.resourceLocks.size, 0);
  assert.equal(adapter.reservations.size, 1);
  assert.equal(adapter.receipts.size, 0);
});

test('cleanup receipt insertion and resource-lock release failures preserve pending ownership atomically', async () => {
  for (const failure of ['receipt', 'resourceLocks']) {
    const adapter = fakeAdapter();
    const store = createAttemptStore(adapter);
    const owner = await prepareAttempt(store, input());
    await store.transition({ attemptId: owner.attemptId, fence: owner.fence,
      from: 'collecting', to: 'cancelled' });
    if (failure === 'receipt') adapter.setCleanupReceiptFailure(true);
    else adapter.setCleanupResourceLockFailure(true);

    await assert.rejects(store.cleanup({ attemptId: owner.attemptId, fence: owner.fence,
      projection: cleanupProjection }), { code: failure === 'receipt'
      ? 'cleanup_receipt_insert_failed' : 'resource_lock_release_failed' });

    assert.equal(adapter.cleanupReceipts.size, 0);
    assert.equal((await store.getAttempt(owner.attemptId)).cleanupStatus, 'pending');
    assert.equal(adapter.leases.get(JSON.stringify(owner.key)).fence, owner.fence);
    assert.equal(adapter.resourceLocks.size, 2);
    assert.equal(adapter.reservations.size, 1);
    assert.equal(adapter.receipts.size, 0);
  }
});

test('cleanup rejects projections with fields outside the receipt schema before releasing ownership', async () => {
  const adapter = fakeAdapter();
  const store = createAttemptStore(adapter);
  const owner = await prepareAttempt(store, input());
  await store.transition({ attemptId: owner.attemptId, fence: owner.fence,
    from: 'collecting', to: 'cancelled' });

  await assert.rejects(store.cleanup({ attemptId: owner.attemptId, fence: owner.fence,
    projection: { ...cleanupProjection, callerFlag: true } }), { code: 'cleanup_receipt_invalid' });
  assert.equal(adapter.cleanupReceipts.size, 0);
  assert.equal((await store.getAttempt(owner.attemptId)).cleanupStatus, 'pending');
  assert.equal(adapter.leases.get(JSON.stringify(owner.key)).fence, owner.fence);
  assert.equal(adapter.resourceLocks.size, 2);
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
  const owner = await prepareAttempt(store, input());
  await store.reconcileReservation({ reservationId: owner.reservationId, outcome: 'cancelled',
    retained: projection });
  await store.transition({ attemptId: owner.attemptId, fence: owner.fence,
    from: 'collecting', to: 'cancelled' });
  adapter.advance(61);
  const recovery = { runTerminal: true, runnerRemoved: true, cleanupComplete: true };
  for (const bad of [{ ...recovery, runTerminal: false }, { ...recovery, runnerRemoved: false }, { ...recovery, cleanupComplete: false }]) {
    adapter.setRecovery(bad);
    await assert.rejects(prepareAttempt(store, input('attempt-b', shaB)), { code: 'recovery_unverified' });
  }
  adapter.setRecovery(recovery);
  assert.equal((await prepareAttempt(store, input('attempt-b', shaB))).attemptId, 'attempt-b');
});

test('expired resource locks cannot be taken over while a Stripe intent is unresolved', async () => {
  const adapter = fakeAdapter();
  const store = createAttemptStore(adapter);
  const prior = await prepareAttempt(store, input());
  adapter.stripeIntents.set('intent-unresolved', { intentId: 'intent-unresolved',
    attemptId: prior.attemptId, operation: 'checkout:create:ambiguous' });
  adapter.advance(61);

  await assert.rejects(prepareAttempt(store, input('attempt-b', shaB)), { code: 'recovery_unverified' });
  assert.equal(adapter.resourceLocks.size, 2);
  assert.equal(adapter.reservations.size, 1);
});

test('recovery handoff rotates the fence for read and reconciliation only while retaining locks and reservation', async () => {
  const adapter = fakeAdapter();
  const store = createAttemptStore(adapter);
  assert.equal(typeof store.handoffStripeIntentRecovery, 'function');
  assert.equal(typeof store.listPendingStripeIntents, 'function');
  const prior = await prepareAttempt(store, input());
  const operation = 'checkout:create:orphaned';
  const intent = await store.beginStripeIntent({ attemptId: prior.attemptId, fence: prior.fence,
    candidateSha: prior.candidateSha, workflow: prior.workflow, environment: prior.environment,
    action: 'checkout.replay', operation, requestDigest: 'e'.repeat(64),
    idempotencyKey: providerIdempotencyKey(prior.attemptId, 'stripe', operation) });
  await store.transition({ attemptId: prior.attemptId, fence: prior.fence,
    from: 'collecting', to: 'cancelled' });
  adapter.setRecovery({ runTerminal: true, runnerRemoved: true, cleanupComplete: false,
    currentRun: { ...prior.workflow, runId: '200', runAttempt: 1 } });
  adapter.advance(61);

  const recovery = await store.handoffStripeIntentRecovery({ attemptId: prior.attemptId,
    fence: prior.fence, ttlSeconds: 60 });
  assert.notEqual(recovery.fence, prior.fence);
  assert.equal(recovery.state, 'rechecking');
  assert.equal(recovery.cleanupStatus, 'pending');
  assert.deepEqual((await store.listPendingStripeIntents({ attemptId: prior.attemptId,
    fence: recovery.fence })).map(({ intentId }) => intentId), [intent.intentId]);
  await assert.rejects(store.listPendingStripeIntents({ attemptId: prior.attemptId,
    fence: prior.fence }), { code: 'lease_fence_lost' });
  await assert.rejects(store.reconcileStripeIntent({ attemptId: prior.attemptId,
    fence: prior.fence, intentId: intent.intentId, observation: {
      accountId: environment.stripe.accountId, livemode: false, operation,
      requestDigest: intent.requestDigest, idempotencyKey: intent.idempotencyKey,
      resourceIds: ['cs_synthetic123'],
    } }), { code: 'lease_fence_lost' });
  await assert.rejects(store.beginStripeIntent({ attemptId: prior.attemptId, fence: recovery.fence,
    candidateSha: prior.candidateSha, workflow: prior.workflow, environment: prior.environment,
    action: 'checkout.replay', operation: 'checkout:create:recovery-mutation',
    requestDigest: 'f'.repeat(64), idempotencyKey: providerIdempotencyKey(prior.attemptId,
      'stripe', 'checkout:create:recovery-mutation') }), { code: 'recovery_read_only' });
  let fixtureWrites = 0;
  await assert.rejects(store.fixtureMutation({ attemptId: prior.attemptId, fence: recovery.fence },
    async () => { fixtureWrites++; }), { code: 'recovery_read_only' });
  assert.equal(fixtureWrites, 0);

  const observation = { accountId: environment.stripe.accountId, livemode: false, operation,
    requestDigest: intent.requestDigest, idempotencyKey: intent.idempotencyKey,
    resourceIds: ['cs_synthetic123'] };
  const receipt = await store.reconcileStripeIntent({ attemptId: prior.attemptId,
    fence: recovery.fence, intentId: intent.intentId, observation });
  assert.equal(receipt.fence, recovery.fence);
  assert.deepEqual(await store.listPendingStripeIntents({ attemptId: prior.attemptId,
    fence: recovery.fence }), []);
  assert.equal(adapter.leases.get(JSON.stringify(key)).fence, recovery.fence);
  assert.equal(adapter.resourceLocks.size, 2);
  assert.equal(adapter.reservations.size, 1);
  assert.equal(adapter.receipts.size, 0);
  assert.equal(adapter.attempts.get(prior.attemptId).cleanupStatus, 'pending');
});

test('interrupted Stripe recovery hands off repeatedly using the latest verified recovery run', async () => {
  const adapter = fakeAdapter();
  const store = createAttemptStore(adapter);
  const prior = await prepareAttempt(store, input());
  const operation = 'checkout:create:repeat-recovery';
  const intent = await store.beginStripeIntent({ attemptId: prior.attemptId, fence: prior.fence,
    candidateSha: prior.candidateSha, workflow: prior.workflow, environment: prior.environment,
    action: 'checkout.replay', operation, requestDigest: 'd'.repeat(64),
    idempotencyKey: providerIdempotencyKey(prior.attemptId, 'stripe', operation) });
  await store.transition({ attemptId: prior.attemptId, fence: prior.fence,
    from: 'collecting', to: 'cancelled' });
  const firstRecoveryRun = { ...prior.workflow, runId: '200', runAttempt: 1 };
  const secondRecoveryRun = { ...prior.workflow, runId: '300', runAttempt: 1 };
  const recoveryChecks = [];
  adapter.verifyRecovery = async (input) => {
    recoveryChecks.push(input);
    if (input.ownerRun.runId === '100') {
      return { runTerminal: true, runnerRemoved: true, currentRun: firstRecoveryRun };
    }
    if (input.ownerRun.runId === '200') {
      return { runTerminal: true, runnerRemoved: true, currentRun: secondRecoveryRun };
    }
    return { runTerminal: false, runnerRemoved: false, currentRun: secondRecoveryRun };
  };

  const first = await store.handoffStripeIntentRecovery({ attemptId: prior.attemptId, fence: prior.fence });
  const second = await store.handoffStripeIntentRecovery({ attemptId: prior.attemptId, fence: first.fence });

  assert.notEqual(first.fence, prior.fence);
  assert.notEqual(second.fence, first.fence);
  assert.deepEqual(recoveryChecks.map(({ ownerRun }) => ownerRun.runId), ['100', '200']);
  assert.equal(adapter.leases.get(JSON.stringify(key)).ownerRunId, '300');
  assert.ok([...adapter.resourceLocks.values()].every((lock) => lock.workflow.runId === '300' &&
    lock.fence === second.fence));
  assert.deepEqual((await store.listPendingStripeIntents({ attemptId: prior.attemptId,
    fence: second.fence })).map(({ intentId }) => intentId), [intent.intentId]);
  assert.equal(adapter.reservations.size, 1);
  assert.equal(adapter.receipts.size, 0);
  assert.equal(adapter.cleanupReceipts.size, 0);
});

test('recovery-only authority blocks fixture and Stripe writes after terminal transitions, renewals, and handoffs', async () => {
  for (const terminalState of ['cancelled', 'complete', 'timed_out']) {
    const adapter = fakeAdapter();
    const store = createAttemptStore(adapter);
    const prior = await prepareAttempt(store, input(`attempt-terminal-${terminalState}`, shaA,
      `invoice-${terminalState}`));
    const initialOperation = `checkout:create:terminal-${terminalState}`;
    await store.beginStripeIntent({ attemptId: prior.attemptId, fence: prior.fence,
      candidateSha: prior.candidateSha, workflow: prior.workflow, environment: prior.environment,
      action: 'checkout.replay', operation: initialOperation, requestDigest: 'a'.repeat(64),
      idempotencyKey: providerIdempotencyKey(prior.attemptId, 'stripe', initialOperation) });
    await store.transition({ attemptId: prior.attemptId, fence: prior.fence,
      from: 'collecting', to: 'cancelled' });

    const firstRecoveryRun = { ...prior.workflow, runId: '200', runAttempt: 1 };
    const secondRecoveryRun = { ...prior.workflow, runId: '300', runAttempt: 1 };
    adapter.verifyRecovery = async ({ ownerRun }) => ({ runTerminal: true, runnerRemoved: true,
      currentRun: ownerRun.runId === '100' ? firstRecoveryRun : secondRecoveryRun });
    adapter.advance(61);
    const first = await store.handoffStripeIntentRecovery({ attemptId: prior.attemptId,
      fence: prior.fence });
    await store.renew({ attemptId: prior.attemptId, fence: first.fence, ttlSeconds: 90 });
    const latest = await store.handoffStripeIntentRecovery({ attemptId: prior.attemptId,
      fence: first.fence });
    await store.transition({ attemptId: prior.attemptId, fence: latest.fence,
      from: 'rechecking', to: terminalState });

    let fixtureWrites = 0;
    let providerDispatches = 0;
    const results = await Promise.allSettled([
      store.fixtureMutation({ attemptId: prior.attemptId, fence: latest.fence }, async () => {
        fixtureWrites++;
      }),
      runStripeMutation({ attempts: store, owner: { attemptId: prior.attemptId,
        fence: latest.fence, candidateSha: prior.candidateSha, workflow: prior.workflow,
        environment: prior.environment, webhookEndpointId: 'we_controltest' }, action: 'checkout.replay',
      operation: `checkout:create:blocked-${terminalState}`, input: {},
      idempotencyKey: providerIdempotencyKey(prior.attemptId, 'stripe',
        `checkout:create:blocked-${terminalState}`), adapter: { mutate: async () => {
        providerDispatches++;
      } }, readers: { expectedEnvironment: prior.environment, expectedWebhookEndpointId: 'we_controltest',
        async assertReady() { return true; } }, readerBinding: { attemptId: prior.attemptId,
        caseId: 'payment.approved', startedAt: '2026-09-23T09:00:00.000Z' } }),
    ]);

    assert.deepEqual(results.map((result) => result.status), ['rejected', 'rejected']);
    assert.deepEqual(results.map((result) => result.reason.code), ['recovery_read_only', 'recovery_read_only']);
    assert.equal(fixtureWrites, 0);
    assert.equal(providerDispatches, 0);
    assert.equal(adapter.stripeIntents.size, 1);
    assert.equal(adapter.leases.get(JSON.stringify(prior.key)).recoveryOnly, true);
  }
});

test('recovery may resume after its final reconciliation but never starts with no pending intent', async () => {
  const initialAdapter = fakeAdapter();
  const initialStore = createAttemptStore(initialAdapter);
  const initial = await prepareAttempt(initialStore, input('attempt-empty-initial', shaA, 'invoice-empty-initial'));
  await initialStore.transition({ attemptId: initial.attemptId, fence: initial.fence,
    from: 'collecting', to: 'cancelled' });
  let initialProofCalls = 0;
  initialAdapter.verifyRecovery = async () => {
    initialProofCalls++;
    return { runTerminal: true, runnerRemoved: true,
      currentRun: { ...initial.workflow, runId: '200', runAttempt: 1 } };
  };
  await assert.rejects(initialStore.handoffStripeIntentRecovery({ attemptId: initial.attemptId,
    fence: initial.fence }), { code: 'recovery_unverified' });
  assert.equal(initialProofCalls, 0);
  assert.equal(initialAdapter.leases.get(JSON.stringify(initial.key)).fence, initial.fence);

  const adapter = fakeAdapter();
  const store = createAttemptStore(adapter);
  const prior = await prepareAttempt(store, input('attempt-final-reconcile', shaA, 'invoice-final-reconcile'));
  const operation = 'checkout:create:final-reconcile';
  const intent = await store.beginStripeIntent({ attemptId: prior.attemptId, fence: prior.fence,
    candidateSha: prior.candidateSha, workflow: prior.workflow, environment: prior.environment,
    action: 'checkout.replay', operation, requestDigest: 'b'.repeat(64),
    idempotencyKey: providerIdempotencyKey(prior.attemptId, 'stripe', operation) });
  await store.transition({ attemptId: prior.attemptId, fence: prior.fence,
    from: 'collecting', to: 'cancelled' });
  const firstRecoveryRun = { ...prior.workflow, runId: '200', runAttempt: 1 };
  const secondRecoveryRun = { ...prior.workflow, runId: '300', runAttempt: 1 };
  const recoveryEvidence = [];
  adapter.verifyRecovery = async ({ ownerRun, pendingIntents }) => {
    recoveryEvidence.push({ ownerRun, pendingIntents });
    return { runTerminal: true, runnerRemoved: true,
      currentRun: ownerRun.runId === '100' ? firstRecoveryRun : secondRecoveryRun };
  };
  const first = await store.handoffStripeIntentRecovery({ attemptId: prior.attemptId,
    fence: prior.fence });
  const observation = { accountId: environment.stripe.accountId, livemode: false, operation,
    requestDigest: intent.requestDigest, idempotencyKey: intent.idempotencyKey,
    resourceIds: ['cs_synthetic123'] };
  const receipt = await store.reconcileStripeIntent({ attemptId: prior.attemptId,
    fence: first.fence, intentId: intent.intentId, observation });
  const retainedLocks = [...adapter.resourceLocks.values()];
  const retainedReservation = [...adapter.reservations.values()];

  adapter.advance(100);
  adapter.verifyRecovery = async () => ({ runTerminal: false, runnerRemoved: false,
    currentRun: secondRecoveryRun });
  await assert.rejects(store.handoffStripeIntentRecovery({ attemptId: prior.attemptId,
    fence: first.fence }), { code: 'recovery_unverified' });
  adapter.verifyRecovery = async () => ({ runTerminal: true, runnerRemoved: true,
    currentRun: firstRecoveryRun });
  await assert.rejects(store.handoffStripeIntentRecovery({ attemptId: prior.attemptId,
    fence: first.fence }), { code: 'recovery_unverified' });
  assert.equal(adapter.leases.get(JSON.stringify(prior.key)).fence, first.fence);

  adapter.cleanupReceipts.set(prior.attemptId, { attemptId: prior.attemptId });
  await assert.rejects(store.handoffStripeIntentRecovery({ attemptId: prior.attemptId,
    fence: first.fence }), { code: 'recovery_unverified' });
  adapter.cleanupReceipts.delete(prior.attemptId);
  const [reservationId, reservationRow] = adapter.reservations.entries().next().value;
  adapter.reservations.delete(reservationId);
  await assert.rejects(store.handoffStripeIntentRecovery({ attemptId: prior.attemptId,
    fence: first.fence }), { code: 'recovery_unverified' });
  adapter.reservations.set(reservationId, reservationRow);
  const savedLocks = new Map(adapter.resourceLocks);
  adapter.resourceLocks.clear();
  await assert.rejects(store.handoffStripeIntentRecovery({ attemptId: prior.attemptId,
    fence: first.fence }), { code: 'lease_fence_lost' });
  for (const [lockKey, lock] of savedLocks) adapter.resourceLocks.set(lockKey, lock);
  adapter.verifyRecovery = async ({ ownerRun, pendingIntents }) => {
    recoveryEvidence.push({ ownerRun, pendingIntents });
    return { runTerminal: true, runnerRemoved: true,
      currentRun: ownerRun.runId === '100' ? firstRecoveryRun : secondRecoveryRun };
  };

  const resumed = await store.handoffStripeIntentRecovery({ attemptId: prior.attemptId,
    fence: first.fence });

  assert.notEqual(resumed.fence, first.fence);
  assert.equal(resumed.state, 'rechecking');
  assert.equal(adapter.leases.get(JSON.stringify(prior.key)).recoveryOnly, true);
  assert.equal(recoveryEvidence[1].ownerRun.runId, '200');
  assert.deepEqual(recoveryEvidence[1].pendingIntents, []);
  assert.equal(adapter.stripeReceipts.get(intent.intentId).receiptId, receipt.receiptId);
  assert.deepEqual([...adapter.resourceLocks.values()].map(({ resourceType, resourceId }) =>
    `${resourceType}:${resourceId}`).sort(), retainedLocks.map(({ resourceType, resourceId }) =>
    `${resourceType}:${resourceId}`).sort());
  assert.ok([...adapter.resourceLocks.values()].every(({ attemptId, fence }) =>
    attemptId === prior.attemptId && fence === resumed.fence));
  assert.deepEqual([...adapter.reservations.values()], retainedReservation);
  assert.equal(adapter.cleanupReceipts.size, 0);

  await store.transition({ attemptId: prior.attemptId, fence: resumed.fence,
    from: 'rechecking', to: 'complete' });
  const cleanup = await store.cleanup({ attemptId: prior.attemptId, fence: resumed.fence,
    projection: cleanupProjection });
  assert.equal(cleanup.cleanupStatus, 'complete');
  assert.equal(adapter.cleanupReceipts.size, 1);
  assert.equal(adapter.resourceLocks.size, 0);
  await assert.rejects(store.handoffStripeIntentRecovery({ attemptId: prior.attemptId,
    fence: resumed.fence }), { code: 'recovery_unverified' });
});

test('intent recovery requires verifier-bound current run identity and ignores caller terminal flags', async () => {
  const adapter = fakeAdapter();
  const store = createAttemptStore(adapter);
  const prior = await prepareAttempt(store, input());
  const operation = 'checkout:create:missing-recovery-proof';
  await store.beginStripeIntent({ attemptId: prior.attemptId, fence: prior.fence,
    candidateSha: prior.candidateSha, workflow: prior.workflow, environment: prior.environment,
    action: 'checkout.replay', operation, requestDigest: 'e'.repeat(64),
    idempotencyKey: providerIdempotencyKey(prior.attemptId, 'stripe', operation) });
  await store.transition({ attemptId: prior.attemptId, fence: prior.fence,
    from: 'collecting', to: 'cancelled' });
  adapter.advance(61);

  adapter.setRecovery({ runTerminal: true, runnerRemoved: true });
  await assert.rejects(store.handoffStripeIntentRecovery({ attemptId: prior.attemptId,
    fence: prior.fence, runTerminal: true, runnerRemoved: true,
    currentRun: { ...prior.workflow, runId: '200', runAttempt: 1 } }), { code: 'recovery_unverified' });
  adapter.setRecovery({ runTerminal: false, runnerRemoved: false,
    currentRun: { ...prior.workflow, runId: '200', runAttempt: 1 } });
  await assert.rejects(store.handoffStripeIntentRecovery({ attemptId: prior.attemptId,
    fence: prior.fence, runTerminal: true, runnerRemoved: true }), { code: 'recovery_unverified' });

  assert.equal(adapter.leases.get(JSON.stringify(key)).fence, prior.fence);
  assert.equal(adapter.resourceLocks.size, 2);
  assert.equal(adapter.reservations.size, 1);
  assert.equal(adapter.cleanupReceipts.size, 0);
});

test('intent recovery refuses unless verifyRecovery confirms a terminal run and removed runner', async () => {
  const adapter = fakeAdapter();
  const store = createAttemptStore(adapter);
  const prior = await prepareAttempt(store, input());
  const operation = 'checkout:create:unproven-recovery';
  await store.beginStripeIntent({ attemptId: prior.attemptId, fence: prior.fence,
    candidateSha: prior.candidateSha, workflow: prior.workflow, environment: prior.environment,
    action: 'checkout.replay', operation, requestDigest: 'd'.repeat(64),
    idempotencyKey: providerIdempotencyKey(prior.attemptId, 'stripe', operation) });
  await store.transition({ attemptId: prior.attemptId, fence: prior.fence,
    from: 'collecting', to: 'cancelled' });
  adapter.setRecovery({ runTerminal: true, runnerRemoved: false });
  adapter.advance(61);

  await assert.rejects(store.handoffStripeIntentRecovery({ attemptId: prior.attemptId,
    fence: prior.fence }), { code: 'recovery_unverified' });
  assert.equal(adapter.leases.get(JSON.stringify(key)).fence, prior.fence);
  assert.equal(adapter.resourceLocks.size, 2);
  assert.equal(adapter.reservations.size, 1);
});

test('Stripe intent binds its operation immutably and only exact independent TEST observation settles it', async () => {
  const adapter = fakeAdapter();
  const store = createAttemptStore(adapter);
  const owner = await prepareAttempt(store, input());
  const intentOwner = { attemptId: owner.attemptId, fence: owner.fence,
    candidateSha: owner.candidateSha, workflow: owner.workflow, environment: owner.environment };
  const operation = 'checkout:create:attempt-a';
  const idempotencyKey = providerIdempotencyKey(owner.attemptId, 'stripe', operation);
  const intent = await store.beginStripeIntent({ ...intentOwner, action: 'checkout.replay', operation,
    requestDigest: 'd'.repeat(64), idempotencyKey });

  assert.equal(intent.state, 'in_flight');
  assert.equal(intent.candidateSha, shaA);
  assert.deepEqual(intent.workflow, owner.workflow);
  assert.deepEqual(intent.environment, environment);
  await assert.rejects(store.beginStripeIntent({ ...intentOwner, action: 'checkout.replay', operation,
    requestDigest: 'e'.repeat(64), idempotencyKey }), { code: 'stripe_intent_unresolved' });

  const observation = { accountId: environment.stripe.accountId, livemode: false, operation,
    requestDigest: intent.requestDigest, idempotencyKey, resourceIds: ['cs_synthetic123'] };
  const receipt = await store.reconcileStripeIntent({ attemptId: owner.attemptId,
    fence: owner.fence, intentId: intent.intentId, observation });
  assert.equal(receipt.intentId, intent.intentId);
  assert.equal(receipt.observationDigest.length, 64);
  assert.deepEqual(receipt.resourceIds, observation.resourceIds);
  assert.equal(await adapter.transaction((tx) => tx.hasInFlightStripeIntent(owner.attemptId)), false);
  await assert.rejects(store.reconcileStripeIntent({ attemptId: owner.attemptId,
    fence: owner.fence, intentId: intent.intentId, observation }),
  { code: 'stripe_intent_already_reconciled' });
});

test('expired Test Clock observation cannot settle an intent or release its resource locks', async () => {
  const adapter = fakeAdapter();
  const store = createAttemptStore(adapter);
  const owner = await prepareAttempt(store, input());
  const intentOwner = { attemptId: owner.attemptId, fence: owner.fence,
    candidateSha: owner.candidateSha, workflow: owner.workflow, environment: owner.environment };
  const operation = 'checkout:create:clock-window';
  const intent = await store.beginStripeIntent({ ...intentOwner, action: 'checkout.replay', operation,
    requestDigest: 'f'.repeat(64), idempotencyKey: providerIdempotencyKey(owner.attemptId,
      'stripe', operation) });
  await assert.rejects(store.reconcileStripeIntent({ attemptId: owner.attemptId,
    fence: owner.fence, intentId: intent.intentId, observation: {
      accountId: environment.stripe.accountId, livemode: false, operation,
      requestDigest: intent.requestDigest, idempotencyKey: intent.idempotencyKey,
      resourceIds: ['cs_synthetic123'], testClock: { id: 'clock_expired123', deletes_after: 999 },
    } }), { code: 'stripe_reconciliation_window_expired' });
  assert.equal(adapter.stripeReceipts.size, 0);
  await assert.rejects(cleanupAttempt(store, { attemptId: owner.attemptId,
    fence: owner.fence, projection: cleanupProjection, verified: true }), { code: 'cleanup_not_terminal' });
  assert.equal(adapter.resourceLocks.size, 2);
});

test('store cleanup refuses a terminal attempt with any unresolved Stripe intent', async () => {
  const adapter = fakeAdapter();
  const store = createAttemptStore(adapter);
  const owner = await prepareAttempt(store, input());
  const operation = 'checkout:create:cleanup-blocked';
  await store.beginStripeIntent({ attemptId: owner.attemptId, fence: owner.fence,
    candidateSha: owner.candidateSha, workflow: owner.workflow, environment: owner.environment,
    action: 'checkout.replay', operation, requestDigest: 'b'.repeat(64),
    idempotencyKey: providerIdempotencyKey(owner.attemptId, 'stripe', operation) });
  await store.transition({ attemptId: owner.attemptId, fence: owner.fence,
    from: 'collecting', to: 'cancelled' });

  await assert.rejects(store.cleanup({ attemptId: owner.attemptId, fence: owner.fence,
    projection: cleanupProjection }),
    { code: 'stripe_intent_unresolved' });
  assert.equal(adapter.leases.get(JSON.stringify(key)).fence, owner.fence);
  assert.equal(adapter.resourceLocks.size, 2);
  assert.equal(adapter.reservations.size, 1);
  assert.equal(adapter.attempts.get(owner.attemptId).cleanupStatus, 'pending');
});

test('stale owner cannot mutate a fixture, invoke an external mutation or release successor lease', async () => {
  const adapter = fakeAdapter();
  const store = createAttemptStore(adapter);
  const old = await prepareAttempt(store, input());
  const operation = 'checkout:create:stale-owner';
  const intent = await store.beginStripeIntent({ attemptId: old.attemptId, fence: old.fence,
    candidateSha: old.candidateSha, workflow: old.workflow, environment: old.environment,
    action: 'checkout.replay', operation, requestDigest: 'c'.repeat(64),
    idempotencyKey: providerIdempotencyKey(old.attemptId, 'stripe', operation) });
  await store.reconcileStripeIntent({ attemptId: old.attemptId, fence: old.fence,
    intentId: intent.intentId, observation: { accountId: environment.stripe.accountId,
      livemode: false, operation, requestDigest: intent.requestDigest,
      idempotencyKey: intent.idempotencyKey, resourceIds: ['cs_synthetic123'] } });
  await store.reconcileReservation({ reservationId: old.reservationId, outcome: 'cancelled',
    retained: projection });
  await store.transition({ attemptId: old.attemptId, fence: old.fence,
    from: 'collecting', to: 'cancelled' });
  adapter.advance(61);
  const fresh = await prepareAttempt(store, input('attempt-b', shaB));
  let mutations = 0;
  await assert.rejects(withFixtureMutation(store, old, async () => { mutations++; }), { code: 'lease_fence_lost' });
  await assert.rejects(withExternalFence(store, old, async () => { mutations++; }), { code: 'lease_fence_lost' });
  await assert.rejects(store.transition({ attemptId: old.attemptId, fence: old.fence,
    from: 'cancelled', to: 'timed_out' }), { code: 'lease_fence_lost' });
  await assert.rejects(store.renew({ attemptId: old.attemptId, fence: old.fence, ttlSeconds: 60 }),
    { code: 'lease_fence_lost' });
  await assert.rejects(cleanupAttempt(store, { attemptId: old.attemptId, fence: old.fence,
    projection: cleanupProjection, verified: true }), { code: 'lease_fence_lost' });
  await assert.rejects(store.beginStripeIntent({ attemptId: old.attemptId, fence: old.fence,
    candidateSha: old.candidateSha, workflow: old.workflow, environment: old.environment,
    action: 'checkout.replay', operation: 'checkout:create:stale-after-takeover',
    requestDigest: 'b'.repeat(64), idempotencyKey: providerIdempotencyKey(old.attemptId,
      'stripe', 'checkout:create:stale-after-takeover') }), { code: 'lease_fence_lost' });
  await assert.rejects(store.reconcileStripeIntent({ attemptId: old.attemptId, fence: old.fence,
    intentId: intent.intentId, observation: { accountId: environment.stripe.accountId,
      livemode: false, operation, requestDigest: intent.requestDigest,
      idempotencyKey: intent.idempotencyKey, resourceIds: ['cs_synthetic123'] } }),
  { code: 'lease_fence_lost' });
  await assert.rejects(prepareAttempt(store, input(old.attemptId, old.candidateSha)),
    { code: 'attempt_replay_expired' });
  assert.equal(mutations, 0);
  assert.equal((await store.getAttempt(fresh.attemptId)).state, 'collecting');
  assert.equal(adapter.reservations.size, 2);
  assert.equal(adapter.resourceLocks.size, 2);
  for (const lock of adapter.resourceLocks.values()) {
    assert.equal(lock.attemptId, fresh.attemptId);
    assert.equal(lock.fence, fresh.fence);
  }
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

test('prepare rejects environment accessors without invoking them or entering a write transaction', async () => {
  const adapter = fakeAdapter();
  const store = createAttemptStore(adapter);
  let getterCalls = 0;
  const stripe = Object.defineProperty({}, 'accountId', {
    enumerable: true,
    get() { getterCalls++; return environment.stripe.accountId; },
  });
  const unsafeEnvironment = { database: { ...environment.database },
    deployment: { ...environment.deployment }, stripe };

  await assert.rejects(prepareAttempt(store, { ...input(), environment: unsafeEnvironment }),
    { code: 'attempt_input_invalid' });
  assert.equal(getterCalls, 0);
  assert.equal(adapter.transactionCount(), 0);
  assert.equal(adapter.attempts.size, 0);
  assert.equal(adapter.reservations.size, 0);
  assert.equal(adapter.leases.size, 0);
});

test('prepare uses one detached environment snapshot for target validation, attempt, and retention scope', async () => {
  const adapter = fakeAdapter();
  const expectedEnvironment = structuredClone(environment);
  adapter.expectedEnvironment = expectedEnvironment;
  const store = createAttemptStore(adapter);
  const mutableEnvironment = structuredClone(environment);
  const pending = prepareAttempt(store, { ...input(), environment: mutableEnvironment });
  mutableEnvironment.stripe.accountId = 'acct_changedAfterValidation';

  const row = await pending;
  const reservation = adapter.reservations.get(row.reservationId);
  assert.deepEqual(row.environment, environment);
  assert.deepEqual(reservation.scope, {
    projectRef: environment.database.projectRef,
    branchId: environment.database.branchId,
    stripeAccountId: environment.stripe.accountId,
  });
});

test('prepare pins the expected environment snapshot when the store is created', async () => {
  const adapter = fakeAdapter();
  const expectedEnvironment = structuredClone(environment);
  adapter.expectedEnvironment = expectedEnvironment;
  const store = createAttemptStore(adapter);
  expectedEnvironment.stripe.accountId = 'acct_changedAfterStoreSetup';

  const row = await prepareAttempt(store, input());
  assert.deepEqual(row.environment, environment);
});

test('store rejects inherited expected-environment bindings without invoking accessors', () => {
  let getterCalls = 0;
  const inheritedGetter = Object.create(null);
  Object.defineProperty(inheritedGetter, 'expectedEnvironment', {
    enumerable: true,
    get() { getterCalls++; return environment; },
  });
  const inheritedData = Object.create(null, {
    expectedEnvironment: { enumerable: true, value: structuredClone(environment) },
  });

  for (const prototype of [inheritedGetter, inheritedData]) {
    const adapter = Object.assign(Object.create(prototype), fakeAdapter());
    assert.throws(() => createAttemptStore(adapter), { code: 'store_client_invalid' });
  }
  assert.equal(getterCalls, 0);
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
    fence: row.fence, projection: cleanupProjection, verified: true }), { code: 'cleanup_unverified' });
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
    fence: row.fence, projection: cleanupProjection, verified: true }), { code: 'cleanup_not_terminal' });
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
  await store.reconcileReservation({ reservationId: first.reservationId, outcome: 'cancelled', retained: writes });
  await store.transition({ attemptId: first.attemptId, fence: first.fence,
    from: 'collecting', to: 'cancelled' });
  await cleanupAttempt(store, { attemptId: first.attemptId, fence: first.fence,
    projection: cleanupProjection, verified: true });
  const second = await prepareAttempt(store, { ...input('attempt-b', shaB, 'invoice-b'),
    retentionPolicy: policy, projection: writes });
  assert.deepEqual(second.capacity.projected, policy.quotas);
  assert.deepEqual(second.capacity.remaining, { attempts: 0, databaseRows: 0, authUsers: 0, stripeObjects: 0 });
  await store.reconcileReservation({ reservationId: second.reservationId, outcome: 'cancelled', retained: writes });
  await store.transition({ attemptId: second.attemptId, fence: second.fence,
    from: 'collecting', to: 'cancelled' });
  await cleanupAttempt(store, { attemptId: second.attemptId, fence: second.fence,
    projection: cleanupProjection, verified: true });
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
  await store.transition({ attemptId: owner.attemptId, fence: owner.fence,
    from: 'collecting', to: 'timed_out' });
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
