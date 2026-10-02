import assert from 'node:assert/strict';
import { test } from 'node:test';
import { providerIdempotencyKey } from '../../src/attempts/prepare.mjs';
import { databaseSnapshot, environment, importIfMissing, makeAttemptParts, needExport, expectRefusal } from './support.mjs';

const contracts = await importIfMissing(() => import('../../src/billing/contracts.mjs'));
const cleanupModule = await importIfMissing(() => import('../../src/billing/cleanup.mjs'));

function retainedDatabaseRows() {
  return [
    { kind: 'checkout_attempt', id: 'attempt-task6', ownerAttemptId: 'attempt-task6' },
    { kind: 'payment_context', id: 'cs_task6', ownerAttemptId: 'attempt-task6' },
    { kind: 'contract', id: 'contract_task6', ownerAttemptId: 'attempt-task6' },
    { kind: 'settlement_effect', id: 'set_task6', ownerAttemptId: 'attempt-task6' },
    { kind: 'area_grant', id: 'grant_task6', ownerAttemptId: 'attempt-task6' },
    { kind: 'contract_revision', id: 'revision_task6', ownerAttemptId: 'attempt-task6' },
    { kind: 'usage_period', id: 'usage_period_task6', ownerAttemptId: 'attempt-task6' },
    { kind: 'usage_event', id: 'usage_event_task6', ownerAttemptId: 'attempt-task6' },
    { kind: 'auth_user', id: 'user_task6', ownerAttemptId: 'attempt-task6' },
  ];
}

const retainedDatabaseTargets = Object.freeze({
  checkout_attempt: ['public', 'billing_checkout_attempts'], payment_context: ['public', 'billing_payment_contexts'],
  contract: ['public', 'billing_contracts'], settlement_effect: ['public', 'billing_settlement_effects'],
  area_grant: ['public', 'billing_area_grants'], contract_revision: ['public', 'billing_contract_revisions'],
  usage_period: ['public', 'billing_usage_periods'], usage_event: ['public', 'billing_usage_events'],
  auth_user: ['auth', 'users'],
});

function baselineSnapshot() {
  const snapshot = databaseSnapshot();
  snapshot.attempts = [{ id: 'attempt_prior', quoteId: 'quote_prior', status: 'complete' }];
  snapshot.contexts = [{ sessionId: 'cs_prior', attemptId: 'attempt_prior', status: 'complete' }];
  snapshot.contracts = [{ id: 'contract_prior', status: 'active' }];
  snapshot.settlements = [];
  snapshot.grants = [];
  snapshot.revisions = [];
  snapshot.usage = [];
  return snapshot;
}

function ownedPaidSnapshot({ changedUsage = false } = {}) {
  const snapshot = databaseSnapshot({ paymentSettled: true });
  const baseline = baselineSnapshot();
  snapshot.attempts.push(...baseline.attempts);
  snapshot.contexts.push(...baseline.contexts);
  snapshot.contracts.push(...baseline.contracts);
  snapshot.usage = [
    { id: 'usage_period_task6', contractId: 'contract_task6', includedUnits: 10, consumedUnits: 0, reservedUnits: 0 },
    { id: 'usage_event_task6', contractId: 'contract_task6', includedUnits: changedUsage ? 11 : 10,
      consumedUnits: 0, reservedUnits: 0 },
  ];
  return snapshot;
}

function cleanupFixture({ failDelete = false, failDatabaseCleanup = false, failObservation = false,
  failReceipt = false, leaveResource = false, changeDatabase = false, unowned = false,
  databaseRows = [], databaseCurrent } = {}) {
  const resources = [
    { id: 'cus_task6', type: 'customer', status: 'active', ownerAttemptId: 'attempt-task6', accountId: 'acct_task6test123', livemode: false, sequence: 1 },
    { id: 'cs_task6', type: 'checkout_session', status: 'open', ownerAttemptId: 'attempt-task6', accountId: 'acct_task6test123', livemode: false, sequence: 2 },
    { id: 'sub_task6', type: 'subscription', status: 'active', ownerAttemptId: 'attempt-task6', accountId: 'acct_task6test123', livemode: false, sequence: 3 },
    { id: 'pi_task6', type: 'payment_intent', status: 'requires_payment_method', ownerAttemptId: 'attempt-task6', accountId: 'acct_task6test123', livemode: false, sequence: 4 },
    { id: 'in_task6', type: 'invoice', status: 'open', ownerAttemptId: 'attempt-task6', accountId: 'acct_task6test123', livemode: false, sequence: 5 },
    { id: 'ch_task6', type: 'charge', status: 'succeeded', ownerAttemptId: 'attempt-task6', accountId: 'acct_task6test123', livemode: false, sequence: 6 },
  ];
  const dbRows = databaseRows;
  let databaseCurrentReads = 0;
  const parts = makeAttemptParts({ resourceIds: resources.map(({ id }) => id),
    databaseResourceIds: dbRows, failReceipt });
  const actions = [];
  const observedIntents = [];
  const adapter = {
    async listOwnedResources() { return resources.filter((resource) => resource.type !== 'customer' || resource.status !== 'deleted')
      .map((resource) => ({ ...resource, ...(unowned && resource.id === 'pi_task6' ? { ownerAttemptId: 'another-attempt' } : {}) })); },
    async readDatabaseBaseline() { return baselineSnapshot(); },
    async readDatabaseCurrent() {
      databaseCurrentReads += 1;
      const snapshot = structuredClone(databaseCurrent ?? baselineSnapshot());
      if (changeDatabase && databaseCurrentReads > 1) snapshot.contracts[0].status = 'suspended';
      return snapshot;
    },
    async mutate(request) {
      actions.push(request);
      if (request.provider === 'supabase') {
        if (failDatabaseCleanup) throw new Error('database cleanup callback failed');
        assert.deepEqual(request.input.databaseResources, []);
        return;
      }
      if (failDelete) throw new Error('provider cleanup failed');
      const resource = resources.find((item) => item.id === request.input.resourceId);
      if (leaveResource && resource?.id === 'cs_task6') return;
      if (request.action === 'customer.delete') resource.status = 'deleted';
      if (request.action === 'checkout_session.expire') resource.status = 'expired';
      if (request.action === 'subscription.cancel') resource.status = 'canceled';
      return { id: 'cs_mutation_response_not_proof', status: 'expired' };
    },
    async readStripeIntentObservation({ intent, resource, expectedStatus }) {
      observedIntents.push(intent.intentId);
      if (failObservation) throw new Error('independent Stripe read unavailable');
      const independentlyRead = resources.find(({ id }) => id === resource.id);
      if (!independentlyRead || independentlyRead.status !== expectedStatus) {
        throw new Error('independent Stripe state mismatch');
      }
      return { accountId: environment.stripe.accountId, livemode: false,
        operation: intent.operation, requestDigest: intent.requestDigest,
        idempotencyKey: intent.idempotencyKey, resourceIds: [independentlyRead.id] };
    },
    async mutateInTransaction(request, transaction) {
      if (transaction?.attemptId !== parts.owner.attemptId ||
          transaction?.fence !== parts.owner.fence) {
        throw new Error('fixture transaction owner mismatch');
      }
      return this.mutate(request);
    },
    async listOwnedDatabaseResources() { return structuredClone(dbRows); },
  };
  parts.mutationAdapter = adapter;
  const context = needExport(contracts, 'createVerifiedContext')(parts);
  return { context, parts, adapter, actions, dbRows, observedIntents };
}

test('cleanup expires and cancels owned resources in reverse order, retains charges, and verifies DB baseline before releasing lease', async () => {
  const cleanup = needExport(cleanupModule, 'cleanupOwnedResources');
  const fixture = cleanupFixture();
  const result = await cleanup({ context: fixture.context, adapter: fixture.adapter });
  assert.deepEqual(fixture.actions.map(({ action }) => action), [
    'subscription.cancel', 'checkout_session.expire', 'fixtures.cleanup',
  ]);
  assert.deepEqual(result.retainedObjects, [
    { id: 'ch_task6', type: 'charge', status: 'retained_test_financial_object' },
    { id: 'cs_task6', type: 'checkout_session', status: 'expired_test_checkout_session' },
    { id: 'in_task6', type: 'invoice', status: 'retained_test_financial_object' },
    { id: 'pi_task6', type: 'payment_intent', status: 'retained_test_financial_object' },
    { id: 'sub_task6', type: 'subscription', status: 'retained_test_subscription' },
    { id: 'cus_task6', type: 'customer', status: 'retained_test_customer' },
  ].sort((a, b) => a.id.localeCompare(b.id)));
  assert.deepEqual(result.retainedDatabaseResources, []);
  assert.equal(result.removedDatabaseFixtureCount, 0);
  assert.equal(result.databaseBaselineRestored, false);
  assert.equal(result.fixtureReusable, false);
  assert.equal(result.cleanupClaim, 'owned_reversible_provider_fixtures_only');
  assert.deepEqual(result.mutatedResourceIds, ['sub_task6', 'cs_task6']);
  assert.equal(Object.hasOwn(result, 'deletedResourceIds'), false);
  assert.equal(fixture.actions.every((request) => request.attemptId === fixture.context.owner.attemptId &&
    request.fence === fixture.context.owner.fence &&
    request.environment.database.projectRef === environment.database.projectRef), true);
  assert.equal(result.completed, true);
  assert.equal(fixture.parts.calls.cleanup.length, 1);
  assert.equal(result.cleanupDigest, 'f'.repeat(64));
  assert.deepEqual(fixture.parts.calls.cleanup[0].projection, {
    cleanupClaim: result.cleanupClaim,
    databaseBaselineDigest: result.databaseBaselineDigest,
    mutatedResourceIds: result.mutatedResourceIds,
    retainedDatabaseResources: result.retainedDatabaseResources,
    retainedObjects: result.retainedObjects,
    removedDatabaseFixtureCount: result.removedDatabaseFixtureCount,
  });
  assert.equal(fixture.observedIntents.length, 2);
  assert.equal(fixture.parts.receipts.size, 2);
  assert.equal(fixture.parts.calls.reconciliations.length, 2);
  assert.equal(JSON.stringify(result).includes('client_secret'), false);
});

test('matching before and after snapshots still deny restoration and fixture reuse claims', async () => {
  const cleanup = needExport(cleanupModule, 'cleanupOwnedResources');
  const fixture = cleanupFixture();
  const result = await cleanup({ context: fixture.context, adapter: fixture.adapter });

  assert.deepEqual({ databaseBaselineRestored: result.databaseBaselineRestored,
    fixtureReusable: result.fixtureReusable }, {
    databaseBaselineRestored: false, fixtureReusable: false,
  });
});

test('customer is explicitly retained and never passed to a Stripe mutation', async () => {
  const cleanup = needExport(cleanupModule, 'cleanupOwnedResources');
  const fixture = cleanupFixture();
  const result = await cleanup({ context: fixture.context, adapter: fixture.adapter });
  assert.equal(fixture.actions.some(({ action }) => action === 'customer.delete'), false);
  assert.deepEqual(result.retainedObjects.find(({ type }) => type === 'customer'),
    { id: 'cus_task6', type: 'customer', status: 'retained_test_customer' });
});

test('provider cleanup failure refuses success and retains the Task 5 lease', async () => {
  const cleanup = needExport(cleanupModule, 'cleanupOwnedResources');
  const fixture = cleanupFixture({ failDelete: true });
  await expectRefusal(cleanup({ context: fixture.context, adapter: fixture.adapter }), 'cleanup_mutation_failed');
  assert.equal(fixture.parts.calls.cleanup.length, 0);
});

test('failed independent Stripe read after a successful mutation leaves its intent unresolved and lease held', async () => {
  const cleanup = needExport(cleanupModule, 'cleanupOwnedResources');
  const fixture = cleanupFixture({ failObservation: true });
  await expectRefusal(cleanup({ context: fixture.context, adapter: fixture.adapter }),
    'cleanup_reconciliation_failed');
  assert.equal(fixture.actions.filter(({ action }) =>
    ['checkout_session.expire', 'subscription.cancel'].includes(action)).length, 1);
  assert.equal(fixture.actions.some(({ provider }) => provider === 'supabase'), false);
  assert.equal(fixture.parts.calls.reconciliations.length, 0);
  assert.equal((await fixture.parts.attempts.listPendingStripeIntents({
    attemptId: fixture.context.owner.attemptId, fence: fixture.context.owner.fence,
  })).length, 1);
  assert.equal(fixture.parts.calls.cleanup.length, 0);
});

test('failed durable Stripe receipt after a successful mutation retains the lease and reservation', async () => {
  const cleanup = needExport(cleanupModule, 'cleanupOwnedResources');
  const fixture = cleanupFixture({ failReceipt: true });
  await expectRefusal(cleanup({ context: fixture.context, adapter: fixture.adapter }),
    'cleanup_reconciliation_failed');
  assert.equal(fixture.observedIntents.length, 1);
  assert.equal(fixture.parts.receipts.size, 0);
  assert.equal((await fixture.parts.attempts.listPendingStripeIntents({
    attemptId: fixture.context.owner.attemptId, fence: fixture.context.owner.fence,
  })).length, 1);
  assert.equal(fixture.parts.calls.cleanup.length, 0);
});

test('cleanup refuses before dispatch when no independent Stripe observation reader is configured', async () => {
  const cleanup = needExport(cleanupModule, 'cleanupOwnedResources');
  const fixture = cleanupFixture();
  delete fixture.adapter.readStripeIntentObservation;

  await expectRefusal(cleanup({ context: fixture.context, adapter: fixture.adapter }),
    'cleanup_reconciliation_unavailable');
  assert.equal(fixture.actions.length, 0);
  assert.equal(fixture.parts.calls.intentBegins.length, 0);
  assert.equal(fixture.parts.calls.cleanup.length, 0);
});

test('cleanup refuses pre-existing unresolved Stripe intents before issuing any mutation', async () => {
  const cleanup = needExport(cleanupModule, 'cleanupOwnedResources');
  const fixture = cleanupFixture();
  const owner = fixture.context.owner;
  const operation = 'checkout:create:orphaned-before-cleanup';
  await fixture.parts.attempts.beginStripeIntent({ attemptId: owner.attemptId, fence: owner.fence,
    candidateSha: owner.candidateSha, workflow: owner.workflow, environment: owner.environment,
    action: 'checkout.replay', operation, requestDigest: 'c'.repeat(64),
    idempotencyKey: providerIdempotencyKey(owner.attemptId, 'stripe', operation) });

  await expectRefusal(cleanup({ context: fixture.context, adapter: fixture.adapter }),
    'stripe_intent_unresolved');
  assert.equal(fixture.actions.length, 0);
  assert.equal(fixture.parts.calls.cleanup.length, 0);
});

test('fenced Supabase cleanup callback failure refuses success and retains the Task 5 lease', async () => {
  const cleanup = needExport(cleanupModule, 'cleanupOwnedResources');
  const fixture = cleanupFixture({ failDatabaseCleanup: true });
  await expectRefusal(cleanup({ context: fixture.context, adapter: fixture.adapter }), 'cleanup_mutation_failed');
  assert.equal(fixture.actions.at(-1).provider, 'supabase');
  assert.deepEqual(fixture.actions.at(-1).input.databaseResources, []);
  assert.equal(fixture.parts.calls.cleanup.length, 0);
});

test('owned active contract or grant refuses cleanup and leaves the Task5 lease held', async () => {
  const cleanup = needExport(cleanupModule, 'cleanupOwnedResources');
  const fixture = cleanupFixture({ databaseRows: retainedDatabaseRows(), databaseCurrent: ownedPaidSnapshot() });
  await assert.rejects(cleanup({ context: fixture.context, adapter: fixture.adapter }), (error) => {
    assert.equal(error.code, 'cleanup_database_active_access_retained');
    assert.equal(error.fixtureReusable, false);
    assert.equal(error.databaseBaselineRestored, false);
    assert.deepEqual(error.retainedDatabaseResources.map(({ id, kind }) => ({ id, kind })),
      retainedDatabaseRows().map(({ id, kind }) => ({ id, kind })).sort((a, b) => a.kind.localeCompare(b.kind)));
    return true;
  });
  assert.equal(fixture.actions.length, 0);
  assert.equal(fixture.parts.calls.cleanup.length, 0);
});

test('retained immutable DB evidence refuses cleanup even without active access until reset/isolation exists', async () => {
  const cleanup = needExport(cleanupModule, 'cleanupOwnedResources');
  const inactiveSnapshot = ownedPaidSnapshot();
  inactiveSnapshot.contracts[0].status = 'canceled';
  inactiveSnapshot.grants[0].status = 'revoked';
  const fixture = cleanupFixture({ databaseRows: retainedDatabaseRows(), databaseCurrent: inactiveSnapshot });
  await expectRefusal(cleanup({ context: fixture.context, adapter: fixture.adapter }), 'cleanup_database_retained_not_reusable');
  assert.equal(fixture.actions.length, 0);
  assert.equal(fixture.parts.calls.cleanup.length, 0);
});

test('cleanup refuses unexpected or changed owned database evidence and retains the Task 5 lease', async () => {
  const cleanup = needExport(cleanupModule, 'cleanupOwnedResources');
  const fixture = cleanupFixture({ changeDatabase: true });
  await expectRefusal(cleanup({ context: fixture.context, adapter: fixture.adapter }), 'cleanup_database_changed');
  assert.equal(fixture.actions.some(({ provider, input }) => provider === 'supabase' &&
    JSON.stringify(input.databaseResources) === '[]'), true);
  assert.equal(fixture.parts.calls.cleanup.length, 0);
});

test('cleanup refuses database effects omitted from the owned retention catalog before provider mutations', async () => {
  const cleanup = needExport(cleanupModule, 'cleanupOwnedResources');
  const fixture = cleanupFixture({ databaseRows: retainedDatabaseRows().filter(({ kind }) => kind !== 'usage_event'),
    databaseCurrent: ownedPaidSnapshot() });
  await expectRefusal(cleanup({ context: fixture.context, adapter: fixture.adapter }), 'cleanup_database_unowned_delta');
  assert.equal(fixture.actions.length, 0);
  assert.equal(fixture.parts.calls.cleanup.length, 0);
});

test('cleanup refuses success when an owned resource remains after expiration or cancellation', async () => {
  const cleanup = needExport(cleanupModule, 'cleanupOwnedResources');
  const fixture = cleanupFixture({ leaveResource: true });
  await expectRefusal(cleanup({ context: fixture.context, adapter: fixture.adapter }), 'cleanup_reconciliation_failed');
  assert.equal(fixture.parts.calls.cleanup.length, 0);
});

test('cleanup refuses success if the exact Supabase baseline changes', async () => {
  const cleanup = needExport(cleanupModule, 'cleanupOwnedResources');
  const fixture = cleanupFixture({ changeDatabase: true });
  await expectRefusal(cleanup({ context: fixture.context, adapter: fixture.adapter }), 'cleanup_database_changed');
  assert.equal(fixture.parts.calls.cleanup.length, 0);
});

test('cleanup refuses an unowned resource before issuing provider mutations', async () => {
  const cleanup = needExport(cleanupModule, 'cleanupOwnedResources');
  const fixture = cleanupFixture({ unowned: true });
  await expectRefusal(cleanup({ context: fixture.context, adapter: fixture.adapter }), 'cleanup_ownership_invalid');
  assert.equal(fixture.parts.calls.mutations.length, 0);
  assert.equal(fixture.parts.calls.cleanup.length, 0);
});

test('cleanup rejects unqualified, control-schema, and unknown DB targets before any mutation', async () => {
  const cleanup = needExport(cleanupModule, 'cleanupOwnedResources');
  for (const databaseRows of [
    [{ table: 'attempts', id: 'attempt-task6', ownerAttemptId: 'attempt-task6' }],
    [{ table: 'billing_validation_control.attempts', id: 'attempt-task6', ownerAttemptId: 'attempt-task6' }],
    [{ table: 'public.unreviewed_table', id: 'row_task6', ownerAttemptId: 'attempt-task6' }],
    [{ kind: 'contract', id: 'contract_task6', ownerAttemptId: 'attempt-task6', table: 'billing_validation_control.attempts' }],
    [{ kind: 'unreviewed_kind', id: 'row_task6', ownerAttemptId: 'attempt-task6' }],
  ]) {
    const fixture = cleanupFixture({ databaseRows });
    await expectRefusal(cleanup({ context: fixture.context, adapter: fixture.adapter }), 'cleanup_database_ownership_invalid');
    assert.equal(fixture.actions.length, 0);
    assert.equal(fixture.parts.calls.cleanup.length, 0);
  }
});
