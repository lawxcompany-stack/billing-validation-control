import { createHash } from 'node:crypto';
import { assertCurrentAttempt } from './contracts.mjs';
import { isValidExpectedEnvironment } from '../contracts/evidence.mjs';

const TABLES = Object.freeze(['attempts', 'contexts', 'contracts', 'settlements', 'grants', 'revisions', 'usage']);
const SQL_ASSERTION_IDS = Object.freeze(['checkout_rls', 'catalog_version_audit', 'usage_reservation_replay',
  'legacy_plan_webhook_compatibility', 'settlement_lock_order', 'stale_completion_renewal_fencing']);
const SQL_RACE_IDS = Object.freeze(['coupon_capacity', 'checkout_payment_context_idempotency', 'plan_change', 'adjustment']);
const SQL_BARRIER_IDS = new Set(['billing-sql-barrier-a', 'billing-sql-barrier-b']);
const SQL_DIGEST = /^[0-9a-f]{64}$/u;
const SQL_PROJECT_REF = /^[a-z0-9]{20}$/u;
const SQL_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u;
const ROW_KEYS = Object.freeze({
  attempts: ['id', 'quoteId', 'status'],
  contexts: ['sessionId', 'attemptId', 'status'],
  contracts: ['id', 'status'],
  settlements: ['id', 'contractId', 'invoiceId', 'subscriptionId', 'customerId', 'amount', 'currency', 'operation', 'revision'],
  grants: ['id', 'contractId', 'area', 'status'],
  revisions: ['id', 'contractId', 'revision', 'baseId', 'agentIds', 'includedUnits'],
  usage: ['id', 'contractId', 'includedUnits', 'consumedUnits', 'reservedUnits'],
});
const INTERNAL_EVIDENCE = new WeakMap();

export class BillingObservationRefusal extends Error {
  constructor(code) { super(code); this.name = 'BillingObservationRefusal'; this.code = code; }
}

function refuse(code) { throw new BillingObservationRefusal(code); }
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function safeToken(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u.test(value) && !/(?:secret|cookie|token|session_state)/iu.test(value); }
function dataRecord(value, keys) {
  if (!isObject(value)) return false;
  let ownKeys;
  try { ownKeys = Reflect.ownKeys(value); } catch { return false; }
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) return false;
  const result = {};
  try {
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) return false;
      result[key] = descriptor.value;
    }
  } catch { return false; }
  return result;
}
function ref(value) { return typeof value === 'string' ? value : value?.id; }
function dateMs(value) { const result = Date.parse(value); return Number.isFinite(result) ? result : null; }
function clean(value) { return typeof value === 'string' && /^[a-z_]{1,64}$/u.test(value) ? value : null; }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function digest(value) { return createHash('sha256').update(canonical(value), 'utf8').digest('hex'); }

/** Compose independently configured readonly sources without inventing their remote schemas. */
export function createIndependentBillingReaders({ expectedEnvironment, expectedWebhookEndpointId,
  supabase, stripe } = {}) {
  const supabaseMethods = ['readIdentity', 'readBillingSnapshot', 'listAttemptFixtures',
    'readSyntheticFixture', 'readWebhookInbox', 'readWebhookReceipts'];
  const stripeMethods = ['readIdentity', 'retrieve', 'listEvents', 'retrieveWebhookEndpoint'];
  if (!isValidExpectedEnvironment(expectedEnvironment) ||
      typeof expectedWebhookEndpointId !== 'string' || !/^we_[A-Za-z0-9]+$/u.test(expectedWebhookEndpointId) ||
      supabaseMethods.some((method) => typeof supabase?.[method] !== 'function') ||
      stripeMethods.some((method) => typeof stripe?.[method] !== 'function') ||
      supabase.identity?.projectRef !== expectedEnvironment.database.projectRef ||
      supabase.identity?.branchId !== expectedEnvironment.database.branchId ||
      supabase.identity?.readOnly !== true || stripe.identity?.accountId !== expectedEnvironment.stripe.accountId ||
      stripe.identity?.webhookEndpointId !== expectedWebhookEndpointId ||
      stripe.identity?.webhookUrl !== `${expectedEnvironment.deployment.origin}/api/stripe/webhook` ||
      stripe.identity?.livemode !== false || stripe.identity?.readOnly !== true) {
    refuse('observation_readers_unavailable');
  }

  async function assertReady(binding) {
    if (!isObject(binding) || !safeToken(binding.attemptId) || !safeToken(binding.caseId) ||
        dateMs(binding.startedAt) === null) refuse('observation_reader_binding_invalid');
    try {
      const database = await supabase.readIdentity();
      const provider = await stripe.readIdentity();
      if (database?.projectRef !== expectedEnvironment.database.projectRef ||
          database?.branchId !== expectedEnvironment.database.branchId || database?.readOnly !== true ||
          provider?.accountId !== expectedEnvironment.stripe.accountId ||
          provider?.webhookEndpointId !== expectedWebhookEndpointId ||
          provider?.webhookUrl !== `${expectedEnvironment.deployment.origin}/api/stripe/webhook` ||
          provider?.livemode !== false || provider?.readOnly !== true) refuse('observation_reader_identity_mismatch');
      const endpoint = await stripe.retrieveWebhookEndpoint(expectedWebhookEndpointId);
      if (endpoint?.id !== expectedWebhookEndpointId ||
          endpoint.url !== `${expectedEnvironment.deployment.origin}/api/stripe/webhook` ||
          endpoint.livemode !== false || !Number.isSafeInteger(endpoint.created) ||
          !Array.isArray(endpoint.enabledEvents)) refuse('observation_reader_identity_mismatch');
    } catch { refuse('observation_reader_identity_mismatch'); }
    return true;
  }

  async function readWebhookEvidence(input) {
    const keys = ['attemptId', 'caseId', 'startedAt', 'cutoffAt', 'eventId', 'objectId'];
    const startedAt = dateMs(input?.startedAt);
    const cutoffAt = dateMs(input?.cutoffAt);
    if (!isObject(input) || Reflect.ownKeys(input).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(input, key)) || !safeToken(input.attemptId) ||
        !safeToken(input.caseId) || !safeToken(input.eventId) || !safeToken(input.objectId) ||
        startedAt === null || cutoffAt === null || startedAt > cutoffAt || cutoffAt > Date.now()) {
      refuse('observation_reader_binding_invalid');
    }
    await assertReady(input);
    const started = Math.ceil(startedAt / 1000);
    const cutoff = Math.floor(cutoffAt / 1000);
    let events;
    try {
      events = await stripe.listEvents({ eventId: input.eventId, objectId: input.objectId,
        attemptId: input.attemptId, caseId: input.caseId, created: { gte: started, lte: cutoff } });
    } catch { refuse('observation_read_failed'); }
    if (!Array.isArray(events) || events.length > 100) refuse('observation_evidence_invalid');
    const eventMatches = events.filter((event) => event?.id === input.eventId &&
      typeof event.eventType === 'string' && event.accountId === expectedEnvironment.stripe.accountId &&
      event.livemode === false && event.objectId === input.objectId &&
      Number.isSafeInteger(event.created) && event.created * 1000 >= startedAt &&
      event.created * 1000 <= cutoffAt);
    if (eventMatches.length !== 1) refuse('observation_evidence_invalid');
    let endpoint;
    try { endpoint = await stripe.retrieveWebhookEndpoint(expectedWebhookEndpointId); }
    catch { refuse('observation_read_failed'); }
    const event = eventMatches[0];
    if (endpoint?.id !== expectedWebhookEndpointId ||
        endpoint.url !== `${expectedEnvironment.deployment.origin}/api/stripe/webhook` ||
        endpoint.livemode !== false || !Number.isSafeInteger(endpoint.created) ||
        endpoint.created > event.created || !Array.isArray(endpoint.enabledEvents) ||
        !endpoint.enabledEvents.includes(event.eventType)) refuse('observation_evidence_invalid');

    let inbox;
    let receipts;
    try {
      const query = Object.freeze({ attemptId: input.attemptId, caseId: input.caseId,
        branchId: expectedEnvironment.database.branchId, eventId: input.eventId, objectId: input.objectId });
      [inbox, receipts] = await Promise.all([
        supabase.readWebhookInbox(query), supabase.readWebhookReceipts(query),
      ]);
    } catch (error) {
      if (error?.code === 'supabase_webhook_response_invalid') refuse('observation_evidence_invalid');
      refuse('observation_read_failed');
    }
    const inboxMatches = isObject(inbox) && inbox.attemptId === input.attemptId &&
      inbox.caseId === input.caseId && inbox.branchId === expectedEnvironment.database.branchId &&
      inbox.eventId === input.eventId && inbox.objectId === input.objectId && inbox.status === 'processed' &&
      inbox.accountId === expectedEnvironment.stripe.accountId && inbox.livemode === false;
    const receivedAt = dateMs(inbox?.receivedAt);
    const processedAt = dateMs(inbox?.processedAt);
    const inboxWindowValid = receivedAt !== null && processedAt !== null &&
      startedAt <= receivedAt && receivedAt <= processedAt && processedAt <= cutoffAt;
    const receiptCount = Array.isArray(receipts) ? receipts.filter((receipt) => isObject(receipt) &&
      receipt.attemptId === input.attemptId && receipt.caseId === input.caseId &&
      receipt.branchId === expectedEnvironment.database.branchId && receipt.eventId === input.eventId &&
      receipt.objectId === input.objectId && receipt.status === 'processed' &&
      receipt.accountId === expectedEnvironment.stripe.accountId && receipt.livemode === false &&
      dateMs(receipt.receivedAt) !== null && dateMs(receipt.receivedAt) >= startedAt &&
      dateMs(receipt.receivedAt) <= cutoffAt && dateMs(receipt.receivedAt) <= processedAt).length : 0;
    if (!inboxMatches || !inboxWindowValid || receiptCount < 1) refuse('observation_evidence_invalid');
    return Object.freeze({ eventId: input.eventId, accountId: expectedEnvironment.stripe.accountId,
      livemode: false, eventObserved: true, inboxStatus: 'processed', receiptCount,
      receivedAt: new Date(receivedAt).toISOString(), processedAt: new Date(processedAt).toISOString() });
  }

  return Object.freeze({ expectedEnvironment, expectedWebhookEndpointId, supabase, stripe,
    assertReady, readWebhookEvidence });
}

export function sanitizeDatabaseSnapshot(snapshot) {
  if (!isObject(snapshot) || Object.keys(snapshot).length !== TABLES.length + 1 ||
      !Object.hasOwn(snapshot, 'observedAt') || dateMs(snapshot.observedAt) === null) refuse('database_snapshot_invalid');
  const cleanSnapshot = { observedAt: new Date(dateMs(snapshot.observedAt)).toISOString() };
  for (const table of TABLES) {
    const rows = snapshot[table];
    if (!Array.isArray(rows)) refuse('database_snapshot_invalid');
    cleanSnapshot[table] = rows.map((row) => {
      const keys = ROW_KEYS[table];
      if (!isObject(row) || Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key))) {
        refuse('database_snapshot_invalid');
      }
      const projected = Object.fromEntries(keys.map((key) => [key, row[key]]));
      const ids = table === 'settlements' ? ['id', 'contractId', 'invoiceId', 'subscriptionId', 'customerId', 'operation'] :
        table === 'attempts' ? ['id', 'quoteId'] : table === 'contexts' ? ['sessionId', 'attemptId'] :
          table === 'contracts' ? ['id'] : table === 'grants' ? ['id', 'contractId', 'area'] :
            table === 'revisions' ? ['id', 'contractId', 'baseId'] : ['id', 'contractId'];
      if (ids.some((key) => !safeToken(projected[key])) ||
          ['status', 'currency'].some((key) => Object.hasOwn(projected, key) &&
            (typeof projected[key] !== 'string' || !/^[A-Za-z_]{1,64}$/u.test(projected[key]))) ||
          ['amount', 'revision', 'includedUnits', 'consumedUnits', 'reservedUnits'].some((key) =>
            Object.hasOwn(projected, key) && projected[key] !== null &&
            (!Number.isSafeInteger(projected[key]) || projected[key] < 0)) ||
          (Object.hasOwn(projected, 'agentIds') && (!Array.isArray(projected.agentIds) || !projected.agentIds.every(safeToken))) ||
          (Object.hasOwn(projected, 'currency') && projected.currency !== 'BRL')) refuse('database_snapshot_invalid');
      return projected;
    }).sort((a, b) => canonical(a).localeCompare(canonical(b)));
  }
  return cleanSnapshot;
}

/** Project an independently read installed-schema receipt into a closed, digest-only form. */
export function sanitizeInstalledSchemaState(value) {
  const keys = ['version', 'readerId', 'projectRef', 'parentProjectRef', 'branchId', 'branchName', 'isDefaultBranch',
    'schemaFingerprintSha256', 'migrationHistorySha256', 'triggerDigestSha256', 'aclDigestSha256',
    'privilegeDigestSha256'];
  const state = dataRecord(value, keys);
  if (!state || state.version !== 1 || !safeToken(state.readerId) ||
      !SQL_PROJECT_REF.test(state.projectRef) || !SQL_PROJECT_REF.test(state.parentProjectRef) ||
      !SQL_BRANCH.test(state.branchId) || !SQL_BRANCH.test(state.branchName) ||
      typeof state.isDefaultBranch !== 'boolean' ||
      ['schemaFingerprintSha256', 'migrationHistorySha256', 'triggerDigestSha256', 'aclDigestSha256',
        'privilegeDigestSha256'].some((key) => !SQL_DIGEST.test(state[key] ?? ''))) {
    refuse('sql_schema_observation_invalid');
  }
  return Object.freeze(state);
}

/** Validate the fixed Task 7 assertion and race receipt shape without retaining raw database rows. */
export function sanitizeSqlConcurrencyProof(value) {
  const keys = ['version', 'readerId', 'projectRef', 'parentProjectRef', 'branchId', 'branchName', 'barrierId',
    'assertionDigests', 'races'];
  const proof = dataRecord(value, keys);
  const assertionDigests = proof && dataRecord(proof.assertionDigests, SQL_ASSERTION_IDS);
  const observedRaces = proof && dataRecord(proof.races, SQL_RACE_IDS);
  if (!proof || proof.version !== 1 || !safeToken(proof.readerId) ||
      !SQL_PROJECT_REF.test(proof.projectRef) || !SQL_PROJECT_REF.test(proof.parentProjectRef) ||
      !SQL_BRANCH.test(proof.branchId) || !SQL_BRANCH.test(proof.branchName) ||
      !SQL_BARRIER_IDS.has(proof.barrierId) || !assertionDigests ||
      SQL_ASSERTION_IDS.some((id) => !SQL_DIGEST.test(assertionDigests[id] ?? '')) || !observedRaces) {
    refuse('sql_concurrency_observation_invalid');
  }

  const races = {};
  for (const id of SQL_RACE_IDS) {
    const race = dataRecord(observedRaces[id], ['committedOwnerCount', 'committedOwnerDigest', 'loserStateDigest']);
    if (!race ||
        race.committedOwnerCount !== 1 || !SQL_DIGEST.test(race.committedOwnerDigest ?? '') ||
        !SQL_DIGEST.test(race.loserStateDigest ?? '')) refuse('sql_concurrency_observation_invalid');
    races[id] = Object.freeze({ committedOwnerCount: 1,
      committedOwnerDigest: race.committedOwnerDigest, loserStateDigest: race.loserStateDigest });
  }

  return Object.freeze({
    version: 1,
    readerId: proof.readerId,
    projectRef: proof.projectRef,
    parentProjectRef: proof.parentProjectRef,
    branchId: proof.branchId,
    branchName: proof.branchName,
    barrierId: proof.barrierId,
    assertionDigests: Object.freeze(assertionDigests),
    races: Object.freeze(races),
  });
}

function snapshotFacts(snapshot) {
  return Object.fromEntries(TABLES.map((table) => [table, snapshot[table]]));
}

export function databaseSnapshotDigest(snapshot) {
  const cleanSnapshot = sanitizeDatabaseSnapshot(snapshot);
  return digest(snapshotFacts(cleanSnapshot));
}

export function isTrustedFinancialObservation(evidence) {
  return INTERNAL_EVIDENCE.has(evidence);
}

export function databaseSnapshotsEqual(left, right) {
  const a = sanitizeDatabaseSnapshot(left);
  const b = sanitizeDatabaseSnapshot(right);
  return canonical(snapshotFacts(a)) === canonical(snapshotFacts(b));
}

function settlementMatches(row, provider, identity, expectedContractId) {
  return row.invoiceId === provider.invoiceId && row.subscriptionId === provider.subscriptionId &&
    row.customerId === identity.customerId && row.contractId === expectedContractId &&
    row.amount === provider.amountPaid && row.currency === 'BRL';
}

function collectEventEvidence(event, inbox, receipts, endpoint, expectedEndpoint, expectedAccount, startedAt,
  observationCutoff) {
  if (!event || event.type !== 'invoice.paid' || !safeToken(event.data?.object?.id) ||
      !safeToken(event.id) ||
      !Number.isSafeInteger(event.created) || !Number.isSafeInteger(event.pending_webhooks) ||
      event.livemode !== false || (event.account !== null && event.account !== undefined && event.account !== expectedAccount) ||
      event.data.object.id === '' || ref(event.data.object.customer) === null ||
      event.data.object.customer !== undefined && ref(event.data.object.customer) === '') return null;
  const started = dateMs(startedAt);
  const cutoff = dateMs(observationCutoff);
  if (started === null || cutoff === null || event.created * 1000 < started || event.created * 1000 > cutoff) return null;
  const receiptRows = Array.isArray(receipts) ? receipts.filter((receipt) => isObject(receipt) &&
    safeToken(receipt.id) && receipt.eventId === event.id && receipt.eventType === event.type &&
    receipt.objectId === event.data.object.id && receipt.accountId === expectedAccount && receipt.livemode === false &&
    receipt.apiVersion === (event.api_version ?? null) && dateMs(receipt.receivedAt) >= started &&
    dateMs(receipt.receivedAt) <= cutoff) : [];
  const inboxReceivedAt = dateMs(inbox?.receivedAt);
  const inboxProcessedAt = dateMs(inbox?.processedAt);
  const inboxValid = isObject(inbox) && inbox.eventId === event.id && inbox.eventType === event.type &&
    inbox.objectId === event.data.object.id && inbox.accountId === expectedAccount && inbox.livemode === false &&
    inbox.status === 'processed' && Number.isSafeInteger(inbox.attempts) && inbox.attempts >= 1 &&
    inboxReceivedAt !== null && inboxProcessedAt !== null &&
    inboxReceivedAt >= started && inboxProcessedAt >= inboxReceivedAt && inboxProcessedAt <= cutoff;
  const endpointWindow = isObject(endpoint) && endpoint.id === expectedEndpoint.webhookEndpointId &&
    endpoint.url === expectedEndpoint.webhookUrl && endpoint.livemode === false &&
    Number.isSafeInteger(endpoint.created) && endpoint.created <= event.created &&
    Array.isArray(endpoint.enabledEvents) && endpoint.enabledEvents.includes(event.type);
  const verified = inboxValid && receiptRows.length > 0 && endpointWindow && event.pending_webhooks === 0;
  return { eventId: event.id, processed: verified, inboxStatus: inbox?.status ?? null,
    receiptCount: receiptRows.length, pendingWebhooks: event.pending_webhooks,
    providerCreatedAt: new Date(event.created * 1000).toISOString(),
    receivedAt: inboxValid ? new Date(inboxReceivedAt).toISOString() : null,
    processedAt: inboxValid ? new Date(inboxProcessedAt).toISOString() : null,
    endpointWindowVerified: endpointWindow, endpointAttribution: 'configuration-window-only' };
}

function eventForEvidence(event) {
  if (!isObject(event) || typeof event.eventType !== 'string' || typeof event.objectId !== 'string') return event;
  return {
    id: event.id,
    type: event.eventType,
    livemode: event.livemode,
    created: event.created,
    pending_webhooks: event.pendingWebhooks,
    api_version: event.apiVersion,
    account: event.accountId,
    data: { object: { id: event.objectId, ...(event.customerId ? { customer: event.customerId } : {}) } },
  };
}

async function readObservation(operation) {
  try { return await operation(); }
  catch { refuse('observation_read_failed'); }
}

function invoicePaymentIntentMatches(invoice, expectedPaymentIntentId) {
  const payments = invoice?.payments;
  const paymentIntentIds = new Set();
  if (payments !== undefined) {
    if (!isObject(payments) || !Array.isArray(payments.data) || payments.has_more !== false) return false;
    for (const entry of payments.data) {
      const paymentIntentId = ref(entry?.payment?.payment_intent);
      if (paymentIntentId) paymentIntentIds.add(paymentIntentId);
    }
  } else {
    const legacyPaymentIntentId = ref(invoice?.payment_intent);
    if (legacyPaymentIntentId) paymentIntentIds.add(legacyPaymentIntentId);
  }
  return paymentIntentIds.size === 1 && paymentIntentIds.has(expectedPaymentIntentId);
}

export async function observeFinancialEvidence({ context, caseId, identity, readers, startedAt } = {}) {
  if (!context?.owner?.attemptId || typeof caseId !== 'string' || !safeToken(caseId) ||
      !isObject(identity) || !safeToken(identity.customerId) || !safeToken(identity.invoiceId) ||
      !safeToken(identity.paymentIntentId) || !safeToken(identity.teamId) ||
      !readers?.stripe || typeof readers.stripe.retrieve !== 'function' ||
      typeof readers.stripe.listEvents !== 'function' || typeof readers.stripe.retrieveWebhookEndpoint !== 'function' ||
      !readers?.supabase || typeof readers.supabase.readBillingSnapshot !== 'function' ||
      typeof readers.supabase.readWebhookInbox !== 'function' || typeof readers.supabase.readWebhookReceipts !== 'function' ||
      dateMs(startedAt) === null) refuse('observation_input_invalid');

  await assertCurrentAttempt(context);

  const accountId = context.preflight.providerVerification.stripe.accountId;
  const beforeRaw = await readObservation(() => readers.supabase.readBillingSnapshot({ attemptId: context.owner.attemptId,
    caseId, teamId: identity.teamId, phase: 'baseline' }));
  const before = sanitizeDatabaseSnapshot(beforeRaw);
  const invoice = await readObservation(() => readers.stripe.retrieve('invoice', identity.invoiceId,
    { expand: ['payments.data.payment.payment_intent'] }));
  const intent = await readObservation(() => readers.stripe.retrieve('payment_intent', identity.paymentIntentId));
  const latestChargeId = ref(intent?.latest_charge);
  const charge = latestChargeId ? await readObservation(() => readers.stripe.retrieve('charge', latestChargeId)) : null;

  const invoiceSubscription = ref(invoice?.parent?.subscription_details?.subscription ?? invoice?.subscription);
  const lineageValid = invoice?.id === identity.invoiceId && invoice.livemode === false &&
    ref(invoice.customer) === identity.customerId && invoiceSubscription === (identity.subscriptionId ?? invoiceSubscription) &&
    invoicePaymentIntentMatches(invoice, identity.paymentIntentId) &&
    intent?.id === identity.paymentIntentId && intent.livemode === false && ref(intent.customer) === identity.customerId &&
    (!identity.subscriptionId || invoiceSubscription === identity.subscriptionId) &&
    (!latestChargeId || charge?.id === latestChargeId && charge.livemode === false &&
      ref(charge.customer) === identity.customerId && ref(charge.payment_intent) === intent.id);
  if (!lineageValid) refuse('payment_lineage_invalid');

  const authentication = charge?.payment_method_details?.card?.three_d_secure;
  const amountDue = invoice.amount_due;
  const amountPaid = invoice.amount_paid;
  const amountRemaining = invoice.amount_remaining;
  const amountReceived = intent.amount_received;
  const currency = invoice.currency;
  const paymentAmountValid = Number.isSafeInteger(amountDue) && amountDue >= 0 &&
    Number.isSafeInteger(amountPaid) && amountPaid >= 0 && Number.isSafeInteger(amountRemaining) && amountRemaining >= 0 &&
    Number.isSafeInteger(amountReceived) && amountReceived >= 0 &&
    invoice.currency === 'brl' && intent.currency === 'brl' &&
    (!charge || charge.currency === 'brl');
  const stripePaid = paymentAmountValid && amountDue > 0 && invoice.status === 'paid' && intent.status === 'succeeded' &&
    amountPaid === amountDue && amountRemaining === 0 && amountReceived === amountPaid &&
    charge?.paid === true && charge.amount_captured === amountPaid;
  const noFundsCollected = paymentAmountValid && amountDue > 0 && amountPaid === 0 && amountReceived === 0 &&
    (!charge || charge.paid !== true && charge.amount_captured === 0);
  const declinedState = noFundsCollected &&
    ['open', 'draft'].includes(invoice.status) && amountPaid === 0 && amountRemaining === amountDue &&
    intent.status === 'requires_payment_method' && amountReceived === 0 &&
    typeof intent.last_payment_error?.code === 'string' && intent.last_payment_error.code.length > 0 &&
    typeof intent.last_payment_error?.decline_code === 'string' && intent.last_payment_error.decline_code.length > 0 &&
    (!charge || charge.paid === false && charge.amount_captured === 0);

  const rawEvents = await readObservation(() => readers.stripe.listEvents({ customerId: identity.customerId,
    objectId: identity.invoiceId, types: ['invoice.paid'], created: { gte: Math.floor(dateMs(startedAt) / 1000) } }));
  const webhookCandidates = [];
  let webhook = { eventId: null, processed: false, inboxStatus: null, receiptCount: 0,
    pendingWebhooks: null, providerCreatedAt: null, receivedAt: null, processedAt: null,
    endpointWindowVerified: false, endpointAttribution: 'configuration-window-only' };
  for (const rawEvent of Array.isArray(rawEvents) ? rawEvents : []) {
    const event = eventForEvidence(rawEvent);
    if (event?.type !== 'invoice.paid' || event.data?.object?.id !== identity.invoiceId ||
        ref(event.data.object.customer) !== identity.customerId || event.livemode !== false) continue;
    const [inbox, receipts, endpoint] = await readObservation(() => Promise.all([
      readers.supabase.readWebhookInbox(event.id),
      readers.supabase.readWebhookReceipts(event.id),
      readers.stripe.retrieveWebhookEndpoint(context.preflight.providerVerification.stripe.webhookEndpointId),
    ]));
    webhookCandidates.push({ event, inbox, receipts, endpoint });
  }

  const currentRaw = await readObservation(() => readers.supabase.readBillingSnapshot({ attemptId: context.owner.attemptId,
    caseId, teamId: identity.teamId, phase: 'current' }));
  const current = sanitizeDatabaseSnapshot(currentRaw);
  for (const { event, inbox, receipts, endpoint } of webhookCandidates) {
    const evidence = collectEventEvidence(event, inbox, receipts, endpoint,
      context.preflight.providerVerification.stripe, accountId, startedAt, current.observedAt);
    if (evidence?.processed) { webhook = evidence; break; }
    if (evidence && evidence.receiptCount >= webhook.receiptCount) webhook = evidence;
  }
  const tableDelta = Object.fromEntries(TABLES.map((table) => [table,
    current[table].filter((row) => !before[table].some((old) => canonical(old) === canonical(row)))]));
  const internal = {
    provider: { invoiceId: invoice.id, subscriptionId: identity.subscriptionId ?? invoiceSubscription, amountPaid },
    declinedState, noFundsCollected,
    baseline: snapshotFacts(before),
    current: snapshotFacts(current),
    settlementDelta: tableDelta.settlements,
    grantDelta: tableDelta.grants,
  };
  const data = {
    caseId,
    attemptId: context.owner.attemptId,
    observedAt: current.observedAt,
    provider: {
      customerId: identity.customerId, invoiceId: invoice.id,
      subscriptionId: identity.subscriptionId ?? invoiceSubscription,
      intentId: intent.id, chargeId: charge?.id ?? null,
      invoiceStatus: clean(invoice.status), intentStatus: clean(intent.status),
      currency: typeof currency === 'string' && currency.toLowerCase() === 'brl' ? 'BRL' : null,
      paymentAmountValid, stripePaid,
      authenticationFlow: clean(authentication?.authentication_flow),
      authenticationResult: clean(authentication?.result),
      authenticationResultReason: clean(authentication?.result_reason),
      errorCode: clean(intent.last_payment_error?.code),
      declineCode: clean(intent.last_payment_error?.decline_code),
      chargePaid: charge?.paid === true,
    },
    webhook,
    database: {
      baselineDigest: digest(snapshotFacts(before)), currentDigest: digest(snapshotFacts(current)),
      unchanged: canonical(snapshotFacts(before)) === canonical(snapshotFacts(current)),
      contextCount: tableDelta.contexts.length,
      contextIds: tableDelta.contexts.map((row) => row.sessionId),
      settlementCount: tableDelta.settlements.length, grantCount: tableDelta.grants.length,
      revisionCount: tableDelta.revisions.length, usageCount: tableDelta.usage.length,
      settlementIds: tableDelta.settlements.map((row) => row.id),
      grantIds: tableDelta.grants.map((row) => row.id),
    },
  };
  const evidence = Object.freeze({ ...data, digest: digest(data) });
  INTERNAL_EVIDENCE.set(evidence, internal);
  await assertCurrentAttempt(context);
  return evidence;
}

export function matchingSettlementCount(evidence, identity, expectedContractId) {
  const internal = INTERNAL_EVIDENCE.get(evidence);
  if (!internal) return 0;
  return internal.settlementDelta.filter((row) => settlementMatches(row, internal.provider, identity,
    expectedContractId)).length;
}

export function hasVerifiedDeclineState(evidence) {
  return INTERNAL_EVIDENCE.get(evidence)?.declinedState === true;
}

export function hasNoFundsCollected(evidence) {
  return INTERNAL_EVIDENCE.get(evidence)?.noFundsCollected === true;
}

export function expectedGrantCount(evidence, expectedAccess) {
  if (!isValidExpectedAccess(expectedAccess)) return 0;
  const areas = expectedAccess.areas;
  const internal = INTERNAL_EVIDENCE.get(evidence);
  const current = internal?.current;
  if (!current || !internal.baseline || !Array.isArray(internal.grantDelta)) return 0;
  const active = current.grants.filter((grant) => grant.status === 'active');
  const baselineActiveForContract = internal.baseline.grants.filter((grant) =>
    grant.contractId === expectedAccess.contractId && grant.status === 'active');
  const baselineGrantIds = new Set(internal.baseline.grants.map((grant) => grant.id));
  const newActiveForContract = internal.grantDelta.filter((grant) =>
    grant.contractId === expectedAccess.contractId && grant.status === 'active' &&
    !baselineGrantIds.has(grant.id));
  if (baselineActiveForContract.length || newActiveForContract.length !== areas.length ||
      newActiveForContract.some((grant) => !areas.includes(grant.area)) ||
      new Set(newActiveForContract.map((grant) => grant.area)).size !== areas.length) return 0;
  if (new Set(active.map((grant) => grant.area)).size !== active.length || active.length !== areas.length ||
      active.some((grant) => grant.contractId !== expectedAccess.contractId || !areas.includes(grant.area))) return 0;
  return areas.every((area) => active.some((grant) => grant.area === area)) ? areas.length : 0;
}

export function isValidExpectedAccess(expectedAccess) {
  const areas = expectedAccess?.areas;
  return isObject(expectedAccess) && safeToken(expectedAccess.contractId) && Array.isArray(areas) &&
    areas.length > 0 && areas.every(safeToken) && new Set(areas).size === areas.length;
}
