import { createPublicKey } from 'node:crypto';
import { createRequire } from 'node:module';
import { isValidBillingEnvironment, isValidStandaloneDatabasePolicy } from '../billing/contracts.mjs';
import { resolvePreviewDeployment } from '../github/deployments.mjs';
import { verifyDeploymentAttestation } from './vercel.mjs';
import { assertSupabaseRuntimeConfiguration, verifySupabaseEnvironment } from './supabase.mjs';
import { verifyStripeEnvironment } from './stripe.mjs';

const require = createRequire(import.meta.url);
const DEFAULT_POLICY = require('../../policy/environment-policy.json');
const POLICY_KEYS = ['schema_version', 'environment', 'vercel', 'database', 'stripe', 'attestation'];
const ID_PATTERN = {
  projectId: /^prj_[A-Za-z0-9]+$/u,
  teamId: /^team_[A-Za-z0-9]+$/u,
  accountId: /^acct_[A-Za-z0-9_]+$/u,
  webhookEndpointId: /^we_[A-Za-z0-9]+$/u,
};

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
  if (!exactKeys(policy, POLICY_KEYS) || policy.schema_version !== 3 || policy.environment !== 'billing-validation' ||
      !exactKeys(policy.vercel, ['projectId', 'teamId']) ||
      !isValidStandaloneDatabasePolicy(policy.database) ||
      !exactKeys(policy.stripe, ['accountId', 'webhookEndpointId', 'livemode']) ||
      !exactKeys(policy.attestation, ['publicKeyPem'])) return false;

  return nullableMatch(policy.vercel.projectId, ID_PATTERN.projectId) &&
    nullableMatch(policy.vercel.teamId, ID_PATTERN.teamId) &&
    nullableMatch(policy.stripe.accountId, ID_PATTERN.accountId) && policy.stripe.accountId !== 'platform' &&
    nullableMatch(policy.stripe.webhookEndpointId, ID_PATTERN.webhookEndpointId) &&
    policy.stripe.livemode === false && validPublicKey(policy.attestation.publicKeyPem);
}

function hasRequiredTaskIdentities(policy) {
  return policy.vercel.projectId !== null && policy.vercel.teamId !== null &&
    isValidStandaloneDatabasePolicy(policy.database, { configured: true }) &&
    policy.stripe.accountId !== null && policy.stripe.webhookEndpointId !== null &&
    policy.attestation.publicKeyPem !== null;
}

export async function preflightRuntime(options = {}) {
  if (!isObject(options) || Object.keys(options).some((key) =>
    !['api', 'candidate', 'policy', 'fetchImpl', 'now', 'supabaseToken', 'stripeKey', 'trustedConfiguration'].includes(key))) refuse('preflight_input_invalid');
  const { api, candidate, fetchImpl, now, supabaseToken, stripeKey, trustedConfiguration } = options;
  const policy = options.policy ?? DEFAULT_POLICY;
  if (!validateEnvironmentPolicy(policy)) refuse('environment_policy_invalid');
  if (!hasRequiredTaskIdentities(policy)) refuse('environment_policy_unconfigured');
  const database = assertSupabaseRuntimeConfiguration({ policy, token: supabaseToken, trustedConfiguration, fetchImpl });
  // Snapshot the trusted pin before any asynchronous metadata operation.
  const pinnedPolicy = { ...policy, database };
  if (!candidate || typeof candidate.candidateSha !== 'string' || typeof candidate.treeSha !== 'string') {
    refuse('preflight_candidate_invalid');
  }

  const deployment = await resolvePreviewDeployment({ api, candidate, policy });
  const deploymentAttestation = await verifyDeploymentAttestation({ deployment, candidate, policy: pinnedPolicy, fetchImpl, now });

  const expectedEnvironment = Object.freeze({
    database: Object.freeze({ projectRef: database.projectRef }),
    deployment,
    stripe: Object.freeze({ accountId: policy.stripe.accountId }),
  });
  if (!isValidBillingEnvironment(expectedEnvironment)) refuse('environment_identity_invalid');

  const supabase = await verifySupabaseEnvironment({ policy: pinnedPolicy, token: supabaseToken, trustedConfiguration, fetchImpl });
  const stripe = await verifyStripeEnvironment({ policy, deployment, key: stripeKey, fetchImpl });
  return Object.freeze({ expectedEnvironment, providerVerification: Object.freeze({ supabase, stripe }),
    candidate: Object.freeze({ candidateSha: candidate.candidateSha, treeSha: candidate.treeSha }),
    deploymentAttestation });
}
