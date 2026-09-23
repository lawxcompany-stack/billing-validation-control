import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importIfMissing, needExport, needValue } from './support.mjs';

const fixtures = await importIfMissing(() => import('../../src/billing/fixtures.mjs'));

test('financial catalog retains all 45 reviewed scenarios without runtime deferral', () => {
  const ids = needValue(fixtures, 'FINANCIAL_SCENARIOS');
  assert.deepEqual(ids, [
    'signup.native', 'signup.join', 'signup.advbox', 'signup.expired-intent', 'signup.tampered-intent', 'signup.replay',
    'pricing.base-agents', 'pricing.progressive', 'pricing.combo', 'pricing.coupon-allowed', 'pricing.coupon-rejected', 'pricing.zero-total',
    'payment.approved', 'payment.declined', 'payment.3ds', 'payment.abandoned', 'payment.timeout', 'payment.refresh', 'payment.two-tabs',
    'zero.authorized', 'zero.replay', 'subscription.add-area', 'subscription.upgrade', 'subscription.downgrade',
    'subscription.proration', 'subscription.renewal', 'subscription.cancellation', 'finance.delinquency', 'finance.recovery',
    'finance.partial-refund', 'finance.partial-credit', 'finance.concurrent-adjustment', 'access.contracted',
    'access.uncontracted', 'access.other-team', 'access.extras-preprocedural', 'access.hub-blocked', 'access.custom-blocked',
    'webhook.invalid-signature', 'webhook.wrong-account', 'webhook.wrong-mode', 'webhook.replay', 'webhook.reverse-order',
    'webhook.retry', 'webhook.takeover',
  ]);
  assert.equal(Object.isFrozen(ids), true);
  assert.equal(typeof fixtures.getFinancialValidationScenarios, 'undefined');
});

test('only financial categories with explicit outcome and evidence contracts are executable', () => {
  const contracts = needValue(fixtures, 'FINANCIAL_SCENARIO_CONTRACTS');
  assert.deepEqual(Object.keys(contracts).sort(), [
    'payment.approved', 'payment.declined', 'payment.3ds', 'payment.refresh', 'payment.two-tabs',
  ].sort());
  for (const id of ['payment.abandoned', 'payment.timeout', 'webhook.invalid-signature',
    'webhook.wrong-account', 'webhook.wrong-mode', 'subscription.add-area', 'finance.delinquency']) {
    assert.equal(Object.hasOwn(contracts, id), false, `${id} must remain fail-closed until its evidence contract exists`);
  }
});

test('3DS catalog keeps the 15 supervised cases and separates the control-only incomplete case', () => {
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
  for (const id of ['change.upgrade.challenge', 'change.add_area.challenge', 'renewal.off_session.challenge']) {
    assert.equal(needExport(fixtures, 'threeDsScenario')(id).supported, false);
  }
  assert.throws(() => fixtures.threeDsScenario('not-a-case'), { code: 'three_ds_scenario_invalid' });
});
