import { createHash } from 'node:crypto';
import { providerIdempotencyKey } from '../attempts/prepare.mjs';
import { withStripeIntent } from '../attempts/lock.mjs';
import { immutableVercelOrigin } from '../github/deployments.mjs';
import { isValidExpectedEnvironment } from '../contracts/evidence.mjs';
import { isVerifiedDeploymentAttestation } from './vercel.mjs';

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

// Keep the Task 4 reader deliberately narrow: these are the only provider objects
// consumed by the current financial observation flow.
const READABLE_OBJECTS = new Set(['invoice', 'payment_intent', 'charge']);
const STRIPE_OBJECT_ID = /^(?:cus|in|pi|sub|price|prod|evt|ch|re|pm|seti|cs)_[A-Za-z0-9_]{1,120}$/u;

function plainRecord(value) {
  if (!object(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch { return false; }
}

function ownValue(value, key) {
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(value, key); }
  catch { refuse('stripe_reader_response_invalid'); }
  if (!descriptor) return { present: false };
  if (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) refuse('stripe_reader_response_invalid');
  return { present: true, value: descriptor.value };
}

function reference(value, prefix) {
  if (value === null) return null;
  if (typeof value === 'string') {
    if (!STRIPE_OBJECT_ID.test(value) || prefix && !value.startsWith(`${prefix}_`)) refuse('stripe_reader_response_invalid');
    return value;
  }
  if (!plainRecord(value)) refuse('stripe_reader_response_invalid');
  const id = ownValue(value, 'id');
  if (!id.present || typeof id.value !== 'string' || !STRIPE_OBJECT_ID.test(id.value) ||
      prefix && !id.value.startsWith(`${prefix}_`)) refuse('stripe_reader_response_invalid');
  return id.value;
}

function selectField(source, target, key, validate, transform = (value) => value) {
  const field = ownValue(source, key);
  if (!field.present) return;
  if (!validate(field.value)) refuse('stripe_reader_response_invalid');
  target[key] = transform(field.value);
}

function selectReference(source, target, key, prefix) {
  const field = ownValue(source, key);
  if (field.present) target[key] = reference(field.value, prefix);
}

function projectPaymentIntent(value) {
  if (!plainRecord(value)) refuse('stripe_reader_response_invalid');
  const result = {};
  selectField(value, result, 'id', (field) => typeof field === 'string' && /^pi_[A-Za-z0-9_]{1,120}$/u.test(field));
  selectField(value, result, 'livemode', (field) => field === false);
  selectReference(value, result, 'customer', 'cus');
  selectReference(value, result, 'latest_charge', 'ch');
  selectField(value, result, 'amount_received', (field) => Number.isSafeInteger(field) && field >= 0);
  selectField(value, result, 'currency', (field) => typeof field === 'string' && /^[a-z]{3}$/u.test(field));
  selectField(value, result, 'status', (field) => typeof field === 'string' && /^[a-z_]{1,64}$/u.test(field));
  const error = ownValue(value, 'last_payment_error');
  if (error.present) {
    if (error.value === null) result.last_payment_error = null;
    else {
      if (!plainRecord(error.value)) refuse('stripe_reader_response_invalid');
      const projected = {};
      selectField(error.value, projected, 'code', (field) => typeof field === 'string' && /^[a-z0-9_]{1,128}$/u.test(field));
      selectField(error.value, projected, 'decline_code', (field) => typeof field === 'string' && /^[a-z0-9_]{1,128}$/u.test(field));
      result.last_payment_error = projected;
    }
  }
  if (result.id === undefined || result.livemode !== false) refuse('stripe_reader_response_invalid');
  return Object.freeze(result);
}

function projectInvoice(value) {
  if (!plainRecord(value)) refuse('stripe_reader_response_invalid');
  const result = {};
  selectField(value, result, 'id', (field) => typeof field === 'string' && /^in_[A-Za-z0-9_]{1,120}$/u.test(field));
  selectField(value, result, 'livemode', (field) => field === false);
  selectReference(value, result, 'customer', 'cus');
  selectReference(value, result, 'subscription', 'sub');
  selectReference(value, result, 'payment_intent', 'pi');
  for (const key of ['amount_due', 'amount_paid', 'amount_remaining']) {
    selectField(value, result, key, (field) => Number.isSafeInteger(field) && field >= 0);
  }
  selectField(value, result, 'currency', (field) => typeof field === 'string' && /^[a-z]{3}$/u.test(field));
  selectField(value, result, 'status', (field) => typeof field === 'string' && /^[a-z_]{1,64}$/u.test(field));
  const payments = ownValue(value, 'payments');
  if (payments.present) {
    if (payments.value === null) result.payments = null;
    else {
      if (!plainRecord(payments.value)) refuse('stripe_reader_response_invalid');
      const data = ownValue(payments.value, 'data');
      const hasMore = ownValue(payments.value, 'has_more');
      if (!data.present || !Array.isArray(data.value) || data.value.length > 100 ||
          !hasMore.present || typeof hasMore.value !== 'boolean') refuse('stripe_reader_response_invalid');
      const projectedRows = data.value.map((entry) => {
        if (!plainRecord(entry)) refuse('stripe_reader_response_invalid');
        const payment = ownValue(entry, 'payment');
        if (!payment.present || !plainRecord(payment.value)) refuse('stripe_reader_response_invalid');
        const intent = ownValue(payment.value, 'payment_intent');
        return Object.freeze({ payment: Object.freeze({
          ...(intent.present ? { payment_intent: reference(intent.value, 'pi') } : {}),
        }) });
      });
      result.payments = Object.freeze({ data: Object.freeze(projectedRows), has_more: hasMore.value });
    }
  }
  const parent = ownValue(value, 'parent');
  if (parent.present) {
    if (parent.value === null) result.parent = null;
    else {
      if (!plainRecord(parent.value)) refuse('stripe_reader_response_invalid');
      const details = ownValue(parent.value, 'subscription_details');
      if (details.present && details.value !== null) {
        if (!plainRecord(details.value)) refuse('stripe_reader_response_invalid');
        const subscription = ownValue(details.value, 'subscription');
        result.parent = Object.freeze({ subscription_details: Object.freeze({
          ...(subscription.present ? { subscription: reference(subscription.value, 'sub') } : {}),
        }) });
      } else result.parent = Object.freeze({});
    }
  }
  if (result.id === undefined || result.livemode !== false) refuse('stripe_reader_response_invalid');
  return Object.freeze(result);
}

function projectCharge(value) {
  if (!plainRecord(value)) refuse('stripe_reader_response_invalid');
  const result = {};
  selectField(value, result, 'id', (field) => typeof field === 'string' && /^ch_[A-Za-z0-9_]{1,120}$/u.test(field));
  selectField(value, result, 'livemode', (field) => field === false);
  selectReference(value, result, 'customer', 'cus');
  selectReference(value, result, 'payment_intent', 'pi');
  selectField(value, result, 'currency', (field) => typeof field === 'string' && /^[a-z]{3}$/u.test(field));
  selectField(value, result, 'paid', (field) => typeof field === 'boolean');
  selectField(value, result, 'amount_captured', (field) => Number.isSafeInteger(field) && field >= 0);
  const details = ownValue(value, 'payment_method_details');
  if (details.present) {
    if (details.value === null) result.payment_method_details = null;
    else {
      if (!plainRecord(details.value)) refuse('stripe_reader_response_invalid');
      const card = ownValue(details.value, 'card');
      if (card.present && card.value !== null) {
        if (!plainRecord(card.value)) refuse('stripe_reader_response_invalid');
        const threeDSecure = ownValue(card.value, 'three_d_secure');
        if (threeDSecure.present && threeDSecure.value !== null) {
          if (!plainRecord(threeDSecure.value)) refuse('stripe_reader_response_invalid');
          const projected = {};
          for (const key of ['authentication_flow', 'result', 'result_reason']) {
            selectField(threeDSecure.value, projected, key, (field) => field === null ||
              typeof field === 'string' && /^[a-z0-9_-]{1,64}$/iu.test(field));
          }
          result.payment_method_details = Object.freeze({ card: Object.freeze({ three_d_secure: Object.freeze(projected) }) });
        }
      }
    }
  }
  if (result.id === undefined || result.livemode !== false) refuse('stripe_reader_response_invalid');
  return Object.freeze(result);
}

function projectBillingObject(type, value) {
  if (type === 'invoice') return projectInvoice(value);
  if (type === 'payment_intent') return projectPaymentIntent(value);
  if (type === 'charge') return projectCharge(value);
  refuse('stripe_reader_input_invalid');
}

function projectStripeEvent(value) {
  if (!plainRecord(value)) refuse('stripe_reader_response_invalid');
  const id = ownValue(value, 'id');
  const eventType = ownValue(value, 'eventType');
  const type = ownValue(value, 'type');
  const livemode = ownValue(value, 'livemode');
  const created = ownValue(value, 'created');
  if (!id.present || typeof id.value !== 'string' || !/^evt_[A-Za-z0-9_]{1,120}$/u.test(id.value) ||
      !livemode.present || livemode.value !== false || !created.present ||
      !Number.isSafeInteger(created.value) || created.value < 1) refuse('stripe_reader_response_invalid');
  const eventName = eventType.present ? eventType.value : type.value;
  if (typeof eventName !== 'string' || !/^[a-z][a-z0-9_.]{1,127}$/u.test(eventName) ||
      eventType.present && type.present && eventType.value !== type.value) refuse('stripe_reader_response_invalid');
  const objectId = ownValue(value, 'objectId');
  const customerId = ownValue(value, 'customerId');
  const data = ownValue(value, 'data');
  let projectedObjectId = objectId.present ? reference(objectId.value) : null;
  let projectedCustomerId = customerId.present ? reference(customerId.value, 'cus') : null;
  if (data.present) {
    if (!plainRecord(data.value)) refuse('stripe_reader_response_invalid');
    const objectValue = ownValue(data.value, 'object');
    if (!objectValue.present || !plainRecord(objectValue.value)) refuse('stripe_reader_response_invalid');
    const nestedId = ownValue(objectValue.value, 'id');
    const nestedCustomer = ownValue(objectValue.value, 'customer');
    if (nestedId.present) {
      const valueId = reference(nestedId.value);
      if (projectedObjectId && projectedObjectId !== valueId) refuse('stripe_reader_response_invalid');
      projectedObjectId = valueId;
    }
    if (nestedCustomer.present) {
      const valueCustomer = reference(nestedCustomer.value, 'cus');
      if (projectedCustomerId && projectedCustomerId !== valueCustomer) refuse('stripe_reader_response_invalid');
      projectedCustomerId = valueCustomer;
    }
  }
  if (!projectedObjectId) refuse('stripe_reader_response_invalid');
  const result = { id: id.value, eventType: eventName, livemode: false, created: created.value,
    objectId: projectedObjectId };
  const pending = ownValue(value, 'pendingWebhooks');
  const pendingSnake = ownValue(value, 'pending_webhooks');
  if (pending.present && pendingSnake.present && pending.value !== pendingSnake.value) refuse('stripe_reader_response_invalid');
  const pendingValue = pending.present ? pending.value : pendingSnake.value;
  if (pending.present || pendingSnake.present) {
    if (!Number.isSafeInteger(pendingValue) || pendingValue < 0) refuse('stripe_reader_response_invalid');
    result.pendingWebhooks = pendingValue;
  }
  const apiVersion = ownValue(value, 'apiVersion');
  const apiVersionSnake = ownValue(value, 'api_version');
  if (apiVersion.present && apiVersionSnake.present && apiVersion.value !== apiVersionSnake.value) refuse('stripe_reader_response_invalid');
  const apiVersionValue = apiVersion.present ? apiVersion.value : apiVersionSnake.value;
  if (apiVersion.present || apiVersionSnake.present) {
    if (apiVersionValue !== null && (typeof apiVersionValue !== 'string' || apiVersionValue.length > 64)) refuse('stripe_reader_response_invalid');
    result.apiVersion = apiVersionValue;
  }
  const account = ownValue(value, 'accountId');
  const accountSnake = ownValue(value, 'account');
  if (account.present && accountSnake.present && account.value !== accountSnake.value) refuse('stripe_reader_response_invalid');
  const accountValue = account.present ? account.value : accountSnake.value;
  if (account.present || accountSnake.present) {
    if (accountValue !== null && (typeof accountValue !== 'string' || !/^acct_[A-Za-z0-9_]+$/u.test(accountValue))) {
      refuse('stripe_reader_response_invalid');
    }
    result.accountId = accountValue;
  }
  if (projectedCustomerId) result.customerId = projectedCustomerId;
  return Object.freeze(result);
}

function exactRecord(value, keys) {
  if (!object(value)) return false;
  let ownKeys;
  try { ownKeys = Reflect.ownKeys(value); } catch { return false; }
  return ownKeys.length === keys.length && ownKeys.every((key) => typeof key === 'string' && keys.includes(key)) &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true;
    });
}

function billingReadIdentity(value, expectedEnvironment, expectedWebhookEndpointId) {
  return exactRecord(value, ['accountId', 'webhookEndpointId', 'webhookUrl', 'livemode', 'readOnly']) &&
    value.accountId === expectedEnvironment.stripe.accountId &&
    value.webhookEndpointId === expectedWebhookEndpointId &&
    value.webhookUrl === `${expectedEnvironment.deployment.origin}/api/stripe/webhook` &&
    value.livemode === false && value.readOnly === true;
}

/** Read-only Stripe TEST reader. A remote client/schema is never created here. */
export function createStripeBillingReader({ expectedEnvironment, expectedWebhookEndpointId, source } = {}) {
  if (!isValidExpectedEnvironment(expectedEnvironment) || !ENDPOINT.test(expectedWebhookEndpointId ?? '') ||
      !object(source) || ['readIdentity', 'retrieve', 'listEvents', 'retrieveWebhookEndpoint']
        .some((method) => typeof source[method] !== 'function')) refuse('stripe_reader_unavailable');
  const identity = Object.freeze({ accountId: expectedEnvironment.stripe.accountId,
    webhookEndpointId: expectedWebhookEndpointId,
    webhookUrl: `${expectedEnvironment.deployment.origin}/api/stripe/webhook`,
    livemode: false, readOnly: true });

  async function readIdentity() {
    let actual;
    try { actual = await source.readIdentity(); } catch { refuse('stripe_reader_unavailable'); }
    if (!billingReadIdentity(actual, expectedEnvironment, expectedWebhookEndpointId)) {
      refuse('stripe_reader_identity_mismatch');
    }
    return identity;
  }

  return Object.freeze({
    identity,
    readIdentity,
    async retrieve(type, id, params = {}) {
      const expectedPrefix = type === 'invoice' ? 'in' : type === 'payment_intent' ? 'pi' : 'ch';
      if (!READABLE_OBJECTS.has(type) || typeof id !== 'string' ||
          !id.startsWith(`${expectedPrefix}_`) || !STRIPE_OBJECT_ID.test(id) || !plainRecord(params)) {
        refuse('stripe_reader_input_invalid');
      }
      let safeParams = {};
      const keys = Reflect.ownKeys(params);
      if (keys.length > 0) {
        const expand = ownValue(params, 'expand');
        if (type !== 'invoice' || keys.length !== 1 || !expand.present || !Array.isArray(expand.value) ||
            expand.value.length !== 1 || expand.value[0] !== 'payments.data.payment.payment_intent') {
          refuse('stripe_reader_input_invalid');
        }
        safeParams = { expand: Object.freeze(['payments.data.payment.payment_intent']) };
      }
      let value;
      try { value = await source.retrieve(type, id, Object.freeze(safeParams)); }
      catch { refuse('stripe_reader_unavailable'); }
      if (value === null) return null;
      const projected = projectBillingObject(type, value);
      if (projected.id !== id) refuse('stripe_reader_response_invalid');
      return projected;
    },
    async listEvents(query) {
      const allowed = new Set(['customerId', 'objectId', 'types', 'created', 'eventId', 'attemptId', 'caseId']);
      if (!plainRecord(query) || Reflect.ownKeys(query).some((key) => typeof key !== 'string' || !allowed.has(key))) {
        refuse('stripe_reader_input_invalid');
      }
      const safeQuery = {};
      for (const [key, prefix] of [['customerId', 'cus'], ['objectId', null], ['eventId', 'evt']]) {
        const field = ownValue(query, key);
        if (field.present) safeQuery[key] = reference(field.value, prefix);
      }
      for (const key of ['attemptId', 'caseId']) {
        const field = ownValue(query, key);
        if (field.present) {
          if (typeof field.value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u.test(field.value)) {
            refuse('stripe_reader_input_invalid');
          }
          safeQuery[key] = field.value;
        }
      }
      const types = ownValue(query, 'types');
      if (types.present) {
        if (!Array.isArray(types.value) || types.value.length > 100 ||
            !types.value.every((value) => typeof value === 'string' && /^[a-z][a-z0-9_.]{1,127}$/u.test(value))) {
          refuse('stripe_reader_input_invalid');
        }
        safeQuery.types = Object.freeze([...types.value]);
      }
      const created = ownValue(query, 'created');
      if (created.present) {
        if (!plainRecord(created.value)) refuse('stripe_reader_input_invalid');
        const gte = ownValue(created.value, 'gte');
        const lte = ownValue(created.value, 'lte');
        if (!gte.present || !Number.isSafeInteger(gte.value) || gte.value < 1 ||
            lte.present && (!Number.isSafeInteger(lte.value) || lte.value < gte.value) ||
            Reflect.ownKeys(created.value).some((key) => key !== 'gte' && key !== 'lte')) {
          refuse('stripe_reader_input_invalid');
        }
        safeQuery.created = Object.freeze({ gte: gte.value, ...(lte.present ? { lte: lte.value } : {}) });
      }
      let events;
      try { events = await source.listEvents(Object.freeze({ ...safeQuery,
        accountId: identity.accountId, webhookEndpointId: identity.webhookEndpointId, livemode: false })); }
      catch { refuse('stripe_reader_unavailable'); }
      if (!Array.isArray(events) || events.length > 100) refuse('stripe_reader_response_invalid');
      return Object.freeze(events.map((event) => {
        const projected = projectStripeEvent(event);
        if (projected.accountId !== identity.accountId) refuse('stripe_reader_response_invalid');
        return projected;
      }));
    },
    async retrieveWebhookEndpoint(id) {
      if (id !== identity.webhookEndpointId) refuse('stripe_reader_input_invalid');
      let endpoint;
      try { endpoint = await source.retrieveWebhookEndpoint(identity.webhookEndpointId); }
      catch { refuse('stripe_reader_unavailable'); }
      if (!object(endpoint) || endpoint.id !== identity.webhookEndpointId || endpoint.livemode !== false ||
          endpoint.url !== identity.webhookUrl || !Number.isSafeInteger(endpoint.created) ||
          !Array.isArray(endpoint.enabledEvents) || endpoint.enabledEvents.some((type) => typeof type !== 'string')) {
        refuse('stripe_reader_identity_mismatch');
      }
      return Object.freeze({ id: endpoint.id, url: endpoint.url, livemode: false,
        created: endpoint.created, enabledEvents: Object.freeze([...endpoint.enabledEvents]) });
    },
  });
}

export function stripeRequestDigest({ action, operation, input } = {}) {
  if (!MUTABLE_ACTIONS.has(action) || typeof operation !== 'string' || !OPERATION.test(operation) ||
      !object(input)) refuse('stripe_mutation_invalid');
  const canonical = canonicalJson({ action, operation, input });
  return createHash('sha256').update(canonical).digest('hex');
}

export async function runStripeMutation({ attempts, owner, action, operation, input, idempotencyKey,
  adapter, readers, readerBinding, deploymentAttestation, candidate } = {}) {
  if (!attempts || typeof attempts.assertFence !== 'function' ||
      typeof attempts.beginStripeIntent !== 'function' || !owner ||
      typeof owner.attemptId !== 'string' || typeof owner.fence !== 'string' ||
      !/^[a-f0-9]{40}$/u.test(owner.candidateSha ?? '') ||
      !object(owner.workflow) || !object(owner.environment) ||
      !ACCOUNT.test(owner.environment.stripe?.accountId ?? '') ||
      typeof owner.webhookEndpointId !== 'string' || !ENDPOINT.test(owner.webhookEndpointId) ||
      !MUTABLE_ACTIONS.has(action) || typeof operation !== 'string' || !OPERATION.test(operation) ||
      !object(input) || typeof adapter?.mutate !== 'function' ||
      !isValidExpectedEnvironment(readers?.expectedEnvironment) ||
      readers.expectedEnvironment.database.projectRef !== owner.environment.database?.projectRef ||
      readers.expectedEnvironment.database.branchId !== owner.environment.database?.branchId ||
      readers.expectedEnvironment.deployment.id !== owner.environment.deployment?.id ||
      readers.expectedEnvironment.deployment.origin !== owner.environment.deployment?.origin ||
      readers.expectedEnvironment.stripe.accountId !== owner.environment.stripe.accountId ||
      readers.expectedWebhookEndpointId !== owner.webhookEndpointId ||
      typeof readers.assertReady !== 'function' || readerBinding?.attemptId !== owner.attemptId ||
      typeof readerBinding?.caseId !== 'string' || typeof readerBinding?.startedAt !== 'string' ||
      idempotencyKey !== providerIdempotencyKey(owner.attemptId, 'stripe', operation)) {
    refuse('stripe_mutation_invalid');
  }
  try { await readers.assertReady(Object.freeze({ ...readerBinding })); }
  catch { refuse('stripe_readers_unavailable'); }
  const requestDigest = stripeRequestDigest({ action, operation, input });
  const safeInput = JSON.parse(canonicalJson(input));
  const current = await attempts.assertFence({ attemptId: owner.attemptId, fence: owner.fence });
  assertCurrentStripeOwner(current, owner);
  return withStripeIntent(attempts, owner, { action, operation, requestDigest, idempotencyKey },
    (intent) => {
      if (candidate?.candidateSha !== owner.candidateSha ||
          !isVerifiedDeploymentAttestation(deploymentAttestation, {
            deployment: owner.environment.deployment, candidate,
          })) refuse('stripe_deployment_unverified');
      return adapter.mutate({ intentId: intent.intentId, attemptId: intent.attemptId,
        fence: intent.fence, candidateSha: intent.candidateSha, workflow: intent.workflow,
        environment: intent.environment, accountId: owner.environment.stripe.accountId, livemode: false,
        action, operation, requestDigest, idempotencyKey, input: safeInput });
    });
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
