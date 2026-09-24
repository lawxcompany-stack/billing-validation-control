import assert from 'node:assert/strict';
import { test } from 'node:test';
import { databaseSnapshot, importIfMissing, makeAttemptParts, makeReaders, needExport,
  paidProviderState, startedAt } from '../billing/support.mjs';

const operatorModule = await importIfMissing(() => import('../../src/operator/run-collect.mjs'));
const contracts = await importIfMissing(() => import('../../src/billing/contracts.mjs'));
const runCollect = (...args) => needExport(operatorModule, 'runCollect')(...args);

const candidateSha = 'f'.repeat(40);

function makeControlContext() {
  const parts = makeAttemptParts();
  const owner = Object.freeze({ ...parts.owner, candidateSha });
  return needExport(contracts, 'createVerifiedContext')({ ...parts, owner });
}

function mockedChromium() {
  const calls = { launch: [], connect: [], pages: [], contextClose: 0, browserClose: 0, serverClose: 0 };
  const browser = {
    listeners: new Map(),
    on(name, callback) { this.listeners.set(name, callback); },
    off(name) { this.listeners.delete(name); },
    async newContext() {
      return {
        async newPage() {
          const page = {
            signalHandler: null,
            async exposeFunction(_name, callback) { this.signalHandler = callback; },
            async setContent() {},
            async evaluate(_render, request) {
              if (!request) return;
              const type = request.kind === 'challenge' ? 'complete' : 'checkpoint';
              await this.signalHandler({ version: 1, type, candidateSha: request.candidateSha,
                attemptId: request.attemptId, caseId: request.caseId, nonce: request.nonce });
            },
            async close() { calls.pages.push('closed'); },
          };
          calls.pages.push(page);
          return page;
        },
        async close() { calls.contextClose++; },
      };
    },
    async close() { calls.browserClose++; },
  };
  const chromium = {
    async launchServer(options) {
      calls.launch.push(options);
      return { wsEndpoint: () => `ws://127.0.0.1:43123/${options.wsPath}`,
        async close() { calls.serverClose++; } };
    },
    async connect(endpoint, options) {
      calls.connect.push({ endpoint, options });
      return browser;
    },
  };
  return { chromium, calls, browser };
}

test('operator completion cannot turn failed independent Stripe evidence into a 3DS pass', async () => {
  const controlContext = makeControlContext();
  const provider = paidProviderState({
    invoice: { status: 'open', amount_paid: 0, amount_remaining: 2500 },
    intent: { status: 'requires_payment_method', amount_received: 0,
      last_payment_error: { code: 'authentication_failed' } },
    charge: { paid: false, amount_captured: 0, payment_method_details: { card: { three_d_secure: {
      authentication_flow: 'challenge', result: 'failed', result_reason: 'failed' } } } },
    event: null, inbox: null, receipts: [],
  });
  const readers = makeReaders({ provider, baseline: databaseSnapshot(), current: databaseSnapshot() });
  const { chromium, calls } = mockedChromium();
  const result = await runCollect({ chromium, candidateSha, controlContext,
    caseId: 'initial.challenge.success', identity: { customerId: 'cus_task6', sessionId: 'cs_task6',
      checkoutSessionId: 'cs_task6', eventId: 'evt_task6', subscriptionId: 'sub_task6',
      invoiceId: 'in_task6', paymentIntentId: 'pi_task6', teamId: 'team_task6' }, readers,
    expectedAccess: { contractId: 'contract_task6', areas: ['area_task6'] }, startedAt,
    prepareScenario: async () => ({ passed: true }), timeoutMs: 100 });

  assert.equal(result.challengeWitnessVerified, true);
  assert.equal(result.passed, false);
  assert.ok(result.failures.includes('payment_reconciliation_incomplete'));
  assert.equal(calls.contextClose, 1);
  assert.equal(calls.browserClose, 1);
  assert.equal(calls.serverClose, 1);
  assert.equal(calls.pages.filter((page) => page === 'closed').length, 2);
});

test('operator browser disconnect closes the signal transport and browser endpoint', async () => {
  const controlContext = makeControlContext();
  const { chromium, calls, browser } = mockedChromium();
  let preparationStarted;
  const started = new Promise((resolve) => { preparationStarted = resolve; });
  let resumePreparation;
  const waitForPreparation = new Promise((resolve) => { resumePreparation = resolve; });
  const running = runCollect({ chromium, candidateSha, controlContext,
    caseId: 'initial.challenge.success', identity: { customerId: 'cus_task6', invoiceId: 'in_task6',
      paymentIntentId: 'pi_task6', teamId: 'team_task6' },
    readers: makeReaders(), expectedAccess: { contractId: 'contract_task6', areas: ['area_task6'] }, startedAt,
    prepareScenario: async () => { preparationStarted(); await waitForPreparation; }, timeoutMs: 100 });
  await started;
  browser.listeners.get('disconnected')?.();
  const disconnectedResult = await Promise.race([
    running.then(() => false, (error) => error.code === 'operator_closed'),
    new Promise((resolve) => setTimeout(() => resolve(false), 50)),
  ]);
  assert.equal(disconnectedResult, true, 'disconnect must not wait for an unresponsive browser hook');
  resumePreparation();
  await assert.rejects(running, { code: 'operator_closed' });
  assert.equal(calls.browserClose, 1);
  assert.equal(calls.serverClose, 1);
});

test('unsupported 3DS scenarios are refused before launching the operator or preparing a fixture', async () => {
  const controlContext = makeControlContext();
  const { chromium, calls } = mockedChromium();
  let prepared = false;

  await assert.rejects(runCollect({ chromium, candidateSha, controlContext,
    caseId: 'change.upgrade.challenge', identity: { paymentIntentId: 'pi_task6' },
    readers: {}, expectedAccess: { contractId: 'contract_task6', areas: ['area_task6'] }, startedAt,
    prepareScenario: async () => { prepared = true; } }), { code: 'operator_scenario_unsupported' });

  assert.equal(prepared, false);
  assert.equal(calls.launch.length, 0);
});

test('operator hooks receive no caller-supplied provider payload fields', async () => {
  const controlContext = makeControlContext();
  const { chromium, calls } = mockedChromium();
  let prepared = false;

  await assert.rejects(runCollect({ chromium, candidateSha, controlContext,
    caseId: 'initial.challenge.success', identity: { customerId: 'cus_task6', invoiceId: 'in_task6',
      paymentIntentId: 'pi_task6', teamId: 'team_task6', clientSecret: 'private-placeholder' },
    readers: makeReaders(), expectedAccess: { contractId: 'contract_task6', areas: ['area_task6'] }, startedAt,
    prepareScenario: async () => { prepared = true; } }), { code: 'operator_identity_invalid' });

  assert.equal(prepared, false);
  assert.equal(calls.launch.length, 0);
});

test('scenario preparation failure is sanitized and closes all operator resources', async () => {
  const controlContext = makeControlContext();
  const { chromium, calls } = mockedChromium();

  await assert.rejects(runCollect({ chromium, candidateSha, controlContext,
    caseId: 'initial.challenge.success', identity: { customerId: 'cus_task6', invoiceId: 'in_task6',
      paymentIntentId: 'pi_task6', teamId: 'team_task6' },
    readers: makeReaders(), expectedAccess: { contractId: 'contract_task6', areas: ['area_task6'] }, startedAt,
    prepareScenario: async () => { throw new Error('private fixture detail'); } }),
  { code: 'operator_scenario_prepare_failed' });

  assert.equal(calls.contextClose, 1);
  assert.equal(calls.browserClose, 1);
  assert.equal(calls.serverClose, 1);
  assert.equal(calls.pages.filter((page) => page === 'closed').length, 2);
});

test('operator collection refuses a Task 5 owner missing its candidate SHA binding', async () => {
  const parts = makeAttemptParts();
  const controlContext = needExport(contracts, 'createVerifiedContext')(parts);
  const { chromium, calls } = mockedChromium();

  await assert.rejects(runCollect({ chromium, candidateSha, controlContext,
    caseId: 'initial.challenge.success', identity: { customerId: 'cus_task6', invoiceId: 'in_task6',
      paymentIntentId: 'pi_task6', teamId: 'team_task6' }, readers: makeReaders(),
    expectedAccess: { contractId: 'contract_task6', areas: ['area_task6'] }, startedAt }),
  { code: 'operator_context_unverified' });
  assert.equal(calls.launch.length, 0);
});
