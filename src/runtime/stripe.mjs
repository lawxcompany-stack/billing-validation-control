import { createHash } from 'node:crypto';
import { providerIdempotencyKey } from '../attempts/prepare.mjs';
import { withStripeIntent } from '../attempts/lock.mjs';
import { immutableVercelOrigin } from '../github/deployments.mjs';

const API = 'https://api.stripe.com';
const TEST_KEY = /^sk_test_[A-Za-z0-9]{8,}$/u;
const ACCOUNT = /^acct_[A-Za-z0-9_]+$/u;
const ENDPOINT = /^we_[A-Za-z0-9]+$/u;
const RESPONSE_LIMIT = 256_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MUTABLE_ACTIONS = new Set(['checkout.replay', 'checkout_session.expire', 'subscription.cancel']);
const OPERATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u;

export class StripeRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = 'StripeRefusal';
    this.code = code;
  }
}

function refuse(code) { throw new StripeRefusal(code); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function canonicalJson(value, depth = 0) {
  if (depth > 32) refuse('stripe_mutation_invalid');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    let keys;
    try { keys = Reflect.ownKeys(value); } catch { refuse('stripe_mutation_invalid'); }
    if (Object.getPrototypeOf(value) !== Array.prototype || keys.length !== value.length + 1 ||
        !keys.includes('length')) refuse('stripe_mutation_invalid');
    const items = [];
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
        refuse('stripe_mutation_invalid');
      }
      items.push(canonicalJson(descriptor.value, depth + 1));
    }
    return `[${items.join(',')}]`;
  }
  if (object(value)) {
    let prototype;
    let keys;
    try { prototype = Object.getPrototypeOf(value); keys = Reflect.ownKeys(value); }
    catch { refuse('stripe_mutation_invalid'); }
    if ((prototype !== Object.prototype && prototype !== null) || keys.some((key) => typeof key !== 'string')) {
      refuse('stripe_mutation_invalid');
    }
    const pairs = [];
    for (const key of keys.sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
        refuse('stripe_mutation_invalid');
      }
      pairs.push(`${JSON.stringify(key)}:${canonicalJson(descriptor.value, depth + 1)}`);
    }
    return `{${pairs.join(',')}}`;
  }
  refuse('stripe_mutation_invalid');
}

function exactObservation(value) {
  if (!object(value)) return null;
  let keys;
  try { keys = Reflect.ownKeys(value); } catch { return null; }
  const required = ['accountId', 'livemode', 'operation', 'requestDigest', 'idempotencyKey', 'resourceIds'];
  const allowed = [...required, 'testClock'];
  if (keys.some((key) => typeof key !== 'string' || !allowed.includes(key)) ||
      required.some((key) => !keys.includes(key)) ||
      (keys.length !== required.length && !(keys.length === allowed.length && keys.includes('testClock')))) return null;
  const copy = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) return null;
    copy[key] = descriptor.value;
  }
  if (typeof copy.accountId !== 'string' || copy.livemode !== false || !OPERATION.test(copy.operation ?? '') ||
      !/^[a-f0-9]{64}$/u.test(copy.requestDigest ?? '') || typeof copy.idempotencyKey !== 'string' ||
      !snapshotStripeResourceIds(copy.resourceIds) || snapshotStripeResourceIds(copy.resourceIds).length < 1 ||
      new Set(snapshotStripeResourceIds(copy.resourceIds)).size !== snapshotStripeResourceIds(copy.resourceIds).length) return null;
  if (Object.hasOwn(copy, 'testClock')) {
    const clock = copy.testClock;
    let keys;
    let prototype;
    try { keys = Reflect.ownKeys(clock); prototype = Object.getPrototypeOf(clock); } catch { return null; }
    if ((prototype !== Object.prototype && prototype !== null) || keys.length !== 2 ||
        !keys.includes('id') || !keys.includes('deletes_after')) return null;
    const id = Object.getOwnPropertyDescriptor(clock, 'id');
    const deletesAfter = Object.getOwnPropertyDescriptor(clock, 'deletes_after');
    if (!id || !Object.hasOwn(id, 'value') || id.enumerable !== true ||
        !deletesAfter || !Object.hasOwn(deletesAfter, 'value') || deletesAfter.enumerable !== true ||
        typeof id.value !== 'string' || !/^clock_[A-Za-z0-9]+$/u.test(id.value) ||
        !Number.isSafeInteger(deletesAfter.value) || deletesAfter.value < 1) return null;
    copy.testClock = { id: id.value, deletes_after: deletesAfter.value };
  }
  return { accountId: copy.accountId, livemode: false, operation: copy.operation,
    requestDigest: copy.requestDigest, idempotencyKey: copy.idempotencyKey,
    resourceIds: snapshotStripeResourceIds(copy.resourceIds),
    ...(copy.testClock ? { testClock: copy.testClock } : {}) };
}

function snapshotStripeResourceIds(value) {
  if (!Array.isArray(value) || value.length > 100) return null;
  let prototype;
  let keys;
  try { prototype = Object.getPrototypeOf(value); keys = Reflect.ownKeys(value); }
  catch { return null; }
  if (prototype !== Array.prototype || keys.length !== value.length + 1 || !keys.includes('length')) return null;
  const result = [];
  for (let index = 0; index < value.length; index++) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, String(index)); } catch { return null; }
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true ||
        typeof descriptor.value !== 'string' ||
        !/^(?:cus|in|pi|sub|price|prod|evt|ch|re|pm|seti|cs)_[A-Za-z0-9_]{1,120}$/u.test(descriptor.value) ||
        /(?:^|_)secret(?:_|$)/iu.test(descriptor.value)) return null;
    result.push(descriptor.value);
  }
  return result;
}

function assertCurrentStripeOwner(current, owner) {
  const workflowMatches = ['repository', 'ref', 'runId', 'runAttempt', 'runnerLabel']
    .every((key) => current?.workflow?.[key] === owner.workflow?.[key]);
  const environmentMatches = current?.environment?.database?.projectRef === owner.environment?.database?.projectRef &&
    current?.environment?.database?.branchId === owner.environment?.database?.branchId &&
    current?.environment?.deployment?.id === owner.environment?.deployment?.id &&
    current?.environment?.deployment?.origin === owner.environment?.deployment?.origin &&
    current?.environment?.stripe?.accountId === owner.environment?.stripe?.accountId;
  if (current?.attemptId !== owner.attemptId || current?.fence !== owner.fence ||
      current?.candidateSha !== owner.candidateSha ||
      !workflowMatches || !environmentMatches) refuse('lease_fence_lost');
}

async function getJson(path, key, fetchImpl) {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(`${API}${path}`, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${key}`, 'Cache-Control': 'no-store' },
      redirect: 'error',
      cache: 'no-store',
      signal,
    });
  } catch {
    refuse('stripe_unavailable');
  }
  if (signal.aborted) refuse('stripe_unavailable');
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

export function stripeRequestDigest({ action, operation, input } = {}) {
  if (!MUTABLE_ACTIONS.has(action) || typeof operation !== 'string' || !OPERATION.test(operation) ||
      !object(input)) refuse('stripe_mutation_invalid');
  const canonical = canonicalJson({ action, operation, input });
  return createHash('sha256').update(canonical).digest('hex');
}

export async function runStripeMutation({ attempts, owner, action, operation, input, idempotencyKey,
  adapter } = {}) {
  if (!attempts || typeof attempts.assertFence !== 'function' ||
      typeof attempts.beginStripeIntent !== 'function' || !owner ||
      typeof owner.attemptId !== 'string' || typeof owner.fence !== 'string' ||
      !/^[a-f0-9]{40}$/u.test(owner.candidateSha ?? '') ||
      !object(owner.workflow) || !object(owner.environment) ||
      !ACCOUNT.test(owner.environment.stripe?.accountId ?? '') ||
      !MUTABLE_ACTIONS.has(action) || typeof operation !== 'string' || !OPERATION.test(operation) ||
      !object(input) || typeof adapter?.mutate !== 'function' ||
      idempotencyKey !== providerIdempotencyKey(owner.attemptId, 'stripe', operation)) {
    refuse('stripe_mutation_invalid');
  }
  const requestDigest = stripeRequestDigest({ action, operation, input });
  const safeInput = JSON.parse(canonicalJson(input));
  const current = await attempts.assertFence({ attemptId: owner.attemptId, fence: owner.fence });
  assertCurrentStripeOwner(current, owner);
  return withStripeIntent(attempts, owner, { action, operation, requestDigest, idempotencyKey },
    (intent) => adapter.mutate({ intentId: intent.intentId, attemptId: intent.attemptId,
      fence: intent.fence, candidateSha: intent.candidateSha, workflow: intent.workflow,
      environment: intent.environment, accountId: owner.environment.stripe.accountId, livemode: false,
      action, operation, requestDigest, idempotencyKey, input: safeInput }));
}

export async function reconcileStripeIntent({ attempts, owner, intentId, readObservation,
  nowSeconds = Date.now() / 1000 } = {}) {
  if (!attempts || typeof attempts.assertFence !== 'function' ||
      typeof attempts.getStripeIntent !== 'function' || typeof attempts.reconcileStripeIntent !== 'function' ||
      typeof attempts.listPendingStripeIntents !== 'function' ||
      !owner || typeof owner.attemptId !== 'string' || typeof owner.fence !== 'string' ||
      typeof intentId !== 'string' || !/^[-A-Za-z0-9._:]{2,128}$/u.test(intentId) ||
      typeof readObservation !== 'function' || !Number.isFinite(nowSeconds)) {
    refuse('stripe_reconciliation_invalid');
  }
  const current = await attempts.assertFence({ attemptId: owner.attemptId, fence: owner.fence });
  assertCurrentStripeOwner(current, owner);
  const pending = await attempts.listPendingStripeIntents({ attemptId: owner.attemptId, fence: owner.fence });
  if (!Array.isArray(pending) || pending.some((candidate) => !candidate ||
      candidate.attemptId !== owner.attemptId || candidate.state !== 'in_flight') ||
      pending.filter((candidate) => candidate.intentId === intentId).length !== 1) {
    refuse('stripe_intent_missing');
  }
  const intent = await attempts.getStripeIntent(intentId);
  if (!intent || intent.attemptId !== owner.attemptId ||
      intent.accountId !== owner.environment?.stripe?.accountId || intent.state !== 'in_flight' ||
      intent.candidateSha !== owner.candidateSha ||
      JSON.stringify(intent.workflow) !== JSON.stringify(owner.workflow) ||
      JSON.stringify(intent.environment) !== JSON.stringify(owner.environment)) refuse('stripe_intent_missing');
  let rawObservation;
  try { rawObservation = await readObservation(intent); }
  catch { refuse('stripe_observation_unavailable'); }
  const observation = exactObservation(rawObservation);
  if (!observation || observation.accountId !== intent.accountId || observation.livemode !== false ||
      observation.operation !== intent.operation || observation.requestDigest !== intent.requestDigest ||
      observation.idempotencyKey !== intent.idempotencyKey) refuse('stripe_observation_mismatch');
  if (observation.testClock && observation.testClock.deletes_after <= nowSeconds) {
    refuse('stripe_reconciliation_window_expired');
  }
  return attempts.reconcileStripeIntent({ attemptId: owner.attemptId, fence: owner.fence,
    intentId, observation });
}
