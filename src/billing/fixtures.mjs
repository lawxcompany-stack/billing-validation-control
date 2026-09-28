import { BILLING_43_IDS, BILLING_43_TASK5_IDS } from '../contracts/billing-43.mjs';
import { SIGNUP_SCENARIOS } from './scenarios/signup.mjs';
import { PRICING_SCENARIOS } from './scenarios/pricing.mjs';
import { PAYMENT_SCENARIOS } from './scenarios/payment.mjs';
import { ZERO_SCENARIOS } from './scenarios/zero.mjs';
import { SUBSCRIPTION_SCENARIOS } from './scenarios/subscription.mjs';
import { FINANCE_SCENARIOS } from './scenarios/finance.mjs';
import { ACCESS_SCENARIOS } from './scenarios/access.mjs';
import { WEBHOOK_SCENARIOS } from './scenarios/webhook.mjs';

const task5Entries = [SIGNUP_SCENARIOS, PRICING_SCENARIOS, PAYMENT_SCENARIOS, ZERO_SCENARIOS]
  .flatMap((domain) => Object.values(domain));
const task5ById = Object.create(null);
for (const contract of task5Entries) {
  if (!BILLING_43_IDS.includes(contract.id) || Object.hasOwn(task5ById, contract.id)) {
    throw new Error('billing_task5_registry_invalid');
  }
  task5ById[contract.id] = contract;
}
const task5Ids = BILLING_43_IDS.filter((id) => Object.hasOwn(task5ById, id));
if (task5Entries.length !== BILLING_43_TASK5_IDS.length ||
    task5Ids.some((id, index) => id !== BILLING_43_TASK5_IDS[index])) {
  throw new Error('billing_task5_registry_invalid');
}

export const TASK5_BLOCKED_SCENARIO_CONTRACTS = Object.freeze(Object.fromEntries(
  task5Ids.map((id) => [id, task5ById[id]])));
export const TASK5_BLOCKED_SCENARIO_IDS = Object.freeze(task5Ids);

const task6Entries = [SUBSCRIPTION_SCENARIOS, FINANCE_SCENARIOS, ACCESS_SCENARIOS,
  WEBHOOK_SCENARIOS].flatMap((domain) => Object.values(domain));
const task6ById = Object.create(null);
for (const contract of task6Entries) {
  if (!BILLING_43_IDS.includes(contract.id) || Object.hasOwn(task6ById, contract.id) ||
      Object.hasOwn(task5ById, contract.id)) {
    throw new Error('billing_task6_registry_invalid');
  }
  task6ById[contract.id] = contract;
}
const task6Ids = BILLING_43_IDS.filter((id) => Object.hasOwn(task6ById, id));
const expectedTask6Ids = BILLING_43_IDS.slice(BILLING_43_TASK5_IDS.length);
if (task6Entries.length !== expectedTask6Ids.length ||
    task6Ids.some((id, index) => id !== expectedTask6Ids[index])) {
  throw new Error('billing_task6_registry_invalid');
}

export const TASK6_BLOCKED_SCENARIO_CONTRACTS = Object.freeze(Object.fromEntries(
  task6Ids.map((id) => [id, task6ById[id]])));
export const TASK6_BLOCKED_SCENARIO_IDS = Object.freeze(task6Ids);

export const FINANCIAL_SCENARIOS = BILLING_43_IDS;

export const SUPERVISED_FINANCIAL_SCENARIOS = Object.freeze(['signup.advbox', 'payment.3ds']);

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
    webhookDelayed: true }),
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
  'signup.native': read, 'signup.join': read,
  'signup.expired-intent': read, 'signup.tampered-intent': read, 'signup.replay': read,
  'pricing.base-agents': read, 'pricing.progressive': read, 'pricing.combo': read,
  'pricing.coupon-allowed': read, 'pricing.coupon-rejected': read, 'pricing.zero-total': read,
  'payment.approved': payment, 'payment.declined': rejectedPayment,
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
  'payment.refresh': Object.freeze({ ...scenarioContract('paid'), contextCount: 1, singleEffect: true }),
  'payment.two-tabs': Object.freeze({ ...scenarioContract('paid'), contextCount: 1, singleEffect: true }),
});
