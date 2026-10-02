import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isValidStandaloneDatabasePolicy } from '../billing/contracts.mjs';
import { assertSupabaseRuntimeConfiguration, SupabaseRefusal, verifySupabaseEnvironment } from '../runtime/supabase.mjs';
import { AttemptRefusal, refuse } from './store.mjs';

const require = createRequire(import.meta.url);
function freezeTree(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}
const CONTROL_POLICY = freezeTree(JSON.parse(JSON.stringify(require('../../policy/environment-policy.json'))));
const MIGRATION_DIRECTORY = new URL('./migrations/', import.meta.url);
const DEFINITIONS = Object.freeze([
  Object.freeze({ version: '202610010001', name: 'standalone-lease-fencing',
    file: '202610010001-standalone-lease-fencing.sql',
    sha256: 'd733038f706135c2514084fc229c9ac7507796cccd4eca4974ca1dc981fd12fb' }),
]);
const ROUTINE_BODY_SHA256 = Object.freeze({
  'billing_validation_control.reject_append_only_history_mutation': '88b80c1d835b7d872c626b75208df25052e841bdb6bd551baea688c71d183220',
  'billing_validation_control.validate_fixture_case_claim': 'f919782f8c3767d8fc3295142a8dba4b7cada4c5a33f5113bf2f64a3d5aac18f',
  'billing_validation_control.validate_cleanup_receipt_identity': '2c9c797b5e402a462102241b315f06423959f099b75e936a1a85e9dcb303e72b',
  'billing_validation_control.validate_retention_receipt_owner_fence': 'ed07a5fc1085973a198c5302dfa20ede182f90b245ce8ec7db01adb9d119bafe',
});
const ROUTINE_DEFINITION_SHA256 = Object.freeze({
  'billing_validation_control.reject_append_only_history_mutation': '2b9e4643fc2ca8fb37a5315c13a1cb07161dabf8914afbf4d3b530e335193085',
  'billing_validation_control.validate_fixture_case_claim': '5c06b105aebf403b9647c00eccbeb4f9513eb8fb92e92c25ace137a85132f7b2',
  'billing_validation_control.validate_cleanup_receipt_identity': 'ae3ddb69c8b7267ad1798c71051c19f40f4d4eb4c6d64e5d33d90ca8a7f49b54',
  'billing_validation_control.validate_retention_receipt_owner_fence': 'f0c7a774eb6d54932aa59b6a3baa221836ec0f8dba10ed18076e217958c44eda',
});
const TRIGGER_DEFINITION_SHA256 = Object.freeze({
  billing_validation_retention_receipt_owner_fence: '0c8962f35b9153c78e22d3d4eb18f5a64506c363636e880d9745b37fa5f5926c',
  billing_validation_migration_history_immutable: '8de76161f5a31a9471541b75c17ce702709e7b1163b818f31ce6568168bb4709',
  billing_validation_migration_history_no_truncate: '4445e28dbff9d69f7d3e775f815c26c8b3e05362591df04e1791eb26b1b674ef',
  billing_validation_fixture_lease_history_immutable: 'e51f215888420c15c47f314a8a832b07cb1b73168b0f1853fc073562f07e8735',
  billing_validation_fixture_lease_history_no_truncate: '2b89b6a1156127e6c8ada686ad9e4bece5d4cf06987d172edd3bf48d0706833e',
});
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

function readSingleQuoted(sql, start, escapeBackslash) {
  let value = '';
  let hadBackslash = false;
  for (let index = start + 1; index < sql.length; index += 1) {
    const character = sql[index];
    if (character === '\\') {
      hadBackslash = true;
      if (escapeBackslash && index + 1 < sql.length) {
        value += sql[index + 1];
        index += 1;
      } else value += character;
    } else if (character === "'" && sql[index + 1] === "'") {
      value += "'";
      index += 1;
    } else if (character === "'") {
      return { value, next: index + 1, hadBackslash };
    } else {
      value += character;
    }
  }
  refuse('migration_sql_invalid');
}

function isRoutineDefinition(words) {
  return words[0] === 'CREATE' && words.slice(1, 5).some((word) => word === 'FUNCTION' || word === 'PROCEDURE');
}

function routineNameFromStatement(statement) {
  const identifier = '([A-Za-z_][A-Za-z0-9_$]*(?:\\s*\\.\\s*[A-Za-z_][A-Za-z0-9_$]*)?)';
  const match = new RegExp(`^\\s*CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${identifier}\\b[\\s\\S]*\\bAS\\s*$`, 'iu')
    .exec(statement);
  return match?.[1].replace(/\\s*\\.\\s*/gu, '.').toLowerCase() ?? null;
}

/** Mask SQL comments and literals without treating comment markers inside literals as comments. */
function scanSql(sql) {
  const visible = [];
  const routineDefinitions = [];
  const statementWords = [];
  let previousWord = '';
  let statementStart = 0;
  let statementFirstWordRaw = null;
  let pendingRoutineDefinition = null;

  function finishStatement(end) {
    if (isRoutineDefinition(statementWords) && pendingRoutineDefinition === null) {
      refuse('migration_unsafe_sql');
    }
    if (pendingRoutineDefinition !== null) {
      const routine = routineDefinitions[pendingRoutineDefinition];
      routine.definitionSha256 = sha256(sql.slice(routine.definitionStart, end).trim());
      pendingRoutineDefinition = null;
    }
    if (statementWords[0] === 'CREATE' && statementWords[1] === 'TRIGGER') {
      const name = statementWords[2]?.toLowerCase();
      if (sha256(sql.slice(statementFirstWordRaw, end).trim()) !== TRIGGER_DEFINITION_SHA256[name]) {
        refuse('migration_unsafe_sql');
      }
    }
  }

  for (let index = 0; index < sql.length;) {
    const character = sql[index];
    const next = sql[index + 1];
    if (/\s/u.test(character)) {
      visible.push(character);
      index += 1;
      continue;
    }
    if (character === '-' && next === '-') {
      let end = index + 2;
      while (end < sql.length && sql[end] !== '\r' && sql[end] !== '\n') end += 1;
      visible.push(' ');
      index = end;
      continue;
    }
    if (character === '/' && next === '*') {
      let depth = 1;
      index += 2;
      while (index < sql.length && depth > 0) {
        if (sql[index] === '/' && sql[index + 1] === '*') { depth += 1; index += 2; }
        else if (sql[index] === '*' && sql[index + 1] === '/') { depth -= 1; index += 2; }
        else index += 1;
      }
      if (depth !== 0) refuse('migration_sql_invalid');
      visible.push(' ');
      continue;
    }

    const dollarOpening = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u.exec(sql.slice(index));
    if (dollarOpening) {
      const delimiter = dollarOpening[0];
      const bodyStart = index + delimiter.length;
      const bodyEnd = sql.indexOf(delimiter, bodyStart);
      if (bodyEnd < 0) refuse('migration_sql_invalid');
      if (previousWord === 'AS' && isRoutineDefinition(statementWords)) {
        const name = routineNameFromStatement(visible.join('').slice(statementStart));
        if (!name || pendingRoutineDefinition !== null) refuse('migration_unsafe_sql');
        routineDefinitions.push({ name, body: sql.slice(bodyStart, bodyEnd),
          definitionStart: statementFirstWordRaw ?? index });
        pendingRoutineDefinition = routineDefinitions.length - 1;
      }
      visible.push(' ');
      index = bodyEnd + delimiter.length;
      previousWord = '';
      continue;
    }

    let stringStart = -1;
    let escapeBackslash = false;
    let consumedPrefix = 0;
    if (character === "'") stringStart = index;
    else if (/^[EeBbXx]$/u.test(character) && next === "'") {
      stringStart = index + 1;
      consumedPrefix = 1;
      escapeBackslash = /[Ee]/u.test(character);
    } else if (/^[Uu]$/u.test(character) && next === '&' && sql[index + 2] === "'") {
      stringStart = index + 2;
      consumedPrefix = 2;
    }
    if (stringStart >= 0) {
      const parsed = readSingleQuoted(sql, stringStart, escapeBackslash);
      const routineBody = previousWord === 'AS' && isRoutineDefinition(statementWords);
      if (routineBody && parsed.hadBackslash) refuse('migration_unsafe_sql');
      if (routineBody) {
        const name = routineNameFromStatement(visible.join('').slice(statementStart));
        if (!name || pendingRoutineDefinition !== null) refuse('migration_unsafe_sql');
        routineDefinitions.push({ name, body: parsed.value, definitionStart: statementFirstWordRaw ?? index });
        pendingRoutineDefinition = routineDefinitions.length - 1;
      }
      visible.push(' ');
      index = parsed.next;
      previousWord = '';
      if (consumedPrefix > 0) statementWords.push('STRING');
      continue;
    }

    if (character === '"') {
      let end = index + 1;
      while (end < sql.length) {
        if (sql[end] === '"' && sql[end + 1] === '"') end += 2;
        else if (sql[end] === '"') { end += 1; break; }
        else end += 1;
      }
      if (end > sql.length || sql[end - 1] !== '"') refuse('migration_sql_invalid');
      visible.push(' ');
      index = end;
      previousWord = '';
      continue;
    }

    const word = /^[A-Za-z_][A-Za-z0-9_$]*/u.exec(sql.slice(index));
    if (word) {
      const normalized = word[0].toUpperCase();
      visible.push(word[0]);
      if (statementWords.length === 0) statementFirstWordRaw = index;
      if (statementWords.length < 6) statementWords.push(normalized);
      previousWord = normalized;
      index += word[0].length;
      continue;
    }

    visible.push(character);
    if (character === ';') {
      finishStatement(index + 1);
      statementWords.length = 0;
      statementFirstWordRaw = null;
      statementStart = visible.join('').length;
    }
    previousWord = '';
    index += 1;
  }

  finishStatement(sql.length);
  return { visible: visible.join(''), routineDefinitions };
}

/** Reject destructive/reset/bootstrap statements while allowing append-only trigger definitions. */
export function validateMigrationSql(sql) {
  if (typeof sql !== 'string' || sql.length < 1 || sql.length > 1_000_000) {
    refuse('migration_sql_invalid');
  }
  const { visible, routineDefinitions } = scanSql(sql);
  const statements = visible.split(';').map((statement) => statement.trim()).filter(Boolean);
  if (statements.length === 0 || /\b(?:BOOTSTRAP|RESTORE|RESET|REINITIALIZE)\b/iu.test(visible) ||
      /\b(?:DO|CALL|PREPARE)\b/iu.test(visible) || /\bBEGIN\s+ATOMIC\b/iu.test(visible)) {
    refuse('migration_unsafe_sql');
  }
  assertTriggerRoutineBindings(visible);
  for (const statement of statements) {
    const wrappedMutation = /^(?:WITH|EXPLAIN)\b[\s\S]*\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE|DROP)\b/iu.test(statement);
    if (wrappedMutation || /^(?:INSERT|UPDATE|DELETE|MERGE|DROP|TRUNCATE)\b/iu.test(statement) ||
        /^(?:RESET|REINDEX|VACUUM|CLUSTER)\b/iu.test(statement) ||
        /^CREATE\s+(?:DATABASE|SCHEMA|RULE)\b/iu.test(statement) || /^SET\b/iu.test(statement) ||
        /^CREATE\s+(?:TABLE|SEQUENCE)\s+IF\s+NOT\s+EXISTS\b/iu.test(statement) ||
        /^ALTER\b[\s\S]*\bDROP\b/iu.test(statement) ||
        /^ALTER\s+TABLE\b[\s\S]*\b(?:DISABLE\s+(?:TRIGGER|ROW\s+LEVEL\s+SECURITY)|NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY)\b/iu.test(statement) ||
        /\bEXECUTE\s+(?!FUNCTION\b)/iu.test(statement) || !isAllowedMigrationStatement(statement)) {
      refuse('migration_unsafe_sql');
    }
  }
  const routineNames = routineDefinitions.map(({ name }) => name);
  if (new Set(routineNames).size !== routineNames.length) refuse('migration_unsafe_sql');
  for (const { name, body, definitionSha256 } of routineDefinitions) {
    const expectedBodySha256 = ROUTINE_BODY_SHA256[name];
    const expectedDefinitionSha256 = ROUTINE_DEFINITION_SHA256[name];
    if (!expectedBodySha256 || sha256(body) !== expectedBodySha256 || !expectedDefinitionSha256 ||
        definitionSha256 !== expectedDefinitionSha256) refuse('migration_unsafe_sql');
    const { visible: bodyVisible, routineDefinitions: nestedDefinitions } = scanSql(body);
    if (/\b(?:INSERT|UPDATE|DELETE|MERGE|DROP|TRUNCATE|EXECUTE|SET)\b/iu.test(bodyVisible)) {
      refuse('migration_unsafe_sql');
    }
    if (nestedDefinitions.length > 0) refuse('migration_unsafe_sql');
  }
  return true;
}

function assertTriggerRoutineBindings(visible) {
  const identifier = '([A-Za-z_][A-Za-z0-9_$]*(?:\\s*\\.\\s*[A-Za-z_][A-Za-z0-9_$]*)?)';
  const declared = new Set([...visible.matchAll(new RegExp(
    `\\bCREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${identifier}`, 'giu'))]
    .map(([, name]) => name.replace(/\\s*\\.\\s*/gu, '.').toLowerCase()));
  const calls = [...visible.matchAll(/\bEXECUTE\s+FUNCTION\b/giu)];
  const references = [...visible.matchAll(new RegExp(
    `\\bEXECUTE\\s+FUNCTION\\s+${identifier}\\s*\\(`, 'giu'))];
  if (calls.length !== references.length || references.some(([, name]) =>
    !declared.has(name.replace(/\\s*\\.\\s*/gu, '.').toLowerCase()))) {
    refuse('migration_unsafe_sql');
  }
}

function createTableUsesQuery(statement) {
  let depth = 0;
  const tokens = statement.matchAll(/[()]|[A-Za-z_][A-Za-z0-9_$]*/gu);
  for (const [token] of tokens) {
    if (token === '(') depth += 1;
    else if (token === ')') {
      depth -= 1;
      if (depth < 0) return true;
    } else if (depth === 0 && token.toUpperCase() === 'AS') return true;
  }
  return depth !== 0;
}

function isAllowedMigrationStatement(statement) {
  const createsTableFromQuery = /^CREATE\s+TABLE\b/iu.test(statement) && createTableUsesQuery(statement);
  return /^CREATE\s+SEQUENCE\b/iu.test(statement) ||
    /^CREATE\s+TABLE\b/iu.test(statement) && !createsTableFromQuery ||
    /^CREATE\s+(?:UNIQUE\s+)?INDEX\b/iu.test(statement) ||
    /^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/iu.test(statement) ||
    /^CREATE\s+TRIGGER\b/iu.test(statement) ||
    /^ALTER\s+TABLE\b[\s\S]*\bADD\s+(?:COLUMN|CONSTRAINT)\b/iu.test(statement) ||
    /^REVOKE\s+ALL\b/iu.test(statement);
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

const CONTROL_REPOSITORY = 'lawxcompany-stack/billing-validation-control';
const CONTROL_REPOSITORY_ID = '1384018279';
const CONTROL_WORKFLOW_REF = `${CONTROL_REPOSITORY}/.github/workflows/validate-billing.yml@refs/heads/main`;
const APPROVAL_ENVIRONMENT = 'billing-validation-tests';

function requireApprovedWorkflowEnvironment(environment) {
  if (!environment || environment.BILLING_VALIDATION_APPROVAL_ENVIRONMENT !== APPROVAL_ENVIRONMENT ||
      environment.GITHUB_REPOSITORY !== CONTROL_REPOSITORY ||
      environment.GITHUB_REPOSITORY_ID !== CONTROL_REPOSITORY_ID ||
      environment.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
      environment.GITHUB_REF !== 'refs/heads/main' || environment.GITHUB_REF_PROTECTED !== 'true' ||
      environment.GITHUB_WORKFLOW_REF !== CONTROL_WORKFLOW_REF ||
      !/^[1-9][0-9]{0,19}$/u.test(environment.GITHUB_RUN_ID ?? '') ||
      !/^[1-9][0-9]{0,5}$/u.test(environment.GITHUB_RUN_ATTEMPT ?? '')) {
    refuse('migration_approval_required');
  }
}

function assertClientConnectionTarget(client, database) {
  const parameters = client?.connectionParameters;
  const connection = database.connection;
  if (!parameters || parameters.host !== connection.host || parameters.port !== connection.port ||
      parameters.database !== connection.database || parameters.user !== connection.role ||
      parameters.hostaddr !== undefined && parameters.hostaddr !== null ||
      !exactRecord(parameters.ssl, ['rejectUnauthorized', 'servername']) ||
      parameters.ssl.rejectUnauthorized !== true || parameters.ssl.servername !== connection.host) {
    refuse('migration_connection_target_mismatch');
  }
}

function assertConnectedDatabaseIdentity(result, database) {
  const row = result?.rows?.[0];
  const keys = ['database_name', 'role_name', 'server_version_num'];
  const [expectedMajor, expectedMinor] = database.databaseVersion.split('.').map(Number);
  const expectedServerVersion = expectedMajor * 10_000 + expectedMinor;
  if (result?.rows?.length !== 1 || !exactRecord(row, keys) ||
      row.database_name !== database.connection.database || row.role_name !== database.connection.role ||
      !/^\d{5,6}$/u.test(String(row.server_version_num)) ||
      Number(row.server_version_num) !== expectedServerVersion) {
    refuse('migration_connection_identity_mismatch');
  }
}

/** Apply allowlisted migrations only from the protected, manually approved control Environment. */
export async function applyAttemptMigrations({ client, migrationDirectory = MIGRATION_DIRECTORY } = {}) {
  const environment = process.env;
  requireApprovedWorkflowEnvironment(environment);
  const policy = CONTROL_POLICY;
  if (!isValidStandaloneDatabasePolicy(policy?.database, { configured: true })) {
    refuse('migration_target_unconfigured');
  }
  if (typeof client?.transaction !== 'function') refuse('store_client_invalid');
  const token = environment.SUPABASE_VALIDATION_MANAGEMENT_TOKEN;
  const trustedConfiguration = {
    environmentApproved: true,
    SUPABASE_VALIDATION_PROJECT_REF: environment.SUPABASE_VALIDATION_PROJECT_REF,
    databaseUrl: environment.SUPABASE_VALIDATION_DATABASE_URL,
  };
  const database = assertSupabaseRuntimeConfiguration({ policy, token, trustedConfiguration });
  assertClientConnectionTarget(client, database);
  const plan = await loadAttemptMigrationPlan({ directory: migrationDirectory });
  const readback = await verifySupabaseEnvironment({ policy, token, trustedConfiguration });
  if (readback.projectRef !== database.projectRef || readback.databaseVersion !== database.databaseVersion ||
      readback.schemaFingerprintSha256 !== database.schemaFingerprintSha256 ||
      readback.migrationHistorySha256 !== database.migrationHistorySha256) {
    refuse('migration_target_readback_mismatch');
  }
  try {
    return await client.transaction(async (queryClient) => {
      if (typeof queryClient?.query !== 'function') refuse('store_client_invalid');
      await queryClient.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      const identity = await queryClient.query(`SELECT current_database() AS database_name,
        current_user AS role_name, current_setting('server_version_num') AS server_version_num`);
      assertConnectedDatabaseIdentity(identity, database);
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
  } catch (error) {
    if (error instanceof AttemptRefusal || error instanceof SupabaseRefusal) throw error;
    refuse('migration_database_operation_failed');
  }
}

export const ATTEMPT_MIGRATION_ALLOWLIST = Object.freeze(DEFINITIONS.map(({ version, name, file, sha256 }) =>
  Object.freeze({ version, name, file, sha256 })));
