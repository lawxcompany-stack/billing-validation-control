import assert from 'node:assert/strict';
import { test } from 'node:test';
import { challengeCapabilities, databaseSnapshot, importIfMissing, makeAttemptParts, makeReaders,
  needExport, paidDatabaseSnapshot, paidProviderState, paymentIdentity, startedAt,
  webhookReplayStates, manualResendCapabilities, expectRefusal } from './support.mjs';

const contracts = await importIfMissing(() => import('../../src/billing/contracts.mjs'));
const threeDs = await importIfMissing(() => import('../../src/billing/three-ds.mjs'));

function invocation(caseId, providerState = paidProviderState(), current = paidDatabaseSnapshot(), extra = {}) {
  const parts = makeAttemptParts();
  return { parts, input: { context: needExport(contracts, 'createVerifiedContext')(parts), caseId,
    identity: paymentIdentity, readers: makeReaders({ provider: providerState, baseline: databaseSnapshot(), current }),
    expectedAccess: { contractId: 'contract_task6', areas: ['area_task6'] }, startedAt, ...extra } };
}

function delayedInvocation({ pendingWebhooks = 1, preFinancialEffect = false, preSnapshotMismatch = false,
  freshReceiptAtOffset = 60_000, includeFreshReceipt = true, postInboxStatus = 'processed',
  postReobservationMismatch = false, preInboxStatus = 'pending', includeInitialReceipt = true,
  eventId = 'evt_task6', omitIdentityEventId = false, processedAtOffset = 60_500 } = {}) {
  const baseTime = Date.now();
  const iso = (offset) => new Date(baseTime + offset).toISOString();
  const initialInbox = { eventId, eventType: 'invoice.paid', objectId: 'in_task6',
    accountId: 'acct_task6test123', livemode: false, status: preInboxStatus, attempts: 1,
    receivedAt: iso(-30_000), processedAt: null };
  const provider = paidProviderState({ event: { id: eventId, pending_webhooks: pendingWebhooks }, inbox: initialInbox,
    receipt: { eventId, receivedAt: iso(-30_000) } });
  if (preInboxStatus === null) provider.inbox = null;
  if (!includeInitialReceipt) provider.receipts = [];
  const baseline = databaseSnapshot({ observedAt: iso(-40_000) });
  const current = databaseSnapshot({ observedAt: iso(-15_000) });
  if (preFinancialEffect) current.settlements.push({ id: 'sett_preexisting', contractId: 'contract_task6',
    invoiceId: 'in_task6', subscriptionId: 'sub_task6', customerId: 'cus_task6', amount: 2500,
    currency: 'BRL', operation: 'subscription_initial', revision: 1 });
  const beforeSnapshot = structuredClone(current);
  beforeSnapshot.observedAt = iso(-10_000);
  if (preSnapshotMismatch) beforeSnapshot.usage.push({ id: 'usage_snapshot_mismatch', contractId: 'contract_task6',
    includedUnits: 10, consumedUnits: 0, reservedUnits: 0 });
  const afterSnapshot = paidDatabaseSnapshot({ observedAt: iso(61_000) });
  const afterInbox = { ...initialInbox, status: postInboxStatus,
    processedAt: postInboxStatus === 'processed' ? iso(processedAtOffset) : null };
  const initialReceipt = provider.receipts[0] ?? { eventId, eventType: 'invoice.paid', objectId: 'in_task6',
    accountId: 'acct_task6test123', livemode: false, apiVersion: '2026-01-01',
    receivedAt: iso(-30_000) };
  const freshReceipt = { ...initialReceipt, id: 'receipt_task6_delayed', receivedAt: iso(freshReceiptAtOffset) };
  const beforeState = { observedAt: iso(-10_000), inbox: structuredClone(provider.inbox),
    receipts: structuredClone(provider.receipts), snapshot: beforeSnapshot };
  const afterState = { observedAt: iso(61_000), inbox: afterInbox,
    receipts: includeFreshReceipt ? [...structuredClone(provider.receipts), freshReceipt] : structuredClone(provider.receipts),
    snapshot: afterSnapshot };
  const readers = makeReaders({ provider, baseline, current, replayStates: [beforeState, afterState] });
  if (postReobservationMismatch) {
    const readBillingSnapshot = readers.supabase.readBillingSnapshot.bind(readers.supabase);
    let currentReads = 0;
    readers.supabase.readBillingSnapshot = async (request) => {
      const snapshot = await readBillingSnapshot(request);
      if (request.phase === 'current' && ++currentReads === 2) {
        snapshot.grants.push({ id: 'grant_task6_extra', contractId: 'contract_task6',
          area: 'area_extra', status: 'active' });
      }
      return snapshot;
    };
  }
  const capability = challengeCapabilities();
  const checkpoint = manualResendCapabilities({ eventId });
  const verifier = {
    isOpaqueCapability: (...args) => checkpoint.verifier.isOpaqueCapability(...args),
    async verify(witness, binding) {
      const verified = await checkpoint.verifier.verify(witness, binding);
      if (verified) {
        provider.event.pending_webhooks = 0;
        provider.inbox = structuredClone(afterInbox);
        provider.receipts = structuredClone(afterState.receipts);
        for (const [key, value] of Object.entries(afterSnapshot)) current[key] = structuredClone(value);
      }
      return verified;
    },
  };
  const identity = { ...paymentIdentity };
  if (omitIdentityEventId) delete identity.eventId;
  const { parts, input } = invocation('initial.webhook_delayed', provider, current, {
    identity,
    readers, challengeWitnessProvider: capability.provider, challengeVerifier: capability.verifier,
    resendCheckpointProvider: checkpoint.provider, resendCheckpointVerifier: verifier });
  return { parts, input, provider, current, beforeState, afterState, checkpoint, readers };
}

test('paid challenge succeeds with null Stripe flow only after the bound opaque witness verifier approves', async () => {
  const evaluate = needExport(threeDs, 'runThreeDsCase');
  const capability = challengeCapabilities();
  const { input } = invocation('initial.challenge.success', paidProviderState(), paidDatabaseSnapshot(), {
    challengeWitnessProvider: capability.provider, challengeVerifier: capability.verifier });
  const result = await evaluate(input);
  assert.equal(result.passed, true);
  assert.equal(result.evidence.provider.authenticationFlow, null);
  assert.deepEqual(capability.calls.map((call) => call.kind), ['obtain', 'verify']);
  assert.deepEqual(capability.calls[0].binding, { attemptId: 'attempt-task6',
    fence: 'fence-task6', caseId: 'initial.challenge.success', paymentIntentId: 'pi_task6' });
});

test('operator acknowledgement, a boolean, or a JSON witness cannot establish a challenge', async () => {
  const evaluate = needExport(threeDs, 'runThreeDsCase');
  for (const payload of [true, { acknowledged: true }, { challengeObserved: true, authenticationFlow: 'challenge' }]) {
    const { input } = invocation('initial.challenge.success', paidProviderState(), paidDatabaseSnapshot(), {
      challengeWitnessProvider: payload, challengeVerifier: { async verify() { return true; } } });
    const result = await evaluate(input);
    assert.equal(result.passed, false);
    assert.ok(result.failures.includes('challenge_witness_unverified'));
  }
});

test('built-in objects are not accepted as opaque Task7 challenge capabilities', async () => {
  const evaluate = needExport(threeDs, 'runThreeDsCase');
  for (const witness of [new Date(), new Map()]) {
    const { input } = invocation('initial.challenge.success', paidProviderState(), paidDatabaseSnapshot(), {
      challengeWitnessProvider: { async obtain() { return witness; } },
      challengeVerifier: { async verify() { return true; } } });
    const result = await evaluate(input);
    assert.equal(result.passed, false);
    assert.ok(result.failures.includes('challenge_witness_unverified'));
  }
});

test('a custom prototype without Task7 capability brand cannot establish challenge evidence', async () => {
  const evaluate = needExport(threeDs, 'runThreeDsCase');
  const witness = Object.freeze(Object.create({ constructor: function SyntheticCapability() {} }));
  const { input } = invocation('initial.challenge.success', paidProviderState(), paidDatabaseSnapshot(), {
    challengeWitnessProvider: { async obtain() { return witness; } },
    challengeVerifier: { async isOpaqueCapability() { return false; }, async verify() { return true; } } });
  const result = await evaluate(input);
  assert.equal(result.passed, false);
  assert.ok(result.failures.includes('challenge_witness_unverified'));
});

test('a witness verifier bound to another attempt, case, or PaymentIntent cannot pass', async () => {
  const evaluate = needExport(threeDs, 'runThreeDsCase');
  const capability = challengeCapabilities({ verified: false });
  const { input } = invocation('initial.challenge.success', paidProviderState(), paidDatabaseSnapshot(), {
    challengeWitnessProvider: capability.provider, challengeVerifier: capability.verifier });
  const result = await evaluate(input);
  assert.equal(result.passed, false);
  assert.ok(result.failures.includes('challenge_witness_unverified'));
});

test('a challenge witness bound to a previous Task 5 fence cannot pass', async () => {
  const evaluate = needExport(threeDs, 'runThreeDsCase');
  const capability = challengeCapabilities({ expectedFence: 'previous-fence' });
  const { input } = invocation('initial.challenge.success', paidProviderState(), paidDatabaseSnapshot(), {
    challengeWitnessProvider: capability.provider, challengeVerifier: capability.verifier });
  const result = await evaluate(input);
  assert.equal(result.passed, false);
  assert.ok(result.failures.includes('challenge_witness_unverified'));
  assert.equal(capability.calls[0].binding.fence, 'fence-task6');
});

test('positive challenge requires Stripe authenticationResult authenticated, even with a valid witness', async () => {
  const evaluate = needExport(threeDs, 'runThreeDsCase');
  for (const authenticationResult of [undefined, 'failed']) {
    const capability = challengeCapabilities();
    const provider = paidProviderState({ charge: { payment_method_details: { card: { three_d_secure: {
      authentication_flow: null, result: authenticationResult } } } } });
    const { input } = invocation('initial.challenge.success', provider, paidDatabaseSnapshot(), {
      challengeWitnessProvider: capability.provider, challengeVerifier: capability.verifier });
    const result = await evaluate(input);
    assert.equal(result.passed, false);
    assert.notEqual(result.evidence.provider.authenticationResult, 'authenticated');
    assert.ok(result.failures.includes('payment_reconciliation_incomplete'));
  }
});

test('paid 3DS refuses absent or empty expected access before provider reads', async () => {
  const evaluate = needExport(threeDs, 'runThreeDsCase');
  for (const expectedAccess of [undefined, { contractId: 'contract_task6', areas: [] }]) {
    const { input } = invocation('initial.challenge.success', paidProviderState(), paidDatabaseSnapshot(),
      { expectedAccess });
    await expectRefusal(evaluate(input), 'three_ds_expected_access_invalid');
    assert.equal(input.readers.calls.length, 0);
  }
});

test('paid 3DS requires the new settlement to belong to the expected contract', async () => {
  const evaluate = needExport(threeDs, 'runThreeDsCase');
  const capability = challengeCapabilities();
  const current = paidDatabaseSnapshot();
  current.settlements[0].contractId = 'contract_other';
  const { input } = invocation('initial.challenge.success', paidProviderState(), current, {
    challengeWitnessProvider: capability.provider, challengeVerifier: capability.verifier });
  const result = await evaluate(input);
  assert.equal(result.passed, false);
  assert.ok(result.failures.includes('payment_reconciliation_incomplete'));
});

test('paid 3DS cannot count an active grant that was already present in the baseline', async () => {
  const evaluate = needExport(threeDs, 'runThreeDsCase');
  const capability = challengeCapabilities();
  const current = paidDatabaseSnapshot();
  const baseline = databaseSnapshot();
  baseline.grants = structuredClone(current.grants);
  const readers = makeReaders({ baseline, current });
  const { input } = invocation('initial.challenge.success', paidProviderState(), current, {
    readers, challengeWitnessProvider: capability.provider, challengeVerifier: capability.verifier });
  const result = await evaluate(input);
  assert.equal(result.passed, false);
  assert.ok(result.failures.includes('payment_reconciliation_incomplete'));
});

test('challenge failure shows no settlement, grant, revision, or usage change', async () => {
  const evaluate = needExport(threeDs, 'runThreeDsCase');
  const capability = challengeCapabilities();
  const provider = paidProviderState({ invoice: { status: 'open', amount_paid: 0, amount_remaining: 2500 },
    intent: { status: 'requires_payment_method', amount_received: 0, last_payment_error: { code: 'authentication_failed' } },
    charge: { paid: false, amount_captured: 0, payment_method_details: { card: { three_d_secure: {
      authentication_flow: 'challenge', result: 'failed', result_reason: 'failed' } } } }, event: null, inbox: null, receipts: [] });
  const { input } = invocation('initial.challenge.failure', provider, databaseSnapshot(), {
    challengeWitnessProvider: capability.provider, challengeVerifier: capability.verifier });
  const result = await evaluate(input);
  assert.equal(result.passed, true);
  assert.equal(result.outcome, 'no_new_access');
});

test('cancellation requires the latest Charge authentication result reason canceled', async () => {
  const evaluate = needExport(threeDs, 'runThreeDsCase');
  const capability = challengeCapabilities();
  const provider = paidProviderState({ invoice: { status: 'void', amount_paid: 0, amount_remaining: 0 },
    intent: { status: 'canceled', amount_received: 0 }, charge: { paid: false, amount_captured: 0,
      payment_method_details: { card: { three_d_secure: { authentication_flow: 'challenge',
        result: 'failed', result_reason: 'canceled' } } } }, event: null, inbox: null, receipts: [] });
  const { input } = invocation('initial.challenge.cancel', provider, databaseSnapshot(), {
    challengeWitnessProvider: capability.provider, challengeVerifier: capability.verifier });
  const result = await evaluate(input);
  assert.equal(result.passed, true);
  const incorrect = paidProviderState({ invoice: { status: 'void', amount_paid: 0, amount_remaining: 0 },
    intent: { status: 'canceled', amount_received: 0 }, charge: { paid: false, amount_captured: 0,
      payment_method_details: { card: { three_d_secure: { authentication_flow: 'challenge',
        result: 'failed', result_reason: null } } } }, event: null, inbox: null, receipts: [] });
  const invalid = await evaluate({ ...input, readers: makeReaders({ provider: incorrect, baseline: databaseSnapshot(), current: databaseSnapshot() }) });
  assert.equal(invalid.passed, false);
  assert.ok(invalid.failures.includes('cancellation_not_verified'));
});

test('authenticated decline is not payment success and cannot create access', async () => {
  const evaluate = needExport(threeDs, 'runThreeDsCase');
  const capability = challengeCapabilities();
  const provider = paidProviderState({ invoice: { status: 'open', amount_paid: 0, amount_remaining: 2500 },
    intent: { status: 'requires_payment_method', amount_received: 0,
      last_payment_error: { code: 'card_declined', decline_code: 'do_not_honor' } },
    charge: { paid: false, amount_captured: 0, payment_method_details: { card: { three_d_secure: {
      authentication_flow: 'challenge', result: 'authenticated', result_reason: null } } } }, event: null, inbox: null, receipts: [] });
  const { input } = invocation('initial.authenticated.declined', provider, databaseSnapshot(), {
    challengeWitnessProvider: capability.provider, challengeVerifier: capability.verifier });
  const result = await evaluate(input);
  assert.equal(result.passed, true);
  assert.equal(result.outcome, 'no_new_access');
});

test('incomplete authentication is a passing negative observation, never a payment success', async () => {
  const evaluate = needExport(threeDs, 'runThreeDsCase');
  const capability = challengeCapabilities();
  const provider = paidProviderState({ invoice: { status: 'open', amount_paid: 0, amount_remaining: 2500 },
    intent: { status: 'requires_action', amount_received: 0, latest_charge: null }, charge: null,
    event: null, inbox: null, receipts: [] });
  const { input } = invocation('initial.challenge.incomplete', provider, databaseSnapshot(), {
    challengeWitnessProvider: capability.provider, challengeVerifier: capability.verifier });
  const result = await evaluate(input);
  assert.equal(result.passed, true);
  assert.equal(result.outcome, 'incomplete');
  assert.notEqual(result.outcome, 'paid_challenge');
});

test('negative challenge result cannot pass if Stripe records any amount received', async () => {
  const evaluate = needExport(threeDs, 'runThreeDsCase');
  const capability = challengeCapabilities();
  const provider = paidProviderState({ invoice: { status: 'open', amount_paid: 0, amount_remaining: 2500 },
    intent: { status: 'requires_payment_method', amount_received: 1, last_payment_error: {
      code: 'authentication_failed', decline_code: null } },
    charge: { paid: false, amount_captured: 0, payment_method_details: { card: { three_d_secure: {
      authentication_flow: 'challenge', result: 'failed', result_reason: 'failed' } } } },
    event: null, inbox: null, receipts: [] });
  const { input } = invocation('initial.challenge.failure', provider, databaseSnapshot(), {
    challengeWitnessProvider: capability.provider, challengeVerifier: capability.verifier });
  const result = await evaluate(input);
  assert.equal(result.passed, false);
  assert.ok(result.failures.includes('unexpected_payment'));
});

test('frictionless success requires Stripe frictionless authentication and no challenge witness', async () => {
  const evaluate = needExport(threeDs, 'runThreeDsCase');
  const provider = paidProviderState({ charge: { payment_method_details: { card: { three_d_secure: {
    authentication_flow: 'frictionless', result: 'authenticated', result_reason: null } } } } });
  const { input } = invocation('initial.frictionless', provider, paidDatabaseSnapshot());
  const result = await evaluate(input);
  assert.equal(result.passed, true);
  assert.equal(result.outcome, 'paid_frictionless');
});

test('an expired case requires a retrieved expired Checkout Session and unpaid state', async () => {
  const evaluate = needExport(threeDs, 'runThreeDsCase');
  const expiredState = paidProviderState({ invoice: { status: 'open', amount_paid: 0, amount_remaining: 2500 },
    intent: { status: 'requires_payment_method', amount_received: 0, latest_charge: null },
    charge: null, event: null, inbox: null, receipts: [],
    checkoutSession: { status: 'expired', payment_status: 'unpaid', expires_at: Math.floor(Date.now() / 1000) - 60 } });
  const positive = invocation('initial.expired', expiredState, databaseSnapshot());
  const result = await evaluate(positive.input);
  assert.equal(result.passed, true);
  assert.equal(result.evidence.checkoutSessionStatus, 'expired');
  assert.equal(result.evidence.checkoutPaymentStatus, 'unpaid');

  const noSession = invocation('initial.expired', paidProviderState({ invoice: { status: 'open', amount_paid: 0,
    amount_remaining: 2500 }, intent: { status: 'requires_payment_method', amount_received: 0,
    latest_charge: null }, charge: null, event: null, inbox: null, receipts: [], checkoutSession: null }), databaseSnapshot());
  const missing = await evaluate(noSession.input);
  assert.equal(missing.passed, false);
  assert.ok(missing.failures.includes('checkout_session_expiry_unverified'));
});

test('foreign_actor passes only when a trusted access observation proves cross-team denial', async () => {
  const evaluate = needExport(threeDs, 'runThreeDsCase');
  const negativePayment = paidProviderState({ invoice: { status: 'open', amount_paid: 0, amount_remaining: 2500 },
    intent: { status: 'requires_payment_method', amount_received: 0, latest_charge: null },
    charge: null, event: null, inbox: null, receipts: [] });
  const accessDecision = async () => ({ actorTeamId: 'team_foreign', resourceTeamId: 'team_task6',
    allowed: false, statusCode: 403, reason: 'team_mismatch' });
  const { input } = invocation('access.foreign_actor', negativePayment, databaseSnapshot(), {
    readers: makeReaders({ provider: negativePayment, baseline: databaseSnapshot(), current: databaseSnapshot(), accessDecision }) });
  const result = await evaluate(input);
  assert.equal(result.passed, true);
  assert.equal(result.evidence.accessDecision.denied, true);

  const allowed = invocation('access.foreign_actor', negativePayment, databaseSnapshot(), {
    readers: makeReaders({ provider: negativePayment, baseline: databaseSnapshot(), current: databaseSnapshot(),
      accessDecision: async () => ({ actorTeamId: 'team_foreign', resourceTeamId: 'team_task6',
        allowed: true, statusCode: 200, reason: null }) }) });
  const invalid = await evaluate(allowed.input);
  assert.equal(invalid.passed, false);
  assert.ok(invalid.failures.includes('foreign_actor_denial_unverified'));
});

test('delayed and replay cases bind Task7 checkpoint and require a fresh receipt with unchanged DB', async () => {
  const evaluate = needExport(threeDs, 'runThreeDsCase');
  for (const caseId of ['initial.webhook_replay']) {
    const capability = challengeCapabilities();
    const checkpoint = manualResendCapabilities();
    const replay = webhookReplayStates();
    const [beforeReplay, afterReplay] = replay.states;
    const current = replay.initialSnapshot;
    assert.ok(current, 'fixture provides an initial pre-checkpoint database snapshot');
    const initialObservedAt = Date.parse(current.observedAt);
    const originalReceiptTimes = replay.provider.receipts.map(({ receivedAt }) => Date.parse(receivedAt));
    assert.ok(originalReceiptTimes.every((receivedAt) => receivedAt <= initialObservedAt));
    assert.ok(Date.parse(replay.provider.inbox.processedAt) <= initialObservedAt);
    assert.ok(initialObservedAt <= Date.parse(beforeReplay.observedAt));
    assert.equal(Date.parse(beforeReplay.snapshot.observedAt), Date.parse(beforeReplay.observedAt));
    assert.equal(Date.parse(afterReplay.snapshot.observedAt), Date.parse(afterReplay.observedAt));
    const readers = makeReaders({ provider: replay.provider, current, replayStates: replay.states });
    const { parts, input } = invocation(caseId, replay.provider, current, {
      readers, challengeWitnessProvider: capability.provider, challengeVerifier: capability.verifier,
      resendCheckpointProvider: checkpoint.provider, resendCheckpointVerifier: checkpoint.verifier });
    const result = await evaluate(input);
    assert.equal(result.passed, true);
    assert.equal(result.webhookReplay.passed, true);
    assert.deepEqual(checkpoint.calls[0].binding, { attemptId: 'attempt-task6', fence: 'fence-task6',
      caseId, eventId: 'evt_task6' });
    assert.equal(parts.calls.mutations.length, 0, 'manual resend never uses a provider mutation adapter');
    const freshReceipt = afterReplay.receipts.find(({ id }) => id === 'receipt_task6_replay');
    assert.ok(Date.parse(freshReceipt.receivedAt) > Date.parse(result.webhookReplay.checkpointAt));
    assert.ok(Date.parse(freshReceipt.receivedAt) <= Date.parse(afterReplay.observedAt));
  }
});

test('delayed webhook requires pending/no-effect before checkpoint then exact paid reconciliation afterward', async () => {
  const evaluate = needExport(threeDs, 'runThreeDsCase');
  const fixture = delayedInvocation();
  const result = await evaluate(fixture.input);
  assert.equal(result.passed, true);
  assert.equal(result.outcome, 'paid_challenge');
  assert.equal(result.webhookDelayed.passed, true);
  assert.equal(fixture.checkpoint.calls.map(({ kind }) => kind).join(','), 'request,verify');
  assert.equal(fixture.parts.calls.mutations.length, 0);
  assert.equal(result.evidence.webhook.pendingWebhooks, 0);
  assert.equal(result.evidence.webhook.processed, true);
  assert.equal(result.evidence.database.settlementCount, 1);
  assert.equal(result.evidence.database.grantCount, 1);
  assert.equal(fixture.readers.calls.filter((call) => call === 'supabase.readBillingSnapshot:current').length, 2);
});

test('delayed webhook accepts the paused state with no receiver row and no receipts', async () => {
  const evaluate = needExport(threeDs, 'runThreeDsCase');
  const fixture = delayedInvocation({ preInboxStatus: null, includeInitialReceipt: false });
  const result = await evaluate(fixture.input);
  assert.equal(result.passed, true);
  assert.equal(fixture.checkpoint.calls.length, 2);
});

test('delayed webhook accepts only known non-processed receiver states before checkpoint', async () => {
  const evaluate = needExport(threeDs, 'runThreeDsCase');
  for (const status of ['pending', 'processing', 'failed']) {
    const fixture = delayedInvocation({ preInboxStatus: status });
    const result = await evaluate(fixture.input);
    assert.equal(result.passed, true, `status ${status} remains a valid unprocessed receiver state`);
  }
});

test('delayed webhook binds a Stripe-generated event ID from trusted initial evidence', async () => {
  const evaluate = needExport(threeDs, 'runThreeDsCase');
  const fixture = delayedInvocation({ eventId: 'evt_generated_task6', omitIdentityEventId: true });
  const result = await evaluate(fixture.input);
  assert.equal(result.passed, true);
  assert.equal(result.webhookDelayed.eventId, 'evt_generated_task6');
  assert.equal(fixture.checkpoint.calls[0].binding.eventId, 'evt_generated_task6');
});

test('delayed webhook requires processedAt strictly after verified checkpoint', async () => {
  const evaluate = needExport(threeDs, 'runThreeDsCase');
  const fixture = delayedInvocation({ processedAtOffset: -5_000 });
  const result = await evaluate(fixture.input);
  assert.equal(result.passed, false);
  assert.equal(fixture.checkpoint.calls.length, 2);
});

test('delayed webhook refuses without a pending before-state or when pre-state has financial effects', async () => {
  const evaluate = needExport(threeDs, 'runThreeDsCase');
  for (const fixture of [delayedInvocation({ pendingWebhooks: 0 }), delayedInvocation({ preFinancialEffect: true })]) {
    const result = await evaluate(fixture.input);
    assert.equal(result.passed, false);
    assert.equal(fixture.checkpoint.calls.length, 0);
  }
});

test('delayed webhook binds the before snapshot to initial observation before requesting checkpoint', async () => {
  const evaluate = needExport(threeDs, 'runThreeDsCase');
  const fixture = delayedInvocation({ preSnapshotMismatch: true });
  const result = await evaluate(fixture.input);
  assert.equal(result.passed, false);
  assert.equal(fixture.checkpoint.calls.length, 0);
});

test('delayed webhook rejects an old receipt even when it appears during the resend checkpoint', async () => {
  const evaluate = needExport(threeDs, 'runThreeDsCase');
  const fixture = delayedInvocation({ freshReceiptAtOffset: -5_000 });
  const result = await evaluate(fixture.input);
  assert.equal(result.passed, false);
  assert.equal(fixture.checkpoint.calls.length, 2);
});

test('delayed webhook requires a fresh receipt and processed inbox after checkpoint', async () => {
  const evaluate = needExport(threeDs, 'runThreeDsCase');
  for (const fixture of [delayedInvocation({ includeFreshReceipt: false }),
    delayedInvocation({ postInboxStatus: 'pending' })]) {
    const result = await evaluate(fixture.input);
    assert.equal(result.passed, false);
    assert.equal(fixture.checkpoint.calls.length, 2);
  }
});

test('delayed webhook refuses when the post-state snapshot differs from fresh observation', async () => {
  const evaluate = needExport(threeDs, 'runThreeDsCase');
  const fixture = delayedInvocation({ postReobservationMismatch: true });
  const result = await evaluate(fixture.input);
  assert.equal(result.passed, false);
  assert.equal(fixture.checkpoint.calls.length, 2);
});

test('webhook replay fails when the exact DB snapshot changes during the checkpoint', async () => {
  const evaluate = needExport(threeDs, 'runThreeDsCase');
  const capability = challengeCapabilities();
  const checkpoint = manualResendCapabilities();
  const replay = webhookReplayStates({ unchanged: false });
  const current = replay.initialSnapshot;
  const { input } = invocation('initial.webhook_replay', replay.provider, current, {
    readers: makeReaders({ provider: replay.provider, current, replayStates: replay.states }),
    challengeWitnessProvider: capability.provider, challengeVerifier: capability.verifier,
    resendCheckpointProvider: checkpoint.provider, resendCheckpointVerifier: checkpoint.verifier });
  const result = await evaluate(input);
  assert.equal(result.passed, false);
  assert.ok(result.failures.includes('webhook_replay_unverified'));
});

test('refresh, two tabs, and repeated challenge require exactly one session/settlement/grant effect', async () => {
  const evaluate = needExport(threeDs, 'runThreeDsCase');
  for (const caseId of ['initial.refresh', 'initial.two_tabs', 'initial.challenge.success.repeat']) {
    const capability = challengeCapabilities();
    const { input } = invocation(caseId, paidProviderState(), paidDatabaseSnapshot(), {
      challengeWitnessProvider: capability.provider, challengeVerifier: capability.verifier });
    const result = await evaluate(input);
    assert.equal(result.passed, true);
    assert.equal(result.singleEffectVerified, true);
    assert.equal(result.evidence.database.contextCount, 1);
    assert.equal(result.evidence.database.settlementCount, 1);
    assert.equal(result.evidence.database.grantCount, 1);
  }

  const capability = challengeCapabilities();
  const duplicateContexts = paidDatabaseSnapshot();
  duplicateContexts.contexts.push({ sessionId: 'cs_second_tab_task6', attemptId: 'attempt-task6', status: 'complete' });
  const duplicate = invocation('initial.two_tabs', paidProviderState(), duplicateContexts, {
    challengeWitnessProvider: capability.provider, challengeVerifier: capability.verifier });
  const result = await evaluate(duplicate.input);
  assert.equal(result.passed, false);
  assert.ok(result.failures.includes('single_effect_not_unique'));
});

test('a lease lost while a challenge witness is being verified cannot return a pass', async () => {
  const evaluate = needExport(threeDs, 'runThreeDsCase');
  const capability = challengeCapabilities();
  const { parts, input } = invocation('initial.challenge.success', paidProviderState(), paidDatabaseSnapshot(), {
    challengeWitnessProvider: capability.provider, challengeVerifier: capability.verifier });
  let checks = 0;
  parts.attempts.assertFence = async () => {
    checks += 1;
    if (checks === 3) throw new Error('lease_fence_lost');
    return { ...parts.owner };
  };
  await expectRefusal(evaluate(input), 'lease_fence_lost');
  assert.equal(checks, 3);
});

test('change and renewal 3DS cases without a frozen operation contract fail closed as unsupported', async () => {
  const evaluate = needExport(threeDs, 'runThreeDsCase');
  for (const caseId of ['change.upgrade.challenge', 'change.add_area.challenge', 'renewal.off_session.challenge']) {
    const { input } = invocation(caseId);
    await expectRefusal(evaluate(input), 'three_ds_scenario_unsupported');
    assert.equal(input.readers.calls.length, 0);
  }
});
