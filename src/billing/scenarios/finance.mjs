import { defineBlockedScenarioContracts, runBlockedBillingScenario } from './blocked.mjs';

const common = ['finance_provider_database_oracle_unavailable', 'finance_owned_cleanup_unavailable'];

export const FINANCE_SCENARIOS = defineBlockedScenarioContracts('finance', {
  'finance.delinquency': { reasonCode: 'finance_delinquency_grace_transition_unverified', blockedBy: [
    ...common, 'finance_delinquency_grace_transition_unverified',
  ] },
  'finance.recovery': { reasonCode: 'finance_recovery_paid_through_oracle_unavailable', blockedBy: [
    ...common, 'finance_recovery_paid_through_oracle_unavailable',
  ] },
  'finance.partial-refund': { reasonCode: 'finance_partial_refund_payment_proof_unavailable', blockedBy: [
    ...common, 'finance_partial_refund_payment_proof_unavailable',
  ] },
  'finance.partial-credit': { reasonCode: 'finance_partial_credit_balance_oracle_unavailable', blockedBy: [
    ...common, 'finance_partial_credit_balance_oracle_unavailable',
  ] },
  'finance.concurrent-adjustment': { reasonCode: 'finance_concurrent_adjustment_two_backend_barrier_unavailable', blockedBy: [
    ...common, 'finance_concurrent_adjustment_two_backend_barrier_unavailable',
  ] },
});

export function runFinanceScenario(id, effects) {
  return runBlockedBillingScenario(FINANCE_SCENARIOS, id, effects);
}
