import { test } from 'node:test';
import { importIfMissing, needExport, needValue } from '../support.mjs';
import { assertBlockedDomain } from './support.mjs';

const scenarios = await importIfMissing(() => import('../../../src/billing/scenarios/webhook.mjs'));

test('webhook journeys refuse without safe delivery and independent inbox proof', () => {
  const common = ['webhook_safe_delivery_seam_unavailable', 'webhook_inbox_provider_oracle_unavailable',
    'webhook_owned_event_retention_unavailable'];
  const expected = [
    ['webhook.invalid-signature', 'webhook_invalid_signature_negative_delivery_unavailable'],
    ['webhook.wrong-account', 'webhook_wrong_account_negative_delivery_unavailable'],
    ['webhook.wrong-mode', 'webhook_wrong_mode_negative_delivery_unavailable'],
    ['webhook.replay', 'webhook_replay_case_binding_unavailable'],
    ['webhook.reverse-order', 'webhook_reverse_order_first_delivery_seam_unavailable'],
    ['webhook.retry', 'webhook_retry_controlled_failure_seam_unavailable'],
    ['webhook.takeover', 'webhook_takeover_two_backend_barrier_unavailable'],
  ].map(([id, reasonCode]) => ({ id, reasonCode, blockedBy: [...common, reasonCode] }));
  assertBlockedDomain({ contracts: needValue(scenarios, 'WEBHOOK_SCENARIOS'), expected,
    run: needExport(scenarios, 'runWebhookScenario') });
});
