import { test } from 'node:test';
import { importIfMissing, needExport, needValue } from '../support.mjs';
import { assertBlockedDomain } from './support.mjs';

const scenarios = await importIfMissing(() => import('../../../src/billing/scenarios/subscription.mjs'));

test('subscription journeys refuse before fixture, provider, or stale-fence effects', () => {
  const common = ['subscription_transition_oracle_unavailable', 'subscription_owned_cleanup_unavailable'];
  const expected = [
    ['subscription.add-area', 'subscription_add_area_proration_driver_conflict'],
    ['subscription.upgrade', 'subscription_upgrade_transition_unverified'],
    ['subscription.downgrade', 'subscription_downgrade_transition_unverified'],
    ['subscription.proration', 'subscription_proration_driver_conflict'],
    ['subscription.renewal', 'subscription_renewal_settlement_oracle_unavailable'],
    ['subscription.cancellation', 'subscription_cancellation_effective_date_oracle_unavailable'],
  ].map(([id, reasonCode]) => ({ id, reasonCode, blockedBy: [...common, reasonCode] }));
  assertBlockedDomain({ contracts: needValue(scenarios, 'SUBSCRIPTION_SCENARIOS'), expected,
    run: needExport(scenarios, 'runSubscriptionScenario') });
});
