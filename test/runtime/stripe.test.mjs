import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyStripeEnvironment } from '../../src/runtime/stripe.mjs';
import * as stripeModule from '../../src/runtime/stripe.mjs';
import { providerIdempotencyKey } from '../../src/attempts/prepare.mjs';
import { verifyDeploymentAttestation } from '../../src/runtime/vercel.mjs';
import { candidate, deployment, fetchFixture, policy, signedAttestation } from './fixture.mjs';

const key = 'sk_test_synthetic123';
const account = { id: policy.stripe.accountId, object: 'account' };
const endpoint = {
  id: policy.stripe.webhookEndpointId,
  object: 'webhook_endpoint',
  livemode: false,
  status: 'enabled',
  url: `${deployment.origin}/api/stripe/webhook`,
};

function fixture(replies = [account, endpoint]) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify(replies[calls.length - 1]), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    },
  };
}

test('binds the exact account, enabled TEST webhook and immutable Preview URL with read-only GETs', async () => {
  const network = fixture();
  const result = await verifyStripeEnvironment({ policy, deployment, key, fetchImpl: network.fetchImpl });
  assert.deepEqual(result, {
    accountId: policy.stripe.accountId,
    webhookEndpointId: policy.stripe.webhookEndpointId,
    webhookUrl: `${deployment.origin}/api/stripe/webhook`,
    livemode: false,
  });
  assert.deepEqual(network.calls.map(({ url }) => url), [
    'https://api.stripe.com/v1/account',
    `https://api.stripe.com/v1/webhook_endpoints/${policy.stripe.webhookEndpointId}`,
  ]);
  for (const { options } of network.calls) {
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
  }
  assert.equal(JSON.stringify(result).includes(key), false);
});

test('exposes no mutation operation and refuses absent, Live, restricted, or malformed keys before requests', async () => {
  assert.deepEqual(Object.keys(stripeModule).sort(), ['StripeRefusal', 'createStripeBillingReader',
    'reconcileStripeIntent', 'runStripeMutation', 'stripeRequestDigest', 'verifyStripeEnvironment']);
  for (const badKey of [undefined, 'sk_live_synthetic123', 'rk_test_synthetic123', 'sk_test_', 'sk_test_bad\nheader']) {
    const network = fixture();
    await assert.rejects(verifyStripeEnvironment({ policy, deployment, key: badKey, fetchImpl: network.fetchImpl }), {
      code: 'stripe_credentials_invalid',
    });
    assert.equal(network.calls.length, 0);
  }
});

test('refuses a foreign or malformed account before querying the endpoint', async () => {
  for (const badAccount of [{ id: 'acct_other', object: 'account' }, { id: policy.stripe.accountId }, null]) {
    const network = fixture([badAccount, endpoint]);
    await assert.rejects(verifyStripeEnvironment({ policy, deployment, key, fetchImpl: network.fetchImpl }), {
      code: 'stripe_account_mismatch',
    });
    assert.equal(network.calls.length, 1);
  }
});

test('refuses a wrong, Live, disabled, or retargeted webhook', async () => {
  const cases = [
    { id: 'we_wrong' }, { livemode: true }, { status: 'disabled' },
    { url: 'https://another-preview.vercel.app/api/stripe/webhook' },
    { url: `${deployment.origin}/api/stripe/webhook/` },
  ];
  for (const change of cases) {
    const network = fixture([account, { ...endpoint, ...change }]);
    await assert.rejects(verifyStripeEnvironment({ policy, deployment, key, fetchImpl: network.fetchImpl }), {
      code: 'stripe_webhook_mismatch',
    });
    assert.equal(network.calls.length, 2);
  }
});

test('refuses non-immutable Preview origins before requesting Stripe', async () => {
  for (const origin of ['https://lawx.vercel.app', null]) {
    const network = fixture();
    await assert.rejects(verifyStripeEnvironment({
      policy, deployment: { ...deployment, origin }, key, fetchImpl: network.fetchImpl,
    }), { code: 'stripe_policy_invalid' });
    assert.equal(network.calls.length, 0);
  }
});

test('bounds Stripe responses and sanitizes redirects, rate limits, timeouts, and malformed JSON', async () => {
  const cases = [
    async () => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.invalid' } }),
    async () => new Response('{}', { status: 429, headers: { 'Content-Type': 'application/json' } }),
    async () => { throw new Error(`network failed with ${key}`); },
    async () => new Response('{broken', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    async () => new Response(JSON.stringify({ pad: 'x'.repeat(256_000) }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  ];
  for (const fetchImpl of cases) {
    await assert.rejects(verifyStripeEnvironment({ policy, deployment, key, fetchImpl }), (error) => {
      assert.match(error.code, /^stripe_(?:unavailable|response_invalid)$/u);
      assert.equal(JSON.stringify(error).includes(key), false);
      assert.equal(error.message.includes(key), false);
      return true;
    });
  }
});

test('refuses a successful-looking response after the request timeout signal aborts', async () => {
  const originalTimeout = AbortSignal.timeout;
  const controller = new AbortController();
  let timeoutMs;
  const network = fixture();
  AbortSignal.timeout = (milliseconds) => { timeoutMs = milliseconds; return controller.signal; };
  try {
    await assert.rejects(verifyStripeEnvironment({
      policy, deployment, key,
      fetchImpl: async (url, options) => {
        assert.equal(options.signal, controller.signal);
        controller.abort(new DOMException('synthetic timeout', 'TimeoutError'));
        return network.fetchImpl(url, options);
      },
    }), { code: 'stripe_unavailable' });
    assert.equal(timeoutMs, 10_000);
    assert.equal(network.calls.length, 1);
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
});

test('rejects an oversized webhook response after a valid account read', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(JSON.stringify(calls === 1 ? account : { pad: 'x'.repeat(256_000) }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };
  await assert.rejects(verifyStripeEnvironment({ policy, deployment, key, fetchImpl }), {
    code: 'stripe_response_invalid',
  });
  assert.equal(calls, 2);
});

const owner = Object.freeze({ attemptId: 'attempt-stripe-local',
  fence: '11111111-1111-4111-8111-111111111111', candidateSha: 'c'.repeat(40),
  workflow: Object.freeze({ repository: 'lawxcompany-stack/billing-validation-control',
    ref: 'refs/heads/main', runId: '123456', runAttempt: 2,
    runnerLabel: `billing-validation-${'f'.repeat(32)}` }),
  environment: Object.freeze({ database: Object.freeze({ projectRef: 'abcdefghijklmnopqrst',
    branchId: 'validation-branch-1' }),
  deployment,
  stripe: Object.freeze({ accountId: policy.stripe.accountId }) }),
  webhookEndpointId: policy.stripe.webhookEndpointId });
const ownerCandidate = Object.freeze({ candidateSha: owner.candidateSha, treeSha: 'd'.repeat(40) });
const ownerAttestation = await verifyDeploymentAttestation({ deployment: owner.environment.deployment,
  candidate: ownerCandidate, policy,
  fetchImpl: fetchFixture(signedAttestation({ overrides: { commit: ownerCandidate.candidateSha,
    treeHash: ownerCandidate.treeSha } })).fetchImpl });
const operation = 'checkout:create:local-session';
const action = 'checkout.replay';
const mutationInput = Object.freeze({ amount: 2500, currency: 'usd',
  metadata: Object.freeze({ attemptId: owner.attemptId }) });
const idempotencyKey = providerIdempotencyKey(owner.attemptId, 'stripe', operation);

function localIntentStore({ currentFence = owner.fence } = {}) {
  const intents = new Map();
  const receipts = [];
  const pendingQueries = [];
  const reconciled = new Set();
  const calls = [];
  return {
    intents, receipts, calls, pendingQueries,
    async assertFence(input) {
      if (input.attemptId !== owner.attemptId || input.fence !== currentFence) {
        throw Object.assign(new Error('lease_fence_lost'), { code: 'lease_fence_lost' });
      }
      return { ...owner };
    },
    async beginStripeIntent(input) {
      calls.push('begin');
      if (input.fence !== currentFence) throw Object.assign(new Error('lease_fence_lost'), {
        code: 'lease_fence_lost',
      });
      const key = `${input.attemptId}:${input.operation}`;
      if (intents.has(key)) throw Object.assign(new Error('stripe_intent_unresolved'), {
        code: 'stripe_intent_unresolved',
      });
      const intent = { intentId: 'intent_stripe_local_1', ...structuredClone(input),
        accountId: input.environment.stripe.accountId, state: 'in_flight' };
      intents.set(key, intent);
      return intent;
    },
    async getStripeIntent(intentId) {
      calls.push('read_intent');
      return [...intents.values()].find((intent) => intent.intentId === intentId) ?? null;
    },
    async listPendingStripeIntents(input) {
      calls.push('list_pending');
      pendingQueries.push(structuredClone(input));
      if (input.attemptId !== owner.attemptId || input.fence !== currentFence) {
        throw Object.assign(new Error('lease_fence_lost'), { code: 'lease_fence_lost' });
      }
      return [...intents.values()].filter((intent) => intent.attemptId === input.attemptId &&
        !reconciled.has(intent.intentId)).map((intent) => structuredClone(intent));
    },
    async reconcileStripeIntent(input) {
      calls.push('reconcile');
      if (input.fence !== currentFence || input.attemptId !== owner.attemptId) {
        throw Object.assign(new Error('lease_fence_lost'), { code: 'lease_fence_lost' });
      }
      receipts.push(structuredClone(input));
      reconciled.add(input.intentId);
      return { intentId: input.intentId, state: 'reconciled', observationDigest: '2'.repeat(64) };
    },
  };
}

function stripeIntentInput(attempts, adapter) {
  return { attempts, owner, action, operation, input: mutationInput, idempotencyKey, adapter,
    deploymentAttestation: ownerAttestation, candidate: ownerCandidate,
    readers: { expectedEnvironment: owner.environment, expectedWebhookEndpointId: policy.stripe.webhookEndpointId,
      async assertReady() { return true; } },
    readerBinding: { attemptId: owner.attemptId, caseId: 'payment.approved',
      startedAt: '2026-09-23T09:00:00.000Z' } };
}

test('low-level Stripe mutation refuses an unavailable independent reader before intent or provider dispatch', async () => {
  const attempts = localIntentStore();
  let adapterCalls = 0;
  const readers = { expectedEnvironment: owner.environment,
    expectedWebhookEndpointId: policy.stripe.webhookEndpointId,
    async assertReady() { throw new Error('Stripe account mismatch'); } };

  await assert.rejects(stripeModule.runStripeMutation({ ...stripeIntentInput(attempts, { async mutate() {
    adapterCalls++;
  } }), readers }), { code: 'stripe_readers_unavailable' });

  assert.deepEqual(attempts.calls, []);
  assert.equal(adapterCalls, 0);
});

test('persists an immutable in_flight TEST intent before adapter invocation and withholds its raw response', async () => {
  const run = stripeModule.runStripeMutation;
  assert.equal(typeof run, 'function');
  const attempts = localIntentStore();
  const events = [];
  const result = await run(stripeIntentInput(attempts, { async mutate(request) {
    events.push('adapter');
    assert.equal(attempts.calls[0], 'begin');
    const intent = attempts.intents.get(`${owner.attemptId}:${operation}`);
    assert.equal(intent.state, 'in_flight');
    assert.equal(request.accountId, policy.stripe.accountId);
    assert.equal(request.livemode, false);
    return { id: 'cs_synthetic123', client_secret: 'sk_test_private_payload' };
  } }));

  const intent = attempts.intents.get(`${owner.attemptId}:${operation}`);
  assert.deepEqual(events, ['adapter']);
  assert.equal(intent.attemptId, owner.attemptId);
  assert.equal(intent.fence, owner.fence);
  assert.equal(intent.candidateSha, owner.candidateSha);
  assert.deepEqual(intent.workflow, owner.workflow);
  assert.deepEqual(intent.environment, owner.environment);
  assert.equal(intent.operation, operation);
  assert.equal(intent.idempotencyKey, idempotencyKey);
  assert.equal(intent.requestDigest, stripeModule.stripeRequestDigest({ action, operation, input: mutationInput }));
  assert.deepEqual(result, { intentId: 'intent_stripe_local_1', operation,
    requestDigest: intent.requestDigest, idempotencyKey, state: 'in_flight' });
  assert.equal(JSON.stringify(result).includes('sk_test_private_payload'), false);
  assert.equal(attempts.receipts.length, 0);
});

test('ambiguous Stripe failure retains the unresolved intent and never retries it after idempotency aging', async () => {
  const run = stripeModule.runStripeMutation;
  assert.equal(typeof run, 'function');
  const attempts = localIntentStore();
  let invocations = 0;
  const args = stripeIntentInput(attempts, { async mutate() {
    invocations++;
    throw new Error('network timed out after dispatch');
  } });

  await assert.rejects(run(args), { code: 'stripe_mutation_ambiguous' });
  assert.equal(attempts.intents.get(`${owner.attemptId}:${operation}`).state, 'in_flight');
  await assert.rejects(run({ ...args, nowSeconds: 1_800_000_000 }), { code: 'stripe_intent_unresolved' });
  await assert.rejects(run({ ...args, input: { ...mutationInput, amount: 2600 } }),
    { code: 'stripe_intent_unresolved' });
  await assert.rejects(run({ ...args, idempotencyKey: 'billing-validation-' + '9'.repeat(64) }),
    { code: 'stripe_mutation_invalid' });
  assert.equal(invocations, 1);
  assert.equal(attempts.receipts.length, 0);
});

test('independent exact TEST observation is required before an intent can be reconciled', async () => {
  const reconcile = stripeModule.reconcileStripeIntent;
  assert.equal(typeof reconcile, 'function');
  const attempts = localIntentStore();
  const run = stripeModule.runStripeMutation;
  await run(stripeIntentInput(attempts, { async mutate() {
    return { id: 'cs_synthetic123', status: 'open' };
  } }));
  const intent = attempts.intents.get(`${owner.attemptId}:${operation}`);
  const observation = {
    accountId: policy.stripe.accountId, livemode: false, operation,
    requestDigest: intent.requestDigest, idempotencyKey,
    resourceIds: ['cs_synthetic123'],
  };
  let observedIntent;
  const result = await reconcile({ attempts, owner, intentId: intent.intentId,
    readObservation: async (storedIntent) => { observedIntent = storedIntent; return observation; } });
  assert.equal(observedIntent.intentId, intent.intentId);
  assert.deepEqual(attempts.receipts, [{ attemptId: owner.attemptId, fence: owner.fence,
    intentId: intent.intentId, observation }]);
  assert.deepEqual(attempts.pendingQueries, [{ attemptId: owner.attemptId, fence: owner.fence }]);
  assert.equal(result.state, 'reconciled');
});

test('mismatched or Live observation and an expired Test Clock cannot settle an ambiguous intent', async () => {
  const reconcile = stripeModule.reconcileStripeIntent;
  const run = stripeModule.runStripeMutation;
  assert.equal(typeof reconcile, 'function');
  const cases = [
    { accountId: 'acct_other123' },
    { livemode: true },
    { operation: 'subscription.cancel:other' },
    { requestDigest: '9'.repeat(64) },
    { idempotencyKey: 'billing-validation-other' },
    { testClock: { id: 'clock_expired123', deletes_after: 999 } },
  ];
  for (const change of cases) {
    const attempts = localIntentStore();
    await run(stripeIntentInput(attempts, { async mutate() { return { id: 'cs_synthetic123' }; } }));
    const intent = attempts.intents.get(`${owner.attemptId}:${operation}`);
    const observation = { accountId: policy.stripe.accountId, livemode: false, operation,
      requestDigest: intent.requestDigest, idempotencyKey, resourceIds: ['cs_synthetic123'], ...change };
    await assert.rejects(reconcile({ attempts, owner, intentId: intent.intentId,
      readObservation: async () => observation, nowSeconds: 1_000 }),
    { code: change.testClock ? 'stripe_reconciliation_window_expired' : 'stripe_observation_mismatch' });
    assert.equal(attempts.receipts.length, 0);
    assert.equal(intent.state, 'in_flight');
  }
});

test('Test Clock deletion is outside the Stripe mutation allowlist', async () => {
  const run = stripeModule.runStripeMutation;
  assert.equal(typeof run, 'function');
  const attempts = localIntentStore();
  let invoked = false;
  await assert.rejects(run({ ...stripeIntentInput(attempts, { async mutate() { invoked = true; } }),
    action: 'test_clock.delete', operation: 'clock-delete:clock_expired123' }),
  { code: 'stripe_mutation_invalid' });
  assert.equal(invoked, false);
  assert.equal(attempts.intents.size, 0);
});
