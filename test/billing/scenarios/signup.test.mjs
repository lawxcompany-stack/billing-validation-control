import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importIfMissing, needExport, needValue } from '../support.mjs';
import { assertBlockedDomain } from './support.mjs';

const scenarios = await importIfMissing(() => import('../../../src/billing/scenarios/signup.mjs'));
const fixtureRun = await importIfMissing(() => import('../../../src/billing/fixture-run.mjs'));

const common = [
  'signup_confirmation_policy_unverified',
  'signup_non_delivering_inbox_unavailable',
  'signup_crm_mailchimp_suppression_unavailable',
  'signup_append_only_identity_retention_unavailable',
];

test('all five canonical signup cases are immutable zero-write blocks before every side effect', () => {
  const expected = [
    ['signup.native', 'signup_native_inbox_and_policy_unavailable'],
    ['signup.join', 'signup_join_policy_reader_unavailable'],
    ['signup.expired-intent', 'signup_expired_intent_verifier_unavailable'],
    ['signup.tampered-intent', 'signup_tampered_intent_verifier_unavailable'],
    ['signup.replay', 'signup_replay_finalizer_reader_unavailable'],
  ].map(([id, reasonCode]) => ({ id, reasonCode, blockedBy: [...common, reasonCode] }));

  assertBlockedDomain({ contracts: needValue(scenarios, 'SIGNUP_SCENARIOS'), expected,
    run: needExport(scenarios, 'runSignupScenario') });
});

test('legacy signup readiness gate uses the same stable per-case block reasons', async () => {
  const assertReady = needExport(fixtureRun, 'assertNativeSignupReady');
  const cases = [
    ['signup.native', 'signup_native_inbox_and_policy_unavailable'],
    ['signup.join', 'signup_join_policy_reader_unavailable'],
    ['signup.expired-intent', 'signup_expired_intent_verifier_unavailable'],
    ['signup.tampered-intent', 'signup_tampered_intent_verifier_unavailable'],
    ['signup.replay', 'signup_replay_finalizer_reader_unavailable'],
  ];
  for (const [caseId, reasonCode] of cases) {
    await assert.rejects(assertReady({ caseId, confirmationRequired: false,
      inbox: { async verify() { assert.fail('blocked signup must not inspect an inbox'); } } }),
    { code: reasonCode });
  }
});
