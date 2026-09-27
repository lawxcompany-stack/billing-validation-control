import { test } from 'node:test';
import { importIfMissing, needExport, needValue } from '../support.mjs';
import { assertBlockedDomain } from './support.mjs';

const scenarios = await importIfMissing(() => import('../../../src/billing/scenarios/access.mjs'));

test('access journeys require both entitlement and product projection proof', () => {
  const common = ['access_two_sided_projection_oracle_unavailable', 'access_owned_fixture_cleanup_unavailable'];
  const expected = [
    ['access.contracted', 'access_contracted_projection_unverified'],
    ['access.uncontracted', 'access_uncontracted_denial_unverified'],
    ['access.other-team', 'access_other_team_denial_unverified'],
    ['access.extras-preprocedural', 'access_extras_preprocedural_policy_unverified'],
    ['access.hub-blocked', 'access_hub_blocked_projection_unverified'],
    ['access.custom-blocked', 'access_custom_blocked_projection_unverified'],
  ].map(([id, reasonCode]) => ({ id, reasonCode, blockedBy: [...common, reasonCode] }));
  assertBlockedDomain({ contracts: needValue(scenarios, 'ACCESS_SCENARIOS'), expected,
    run: needExport(scenarios, 'runAccessScenario') });
});
