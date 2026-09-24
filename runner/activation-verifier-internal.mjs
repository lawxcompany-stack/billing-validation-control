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
const ATTESTATION_ENVIRONMENT = 'billing-validation-attestation';
const DEPLOYMENT_ENVIRONMENT_OID = '1.3.6.1.4.1.57264.1.23';
const SLSA_PROVENANCE_TYPE = 'https://slsa.dev/provenance/v1';
const MAX_OUTPUT_BYTES = 512 * 1024;
const MAX_CERTIFICATE_BYTES = 64 * 1024;
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

function readDerNode(bytes, offset, limit = bytes.length) {
  if (!Buffer.isBuffer(bytes) || !Number.isInteger(offset) || !Number.isInteger(limit) ||
      offset < 0 || offset >= limit || limit > bytes.length) refuse();
  const tag = bytes[offset++];
  if ((tag & 0x1f) === 0x1f || offset >= limit) refuse();
  const firstLength = bytes[offset++];
  let length = firstLength;
  if ((firstLength & 0x80) !== 0) {
    const lengthOctets = firstLength & 0x7f;
    if (lengthOctets === 0 || lengthOctets > 4 || offset + lengthOctets > limit || bytes[offset] === 0) refuse();
    length = 0;
    for (let index = 0; index < lengthOctets; index += 1) {
      length = length * 256 + bytes[offset++];
    }
    if (length < 128) refuse();
  }
  if (!Number.isSafeInteger(length) || length < 0 || offset + length > limit) refuse();
  return { tag, contentStart: offset, contentEnd: offset + length, next: offset + length };
}

function derChildren(bytes, parent) {
  const children = [];
  for (let offset = parent.contentStart; offset < parent.contentEnd;) {
    if (children.length >= 4096) refuse();
    const child = readDerNode(bytes, offset, parent.contentEnd);
    children.push(child);
    offset = child.next;
  }
  return children;
}

function base128Integer(bytes, start, end) {
  if (start >= end || bytes[start] === 0x80) refuse();
  let value = 0;
  for (let offset = start; offset < end; offset += 1) {
    const octet = bytes[offset];
    value = value * 128 + (octet & 0x7f);
    if (!Number.isSafeInteger(value)) refuse();
    if ((octet & 0x80) === 0) return { value, next: offset + 1 };
  }
  refuse();
}

function derOid(bytes, node) {
  if (node.tag !== 0x06 || node.contentStart >= node.contentEnd) refuse();
  const subidentifiers = [];
  for (let offset = node.contentStart; offset < node.contentEnd;) {
    if (subidentifiers.length >= 64) refuse();
    const decoded = base128Integer(bytes, offset, node.contentEnd);
    subidentifiers.push(decoded.value);
    offset = decoded.next;
  }
  const first = subidentifiers.shift();
  const firstArc = first < 40 ? 0 : first < 80 ? 1 : 2;
  return [firstArc, first - (firstArc * 40), ...subidentifiers].join('.');
}

function certificateBytes(rawBytes) {
  if (typeof rawBytes !== 'string' || rawBytes.length === 0 || rawBytes.length > MAX_CERTIFICATE_BYTES * 2 ||
      rawBytes.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(rawBytes)) refuse();
  const bytes = Buffer.from(rawBytes, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_CERTIFICATE_BYTES || bytes.toString('base64') !== rawBytes) refuse();
  return bytes;
}

function certificateRawBytes(attestation) {
  const bundle = attestation?.bundle;
  const material = bundle?.verificationMaterial;
  if (!isRecord(bundle) || !isRecord(material)) refuse();

  if (isRecord(material.certificate) && typeof material.certificate.rawBytes === 'string' &&
      material.x509CertificateChain === undefined) return material.certificate.rawBytes;

  const certificates = material.x509CertificateChain?.certificates;
  if (material.certificate === undefined && Array.isArray(certificates) &&
      certificates.length > 0 && certificates.length <= 8 &&
      certificates.every((certificate) => isRecord(certificate) && typeof certificate.rawBytes === 'string')) {
    return certificates[0].rawBytes;
  }
  refuse();
}

function deploymentEnvironmentFromCertificate(rawBytes) {
  const bytes = certificateBytes(rawBytes);
  const certificate = readDerNode(bytes, 0);
  if (certificate.tag !== 0x30 || certificate.next !== bytes.length) refuse();
  const certificateFields = derChildren(bytes, certificate);
  if (certificateFields.length !== 3 || certificateFields[0].tag !== 0x30 ||
      certificateFields[1].tag !== 0x30 || certificateFields[2].tag !== 0x03) refuse();
  const tbsFields = derChildren(bytes, certificateFields[0]);
  const extensionFields = tbsFields.filter((field) => field.tag === 0xa3);
  if (extensionFields.length !== 1) refuse();
  const extensionSequence = derChildren(bytes, extensionFields[0]);
  if (extensionSequence.length !== 1 || extensionSequence[0].tag !== 0x30) refuse();

  let deploymentEnvironment;
  for (const extension of derChildren(bytes, extensionSequence[0])) {
    if (extension.tag !== 0x30) refuse();
    const fields = derChildren(bytes, extension);
    if (fields.length < 2 || fields.length > 3 || fields[0].tag !== 0x06) refuse();
    let valueIndex = 1;
    if (fields[valueIndex]?.tag === 0x01) {
      const critical = fields[valueIndex];
      if (critical.contentEnd - critical.contentStart !== 1 ||
          ![0x00, 0xff].includes(bytes[critical.contentStart])) refuse();
      valueIndex += 1;
    }
    if (fields.length !== valueIndex + 1 || fields[valueIndex].tag !== 0x04) refuse();
    if (derOid(bytes, fields[0]) !== DEPLOYMENT_ENVIRONMENT_OID) continue;
    if (deploymentEnvironment !== undefined) refuse();
    const encodedValue = readDerNode(bytes, fields[valueIndex].contentStart, fields[valueIndex].contentEnd);
    if (encodedValue.tag !== 0x0c || encodedValue.next !== fields[valueIndex].contentEnd) refuse();
    try {
      deploymentEnvironment = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
        .decode(bytes.subarray(encodedValue.contentStart, encodedValue.contentEnd));
    } catch {
      refuse();
    }
  }
  return deploymentEnvironment;
}

function verifyDeploymentEnvironment(attestation, certificate) {
  const environment = deploymentEnvironmentFromCertificate(certificateRawBytes(attestation));
  if (environment !== ATTESTATION_ENVIRONMENT) refuse();
  for (const field of ['deploymentEnvironment', 'DeploymentEnvironment']) {
    if (Object.hasOwn(certificate, field) && certificate[field] !== environment) refuse();
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
  verifyDeploymentEnvironment(results[0].attestation, verificationResult.signature.certificate);
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
