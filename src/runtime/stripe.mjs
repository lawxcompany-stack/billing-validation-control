import { immutableVercelOrigin } from '../github/deployments.mjs';

const API = 'https://api.stripe.com';
const TEST_KEY = /^sk_test_[A-Za-z0-9]{8,}$/u;
const ACCOUNT = /^acct_[A-Za-z0-9_]+$/u;
const ENDPOINT = /^we_[A-Za-z0-9]+$/u;
const RESPONSE_LIMIT = 256_000;
const REQUEST_TIMEOUT_MS = 10_000;

export class StripeRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = 'StripeRefusal';
    this.code = code;
  }
}

function refuse(code) { throw new StripeRefusal(code); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

async function getJson(path, key, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(`${API}${path}`, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${key}`, 'Cache-Control': 'no-store' },
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    refuse('stripe_unavailable');
  }
  if (!response || response.status !== 200 || !response.headers?.get('content-type')?.toLowerCase().startsWith('application/json')) {
    refuse('stripe_unavailable');
  }
  const statedLength = response.headers.get('content-length');
  if (statedLength !== null && (!/^\d+$/u.test(statedLength) || Number(statedLength) > RESPONSE_LIMIT)) refuse('stripe_response_invalid');
  if (!response.body || typeof response.body.getReader !== 'function') refuse('stripe_response_invalid');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) refuse('stripe_response_invalid');
      size += value.byteLength;
      if (size > RESPONSE_LIMIT) refuse('stripe_response_invalid');
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    refuse('stripe_response_invalid');
  } finally {
    reader.releaseLock();
  }
}

export async function verifyStripeEnvironment({ policy, deployment, key, fetchImpl = globalThis.fetch } = {}) {
  const stripe = policy?.stripe;
  if (!object(stripe) || !ACCOUNT.test(stripe.accountId) || !ENDPOINT.test(stripe.webhookEndpointId) ||
      stripe.livemode !== false || !object(deployment) || typeof deployment.origin !== 'string' ||
      immutableVercelOrigin(deployment.origin) !== deployment.origin) refuse('stripe_policy_invalid');
  if (typeof key !== 'string' || !TEST_KEY.test(key) || typeof fetchImpl !== 'function') refuse('stripe_credentials_invalid');

  const account = await getJson('/v1/account', key, fetchImpl);
  if (!object(account) || account.object !== 'account' || account.id !== stripe.accountId) refuse('stripe_account_mismatch');
  const webhook = await getJson(`/v1/webhook_endpoints/${stripe.webhookEndpointId}`, key, fetchImpl);
  const webhookUrl = `${deployment.origin}/api/stripe/webhook`;
  if (!object(webhook) || webhook.object !== 'webhook_endpoint' || webhook.id !== stripe.webhookEndpointId ||
      webhook.livemode !== false || webhook.status !== 'enabled' || webhook.url !== webhookUrl) {
    refuse('stripe_webhook_mismatch');
  }
  return Object.freeze({ accountId: stripe.accountId, webhookEndpointId: stripe.webhookEndpointId,
    webhookUrl, livemode: false });
}
