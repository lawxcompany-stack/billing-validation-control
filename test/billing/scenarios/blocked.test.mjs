import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineBlockedScenarioContracts, runBlockedBillingScenario } from '../../../src/billing/scenarios/blocked.mjs';

test('blocked scenario definitions reject a getter-backed case without invoking it', () => {
  let reads = 0;
  const definitions = {};
  Object.defineProperty(definitions, 'signup.native', {
    enumerable: true,
    get() { reads += 1; return { reasonCode: 'signup_unavailable', blockedBy: ['signup_policy_missing'] }; },
  });
  assert.throws(() => defineBlockedScenarioContracts('signup', definitions),
    { code: 'billing_scenario_contract_invalid' });
  assert.equal(reads, 0);
});

test('blocked scenario definitions reject getter-backed fields and blockedBy entries without invoking them', () => {
  let reasonReads = 0;
  const reasonDefinition = { blockedBy: ['signup_policy_missing'] };
  Object.defineProperty(reasonDefinition, 'reasonCode', {
    enumerable: true,
    get() { reasonReads += 1; return 'signup_unavailable'; },
  });
  assert.throws(() => defineBlockedScenarioContracts('signup', { 'signup.native': reasonDefinition }),
    { code: 'billing_scenario_contract_invalid' });
  assert.equal(reasonReads, 0);

  let blockedByReads = 0;
  const blockedBy = ['signup_policy_missing'];
  Object.defineProperty(blockedBy, '0', {
    configurable: true,
    enumerable: true,
    get() { blockedByReads += 1; return 'signup_policy_missing'; },
  });
  assert.throws(() => defineBlockedScenarioContracts('signup', {
    'signup.native': { reasonCode: 'signup_unavailable', blockedBy },
  }), { code: 'billing_scenario_contract_invalid' });
  assert.equal(blockedByReads, 0);
});

test('blocked runner rejects a getter-backed contract map without invoking it', () => {
  let reads = 0;
  const contracts = {};
  Object.defineProperty(contracts, 'signup.native', {
    enumerable: true,
    get() { reads += 1; return {}; },
  });
  assert.throws(() => runBlockedBillingScenario(contracts, 'signup.native'),
    { code: 'billing_scenario_contract_invalid' });
  assert.equal(reads, 0);
});

test('blocked runner rejects getter-backed contract fields without invoking them', () => {
  let reads = 0;
  const contract = {
    id: 'signup.native', domain: 'signup', disposition: 'blocked', maxWrites: 0,
    blockedBy: ['signup_policy_missing'], allowedOperations: [],
  };
  Object.defineProperty(contract, 'reasonCode', {
    enumerable: true,
    get() { reads += 1; return 'signup_unavailable'; },
  });
  assert.throws(() => runBlockedBillingScenario({ 'signup.native': contract }, 'signup.native'),
    { code: 'billing_scenario_contract_invalid' });
  assert.equal(reads, 0);
});
