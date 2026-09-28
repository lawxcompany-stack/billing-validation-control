import { defineBlockedScenarioContracts, runBlockedBillingScenario } from './blocked.mjs';

export const PRICING_SCENARIOS = defineBlockedScenarioContracts('pricing', {
  'pricing.base-agents': { reasonCode: 'pricing_base_catalog_snapshot_unavailable', blockedBy: [
    'pricing_synthetic_catalog_unavailable', 'pricing_independent_price_snapshot_reader_unavailable',
    'pricing_base_catalog_snapshot_unavailable',
  ] },
  'pricing.progressive': { reasonCode: 'pricing_progressive_catalog_snapshot_unavailable', blockedBy: [
    'pricing_synthetic_catalog_unavailable', 'pricing_independent_price_snapshot_reader_unavailable',
    'pricing_progressive_catalog_snapshot_unavailable',
  ] },
  'pricing.combo': { reasonCode: 'pricing_combo_catalog_snapshot_unavailable', blockedBy: [
    'pricing_synthetic_catalog_unavailable', 'pricing_independent_price_snapshot_reader_unavailable',
    'pricing_combo_catalog_snapshot_unavailable',
  ] },
  'pricing.coupon-allowed': { reasonCode: 'pricing_coupon_allowlist_oracle_unavailable', blockedBy: [
    'pricing_synthetic_catalog_unavailable', 'pricing_independent_price_snapshot_reader_unavailable',
    'pricing_coupon_allowlist_oracle_unavailable',
  ] },
  'pricing.coupon-rejected': { reasonCode: 'pricing_coupon_rejection_oracle_unavailable', blockedBy: [
    'pricing_synthetic_catalog_unavailable', 'pricing_independent_price_snapshot_reader_unavailable',
    'pricing_coupon_rejection_oracle_unavailable',
  ] },
  'pricing.zero-total': { reasonCode: 'pricing_zero_total_policy_unverified', blockedBy: [
    'pricing_synthetic_catalog_unavailable', 'pricing_independent_price_snapshot_reader_unavailable',
    'pricing_zero_total_policy_unverified',
  ] },
});

export function runPricingScenario(id, effects) {
  return runBlockedBillingScenario(PRICING_SCENARIOS, id, effects);
}
