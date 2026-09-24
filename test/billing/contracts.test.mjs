import assert from 'node:assert/strict';
import { test } from 'node:test';
import { challengeCapabilities, environment, importIfMissing, makeAttemptParts, needExport,
  expectRefusal } from './support.mjs';

const contracts = await importIfMissing(() => import('../../src/billing/contracts.mjs'));

test('provider mutations bind the current fence, exact child and TEST identity, and attempt-scoped key', async () => {
  const create = needExport(contracts, 'createVerifiedContext');
  const mutate = needExport(contracts, 'mutateProvider');
  const h = makeAttemptParts();
  const context = create(h);
  await mutate(context, { provider: 'stripe', action: 'checkout.replay', operation: 'checkout-replay:quote_task6',
    input: { applicationRequest: { quoteId: 'quote_task6', idempotencyKey: 'quote-scoped-replay-0001', sessionParams: {} } } });
  const [request] = h.calls.mutations;
  assert.equal(request.attemptId, h.owner.attemptId);
  assert.equal(request.fence, h.owner.fence);
  assert.deepEqual(request.environment, environment);
  assert.match(request.idempotencyKey, /^billing-validation-[0-9a-f]{64}$/);
  assert.equal(h.calls.assertions.length, 1);
  assert.equal(JSON.stringify(request).includes('sk_test_private_output'), false);
});

test('a stale Task 5 fence refuses mutation before the injected adapter runs', async () => {
  const create = needExport(contracts, 'createVerifiedContext');
  const mutate = needExport(contracts, 'mutateProvider');
  const h = makeAttemptParts({ currentFence: 'successor-fence' });
  const context = create(h);
  await expectRefusal(mutate(context, { provider: 'stripe', action: 'checkout.replay', operation: 'checkout-replay:quote_task6', input: {} }), 'lease_fence_lost');
  assert.equal(h.calls.mutations.length, 0);
});

test('a returned successor fence cannot authorize mutation under the stale owner fence', async () => {
  const create = needExport(contracts, 'createVerifiedContext');
  const mutate = needExport(contracts, 'mutateProvider');
  const h = makeAttemptParts();
  h.attempts.assertFence = async () => ({ ...h.owner, fence: 'successor-fence' });
  const context = create(h);
  await expectRefusal(mutate(context, { provider: 'stripe', action: 'checkout.replay',
    operation: 'checkout-replay:quote_task6', input: {} }), 'lease_fence_lost');
  assert.equal(h.calls.mutations.length, 0);
});

test('provider mutation actions are closed and scoped to their provider', async () => {
  const create = needExport(contracts, 'createVerifiedContext');
  const mutate = needExport(contracts, 'mutateProvider');
  const h = makeAttemptParts();
  const context = create(h);
  for (const request of [
    { provider: 'stripe', action: 'webhook.resend', operation: 'unsupported-resend', input: { eventId: 'evt_task6' } },
    { provider: 'stripe', action: 'unknown.action', operation: 'unknown-stripe', input: {} },
    { provider: 'supabase', action: 'customer.delete', operation: 'wrong-provider', input: {} },
    { provider: 'supabase', action: 'unknown.action', operation: 'unknown-supabase', input: {} },
    { provider: 'stripe', action: 'fixtures.cleanup', operation: 'wrong-provider', input: {} },
  ]) {
    await expectRefusal(mutate(context, request), 'billing_mutation_invalid');
  }
  assert.equal(h.calls.assertions.length, 0);
  assert.equal(h.calls.mutations.length, 0);
});

test('fixtures.cleanup is an allowed action only for the Supabase adapter', async () => {
  const create = needExport(contracts, 'createVerifiedContext');
  const mutate = needExport(contracts, 'mutateProvider');
  const h = makeAttemptParts();
  const context = create(h);
  await mutate(context, { provider: 'supabase', action: 'fixtures.cleanup',
    operation: 'cleanup:database-fixtures', input: { databaseResources: [] } });
  assert.equal(h.calls.mutations.length, 1);
  assert.equal(h.calls.mutations[0].provider, 'supabase');
  assert.equal(h.calls.mutations[0].action, 'fixtures.cleanup');
});

test('a Task 4 live-mode or child mismatch refuses context construction', () => {
  const create = needExport(contracts, 'createVerifiedContext');
  const live = makeAttemptParts();
  live.preflight = { ...live.preflight, providerVerification: { ...live.preflight.providerVerification,
    stripe: { ...live.preflight.providerVerification.stripe, livemode: true } } };
  assert.throws(() => create(live), { code: 'billing_environment_unverified' });
  const wrongChild = makeAttemptParts();
  wrongChild.preflight = { ...wrongChild.preflight, expectedEnvironment: { ...environment,
    database: { ...environment.database, branchId: 'another-child-456' } } };
  assert.throws(() => create(wrongChild), { code: 'billing_environment_unverified' });
});

test('challenge witness mocks are opaque capabilities rather than user payloads', () => {
  const { witness } = challengeCapabilities();
  assert.notEqual(Object.getPrototypeOf(witness), Object.getPrototypeOf({}));
  assert.equal(Reflect.ownKeys(witness).length, 0);
});
