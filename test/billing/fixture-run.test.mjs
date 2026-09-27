import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BILLING_43_IDS } from '../../src/contracts/billing-43.mjs';
import { environment, importIfMissing, makeAttemptParts, needExport } from './support.mjs';

const fixtureRun = await importIfMissing(() => import('../../src/billing/fixture-run.mjs'));
const supabase = await importIfMissing(() => import('../../src/runtime/supabase.mjs'));
const contracts = await importIfMissing(() => import('../../src/billing/contracts.mjs'));
const observations = await importIfMissing(() => import('../../src/billing/observations.mjs'));
const stripe = await importIfMissing(() => import('../../src/runtime/stripe.mjs'));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const capacity = Object.freeze({ requested: Object.freeze({
  attempts: 1, databaseRows: 4, authUsers: 0, stripeObjects: 0,
}) });

function attemptContext({ currentFence, requested = capacity.requested, branchId = environment.database.branchId,
  admitted = true, attemptId = 'attempt-task6' } = {}) {
  const parts = makeAttemptParts({ attemptId });
  const owner = { ...parts.owner, environment: {
    ...environment, database: { ...environment.database, branchId },
  } };
  if (admitted) Object.defineProperties(owner, {
    reservationId: { value: 'd74cf90a-0c2d-4f90-9d95-7727fe43260c', enumerable: false },
    capacity: { value: { requested }, enumerable: false },
  });
  const fence = currentFence ?? owner.fence;
  const calls = { assertions: 0, transactions: [], reservationTransactions: [], fixtureRpc: [], readbacks: [] };
  parts.attempts.assertFence = async ({ attemptId, fence: suppliedFence }) => {
    calls.assertions += 1;
    if (attemptId !== owner.attemptId || suppliedFence !== fence) {
      throw Object.assign(new Error('private fence detail'), { code: 'lease_fence_lost' });
    }
    return { ...owner, state: 'collecting', cleanupStatus: 'pending', fence };
  };
  parts.attempts.fixtureMutation = async ({ attemptId, fence: suppliedFence, reservationId }, callback) => {
    calls.transactions.push({ attemptId, fence: suppliedFence, reservationId });
    if (attemptId !== owner.attemptId || suppliedFence !== fence || reservationId !== owner.reservationId) {
      throw Object.assign(new Error('private transaction detail'), { code: 'lease_fence_lost' });
    }
    return callback(Object.freeze({ attemptId, fence: suppliedFence,
      reservationId: owner.reservationId, transactionId: `tx-${calls.transactions.length}` }));
  };
  parts.attempts.fixtureMutationWithReservation = async ({ attemptId, fence: suppliedFence,
    reservationId, rows }, callback) => {
    calls.reservationTransactions.push({ attemptId, fence: suppliedFence, reservationId, rows });
    if (attemptId !== owner.attemptId || suppliedFence !== fence || reservationId !== owner.reservationId ||
        rows?.databaseRows !== 1) {
      throw Object.assign(new Error('private reservation detail'), { code: 'fixture_reservation_insufficient' });
    }
    return callback(Object.freeze({ attemptId, fence: suppliedFence, reservationId,
      transactionId: `tx-${calls.reservationTransactions.length}`, reservationLocked: true,
      reservationValidated: true, reservationStatus: 'active', reservationSettled: false,
      remainingDatabaseRows: capacity.requested.databaseRows - calls.reservationTransactions.length + 1 }));
  };
  return { parts, owner, calls };
}

function createContext(parts, owner) {
  const create = needExport(contracts, 'createVerifiedContext');
  return create({ attempts: parts.attempts, owner, preflight: parts.preflight,
    mutationAdapter: parts.mutationAdapter });
}

function offlineReaders(store) {
  const create = needExport(observations, 'createIndependentBillingReaders');
  const supabaseIdentity = { projectRef: environment.database.projectRef,
    branchId: environment.database.branchId, readOnly: true };
  const stripeIdentity = { accountId: environment.stripe.accountId, webhookEndpointId: 'we_task6endpoint',
    webhookUrl: `${environment.deployment.origin}/api/stripe/webhook`, livemode: false, readOnly: true };
  const supabaseSource = {
    identity: supabaseIdentity,
    async readIdentity() { return supabaseIdentity; },
    async readBillingSnapshot() { return { ...store.databaseSnapshot }; },
    async readWebhookInbox() { return null; },
    async readWebhookReceipts() { return []; },
    async listAttemptFixtures({ attemptId, caseId, namespaceId }) {
      return [...store.fixtures.values()].filter((item) => item.attemptId === attemptId &&
        item.caseId === caseId && item.namespaceId === namespaceId);
    },
    async readSyntheticFixture({ fixtureId }) { return store.fixtures.get(fixtureId) ?? null; },
  };
  const stripeSource = {
    identity: stripeIdentity,
    async readIdentity() { return stripeIdentity; },
    async retrieve() { return null; },
    async listEvents() { return []; },
    async retrieveWebhookEndpoint() { return { id: stripeIdentity.webhookEndpointId,
      url: stripeIdentity.webhookUrl, livemode: false, created: 1, enabledEvents: [] }; },
  };
  const supabaseReader = needExport(supabase, 'createSupabaseBillingReader')({
    expectedEnvironment: environment, source: supabaseSource,
  });
  const stripeReader = needExport(stripe, 'createStripeBillingReader')({
    expectedEnvironment: environment, expectedWebhookEndpointId: 'we_task6endpoint', source: stripeSource,
  });
  return create({ expectedEnvironment: environment, expectedWebhookEndpointId: 'we_task6endpoint',
    supabase: supabaseReader, stripe: stripeReader });
}

function offlinePublisher(parts, owner, store, { insertError } = {}) {
  const create = needExport(supabase, 'createSupabaseFixturePublisher');
  const identity = { projectRef: environment.database.projectRef,
    branchId: environment.database.branchId, appendOnly: true };
  const capabilities = { transactionalFence: true, transactionalReservation: true,
    rejectsExistingIds: true, update: false, delete: false, authAdmin: false };
  const adapter = {
    identity,
    capabilities,
    async readIdentity() { return identity; },
    async insertAttemptFixture(request) {
      store.fixtureRpc.push(structuredClone(request));
      if (insertError) throw insertError;
      if (store.fixtures.has(request.fixtureId)) {
        throw Object.assign(new Error('duplicate'), { code: 'fixture_resource_exists' });
      }
      const fixture = { fixtureId: request.fixtureId, namespaceId: request.namespaceId,
        attemptId: request.attemptId, caseId: request.caseId, kind: request.kind,
        marker: request.marker, synthetic: true };
      store.fixtures.set(request.fixtureId, fixture);
      return { inserted: true, fixtureId: request.fixtureId, attemptId: request.attemptId,
        caseId: request.caseId };
    },
  };
  return create({ expectedEnvironment: environment, adapter, attempts: parts.attempts, owner });
}

test('the canonical case registry stays frozen, exact, and free of duplicate IDs', () => {
  assert.equal(BILLING_43_IDS.length, 43);
  assert.equal(Object.isFrozen(BILLING_43_IDS), true);
  assert.equal(new Set(BILLING_43_IDS).size, 43);
});

test('fixture cases are admitted in canonical order exactly once; caller-selected case and resource IDs are refused', async () => {
  const createRun = needExport(fixtureRun, 'createAttemptFixtureRun');
  const parts = attemptContext();
  const store = { fixtureRpc: [], fixtures: new Map(), databaseSnapshot: {} };
  const context = createContext(parts.parts, parts.owner);
  const run = createRun({ context, publisher: offlinePublisher(parts.parts, parts.owner, store),
    readers: offlineReaders(store), startedAt: '2026-09-27T09:00:00.000Z' });

  const first = run.openCase(BILLING_43_IDS[0]);
  assert.throws(() => run.openCase(BILLING_43_IDS[0]), { code: 'fixture_case_duplicate' });
  assert.throws(() => run.openCase('case-selected-by-candidate'), { code: 'fixture_case_invalid' });
  await assert.rejects(first.publish({ kind: 'catalog', fixtureId: 'operator-chosen-id' }),
    { code: 'fixture_input_invalid' });
  await assert.rejects(first.publish({ kind: 'auth_admin' }), { code: 'fixture_input_invalid' });
  await assert.rejects(first.publish({ kind: 'catalog', email: 'real@example.com' }),
    { code: 'fixture_input_invalid' });
  assert.equal(store.fixtureRpc.length, 0);
  assert.equal(run.openCase(BILLING_43_IDS[1]).caseId, BILLING_43_IDS[1]);
});

test('all 43 case handles are minted from the canonical registry once, in canonical order', () => {
  const createRun = needExport(fixtureRun, 'createAttemptFixtureRun');
  const parts = attemptContext();
  const store = { fixtureRpc: [], fixtures: new Map(), databaseSnapshot: {} };
  const run = createRun({ context: createContext(parts.parts, parts.owner),
    publisher: offlinePublisher(parts.parts, parts.owner, store), readers: offlineReaders(store),
    startedAt: '2026-09-27T09:00:00.000Z' });
  const cases = BILLING_43_IDS.map((caseId) => run.openCase(caseId));

  assert.deepEqual(cases.map((scenario) => scenario.caseId), BILLING_43_IDS);
  for (const caseId of BILLING_43_IDS) {
    assert.throws(() => run.openCase(caseId), { code: 'fixture_case_duplicate' });
  }
  assert.equal(store.fixtureRpc.length, 0);
});

test('fixture resources receive fresh cryptographic IDs in an attempt/case namespace, not run/email/caller-derived IDs', async () => {
  const createRun = needExport(fixtureRun, 'createAttemptFixtureRun');
  const parts = attemptContext();
  const store = { fixtureRpc: [], fixtures: new Map(), databaseSnapshot: {} };
  const context = createContext(parts.parts, parts.owner);
  const run = createRun({ context, publisher: offlinePublisher(parts.parts, parts.owner, store),
    readers: offlineReaders(store), startedAt: '2026-09-27T09:00:00.000Z' });
  const scenario = run.openCase(BILLING_43_IDS[0]);
  const one = await scenario.publish({ kind: 'catalog' });
  const two = await scenario.publish({ kind: 'billing_identity' });
  const otherCase = await run.openCase(BILLING_43_IDS[1]).publish({ kind: 'catalog' });

  assert.match(one.fixtureId, UUID);
  assert.match(two.fixtureId, UUID);
  assert.notEqual(one.fixtureId, two.fixtureId);
  assert.match(one.namespaceId, UUID);
  assert.equal(one.namespaceId, two.namespaceId);
  assert.notEqual(one.namespaceId, otherCase.namespaceId);
  for (const id of [one.fixtureId, two.fixtureId, one.namespaceId]) {
    assert.equal(id.includes(parts.owner.attemptId), false);
    assert.equal(id.includes(parts.owner.workflow.runId), false);
    assert.equal(id.includes('angelo.neto@advbox.com.br'), false);
  }
  assert.equal(one.attemptId, parts.owner.attemptId);
  assert.equal(one.caseId, BILLING_43_IDS[0]);
  assert.equal(one.synthetic, true);
  assert.equal(JSON.stringify(one).includes('cookie'), false);
  assert.equal(JSON.stringify(one).includes('token'), false);
  assert.equal(store.fixtureRpc.length, 3);
});

test('missing admission, insufficient reservation, wrong branch, stale fence, or missing readers yield zero fixture RPCs', async () => {
  const createRun = needExport(fixtureRun, 'createAttemptFixtureRun');

  for (const variant of [
    { admitted: false },
    { requested: { attempts: 1, databaseRows: 0, authUsers: 0, stripeObjects: 0 } },
    { branchId: 'wrong-validation-branch' },
    { currentFence: 'successor-fence' },
  ]) {
    const parts = attemptContext(variant);
    const store = { fixtureRpc: [], fixtures: new Map(), databaseSnapshot: {} };
    let context;
    let run;
    try { context = createContext(parts.parts, parts.owner); } catch { context = null; }
    if (context) {
      try {
        run = createRun({ context, publisher: offlinePublisher(parts.parts, parts.owner, store),
          readers: offlineReaders(store), startedAt: '2026-09-27T09:00:00.000Z' });
      } catch { run = null; }
      if (!run) {
        assert.equal(store.fixtureRpc.length, 0);
        continue;
      }
      await assert.rejects(run.openCase(BILLING_43_IDS[0]).publish({ kind: 'catalog' }));
    }
    assert.equal(store.fixtureRpc.length, 0);
  }

  const parts = attemptContext();
  const store = { fixtureRpc: [], fixtures: new Map(), databaseSnapshot: {} };
  const context = createContext(parts.parts, parts.owner);
  assert.throws(() => createRun({ context, publisher: offlinePublisher(parts.parts, parts.owner, store),
    readers: null, startedAt: '2026-09-27T09:00:00.000Z' }), { code: 'fixture_run_unavailable' });
  assert.equal(store.fixtureRpc.length, 0);
});

test('fixture publication is unavailable when the attempt store lacks same-transaction live reservation validation', () => {
  const createRun = needExport(fixtureRun, 'createAttemptFixtureRun');
  const parts = attemptContext();
  delete parts.parts.attempts.fixtureMutationWithReservation;
  const store = { fixtureRpc: [], fixtures: new Map(), databaseSnapshot: {} };
  assert.throws(() => createRun({ context: createContext(parts.parts, parts.owner),
    publisher: offlinePublisher(parts.parts, parts.owner, store), readers: offlineReaders(store),
    startedAt: '2026-09-27T09:00:00.000Z' }), { code: 'fixture_run_unavailable' });
  assert.equal(store.fixtureRpc.length, 0);
});

test('each fixture write is fenced, reservation-bound, insert-only, and independently read back', async () => {
  const createRun = needExport(fixtureRun, 'createAttemptFixtureRun');
  const parts = attemptContext();
  const store = { fixtureRpc: [], fixtures: new Map(), databaseSnapshot: {} };
  const context = createContext(parts.parts, parts.owner);
  const publisher = offlinePublisher(parts.parts, parts.owner, store);
  const run = createRun({ context, publisher, readers: offlineReaders(store),
    startedAt: '2026-09-27T09:00:00.000Z' });
  const result = await run.openCase(BILLING_43_IDS[0]).publish({ kind: 'catalog' });

  assert.equal(parts.calls.assertions, 3);
  assert.deepEqual(parts.calls.transactions, [], 'legacy fixtureMutation does not prove reservation capacity');
  assert.deepEqual(parts.calls.reservationTransactions, [{ attemptId: parts.owner.attemptId,
    fence: parts.owner.fence, reservationId: parts.owner.reservationId, rows: { databaseRows: 1 } }]);
  assert.equal(store.fixtureRpc.length, 1);
  assert.equal(store.fixtureRpc[0].attemptId, parts.owner.attemptId);
  assert.equal(store.fixtureRpc[0].reservationId, parts.owner.reservationId);
  assert.equal(store.fixtureRpc[0].fence, parts.owner.fence);
  assert.equal(store.fixtureRpc[0].environment.database.branchId, environment.database.branchId);
  assert.equal(store.fixtureRpc[0].synthetic, true);
  assert.equal(store.fixtureRpc[0].transaction.transactionId, 'tx-1');
  assert.equal(store.fixtureRpc[0].transaction.reservationLocked, true);
  assert.equal(store.fixtureRpc[0].transaction.reservationValidated, true);
  assert.equal(store.fixtureRpc[0].transaction.reservationStatus, 'active');
  assert.equal(store.fixtureRpc[0].transaction.reservationSettled, false);
  assert.deepEqual(result, store.fixtures.get(result.fixtureId));
  assert.equal(Object.keys(publisher).some((key) => /delete|update|auth/iu.test(key)), false);
});

test('fixture writer rejects unconfigured or unsafe mutation capabilities before invoking the adapter', async () => {
  const create = needExport(supabase, 'createSupabaseFixturePublisher');
  const parts = attemptContext();
  const unsafeCalls = [];
  const unsafe = create({ expectedEnvironment: environment, adapter: {
    identity: { projectRef: environment.database.projectRef, branchId: environment.database.branchId,
      appendOnly: false },
    capabilities: { transactionalFence: false, transactionalReservation: false, rejectsExistingIds: false,
      update: true, delete: true, authAdmin: true },
    async readIdentity() { return this.identity; },
    async insertAttemptFixture(input) { unsafeCalls.push(input); },
  }, attempts: parts.parts.attempts, owner: parts.owner });
  await assert.rejects(unsafe.assertReady({ attemptId: parts.owner.attemptId,
    reservationId: parts.owner.reservationId, fence: parts.owner.fence,
    environment: parts.owner.environment }), { code: 'supabase_fixture_adapter_unavailable' });
  assert.equal(unsafeCalls.length, 0);

  const absent = create({ expectedEnvironment: environment });
  await assert.rejects(absent.assertReady({ attemptId: 'attempt-4', reservationId: 'reservation-4',
    fence: 'fence-4', environment }), { code: 'supabase_fixture_adapter_unavailable' });
});

test('native signup requiring confirmation blocks without an isolated non-delivering inbox and never offers Auth-admin creation', async () => {
  const allowSignup = needExport(fixtureRun, 'assertNativeSignupReady');
  await assert.rejects(allowSignup({ caseId: 'signup.native', confirmationRequired: true }),
    { code: 'signup_inbox_unavailable' });
  const ready = await allowSignup({ caseId: 'signup.native', confirmationRequired: true,
    inbox: { isolated: true, delivery: 'disabled', async verify() {
      return { isolated: true, delivery: 'disabled' };
    } } });
  assert.equal(ready.caseId, 'signup.native');
  assert.equal(ready.authCreation, 'native-preview-only');
  assert.equal(Object.keys(needExport(supabase, 'createSupabaseFixturePublisher')({
    expectedEnvironment: environment,
  })).some((key) => /auth|admin/iu.test(key)), false);
  await assert.rejects(allowSignup({ caseId: 'payment.approved', confirmationRequired: true }),
    { code: 'signup_case_invalid' });
  for (const unsafeInbox of [
    { isolated: false, delivery: 'disabled', async verify() { return { isolated: true, delivery: 'disabled' }; } },
    { isolated: true, delivery: 'enabled', async verify() { return { isolated: true, delivery: 'enabled' }; } },
    { isolated: true, delivery: 'disabled', async verify() { return { isolated: false, delivery: 'disabled' }; } },
  ]) {
    await assert.rejects(allowSignup({ caseId: 'signup.native', confirmationRequired: true,
      inbox: unsafeInbox }), { code: 'signup_inbox_unavailable' });
  }
});

test('ambiguous fixture mutation is sanitized and never retried', async () => {
  const createRun = needExport(fixtureRun, 'createAttemptFixtureRun');
  const parts = attemptContext();
  const store = { fixtureRpc: [], fixtures: new Map(), databaseSnapshot: {} };
  const context = createContext(parts.parts, parts.owner);
  const publisher = offlinePublisher(parts.parts, parts.owner, store, {
    insertError: new Error('upstream response leaked sk_test_sensitive and cookie=value'),
  });
  const run = createRun({ context, publisher, readers: offlineReaders(store),
    startedAt: '2026-09-27T09:00:00.000Z' });
  await assert.rejects(run.openCase(BILLING_43_IDS[0]).publish({ kind: 'catalog' }), (error) => {
    assert.equal(error.code, 'fixture_mutation_ambiguous');
    assert.equal(error.message.includes('sk_test_sensitive'), false);
    assert.equal(error.message.includes('cookie=value'), false);
    return true;
  });
  assert.equal(store.fixtureRpc.length, 1);
});
