import { createHash } from 'node:crypto';
import { types } from 'node:util';

const MAX_MANIFEST_BYTES = 16_384;
const MAX_WINDOW_MS = 1_200_000;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype), 'byteLength',
).get;

export class AuthorizationRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = 'AuthorizationRefusal';
    this.code = code;
  }
}

function invalid() {
  throw new AuthorizationRefusal('authorization_manifest_invalid');
}

function scalar(predicate) {
  return (value) => {
    if (!predicate(value)) invalid();
    return value;
  };
}

const literal = (expected) => scalar((value) => value === expected);
const oneOf = (...values) => scalar((value) => values.includes(value));
const hex = (length) => scalar((value) => typeof value === 'string'
  && value.length === length && /^[a-f0-9]+$/u.test(value));
const sha = hex(40);
const digest = hex(64);
const executionId = hex(32);
const decimalId = scalar((value) => typeof value === 'string'
  && /^[1-9][0-9]*$/u.test(value) && Number.isSafeInteger(Number(value))
  && String(Number(value)) === value);
const timestamp = scalar((value) => typeof value === 'string' && value.length === 24
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);

// Read only own data descriptors; neither getters nor custom serialization run.
function record(input, schema) {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input)) invalid();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const keys = Reflect.ownKeys(input);
  const fields = Object.keys(schema);
  if (keys.length !== fields.length || keys.some((key) => !Object.hasOwn(schema, key))) invalid();
  const output = {};
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid();
    output[key] = schema[key](descriptor.value);
  }
  return Object.freeze(output);
}

const JOB_KEYS = ['quality', 'regression', 'build'];
function jobs(input) {
  if (!input || types.isProxy(input) || !Array.isArray(input)
    || Object.getPrototypeOf(input) !== Array.prototype) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (descriptors.length.value !== 3 || Reflect.ownKeys(descriptors).length !== 4) invalid();
  const output = JOB_KEYS.map((key, index) => {
    const descriptor = descriptors[index];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid();
    return record(descriptor.value, { key: literal(key), jobId: decimalId, conclusion: literal('success') });
  });
  if (new Set(output.map((job) => job.jobId)).size !== 3) invalid();
  return Object.freeze(output);
}

function prefixedDigest(prefix) {
  return scalar((value) => typeof value === 'string' && value.startsWith(prefix)
    && value.length === prefix.length + 64 && /^[a-f0-9]{64}$/u.test(value.slice(prefix.length)));
}

const SCHEMA = {
  schemaVersion: literal(2),
  kind: literal('billing-collector-authorization'),
  executionMode: literal('isolated-local'),
  operation: oneOf('collect', 'recover', 'recheck'),
  executionId,
  activationCommitment: digest,
  candidate: (value) => record(value, {
    repository: literal('lawxcompany-stack/Plataforma-LawX'),
    repositoryId: literal('1234079266'),
    pullNumber: decimalId,
    sha,
    treeSha: sha,
    baseSha: sha,
  }),
  prerequisites: (value) => record(value, {
    workflowId: literal('290018021'),
    workflowPath: literal('.github/workflows/ci.yml'),
    runId: decimalId,
    runAttempt: decimalId,
    jobs,
  }),
  control: (value) => record(value, {
    repository: literal('lawxcompany-stack/billing-validation-control'),
    repositoryId: literal('1384018279'),
    ref: literal('refs/heads/main'),
    workflowPath: literal('.github/workflows/authorize-local-collector.yml'),
    sha,
    runId: decimalId,
    runAttempt: decimalId,
    event: literal('workflow_dispatch'),
  }),
  collectorRelease: (value) => record(value, {
    image: prefixedDigest('ghcr.io/lawxcompany-stack/billing-validation-control@sha256:'),
    configDigest: prefixedDigest('sha256:'),
    sourceSha: sha,
    sourceTreeSha: sha,
    policyDigest: digest,
  }),
  policy: (value) => record(value, {
    environmentDigest: digest,
    contractsDigest: digest,
    egressDigest: digest,
    limitsDigest: digest,
  }),
  suite: oneOf('billing-43', 'billing-3ds-15'),
  issuedAt: timestamp,
  expiresAt: timestamp,
  sourceExecutionId: (value) => value === null ? null : executionId(value),
};

export function createAuthorizationManifest(value) {
  const manifest = record(value, SCHEMA);
  const windowMs = Date.parse(manifest.expiresAt) - Date.parse(manifest.issuedAt);
  if (windowMs <= 0 || windowMs > MAX_WINDOW_MS) invalid();
  if (manifest.operation === 'collect') {
    if (manifest.sourceExecutionId !== null) invalid();
  } else {
    if (manifest.sourceExecutionId === null || manifest.sourceExecutionId === manifest.executionId) invalid();
    // Historical authority is not integrated in this increment. Never downgrade to collect.
    throw new AuthorizationRefusal('authorization_operation_unsupported');
  }
  return manifest;
}

export function serializeAuthorizationManifest(value) {
  return `${JSON.stringify(createAuthorizationManifest(value))}\n`;
}

function snapshotBytes(input) {
  if (types.isProxy(input) || (typeof input !== 'string' && !types.isUint8Array(input))) {
    throw new AuthorizationRefusal('authorization_noncanonical');
  }
  const length = typeof input === 'string' ? Buffer.byteLength(input, 'utf8') : typedArrayByteLength.call(input);
  if (length === 0 || length > MAX_MANIFEST_BYTES) throw new AuthorizationRefusal('authorization_noncanonical');
  if (typeof input === 'string') return Buffer.from(input, 'utf8');
  // Intrinsic typed-array operations bypass valueOf and overridden size/accessor properties.
  const bytes = Buffer.alloc(length);
  Uint8Array.prototype.set.call(bytes, input);
  return bytes;
}

export function parseAuthorizationManifest(input) {
  try {
    const inputBytes = snapshotBytes(input);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(inputBytes);
    const manifest = createAuthorizationManifest(JSON.parse(text));
    const bytes = Buffer.from(serializeAuthorizationManifest(manifest));
    // Compare original bytes, not decoded text: TextDecoder may strip a BOM.
    if (!bytes.equals(inputBytes)) throw new AuthorizationRefusal('authorization_noncanonical');
    return manifest;
  } catch (error) {
    if (error instanceof AuthorizationRefusal && error.code === 'authorization_operation_unsupported') throw error;
    throw new AuthorizationRefusal('authorization_noncanonical');
  }
}

export function authorizationDigest(bytes) {
  const manifest = parseAuthorizationManifest(bytes);
  return createHash('sha256').update(serializeAuthorizationManifest(manifest), 'utf8').digest('hex');
}
