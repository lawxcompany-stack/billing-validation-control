import { test } from 'node:test';
import { importIfMissing, needExport, needValue } from '../support.mjs';
import { assertBlockedDomain } from './support.mjs';

const scenarios = await importIfMissing(() => import('../../../src/billing/scenarios/pricing.mjs'));

const common = [
  'pricing_synthetic_catalog_unavailable',
  'pricing_independent_price_snapshot_reader_unavailable',
];

test('all six canonical pricing cases are immutable zero-write blocks before every side effect', () => {
  const expected = [
    ['pricing.base-agents', 'pricing_base_catalog_snapshot_unavailable'],
    ['pricing.progressive', 'pricing_progressive_catalog_snapshot_unavailable'],
    ['pricing.combo', 'pricing_combo_catalog_snapshot_unavailable'],
    ['pricing.coupon-allowed', 'pricing_coupon_allowlist_oracle_unavailable'],
    ['pricing.coupon-rejected', 'pricing_coupon_rejection_oracle_unavailable'],
    ['pricing.zero-total', 'pricing_zero_total_policy_unverified'],
  ].map(([id, reasonCode]) => ({ id, reasonCode, blockedBy: [...common, reasonCode] }));

  assertBlockedDomain({ contracts: needValue(scenarios, 'PRICING_SCENARIOS'), expected,
    run: needExport(scenarios, 'runPricingScenario') });
});
