import { defineBlockedScenarioContracts, runBlockedBillingScenario } from './blocked.mjs';

const common = ['subscription_transition_oracle_unavailable', 'subscription_owned_cleanup_unavailable'];

export const SUBSCRIPTION_SCENARIOS = defineBlockedScenarioContracts('subscription', {
  'subscription.add-area': { reasonCode: 'subscription_add_area_proration_driver_conflict', blockedBy: [
    ...common, 'subscription_add_area_proration_driver_conflict',
  ] },
  'subscription.upgrade': { reasonCode: 'subscription_upgrade_transition_unverified', blockedBy: [
    ...common, 'subscription_upgrade_transition_unverified',
  ] },
  'subscription.downgrade': { reasonCode: 'subscription_downgrade_transition_unverified', blockedBy: [
    ...common, 'subscription_downgrade_transition_unverified',
  ] },
  'subscription.proration': { reasonCode: 'subscription_proration_driver_conflict', blockedBy: [
    ...common, 'subscription_proration_driver_conflict',
  ] },
  'subscription.renewal': { reasonCode: 'subscription_renewal_settlement_oracle_unavailable', blockedBy: [
    ...common, 'subscription_renewal_settlement_oracle_unavailable',
  ] },
  'subscription.cancellation': { reasonCode: 'subscription_cancellation_effective_date_oracle_unavailable', blockedBy: [
    ...common, 'subscription_cancellation_effective_date_oracle_unavailable',
  ] },
});

export function runSubscriptionScenario(id, effects) {
  return runBlockedBillingScenario(SUBSCRIPTION_SCENARIOS, id, effects);
}
