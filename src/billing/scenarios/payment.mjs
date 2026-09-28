import { defineBlockedScenarioContracts, runBlockedBillingScenario } from './blocked.mjs';

export const PAYMENT_SCENARIOS = defineBlockedScenarioContracts('payment', {
  'payment.approved': { reasonCode: 'payment_approved_oracle_and_cleanup_unavailable', blockedBy: [
    'payment_independent_stripe_test_readback_unavailable', 'payment_independent_database_readback_unavailable',
    'payment_owned_resource_cleanup_unavailable', 'payment_approved_oracle_and_cleanup_unavailable',
  ] },
  'payment.declined': { reasonCode: 'payment_decline_terminal_state_unverified', blockedBy: [
    'payment_independent_stripe_test_readback_unavailable', 'payment_independent_database_readback_unavailable',
    'payment_owned_resource_cleanup_unavailable', 'payment_decline_terminal_state_unverified',
  ] },
  'payment.abandoned': { reasonCode: 'payment_abandon_terminal_state_unverified', blockedBy: [
    'payment_independent_stripe_test_readback_unavailable', 'payment_independent_database_readback_unavailable',
    'payment_owned_resource_cleanup_unavailable', 'payment_abandon_terminal_state_unverified',
  ] },
  'payment.timeout': { reasonCode: 'payment_timeout_outcome_ambiguous', blockedBy: [
    'payment_independent_stripe_test_readback_unavailable', 'payment_independent_database_readback_unavailable',
    'payment_owned_resource_cleanup_unavailable', 'payment_timeout_outcome_ambiguous',
  ] },
  'payment.refresh': { reasonCode: 'payment_refresh_idempotency_oracle_unavailable', blockedBy: [
    'payment_independent_stripe_test_readback_unavailable', 'payment_independent_database_readback_unavailable',
    'payment_owned_resource_cleanup_unavailable', 'payment_refresh_idempotency_oracle_unavailable',
  ] },
  'payment.two-tabs': { reasonCode: 'payment_two_tabs_concurrency_barrier_unavailable', blockedBy: [
    'payment_independent_stripe_test_readback_unavailable', 'payment_independent_database_readback_unavailable',
    'payment_owned_resource_cleanup_unavailable', 'payment_two_tabs_concurrency_barrier_unavailable',
  ] },
});

export function runPaymentScenario(id, effects) {
  return runBlockedBillingScenario(PAYMENT_SCENARIOS, id, effects);
}
