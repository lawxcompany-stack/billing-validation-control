import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parseCanonicalActivationManifest,
  serializeActivationManifest,
} from './activation-manifest.mjs';

const CONTROL_REPOSITORY = 'lawxcompany-stack/billing-validation-control';
const CONTROL_WORKFLOW_PATH = '.github/workflows/validate-billing.yml';
const CONTROL_REF = 'refs/heads/main';
const OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const SLSA_PROVENANCE_TYPE = 'https://slsa.dev/provenance/v1';
const MAX_OUTPUT_BYTES = 512 * 1024;
const VERIFY_TIMEOUT_MS = 30_000;

export class ActivationVerifierRefusal extends Error {
  constructor() {
    super('activation_attestation_invalid');
    this.name = 'ActivationVerifierRefusal';
    this.code = 'activation_attestation_invalid';
  }
}

function refuse() {
  throw new ActivationVerifierRefusal();
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function expectedIdentity(manifest) {
  const repositoryUri = `https://github.com/${CONTROL_REPOSITORY}`;
  const workflowUri = `${repositoryUri}/${CONTROL_WORKFLOW_PATH}`;
  const workflowIdentity = `${workflowUri}@${CONTROL_REF}`;
  const runInvocationUri = `${repositoryUri}/actions/runs/${manifest.runId}/attempts/${manifest.runAttempt}`;
  return { repositoryUri, workflowUri, workflowIdentity, runInvocationUri };
}

function validVerifiedTimestamp(timestamp) {
  if (!isRecord(timestamp) || typeof timestamp.type !== 'string' ||
      !/^[A-Za-z0-9._-]{1,64}$/u.test(timestamp.type) || typeof timestamp.uri !== 'string' ||
      timestamp.uri.length > 2048 || typeof timestamp.timestamp !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(timestamp.timestamp) ||
      !Number.isFinite(Date.parse(timestamp.timestamp))) return false;
  try {
    const uri = new URL(timestamp.uri);
    return uri.protocol === 'https:' && uri.hostname.length > 0 && !uri.username && !uri.password;
  } catch {
    return false;
  }
}

function verifyCertificate(certificate, manifest, reviewedControlRepositoryId) {
  if (!isRecord(certificate)) refuse();
  const expected = expectedIdentity(manifest);
  if (certificate.issuer !== OIDC_ISSUER || certificate.subjectAlternativeName !== expected.workflowIdentity ||
      certificate.buildSignerURI !== expected.workflowIdentity ||
      certificate.buildSignerDigest !== manifest.controlWorkflowSha ||
      certificate.runInvocationURI !== expected.runInvocationUri ||
      certificate.sourceRepositoryURI !== expected.repositoryUri ||
      certificate.sourceRepositoryIdentifier !== reviewedControlRepositoryId ||
      certificate.sourceRepositoryRef !== CONTROL_REF ||
      certificate.sourceRepositoryDigest !== manifest.controlWorkflowSha ||
      certificate.githubWorkflowTrigger !== 'workflow_dispatch' ||
      certificate.githubWorkflowRef !== CONTROL_REF ||
      certificate.githubWorkflowSHA !== manifest.controlWorkflowSha ||
      certificate.runnerEnvironment !== 'github-hosted') {
    refuse();
  }
}

function verifiedSubjectDigest(verificationResult) {
  const statement = verificationResult?.statement;
  const subjects = statement?.subject;
  if (!isRecord(statement) || !Array.isArray(subjects) || subjects.length !== 1 ||
      !isRecord(subjects[0]) || !isRecord(subjects[0].digest) ||
      typeof subjects[0].digest.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(subjects[0].digest.sha256) ||
      statement.predicateType !== SLSA_PROVENANCE_TYPE) {
    refuse();
  }
  return subjects[0].digest.sha256;
}

function parseAndValidateOutput(stdout, expectedDigest, manifest, reviewedControlRepositoryId) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout, 'utf8') > MAX_OUTPUT_BYTES) refuse();
  let results;
  try { results = JSON.parse(stdout); } catch { refuse(); }
  if (!Array.isArray(results) || results.length !== 1 || !isRecord(results[0]) ||
      !isRecord(results[0].attestation) || !isRecord(results[0].verificationResult)) {
    refuse();
  }
  const verificationResult = results[0].verificationResult;
  if (!isRecord(verificationResult.signature) || !Array.isArray(verificationResult.verifiedTimestamps) ||
      verificationResult.verifiedTimestamps.length === 0 ||
      verificationResult.verifiedTimestamps.length > 16 ||
      !verificationResult.verifiedTimestamps.every(validVerifiedTimestamp)) {
    refuse();
  }
  verifyCertificate(verificationResult.signature.certificate, manifest, reviewedControlRepositoryId);
  if (verifiedSubjectDigest(verificationResult) !== expectedDigest) refuse();
}

// Internal seam for deterministic tests only. Production never accepts either
// of these trust inputs; see activation-verifier.mjs.
export async function verifyActivationAttestationWithBoundary({ manifest, processBoundary,
  reviewedControlRepositoryId, signal } = {}) {
  let temporaryDirectory;
  try {
    if (!processBoundary || typeof processBoundary.run !== 'function' ||
        typeof reviewedControlRepositoryId !== 'string' ||
        !/^[1-9][0-9]{0,19}$/u.test(reviewedControlRepositoryId) ||
        signal?.aborted === true || (signal !== undefined && (!signal ||
          typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function'))) {
      refuse();
    }
    const canonicalBytes = Buffer.from(serializeActivationManifest(manifest), 'utf8');
    const canonicalManifest = parseCanonicalActivationManifest(canonicalBytes);
    if (canonicalManifest.controlRepository !== CONTROL_REPOSITORY ||
        canonicalManifest.controlRepositoryId !== reviewedControlRepositoryId ||
        canonicalManifest.controlRef !== CONTROL_REF || canonicalManifest.controlWorkflowPath !== CONTROL_WORKFLOW_PATH) {
      refuse();
    }

    const expectedDigest = createHash('sha256').update(canonicalBytes).digest('hex');
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'bvc-activation-verify-'));
    const manifestPath = path.join(temporaryDirectory, 'activation-manifest.json');
    await writeFile(manifestPath, canonicalBytes, { flag: 'wx', mode: 0o600 });
    const args = [
      'attestation', 'verify', manifestPath,
      '--repo', CONTROL_REPOSITORY,
      '--signer-workflow', `${CONTROL_REPOSITORY}/${CONTROL_WORKFLOW_PATH}`,
      '--source-ref', CONTROL_REF,
      '--source-digest', canonicalManifest.controlWorkflowSha,
      '--deny-self-hosted-runners',
      '--predicate-type', SLSA_PROVENANCE_TYPE,
      '--format', 'json',
    ];
    const result = await processBoundary.run('gh', args, {
      signal,
      timeoutMs: VERIFY_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    });
    if (signal?.aborted || !result || typeof result.stdout !== 'string') refuse();
    parseAndValidateOutput(result.stdout, expectedDigest, canonicalManifest, reviewedControlRepositoryId);
    return Object.freeze({ manifest: canonicalManifest, manifestDigest: expectedDigest });
  } catch {
    refuse();
  } finally {
    if (temporaryDirectory) {
      try { await rm(temporaryDirectory, { recursive: true, force: true }); }
      catch { refuse(); }
    }
  }
}
