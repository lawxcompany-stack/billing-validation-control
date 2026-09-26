import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAttemptStore } from '../../src/attempts/store.mjs';

function concurrentAdapter() {
  const attempts = new Map();
  const leases = new Map();
  const reservations = new Map();
  const receipts = new Map();
  const locks = new Map();
  let delayLease = false;
  async function acquire(name, held) {
    const previous = locks.get(name) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    locks.set(name, current);
    await previous;
    held.push(release);
  }
  return {
    leases, reservations, receipts,
    delayNextLease: () => { delayLease = true; },
    async transaction(fn) {
      const held = [];
      const tx = {
        now: async () => 1000,
        lockAttempt: async (id) => acquire(`attempt:${id}`, held),
        lockRetention: async (scope) => acquire(`retention:${JSON.stringify(scope)}`, held),
        getAttempt: async (id) => structuredClone(attempts.get(id) ?? null),
        putAttempt: async (row) => attempts.set(row.attemptId, structuredClone(row)),
        async getLease(key) {
          if (delayLease) {
            delayLease = false;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          const serialized = JSON.stringify(key);
          await acquire(`lease:${serialized}`, held);
          return structuredClone(leases.get(serialized) ?? null);
        },
        putLease: async (row) => leases.set(JSON.stringify(row.key), structuredClone(row)),
        deleteLease: async (key) => leases.delete(JSON.stringify(key)),
        async getRetentionUsage(scope) {
          const matches = (row) => JSON.stringify(row.scope) === JSON.stringify(scope);
          const inScope = [...reservations.values()].filter(matches);
          const committed = { attempts: 0, databaseRows: 0, authUsers: 0, stripeObjects: 0 };
          const reserved = { ...committed };
          for (const reservation of inScope) {
            const receipt = receipts.get(reservation.reservationId);
            const bucket = receipt ? committed : reserved;
            const usage = receipt?.retained ?? reservation.projection;
            for (const quotaKey of Object.keys(bucket)) bucket[quotaKey] += usage[quotaKey];
          }
          return { committed, reserved, policyLimits: inScope[0]?.quotas ?? null };
        },
        async getRetentionReservationByAttempt(id) {
          return structuredClone([...reservations.values()].find((row) => row.attemptId === id) ?? null);
        },
        async getRetentionReservation(id) { return structuredClone(reservations.get(id) ?? null); },
        async getRetentionReceipt(id) { return structuredClone(receipts.get(id) ?? null); },
        async putRetentionReservation(row) { reservations.set(row.reservationId, structuredClone(row)); },
        async putRetentionReceipt(row) { receipts.set(row.reservationId, structuredClone(row)); },
        fixtureMutation: async (fn) => fn(),
      };
      try { return await fn(tx); }
      finally { for (const release of held.reverse()) release(); }
    },
  };
}

const key = { branchId: 'validation-child-1', suite: 'billing', fixtureKey: 'invoice-a' };
const candidateSha = 'a'.repeat(40);
const workflow = { repository: 'lawxcompany-stack/billing-validation-control',
  ref: 'refs/heads/main', runId: '100', runAttempt: 1,
  runnerLabel: 'billing-validation-' + 'a'.repeat(32) };
const environment = { database: { projectRef: 'abcdefghijklmnopqrst', branchId: key.branchId },
  deployment: { id: 'dpl_candidate123', origin: 'https://candidate.vercel.app' },
  stripe: { accountId: 'acct_synthetic123' } };
const input = { attemptId: 'attempt-a', key, candidateSha, workflow, environment, ttlSeconds: 60 };
input.retentionPolicy = { version: 1, quotas: {
  attempts: 20, databaseRows: 200, authUsers: 20, stripeObjects: 200,
} };
input.projection = { attempts: 1, databaseRows: 10, authUsers: 1, stripeObjects: 10 };

test('concurrent duplicate prepares serialize before reading attempt state', async () => {
  const adapter = concurrentAdapter();
  const store = createAttemptStore(adapter);
  adapter.delayNextLease();
  const [first, replay] = await Promise.all([store.prepare(input), store.prepare(input)]);
  assert.equal(first.fence, replay.fence);
});

test('concurrent cancel and collect cannot overwrite a stale attempt state', async () => {
  const adapter = concurrentAdapter();
  const store = createAttemptStore(adapter);
  const owner = await store.prepare(input);
  adapter.delayNextLease();
  const outcomes = await Promise.allSettled([
    store.transition({ attemptId: owner.attemptId, fence: owner.fence,
      from: 'collecting', to: 'cancelled' }),
    store.transition({ attemptId: owner.attemptId, fence: owner.fence,
      from: 'collecting', to: 'collected', artifact: { id: 'artifact-321',
        digest: 'c'.repeat(64), schema: 1 } }),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find((outcome) => outcome.status === 'rejected').reason.code, 'invalid_transition');
});

test('one attempt ID cannot leave leases on two fixture keys', async () => {
  const adapter = concurrentAdapter();
  const store = createAttemptStore(adapter);
  adapter.delayNextLease();
  const results = await Promise.allSettled([
    store.prepare(input),
    store.prepare({ ...input, key: { ...key, fixtureKey: 'invoice-b' } }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code,
    'attempt_replay_mismatch');
  assert.equal(adapter.leases.size, 1);
});

test('concurrent admissions serialize retained-capacity reads and cannot overbook a shared branch/account quota', async () => {
  const adapter = concurrentAdapter();
  const store = createAttemptStore(adapter);
  const limited = { ...input,
    retentionPolicy: { version: 1, quotas: { attempts: 1, databaseRows: 4, authUsers: 1, stripeObjects: 4 } },
    projection: { attempts: 1, databaseRows: 4, authUsers: 1, stripeObjects: 4 },
  };
  const outcomes = await Promise.allSettled([
    store.prepare(limited),
    store.prepare({ ...limited, attemptId: 'attempt-b', key: { ...key, fixtureKey: 'invoice-b' } }),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);
  assert.equal(outcomes.find((outcome) => outcome.status === 'rejected').reason.code,
    'retention_capacity_exceeded');
  assert.equal(adapter.reservations.size, 1);
});
