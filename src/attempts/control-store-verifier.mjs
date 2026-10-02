import { createHash } from 'node:crypto';
import { CONTROL_STORE_BOOTSTRAP_PINS } from './control-store-bootstrap-pins.mjs';
import {
  CONTROL_RUNTIME_FINGERPRINT_EMPTY_SEQUENCES,
  CONTROL_RUNTIME_FINGERPRINT_EMPTY_TABLES,
  CONTROL_RUNTIME_PRIVILEGES,
} from './runtime-privileges.mjs';

const REFUSAL_CODE = 'control_store_identity_invalid';
const REFUSAL_MESSAGE = 'Control store identity verification failed.';
const QUERY_TIMEOUT_MS = 5000;
const RESULT_KEYS = Object.freeze([
  'project_ref', 'database_name', 'session_role', 'verifier_role', 'role_setting', 'server_version_num',
  'owner_login', 'runtime_login', 'runtime_superuser', 'runtime_create_role', 'runtime_create_database',
  'runtime_replication', 'runtime_bypass_rls', 'runtime_member_of_owner', 'runtime_has_role_membership',
  'runtime_owns_objects', 'owner_owns_objects', 'schema_owner', 'baseline_sha256', 'migration_count',
  'migration_sha256', 'privilege_fingerprint_sha256',
]);
const POLICY_KEYS = Object.freeze([
  'schemaVersion', 'projectRef', 'region', 'databaseVersion', 'schema', 'roles', 'connection', 'urlEnvironment',
]);
const TARGET_KEYS = Object.freeze(['projectRef', 'host', 'port', 'database', 'username', 'sslMode']);

function refuse() {
  const error = new Error(REFUSAL_MESSAGE);
  error.name = 'ControlStoreIdentityRefusal';
  error.code = REFUSAL_CODE;
  throw error;
}

function exactDataRecord(value, keys) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) {
      return false;
    }
    return keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true;
    });
  } catch {
    return false;
  }
}

function assertPolicy(policy) {
  if (!exactDataRecord(policy, POLICY_KEYS) || policy.schemaVersion !== 1 ||
      typeof policy.projectRef !== 'string' || !/^[a-z0-9]{20}$/u.test(policy.projectRef) ||
      typeof policy.region !== 'string' || !/^[a-z]{2}-[a-z]+-\d+$/u.test(policy.region) ||
      typeof policy.databaseVersion !== 'string' || !/^\d+\.\d+\.\d+\.\d+$/u.test(policy.databaseVersion) ||
      policy.schema !== 'billing_validation_control' ||
      policy.urlEnvironment !== 'BILLING_CONTROL_VERIFIER_DATABASE_URL' ||
      !exactDataRecord(policy.roles, ['owner', 'runtime', 'verifier']) ||
      policy.roles.owner !== 'billing_validation_owner' || policy.roles.runtime !== 'billing_validation_runtime' ||
      policy.roles.verifier !== 'billing_validation_verifier' ||
      !exactDataRecord(policy.connection, ['protocol', 'host', 'port', 'database', 'sslMode']) ||
      policy.connection.protocol !== 'postgresql' || policy.connection.host !== `db.${policy.projectRef}.supabase.co` ||
      policy.connection.port !== 5432 || policy.connection.database !== 'postgres' ||
      policy.connection.sslMode !== 'require') refuse();
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function expectedMigrationSha256() {
  const source = CONTROL_STORE_BOOTSTRAP_PINS.migrations
    .map(({ version, name, sha256: digest }) => `${version}|${name}|${digest}`).join('\n');
  return sha256(source);
}

function expectedPrivilegeSha256(policy) {
  const rows = [
    'role|owner_login|0',
    'role|runtime_login|0',
    'role|runtime_superuser|0',
    'role|runtime_create_role|0',
    'role|runtime_create_database|0',
    'role|runtime_replication|0',
    'role|runtime_bypass_rls|0',
    'role|runtime_member_of_owner|0',
    'role|runtime_has_role_membership|0',
    'role|runtime_owns_objects|0',
    'role|verifier_login|1',
    'role|verifier_superuser|0',
    'role|verifier_create_role|0',
    'role|verifier_create_database|0',
    'role|verifier_replication|0',
    'role|verifier_bypass_rls|0',
    'role|verifier_member_of_owner|0',
    'role|verifier_has_role_membership|0',
    'role|verifier_owns_objects|0',
    'role|owner_owns_objects|1',
    `schema|owner|${policy.roles.owner}`,
    'schema|usage|1',
    'schema|create|0',
    'schema|verifier_usage|1',
    'schema|verifier_create|0',
    'verifier|table_privileges|0',
    'verifier|sequence_privileges|0',
    'verifier|unapproved_function_execute|0',
  ];
  const tables = { ...CONTROL_RUNTIME_PRIVILEGES.tables,
    ...Object.fromEntries(CONTROL_RUNTIME_FINGERPRINT_EMPTY_TABLES.map((name) => [name, {}])) };
  for (const [name, rights] of Object.entries(tables)) {
    const selectTable = rights.select === true;
    const selectColumns = Array.isArray(rights.select) ? [...rights.select].sort().join(',') : '';
    const insertColumns = [...(rights.insert ?? [])].sort().join(',');
    const updateColumns = [...(rights.update ?? [])].sort().join(',');
    const referenceColumns = [...(rights.references ?? [])].sort().join(',');
    rows.push(`table|${name}|${selectTable ? 1 : 0}|${selectColumns}|${rights.insertTable ? 1 : 0}|${insertColumns}|${rights.updateTable ? 1 : 0}|${updateColumns}|${rights.referencesTable ? 1 : 0}|${referenceColumns}|${rights.delete ? 1 : 0}|${rights.truncate ? 1 : 0}|${rights.trigger ? 1 : 0}|${rights.maintain ? 1 : 0}`);
  }
  const sequences = { ...CONTROL_RUNTIME_PRIVILEGES.sequences,
    ...Object.fromEntries(CONTROL_RUNTIME_FINGERPRINT_EMPTY_SEQUENCES.map((name) => [name, {}])) };
  for (const [name, rights] of Object.entries(sequences)) {
    rows.push(`sequence|${name}|${rights.usage ? 1 : 0}|${rights.select ? 1 : 0}|${rights.update ? 1 : 0}`);
  }
  for (const [signature, rights] of Object.entries(CONTROL_RUNTIME_PRIVILEGES.functions)) {
    if (rights.execute) rows.push(`function|${signature}|runtime|1|verifier|0`);
  }
  rows.push('function|verify_attempt_control_store()|runtime|0|verifier|1');
  return sha256(rows.sort().join('\n'));
}

function targetMatchesPolicy(target, policy) {
  return exactDataRecord(target, TARGET_KEYS) && target.projectRef === policy.projectRef &&
    target.host === policy.connection.host && target.port === policy.connection.port &&
    target.database === policy.connection.database && target.username === policy.roles.verifier &&
    target.sslMode === policy.connection.sslMode;
}

function assertReceipt(row, policy) {
  const [major, minor] = policy.databaseVersion.split('.').map(Number);
  const expectedServerVersion = major * 10_000 + minor;
  if (!exactDataRecord(row, RESULT_KEYS) || row.project_ref !== policy.projectRef ||
      row.database_name !== policy.connection.database || row.session_role !== policy.roles.verifier ||
      row.verifier_role !== policy.roles.owner || row.role_setting !== 'none' ||
      !/^\d{5,6}$/u.test(String(row.server_version_num)) || Number(row.server_version_num) !== expectedServerVersion ||
      row.owner_login !== false || row.runtime_login !== false || row.runtime_superuser !== false ||
      row.runtime_create_role !== false || row.runtime_create_database !== false || row.runtime_replication !== false ||
      row.runtime_bypass_rls !== false || row.runtime_member_of_owner !== false ||
      row.runtime_has_role_membership !== false || row.runtime_owns_objects !== false ||
      row.owner_owns_objects !== true || row.schema_owner !== policy.roles.owner ||
      row.baseline_sha256 !== CONTROL_STORE_BOOTSTRAP_PINS.baselineSha256 ||
      row.migration_count !== CONTROL_STORE_BOOTSTRAP_PINS.migrations.length ||
      row.migration_sha256 !== expectedMigrationSha256() ||
      row.privilege_fingerprint_sha256 !== expectedPrivilegeSha256(policy)) refuse();

  return Object.freeze({
    projectRef: row.project_ref,
    database: row.database_name,
    role: row.session_role,
    serverVersion: String(row.server_version_num),
    baselineSha256: row.baseline_sha256,
    migrationSha256: row.migration_sha256,
    privilegeFingerprintSha256: row.privilege_fingerprint_sha256,
  });
}

/** Verify the control database using only its same-transaction, read-only SQL receipt. */
export async function verifyAttemptControlStore({ queryClient, policy, target } = {}) {
  try {
    assertPolicy(policy);
    if (typeof queryClient?.query !== 'function' || !targetMatchesPolicy(target, policy)) refuse();
    const result = await queryClient.query({
      text: `SELECT * FROM ${policy.schema}.verify_attempt_control_store()`,
      query_timeout: QUERY_TIMEOUT_MS,
    });
    if (!Array.isArray(result?.rows) || result.rows.length !== 1) refuse();
    return assertReceipt(result.rows[0], policy);
  } catch {
    refuse();
  }
}
