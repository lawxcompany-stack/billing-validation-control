import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAttemptStore } from '../../src/attempts/store.mjs';

function concurrentAdapter() {
  const attempts = new Map();
  const leases = new Map();
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
    leases,
    delayNextLease: () => { delayLease = true; },
    async transaction(fn) {
      const held = [];
      const tx = {
        now: async () => 1000,
        lockAttempt: async (id) => acquire(`attempt:${id}`, held),
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
