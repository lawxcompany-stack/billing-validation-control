import { defineBlockedScenarioContracts, runBlockedBillingScenario } from './blocked.mjs';

const common = ['access_two_sided_projection_oracle_unavailable', 'access_owned_fixture_cleanup_unavailable'];

export const ACCESS_SCENARIOS = defineBlockedScenarioContracts('access', {
  'access.contracted': { reasonCode: 'access_contracted_projection_unverified', blockedBy: [
    ...common, 'access_contracted_projection_unverified',
  ] },
  'access.uncontracted': { reasonCode: 'access_uncontracted_denial_unverified', blockedBy: [
    ...common, 'access_uncontracted_denial_unverified',
  ] },
  'access.other-team': { reasonCode: 'access_other_team_denial_unverified', blockedBy: [
    ...common, 'access_other_team_denial_unverified',
  ] },
  'access.extras-preprocedural': { reasonCode: 'access_extras_preprocedural_policy_unverified', blockedBy: [
    ...common, 'access_extras_preprocedural_policy_unverified',
  ] },
  'access.hub-blocked': { reasonCode: 'access_hub_blocked_projection_unverified', blockedBy: [
    ...common, 'access_hub_blocked_projection_unverified',
  ] },
  'access.custom-blocked': { reasonCode: 'access_custom_blocked_projection_unverified', blockedBy: [
    ...common, 'access_custom_blocked_projection_unverified',
  ] },
});

export function runAccessScenario(id, effects) {
  return runBlockedBillingScenario(ACCESS_SCENARIOS, id, effects);
}
