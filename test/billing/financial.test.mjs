import assert from 'node:assert/strict';
import { test } from 'node:test';
import { environment, importIfMissing, makeAttemptParts, makeReaders, needExport,
  needValue, paymentIdentity, startedAt, webhookReplayStates,
  manualResendCapabilities, expectRefusal } from './support.mjs';

const contracts = await importIfMissing(() => import('../../src/billing/contracts.mjs'));
const financial = await importIfMissing(() => import('../../src/billing/financial.mjs'));
const fixtures = await importIfMissing(() => import('../../src/billing/fixtures.mjs'));

function completeBilling43Contracts() {
  return fixtures.FINANCIAL_SCENARIOS.map((id) => ({
    id,
    domain: id.split('.')[0],
    maxWrites: 0,
    allowedOperations: [],
    requiredEvidence: ['database'],
    async run() {},
  }));
}

test('checkout replay refuses a missing or incomplete registry before invoking Stripe', async () => {
  const replay = needExport(financial, 'replayCheckoutRequest');
  const parts = makeAttemptParts();
  const context = needExport(contracts, 'createVerifiedContext')(parts);
  const request = Object.freeze({ quoteId: 'quote_task6', idempotencyKey: 'quote-scoped-replay-0001',
    sessionParams: Object.freeze({ mode: 'subscription', currency: 'brl', amount: 2500 }) });

  for (const registry of [{}, { contracts: [] }]) {
    const outcome = await Promise.allSettled([
      replay({ context, applicationRequest: request, ...registry }),
    ]);
    assert.equal(parts.calls.mutations.length, 0);
    assert.equal(outcome[0].status, 'rejected');
    assert.equal(outcome[0].reason.code, 'billing_contracts_incomplete');
  }
});

test('checkout replay retains an unresolved intent after observation failure and blocks retries', async () => {
  const replay = needExport(financial, 'replayCheckoutRequest');
  const parts = makeAttemptParts();
  const domainContracts = completeBilling43Contracts();
  const verifiedContext = needExport(contracts, 'createVerifiedContext')(parts);
  const request = Object.freeze({ quoteId: 'quote_task6', idempotencyKey: 'quote-scoped-replay-0001',
    sessionParams: Object.freeze({ mode: 'subscription', currency: 'brl', amount: 2500 }) });
  await assert.rejects(replay({ context: verifiedContext, applicationRequest: request,
    contracts: domainContracts, readStripeIntentObservation: async () => {
      throw new Error('independent read unavailable');
    } }), { code: 'stripe_observation_unavailable' });
  await assert.rejects(replay({ context: verifiedContext, applicationRequest: request,
    contracts: domainContracts, readStripeIntentObservation: async () => ({}) }),
  { code: 'stripe_intent_unresolved' });
  assert.equal(parts.calls.mutations.length, 1);
  assert.equal(parts.calls.mutations[0].input.applicationRequest.idempotencyKey, 'quote-scoped-replay-0001');
  assert.equal(parts.calls.mutations[0].attemptId, parts.owner.attemptId);
  assert.equal(parts.calls.intentBegins.length, 1);
});

test('checkout replay independently reconciles a successful dispatch before returning', async () => {
  const replay = needExport(financial, 'replayCheckoutRequest');
  const parts = makeAttemptParts();
  const domainContracts = completeBilling43Contracts();
  const context = needExport(contracts, 'createVerifiedContext')(parts);
  const request = Object.freeze({ quoteId: 'quote_task6', idempotencyKey: 'quote-scoped-replay-0001',
    sessionParams: Object.freeze({ mode: 'subscription', currency: 'brl', amount: 2500 }) });
  let observed;

  const result = await replay({ context, applicationRequest: request, contracts: domainContracts,
    readStripeIntentObservation: async (input) => {
      observed = input;
      return { accountId: environment.stripe.accountId, livemode: false,
        operation: 'checkout-replay:quote_task6', requestDigest: input.intent.requestDigest,
        idempotencyKey: input.intent.idempotencyKey,
        resourceIds: ['cs_task6created'] };
    } });

  assert.equal(result.state, 'reconciled');
  assert.equal(typeof result.receiptId, 'string');
  assert.equal(observed.intent.intentId, result.intentId);
  assert.equal(observed.attemptId, parts.owner.attemptId);
  assert.equal(observed.fence, parts.owner.fence);
  assert.equal(observed.applicationRequest.quoteId, 'quote_task6');
  assert.equal(parts.calls.reconciliations.length, 1);
  assert.deepEqual(await parts.attempts.listPendingStripeIntents({
    attemptId: parts.owner.attemptId, fence: parts.owner.fence,
  }), []);
  assert.equal(JSON.stringify(result).includes('client_secret'), false);
});

test('checkout replay requires an independent reader before dispatching Stripe', async () => {
  const replay = needExport(financial, 'replayCheckoutRequest');
  const parts = makeAttemptParts();
  const context = needExport(contracts, 'createVerifiedContext')(parts);
  const request = Object.freeze({ quoteId: 'quote_task6', idempotencyKey: 'quote-scoped-replay-0001',
    sessionParams: Object.freeze({ mode: 'subscription', currency: 'brl', amount: 2500 }) });

  await expectRefusal(replay({ context, applicationRequest: request,
    contracts: completeBilling43Contracts() }), 'checkout_replay_reconciliation_unavailable');
  assert.equal(parts.calls.mutations.length, 0);
  assert.equal(parts.calls.intentBegins.length, 0);
});

test('failed independent checkout observation retains the intent and blocks cleanup', async () => {
  const replay = needExport(financial, 'replayCheckoutRequest');
  const parts = makeAttemptParts();
  const context = needExport(contracts, 'createVerifiedContext')(parts);
  const request = Object.freeze({ quoteId: 'quote_task6', idempotencyKey: 'quote-scoped-replay-0001',
    sessionParams: Object.freeze({ mode: 'subscription', currency: 'brl', amount: 2500 }) });

  await assert.rejects(replay({ context, applicationRequest: request,
    contracts: completeBilling43Contracts(),
    readStripeIntentObservation: async () => { throw new Error('independent read unavailable'); } }),
  { code: 'stripe_observation_unavailable' });
  assert.equal(parts.calls.mutations.length, 1);
  assert.equal(parts.calls.reconciliations.length, 0);
  assert.equal((await parts.attempts.listPendingStripeIntents({
    attemptId: parts.owner.attemptId, fence: parts.owner.fence,
  })).length, 1);
});

test('payment.3ds is excluded from the canonical 43 and remains in the supervised suite', async () => {
  const reconcile = needExport(financial, 'reconcileFinancialCase');
  const parts = makeAttemptParts();
  const readers = makeReaders();
  await expectRefusal(reconcile({ context: needExport(contracts, 'createVerifiedContext')(parts),
    caseId: 'payment.3ds', expectedOutcome: 'paid',
    expectedAccess: { contractId: 'contract_task6', areas: ['area_task6'] }, identity: paymentIdentity,
    readers, startedAt }), 'financial_scenario_unsupported');
  assert.equal(readers.calls.length, 0);
  assert.equal(parts.calls.assertions.length, 0);
});

test('unknown financial categories fail closed before any reads', async () => {
  const reconcile = needExport(financial, 'reconcileFinancialCase');
  for (const caseId of ['not-a-case']) {
    const readers = makeReaders();
    await expectRefusal(reconcile({ context: needExport(contracts, 'createVerifiedContext')(makeAttemptParts()),
      caseId, identity: paymentIdentity, readers, startedAt }), 'financial_scenario_unsupported');
    assert.equal(readers.calls.length, 0);
  }
});

test('financial reconciliation refuses all blocked Task 5 cases before invoking any evidence reader', async () => {
  const reconcile = needExport(financial, 'reconcileFinancialCase');
  const blocked = needValue(fixtures, 'TASK5_BLOCKED_SCENARIO_CONTRACTS');
  for (const [caseId, contract] of Object.entries(blocked)) {
    const parts = makeAttemptParts();
    const readers = makeReaders();
    await expectRefusal(reconcile({ context: needExport(contracts, 'createVerifiedContext')(parts),
      caseId, expectedOutcome: 'paid', expectedAccess: { contractId: 'contract_task6', areas: ['area_task6'] },
      identity: paymentIdentity, readers, startedAt }), contract.reasonCode);
    assert.equal(readers.calls.length, 0, `${caseId} must not inspect financial evidence`);
  }
});

test('financial reconciliation refuses all blocked Task 6 cases before readers or stale fence checks', async () => {
  const reconcile = needExport(financial, 'reconcileFinancialCase');
  const blocked = needValue(fixtures, 'TASK6_BLOCKED_SCENARIO_CONTRACTS');
  for (const [caseId, contract] of Object.entries(blocked)) {
    const parts = makeAttemptParts({ currentFence: '22222222-2222-4222-8222-222222222222' });
    const readers = makeReaders();
    await expectRefusal(reconcile({ context: needExport(contracts, 'createVerifiedContext')(parts),
      caseId, expectedOutcome: 'settled', identity: paymentIdentity, readers, startedAt }),
    contract.reasonCode);
    assert.equal(readers.calls.length, 0, `${caseId} must not inspect financial evidence`);
    assert.equal(parts.calls.assertions.length, 0, `${caseId} must not continue past the block`);
    assert.equal(parts.calls.mutations.length, 0, `${caseId} must not mutate`);
  }
});

test('trusted financial requirements cover only canonical billing IDs', () => {
  const requirements = needValue(financial, 'FINANCIAL_EVIDENCE_REQUIREMENTS');
  assert.deepEqual(requirements['payment.approved'], ['http', 'database', 'stripe', 'webhook', 'worker', 'browser']);
  assert.deepEqual(requirements['webhook.invalid-signature'], ['http', 'database', 'webhook']);
  assert.equal(Object.keys(requirements).length, 43);
  assert.equal(Object.hasOwn(requirements, 'signup.advbox'), false);
  assert.equal(Object.hasOwn(requirements, 'payment.3ds'), false);
  assert.deepEqual(needValue(fixtures, 'SUPERVISED_FINANCIAL_SCENARIOS'), ['signup.advbox', 'payment.3ds']);
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
  const afterState = replay.states[1];
  const priorReceipts = [...replay.states[0].receipts];
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

test('a receipt arriving while the manual checkpoint request is pending cannot satisfy replay', async () => {
  const resend = needExport(financial, 'resendWebhookDelivery');
  const parts = makeAttemptParts();
  const replay = webhookReplayStates({ fresh: false });
  const checkpoint = manualResendCapabilities();
  const afterState = replay.states[1];
  const priorReceipts = replay.states[0].receipts;
  let receiptArrivedBeforeCheckpointReturned = false;
  const delayedProvider = {
    async request(binding) {
      const witness = await checkpoint.provider.request(binding);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const receivedAt = new Date().toISOString();
      Object.assign(afterState, {
        observedAt: new Date(Date.now() + 60_000).toISOString(),
        receipts: [...priorReceipts,
          { ...replay.provider.receipts[0], id: 'receipt_during_checkpoint', receivedAt }],
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      receiptArrivedBeforeCheckpointReturned = true;
      return witness;
    },
  };
  await expectRefusal(resend({ context: needExport(contracts, 'createVerifiedContext')(parts),
    caseId: 'initial.webhook_replay', eventId: 'evt_task6',
    readers: makeReaders({ provider: replay.provider, replayStates: replay.states }),
    resendCheckpointProvider: delayedProvider, resendCheckpointVerifier: checkpoint.verifier }),
  'webhook_replay_receipt_missing');
  assert.equal(receiptArrivedBeforeCheckpointReturned, true);
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
