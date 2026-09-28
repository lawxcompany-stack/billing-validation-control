import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { sanitizeInstalledSchemaState, sanitizeSqlConcurrencyProof } from './observations.mjs';

const require = createRequire(import.meta.url);
const PROTECTED_POLICY = require('../../policy/environment-policy.json');
const VERSION = 1;
const ASSERTION_IDS = Object.freeze(['checkout_rls', 'catalog_version_audit', 'usage_reservation_replay',
  'legacy_plan_webhook_compatibility', 'settlement_lock_order', 'stale_completion_renewal_fencing']);
const RACE_IDS = Object.freeze(['coupon_capacity', 'checkout_payment_context_idempotency', 'plan_change', 'adjustment']);
const BARRIER_IDS = Object.freeze(['billing-sql-barrier-a', 'billing-sql-barrier-b']);
const DIGEST = /^[0-9a-f]{64}$/u;
const REF = /^[a-z0-9]{20}$/u;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u;
const READER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u;
const PRODUCTION_BRANCH_PART = /(?:^|[-_.])(?:main|master|prod|production|primary|default)(?:$|[-_.])/u;

export class SqlGateRefusal extends Error {
  constructor(code) { super(code); this.name = 'SqlGateRefusal'; this.code = code; }
}

function refuse(code) { throw new SqlGateRefusal(code); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function dataRecord(value, keys) {
  if (!object(value)) return false;
  let ownKeys;
  try { ownKeys = Reflect.ownKeys(value); } catch { return false; }
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) return false;
  const result = {};
  try {
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) return false;
      result[key] = descriptor.value;
    }
  } catch { return false; }
  return result;
}

function dataProperty(value, key) {
  if (value === null || typeof value !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch { return undefined; }
}

function exactReaderPair(value) {
  if (!Array.isArray(value) || value.length !== 2) return null;
  let keys;
  try { keys = Reflect.ownKeys(value); } catch { return null; }
  if (keys.length !== 3 || !keys.includes('0') || !keys.includes('1') || !keys.includes('length')) return null;
  const first = dataProperty(value, '0');
  const second = dataProperty(value, '1');
  return first !== undefined && second !== undefined ? [first, second] : null;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) { return createHash('sha256').update(canonical(value), 'utf8').digest('hex'); }
function productionBranch(value) { return PRODUCTION_BRANCH_PART.test(value.toLowerCase()); }

function bindProtectedPolicy(expectedInvariants) {
  const policyKeys = ['schema_version', 'environment', 'vercel', 'database', 'stripe', 'attestation'];
  const policy = dataRecord(PROTECTED_POLICY, policyKeys) ??
    dataRecord(PROTECTED_POLICY, [...policyKeys, 'billingSqlGate']);
  const database = dataRecord(policy?.database, ['projectRef', 'parentProjectRef', 'branchId', 'branchName',
    'schemaFingerprintSha256', 'migrationHistorySha256']);
  if (!policy || policy.schema_version !== 2 || policy.environment !== 'billing-validation' || !database ||
      expectedInvariants.schema.projectRef !== database.projectRef ||
      expectedInvariants.schema.branchId !== database.branchId ||
      expectedInvariants.schema.branchName !== database.branchName) {
    refuse('sql_gate_protected_target_mismatch');
  }

  const pin = dataRecord(dataProperty(policy, 'billingSqlGate'), ['version', 'expectedInvariantsSha256']);
  if (!REF.test(database.projectRef ?? '') || !REF.test(database.parentProjectRef ?? '') ||
      database.projectRef === database.parentProjectRef || !BRANCH.test(database.branchId ?? '') ||
      !BRANCH.test(database.branchName ?? '') || productionBranch(database.branchId) ||
      productionBranch(database.branchName) || !DIGEST.test(database.schemaFingerprintSha256 ?? '') ||
      !DIGEST.test(database.migrationHistorySha256 ?? '') || !pin || pin.version !== VERSION ||
      !DIGEST.test(pin.expectedInvariantsSha256 ?? '')) {
    refuse('sql_gate_protected_policy_unconfigured');
  }

  const schema = expectedInvariants.schema;
  if (schema.parentProjectRef !== database.parentProjectRef ||
      schema.schemaFingerprintSha256 !== database.schemaFingerprintSha256 ||
      schema.migrationHistorySha256 !== database.migrationHistorySha256) {
    refuse('sql_gate_protected_target_mismatch');
  }
  if (digest(expectedInvariants) !== pin.expectedInvariantsSha256) {
    refuse('sql_gate_expected_invariants_untrusted');
  }
}

function validateExpectedInvariants(value) {
  const invariants = dataRecord(value, ['version', 'schema', 'assertionDigests', 'raceLoserStateDigests']);
  if (!invariants || invariants.version !== VERSION) refuse('sql_gate_expected_invariants_invalid');
  const schemaKeys = ['projectRef', 'parentProjectRef', 'branchId', 'branchName', 'schemaFingerprintSha256',
    'migrationHistorySha256', 'triggerDigestSha256', 'aclDigestSha256', 'privilegeDigestSha256'];
  const schema = dataRecord(invariants.schema, schemaKeys);
  const assertionDigests = dataRecord(invariants.assertionDigests, ASSERTION_IDS);
  const raceLoserStateDigests = dataRecord(invariants.raceLoserStateDigests, RACE_IDS);
  if (!schema || !REF.test(schema.projectRef ?? '') ||
      !REF.test(schema.parentProjectRef ?? '') || schema.projectRef === schema.parentProjectRef ||
      !BRANCH.test(schema.branchId ?? '') || !BRANCH.test(schema.branchName ?? '') ||
      productionBranch(schema.branchId) || productionBranch(schema.branchName) ||
      ['schemaFingerprintSha256', 'migrationHistorySha256', 'triggerDigestSha256', 'aclDigestSha256',
        'privilegeDigestSha256'].some((key) => !DIGEST.test(schema[key] ?? '')) ||
      !assertionDigests || ASSERTION_IDS.some((id) => !DIGEST.test(assertionDigests[id] ?? '')) ||
      !raceLoserStateDigests || RACE_IDS.some((id) => !DIGEST.test(raceLoserStateDigests[id] ?? ''))) {
    refuse('sql_gate_expected_invariants_invalid');
  }
  return Object.freeze({ version: VERSION, schema: Object.freeze(schema),
    assertionDigests: Object.freeze(assertionDigests), raceLoserStateDigests: Object.freeze(raceLoserStateDigests) });
}

function validateReader(reader, expected, method) {
  const readerId = dataProperty(reader, 'trustedReaderId');
  const read = dataProperty(reader, method);
  const identity = dataProperty(reader, 'identity');
  if (!object(reader) || typeof read !== 'function' || !READER_ID.test(readerId ?? '') ||
      dataProperty(identity, 'projectRef') !== expected.projectRef ||
      dataProperty(identity, 'branchId') !== expected.branchId || dataProperty(identity, 'readOnly') !== true) {
    refuse('sql_gate_reader_unavailable');
  }
  return Object.freeze({ reader, readerId, read });
}

function validateConcurrencyReaders(value, expected) {
  const readers = exactReaderPair(value);
  if (!readers) refuse('sql_gate_reader_unavailable');
  const [first, second] = readers.map((reader) => validateReader(reader, expected.schema, 'readConcurrencyProof'));
  if (first.reader === second.reader || first.readerId === second.readerId) {
    refuse('sql_gate_readers_not_independent');
  }
  return Object.freeze([first, second]);
}

function matchesSchema(actual, expected) {
  return actual.projectRef === expected.projectRef && actual.parentProjectRef === expected.parentProjectRef &&
    actual.branchId === expected.branchId && actual.branchName === expected.branchName &&
    actual.isDefaultBranch === false && actual.schemaFingerprintSha256 === expected.schemaFingerprintSha256 &&
    actual.migrationHistorySha256 === expected.migrationHistorySha256 &&
    actual.triggerDigestSha256 === expected.triggerDigestSha256 && actual.aclDigestSha256 === expected.aclDigestSha256 &&
    actual.privilegeDigestSha256 === expected.privilegeDigestSha256;
}

/**
 * Compare one independent installed-schema receipt to a detached versioned snapshot.
 * This component check does not authorize a target; the full gate binds policy first.
 */
export async function verifyInstalledSchemaEvidence(expectedValue, readerValue) {
  const expectedInvariants = validateExpectedInvariants(expectedValue);
  const target = expectedInvariants.schema;
  const schemaReader = validateReader(readerValue, target, 'readInstalledSchemaState');
  const targetBinding = Object.freeze({ projectRef: target.projectRef, parentProjectRef: target.parentProjectRef,
    branchId: target.branchId, branchName: target.branchName });
  let schemaRaw;
  try { schemaRaw = await schemaReader.read.call(schemaReader.reader, targetBinding); }
  catch { refuse('sql_gate_schema_read_failed'); }
  let schemaState;
  try { schemaState = sanitizeInstalledSchemaState(schemaRaw); }
  catch { refuse('sql_gate_schema_proof_invalid'); }
  if (schemaState.readerId !== schemaReader.readerId || !matchesSchema(schemaState, target)) {
    refuse('sql_gate_schema_mismatch');
  }
  return schemaState;
}

function matchesConcurrencyProof(proof, expected, reader, barrierId) {
  if (proof.readerId !== reader.trustedReaderId || proof.projectRef !== expected.schema.projectRef ||
      proof.parentProjectRef !== expected.schema.parentProjectRef || proof.branchId !== expected.schema.branchId ||
      proof.branchName !== expected.schema.branchName || proof.barrierId !== barrierId) {
    refuse('sql_gate_concurrency_identity_mismatch');
  }
  for (const id of ASSERTION_IDS) {
    if (proof.assertionDigests[id] !== expected.assertionDigests[id]) {
      refuse('sql_gate_assertion_mismatch');
    }
  }
  for (const id of RACE_IDS) {
    if (proof.races[id].committedOwnerCount !== 1 ||
        proof.races[id].loserStateDigest !== expected.raceLoserStateDigests[id]) {
      refuse('sql_gate_race_mismatch');
    }
  }
}

/**
 * Compare two independent read-only barrier receipts to a detached invariant snapshot.
 * This component validates evidence only; it does not authorize a target or replace policy binding.
 */
export async function verifyConcurrencyEvidence(expectedValue, readerValues) {
  const expectedInvariants = validateExpectedInvariants(expectedValue);
  const target = expectedInvariants.schema;
  const concurrencyReaders = validateConcurrencyReaders(readerValues, expectedInvariants);
  const targetBinding = Object.freeze({ projectRef: target.projectRef, parentProjectRef: target.parentProjectRef,
    branchId: target.branchId, branchName: target.branchName });
  let rawProofs;
  try {
    rawProofs = await Promise.all(concurrencyReaders.map((reader, index) =>
      reader.read.call(reader.reader, Object.freeze({ ...targetBinding, barrierId: BARRIER_IDS[index] }))));
  } catch {
    refuse('sql_gate_concurrency_read_failed');
  }
  const proofs = rawProofs.map((raw) => {
    try { return sanitizeSqlConcurrencyProof(raw); }
    catch { refuse('sql_gate_concurrency_proof_invalid'); }
  });
  proofs.forEach((proof, index) => matchesConcurrencyProof(proof, expectedInvariants,
    { trustedReaderId: concurrencyReaders[index].readerId }, BARRIER_IDS[index]));
}

/**
 * Compare installed, independently read billing-schema receipts to a trusted versioned pin.
 * This boundary accepts readers only. It has no SQL, migration, script, or candidate-artifact input.
 */
export async function verifyTrustedBillingSqlGates(input = {}) {
  const settings = dataRecord(input, ['expectedInvariants', 'schemaReader', 'concurrencyReaders']);
  if (!settings) refuse('sql_gate_input_invalid');
  const expectedInvariants = validateExpectedInvariants(settings.expectedInvariants);
  bindProtectedPolicy(expectedInvariants);
  const target = expectedInvariants.schema;
  validateConcurrencyReaders(settings.concurrencyReaders, expectedInvariants);

  const schemaState = await verifyInstalledSchemaEvidence(expectedInvariants, settings.schemaReader);
  await verifyConcurrencyEvidence(expectedInvariants, settings.concurrencyReaders);

  return Object.freeze({
    version: VERSION,
    schemaFingerprintSha256: schemaState.schemaFingerprintSha256,
    migrationHistorySha256: schemaState.migrationHistorySha256,
    triggerDigestSha256: schemaState.triggerDigestSha256,
    aclDigestSha256: schemaState.aclDigestSha256,
    privilegeDigestSha256: schemaState.privilegeDigestSha256,
    assertionCount: ASSERTION_IDS.length,
    barrierCount: BARRIER_IDS.length,
    raceCount: RACE_IDS.length,
  });
}
