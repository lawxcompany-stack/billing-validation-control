import assert from 'node:assert/strict';
import { test } from 'node:test';
import { challengeCapabilities, databaseSnapshot, environment, importIfMissing, makeAttemptParts, makeReaders, needExport,
  needValue, paidDatabaseSnapshot, paidProviderState, paymentIdentity, startedAt, webhookReplayStates,
  manualResendCapabilities, expectRefusal } from './support.mjs';

const contracts = await importIfMissing(() => import('../../src/billing/contracts.mjs'));
const financial = await importIfMissing(() => import('../../src/billing/financial.mjs'));

test('replaying an app checkout preserves its persisted quote key while control uses its attempt key', async () => {
  const replay = needExport(financial, 'replayCheckoutRequest');
  const parts = makeAttemptParts();
  const context = needExport(contracts, 'createVerifiedContext')(parts);
  const request = Object.freeze({ quoteId: 'quote_task6', idempotencyKey: 'quote-scoped-replay-0001',
    sessionParams: Object.freeze({ mode: 'subscription', currency: 'brl', amount: 2500 }) });
  await replay({ context, applicationRequest: request });
  await replay({ context, applicationRequest: request });
  assert.equal(parts.calls.mutations.length, 2);
  assert.equal(parts.calls.mutations[0].input.applicationRequest.idempotencyKey, 'quote-scoped-replay-0001');
  assert.equal(parts.calls.mutations[1].input.applicationRequest.idempotencyKey, 'quote-scoped-replay-0001');
  assert.equal(parts.calls.mutations[0].idempotencyKey, parts.calls.mutations[1].idempotencyKey);
  assert.notEqual(parts.calls.mutations[0].idempotencyKey, request.idempotencyKey);
  assert.equal(parts.calls.mutations[0].attemptId, parts.owner.attemptId);
});

test('financial success is withheld until payment, processed webhook and DB settlement all reconcile', async () => {
  const reconcile = needExport(financial, 'reconcileFinancialCase');
  const parts = makeAttemptParts();
  const incompleteWebhook = paidProviderState({ receipts: [], inbox: { status: 'pending', processedAt: null } });
  const result = await reconcile({ context: needExport(contracts, 'createVerifiedContext')(parts),
    caseId: 'payment.approved', expectedOutcome: 'paid', expectedAccess: { contractId: 'contract_task6', areas: ['area_task6'] },
    identity: paymentIdentity, readers: makeReaders({ provider: incompleteWebhook, current: paidDatabaseSnapshot() }), startedAt });
  assert.equal(result.passed, false);
  assert.ok(result.failures.includes('webhook_unprocessed'));
});

test('an inherently unpaid scenario cannot be relabelled as paid by the caller', async () => {
  const reconcile = needExport(financial, 'reconcileFinancialCase');
  const parts = makeAttemptParts();
  const readers = makeReaders();
  await expectRefusal(reconcile({ context: needExport(contracts, 'createVerifiedContext')(parts),
    caseId: 'payment.declined', expectedOutcome: 'paid',
    expectedAccess: { contractId: 'contract_task6', areas: ['area_task6'] }, identity: paymentIdentity,
    readers, startedAt }), 'financial_outcome_mismatch');
  assert.equal(readers.calls.length, 0);
});

test('paid reconciliation rejects absent or empty expected access before provider reads', async () => {
  const reconcile = needExport(financial, 'reconcileFinancialCase');
  for (const expectedAccess of [undefined, { contractId: 'contract_task6', areas: [] }]) {
    const parts = makeAttemptParts();
    const readers = makeReaders();
    await expectRefusal(reconcile({ context: needExport(contracts, 'createVerifiedContext')(parts),
      caseId: 'payment.approved', expectedAccess, identity: paymentIdentity, readers, startedAt }),
    'financial_expected_access_invalid');
    assert.equal(readers.calls.length, 0);
  }
});

test('declined payment requires an explicit failed-payment state and rejects unknown status', async () => {
  const reconcile = needExport(financial, 'reconcileFinancialCase');
  const rejected = paidProviderState({ invoice: { status: 'open', amount_paid: 0, amount_remaining: 2500 },
    intent: { status: 'requires_payment_method', amount_received: 0,
      last_payment_error: { code: 'card_declined', decline_code: 'do_not_honor' } },
    charge: { paid: false, amount_captured: 0 } });
  const accepted = await reconcile({ context: needExport(contracts, 'createVerifiedContext')(makeAttemptParts()),
    caseId: 'payment.declined', expectedOutcome: 'unpaid', identity: paymentIdentity,
    readers: makeReaders({ provider: rejected, baseline: databaseSnapshot(), current: databaseSnapshot() }), startedAt });
  assert.equal(accepted.passed, true);

  const unknown = paidProviderState({ intent: { status: 'processing', amount_received: 0, latest_charge: null,
    last_payment_error: null }, invoice: { status: 'open', amount_paid: 0, amount_remaining: 2500 },
    charge: null, event: null, inbox: null, receipts: [] });
  const result = await reconcile({ context: needExport(contracts, 'createVerifiedContext')(makeAttemptParts()),
    caseId: 'payment.declined', expectedOutcome: 'unpaid', identity: paymentIdentity,
    readers: makeReaders({ provider: unknown, baseline: databaseSnapshot(), current: databaseSnapshot() }), startedAt });
  assert.equal(result.passed, false);
  assert.ok(result.failures.includes('declined_status_unverified'));
});

test('payment.3ds requires authenticated Stripe result and the bound Task7 capability', async () => {
  const reconcile = needExport(financial, 'reconcileFinancialCase');
  const capability = challengeCapabilities();
  const parts = makeAttemptParts();
  const result = await reconcile({ context: needExport(contracts, 'createVerifiedContext')(parts),
    caseId: 'payment.3ds', expectedOutcome: 'paid',
    expectedAccess: { contractId: 'contract_task6', areas: ['area_task6'] }, identity: paymentIdentity,
    readers: makeReaders({ current: paidDatabaseSnapshot() }), startedAt,
    challengeWitnessProvider: capability.provider, challengeVerifier: capability.verifier });
  assert.equal(result.passed, true);
  assert.equal(capability.calls[0].binding.fence, parts.owner.fence);

  const missing = await reconcile({ context: needExport(contracts, 'createVerifiedContext')(makeAttemptParts()),
    caseId: 'payment.3ds', expectedOutcome: 'paid',
    expectedAccess: { contractId: 'contract_task6', areas: ['area_task6'] }, identity: paymentIdentity,
    readers: makeReaders({ current: paidDatabaseSnapshot() }), startedAt });
  assert.equal(missing.passed, false);
  assert.ok(missing.failures.includes('challenge_witness_unverified'));
});

test('payment refresh and two-tabs require exactly one completion context', async () => {
  const reconcile = needExport(financial, 'reconcileFinancialCase');
  for (const caseId of ['payment.refresh', 'payment.two-tabs']) {
    const current = paidDatabaseSnapshot();
    current.contexts.push({ sessionId: 'cs_duplicate_task6', attemptId: 'attempt-task6', status: 'complete' });
    const result = await reconcile({ context: needExport(contracts, 'createVerifiedContext')(makeAttemptParts()),
      caseId, expectedOutcome: 'paid', expectedAccess: { contractId: 'contract_task6', areas: ['area_task6'] },
      identity: paymentIdentity, readers: makeReaders({ current }), startedAt });
    assert.equal(result.passed, false);
    assert.ok(result.failures.includes('single_effect_not_unique'));
  }
});

test('unsupported generic unpaid and settled categories fail closed before any reads', async () => {
  const reconcile = needExport(financial, 'reconcileFinancialCase');
  for (const caseId of ['payment.abandoned', 'payment.timeout', 'webhook.invalid-signature',
    'webhook.wrong-account', 'webhook.wrong-mode', 'subscription.add-area', 'finance.delinquency']) {
    const readers = makeReaders();
    await expectRefusal(reconcile({ context: needExport(contracts, 'createVerifiedContext')(makeAttemptParts()),
      caseId, identity: paymentIdentity, readers, startedAt }), 'financial_scenario_unsupported');
    assert.equal(readers.calls.length, 0);
  }
});

test('paid reconciliation rejects extra and duplicate active area grants', async () => {
  const reconcile = needExport(financial, 'reconcileFinancialCase');
  for (const additionalGrant of [
    { id: 'grant_extra', contractId: 'contract_task6', area: 'unexpected_area', status: 'active' },
    { id: 'grant_duplicate', contractId: 'contract_task6', area: 'area_task6', status: 'active' },
    { id: 'grant_other_contract', contractId: 'contract_other', area: 'unexpected_area', status: 'active' },
  ]) {
    const parts = makeAttemptParts();
    const current = paidDatabaseSnapshot();
    current.grants.push(additionalGrant);
    const result = await reconcile({ context: needExport(contracts, 'createVerifiedContext')(parts),
      caseId: 'payment.approved', expectedOutcome: 'paid',
      expectedAccess: { contractId: 'contract_task6', areas: ['area_task6'] }, identity: paymentIdentity,
      readers: makeReaders({ current }), startedAt });
    assert.equal(result.passed, false);
    assert.ok(result.failures.includes('entitlement_mismatch'));
  }
});

test('no entitlement may appear before authoritative provider reconciliation', async () => {
  const reconcile = needExport(financial, 'reconcileFinancialCase');
  const parts = makeAttemptParts();
  const unpaidProvider = paidProviderState({ invoice: { status: 'open', amount_paid: 0, amount_remaining: 2500 },
    intent: { status: 'requires_action', amount_received: 0, latest_charge: null }, charge: null, event: null, receipts: [],
    inbox: null });
  const result = await reconcile({ context: needExport(contracts, 'createVerifiedContext')(parts),
    caseId: 'payment.3ds', expectedOutcome: 'paid',
    expectedAccess: { contractId: 'contract_task6', areas: ['area_task6'] }, identity: paymentIdentity,
    readers: makeReaders({ provider: unpaidProvider, current: paidDatabaseSnapshot() }), startedAt });
  assert.equal(result.passed, false);
  assert.ok(result.failures.includes('entitlement_before_payment'));
});

test('all financial scenarios have fixed evidence requirements and no environment deferral API', () => {
  const requirements = needValue(financial, 'FINANCIAL_EVIDENCE_REQUIREMENTS');
  assert.deepEqual(requirements['payment.approved'], ['http', 'database', 'stripe', 'webhook', 'worker', 'browser']);
  assert.deepEqual(requirements['webhook.invalid-signature'], ['http', 'database', 'webhook']);
  assert.equal(Object.keys(requirements).length, 45);
  assert.equal(typeof financial.getFinancialValidationScenarios, 'undefined');
});

test('webhook resend requires existing processed inbox and receipt, then a fresh receipt after checkpoint', async () => {
  const resend = needExport(financial, 'resendWebhookDelivery');
  const parts = makeAttemptParts();
  const replay = webhookReplayStates();
  const readers = makeReaders({ provider: replay.provider, replayStates: replay.states });
  const checkpoint = manualResendCapabilities();
  const result = await resend({ context: needExport(contracts, 'createVerifiedContext')(parts),
    caseId: 'initial.webhook_replay', eventId: 'evt_task6', readers,
    resendCheckpointProvider: checkpoint.provider, resendCheckpointVerifier: checkpoint.verifier });
  assert.equal(result.passed, true);
  assert.equal(result.endpointAttribution, 'configuration-window-only');
  assert.equal(result.beforeReceiptIds.length, 1);
  assert.equal(result.afterReceiptIds.length, 2);
  assert.equal(checkpoint.calls[0].kind, 'request');
  assert.equal(checkpoint.calls[0].binding.attemptId, parts.owner.attemptId);
  assert.equal(checkpoint.calls[0].binding.caseId, 'initial.webhook_replay');
  assert.equal(checkpoint.calls[0].binding.eventId, 'evt_task6');
  assert.equal(checkpoint.calls[1].kind, 'verify');
  assert.equal(parts.calls.mutations.length, 0, 'manual Dashboard resend must not invoke a Stripe API mutation');
  assert.equal(readers.calls.filter((call) => call === 'stripe.retrieveWebhookEndpoint').length, 2);
});

test('pending_webhooks zero without a fresh post-checkpoint receipt refuses replay success', async () => {
  const resend = needExport(financial, 'resendWebhookDelivery');
  const parts = makeAttemptParts();
  const replay = webhookReplayStates({ fresh: false });
  const checkpoint = manualResendCapabilities();
  await expectRefusal(resend({ context: needExport(contracts, 'createVerifiedContext')(parts),
    caseId: 'initial.webhook_replay', eventId: 'evt_task6', readers: makeReaders({ provider: replay.provider, replayStates: replay.states }),
    resendCheckpointProvider: checkpoint.provider, resendCheckpointVerifier: checkpoint.verifier }),
  'webhook_replay_receipt_missing');
  assert.equal(parts.calls.cleanup.length, 0);
  assert.equal(parts.calls.mutations.length, 0);
});

test('a fresh replay receipt is accepted alongside the original processed inbox row', async () => {
  const resend = needExport(financial, 'resendWebhookDelivery');
  const parts = makeAttemptParts();
  const replay = webhookReplayStates();
  replay.states[1] = { ...replay.states[1], inbox: replay.states[0].inbox };
  const checkpoint = manualResendCapabilities();
  const result = await resend({ context: needExport(contracts, 'createVerifiedContext')(parts),
    caseId: 'initial.webhook_replay', eventId: 'evt_task6',
    readers: makeReaders({ provider: replay.provider, replayStates: replay.states }),
    resendCheckpointProvider: checkpoint.provider, resendCheckpointVerifier: checkpoint.verifier });
  assert.equal(result.passed, true);
  assert.equal(result.afterReceiptIds.includes('receipt_task6_replay'), true);
  assert.equal(parts.calls.mutations.length, 0);
});

test('webhook replay refuses if processing changes the exact Supabase financial snapshot', async () => {
  const resend = needExport(financial, 'resendWebhookDelivery');
  const parts = makeAttemptParts();
  const replay = webhookReplayStates({ unchanged: false });
  const checkpoint = manualResendCapabilities();
  await expectRefusal(resend({ context: needExport(contracts, 'createVerifiedContext')(parts),
    caseId: 'initial.webhook_replay', eventId: 'evt_task6', readers: makeReaders({ provider: replay.provider, replayStates: replay.states }),
    resendCheckpointProvider: checkpoint.provider, resendCheckpointVerifier: checkpoint.verifier }),
  'webhook_replay_financial_state_changed');
});

test('a plain manual acknowledgement cannot authorize resend or produce webhook evidence', async () => {
  const resend = needExport(financial, 'resendWebhookDelivery');
  const parts = makeAttemptParts();
  const replay = webhookReplayStates();
  const checkpoint = manualResendCapabilities({ response: true });
  await expectRefusal(resend({ context: needExport(contracts, 'createVerifiedContext')(parts),
    caseId: 'initial.webhook_replay', eventId: 'evt_task6',
    readers: makeReaders({ provider: replay.provider, replayStates: replay.states }),
    resendCheckpointProvider: checkpoint.provider, resendCheckpointVerifier: checkpoint.verifier }),
  'webhook_replay_checkpoint_invalid');
  assert.equal(parts.calls.mutations.length, 0);
});

test('built-in or unbranded checkpoint values cannot authorize a manual resend', async () => {
  const resend = needExport(financial, 'resendWebhookDelivery');
  for (const response of [new Date(), new Map(), Object.freeze(Object.create({ constructor: function Fake() {} }))]) {
    const parts = makeAttemptParts();
    const replay = webhookReplayStates();
    const checkpoint = manualResendCapabilities({ response });
    await expectRefusal(resend({ context: needExport(contracts, 'createVerifiedContext')(parts),
      caseId: 'initial.webhook_replay', eventId: 'evt_task6',
      readers: makeReaders({ provider: replay.provider, replayStates: replay.states }),
      resendCheckpointProvider: checkpoint.provider, resendCheckpointVerifier: checkpoint.verifier }),
    'webhook_replay_checkpoint_invalid');
    assert.equal(parts.calls.mutations.length, 0);
  }
});

test('resend refuses when the verified endpoint configuration window is not active', async () => {
  const resend = needExport(financial, 'resendWebhookDelivery');
  const parts = makeAttemptParts();
  const replay = webhookReplayStates();
  const checkpoint = manualResendCapabilities();
  const readers = makeReaders({ provider: { ...replay.provider, endpoint: { ...replay.provider.endpoint, livemode: true } },
    replayStates: replay.states });
  await expectRefusal(resend({ context: needExport(contracts, 'createVerifiedContext')(parts),
    caseId: 'initial.webhook_replay', eventId: 'evt_task6', readers,
    resendCheckpointProvider: checkpoint.provider, resendCheckpointVerifier: checkpoint.verifier }),
  'webhook_replay_endpoint_unverified');
  assert.equal(checkpoint.calls.length, 0);
  assert.equal(parts.calls.mutations.length, 0);
});
