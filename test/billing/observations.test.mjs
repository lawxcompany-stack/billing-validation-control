import assert from 'node:assert/strict';
import { test } from 'node:test';
import { databaseSnapshot, importIfMissing, makeAttemptParts, makeReaders, needExport,
  paidDatabaseSnapshot, paidProviderState, paymentIdentity, startedAt } from './support.mjs';

const contracts = await importIfMissing(() => import('../../src/billing/contracts.mjs'));
const observations = await importIfMissing(() => import('../../src/billing/observations.mjs'));

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

test('duplicate deliveries remain one processed event and one settlement in the exact snapshot', async () => {
  const reconcile = needExport(await importIfMissing(() => import('../../src/billing/financial.mjs')),
    'reconcileFinancialCase');
  const parts = makeAttemptParts();
  const provider = (await import('./support.mjs')).paidProviderState({
    receipts: [
      { id: 'receipt_task6', eventId: 'evt_task6', eventType: 'invoice.paid', objectId: 'in_task6',
        accountId: 'acct_task6test123', livemode: false, apiVersion: '2026-01-01', receivedAt: '2026-09-23T09:10:01.000Z' },
      { id: 'receipt_task6_dup', eventId: 'evt_task6', eventType: 'invoice.paid', objectId: 'in_task6',
        accountId: 'acct_task6test123', livemode: false, apiVersion: '2026-01-01', receivedAt: '2026-09-23T09:10:03.000Z' },
    ],
  });
  const result = await reconcile({ context: needExport(contracts, 'createVerifiedContext')(parts),
    caseId: 'payment.approved', expectedOutcome: 'paid', expectedAccess: { contractId: 'contract_task6', areas: ['area_task6'] },
    identity: paymentIdentity, readers: makeReaders({ provider, current: paidDatabaseSnapshot() }), startedAt });
  assert.equal(result.passed, true);
  assert.equal(result.evidence.webhook.receiptCount, 2);
  assert.equal(result.evidence.database.settlementCount, 1);
});
