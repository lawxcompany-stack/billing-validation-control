import { defineBlockedScenarioContracts, runBlockedBillingScenario } from './blocked.mjs';

const common = ['webhook_safe_delivery_seam_unavailable', 'webhook_inbox_provider_oracle_unavailable',
  'webhook_owned_event_retention_unavailable'];

export const WEBHOOK_SCENARIOS = defineBlockedScenarioContracts('webhook', {
  'webhook.invalid-signature': { reasonCode: 'webhook_invalid_signature_negative_delivery_unavailable', blockedBy: [
    ...common, 'webhook_invalid_signature_negative_delivery_unavailable',
  ] },
  'webhook.wrong-account': { reasonCode: 'webhook_wrong_account_negative_delivery_unavailable', blockedBy: [
    ...common, 'webhook_wrong_account_negative_delivery_unavailable',
  ] },
  'webhook.wrong-mode': { reasonCode: 'webhook_wrong_mode_negative_delivery_unavailable', blockedBy: [
    ...common, 'webhook_wrong_mode_negative_delivery_unavailable',
  ] },
  'webhook.replay': { reasonCode: 'webhook_replay_case_binding_unavailable', blockedBy: [
    ...common, 'webhook_replay_case_binding_unavailable',
  ] },
  'webhook.reverse-order': { reasonCode: 'webhook_reverse_order_first_delivery_seam_unavailable', blockedBy: [
    ...common, 'webhook_reverse_order_first_delivery_seam_unavailable',
  ] },
  'webhook.retry': { reasonCode: 'webhook_retry_controlled_failure_seam_unavailable', blockedBy: [
    ...common, 'webhook_retry_controlled_failure_seam_unavailable',
  ] },
  'webhook.takeover': { reasonCode: 'webhook_takeover_two_backend_barrier_unavailable', blockedBy: [
    ...common, 'webhook_takeover_two_backend_barrier_unavailable',
  ] },
});

export function runWebhookScenario(id, effects) {
  return runBlockedBillingScenario(WEBHOOK_SCENARIOS, id, effects);
}
