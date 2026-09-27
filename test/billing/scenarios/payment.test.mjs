import { test } from 'node:test';
import { importIfMissing, needExport, needValue } from '../support.mjs';
import { assertBlockedDomain } from './support.mjs';

const scenarios = await importIfMissing(() => import('../../../src/billing/scenarios/payment.mjs'));

const common = [
  'payment_independent_stripe_test_readback_unavailable',
  'payment_independent_database_readback_unavailable',
  'payment_owned_resource_cleanup_unavailable',
];

test('all six canonical payment cases are immutable zero-write blocks before every side effect', () => {
  const expected = [
    ['payment.approved', 'payment_approved_oracle_and_cleanup_unavailable'],
    ['payment.declined', 'payment_decline_terminal_state_unverified'],
    ['payment.abandoned', 'payment_abandon_terminal_state_unverified'],
    ['payment.timeout', 'payment_timeout_outcome_ambiguous'],
    ['payment.refresh', 'payment_refresh_idempotency_oracle_unavailable'],
    ['payment.two-tabs', 'payment_two_tabs_concurrency_barrier_unavailable'],
  ].map(([id, reasonCode]) => ({ id, reasonCode, blockedBy: [...common, reasonCode] }));

  assertBlockedDomain({ contracts: needValue(scenarios, 'PAYMENT_SCENARIOS'), expected,
    run: needExport(scenarios, 'runPaymentScenario') });
});
