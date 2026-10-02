import { createHash } from 'node:crypto';
import { isValidStandaloneDatabasePolicy } from '../src/billing/contracts.mjs';
import { BILLING_43_IDS } from '../src/contracts/billing-43.mjs';
import { immutableVercelOrigin } from '../src/github/deployments.mjs';

import { CONTROL_REPOSITORY, CONTROL_REPOSITORY_ID } from '../src/contracts/control-identity.mjs';
const CONTROL_REF = 'refs/heads/main';
const CONTROL_WORKFLOW_PATH = '.github/workflows/validate-billing.yml';
const CONTROL_EVENT_NAME = 'workflow_dispatch';
const CANDIDATE_REPOSITORY = 'lawxcompany-stack/Plataforma-LawX';
const OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const WORKFLOW_REF = `${CONTROL_REPOSITORY}/${CONTROL_WORKFLOW_PATH}@${CONTROL_REF}`;
const SHA1 = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const DECIMAL_ID = /^[1-9][0-9]{0,19}$/u;
const SUPABASE_PROJECT_REF = /^[a-z0-9]{20}$/u;
const VERCEL_PROJECT_ID = /^prj_[A-Za-z0-9]+$/u;
const VERCEL_DEPLOYMENT_ID = /^dpl_[A-Za-z0-9]+$/u;
const STRIPE_TEST_ACCOUNT_ID = /^acct_[A-Za-z0-9_]{1,64}$/u;
const MANIFEST_MAX_BYTES = 16 * 1024;
const INPUT_MAX_BYTES = 4 * 1024 * 1024;

const CONTROL_KEYS = Object.freeze([
  'repository', 'repositoryId', 'ref', 'workflowPath', 'workflowRef',
  'workflowSha', 'runId', 'runAttempt', 'eventName',
]);
const CANDIDATE_KEYS = Object.freeze(['repository', 'pullRequestNumber', 'sha']);
const DEPLOYMENT_KEYS = Object.freeze(['id', 'origin', 'projectId', 'sha']);
const SUPABASE_KEYS = Object.freeze(['projectRef']);
const STRIPE_KEYS = Object.freeze(['accountId', 'livemode']);
const RESULT_KEYS = Object.freeze([
  'suite', 'totalCount', 'passedCount', 'failedCount', 'scenarioIdsSha256', 'resultsSha256',
]);
const MANIFEST_KEYS = Object.freeze([
  'schemaVersion', 'control', 'candidate', 'deployment', 'supabase', 'stripe', 'results',
]);
const INPUT_KEYS = Object.freeze(['results']);
const RESOLVED_DEPLOYMENT_KEYS = Object.freeze(['id', 'origin']);
const INPUT_RESULT_KEYS = Object.freeze(['id', 'status', 'evidenceSha256']);

function isSha1(value) { return typeof value === 'string' && SHA1.test(value); }
function isSha256(value) { return typeof value === 'string' && SHA256.test(value); }

// The financial result contract is intentionally distinct from the existing
// 43-case collector contract. The two separately supervised financial cases
// stay required for a complete 45-case result.
export const BILLING_RESULT_45_IDS = Object.freeze([
  ...BILLING_43_IDS.slice(0, 2),
  'signup.advbox',
  ...BILLING_43_IDS.slice(2, 13),
  'payment.3ds',
  ...BILLING_43_IDS.slice(13),
]);

const SCENARIO_IDS_SHA256 = createHash('sha256')
  .update(JSON.stringify(BILLING_RESULT_45_IDS), 'utf8')
  .digest('hex');

export class BillingResultManifestRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = 'BillingResultManifestRefusal';
    this.code = code;
  }
}

function refuse(code = 'billing_result_manifest_invalid') {
  throw new BillingResultManifestRefusal(code);
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function snapshotRecord(value, keys) {
  if (!isRecord(value)) return null;
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); }
  catch { return null; }
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) return null;
  const snapshot = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) return null;
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function snapshotDenseArray(value) {
  if (!Array.isArray(value)) return null;
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); }
  catch { return null; }
  const ownKeys = Reflect.ownKeys(descriptors);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value')) return null;
  const length = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || length < 0 || ownKeys.length !== length + 1 ||
      ownKeys.some((key) => key !== 'length' && (typeof key !== 'string' ||
        !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length))) return null;
  const snapshot = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
    snapshot.push(descriptor.value);
  }
  return snapshot;
}

function decimalId(value, maximumLength = 20) {
  return typeof value === 'string' && value.length <= maximumLength && DECIMAL_ID.test(value);
}

function validControl(value) {
  const control = snapshotRecord(value, CONTROL_KEYS);
  if (!control || control.repository !== CONTROL_REPOSITORY ||
      control.repositoryId !== CONTROL_REPOSITORY_ID || control.ref !== CONTROL_REF ||
      control.workflowPath !== CONTROL_WORKFLOW_PATH || control.workflowRef !== WORKFLOW_REF ||
      !isSha1(control.workflowSha) || !decimalId(control.runId) ||
      !decimalId(control.runAttempt, 8) || control.eventName !== CONTROL_EVENT_NAME) return null;
  return Object.freeze(control);
}

function validCandidate(value) {
  const candidate = snapshotRecord(value, CANDIDATE_KEYS);
  if (!candidate || candidate.repository !== CANDIDATE_REPOSITORY ||
      !decimalId(candidate.pullRequestNumber, 10) || !isSha1(candidate.sha)) return null;
  return Object.freeze(candidate);
}

function validDeployment(value, candidateSha, expectedProjectId) {
  const deployment = snapshotRecord(value, DEPLOYMENT_KEYS);
  if (!deployment || typeof deployment.id !== 'string' || !VERCEL_DEPLOYMENT_ID.test(deployment.id) ||
      immutableVercelOrigin(deployment.origin) !== deployment.origin ||
      typeof deployment.projectId !== 'string' || !VERCEL_PROJECT_ID.test(deployment.projectId) ||
      (expectedProjectId !== undefined && deployment.projectId !== expectedProjectId) ||
      !isSha1(deployment.sha) || deployment.sha !== candidateSha) return null;
  return Object.freeze(deployment);
}

function validSupabase(value, expectedProjectRef) {
  const supabase = snapshotRecord(value, SUPABASE_KEYS);
  if (!supabase || typeof supabase.projectRef !== 'string' || !SUPABASE_PROJECT_REF.test(supabase.projectRef) ||
      (expectedProjectRef !== undefined && supabase.projectRef !== expectedProjectRef)) return null;
  return Object.freeze(supabase);
}

function validStripe(value, expectedAccountId) {
  const stripe = snapshotRecord(value, STRIPE_KEYS);
  if (!stripe || typeof stripe.accountId !== 'string' || !STRIPE_TEST_ACCOUNT_ID.test(stripe.accountId) || stripe.livemode !== false ||
      (expectedAccountId !== undefined && stripe.accountId !== expectedAccountId)) return null;
  return Object.freeze(stripe);
}

function snapshotTrustedContext(value) {
  const context = snapshotRecord(value, [
    'control', 'candidate', 'candidateTreeSha', 'vercelProjectId', 'supabaseProjectRef', 'stripeAccountId',
  ]);
  if (!context) return null;
  const control = validControl(context.control);
  const candidate = validCandidate(context.candidate);
  if (!control || !candidate || typeof context.vercelProjectId !== 'string' ||
      !VERCEL_PROJECT_ID.test(context.vercelProjectId) || typeof context.supabaseProjectRef !== 'string' ||
      !SUPABASE_PROJECT_REF.test(context.supabaseProjectRef) || typeof context.stripeAccountId !== 'string' ||
      !STRIPE_TEST_ACCOUNT_ID.test(context.stripeAccountId) || !isSha1(context.candidateTreeSha)) return null;
  return Object.freeze({
    control,
    candidate,
    candidateTreeSha: context.candidateTreeSha,
    vercelProjectId: context.vercelProjectId,
    supabaseProjectRef: context.supabaseProjectRef,
    stripeAccountId: context.stripeAccountId,
  });
}

function workflowString(environment, key) {
  const value = environment[key];
  return typeof value === 'string' ? value : '';
}

export function createBillingResultTrustedContext(environment, policy) {
  if (!isRecord(environment) || !isRecord(policy) || policy.environment !== 'billing-validation' ||
      !isRecord(policy.vercel) || !isRecord(policy.database) || !isRecord(policy.stripe) ||
      !isValidStandaloneDatabasePolicy(policy.database) ||
      policy.stripe.livemode !== false) refuse();

  const workflowRef = `${CONTROL_REPOSITORY}/${CONTROL_WORKFLOW_PATH}@${CONTROL_REF}`;
  if (workflowString(environment, 'CONTROL_REPOSITORY') !== CONTROL_REPOSITORY ||
      workflowString(environment, 'CONTROL_REPOSITORY_ID') !== CONTROL_REPOSITORY_ID ||
      workflowString(environment, 'CONTROL_REF') !== CONTROL_REF ||
      workflowString(environment, 'CONTROL_DEFAULT_BRANCH') !== 'main' ||
      workflowString(environment, 'CONTROL_REF_PROTECTED') !== 'true' ||
      workflowString(environment, 'CONTROL_WORKFLOW_REF') !== workflowRef ||
      workflowString(environment, 'CONTROL_EVENT_NAME') !== CONTROL_EVENT_NAME ||
      workflowString(environment, 'CANDIDATE_SHA') !== workflowString(environment, 'READER_CANDIDATE_SHA') ||
      !isSha1(workflowString(environment, 'READER_CANDIDATE_TREE_SHA'))) refuse();

  const control = {
    repository: CONTROL_REPOSITORY,
    repositoryId: CONTROL_REPOSITORY_ID,
    ref: CONTROL_REF,
    workflowPath: CONTROL_WORKFLOW_PATH,
    workflowRef,
    workflowSha: workflowString(environment, 'CONTROL_WORKFLOW_SHA'),
    runId: workflowString(environment, 'CONTROL_RUN_ID'),
    runAttempt: workflowString(environment, 'CONTROL_RUN_ATTEMPT'),
    eventName: CONTROL_EVENT_NAME,
  };
  const candidate = {
    repository: CANDIDATE_REPOSITORY,
    pullRequestNumber: workflowString(environment, 'CANDIDATE_PULL_NUMBER'),
    sha: workflowString(environment, 'CANDIDATE_SHA'),
  };
  return snapshotTrustedContext({
    control,
    candidate,
    candidateTreeSha: workflowString(environment, 'READER_CANDIDATE_TREE_SHA'),
    vercelProjectId: policy.vercel.projectId,
    supabaseProjectRef: policy.database.projectRef,
    stripeAccountId: policy.stripe.accountId,
  }) ?? refuse();
}

function snapshotResults(value) {
  const results = snapshotDenseArray(value);
  if (!results || results.length !== BILLING_RESULT_45_IDS.length) {
    refuse('billing_result_suite_incomplete');
  }
  const normalized = [];
  for (let index = 0; index < BILLING_RESULT_45_IDS.length; index += 1) {
    const result = snapshotRecord(results[index], INPUT_RESULT_KEYS);
    if (!result || result.id !== BILLING_RESULT_45_IDS[index] || result.status !== 'passed' ||
        !isSha256(result.evidenceSha256)) refuse();
    normalized.push(Object.freeze({
      id: result.id,
      status: 'passed',
      evidenceSha256: result.evidenceSha256,
    }));
  }
  return Object.freeze(normalized);
}

function resultSummary(results) {
  return Object.freeze({
    suite: 'billing-45',
    totalCount: BILLING_RESULT_45_IDS.length,
    passedCount: BILLING_RESULT_45_IDS.length,
    failedCount: 0,
    scenarioIdsSha256: SCENARIO_IDS_SHA256,
    resultsSha256: createHash('sha256').update(JSON.stringify(results), 'utf8').digest('hex'),
  });
}

export function validateBillingResultInput(value) {
  if (!isRecord(value)) refuse();
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); }
  catch { refuse(); }
  if (!descriptors.results || !Object.hasOwn(descriptors.results, 'value')) {
    refuse('billing_result_suite_incomplete');
  }
  const input = snapshotRecord(value, INPUT_KEYS);
  if (!input) refuse();
  return Object.freeze({ results: snapshotResults(input.results) });
}

function snapshotManifest(value) {
  const manifest = snapshotRecord(value, MANIFEST_KEYS);
  if (!manifest || manifest.schemaVersion !== 1) return null;
  const control = validControl(manifest.control);
  const candidate = validCandidate(manifest.candidate);
  const deployment = validDeployment(manifest.deployment, candidate?.sha);
  const supabase = validSupabase(manifest.supabase);
  const stripe = validStripe(manifest.stripe);
  const result = snapshotRecord(manifest.results, RESULT_KEYS);
  if (!control || !candidate || !deployment || !supabase || !stripe || !result ||
      result.suite !== 'billing-45' || result.totalCount !== 45 || result.passedCount !== 45 ||
      result.failedCount !== 0 || result.scenarioIdsSha256 !== SCENARIO_IDS_SHA256 ||
      !isSha256(result.resultsSha256)) return null;
  return Object.freeze({
    schemaVersion: 1,
    control,
    candidate,
    deployment,
    supabase,
    stripe,
    results: Object.freeze({
      suite: result.suite,
      totalCount: result.totalCount,
      passedCount: result.passedCount,
      failedCount: result.failedCount,
      scenarioIdsSha256: result.scenarioIdsSha256,
      resultsSha256: result.resultsSha256,
    }),
  });
}

export function createBillingResultManifest(input, trustedContext, resolvedDeploymentInput) {
  const source = validateBillingResultInput(input);
  const trusted = snapshotTrustedContext(trustedContext);
  const resolvedDeployment = snapshotRecord(resolvedDeploymentInput, RESOLVED_DEPLOYMENT_KEYS);
  if (!trusted) refuse();
  if (!resolvedDeployment) refuse('billing_result_deployment_proof_unavailable');
  const deployment = validDeployment({
    id: resolvedDeployment.id,
    origin: resolvedDeployment.origin,
    projectId: trusted.vercelProjectId,
    sha: trusted.candidate.sha,
  }, trusted.candidate.sha, trusted.vercelProjectId);
  if (!deployment) refuse('billing_result_deployment_proof_invalid');

  return snapshotManifest({
    schemaVersion: 1,
    control: trusted.control,
    candidate: trusted.candidate,
    deployment,
    supabase: { projectRef: trusted.supabaseProjectRef },
    stripe: { accountId: trusted.stripeAccountId, livemode: false },
    results: resultSummary(source.results),
  }) ?? refuse();
}

export function serializeBillingResultManifest(input) {
  const manifest = snapshotManifest(input);
  if (!manifest) refuse();
  return `${JSON.stringify(manifest)}\n`;
}

export function parseCanonicalBillingResultManifest(input) {
  let bytes;
  if (typeof input === 'string') bytes = Buffer.from(input, 'utf8');
  else if (input instanceof Uint8Array) bytes = Buffer.from(input);
  else refuse('billing_result_manifest_noncanonical');
  if (bytes.byteLength === 0 || bytes.byteLength > MANIFEST_MAX_BYTES) refuse('billing_result_manifest_noncanonical');
  let text;
  let parsed;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    refuse('billing_result_manifest_noncanonical');
  }
  const manifest = snapshotManifest(parsed);
  if (!manifest || serializeBillingResultManifest(manifest) !== text) refuse('billing_result_manifest_noncanonical');
  return manifest;
}

export function assertBillingResultManifestMatchesContext(manifestInput, trustedContextInput) {
  const manifest = snapshotManifest(manifestInput);
  const trusted = snapshotTrustedContext(trustedContextInput);
  if (!manifest || !trusted ||
      JSON.stringify(manifest.control) !== JSON.stringify(trusted.control) ||
      JSON.stringify(manifest.candidate) !== JSON.stringify(trusted.candidate) ||
      manifest.deployment.projectId !== trusted.vercelProjectId ||
      manifest.supabase.projectRef !== trusted.supabaseProjectRef ||
      manifest.stripe.accountId !== trusted.stripeAccountId) refuse();
  return manifest;
}

export function billingResultManifestKeys() {
  return [...MANIFEST_KEYS];
}

export const BILLING_RESULT_MANIFEST_LIMITS = Object.freeze({ manifestBytes: MANIFEST_MAX_BYTES, inputBytes: INPUT_MAX_BYTES });
export const BILLING_RESULT_OIDC_ISSUER = OIDC_ISSUER;
