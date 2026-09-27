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

export const BILLING_43_TASK5_IDS = Object.freeze([
  'signup.native', 'signup.join', 'signup.expired-intent', 'signup.tampered-intent', 'signup.replay',
  'pricing.base-agents', 'pricing.progressive', 'pricing.combo', 'pricing.coupon-allowed', 'pricing.coupon-rejected', 'pricing.zero-total',
  'payment.approved', 'payment.declined', 'payment.abandoned', 'payment.timeout', 'payment.refresh', 'payment.two-tabs',
  'zero.authorized', 'zero.replay',
]);

export const BILLING_43_EVIDENCE_KINDS = Object.freeze([
  'http', 'database', 'stripe', 'webhook', 'worker', 'browser',
]);

export const BILLING_43_ALLOWED_OPERATIONS = Object.freeze([
  'checkout.replay', 'checkout_session.expire', 'subscription.cancel', 'fixtures.cleanup',
]);

const ID_SET = new Set(BILLING_43_IDS);
const TASK5_BLOCKED_ID_SET = new Set(BILLING_43_TASK5_IDS);
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

function snapshotDenseArray(value) {
  if (!Array.isArray(value)) return null;
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); }
  catch { return null; }

  const keys = Reflect.ownKeys(descriptors);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value')) return null;
  const length = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || length < 0 || keys.length !== length + 1 ||
      keys.some((key) => key !== 'length' && (typeof key !== 'string' ||
        !/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= length))) return null;

  const snapshot = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
    snapshot.push(descriptor.value);
  }
  return Object.freeze(snapshot);
}

function snapshotContract(value) {
  let plainRecord;
  try { plainRecord = isPlainRecord(value); }
  catch { return null; }
  if (!plainRecord) return null;

  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); }
  catch { return null; }
  const keys = Reflect.ownKeys(descriptors);
  const exactKeys = keys.length === CONTRACT_KEYS.length && keys.every((key) =>
    typeof key === 'string' && CONTRACT_KEYS.includes(key));
  if (!exactKeys) {
    const idDescriptor = descriptors.id;
    const id = idDescriptor && Object.hasOwn(idDescriptor, 'value') ? idDescriptor.value : undefined;
    return { id, contract: null };
  }

  const fields = Object.create(null);
  let id;
  for (const key of CONTRACT_KEYS) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return { id, contract: null };
    const field = descriptor.value;
    fields[key] = field;
    if (key === 'id') id = field;
  }

  const allowedOperations = snapshotDenseArray(fields.allowedOperations);
  const requiredEvidence = snapshotDenseArray(fields.requiredEvidence);
  if (!allowedOperations || !requiredEvidence) return { id, contract: null };

  return {
    id,
    contract: Object.freeze({
      id,
      domain: fields.domain,
      maxWrites: fields.maxWrites,
      allowedOperations,
      requiredEvidence,
      run: fields.run,
    }),
  };
}

function validContract(contract) {
  if (contract.domain !== contract.id.slice(0, contract.id.indexOf('.')) ||
      !Number.isFinite(contract.maxWrites) || contract.maxWrites < 0 ||
      typeof contract.run !== 'function' || contract.requiredEvidence.length === 0) return false;

  const operations = contract.allowedOperations;
  if (new Set(operations).size !== operations.length ||
      operations.some((operation) => typeof operation !== 'string' || !OPERATION_SET.has(operation))) return false;

  const evidence = contract.requiredEvidence;
  return new Set(evidence).size === evidence.length &&
    evidence.every((kind) => typeof kind === 'string' && EVIDENCE_SET.has(kind));
}

export function assertBilling43ContractsComplete(domainContracts) {
  const contractList = snapshotDenseArray(domainContracts);
  if (!contractList) refuse('billing_contracts_incomplete');

  const byId = new Map();
  for (const candidate of contractList) {
    const captured = snapshotContract(candidate);
    if (!captured || typeof captured.id !== 'string' || !ID_SET.has(captured.id)) {
      refuse('billing_contracts_incomplete');
    }
    if (byId.has(captured.id)) refuse('billing_contracts_incomplete');
    if (!captured.contract || !validContract(captured.contract)) refuse('billing_contract_invalid');
    byId.set(captured.id, captured.contract);
  }

  if (byId.size !== BILLING_43_IDS.length || BILLING_43_IDS.some((id) => !byId.has(id))) {
    refuse('billing_contracts_incomplete');
  }

  return Object.freeze(Object.fromEntries(BILLING_43_IDS.map((id) => [id, byId.get(id)])));
}

export function assertCompleteBilling43Contracts(domainContracts) {
  if (!Array.isArray(domainContracts)) {
    if (!isPlainRecord(domainContracts)) refuse('billing_contracts_incomplete');
    let descriptors;
    try { descriptors = Object.getOwnPropertyDescriptors(domainContracts); }
    catch { refuse('billing_contracts_incomplete'); }
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== BILLING_43_IDS.length ||
        keys.some((key) => typeof key !== 'string' || !ID_SET.has(key))) {
      refuse('billing_contracts_incomplete');
    }

    const orderedContracts = BILLING_43_IDS.map((id) => {
      const descriptor = descriptors[id];
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        refuse('billing_contracts_incomplete');
      }
      return descriptor.value;
    });
    const registry = assertBilling43ContractsComplete(orderedContracts);
    if (BILLING_43_IDS.some((id) => registry[id].id !== id)) refuse('billing_contracts_incomplete');
    return registry;
  }
  return assertBilling43ContractsComplete(domainContracts);
}

export async function runBilling43Scenario({ id, contracts, createFixture, context } = {}) {
  const registry = assertCompleteBilling43Contracts(contracts);
  if (!ID_SET.has(id) || typeof createFixture !== 'function') refuse('billing_contract_invalid');
  if (TASK5_BLOCKED_ID_SET.has(id)) refuse('billing_scenario_blocked');

  const contract = registry[id];
  const fixture = await createFixture({ id, contract });
  const runContext = isPlainRecord(context) ? { ...context } : {};
  runContext.id = id;
  runContext.fixture = fixture;
  runContext.contracts = registry;
  return contract.run(Object.freeze(runContext));
}

export async function withCompleteBilling43Contracts(domainContracts, work) {
  const registry = assertCompleteBilling43Contracts(domainContracts);
  if (typeof work !== 'function') refuse('billing_contract_invalid');
  return work(registry);
}
