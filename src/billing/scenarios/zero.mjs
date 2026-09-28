import { defineBlockedScenarioContracts, runBlockedBillingScenario } from './blocked.mjs';

export const ZERO_SCENARIOS = defineBlockedScenarioContracts('zero', {
  'zero.authorized': { reasonCode: 'zero_authorization_persistence_oracle_unavailable', blockedBy: [
    'zero_independent_authorization_reader_unavailable', 'zero_append_only_receipt_reader_unavailable',
    'zero_authorization_persistence_oracle_unavailable',
  ] },
  'zero.replay': { reasonCode: 'zero_replay_finalizer_reader_unavailable', blockedBy: [
    'zero_independent_authorization_reader_unavailable', 'zero_append_only_receipt_reader_unavailable',
    'zero_replay_finalizer_reader_unavailable',
  ] },
});

export function runZeroScenario(id, effects) {
  return runBlockedBillingScenario(ZERO_SCENARIOS, id, effects);
}
