import { test } from 'node:test';
import { importIfMissing, needExport, needValue } from '../support.mjs';
import { assertBlockedDomain } from './support.mjs';

const scenarios = await importIfMissing(() => import('../../../src/billing/scenarios/finance.mjs'));

test('finance journeys require independent amount, provider, and database proof', () => {
  const common = ['finance_provider_database_oracle_unavailable', 'finance_owned_cleanup_unavailable'];
  const expected = [
    ['finance.delinquency', 'finance_delinquency_grace_transition_unverified'],
    ['finance.recovery', 'finance_recovery_paid_through_oracle_unavailable'],
    ['finance.partial-refund', 'finance_partial_refund_payment_proof_unavailable'],
    ['finance.partial-credit', 'finance_partial_credit_balance_oracle_unavailable'],
    ['finance.concurrent-adjustment', 'finance_concurrent_adjustment_two_backend_barrier_unavailable'],
  ].map(([id, reasonCode]) => ({ id, reasonCode, blockedBy: [...common, reasonCode] }));
  assertBlockedDomain({ contracts: needValue(scenarios, 'FINANCE_SCENARIOS'), expected,
    run: needExport(scenarios, 'runFinanceScenario') });
});
