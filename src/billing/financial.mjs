import { FINANCIAL_EVIDENCE_REQUIREMENTS, FINANCIAL_SCENARIOS, FINANCIAL_SCENARIO_CONTRACTS } from './fixtures.mjs';
import { assertCurrentAttempt, mutateProvider, BillingControlRefusal } from './contracts.mjs';
import { databaseSnapshotDigest, databaseSnapshotsEqual, expectedGrantCount, matchingSettlementCount,
  hasVerifiedDeclineState, isValidExpectedAccess, observeFinancialEvidence } from './observations.mjs';
import { verifyChallengeCapability, verifyOpaqueCapability } from './witnesses.mjs';

export { FINANCIAL_EVIDENCE_REQUIREMENTS };

function refuse(code) { throw new BillingControlRefusal(code); }

function safeId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u.test(value) &&
    !/(?:secret|cookie|token)/iu.test(value);
}

export function requiredFinancialEvidence(caseId) {
  if (!FINANCIAL_SCENARIOS.includes(caseId) || !Object.hasOwn(FINANCIAL_EVIDENCE_REQUIREMENTS, caseId)) {
    refuse('financial_scenario_unsupported');
  }
  return FINANCIAL_EVIDENCE_REQUIREMENTS[caseId];
}

export async function replayCheckoutRequest({ context, applicationRequest } = {}) {
  if (!applicationRequest || typeof applicationRequest !== 'object' || Array.isArray(applicationRequest) ||
      Object.keys(applicationRequest).length !== 3 ||
      !safeId(applicationRequest.quoteId) || typeof applicationRequest.idempotencyKey !== 'string' ||
      !/^[A-Za-z0-9_-]{16,128}$/u.test(applicationRequest.idempotencyKey) ||
      !applicationRequest.sessionParams || typeof applicationRequest.sessionParams !== 'object' ||
      Array.isArray(applicationRequest.sessionParams)) refuse('checkout_replay_request_invalid');
  await mutateProvider(context, { provider: 'stripe', action: 'checkout.replay',
    operation: `checkout-replay:${applicationRequest.quoteId}`,
    input: { applicationRequest: structuredClone(applicationRequest) } });
}

function replayStateValid(state, event, context) {
  const inbox = state?.inbox;
  const accountId = context.preflight.providerVerification.stripe.accountId;
  const observedAt = Date.parse(state?.observedAt);
  const receivedAt = Date.parse(inbox?.receivedAt);
  const processedAt = Date.parse(inbox?.processedAt);
  return Number.isFinite(observedAt) && Number.isFinite(receivedAt) && Number.isFinite(processedAt) &&
    safeId(event?.id) && event.type === 'invoice.paid' && event.livemode === false &&
    (event.account === undefined || event.account === null || event.account === accountId) &&
    safeId(event.data?.object?.id) && inbox?.eventId === event.id &&
    inbox.eventType === event.type && inbox.objectId === event.data?.object?.id &&
    inbox.accountId === accountId && inbox.livemode === false && inbox.status === 'processed' &&
    Number.isSafeInteger(inbox.attempts) && inbox.attempts >= 1 && receivedAt <= processedAt &&
    processedAt <= observedAt && Array.isArray(state.receipts) &&
    state.receipts.length > 0 && state.receipts.every((receipt) => receipt.eventId === event.id &&
      receipt.eventType === event.type && receipt.objectId === event.data.object.id &&
      receipt.accountId === accountId && receipt.livemode === false &&
      receipt.apiVersion === (event.api_version ?? null) && safeId(receipt.id) &&
      Number.isFinite(Date.parse(receipt.receivedAt)) && Date.parse(receipt.receivedAt) <= observedAt) &&
    state.snapshot && typeof state.snapshot === 'object';
}

function sameProviderEvent(before, after) {
  return before?.id === after?.id && before?.type === after?.type && before?.created === after?.created &&
    before?.livemode === after?.livemode && before?.account === after?.account &&
    before?.api_version === after?.api_version && before?.data?.object?.id === after?.data?.object?.id &&
    before?.data?.object?.customer === after?.data?.object?.customer;
}

function validWebhookConfiguration(endpoint, event, context) {
  const expected = context.preflight.providerVerification.stripe;
  return endpoint?.id === expected.webhookEndpointId && endpoint.livemode === false &&
    endpoint.url === expected.webhookUrl && Number.isSafeInteger(endpoint.created) &&
    endpoint.created <= event.created && Array.isArray(endpoint.enabledEvents) &&
    endpoint.enabledEvents.includes(event.type);
}

function sameWebhookConfiguration(before, after) {
  return before?.id === after?.id && before?.livemode === after?.livemode && before?.url === after?.url &&
    before?.created === after?.created && Array.isArray(before?.enabledEvents) &&
    Array.isArray(after?.enabledEvents) && [...before.enabledEvents].sort().join(',') ===
    [...after.enabledEvents].sort().join(',');
}

async function requestResendCheckpoint(context, caseId, eventId, provider, verifier) {
  if (typeof provider?.request !== 'function' || typeof verifier?.verify !== 'function') {
    refuse('webhook_replay_checkpoint_unavailable');
  }
  const current = await assertCurrentAttempt(context);
  const binding = Object.freeze({ attemptId: context.owner.attemptId, fence: current.fence, caseId, eventId });
  let witness;
  try { witness = await provider.request(binding); }
  catch { refuse('webhook_replay_checkpoint_invalid'); }
  const verified = await verifyOpaqueCapability({ witness, binding, verifier });
  await assertCurrentAttempt(context);
  if (!verified) refuse('webhook_replay_checkpoint_invalid');
  // The Task7 verifier must only approve a capability after the operator's manual
  // Dashboard action is complete. Starting the clock after verification prevents
  // an unrelated retry while the operator is still acting from counting as proof.
  return Date.now();
}

export async function resendWebhookDelivery({ context, caseId, eventId, readers,
  resendCheckpointProvider, resendCheckpointVerifier } = {}) {
  if (!safeId(caseId) || !safeId(eventId) || typeof readers?.stripe?.retrieveEvent !== 'function' ||
      typeof readers?.stripe?.retrieveWebhookEndpoint !== 'function' ||
      typeof readers?.supabase?.readReplayState !== 'function') refuse('webhook_replay_input_invalid');
  const attemptId = context?.owner?.attemptId;
  await assertCurrentAttempt(context);
  let beforeEvent;
  let before;
  let beforeEndpoint;
  try {
    [beforeEvent, before, beforeEndpoint] = await Promise.all([
      readers.stripe.retrieveEvent(eventId),
      readers.supabase.readReplayState({ attemptId, eventId }),
      readers.stripe.retrieveWebhookEndpoint(context.preflight.providerVerification.stripe.webhookEndpointId),
    ]);
  } catch { refuse('webhook_replay_checkpoint_missing'); }
  if (beforeEvent?.id !== eventId || beforeEvent.type !== 'invoice.paid' || beforeEvent.livemode !== false ||
      !replayStateValid(before, beforeEvent, context)) refuse('webhook_replay_checkpoint_missing');
  if (!validWebhookConfiguration(beforeEndpoint, beforeEvent, context)) refuse('webhook_replay_endpoint_unverified');
  let checkpointCompletedAt;
  try {
    checkpointCompletedAt = await requestResendCheckpoint(context, caseId, eventId,
      resendCheckpointProvider, resendCheckpointVerifier);
  } catch (error) {
    if (error instanceof BillingControlRefusal) throw error;
    refuse('webhook_replay_checkpoint_invalid');
  }

  let afterEvent;
  let after;
  let afterEndpoint;
  try {
    [afterEvent, after, afterEndpoint] = await Promise.all([
      readers.stripe.retrieveEvent(eventId),
      readers.supabase.readReplayState({ attemptId, eventId }),
      readers.stripe.retrieveWebhookEndpoint(context.preflight.providerVerification.stripe.webhookEndpointId),
    ]);
  } catch { refuse('webhook_replay_receipt_missing'); }
  if (!sameProviderEvent(beforeEvent, afterEvent)) refuse('webhook_replay_provider_changed');
  if (!validWebhookConfiguration(afterEndpoint, afterEvent, context) ||
      !sameWebhookConfiguration(beforeEndpoint, afterEndpoint)) refuse('webhook_replay_endpoint_unverified');
  if (!databaseSnapshotsEqual(before.snapshot, after.snapshot)) refuse('webhook_replay_financial_state_changed');
  if (!replayStateValid(after, afterEvent, context)) refuse('webhook_replay_receipt_missing');
  const priorIds = new Set(before.receipts.map((receipt) => receipt.id));
  const fresh = after.receipts.filter((receipt) => !priorIds.has(receipt.id) &&
    Date.parse(receipt.receivedAt) > checkpointCompletedAt &&
    Date.parse(receipt.receivedAt) <= Date.parse(after.observedAt));
  if (!fresh.length) refuse('webhook_replay_receipt_missing');
  await assertCurrentAttempt(context);
  return Object.freeze({ passed: true, eventId, checkpointAt: new Date(checkpointCompletedAt).toISOString(),
    beforeReceiptIds: before.receipts.map((receipt) => receipt.id),
    afterReceiptIds: after.receipts.map((receipt) => receipt.id),
    financialStateDigest: databaseSnapshotDigest(after.snapshot),
    endpointAttribution: 'configuration-window-only' });
}

export async function reconcileFinancialCase({ context, caseId, expectedOutcome, expectedAccess,
  identity, readers, startedAt, challengeWitnessProvider, challengeVerifier } = {}) {
  const contract = FINANCIAL_SCENARIO_CONTRACTS[caseId];
  if (!FINANCIAL_SCENARIOS.includes(caseId) || !contract || !['paid', 'unpaid', 'settled'].includes(contract.outcome)) {
    refuse('financial_scenario_unsupported');
  }
  if (expectedOutcome !== undefined && expectedOutcome !== contract.outcome) refuse('financial_outcome_mismatch');
  const outcome = contract.outcome;
  if (['paid', 'settled'].includes(outcome) && !isValidExpectedAccess(expectedAccess)) {
    refuse('financial_expected_access_invalid');
  }
  const evidence = await observeFinancialEvidence({ context, caseId, identity, readers, startedAt });
  const failures = [];
  const challengeWitnessVerified = contract.challenge ? await verifyChallengeCapability({ context, caseId,
    paymentIntentId: evidence.provider.intentId, challengeWitnessProvider, challengeVerifier }) : false;
  const matchedSettlements = matchingSettlementCount(evidence, identity, expectedAccess?.contractId);
  const expectedGrants = expectedGrantCount(evidence, expectedAccess);
  const newAccess = evidence.database.settlementCount > 0 || evidence.database.grantCount > 0 ||
    evidence.database.revisionCount > 0 || evidence.database.usageCount > 0;

  if (outcome === 'paid' || outcome === 'settled') {
    if (!evidence.provider.stripePaid) failures.push('payment_not_authoritative');
    if (!evidence.provider.stripePaid && newAccess) failures.push('entitlement_before_payment');
    if (!evidence.webhook.processed) failures.push('webhook_unprocessed');
    if (evidence.database.settlementCount !== 1 || matchedSettlements !== 1) failures.push('settlement_not_unique');
    if (expectedGrants !== expectedAccess?.areas?.length) failures.push('entitlement_mismatch');
    if (contract.contextCount !== undefined && evidence.database.contextCount !== contract.contextCount) {
      failures.push('single_effect_not_unique');
    }
    if (contract.challenge && evidence.provider.authenticationResult !== 'authenticated') {
      failures.push('challenge_authentication_unverified');
    }
    if (contract.challenge && !challengeWitnessVerified) failures.push('challenge_witness_unverified');
  } else {
    if (evidence.provider.stripePaid) failures.push('unexpected_payment');
    if (newAccess) failures.push('entitlement_before_payment');
    if (!evidence.database.unchanged) failures.push('unpaid_database_changed');
    if (contract.negativeState === 'declined' && !hasVerifiedDeclineState(evidence)) {
      failures.push('declined_status_unverified');
    }
  }
  return Object.freeze({ caseId, outcome: failures.length ? 'failed' : outcome,
    passed: failures.length === 0, failures: Object.freeze(failures), challengeWitnessVerified, evidence });
}
