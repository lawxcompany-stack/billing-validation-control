import { createPublicKey, verify } from 'node:crypto';
import { immutableVercelOrigin } from '../github/deployments.mjs';

const SIGNED_FIELDS = Object.freeze([
  'origin', 'deploymentId', 'commit', 'treeHash', 'env', 'projectRef', 'timestamp',
]);
const RESPONSE_FIELDS = Object.freeze([...SIGNED_FIELDS, 'signature']);
const FULL_SHA = /^[0-9a-f]{40}$/u;
const DATABASE_PROJECT_REF = /^[a-z0-9]{20}$/u;
const ISO_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const MAX_ATTESTATION_AGE_MS = 300_000;
const MAX_FUTURE_SKEW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTESTATION_RESPONSE_BYTES = 64 * 1024;
const VERIFIED_DEPLOYMENT_ATTESTATIONS = new WeakMap();

export class AttestationRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = 'AttestationRefusal';
    this.code = code;
  }
}

function refuse(code) {
  throw new AttestationRefusal(code);
}

async function readBoundedAttestationJson(response) {
  const contentType = response.headers?.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') refuse('attestation_response_invalid');
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength) ||
      Number(contentLength) > MAX_ATTESTATION_RESPONSE_BYTES)) refuse('attestation_response_invalid');
  if (!response.body || typeof response.body.getReader !== 'function') refuse('attestation_response_invalid');

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) refuse('attestation_response_invalid');
      totalBytes += value.byteLength;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_ATTESTATION_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch { /* response already closed */ }
        refuse('attestation_response_invalid');
      }
      chunks.push(Buffer.from(value));
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, totalBytes));
    return JSON.parse(text);
  } catch (error) {
    try { await reader.cancel(); } catch { /* response already closed */ }
    if (error instanceof AttestationRefusal) throw error;
    refuse('attestation_response_invalid');
  } finally {
    try { reader.releaseLock(); } catch { /* an outstanding read still owns the lock */ }
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function loadPublicKey(value) {
  if (typeof value !== 'string' || !value.startsWith('-----BEGIN PUBLIC KEY-----\n') ||
      value.includes('PRIVATE KEY')) refuse('attestation_key_invalid');
  try {
    const key = createPublicKey(value);
    if (key.asymmetricKeyType !== 'ed25519') refuse('attestation_key_invalid');
    return key;
  } catch {
    refuse('attestation_key_invalid');
  }
}

function safeSignatureBytes(value) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    refuse('attestation_signature_invalid');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== 64 || bytes.toString('base64') !== value) refuse('attestation_signature_invalid');
  return bytes;
}

function validateDocumentShape(document) {
  if (!isObject(document)) refuse('attestation_shape_invalid');
  if (typeof document.signature !== 'string') refuse('attestation_signature_invalid');
  if (Object.keys(document).length !== RESPONSE_FIELDS.length ||
      RESPONSE_FIELDS.some((field) => !Object.hasOwn(document, field)) ||
      SIGNED_FIELDS.some((field) => typeof document[field] !== 'string')) {
    refuse('attestation_shape_invalid');
  }
}

function verifyTimestamp(value, now) {
  if (!ISO_UTC_TIMESTAMP.test(value)) refuse('attestation_timestamp_invalid');
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) refuse('attestation_timestamp_invalid');
  const canonical = new Date(timestamp).toISOString();
  if (canonical.replace(/\.000Z$/u, 'Z') !== value && canonical !== value) refuse('attestation_timestamp_invalid');
  const currentTime = typeof now === 'function' ? now() : Date.now();
  if (!Number.isFinite(currentTime) || currentTime - timestamp > MAX_ATTESTATION_AGE_MS ||
      timestamp - currentTime > MAX_FUTURE_SKEW_MS) refuse('attestation_timestamp_invalid');
  return timestamp;
}

export function isVerifiedDeploymentAttestation(capability, { deployment, candidate, now } = {}) {
  const binding = capability !== null && typeof capability === 'object'
    ? VERIFIED_DEPLOYMENT_ATTESTATIONS.get(capability) : null;
  if (!binding || deployment?.id !== binding.deploymentId || deployment?.origin !== binding.origin ||
      candidate?.candidateSha !== binding.candidateSha || candidate?.treeSha !== binding.treeSha) return false;
  let currentTime;
  try { currentTime = typeof now === 'function' ? now() : Date.now(); }
  catch { return false; }
  return Number.isFinite(currentTime) && currentTime - binding.timestamp <= MAX_ATTESTATION_AGE_MS &&
    binding.timestamp - currentTime <= MAX_FUTURE_SKEW_MS;
}

export async function verifyDeploymentAttestation(options = {}) {
  const { deployment, candidate, policy, fetchImpl = globalThis.fetch, now } = options;
  if (!isObject(deployment) || typeof deployment.id !== 'string' ||
      typeof candidate?.candidateSha !== 'string' || !FULL_SHA.test(candidate.candidateSha) ||
      typeof candidate?.treeSha !== 'string' || !FULL_SHA.test(candidate.treeSha) ||
      !isObject(policy) || !isObject(policy.database)) refuse('attestation_input_invalid');
  const origin = immutableVercelOrigin(deployment.origin);
  if (!origin || origin !== deployment.origin) refuse('deployment_origin_invalid');
  if (typeof fetchImpl !== 'function') refuse('attestation_unavailable');
  const publicKey = loadPublicKey(policy.attestation?.publicKeyPem);

  let response;
  try {
    response = await fetchImpl(`${origin}/api/internal/deployment-identity`, {
      method: 'GET',
      headers: { Accept: 'application/json', 'Cache-Control': 'no-store' },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    refuse('attestation_unavailable');
  }
  if (!response || response.ok !== true) refuse('attestation_unavailable');

  let document;
  try {
    document = await readBoundedAttestationJson(response);
  } catch (error) {
    if (error instanceof AttestationRefusal) throw error;
    refuse('attestation_unavailable');
  }
  validateDocumentShape(document);

  const signature = safeSignatureBytes(document.signature);
  const signedPayload = {};
  for (const field of SIGNED_FIELDS) signedPayload[field] = document[field];
  const signedBytes = Buffer.from(JSON.stringify(signedPayload), 'utf8');
  let validSignature = false;
  try {
    validSignature = verify(null, signedBytes, publicKey, signature);
  } catch {
    refuse('attestation_signature_invalid');
  }
  if (!validSignature) refuse('attestation_signature_invalid');

  if (!FULL_SHA.test(document.commit) || !FULL_SHA.test(document.treeHash) ||
      !DATABASE_PROJECT_REF.test(document.projectRef) || document.deploymentId !== deployment.id ||
      document.origin !== origin || document.commit !== candidate.candidateSha ||
      document.treeHash !== candidate.treeSha || document.env !== 'billing-validation' ||
      document.projectRef !== policy.database.projectRef) refuse('attestation_identity_mismatch');
  const timestamp = verifyTimestamp(document.timestamp, now);

  const identity = {};
  for (const field of RESPONSE_FIELDS) identity[field] = document[field];
  const capability = Object.freeze(identity);
  VERIFIED_DEPLOYMENT_ATTESTATIONS.set(capability, Object.freeze({ deploymentId: document.deploymentId,
    origin: document.origin, candidateSha: candidate.candidateSha, treeSha: candidate.treeSha, timestamp }));
  return capability;
}
