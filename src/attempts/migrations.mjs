import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isValidStandaloneDatabasePolicy } from '../billing/contracts.mjs';
import { refuse } from './store.mjs';

const require = createRequire(import.meta.url);
const CONTROL_POLICY = require('../../policy/environment-policy.json');
const MIGRATION_DIRECTORY = new URL('./migrations/', import.meta.url);
const DEFINITIONS = Object.freeze([
  Object.freeze({ version: '202610010001', name: 'standalone-lease-fencing',
    file: '202610010001-standalone-lease-fencing.sql',
    sha256: 'd733038f706135c2514084fc229c9ac7507796cccd4eca4974ca1dc981fd12fb' }),
]);
const BASELINE_RELATIONS = Object.freeze([
  'billing_validation_control.attempts',
  'billing_validation_control.fixture_leases',
  'billing_validation_control.retention_receipts',
]);

function exactRecord(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  let ownKeys;
  let prototype;
  try { ownKeys = Reflect.ownKeys(value); prototype = Object.getPrototypeOf(value); }
  catch { return false; }
  return (prototype === Object.prototype || prototype === null) && ownKeys.length === keys.length &&
    ownKeys.every((key) => typeof key === 'string' && keys.includes(key)) && keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true;
    });
}

function sha256(value) { return createHash('sha256').update(value, 'utf8').digest('hex'); }

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function removeCommentsAndLiterals(sql) {
  return sql
    .replace(/--[^\r\n]*/gu, ' ')
    .replace(/\/\*[\s\S]*?\*\//gu, ' ')
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/gu, ' ')
    .replace(/\$\$[\s\S]*?\$\$/gu, ' ')
    .replace(/'(?:''|[^'])*'/gu, "''");
}

/** Reject destructive/reset/bootstrap statements while allowing append-only trigger definitions. */
export function validateMigrationSql(sql) {
  if (typeof sql !== 'string' || sql.length < 1 || sql.length > 1_000_000) {
    refuse('migration_sql_invalid');
  }
  const visible = removeCommentsAndLiterals(sql);
  const statements = visible.split(';').map((statement) => statement.trim()).filter(Boolean);
  if (statements.length === 0 || /\b(?:BOOTSTRAP|RESTORE|RESET|REINITIALIZE)\b/iu.test(visible) ||
      /\b(?:DO|CALL|PREPARE)\b/iu.test(visible)) refuse('migration_unsafe_sql');
  for (const statement of statements) {
    if (/^(?:DROP|DELETE|TRUNCATE|RESET|REINDEX|VACUUM|CLUSTER)\b/iu.test(statement) ||
        /^CREATE\s+(?:DATABASE|SCHEMA)\b/iu.test(statement) ||
        /^CREATE\s+(?:TABLE|SEQUENCE)\s+IF\s+NOT\s+EXISTS\b/iu.test(statement) ||
        /^ALTER\b[\s\S]*\bDROP\b/iu.test(statement) ||
        /\bEXECUTE\s+(?!FUNCTION\b)/iu.test(statement)) refuse('migration_unsafe_sql');
  }
  return true;
}

export function validateAttemptMigrationAllowlist(actualFiles) {
  const expectedFiles = DEFINITIONS.map(({ file }) => file).sort();
  if (!Array.isArray(actualFiles) || actualFiles.length !== expectedFiles.length ||
      actualFiles.some((name, index) => name !== expectedFiles[index])) refuse('migration_allowlist_mismatch');
  return true;
}

export async function loadAttemptMigrationPlan({ directory = MIGRATION_DIRECTORY } = {}) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch { refuse('migration_registry_unavailable'); }
  const actualFiles = entries.map((entry) => entry.name).sort();
  if (entries.some((entry) => !entry.isFile())) refuse('migration_allowlist_mismatch');
  validateAttemptMigrationAllowlist(actualFiles);

  const plan = [];
  for (const definition of DEFINITIONS) {
    let sql;
    try { sql = await readFile(new URL(definition.file, directory), 'utf8'); }
    catch { refuse('migration_registry_unavailable'); }
    if (sha256(sql) !== definition.sha256) refuse('migration_local_hash_mismatch');
    validateMigrationSql(sql);
    plan.push(Object.freeze({ ...definition, sql }));
  }
  return Object.freeze(plan);
}

export function validateAppliedAttemptMigrations(plan, appliedRows) {
  if (!Array.isArray(plan) || !Array.isArray(appliedRows)) {
    refuse('migration_history_invalid');
  }
  for (const row of appliedRows) {
    if (!exactRecord(row, ['version', 'name', 'sha256'])) refuse('migration_history_invalid');
    if (!plan.some((known) => known.version === row.version)) refuse('migration_unknown_applied');
  }
  if (appliedRows.length > plan.length) refuse('migration_history_invalid');
  for (let index = 0; index < appliedRows.length; index += 1) {
    const row = appliedRows[index];
    const migration = plan[index];
    if (!migration) refuse('migration_history_invalid');
    if (row.version !== migration.version) refuse('migration_history_invalid');
    if (row.name !== migration.name) refuse('migration_applied_name_mismatch');
    if (row.sha256 !== migration.sha256) refuse('migration_applied_hash_mismatch');
  }
  return Object.freeze(plan.slice(appliedRows.length));
}

function validateMigrationApproval({ policy, targetReadback, approval }) {
  const database = policy?.database;
  const targetKeys = ['projectRef', 'host', 'port', 'database', 'role', 'databaseVersion',
    'isStandaloneProject', 'schemaFingerprintSha256', 'migrationHistorySha256'];
  const approvalKeys = ['approvalId', 'approvedBy', 'approvedAt', 'targetSha256'];
  if (!isValidStandaloneDatabasePolicy(database, { configured: true }) ||
      !exactRecord(targetReadback, targetKeys) || !exactRecord(approval, approvalKeys)) {
    refuse('migration_approval_required');
  }
  const connection = database.connection;
  if (targetReadback.projectRef !== database.projectRef || targetReadback.host !== connection.host ||
      targetReadback.port !== connection.port || targetReadback.database !== connection.database ||
      targetReadback.role !== connection.role || targetReadback.databaseVersion !== database.databaseVersion ||
      targetReadback.isStandaloneProject !== true ||
      targetReadback.schemaFingerprintSha256 !== database.schemaFingerprintSha256 ||
      targetReadback.migrationHistorySha256 !== database.migrationHistorySha256 ||
      typeof approval.approvalId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(approval.approvalId) ||
      typeof approval.approvedBy !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._@-]{1,127}$/u.test(approval.approvedBy) ||
      typeof approval.approvedAt !== 'string' || !Number.isFinite(Date.parse(approval.approvedAt)) ||
      approval.targetSha256 !== sha256(canonical(targetReadback))) refuse('migration_approval_required');
}

/** Apply forward-only migrations only after exact readback and human approval. Never bootstraps. */
export async function applyAttemptMigrations({ client, policy = CONTROL_POLICY, targetReadback, approval,
  migrationDirectory = MIGRATION_DIRECTORY } = {}) {
  validateMigrationApproval({ policy, targetReadback, approval });
  if (typeof client?.transaction !== 'function') refuse('store_client_invalid');
  const plan = await loadAttemptMigrationPlan({ directory: migrationDirectory });
  return client.transaction(async (queryClient) => {
    if (typeof queryClient?.query !== 'function') refuse('store_client_invalid');
    await queryClient.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    const baseline = await queryClient.query(`SELECT
      to_regclass($1) IS NOT NULL AND to_regclass($2) IS NOT NULL AND to_regclass($3) IS NOT NULL AS ready,
      to_regclass($4) IS NOT NULL AS ledger_ready`, [...BASELINE_RELATIONS,
      'billing_validation_control.schema_migrations']);
    if (baseline.rows?.[0]?.ready !== true) refuse('migration_bootstrap_required');
    let applied = [];
    if (baseline.rows?.[0]?.ledger_ready === true) {
      const result = await queryClient.query(`SELECT version, name, sha256
        FROM billing_validation_control.schema_migrations ORDER BY version`);
      applied = result.rows ?? [];
    }
    const pending = validateAppliedAttemptMigrations(plan, applied);
    for (const migration of pending) {
      await queryClient.query(migration.sql);
      const recorded = await queryClient.query(`INSERT INTO billing_validation_control.schema_migrations
        (version, name, sha256) VALUES ($1, $2, $3)`,
      [migration.version, migration.name, migration.sha256]);
      if (recorded.rowCount !== 1) refuse('migration_registry_write_failed');
    }
    return Object.freeze({ appliedVersions: Object.freeze(pending.map(({ version }) => version)) });
  });
}

export const ATTEMPT_MIGRATION_ALLOWLIST = Object.freeze(DEFINITIONS.map(({ version, name, file, sha256 }) =>
  Object.freeze({ version, name, file, sha256 })));
