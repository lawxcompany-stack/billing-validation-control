import assert from 'node:assert/strict';
import { test } from 'node:test';
import { challengeCapabilities, environment, importIfMissing, makeAttemptParts, needExport,
  expectRefusal } from './support.mjs';

const contracts = await importIfMissing(() => import('../../src/billing/contracts.mjs'));

function enableLocalStripeIntents(h) {
  const intents = new Map();
  h.attempts.beginStripeIntent = async (request) => {
    const key = `${request.attemptId}:${request.operation}`;
    if (intents.has(key)) throw Object.assign(new Error('stripe_intent_unresolved'), {
      code: 'stripe_intent_unresolved',
    });
    const intent = { intentId: `intent-${intents.size + 1}`, ...structuredClone(request),
      accountId: request.environment.stripe.accountId, state: 'in_flight' };
    intents.set(key, intent);
    return intent;
  };
  return intents;
}

function pinLocalStripeIdentity(h) {
  const priorAssertFence = h.attempts.assertFence;
  const identity = { candidateSha: 'd'.repeat(40), workflow: {
    repository: 'lawxcompany-stack/billing-validation-control', ref: 'refs/heads/main',
    runId: '987654321', runAttempt: 3, runnerLabel: `billing-validation-${'e'.repeat(32)}` } };
  h.attempts.assertFence = async (request) => ({ ...await priorAssertFence(request), ...identity });
}

function installSupabaseFixtureMutation(h, { fenceAtTransactionStart = h.owner.fence } = {}) {
  const calls = { transactions: [], writes: [] };
  h.attempts.fixtureMutation = async (owner, mutation) => {
    const tx = Object.freeze({ connection: Symbol('supabase-transaction') });
    calls.transactions.push({ owner: { ...owner }, tx });
    if (owner.attemptId !== h.owner.attemptId || owner.fence !== fenceAtTransactionStart) {
      throw Object.assign(new Error('lease_fence_lost'), { code: 'lease_fence_lost' });
    }
    return mutation(tx);
  };
  h.mutationAdapter.mutateInTransaction = async (request, tx) => {
    calls.writes.push({ request: structuredClone(request), tx });
    h.calls.mutations.push(structuredClone(request));
  };
  return calls;
}

test('provider mutations bind the current fence, exact child and TEST identity, and attempt-scoped key', async () => {
  const create = needExport(contracts, 'createVerifiedContext');
  const mutate = needExport(contracts, 'mutateProvider');
  const h = makeAttemptParts();
  pinLocalStripeIdentity(h);
  enableLocalStripeIntents(h);
  const context = create(h);
  await mutate(context, { provider: 'stripe', action: 'checkout.replay', operation: 'checkout-replay:quote_task6',
    input: { applicationRequest: { quoteId: 'quote_task6', idempotencyKey: 'quote-scoped-replay-0001', sessionParams: {} } } });
  const [request] = h.calls.mutations;
  assert.equal(request.attemptId, h.owner.attemptId);
  assert.equal(request.fence, h.owner.fence);
  assert.deepEqual(request.environment, environment);
  assert.match(request.idempotencyKey, /^billing-validation-[0-9a-f]{64}$/);
  assert.equal(h.calls.assertions.length, 2);
  assert.equal(JSON.stringify(request).includes('sk_test_private_output'), false);
});

test('Stripe mutation refuses before adapter invocation when durable intent storage is unavailable', async () => {
  const create = needExport(contracts, 'createVerifiedContext');
  const mutate = needExport(contracts, 'mutateProvider');
  const h = makeAttemptParts();
  delete h.attempts.beginStripeIntent;
  const context = create(h);
  await expectRefusal(mutate(context, { provider: 'stripe', action: 'checkout.replay',
    operation: 'checkout-replay:without-intent-store', input: {} }), 'stripe_intent_store_unavailable');
  assert.equal(h.calls.mutations.length, 0);
});

test('Stripe mutation intent binds the immutable SHA, workflow run identity and canonical request digest', async () => {
  const create = needExport(contracts, 'createVerifiedContext');
  const mutate = needExport(contracts, 'mutateProvider');
  const h = makeAttemptParts();
  const identity = {
    candidateSha: 'd'.repeat(40),
    workflow: { repository: 'lawxcompany-stack/billing-validation-control',
      ref: 'refs/heads/main', runId: '987654321', runAttempt: 3,
      runnerLabel: `billing-validation-${'e'.repeat(32)}` },
  };
  h.attempts.assertFence = async (input) => {
    h.calls.assertions.push({ ...input });
    return { ...h.owner, ...identity, state: 'rechecking', cleanupStatus: 'pending' };
  };
  enableLocalStripeIntents(h);
  const context = create(h);
  const input = { amount: 2500, currency: 'usd', metadata: { attempt: 'attempt-task6' } };
  await mutate(context, { provider: 'stripe', action: 'checkout.replay',
    operation: 'checkout-create:identity-bound', input });

  const [request] = h.calls.mutations;
  assert.equal(request.candidateSha, identity.candidateSha);
  assert.deepEqual(request.workflow, identity.workflow);
  assert.deepEqual(request.environment, environment);
  assert.match(request.requestDigest, /^[a-f0-9]{64}$/u);
  assert.equal(request.requestDigest, contracts.stripeRequestDigest({ action: 'checkout.replay',
    operation: 'checkout-create:identity-bound', input }));
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
  const transaction = installSupabaseFixtureMutation(h);
  const context = create(h);
  await mutate(context, { provider: 'supabase', action: 'fixtures.cleanup',
    operation: 'cleanup:database-fixtures', input: { databaseResources: [] } });
  assert.equal(h.calls.mutations.length, 1);
  assert.equal(h.calls.mutations[0].provider, 'supabase');
  assert.equal(h.calls.mutations[0].action, 'fixtures.cleanup');
  assert.equal(transaction.transactions.length, 1);
  assert.equal(transaction.writes.length, 1);
  assert.strictEqual(transaction.writes[0].tx, transaction.transactions[0].tx);
  assert.deepEqual(transaction.transactions[0].owner,
    { attemptId: h.owner.attemptId, fence: h.owner.fence });
});

test('Supabase cleanup refuses a fence lost before its fixture transaction writes', async () => {
  const create = needExport(contracts, 'createVerifiedContext');
  const mutate = needExport(contracts, 'mutateProvider');
  const h = makeAttemptParts();
  const transaction = installSupabaseFixtureMutation(h, { fenceAtTransactionStart: 'successor-fence' });
  const context = create(h);

  await expectRefusal(mutate(context, { provider: 'supabase', action: 'fixtures.cleanup',
    operation: 'cleanup:lost-fence', input: { databaseResources: [] } }), 'lease_fence_lost');
  assert.equal(transaction.transactions.length, 1);
  assert.equal(transaction.writes.length, 0);
  assert.equal(h.calls.mutations.length, 0);
});

test('Supabase cleanup fails closed when the adapter has no transactional mutation method', async () => {
  const create = needExport(contracts, 'createVerifiedContext');
  const mutate = needExport(contracts, 'mutateProvider');
  const h = makeAttemptParts();
  const transaction = installSupabaseFixtureMutation(h);
  delete h.mutationAdapter.mutateInTransaction;
  const context = create(h);

  await expectRefusal(mutate(context, { provider: 'supabase', action: 'fixtures.cleanup',
    operation: 'cleanup:missing-transaction-method', input: { databaseResources: [] } }),
  'supabase_transaction_adapter_unavailable');
  assert.equal(transaction.transactions.length, 0);
  assert.equal(h.calls.mutations.length, 0);
});

test('Supabase cleanup fails closed when attempts has no fixture transaction', async () => {
  const create = needExport(contracts, 'createVerifiedContext');
  const mutate = needExport(contracts, 'mutateProvider');
  const h = makeAttemptParts();
  const transaction = installSupabaseFixtureMutation(h);
  delete h.attempts.fixtureMutation;
  const context = create(h);

  await expectRefusal(mutate(context, { provider: 'supabase', action: 'fixtures.cleanup',
    operation: 'cleanup:missing-fixture-transaction', input: { databaseResources: [] } }),
  'supabase_transaction_adapter_unavailable');
  assert.equal(transaction.transactions.length, 0);
  assert.equal(h.calls.mutations.length, 0);
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
