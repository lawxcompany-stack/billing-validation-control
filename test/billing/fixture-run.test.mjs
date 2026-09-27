import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BILLING_43_IDS } from '../../src/contracts/billing-43.mjs';
import { createAttemptStore } from '../../src/attempts/store.mjs';
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

function createContext(parts, owner, attempts = parts.attempts) {
  const create = needExport(contracts, 'createVerifiedContext');
  return create({ attempts, owner, preflight: parts.preflight,
    mutationAdapter: parts.mutationAdapter, readers: parts.readers, readerBinding: parts.readerBinding });
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

function integratedFixtureRig({ databaseRows = 2 } = {}) {
  const parts = makeAttemptParts();
  const owner = { ...parts.owner, reservationId: 'reservation-integrated', capacity: {
    requested: { attempts: 1, databaseRows, authUsers: 0, stripeObjects: 0 },
  } };
  const key = { branchId: environment.database.branchId, suite: 'billing', fixtureKey: 'fixture-integrated' };
  const now = 1_000;
  const locks = [
    { resourceType: 'supabase_branch',
      resourceId: `${environment.database.projectRef}:${environment.database.branchId}` },
    { resourceType: 'stripe_account', resourceId: environment.stripe.accountId },
  ].map((resource) => ({ ...resource, attemptId: owner.attemptId, fence: owner.fence,
    candidateSha: owner.candidateSha, workflow: owner.workflow, environment: owner.environment,
    expiresAt: now + 60 }));
  const state = {
    attempt: { attemptId: owner.attemptId, key, candidateSha: owner.candidateSha,
      workflow: owner.workflow, environment: owner.environment, state: 'collecting',
      cleanupStatus: 'pending', resourceIds: [], createdAt: now, updatedAt: now },
    lease: { key, attemptId: owner.attemptId, fence: owner.fence, expiresAt: now + 60,
      candidateSha: owner.candidateSha, ownerRepository: owner.workflow.repository,
      ownerRef: owner.workflow.ref, ownerRunId: owner.workflow.runId,
      ownerRunAttempt: owner.workflow.runAttempt, recoveryOnly: false },
    locks,
    reservation: { reservationId: owner.reservationId, attemptId: owner.attemptId,
      scope: { projectRef: environment.database.projectRef,
        branchId: environment.database.branchId, stripeAccountId: environment.stripe.accountId },
      projection: { attempts: 1, databaseRows, authUsers: 0, stripeObjects: 0 },
      fixtureRowsUsed: 0 },
    receipt: null,
    now,
    events: [],
    fixtureCaseClaims: new Map(),
    fixtureResourceClaims: new Map(),
  };
  let tail = Promise.resolve();
  const adapter = { expectedEnvironment: environment, state, async transaction(operation) {
    const previous = tail;
    let release;
    tail = new Promise((resolve) => { release = resolve; });
    await previous;
    const before = { reservation: structuredClone(state.reservation),
      fixtureCaseClaims: structuredClone(state.fixtureCaseClaims),
      fixtureResourceClaims: structuredClone(state.fixtureResourceClaims) };
    const tx = {
      async lockAttempt() { state.events.push('attempt-lock'); },
      async lockResourceLocks() { state.events.push('resource-lock'); },
      async lockRetention() { state.events.push('reservation-lock'); },
      async getAttempt(attemptId) { return attemptId === state.attempt.attemptId
        ? structuredClone(state.attempt) : null; },
      async getLease(candidateKey) { return JSON.stringify(candidateKey) === JSON.stringify(key)
        ? structuredClone(state.lease) : null; },
      async getResourceLocks() { return structuredClone(state.locks); },
      async now() { return state.now; },
      async getRetentionReservation(reservationId) { state.events.push('reservation-read');
        return reservationId === state.reservation?.reservationId ? structuredClone(state.reservation) : null; },
      async getRetentionReservationByAttempt(attemptId) {
        return attemptId === state.reservation?.attemptId ? structuredClone(state.reservation) : null;
      },
      async getRetentionReceipt(reservationId) { return reservationId === state.reservation?.reservationId
        ? structuredClone(state.receipt) : null; },
      async setRetentionFixtureRowsUsed({ reservationId, attemptId, expectedRows, usedRows }) {
        if (!state.reservation || reservationId !== state.reservation.reservationId ||
            attemptId !== state.reservation.attemptId ||
            state.reservation.fixtureRowsUsed !== expectedRows || usedRows > state.reservation.projection.databaseRows) {
          throw Object.assign(new Error('fixture_reservation_insufficient'), {
            code: 'fixture_reservation_insufficient',
          });
        }
        state.reservation.fixtureRowsUsed = usedRows;
        state.events.push('claim');
      },
      async claimFixtureCase(claim) {
        const caseKey = `${claim.attemptId}:${claim.caseId}`;
        const binding = { attemptId: claim.attemptId, caseId: claim.caseId,
          reservationId: claim.reservationId, fence: claim.fence, candidateSha: claim.candidateSha,
          environment: structuredClone(claim.environment), namespaceId: claim.namespaceId };
        const prior = state.fixtureCaseClaims.get(caseKey);
        if (prior && JSON.stringify(prior) !== JSON.stringify(binding)) {
          throw Object.assign(new Error('fixture_case_duplicate'), { code: 'fixture_case_duplicate' });
        }
        if (!prior) state.fixtureCaseClaims.set(caseKey, binding);
        const resourceKey = `${caseKey}:${claim.kind}`;
        if (state.fixtureResourceClaims.has(resourceKey)) {
          throw Object.assign(new Error('fixture_case_duplicate'), { code: 'fixture_case_duplicate' });
        }
        state.fixtureResourceClaims.set(resourceKey, { ...binding, fixtureId: claim.fixtureId,
          kind: claim.kind });
      },
      async fixtureMutation(callback) { return callback(); },
    };
    try { return await operation(tx); }
    catch (error) {
      state.reservation = before.reservation;
      state.fixtureCaseClaims = before.fixtureCaseClaims;
      state.fixtureResourceClaims = before.fixtureResourceClaims;
      throw error;
    } finally { release(); }
  } };
  return { parts, owner, state, adapter, attempts: createAttemptStore(adapter) };
}

function integratedPublisher(rig, store, { insertError } = {}) {
  const create = needExport(supabase, 'createSupabaseFixturePublisher');
  const identity = { projectRef: environment.database.projectRef,
    branchId: environment.database.branchId, appendOnly: true };
  const adapter = {
    identity,
    capabilities: { transactionalFence: true, transactionalReservation: true,
      rejectsExistingIds: true, update: false, delete: false, authAdmin: false },
    async readIdentity() { return identity; },
    async insertAttemptFixture(request) {
      store.fixtureRpc.push(structuredClone(request));
      rig.state.events.push('rpc');
      if (insertError) throw insertError;
      if (store.fixtures.has(request.fixtureId)) throw Object.assign(new Error('duplicate'), {
        code: 'fixture_resource_exists',
      });
      const fixture = { fixtureId: request.fixtureId, namespaceId: request.namespaceId,
        attemptId: request.attemptId, caseId: request.caseId, kind: request.kind,
        marker: request.marker, synthetic: true };
      store.fixtures.set(request.fixtureId, fixture);
      return { inserted: true, fixtureId: request.fixtureId,
        attemptId: request.attemptId, caseId: request.caseId };
    },
  };
  return needExport(supabase, 'createSupabaseFixturePublisher')({ expectedEnvironment: environment,
    adapter, attempts: rig.attempts, owner: rig.owner });
}

function integratedRun(rig, store, options = {}) {
  const attempts = createAttemptStore(rig.adapter);
  const runRig = { ...rig, attempts };
  const context = createContext(rig.parts, rig.owner, attempts);
  const publisher = integratedPublisher(runRig, store, options);
  const readers = offlineReaders(store);
  assert.equal(typeof context.attempts.fixtureMutationWithReservation, 'function');
  assert.equal(typeof publisher.insertAttemptFixture, 'function');
  assert.equal(typeof readers.supabase?.listAttemptFixtures, 'function');
  assert.equal(typeof readers.supabase?.readSyntheticFixture, 'function');
  return needExport(fixtureRun, 'createAttemptFixtureRun')({ context,
    publisher, readers,
    startedAt: '2026-09-27T09:00:00.000Z' });
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
  const rig = integratedFixtureRig({ databaseRows: 3 });
  const store = { fixtureRpc: [], fixtures: new Map(), databaseSnapshot: {} };
  const run = integratedRun(rig, store);
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
    assert.equal(id.includes(rig.owner.attemptId), false);
    assert.equal(id.includes('angelo.neto@advbox.com.br'), false);
  }
  assert.equal(one.attemptId, rig.owner.attemptId);
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
  const rig = integratedFixtureRig({ databaseRows: 1 });
  const store = { fixtureRpc: [], fixtures: new Map(), databaseSnapshot: {} };
  const publisher = integratedPublisher(rig, store);
  const run = integratedRun(rig, store);
  const result = await run.openCase(BILLING_43_IDS[0]).publish({ kind: 'catalog' });

  assert.equal(rig.state.reservation.fixtureRowsUsed, 1);
  assert.ok(rig.state.events.indexOf('claim') < rig.state.events.indexOf('rpc'));
  assert.equal(store.fixtureRpc.length, 1);
  assert.equal(store.fixtureRpc[0].attemptId, rig.owner.attemptId);
  assert.equal(store.fixtureRpc[0].reservationId, rig.owner.reservationId);
  assert.equal(store.fixtureRpc[0].fence, rig.owner.fence);
  assert.equal(store.fixtureRpc[0].environment.database.branchId, environment.database.branchId);
  assert.equal(store.fixtureRpc[0].synthetic, true);
  assert.match(store.fixtureRpc[0].transaction.transactionId, UUID);
  assert.equal(store.fixtureRpc[0].transaction.reservationLocked, true);
  assert.equal(store.fixtureRpc[0].transaction.reservationValidated, true);
  assert.equal(store.fixtureRpc[0].transaction.reservationStatus, 'active');
  assert.equal(store.fixtureRpc[0].transaction.reservationSettled, false);
  assert.deepEqual(result, store.fixtures.get(result.fixtureId));
  assert.equal(Object.keys(publisher).some((key) => /delete|update|auth/iu.test(key)), false);
});

test('real offline attempt store and fixture publisher persist claims before the adapter write and fence replay/concurrency', async () => {
  const rig = integratedFixtureRig({ databaseRows: 1 });
  const store = { fixtureRpc: [], fixtures: new Map(), databaseSnapshot: {} };
  const first = integratedRun(rig, store);
  const concurrent = integratedRun(rig, store);
  const results = await Promise.allSettled([
    first.openCase(BILLING_43_IDS[0]).publish({ kind: 'catalog' }),
    concurrent.openCase(BILLING_43_IDS[0]).publish({ kind: 'catalog' }),
  ]);

  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  const refused = results.find(({ status }) => status === 'rejected');
  assert.equal(refused.reason.code, 'fixture_reservation_insufficient');
  assert.equal(rig.state.reservation.fixtureRowsUsed, 1);
  assert.equal(store.fixtureRpc.length, 1);
  assert.ok(rig.state.events.indexOf('claim') < rig.state.events.indexOf('rpc'));

  await assert.rejects(integratedRun(rig, store).openCase(BILLING_43_IDS[0]).publish({ kind: 'catalog' }),
    { code: 'fixture_reservation_insufficient' });
  assert.equal(store.fixtureRpc.length, 1, 'a new publisher instance cannot replay a consumed claim');
});

test('integrated publisher and concrete attempt store refuse invalid reservations/fences before any RPC', async () => {
  const scenarios = [
    ['missing reservation', (rig) => { rig.state.reservation = null; }, 'retention_reservation_missing'],
    ['settled reservation', (rig) => { rig.state.receipt = { reservationId: rig.owner.reservationId }; },
      'retention_attempt_settled'],
    ['reservation attempt mismatch', (rig) => { rig.state.reservation.attemptId = 'attempt-other'; },
      'fixture_reservation_invalid'],
    ['reservation scope mismatch', (rig) => { rig.state.reservation.scope.branchId = 'other-branch'; },
      'fixture_reservation_invalid'],
    ['reservation capacity too small', (rig) => { rig.state.reservation.projection.databaseRows = 0; },
      'fixture_reservation_insufficient'],
    ['expired fence', (rig) => { rig.state.now = rig.state.lease.expiresAt + 1; }, 'lease_fence_lost'],
    ['recovery-only fence', (rig) => { rig.state.lease.recoveryOnly = true; }, 'recovery_read_only'],
  ];

  for (const [name, prepare, code] of scenarios) {
    const rig = integratedFixtureRig({ databaseRows: 2 });
    const store = { fixtureRpc: [], fixtures: new Map(), databaseSnapshot: {} };
    prepare(rig);
    const run = integratedRun(rig, store);
    await assert.rejects(run.openCase(BILLING_43_IDS[0]).publish({ kind: 'catalog' }), { code }, name);
    assert.equal(store.fixtureRpc.length, 0, name);
  }
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
  for (const caseId of ['signup.native', 'signup.join', 'signup.expired-intent',
    'signup.tampered-intent', 'signup.replay']) {
    await assert.rejects(allowSignup({ caseId, confirmationRequired: true }),
      { code: 'signup_confirmation_policy_unverified' });
  }
  assert.equal(Object.keys(needExport(supabase, 'createSupabaseFixturePublisher')({
    expectedEnvironment: environment,
  })).some((key) => /auth|admin/iu.test(key)), false);
  await assert.rejects(allowSignup({ caseId: 'payment.approved' }),
    { code: 'signup_case_invalid' });
});

test('caller booleans and a self-reported inbox cannot authorize native signup when no trusted policy reader exists', async () => {
  const allowSignup = needExport(fixtureRun, 'assertNativeSignupReady');
  for (const input of [
    { caseId: 'signup.native', confirmationRequired: false },
    { caseId: 'signup.native', confirmationRequired: true,
      inbox: { isolated: true, delivery: 'disabled', async verify() {
        return { isolated: true, delivery: 'disabled' };
      } } },
  ]) {
    await assert.rejects(allowSignup(input), { code: 'signup_confirmation_policy_unverified' });
  }
});

test('ambiguous fixture mutation is sanitized and never retried', async () => {
  const rig = integratedFixtureRig({ databaseRows: 2 });
  const store = { fixtureRpc: [], fixtures: new Map(), databaseSnapshot: {} };
  const context = createContext(rig.parts, rig.owner, rig.attempts);
  const publisher = integratedPublisher(rig, store, {
    insertError: new Error('upstream response leaked sk_test_sensitive and cookie=value'),
  });
  const run = needExport(fixtureRun, 'createAttemptFixtureRun')({ context, publisher, readers: offlineReaders(store),
    startedAt: '2026-09-27T09:00:00.000Z' });
  const scenario = run.openCase(BILLING_43_IDS[0]);
  await assert.rejects(scenario.publish({ kind: 'catalog' }), (error) => {
    assert.equal(error.code, 'fixture_mutation_ambiguous');
    assert.equal(error.message.includes('sk_test_sensitive'), false);
    assert.equal(error.message.includes('cookie=value'), false);
    return true;
  });
  assert.equal(store.fixtureRpc.length, 1);
  assert.equal(rig.state.reservation.fixtureRowsUsed, 1, 'ambiguous provider outcome consumes capacity conservatively');
  await assert.rejects(scenario.publish({ kind: 'billing_identity' }),
    { code: 'fixture_mutation_unresolved' });
  assert.equal(store.fixtureRpc.length, 1, 'an ambiguous write is never retried');
});

test('a recreated fixture run cannot replay an ambiguously claimed attempt/case with new resources', async () => {
  const rig = integratedFixtureRig({ databaseRows: 3 });
  const store = { fixtureRpc: [], fixtures: new Map(), databaseSnapshot: {} };
  const first = integratedRun(rig, store, {
    insertError: new Error('ambiguous writer response'),
  });

  await assert.rejects(first.openCase(BILLING_43_IDS[0]).publish({ kind: 'catalog' }),
    { code: 'fixture_mutation_ambiguous' });
  const restarted = integratedRun(rig, store);
  const replay = await Promise.allSettled([
    restarted.openCase(BILLING_43_IDS[0]).publish({ kind: 'catalog' }),
  ]);

  assert.equal(replay[0].status, 'rejected');
  assert.equal(replay[0].reason.code, 'fixture_case_duplicate');
  assert.equal(store.fixtureRpc.length, 1, 'a new run instance cannot dispatch a previously claimed case');
});
