import { defineBlockedScenarioContracts, runBlockedBillingScenario } from './blocked.mjs';

export const SIGNUP_SCENARIOS = defineBlockedScenarioContracts('signup', {
  'signup.native': { reasonCode: 'signup_native_inbox_and_policy_unavailable', blockedBy: [
    'signup_confirmation_policy_unverified', 'signup_non_delivering_inbox_unavailable',
    'signup_crm_mailchimp_suppression_unavailable', 'signup_append_only_identity_retention_unavailable',
    'signup_native_inbox_and_policy_unavailable',
  ] },
  'signup.join': { reasonCode: 'signup_join_policy_reader_unavailable', blockedBy: [
    'signup_confirmation_policy_unverified', 'signup_non_delivering_inbox_unavailable',
    'signup_crm_mailchimp_suppression_unavailable', 'signup_append_only_identity_retention_unavailable',
    'signup_join_policy_reader_unavailable',
  ] },
  'signup.expired-intent': { reasonCode: 'signup_expired_intent_verifier_unavailable', blockedBy: [
    'signup_confirmation_policy_unverified', 'signup_non_delivering_inbox_unavailable',
    'signup_crm_mailchimp_suppression_unavailable', 'signup_append_only_identity_retention_unavailable',
    'signup_expired_intent_verifier_unavailable',
  ] },
  'signup.tampered-intent': { reasonCode: 'signup_tampered_intent_verifier_unavailable', blockedBy: [
    'signup_confirmation_policy_unverified', 'signup_non_delivering_inbox_unavailable',
    'signup_crm_mailchimp_suppression_unavailable', 'signup_append_only_identity_retention_unavailable',
    'signup_tampered_intent_verifier_unavailable',
  ] },
  'signup.replay': { reasonCode: 'signup_replay_finalizer_reader_unavailable', blockedBy: [
    'signup_confirmation_policy_unverified', 'signup_non_delivering_inbox_unavailable',
    'signup_crm_mailchimp_suppression_unavailable', 'signup_append_only_identity_retention_unavailable',
    'signup_replay_finalizer_reader_unavailable',
  ] },
});

export function runSignupScenario(id, effects) {
  return runBlockedBillingScenario(SIGNUP_SCENARIOS, id, effects);
}
