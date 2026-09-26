export const BILLING_43_IDS = Object.freeze([
  'signup.native', 'signup.join', 'signup.expired-intent', 'signup.tampered-intent', 'signup.replay',
  'pricing.base-agents', 'pricing.progressive', 'pricing.combo', 'pricing.coupon-allowed', 'pricing.coupon-rejected', 'pricing.zero-total',
  'payment.approved', 'payment.declined', 'payment.abandoned', 'payment.timeout', 'payment.refresh', 'payment.two-tabs',
  'zero.authorized', 'zero.replay',
  'subscription.add-area', 'subscription.upgrade', 'subscription.downgrade', 'subscription.proration', 'subscription.renewal', 'subscription.cancellation',
  'finance.delinquency', 'finance.recovery', 'finance.partial-refund', 'finance.partial-credit', 'finance.concurrent-adjustment',
  'access.contracted', 'access.uncontracted', 'access.other-team', 'access.extras-preprocedural', 'access.hub-blocked', 'access.custom-blocked',
  'webhook.invalid-signature', 'webhook.wrong-account', 'webhook.wrong-mode', 'webhook.replay', 'webhook.reverse-order', 'webhook.retry', 'webhook.takeover',
]);

export const BILLING_43_EVIDENCE_KINDS = Object.freeze([
  'http', 'database', 'stripe', 'webhook', 'worker', 'browser',
]);

export const BILLING_43_ALLOWED_OPERATIONS = Object.freeze([
  'checkout.replay', 'checkout_session.expire', 'subscription.cancel', 'fixtures.cleanup',
]);

const ID_SET = new Set(BILLING_43_IDS);
const EVIDENCE_SET = new Set(BILLING_43_EVIDENCE_KINDS);
const OPERATION_SET = new Set(BILLING_43_ALLOWED_OPERATIONS);
const CONTRACT_KEYS = Object.freeze([
  'id', 'domain', 'maxWrites', 'allowedOperations', 'requiredEvidence', 'run',
]);

export class Billing43ContractRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = 'Billing43ContractRefusal';
    this.code = code;
  }
}

function refuse(code) {
  throw new Billing43ContractRefusal(code);
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactContractKeys(value) {
  if (!isPlainRecord(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === CONTRACT_KEYS.length && keys.every((key) =>
    typeof key === 'string' && CONTRACT_KEYS.includes(key));
}

function isDenseArray(value) {
  if (!Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === value.length + 1 && keys.includes('length') &&
    keys.every((key) => key === 'length' || (typeof key === 'string' &&
      /^(?:0|[1-9]\d*)$/u.test(key) && Number(key) < value.length));
}

function validContract(contract) {
  if (!hasExactContractKeys(contract) || !ID_SET.has(contract.id) ||
      contract.domain !== contract.id.slice(0, contract.id.indexOf('.')) ||
      !Number.isFinite(contract.maxWrites) || contract.maxWrites < 0 ||
      typeof contract.run !== 'function' || !isDenseArray(contract.allowedOperations) ||
      !isDenseArray(contract.requiredEvidence) || contract.requiredEvidence.length === 0) return false;

  const operations = contract.allowedOperations;
  if (new Set(operations).size !== operations.length ||
      operations.some((operation) => typeof operation !== 'string' || !OPERATION_SET.has(operation))) return false;

  const evidence = contract.requiredEvidence;
  return new Set(evidence).size === evidence.length &&
    evidence.every((kind) => typeof kind === 'string' && EVIDENCE_SET.has(kind));
}

export function assertBilling43ContractsComplete(domainContracts) {
  if (!Array.isArray(domainContracts)) refuse('billing_contracts_incomplete');

  const byId = new Map();
  for (const contract of domainContracts) {
    if (!isPlainRecord(contract) || typeof contract.id !== 'string' || !ID_SET.has(contract.id)) {
      refuse('billing_contracts_incomplete');
    }
    if (byId.has(contract.id)) refuse('billing_contracts_incomplete');
    if (!validContract(contract)) refuse('billing_contract_invalid');
    byId.set(contract.id, Object.freeze({
      id: contract.id,
      domain: contract.domain,
      maxWrites: contract.maxWrites,
      allowedOperations: Object.freeze([...contract.allowedOperations]),
      requiredEvidence: Object.freeze([...contract.requiredEvidence]),
      run: contract.run,
    }));
  }

  if (byId.size !== BILLING_43_IDS.length || BILLING_43_IDS.some((id) => !byId.has(id))) {
    refuse('billing_contracts_incomplete');
  }

  return Object.freeze(Object.fromEntries(BILLING_43_IDS.map((id) => [id, byId.get(id)])));
}

export function assertCompleteBilling43Contracts(domainContracts) {
  return assertBilling43ContractsComplete(domainContracts);
}

export async function runBilling43Scenario({ id, contracts, createFixture, context } = {}) {
  const registry = assertCompleteBilling43Contracts(contracts);
  if (!ID_SET.has(id) || typeof createFixture !== 'function') refuse('billing_contract_invalid');

  const contract = registry[id];
  const fixture = await createFixture({ id, contract });
  const runContext = isPlainRecord(context) ? { ...context } : {};
  runContext.id = id;
  runContext.fixture = fixture;
  return contract.run(Object.freeze(runContext));
}

export async function withCompleteBilling43Contracts(domainContracts, work) {
  const registry = assertCompleteBilling43Contracts(domainContracts);
  if (typeof work !== 'function') refuse('billing_contract_invalid');
  return work(registry);
}
