import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importIfMissing, needExport, needValue } from './support.mjs';

const fixtures = await importIfMissing(() => import('../../src/billing/fixtures.mjs'));
const billing43 = await importIfMissing(() => import('../../src/contracts/billing-43.mjs'));

const expectedIds = [
  'signup.native', 'signup.join', 'signup.expired-intent', 'signup.tampered-intent', 'signup.replay',
  'pricing.base-agents', 'pricing.progressive', 'pricing.combo', 'pricing.coupon-allowed',
  'pricing.coupon-rejected', 'pricing.zero-total',
  'payment.approved', 'payment.declined', 'payment.abandoned', 'payment.timeout', 'payment.refresh', 'payment.two-tabs',
  'zero.authorized', 'zero.replay',
  'subscription.add-area', 'subscription.upgrade', 'subscription.downgrade', 'subscription.proration',
  'subscription.renewal', 'subscription.cancellation',
  'finance.delinquency', 'finance.recovery', 'finance.partial-refund', 'finance.partial-credit',
  'finance.concurrent-adjustment',
  'access.contracted', 'access.uncontracted', 'access.other-team', 'access.extras-preprocedural',
  'access.hub-blocked', 'access.custom-blocked',
  'webhook.invalid-signature', 'webhook.wrong-account', 'webhook.wrong-mode', 'webhook.replay',
  'webhook.reverse-order', 'webhook.retry', 'webhook.takeover',
];

function completeTestContracts(ids) {
  return ids.map((id) => ({
    id,
    domain: id.split('.')[0],
    maxWrites: 0,
    allowedOperations: [],
    requiredEvidence: ['database'],
    async run() { return { passed: true }; },
  }));
}

test('canonical registry is the exact frozen 43-ID suite in Spec order', () => {
  const ids = needValue(billing43, 'BILLING_43_IDS');
  assert.deepEqual(ids, expectedIds);
  assert.equal(ids.length, 43);
  assert.equal(new Set(ids).size, 43);
  assert.equal(Object.isFrozen(ids), true);
  assert.equal(ids.includes('signup.advbox'), false);
  assert.equal(ids.includes('payment.3ds'), false);
  assert.deepEqual(needValue(fixtures, 'FINANCIAL_SCENARIOS'), expectedIds);
});

test('canonical executor blocks all Task 5 cases before fixture creation or contract execution', async () => {
  const ids = needValue(billing43, 'BILLING_43_IDS');
  const blockedIds = needValue(fixtures, 'TASK5_BLOCKED_SCENARIO_IDS');
  const runBilling43Scenario = needExport(billing43, 'runBilling43Scenario');
  assert.equal(blockedIds.length, 19);
  let fixtureCreations = 0;
  let contractRuns = 0;
  const contracts = completeTestContracts(ids).map((contract) => ({ ...contract,
    async run() { contractRuns += 1; return { passed: true }; } }));

  for (const id of blockedIds) {
    await assert.rejects(runBilling43Scenario({ id, contracts,
      async createFixture() { fixtureCreations += 1; return {}; },
    }), { code: 'billing_scenario_blocked' });
  }
  assert.equal(fixtureCreations, 0);
  assert.equal(contractRuns, 0);
});

test('Task 5 exposes exactly the 19 blocked canonical signup, pricing, payment, and zero cases', () => {
  const expectedTask5Ids = [
    'signup.native', 'signup.join', 'signup.expired-intent', 'signup.tampered-intent', 'signup.replay',
    'pricing.base-agents', 'pricing.progressive', 'pricing.combo', 'pricing.coupon-allowed',
    'pricing.coupon-rejected', 'pricing.zero-total',
    'payment.approved', 'payment.declined', 'payment.abandoned', 'payment.timeout', 'payment.refresh',
    'payment.two-tabs', 'zero.authorized', 'zero.replay',
  ];
  const contracts = needValue(fixtures, 'TASK5_BLOCKED_SCENARIO_CONTRACTS');
  assert.deepEqual(Object.keys(contracts), expectedTask5Ids);
  assert.deepEqual(needValue(billing43, 'BILLING_43_TASK5_IDS'), expectedTask5Ids);
  assert.equal(Object.isFrozen(contracts), true);
  assert.ok(expectedTask5Ids.every((id) => expectedIds.includes(id)));
  assert.equal(expectedTask5Ids.length, 19);
});

test('contract completeness failures occur before fixture creation or contract execution', async () => {
  const ids = needValue(billing43, 'BILLING_43_IDS');
  const runBilling43Scenario = needExport(billing43, 'runBilling43Scenario');
  const complete = completeTestContracts(ids);
  const invalidRegistries = [
    complete.slice(1),
    [...complete, complete[0]],
    [...complete.slice(1), { ...complete[0], id: 'unknown.scenario', domain: 'unknown' }],
  ];

  for (const contracts of invalidRegistries) {
    let fixtureCreations = 0;
    let providerCalls = 0;
    await assert.rejects(runBilling43Scenario({
      id: ids[0],
      contracts: contracts.map((contract) => ({ ...contract, async run() { providerCalls += 1; } })),
      async createFixture() { fixtureCreations += 1; return {}; },
    }), { code: 'billing_contracts_incomplete' });
    assert.equal(fixtureCreations, 0);
    assert.equal(providerCalls, 0);
  }
});

test('contract run accessors are refused before fixture creation or execution', async () => {
  const ids = needValue(billing43, 'BILLING_43_IDS');
  const runBilling43Scenario = needExport(billing43, 'runBilling43Scenario');
  const contracts = completeTestContracts(ids);
  let getterReads = 0;
  let fixtureCreations = 0;
  let providerMutations = 0;

  Object.defineProperty(contracts[0], 'run', {
    configurable: true,
    enumerable: true,
    get() {
      getterReads += 1;
      return async () => { providerMutations += 1; };
    },
  });

  await assert.rejects(runBilling43Scenario({
    id: ids[0], contracts,
    async createFixture() { fixtureCreations += 1; return {}; },
  }), { code: 'billing_contract_invalid' });
  assert.equal(getterReads, 0);
  assert.equal(fixtureCreations, 0);
  assert.equal(providerMutations, 0);
});

test('operation array index accessors are refused before fixture creation or execution', async () => {
  const ids = needValue(billing43, 'BILLING_43_IDS');
  const runBilling43Scenario = needExport(billing43, 'runBilling43Scenario');
  const contracts = completeTestContracts(ids);
  const allowedOperations = [];
  let getterReads = 0;
  let fixtureCreations = 0;
  let providerMutations = 0;

  Object.defineProperty(allowedOperations, '0', {
    configurable: true,
    enumerable: true,
    get() {
      getterReads += 1;
      return getterReads <= 2 ? 'checkout.replay' : 'unreviewed.provider.mutation';
    },
  });
  contracts[0].allowedOperations = allowedOperations;
  contracts[0].run = async () => { providerMutations += 1; };

  await assert.rejects(runBilling43Scenario({
    id: ids[0], contracts,
    async createFixture() { fixtureCreations += 1; return {}; },
  }), { code: 'billing_contract_invalid' });
  assert.equal(getterReads, 0);
  assert.equal(fixtureCreations, 0);
  assert.equal(providerMutations, 0);
});

test('scenario execution gives contracts the frozen validated registry', async () => {
  const ids = needValue(billing43, 'BILLING_43_IDS');
  const runBilling43Scenario = needExport(billing43, 'runBilling43Scenario');
  let observedContracts;
  const contracts = completeTestContracts(ids).map((contract) => ({
    ...contract,
    async run(context) {
      observedContracts = context.contracts;
      return { passed: true };
    },
  }));

  await runBilling43Scenario({ id: ids[19], contracts,
    async createFixture() { return {}; }, context: { attemptId: 'attempt-safe' } });

  assert.deepEqual(Object.keys(observedContracts ?? {}), ids);
  assert.equal(Object.isFrozen(observedContracts), true);
  assert.equal(observedContracts[ids[19]].id, ids[19]);
});

test('contract completeness requires valid evidence, bounded writes, closed operations, and callable run', () => {
  const ids = needValue(billing43, 'BILLING_43_IDS');
  const assertCompleteBilling43Contracts = needExport(billing43, 'assertCompleteBilling43Contracts');
  const complete = completeTestContracts(ids);
  const invalidContracts = [
    { ...complete[0], requiredEvidence: [] },
    { ...complete[0], requiredEvidence: new Array(1) },
    { ...complete[0], maxWrites: Number.NaN },
    { ...complete[0], maxWrites: -1 },
    { ...complete[0], allowedOperations: ['candidate.unreviewed-operation'] },
    { ...complete[0], allowedOperations: new Array(1) },
    { ...complete[0], run: undefined },
  ];

  for (const invalid of invalidContracts) {
    const contracts = [invalid, ...complete.slice(1)];
    assert.throws(() => assertCompleteBilling43Contracts(contracts), { code: 'billing_contract_invalid' });
  }

  const finiteNonnegativeCap = completeTestContracts(ids);
  finiteNonnegativeCap[0].maxWrites = 0.5;
  assert.doesNotThrow(() => assertCompleteBilling43Contracts(finiteNonnegativeCap));
});

test('45-case leftovers and supervised 3DS workflows stay outside the canonical registry', () => {
  assert.deepEqual(needValue(fixtures, 'SUPERVISED_FINANCIAL_SCENARIOS'), ['signup.advbox', 'payment.3ds']);
  assert.deepEqual(needValue(fixtures, 'THREE_DS_SCENARIOS'), [
    'initial.challenge.success', 'initial.challenge.cancel', 'initial.challenge.failure',
    'initial.authenticated.declined', 'initial.refresh', 'initial.two_tabs', 'initial.expired',
    'initial.webhook_delayed', 'initial.webhook_replay', 'change.upgrade.challenge',
    'change.add_area.challenge', 'renewal.off_session.challenge', 'access.foreign_actor',
    'initial.frictionless', 'initial.challenge.success.repeat',
  ]);
  assert.deepEqual(needValue(fixtures, 'CONTROL_ONLY_THREE_DS_SCENARIOS'), ['initial.challenge.incomplete']);
  assert.equal(needValue(fixtures, 'ALL_THREE_DS_SCENARIOS').length, 16);
  assert.equal(needExport(fixtures, 'threeDsScenario')('initial.challenge.incomplete').expectedOutcome, 'incomplete');
  assert.equal(needExport(fixtures, 'threeDsScenario')('initial.webhook_delayed').webhookDelayed, true);
  assert.equal(needExport(fixtures, 'threeDsScenario')('initial.webhook_delayed').supported, undefined);
  for (const id of ['change.upgrade.challenge', 'change.add_area.challenge', 'renewal.off_session.challenge']) {
    assert.equal(needExport(fixtures, 'threeDsScenario')(id).supported, false);
  }
  assert.throws(() => fixtures.threeDsScenario('not-a-case'), { code: 'three_ds_scenario_invalid' });
});
