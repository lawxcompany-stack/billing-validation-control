import assert from 'node:assert/strict';
import { test } from 'node:test';
import { databaseSnapshot, environment, importIfMissing, makeAttemptParts, makeReaders, needExport,
  paidDatabaseSnapshot, paidProviderState, paymentIdentity, startedAt } from './support.mjs';

const contracts = await importIfMissing(() => import('../../src/billing/contracts.mjs'));
const observations = await importIfMissing(() => import('../../src/billing/observations.mjs'));
const supabaseRuntime = await importIfMissing(() => import('../../src/runtime/supabase.mjs'));
const stripeRuntime = await importIfMissing(() => import('../../src/runtime/stripe.mjs'));

test('observation rechecks only injected readers and strips provider secrets and browser fields', async () => {
  const create = needExport(contracts, 'createVerifiedContext');
  const observe = needExport(observations, 'observeFinancialEvidence');
  const parts = makeAttemptParts();
  const readers = makeReaders();
  const context = create(parts);
  const result = await observe({ context, caseId: 'payment.approved', identity: paymentIdentity, readers, startedAt });
  assert.equal(result.provider.intentStatus, 'succeeded');
  assert.equal(result.webhook.processed, true);
  assert.equal(JSON.stringify(result).includes('pi_secret_private'), false);
  assert.equal(JSON.stringify(result).includes('operatorCapability'), false);
  assert.equal(Object.hasOwn(result.provider, 'amountPaid'), false);
  assert.equal(Object.hasOwn(result.database, 'baseline'), false);
  assert.equal(Object.hasOwn(result.database, 'settlementDelta'), false);
  assert.equal(readers.calls.some((call) => /write|mutate|delete/i.test(call)), false);
  assert.equal(parts.calls.mutations.length, 0);
});

test('delayed webhook initial evidence must be the exact trusted observation object', async () => {
  const observe = needExport(observations, 'observeFinancialEvidence');
  const isTrusted = needExport(observations, 'isTrustedFinancialObservation');
  const evidence = await observe({ context: needExport(contracts, 'createVerifiedContext')(makeAttemptParts()),
    caseId: 'payment.approved', identity: paymentIdentity, readers: makeReaders(), startedAt });
  assert.equal(isTrusted(evidence), true);
  assert.equal(isTrusted(structuredClone(evidence)), false);
});

test('independent readers pin the validation branch, Stripe TEST account and webhook endpoint before dispatch; webhook evidence is read only after effect', async () => {
  const createReaders = needExport(observations, 'createIndependentBillingReaders');
  const createSupabaseReader = needExport(supabaseRuntime, 'createSupabaseBillingReader');
  const createStripeReader = needExport(stripeRuntime, 'createStripeBillingReader');
  const calls = [];
  let effectApplied = false;
  let webhookInbox = { attemptId: 'attempt-task4', caseId: 'payment.approved',
    branchId: environment.database.branchId, eventId: 'evt_task4', eventType: 'invoice.paid',
    objectId: 'in_task4', accountId: environment.stripe.accountId, livemode: false, status: 'processed',
    attempts: 1, receivedAt: new Date(Date.parse(startedAt) + 2_000).toISOString(),
    processedAt: new Date(Date.parse(startedAt) + 3_000).toISOString(),
    secret: 'do-not-return', cookie: 'do-not-return' };
  let eventCreated = Math.floor(Date.parse(startedAt) / 1000) + 1;
  let webhookReceipts = [{ id: 'receipt_task4', attemptId: 'attempt-task4', caseId: 'payment.approved',
    branchId: environment.database.branchId, eventId: 'evt_task4', eventType: 'invoice.paid',
    objectId: 'in_task4', accountId: environment.stripe.accountId, livemode: false, status: 'processed',
    receivedAt: new Date(Date.parse(startedAt) + 2_500).toISOString(), rawBody: 'private' }];
  const supabaseIdentity = { projectRef: environment.database.projectRef,
    branchId: environment.database.branchId, readOnly: true };
  const stripeIdentity = { accountId: environment.stripe.accountId, webhookEndpointId: 'we_task6endpoint',
    webhookUrl: `${environment.deployment.origin}/api/stripe/webhook`, livemode: false, readOnly: true };
  const supabaseReader = createSupabaseReader({ expectedEnvironment: environment, source: {
    identity: supabaseIdentity,
    async readIdentity() { calls.push('supabase.identity'); return supabaseIdentity; },
    async readBillingSnapshot() { return databaseSnapshot(); },
    async listAttemptFixtures() { return []; },
    async readSyntheticFixture() { return null; },
    async readWebhookInbox(query) {
      calls.push('supabase.inbox');
      assert.equal(effectApplied, true);
      assert.equal(query.eventId, 'evt_task4');
      return webhookInbox;
    },
    async readWebhookReceipts(query) {
      calls.push('supabase.receipts');
      assert.equal(effectApplied, true);
      assert.equal(query.eventId, 'evt_task4');
      return webhookReceipts;
    },
  } });
  const stripeReader = createStripeReader({ expectedEnvironment: environment,
    expectedWebhookEndpointId: 'we_task6endpoint', source: {
    identity: stripeIdentity,
    async readIdentity() { calls.push('stripe.identity'); return stripeIdentity; },
    async retrieve() { return null; },
    async retrieveWebhookEndpoint() { calls.push('stripe.endpoint'); return { id: 'we_task6endpoint',
      url: `${environment.deployment.origin}/api/stripe/webhook`, livemode: false,
      created: Math.floor(Date.parse(startedAt) / 1000) - 1, enabledEvents: ['invoice.paid'] }; },
    async listEvents(query) {
      calls.push('stripe.events');
      assert.equal(effectApplied, true);
      assert.equal(query.eventId, 'evt_task4');
      assert.equal(query.objectId, 'in_task4');
      return [{ id: 'evt_task4', eventType: 'invoice.paid', livemode: false,
        accountId: environment.stripe.accountId,
        created: eventCreated,
        objectId: 'in_task4', payload: 'private event body', client_secret: 'pi_secret_private' }];
    },
  } });
  const readers = createReaders({ expectedEnvironment: environment, expectedWebhookEndpointId: 'we_task6endpoint',
    supabase: supabaseReader, stripe: stripeReader });
  const request = { attemptId: 'attempt-task4', caseId: 'payment.approved', startedAt,
    action: 'checkout.replay', operation: 'task4-reader-gate' };
  await readers.assertReady(request);
  calls.push('provider.dispatch');
  effectApplied = true;
  assert.deepEqual(calls, ['supabase.identity', 'stripe.identity', 'stripe.endpoint', 'provider.dispatch']);
  const evidence = await readers.readWebhookEvidence({ attemptId: request.attemptId, caseId: request.caseId,
    startedAt, cutoffAt: new Date(Date.parse(startedAt) + 60_000).toISOString(),
    eventId: 'evt_task4', objectId: 'in_task4' });
  assert.deepEqual(calls.slice(4), ['supabase.identity', 'stripe.identity', 'stripe.endpoint',
    'stripe.events', 'stripe.endpoint', 'supabase.inbox', 'supabase.receipts']);
  assert.deepEqual(evidence, { eventId: 'evt_task4', accountId: environment.stripe.accountId,
    livemode: false, eventObserved: true, inboxStatus: 'processed', receiptCount: 1,
    receivedAt: webhookInbox.receivedAt, processedAt: webhookInbox.processedAt });
  assert.equal(JSON.stringify(evidence).includes('private'), false);
  assert.equal(JSON.stringify(evidence).includes('cookie'), false);

  const validInbox = structuredClone(webhookInbox);
  const validReceipts = structuredClone(webhookReceipts);
  const apply = (source, changes = {}) => {
    const result = { ...source };
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) delete result[key];
      else result[key] = value;
    }
    return result;
  };
  for (const invalid of [
    { inbox: { accountId: undefined } },
    { inbox: { accountId: 'acct_wrong' } },
    { inbox: { livemode: undefined } },
    { inbox: { livemode: true } },
    { inbox: { receivedAt: new Date(Date.parse(startedAt) - 1).toISOString() } },
    { inbox: { processedAt: new Date(Date.parse(startedAt) + 1_000).toISOString() } },
    { inbox: { processedAt: new Date(Date.parse(startedAt) + 61_000).toISOString() } },
    { receipt: { accountId: undefined } },
    { receipt: { livemode: true } },
    { receipt: { receivedAt: new Date(Date.parse(startedAt) + 61_000).toISOString() } },
  ]) {
    webhookInbox = apply(validInbox, invalid.inbox);
    webhookReceipts = invalid.receipt
      ? [apply(validReceipts[0], invalid.receipt)]
      : validReceipts;
    await assert.rejects(readers.readWebhookEvidence({ attemptId: request.attemptId,
      caseId: request.caseId, startedAt,
      cutoffAt: new Date(Date.parse(startedAt) + 60_000).toISOString(),
      eventId: 'evt_task4', objectId: 'in_task4' }), { code: 'observation_evidence_invalid' });
  }

  webhookInbox = validInbox;
  webhookReceipts = validReceipts;
  eventCreated = Math.floor(Date.parse(startedAt) / 1000);
  await assert.rejects(readers.readWebhookEvidence({ attemptId: request.attemptId, caseId: request.caseId,
    startedAt: new Date(Date.parse(startedAt) + 999).toISOString(),
    cutoffAt: new Date(Date.parse(startedAt) + 60_000).toISOString(),
    eventId: 'evt_task4', objectId: 'in_task4' }), { code: 'observation_evidence_invalid' },
  'Stripe second-precision event timestamp just before a fractional start must not be rounded into the run window');
});

test('missing or mismatched readonly identities refuse readiness before provider dispatch', async () => {
  const createReaders = needExport(observations, 'createIndependentBillingReaders');
  const createSupabaseReader = needExport(supabaseRuntime, 'createSupabaseBillingReader');
  const createStripeReader = needExport(stripeRuntime, 'createStripeBillingReader');
  const validSupabase = { projectRef: environment.database.projectRef,
    branchId: environment.database.branchId, readOnly: true };
  const validStripe = { accountId: environment.stripe.accountId, webhookEndpointId: 'we_task6endpoint',
    webhookUrl: `${environment.deployment.origin}/api/stripe/webhook`, livemode: false, readOnly: true };
  for (const mismatch of [
    { provider: 'supabase', identity: { ...validSupabase, branchId: 'wrong-validation-branch' } },
    { provider: 'stripe', identity: { ...validStripe, accountId: 'acct_wrong' } },
    { provider: 'stripe', identity: { ...validStripe, webhookEndpointId: 'we_wrong' } },
    { provider: 'stripe', identity: { ...validStripe, livemode: true } },
  ]) {
    let dispatches = 0;
    const supabaseReader = createSupabaseReader({ expectedEnvironment: environment,
      source: { identity: validSupabase, async readIdentity() {
        return mismatch.provider === 'supabase' ? mismatch.identity : validSupabase;
      }, async readBillingSnapshot() { return databaseSnapshot(); }, async listAttemptFixtures() { return []; },
      async readSyntheticFixture() { return null; }, async readWebhookInbox() { return null; },
      async readWebhookReceipts() { return []; } } });
    const stripeReader = createStripeReader({ expectedEnvironment: environment,
      expectedWebhookEndpointId: 'we_task6endpoint',
      source: { identity: validStripe, async readIdentity() {
        return mismatch.provider === 'stripe' ? mismatch.identity : validStripe;
      }, async retrieve() { return null; }, async listEvents() { return []; },
      async retrieveWebhookEndpoint() { return { id: validStripe.webhookEndpointId,
        url: validStripe.webhookUrl, livemode: false, created: 1, enabledEvents: [] }; } } });
    const readers = createReaders({ expectedEnvironment: environment, expectedWebhookEndpointId: 'we_task6endpoint',
      supabase: supabaseReader, stripe: stripeReader });
    const dispatchAfterReadiness = async () => {
      await readers.assertReady({ attemptId: 'attempt-task4', caseId: 'payment.approved', startedAt });
      dispatches += 1;
    };
    await assert.rejects(dispatchAfterReadiness());
    assert.equal(dispatches, 0);
  }
});

test('Stripe readonly reader projects only billing fields and never returns raw secrets or event payloads', async () => {
  const createStripeReader = needExport(stripeRuntime, 'createStripeBillingReader');
  const identity = { accountId: environment.stripe.accountId, webhookEndpointId: 'we_task4safe',
    webhookUrl: `${environment.deployment.origin}/api/stripe/webhook`, livemode: false, readOnly: true };
  let wrongEventAccount = false;
  const reader = createStripeReader({ expectedEnvironment: environment,
    expectedWebhookEndpointId: identity.webhookEndpointId, source: {
      identity,
      async readIdentity() { return identity; },
      async retrieve(type) {
        if (type === 'payment_intent') return { id: 'pi_task4safe', livemode: false,
          customer: 'cus_task4safe', latest_charge: 'ch_task4safe', amount_received: 2500,
          currency: 'brl', status: 'succeeded',
          last_payment_error: { code: 'declined', decline_code: 'generic_decline', message: 'private' },
          client_secret: 'pi_secret_do_not_return', metadata: { operator: 'private' } };
        assert.equal(type, 'charge');
        return { id: 'ch_task4safe', livemode: false, customer: 'cus_task4safe',
          payment_intent: 'pi_task4safe', currency: 'brl', paid: true, amount_captured: 2500,
          payment_method_details: { card: { three_d_secure: { authentication_flow: null,
            result: 'authenticated', result_reason: null, transaction_id: 'private' } } },
          metadata: { operator: 'private' } };
      },
      async listEvents() {
        return [{ id: 'evt_task4safe', type: 'invoice.paid', livemode: false, created: 100,
          pending_webhooks: 0, api_version: '2025-01-01',
          account: wrongEventAccount ? 'acct_unexpected' : environment.stripe.accountId,
          data: { object: { id: 'in_task4safe', customer: 'cus_task4safe', client_secret: 'private',
            metadata: { session: 'private' } } }, payload: 'private event body' }];
      },
      async retrieveWebhookEndpoint() { return { id: identity.webhookEndpointId, url: identity.webhookUrl,
        livemode: false, created: 1, enabledEvents: ['invoice.paid'] }; },
    } });

  const intent = await reader.retrieve('payment_intent', 'pi_task4safe');
  assert.deepEqual(intent, { id: 'pi_task4safe', livemode: false, customer: 'cus_task4safe',
    latest_charge: 'ch_task4safe', amount_received: 2500, currency: 'brl', status: 'succeeded',
    last_payment_error: { code: 'declined', decline_code: 'generic_decline' } });
  const charge = await reader.retrieve('charge', 'ch_task4safe');
  assert.deepEqual(charge, { id: 'ch_task4safe', livemode: false, customer: 'cus_task4safe',
    payment_intent: 'pi_task4safe', currency: 'brl', paid: true, amount_captured: 2500,
    payment_method_details: { card: { three_d_secure: {
      authentication_flow: null, result: 'authenticated', result_reason: null,
    } } } });
  await assert.rejects(reader.retrieve('payment_intent', 'pi_task4other'),
    { code: 'stripe_reader_response_invalid' });
  await assert.rejects(reader.retrieve('payment_intent', 'pi_task4safe', { apiKey: 'private' }),
    { code: 'stripe_reader_input_invalid' });
  const events = await reader.listEvents({ eventId: 'evt_task4safe' });
  assert.deepEqual(events, [{ id: 'evt_task4safe', eventType: 'invoice.paid', livemode: false, created: 100,
    objectId: 'in_task4safe', pendingWebhooks: 0, apiVersion: '2025-01-01',
    accountId: environment.stripe.accountId, customerId: 'cus_task4safe' }]);
  assert.equal(JSON.stringify({ intent, charge, events }).includes('private'), false);
  assert.equal(JSON.stringify({ intent, charge, events }).includes('secret'), false);
  wrongEventAccount = true;
  await assert.rejects(reader.listEvents({ eventId: 'evt_task4safe' }),
    { code: 'stripe_reader_response_invalid' });
});

test('Supabase fixture and webhook readers enforce the exact branch and attempt binding', async () => {
  const createSupabaseReader = needExport(supabaseRuntime, 'createSupabaseBillingReader');
  const identity = { projectRef: environment.database.projectRef,
    branchId: environment.database.branchId, readOnly: true };
  let fixtureReads = 0;
  let webhookReads = 0;
  const reader = createSupabaseReader({ expectedEnvironment: environment, source: {
    async readIdentity() { return identity; },
    async readBillingSnapshot() { return databaseSnapshot(); },
    async listAttemptFixtures() {
      fixtureReads += 1;
      return [{ fixtureId: '96b09fd4-2d1a-4a59-8e90-2f17e3113e1d',
        namespaceId: '1189f183-f7e4-4d08-b16d-c7aeaa82d71f', attemptId: 'attempt-other',
        caseId: 'payment.approved', kind: 'catalog',
        marker: 'lawx-billing-validation-synthetic-v1', synthetic: true }];
    },
    async readSyntheticFixture() { return null; },
    async readWebhookInbox() { webhookReads += 1; return null; },
    async readWebhookReceipts() { webhookReads += 1; return []; },
  } });

  await assert.rejects(reader.listAttemptFixtures({ attemptId: 'attempt-task4', caseId: 'payment.approved',
    namespaceId: '1189f183-f7e4-4d08-b16d-c7aeaa82d71f', environment }),
  { code: 'supabase_fixture_response_invalid' });
  await assert.rejects(reader.readWebhookInbox('evt_task4'), { code: 'supabase_reader_input_invalid' });
  await assert.rejects(reader.readWebhookInbox({ attemptId: 'attempt-task4', caseId: 'payment.approved',
    branchId: 'branch_wrong', eventId: 'evt_task4', objectId: 'in_task4' }),
  { code: 'supabase_reader_input_invalid' });
  assert.equal(fixtureReads, 1);
  assert.equal(webhookReads, 0);
});

test('invoice retrieval requests expansion for payments.data.payment.payment_intent', async () => {
  const observe = needExport(observations, 'observeFinancialEvidence');
  const readers = makeReaders();
  const retrieve = readers.stripe.retrieve.bind(readers.stripe);
  let params;
  readers.stripe.retrieve = async (type, id, requestParams) => {
    if (type === 'invoice') params = requestParams;
    return retrieve(type, id, requestParams);
  };
  await observe({ context: needExport(contracts, 'createVerifiedContext')(makeAttemptParts()),
    caseId: 'payment.approved', identity: paymentIdentity, readers, startedAt });
  assert.deepEqual(params, { expand: ['payments.data.payment.payment_intent'] });
});

test('invoice payment intent identity rejects missing, mismatched, multiple, and partial-page relationships', async () => {
  const observe = needExport(observations, 'observeFinancialEvidence');
  const invalidInvoices = [
    { payments: { data: [], has_more: false }, payment_intent: null },
    { payments: { data: [{ payment: { payment_intent: 'pi_other' } }], has_more: false } },
    { payments: { data: [
      { payment: { payment_intent: 'pi_task6' } },
      { payment: { payment_intent: 'pi_other' } },
    ], has_more: false } },
    { payments: { data: [{ payment: { payment_intent: 'pi_task6' } }], has_more: true } },
    { payments: { data: [{ payment: { payment_intent: 'pi_task6' } }] } },
    { payments: null, payment_intent: 'pi_task6' },
    { payments: { data: [], has_more: false }, payment_intent: 'pi_task6' },
  ];
  for (const invoice of invalidInvoices) {
    const readers = makeReaders({ provider: paidProviderState({ invoice }) });
    await assert.rejects(observe({ context: needExport(contracts, 'createVerifiedContext')(makeAttemptParts()),
      caseId: 'payment.approved', identity: paymentIdentity, readers, startedAt }),
    { code: 'payment_lineage_invalid' });
  }
});

test('legacy invoice payment_intent is an accepted exact-match fallback', async () => {
  const observe = needExport(observations, 'observeFinancialEvidence');
  const readers = makeReaders({ provider: paidProviderState({ invoice: {
    payments: undefined, payment_intent: 'pi_task6',
  } }) });
  const result = await observe({ context: needExport(contracts, 'createVerifiedContext')(makeAttemptParts()),
    caseId: 'payment.approved', identity: paymentIdentity, readers, startedAt });
  assert.equal(result.provider.stripePaid, true);
});

test('reader failures become finite refusals without leaking provider error messages', async () => {
  const observe = needExport(observations, 'observeFinancialEvidence');
  const privateMarker = 'sk_test_sensitive_reader_material';
  for (const boundary of ['supabase', 'stripe']) {
    const readers = makeReaders();
    if (boundary === 'supabase') {
      readers.supabase.readBillingSnapshot = async () => { throw new Error(`reader failed: ${privateMarker}`); };
    } else {
      readers.stripe.retrieve = async (type) => {
        if (type === 'invoice') throw new Error(`provider failed: ${privateMarker}`);
        return null;
      };
    }
    await assert.rejects(observe({ context: needExport(contracts, 'createVerifiedContext')(makeAttemptParts()),
      caseId: 'payment.approved', identity: paymentIdentity, readers, startedAt }), (error) => {
      assert.equal(error.code, 'observation_read_failed');
      assert.equal(error.message, 'observation_read_failed');
      assert.equal(error.cause, undefined);
      assert.equal(`${error}\n${error.stack}`.includes(privateMarker), false);
      return true;
    });
  }
});

test('webhook evidence timestamps after the authoritative database cutoff are rejected', async () => {
  const observe = needExport(observations, 'observeFinancialEvidence');
  const cutoff = '2026-09-23T09:20:00.000Z';
  const future = '2026-09-23T09:20:00.001Z';
  const cases = [
    ['receipt receivedAt', (provider) => { provider.receipts[0].receivedAt = future; }],
    ['inbox receivedAt', (provider) => {
      provider.inbox.receivedAt = future;
      provider.inbox.processedAt = '2026-09-23T09:20:00.002Z';
    }],
    ['inbox processedAt', (provider) => { provider.inbox.processedAt = future; }],
    ['event created', (provider) => { provider.event.created = Math.floor(Date.parse(future) / 1000) + 1; }],
  ];
  for (const [, mutateProvider] of cases) {
    const provider = paidProviderState();
    mutateProvider(provider);
    const result = await observe({ context: needExport(contracts, 'createVerifiedContext')(makeAttemptParts()),
      caseId: 'payment.approved', identity: paymentIdentity,
      readers: makeReaders({ provider, current: databaseSnapshot({ paymentSettled: true, observedAt: cutoff }) }), startedAt });
    assert.equal(result.webhook.processed, false);
  }
});

test('pending_webhooks zero without a matching receipt and processed inbox is not delivery proof', async () => {
  const observe = needExport(observations, 'observeFinancialEvidence');
  const parts = makeAttemptParts();
  const provider = { ...((await import('./support.mjs')).paidProviderState()), receipts: [],
    inbox: { ...((await import('./support.mjs')).paidProviderState()).inbox, status: 'pending', processedAt: null } };
  const result = await observe({ context: needExport(contracts, 'createVerifiedContext')(parts),
    caseId: 'payment.approved', identity: paymentIdentity, readers: makeReaders({ provider }), startedAt });
  assert.equal(result.webhook.pendingWebhooks, 0);
  assert.equal(result.webhook.processed, false);
  assert.equal(result.webhook.receiptCount, 0);
});

test('processed webhook evidence requires the exact Task4 verified endpoint identity and URL', async () => {
  const observe = needExport(observations, 'observeFinancialEvidence');
  for (const endpoint of [
    { ...((await import('./support.mjs')).paidProviderState()).endpoint, id: 'we_other_endpoint' },
    { ...((await import('./support.mjs')).paidProviderState()).endpoint, url: 'https://other.example/webhook' },
  ]) {
    const provider = (await import('./support.mjs')).paidProviderState({ endpoint });
    const result = await observe({ context: needExport(contracts, 'createVerifiedContext')(makeAttemptParts()),
      caseId: 'payment.approved', identity: paymentIdentity, readers: makeReaders({ provider }), startedAt });
    assert.equal(result.webhook.processed, false);
    assert.equal(result.webhook.endpointWindowVerified, false);
  }
});

test('exact Supabase reconciliation detects a usage-only mutation', async () => {
  const observe = needExport(observations, 'observeFinancialEvidence');
  const parts = makeAttemptParts();
  const readers = makeReaders({ baseline: databaseSnapshot(), current: databaseSnapshot({ changedUsage: true }) });
  const result = await observe({ context: needExport(contracts, 'createVerifiedContext')(parts),
    caseId: 'payment.declined', identity: paymentIdentity, readers, startedAt });
  assert.equal(result.database.unchanged, false);
  assert.notEqual(result.database.baselineDigest, result.database.currentDigest);
});

test('observations fence the Task 5 attempt before reads and again after all reads', async () => {
  const observe = needExport(observations, 'observeFinancialEvidence');
  for (const staleAt of [1, 2]) {
    const parts = makeAttemptParts();
    const readers = makeReaders();
    let checks = 0;
    parts.attempts.assertFence = async () => {
      checks += 1;
      if (checks === staleAt) throw new Error('lease_fence_lost');
      return { ...parts.owner };
    };
    await assert.rejects(observe({ context: needExport(contracts, 'createVerifiedContext')(parts),
      caseId: 'payment.approved', identity: paymentIdentity, readers, startedAt }),
    { code: 'lease_fence_lost' });
    assert.equal(checks, staleAt);
    assert.equal(readers.calls.length > 0, staleAt === 2);
  }
});

test('read-only observation counts duplicate deliveries without asserting Task 5 scenario acceptance', async () => {
  const observe = needExport(observations, 'observeFinancialEvidence');
  const parts = makeAttemptParts();
  const provider = (await import('./support.mjs')).paidProviderState({
    receipts: [
      { id: 'receipt_task6', eventId: 'evt_task6', eventType: 'invoice.paid', objectId: 'in_task6',
        accountId: 'acct_task6test123', livemode: false, apiVersion: '2026-01-01', receivedAt: '2026-09-23T09:10:01.000Z' },
      { id: 'receipt_task6_dup', eventId: 'evt_task6', eventType: 'invoice.paid', objectId: 'in_task6',
        accountId: 'acct_task6test123', livemode: false, apiVersion: '2026-01-01', receivedAt: '2026-09-23T09:10:03.000Z' },
    ],
  });
  const result = await observe({ context: needExport(contracts, 'createVerifiedContext')(parts),
    caseId: 'payment.approved', identity: paymentIdentity,
    readers: makeReaders({ provider, current: paidDatabaseSnapshot() }), startedAt });
  assert.equal(result.webhook.receiptCount, 2);
  assert.equal(result.database.settlementCount, 1);
  assert.equal('passed' in result, false);
});
