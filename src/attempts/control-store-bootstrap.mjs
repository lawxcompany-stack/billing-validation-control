import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTROL_STORE_POLICY } from './control-store-policy.mjs';
import { CONTROL_STORE_BOOTSTRAP_PINS } from './control-store-bootstrap-pins.mjs';

const DEFAULT_BASELINE_PATH = new URL('./schema.sql', import.meta.url);
const DEFAULT_MIGRATION_DIRECTORY = new URL('./migrations/', import.meta.url);
const PLAN_KEYS = Object.freeze([
  'projectRef', 'baselineSha256', 'baselineSql', 'migrations', 'runtimeLogin',
]);
const MIGRATION_KEYS = Object.freeze(['version', 'name', 'file', 'sha256', 'sql']);
const OPTION_KEYS = Object.freeze(['policy', 'baselinePath', 'migrationDirectory']);

function refuse() {
  const error = new Error('Control store bootstrap input is invalid.');
  error.name = 'ControlStoreBootstrapRefusal';
  error.code = 'control_store_bootstrap_invalid';
  throw error;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
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
      return descriptor !== undefined && Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true;
    });
  } catch {
    return false;
  }
}

function exactArray(value, length) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== length) {
      return false;
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== length + 1 || !ownKeys.includes('length')) return false;
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function matchesExactShape(value, approved, visited = new WeakSet()) {
  if (approved === null || typeof approved !== 'object') return value === approved;
  if (!exactDataRecord(value, Object.keys(approved)) || visited.has(value)) return false;
  visited.add(value);
  return Object.keys(approved).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && matchesExactShape(descriptor.value, approved[key], visited);
  });
}

function resolvePath(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value === 'string' && value.length > 0) return value;
  if (value instanceof URL && value.protocol === 'file:') return fileURLToPath(value);
  refuse();
}

function decodeUtf8(bytes) {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes) || text.includes('\0')) refuse();
  return text;
}

function validatePinRegistry() {
  if (!exactDataRecord(CONTROL_STORE_BOOTSTRAP_PINS, ['baselineSha256', 'migrations']) ||
      !/^[a-f0-9]{64}$/u.test(CONTROL_STORE_BOOTSTRAP_PINS.baselineSha256) ||
      !exactArray(CONTROL_STORE_BOOTSTRAP_PINS.migrations, CONTROL_STORE_BOOTSTRAP_PINS.migrations.length)) {
    refuse();
  }

  let previousVersion = '';
  const seenFiles = new Set();
  const seenNames = new Set();
  for (const migration of CONTROL_STORE_BOOTSTRAP_PINS.migrations) {
    if (!exactDataRecord(migration, ['version', 'name', 'file', 'sha256']) ||
        !/^\d{12}$/u.test(migration.version) || migration.version <= previousVersion ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(migration.name) ||
        migration.file !== `${migration.version}-${migration.name}.sql` ||
        !/^[a-f0-9]{64}$/u.test(migration.sha256) ||
        seenFiles.has(migration.file) || seenNames.has(migration.name)) {
      refuse();
    }
    previousVersion = migration.version;
    seenFiles.add(migration.file);
    seenNames.add(migration.name);
  }
}

function readPlanOptions(options) {
  if (!exactDataRecord(options, OPTION_KEYS.filter((key) => Object.hasOwn(options, key)))) refuse();
  const descriptors = Object.getOwnPropertyDescriptors(options);
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== 'string' || !OPTION_KEYS.includes(key) ||
        !Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true) refuse();
  }

  const policy = Object.hasOwn(options, 'policy') ? descriptors.policy.value : CONTROL_STORE_POLICY;
  if (!matchesExactShape(policy, CONTROL_STORE_POLICY)) refuse();
  return {
    policy,
    baselinePath: resolvePath(descriptors.baselinePath?.value, DEFAULT_BASELINE_PATH),
    migrationDirectory: resolvePath(descriptors.migrationDirectory?.value, DEFAULT_MIGRATION_DIRECTORY),
  };
}

function assertPlan(plan) {
  validatePinRegistry();
  if (!exactDataRecord(plan, PLAN_KEYS) || plan.projectRef !== CONTROL_STORE_POLICY.projectRef ||
      plan.runtimeLogin !== false || typeof plan.baselineSql !== 'string' ||
      plan.baselineSha256 !== CONTROL_STORE_BOOTSTRAP_PINS.baselineSha256 ||
      sha256(Buffer.from(plan.baselineSql, 'utf8')) !== plan.baselineSha256 ||
      !exactArray(plan.migrations, CONTROL_STORE_BOOTSTRAP_PINS.migrations.length)) {
    refuse();
  }

  for (let index = 0; index < plan.migrations.length; index += 1) {
    const migration = plan.migrations[index];
    const pin = CONTROL_STORE_BOOTSTRAP_PINS.migrations[index];
    if (!exactDataRecord(migration, MIGRATION_KEYS) || migration.version !== pin.version ||
        migration.name !== pin.name || migration.file !== pin.file || migration.sha256 !== pin.sha256 ||
        typeof migration.sql !== 'string' || sha256(Buffer.from(migration.sql, 'utf8')) !== pin.sha256) {
      refuse();
    }
  }
}

function sqlLiteral(value) {
  if (typeof value !== 'string' || !/^[a-z0-9-]+$/u.test(value)) refuse();
  return `'${value}'`;
}

function keepExactSql(sql) {
  return sql.endsWith('\n') ? sql : `${sql}\n`;
}

export async function loadControlStoreBootstrapPlan(options = {}) {
  try {
    const { policy, baselinePath, migrationDirectory } = readPlanOptions(options);
    validatePinRegistry();

    const baselineBytes = await readFile(baselinePath);
    const baselineSha256 = sha256(baselineBytes);
    if (baselineSha256 !== CONTROL_STORE_BOOTSTRAP_PINS.baselineSha256) refuse();
    const baselineSql = decodeUtf8(baselineBytes);

    const entries = await readdir(migrationDirectory, { withFileTypes: true });
    const expectedFiles = CONTROL_STORE_BOOTSTRAP_PINS.migrations.map(({ file }) => file).sort();
    const actualFiles = entries.map((entry) => entry.name).sort();
    if (entries.some((entry) => !entry.isFile()) || actualFiles.length !== expectedFiles.length ||
        actualFiles.some((file, index) => file !== expectedFiles[index])) refuse();

    const migrations = [];
    for (const pin of CONTROL_STORE_BOOTSTRAP_PINS.migrations) {
      const migrationBytes = await readFile(join(typeof migrationDirectory === 'string'
        ? migrationDirectory
        : fileURLToPath(migrationDirectory), pin.file));
      if (sha256(migrationBytes) !== pin.sha256) refuse();
      migrations.push(Object.freeze({ ...pin, sql: decodeUtf8(migrationBytes) }));
    }

    const plan = {
      projectRef: policy.projectRef,
      baselineSha256,
      baselineSql,
      migrations: Object.freeze(migrations),
      runtimeLogin: false,
    };
    return Object.freeze(plan);
  } catch {
    refuse();
  }
}

export function renderControlStoreBootstrap(plan) {
  try {
    assertPlan(plan);
    const policy = CONTROL_STORE_POLICY;
    const migrationBlocks = plan.migrations.map((migration) =>
      `${keepExactSql(migration.sql)}INSERT INTO ${policy.schema}.schema_migrations (version, name, sha256)\n` +
      `VALUES (${sqlLiteral(migration.version)}, ${sqlLiteral(migration.name)}, ${sqlLiteral(migration.sha256)});\n`)
      .join('\n');

    return [
      'BEGIN;',
      'DO $control_store_preflight$',
      'BEGIN',
      "  IF current_database() IS DISTINCT FROM 'postgres' THEN",
      "    RAISE EXCEPTION 'billing_control_bootstrap_database_required' USING ERRCODE = '55000';",
      '  END IF;',
      "  IF current_user IS DISTINCT FROM 'postgres' THEN",
      "    RAISE EXCEPTION 'billing_control_bootstrap_operator_required' USING ERRCODE = '55000';",
      '  END IF;',
      "  IF session_user IS DISTINCT FROM 'postgres' THEN",
      "    RAISE EXCEPTION 'billing_control_bootstrap_session_identity_required' USING ERRCODE = '55000';",
      '  END IF;',
      `  IF current_setting('server_version_num')::integer / 10000 <> ${Number.parseInt(policy.databaseVersion, 10)} THEN`,
      "    RAISE EXCEPTION 'billing_control_bootstrap_postgres_version_mismatch' USING ERRCODE = '55000';",
      '  END IF;',
      `  IF EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = '${policy.schema}') THEN`,
      "    RAISE EXCEPTION 'billing_control_bootstrap_schema_already_exists' USING ERRCODE = '55000';",
      '  END IF;',
      `  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname IN ('${policy.roles.owner}', '${policy.roles.runtime}')) THEN`,
      "    RAISE EXCEPTION 'billing_control_bootstrap_role_already_exists' USING ERRCODE = '55000';",
      '  END IF;',
      `  IF pg_catalog.to_regclass('${policy.schema}.control_store_install_receipts') IS NOT NULL OR`,
      `     pg_catalog.to_regclass('${policy.schema}.schema_migrations') IS NOT NULL THEN`,
      "    RAISE EXCEPTION 'billing_control_bootstrap_partial_marker_exists' USING ERRCODE = '55000';",
      '  END IF;',
      'END',
      '$control_store_preflight$;',
      `CREATE ROLE ${policy.roles.owner} NOLOGIN;`,
      `CREATE ROLE ${policy.roles.runtime} NOLOGIN;`,
      `CREATE SCHEMA ${policy.schema} AUTHORIZATION ${policy.roles.owner};`,
      `SET LOCAL ROLE ${policy.roles.owner};`,
      keepExactSql(plan.baselineSql),
      `CREATE TABLE ${policy.schema}.control_store_install_receipts (`,
      '  project_ref char(20) PRIMARY KEY CHECK (project_ref ~ \'^[a-z0-9]{20}$\'),',
      '  baseline_sha256 char(64) NOT NULL CHECK (baseline_sha256 ~ \'^[a-f0-9]{64}$\'),',
      '  installed_at timestamptz NOT NULL DEFAULT clock_timestamp()',
      ');',
      `INSERT INTO ${policy.schema}.control_store_install_receipts (project_ref, baseline_sha256)`,
      `VALUES (${sqlLiteral(plan.projectRef)}, ${sqlLiteral(plan.baselineSha256)});`,
      migrationBlocks.trimEnd(),
      'COMMIT;',
      '',
    ].join('\n');
  } catch {
    refuse();
  }
}
