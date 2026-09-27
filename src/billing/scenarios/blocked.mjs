import { BILLING_43_IDS } from '../../contracts/billing-43.mjs';

const CANONICAL_IDS = new Set(BILLING_43_IDS);
const EMPTY_OPERATIONS = Object.freeze([]);
const DOMAIN = /^[a-z][a-z0-9]*$/u;
const REASON_CODE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/u;
const DEFINITION_KEYS = Object.freeze(['reasonCode', 'blockedBy']);
const CONTRACT_KEYS = Object.freeze(['id', 'domain', 'disposition', 'reasonCode', 'blockedBy',
  'maxWrites', 'allowedOperations']);

export class BillingScenarioBlocked extends Error {
  constructor(reasonCode) {
    super(reasonCode);
    this.name = 'BillingScenarioBlocked';
    this.code = reasonCode;
  }
}

function refuse(code) {
  throw new BillingScenarioBlocked(code);
}

function snapshotPlainDataRecord(value, exactKeys = undefined) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== 'string') ||
        (exactKeys && (keys.length !== exactKeys.length || exactKeys.some((key) => !keys.includes(key))))) return null;

    const snapshot = Object.create(null);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) return null;
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch { return null; }
}

function snapshotStringArray(value, { allowEmpty = false } = {}) {
  try {
    if (!Array.isArray(value)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    const lengthDescriptor = descriptors.length;
    if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value')) return null;
    const length = lengthDescriptor.value;
    if (!Number.isSafeInteger(length) || length < (allowEmpty ? 0 : 1) || keys.length !== length + 1 ||
        keys.some((key) => key !== 'length' && (typeof key !== 'string' ||
          !/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= length))) return null;

    const snapshot = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true ||
          typeof descriptor.value !== 'string' || !REASON_CODE.test(descriptor.value)) return null;
      snapshot.push(descriptor.value);
    }
    return Object.freeze(snapshot);
  } catch { return null; }
}

export function defineBlockedScenarioContracts(domain, definitions) {
  const definitionMap = snapshotPlainDataRecord(definitions);
  if (typeof domain !== 'string' || !DOMAIN.test(domain) || !definitionMap) {
    refuse('billing_scenario_contract_invalid');
  }

  const contracts = Object.create(null);
  for (const [id, rawDefinition] of Object.entries(definitionMap)) {
    const definition = snapshotPlainDataRecord(rawDefinition, DEFINITION_KEYS);
    const blockedBy = definition && snapshotStringArray(definition.blockedBy);
    if (!CANONICAL_IDS.has(id) || id.slice(0, id.indexOf('.')) !== domain || !definition ||
        !REASON_CODE.test(definition.reasonCode) || !definition.reasonCode.startsWith(`${domain}_`) ||
        !blockedBy || new Set(blockedBy).size !== blockedBy.length) {
      refuse('billing_scenario_contract_invalid');
    }

    contracts[id] = Object.freeze({
      id,
      domain,
      disposition: 'blocked',
      reasonCode: definition.reasonCode,
      blockedBy,
      maxWrites: 0,
      allowedOperations: EMPTY_OPERATIONS,
    });
  }

  if (Object.keys(contracts).length === 0) refuse('billing_scenario_contract_invalid');
  return Object.freeze(contracts);
}

export function runBlockedBillingScenario(contracts, id, _effects = undefined) {
  if (typeof id !== 'string' || !CANONICAL_IDS.has(id)) refuse('billing_scenario_unsupported');
  const contractMap = snapshotPlainDataRecord(contracts);
  const contract = contractMap?.[id] && snapshotPlainDataRecord(contractMap[id], CONTRACT_KEYS);
  const blockedBy = contract && snapshotStringArray(contract.blockedBy);
  const allowedOperations = contract && snapshotStringArray(contract.allowedOperations, { allowEmpty: true });
  if (!contract || contract.id !== id || contract.domain !== id.slice(0, id.indexOf('.')) ||
      contract.disposition !== 'blocked' || !REASON_CODE.test(contract.reasonCode) ||
      !contract.reasonCode.startsWith(`${contract.domain}_`) || !blockedBy ||
      new Set(blockedBy).size !== blockedBy.length || contract.maxWrites !== 0 ||
      !allowedOperations || allowedOperations.length !== 0) {
    refuse('billing_scenario_contract_invalid');
  }
  refuse(contract.reasonCode);
}
