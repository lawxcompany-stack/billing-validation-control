import { createPublicKey } from 'node:crypto';
import { createRequire } from 'node:module';
import { isValidExpectedEnvironment } from '../contracts/evidence.mjs';
import { resolvePreviewDeployment } from '../github/deployments.mjs';
import { verifyDeploymentAttestation } from './vercel.mjs';

const require = createRequire(import.meta.url);
const DEFAULT_POLICY = require('../../policy/environment-policy.json');
const POLICY_KEYS = ['schema_version', 'environment', 'vercel', 'database', 'stripe', 'attestation'];
const ID_PATTERN = {
  projectId: /^prj_[A-Za-z0-9]+$/u,
  teamId: /^team_[A-Za-z0-9]+$/u,
  projectRef: /^[a-z0-9]{20}$/u,
  branchId: /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u,
  branchName: /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u,
  accountId: /^acct_[A-Za-z0-9_]+$/u,
  webhookEndpointId: /^we_[A-Za-z0-9]+$/u,
};
const PRODUCTION_BRANCH_LABELS = new Set(['main', 'master', 'prod', 'production', 'primary', 'default']);
const PRODUCTION_BRANCH_PART = /(?:^|[-_.])(?:main|master|prod|production|primary|default)(?:$|[-_.])/u;

export class PreflightRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = 'PreflightRefusal';
    this.code = code;
  }
}

function refuse(code) {
  throw new PreflightRefusal(code);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function nullableMatch(value, pattern) {
  return value === null || typeof value === 'string' && pattern.test(value);
}

function validPublicKey(value) {
  if (value === null) return true;
  if (typeof value !== 'string' || !value.startsWith('-----BEGIN PUBLIC KEY-----\n') || value.includes('PRIVATE KEY')) return false;
  try {
    return createPublicKey(value).asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}

export function validateEnvironmentPolicy(policy) {
  if (!exactKeys(policy, POLICY_KEYS) || policy.schema_version !== 1 || policy.environment !== 'billing-validation' ||
      !exactKeys(policy.vercel, ['projectId', 'teamId']) ||
      !exactKeys(policy.database, ['projectRef', 'branchId', 'branchName']) ||
      !exactKeys(policy.stripe, ['accountId', 'webhookEndpointId', 'livemode']) ||
      !exactKeys(policy.attestation, ['publicKeyPem'])) return false;

  const branchIdLabel = typeof policy.database.branchId === 'string' ? policy.database.branchId.toLowerCase() : '';
  const branchNameLabel = typeof policy.database.branchName === 'string' ? policy.database.branchName.toLowerCase() : '';
  return nullableMatch(policy.vercel.projectId, ID_PATTERN.projectId) &&
    nullableMatch(policy.vercel.teamId, ID_PATTERN.teamId) &&
    nullableMatch(policy.database.projectRef, ID_PATTERN.projectRef) &&
    nullableMatch(policy.database.branchId, ID_PATTERN.branchId) &&
    nullableMatch(policy.database.branchName, ID_PATTERN.branchName) &&
    !PRODUCTION_BRANCH_LABELS.has(branchIdLabel) && !PRODUCTION_BRANCH_LABELS.has(branchNameLabel) &&
    !PRODUCTION_BRANCH_PART.test(branchIdLabel) && !PRODUCTION_BRANCH_PART.test(branchNameLabel) &&
    nullableMatch(policy.stripe.accountId, ID_PATTERN.accountId) && policy.stripe.accountId !== 'platform' &&
    nullableMatch(policy.stripe.webhookEndpointId, ID_PATTERN.webhookEndpointId) &&
    policy.stripe.livemode === false && validPublicKey(policy.attestation.publicKeyPem);
}

function hasRequiredTaskIdentities(policy) {
  return policy.vercel.projectId !== null && policy.vercel.teamId !== null &&
    policy.database.projectRef !== null && policy.database.branchId !== null && policy.database.branchName !== null &&
    policy.stripe.accountId !== null && policy.attestation.publicKeyPem !== null;
}

export async function preflightRuntime(options = {}) {
  if (!isObject(options) || Object.keys(options).some((key) =>
    !['api', 'candidate', 'policy', 'fetchImpl', 'now'].includes(key))) refuse('preflight_input_invalid');
  const { api, candidate, fetchImpl, now } = options;
  const policy = options.policy ?? DEFAULT_POLICY;
  if (!validateEnvironmentPolicy(policy)) refuse('environment_policy_invalid');
  if (!hasRequiredTaskIdentities(policy)) refuse('environment_policy_unconfigured');
  if (!candidate || typeof candidate.candidateSha !== 'string' || typeof candidate.treeSha !== 'string') {
    refuse('preflight_candidate_invalid');
  }

  const deployment = await resolvePreviewDeployment({ api, candidate, policy });
  await verifyDeploymentAttestation({ deployment, candidate, policy, fetchImpl, now });

  const expectedEnvironment = Object.freeze({
    database: Object.freeze({ projectRef: policy.database.projectRef, branchId: policy.database.branchId }),
    deployment,
    stripe: Object.freeze({ accountId: policy.stripe.accountId }),
  });
  if (!isValidExpectedEnvironment(expectedEnvironment)) refuse('environment_identity_invalid');

  return Object.freeze({ expectedEnvironment });
}
