import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyStripeEnvironment } from '../../src/runtime/stripe.mjs';
import * as stripeModule from '../../src/runtime/stripe.mjs';
import { deployment, policy } from './fixture.mjs';

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
  assert.deepEqual(Object.keys(stripeModule).sort(), ['StripeRefusal', 'verifyStripeEnvironment']);
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
