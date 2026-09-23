export const FINANCIAL_SCENARIOS = Object.freeze([
  'signup.native', 'signup.join', 'signup.advbox', 'signup.expired-intent', 'signup.tampered-intent', 'signup.replay',
  'pricing.base-agents', 'pricing.progressive', 'pricing.combo', 'pricing.coupon-allowed', 'pricing.coupon-rejected', 'pricing.zero-total',
  'payment.approved', 'payment.declined', 'payment.3ds', 'payment.abandoned', 'payment.timeout', 'payment.refresh', 'payment.two-tabs',
  'zero.authorized', 'zero.replay',
  'subscription.add-area', 'subscription.upgrade', 'subscription.downgrade', 'subscription.proration', 'subscription.renewal', 'subscription.cancellation',
  'finance.delinquency', 'finance.recovery', 'finance.partial-refund', 'finance.partial-credit', 'finance.concurrent-adjustment',
  'access.contracted', 'access.uncontracted', 'access.other-team', 'access.extras-preprocedural', 'access.hub-blocked', 'access.custom-blocked',
  'webhook.invalid-signature', 'webhook.wrong-account', 'webhook.wrong-mode', 'webhook.replay', 'webhook.reverse-order', 'webhook.retry', 'webhook.takeover',
]);

export const THREE_DS_SCENARIOS = Object.freeze([
  'initial.challenge.success', 'initial.challenge.cancel', 'initial.challenge.failure',
  'initial.authenticated.declined', 'initial.refresh', 'initial.two_tabs', 'initial.expired',
  'initial.webhook_delayed', 'initial.webhook_replay', 'change.upgrade.challenge',
  'change.add_area.challenge', 'renewal.off_session.challenge', 'access.foreign_actor',
  'initial.frictionless', 'initial.challenge.success.repeat',
]);

export const CONTROL_ONLY_THREE_DS_SCENARIOS = Object.freeze(['initial.challenge.incomplete']);
export const ALL_THREE_DS_SCENARIOS = Object.freeze([
  ...THREE_DS_SCENARIOS, ...CONTROL_ONLY_THREE_DS_SCENARIOS,
]);

const THREE_DS_CASE_CONTRACTS = Object.freeze({
  'initial.challenge.success': Object.freeze({ expectedOutcome: 'paid_challenge', challenge: true, singleEffect: true }),
  'initial.challenge.cancel': Object.freeze({ expectedOutcome: 'no_new_access', challenge: true, negativeCase: 'cancel' }),
  'initial.challenge.failure': Object.freeze({ expectedOutcome: 'no_new_access', challenge: true, negativeCase: 'failure' }),
  'initial.authenticated.declined': Object.freeze({ expectedOutcome: 'no_new_access', challenge: true, negativeCase: 'authenticated_decline' }),
  'initial.refresh': Object.freeze({ expectedOutcome: 'paid_challenge', challenge: true, singleEffect: true }),
  'initial.two_tabs': Object.freeze({ expectedOutcome: 'paid_challenge', challenge: true, singleEffect: true }),
  'initial.expired': Object.freeze({ expectedOutcome: 'no_new_access', challenge: false, negativeCase: 'expired_checkout' }),
  'initial.webhook_delayed': Object.freeze({ expectedOutcome: 'paid_challenge', challenge: true, singleEffect: true,
    webhookReplay: true, supported: false }),
  'initial.webhook_replay': Object.freeze({ expectedOutcome: 'paid_challenge', challenge: true, singleEffect: true, webhookReplay: true }),
  'change.upgrade.challenge': Object.freeze({ expectedOutcome: 'paid_challenge', challenge: true, singleEffect: true, supported: false }),
  'change.add_area.challenge': Object.freeze({ expectedOutcome: 'paid_challenge', challenge: true, singleEffect: true, supported: false }),
  'renewal.off_session.challenge': Object.freeze({ expectedOutcome: 'paid_challenge', challenge: true, singleEffect: true, supported: false }),
  'access.foreign_actor': Object.freeze({ expectedOutcome: 'no_new_access', challenge: false, negativeCase: 'foreign_actor' }),
  'initial.frictionless': Object.freeze({ expectedOutcome: 'paid_frictionless', challenge: false, singleEffect: true }),
  'initial.challenge.success.repeat': Object.freeze({ expectedOutcome: 'paid_challenge', challenge: true, singleEffect: true }),
  'initial.challenge.incomplete': Object.freeze({ expectedOutcome: 'incomplete', challenge: true, negativeCase: 'incomplete' }),
});

export function threeDsScenario(id) {
  const contract = THREE_DS_CASE_CONTRACTS[id];
  if (!ALL_THREE_DS_SCENARIOS.includes(id) || !contract) {
    throw Object.assign(new Error('three_ds_scenario_invalid'), { code: 'three_ds_scenario_invalid' });
  }
  return Object.freeze({ id, ...contract });
}

const read = Object.freeze(['http', 'database']);
const payment = Object.freeze([...read, 'stripe', 'webhook', 'worker', 'browser']);
const rejectedPayment = Object.freeze([...read, 'stripe', 'browser']);
const settlement = Object.freeze([...read, 'stripe', 'webhook', 'worker']);
const negativeWebhook = Object.freeze([...read, 'webhook']);

export const FINANCIAL_EVIDENCE_REQUIREMENTS = Object.freeze({
  'signup.native': read, 'signup.join': read, 'signup.advbox': Object.freeze([...read, 'browser']),
  'signup.expired-intent': read, 'signup.tampered-intent': read, 'signup.replay': read,
  'pricing.base-agents': read, 'pricing.progressive': read, 'pricing.combo': read,
  'pricing.coupon-allowed': read, 'pricing.coupon-rejected': read, 'pricing.zero-total': read,
  'payment.approved': payment, 'payment.declined': rejectedPayment, 'payment.3ds': payment,
  'payment.abandoned': rejectedPayment, 'payment.timeout': rejectedPayment,
  'payment.refresh': payment, 'payment.two-tabs': payment,
  'zero.authorized': read, 'zero.replay': read,
  'subscription.add-area': settlement, 'subscription.upgrade': settlement,
  'subscription.downgrade': settlement, 'subscription.proration': settlement,
  'subscription.renewal': settlement, 'subscription.cancellation': settlement,
  'finance.delinquency': settlement, 'finance.recovery': settlement,
  'finance.partial-refund': settlement, 'finance.partial-credit': settlement,
  'finance.concurrent-adjustment': settlement,
  'access.contracted': read, 'access.uncontracted': read, 'access.other-team': read,
  'access.extras-preprocedural': read, 'access.hub-blocked': read, 'access.custom-blocked': read,
  'webhook.invalid-signature': negativeWebhook, 'webhook.wrong-account': negativeWebhook,
  'webhook.wrong-mode': negativeWebhook, 'webhook.replay': settlement,
  'webhook.reverse-order': settlement, 'webhook.retry': settlement, 'webhook.takeover': settlement,
});

const scenarioContract = (outcome) => Object.freeze({ outcome });
export const FINANCIAL_SCENARIO_CONTRACTS = Object.freeze({
  'payment.approved': Object.freeze({ ...scenarioContract('paid'), contextCount: 1 }),
  'payment.declined': Object.freeze({ ...scenarioContract('unpaid'), negativeState: 'declined' }),
  'payment.3ds': Object.freeze({ ...scenarioContract('paid'), contextCount: 1, challenge: true }),
  'payment.refresh': Object.freeze({ ...scenarioContract('paid'), contextCount: 1, singleEffect: true }),
  'payment.two-tabs': Object.freeze({ ...scenarioContract('paid'), contextCount: 1, singleEffect: true }),
});
