import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAttemptStore } from '../../src/attempts/store.mjs';
import * as lockModule from '../../src/attempts/lock.mjs';

function concurrentAdapter() {
  const attempts = new Map();
  const leases = new Map();
  const reservations = new Map();
  const receipts = new Map();
  const resourceLocks = new Map();
  const stripeIntents = new Map();
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
  const resourceKeys = (environment) => [
    { resourceType: 'supabase_branch', resourceId:
      `${environment.database.projectRef}:${environment.database.branchId}` },
    { resourceType: 'stripe_account', resourceId: environment.stripe.accountId },
  ].sort((a, b) => `${a.resourceType}:${a.resourceId}`.localeCompare(`${b.resourceType}:${b.resourceId}`));
  const resourceMapKey = (resource) => `${resource.resourceType}:${resource.resourceId}`;
  return {
    leases, reservations, receipts,
    delayNextLease: () => { delayLease = true; },
    async transaction(fn) {
      const held = [];
      const tx = {
        now: async () => 1000,
        lockAttempt: async (id) => acquire(`attempt:${id}`, held),
        lockRetention: async (scope) => acquire(`retention:${JSON.stringify(scope)}`, held),
        async lockResourceLocks(environment) {
          for (const resource of resourceKeys(environment)) {
            await acquire(`resource:${resourceMapKey(resource)}`, held);
          }
        },
        getAttempt: async (id) => structuredClone(attempts.get(id) ?? null),
        putAttempt: async (row) => attempts.set(row.attemptId, structuredClone(row)),
        async getResourceLocks(environment) {
          return resourceKeys(environment).map((resource) => resourceLocks.get(resourceMapKey(resource)))
            .filter(Boolean).map((row) => structuredClone(row));
        },
        async putResourceLocks(owner, previous) {
          const resources = resourceKeys(owner.environment);
          const current = resources.map((resource) => resourceLocks.get(resourceMapKey(resource))).filter(Boolean);
          if (JSON.stringify(current) !== JSON.stringify(previous)) {
            throw Object.assign(new Error('resource_lock_held'), { code: 'resource_lock_held' });
          }
          for (const resource of resources) resourceLocks.set(resourceMapKey(resource), {
            ...resource, attemptId: owner.attemptId, fence: owner.fence,
            candidateSha: owner.candidateSha, workflow: structuredClone(owner.workflow),
            environment: structuredClone(owner.environment), expiresAt: owner.expiresAt,
          });
        },
        async deleteResourceLocks(owner) {
          for (const resource of resourceKeys(owner.environment)) {
            const lock = resourceLocks.get(resourceMapKey(resource));
            if (lock?.attemptId !== owner.attemptId || lock.fence !== owner.fence) {
              throw Object.assign(new Error('lease_fence_lost'), { code: 'lease_fence_lost' });
            }
          }
          for (const resource of resourceKeys(owner.environment)) resourceLocks.delete(resourceMapKey(resource));
        },
        async hasInFlightStripeIntent(attemptId) {
          return [...stripeIntents.values()].some((intent) => intent.attemptId === attemptId);
        },
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

test('durable Stripe intent is committed before the injected provider adapter runs and remains unresolved on failure', async () => {
  const withStripeIntent = lockModule.withStripeIntent;
  assert.equal(typeof withStripeIntent, 'function');
  const events = [];
  const intents = new Map();
  const attempts = {
    async beginStripeIntent(input) {
      const key = `${input.attemptId}:${input.operation}`;
      if (intents.has(key)) throw Object.assign(new Error('stripe_intent_unresolved'), {
        code: 'stripe_intent_unresolved',
      });
      const intent = { intentId: 'intent_local_1', ...structuredClone(input), state: 'in_flight' };
      intents.set(key, intent);
      events.push('intent_persisted');
      return intent;
    },
  };
  const owner = { attemptId: 'attempt-local-1', fence: 'fence-local-1', candidateSha,
    workflow, environment };

  await assert.rejects(withStripeIntent(attempts, owner, {
    action: 'checkout.replay', operation: 'checkout:create:local-1', requestDigest: 'a'.repeat(64),
    idempotencyKey: 'billing-validation-' + 'a'.repeat(64),
  }, async () => {
    assert.equal(intents.get('attempt-local-1:checkout:create:local-1').state, 'in_flight');
    events.push('provider_invoked');
    throw new Error('network outcome is ambiguous');
  }), { code: 'stripe_mutation_ambiguous' });

  assert.deepEqual(events, ['intent_persisted', 'provider_invoked']);
  assert.equal(intents.size, 1);
  assert.equal(intents.get('attempt-local-1:checkout:create:local-1').state, 'in_flight');
  await assert.rejects(withStripeIntent(attempts, owner, {
    action: 'checkout.replay', operation: 'checkout:create:local-1', requestDigest: 'a'.repeat(64),
    idempotencyKey: 'billing-validation-' + 'a'.repeat(64),
  }, async () => { events.push('provider_retried'); }), { code: 'stripe_intent_unresolved' });
  assert.equal(events.includes('provider_retried'), false);
});

test('a stale fence cannot persist an intent or reach the injected provider adapter', async () => {
  const withStripeIntent = lockModule.withStripeIntent;
  assert.equal(typeof withStripeIntent, 'function');
  let invoked = false;
  const attempts = {
    async beginStripeIntent() {
      throw Object.assign(new Error('lease_fence_lost'), { code: 'lease_fence_lost' });
    },
  };

  await assert.rejects(withStripeIntent(attempts, { attemptId: 'attempt-old', fence: 'old-fence',
    candidateSha, workflow, environment }, {
    action: 'checkout.replay', operation: 'checkout:create:stale', requestDigest: 'b'.repeat(64),
    idempotencyKey: 'billing-validation-' + 'b'.repeat(64),
  }, async () => { invoked = true; }), { code: 'lease_fence_lost' });
  assert.equal(invoked, false);
});
