import { BILLING_43_IDS } from '../../contracts/billing-43.mjs';

const CANONICAL_IDS = new Set(BILLING_43_IDS);
const EMPTY_OPERATIONS = Object.freeze([]);
const DOMAIN = /^[a-z][a-z0-9]*$/u;
const REASON_CODE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/u;

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

export function defineBlockedScenarioContracts(domain, definitions) {
  if (typeof domain !== 'string' || !DOMAIN.test(domain) || definitions === null ||
      typeof definitions !== 'object' || Array.isArray(definitions)) {
    refuse('billing_scenario_contract_invalid');
  }

  const contracts = Object.create(null);
  for (const [id, definition] of Object.entries(definitions)) {
    if (!CANONICAL_IDS.has(id) || id.slice(0, id.indexOf('.')) !== domain ||
        definition === null || typeof definition !== 'object' || Array.isArray(definition) ||
        !REASON_CODE.test(definition.reasonCode) || !definition.reasonCode.startsWith(`${domain}_`) ||
        !Array.isArray(definition.blockedBy) || definition.blockedBy.length === 0 ||
        definition.blockedBy.some((reason) => typeof reason !== 'string' || !REASON_CODE.test(reason)) ||
        new Set(definition.blockedBy).size !== definition.blockedBy.length) {
      refuse('billing_scenario_contract_invalid');
    }

    contracts[id] = Object.freeze({
      id,
      domain,
      disposition: 'blocked',
      reasonCode: definition.reasonCode,
      blockedBy: Object.freeze([...definition.blockedBy]),
      maxWrites: 0,
      allowedOperations: EMPTY_OPERATIONS,
    });
  }

  if (Object.keys(contracts).length === 0) refuse('billing_scenario_contract_invalid');
  return Object.freeze(contracts);
}

export function runBlockedBillingScenario(contracts, id, _effects = undefined) {
  if (typeof id !== 'string' || !CANONICAL_IDS.has(id)) refuse('billing_scenario_unsupported');
  const contract = contracts?.[id];
  if (!contract || contract.id !== id || contract.disposition !== 'blocked' ||
      !REASON_CODE.test(contract.reasonCode) || contract.maxWrites !== 0 ||
      !Array.isArray(contract.allowedOperations) || contract.allowedOperations.length !== 0) {
    refuse('billing_scenario_contract_invalid');
  }
  refuse(contract.reasonCode);
}
