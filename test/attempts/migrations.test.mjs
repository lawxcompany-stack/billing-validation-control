import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyAttemptMigrations, loadAttemptMigrationPlan, validateAppliedAttemptMigrations,
  validateAttemptMigrationAllowlist, validateMigrationSql } from '../../src/attempts/migrations.mjs';

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function approvedTarget() {
  const policy = { database: { kind: 'standalone', projectRef: 'abcdefghijklmnopqrst',
    organizationId: 'org_synthetic', organizationSlug: 'org-synthetic', region: 'sa-east-1',
    databaseVersion: '17.6.1.054', postgresEngine: 'postgres', releaseChannel: 'ga',
    connection: { mode: 'direct', host: 'db.abcdefghijklmnopqrst.supabase.co', port: 5432,
      database: 'postgres', role: 'billing_validation_writer' },
    schemaFingerprintSha256: 'a'.repeat(64), migrationHistorySha256: 'b'.repeat(64) } };
  const targetReadback = { projectRef: policy.database.projectRef, host: policy.database.connection.host,
    port: 5432, database: 'postgres', role: 'billing_validation_writer', databaseVersion: '17.6.1.054',
    isStandaloneProject: true, schemaFingerprintSha256: 'a'.repeat(64), migrationHistorySha256: 'b'.repeat(64) };
  const targetSha256 = createHash('sha256').update(canonical(targetReadback), 'utf8').digest('hex');
  return { policy, targetReadback, approval: { approvalId: 'CHG-2026-1001', approvedBy: 'reviewer@example.test',
    approvedAt: '2026-10-01T12:00:00.000Z', targetSha256 } };
}

async function withEnvironment(values, operation) {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { return await operation(); }
  finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const approvedWorkflowEnvironment = Object.freeze({
  BILLING_VALIDATION_APPROVAL_ENVIRONMENT: 'billing-validation-tests',
  GITHUB_REPOSITORY: 'lawxcompany-stack/billing-validation-control',
  GITHUB_REPOSITORY_ID: '1384018279',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_REF_PROTECTED: 'true',
  GITHUB_WORKFLOW_REF: 'lawxcompany-stack/billing-validation-control/.github/workflows/validate-billing.yml@refs/heads/main',
  GITHUB_RUN_ID: '123456789',
  GITHUB_RUN_ATTEMPT: '1',
});

const configuredRef = 'abcdefghijklmnopqrst';
const configuredRole = 'billing_validation_writer';
const fakeManagementToken = 'synthetic-management-token';
const syntheticMigrations = [{ version: '20260930090000', name: 'synthetic_baseline' }];
const syntheticTypes = 'export type Database = { public: { Tables: Record<string, never> } };';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const configuredDatabasePolicy = Object.freeze({
  kind: 'standalone', projectRef: configuredRef, organizationId: 'org_synthetic', organizationSlug: 'org-synthetic',
  region: 'sa-east-1', databaseVersion: '17.6.1.054', postgresEngine: 'postgres', releaseChannel: 'ga',
  connection: { mode: 'direct', host: `db.${configuredRef}.supabase.co`, port: 5432,
    database: 'postgres', role: configuredRole },
  schemaFingerprintSha256: hash(syntheticTypes),
  migrationHistorySha256: hash(JSON.stringify(syntheticMigrations)),
});

async function withConfiguredMigrationExecutor(operation) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'billing-migration-'));
  try {
    const sourceDirectory = fileURLToPath(new URL('../../src/', import.meta.url));
    const policySource = fileURLToPath(new URL('../../policy/environment-policy.json', import.meta.url));
    const temporarySource = join(temporaryRoot, 'src');
    const temporaryPolicy = join(temporaryRoot, 'policy', 'environment-policy.json');
    await cp(sourceDirectory, temporarySource, { recursive: true });
    await mkdir(dirname(temporaryPolicy), { recursive: true });
    await cp(policySource, temporaryPolicy);
    const policy = JSON.parse(await readFile(temporaryPolicy, 'utf8'));
    policy.database = configuredDatabasePolicy;
    await writeFile(temporaryPolicy, `${JSON.stringify(policy, null, 2)}\n`);
    const moduleUrl = pathToFileURL(join(temporarySource, 'attempts/migrations.mjs')).href;
    const { applyAttemptMigrations } = await import(moduleUrl);
    return await operation({ applyAttemptMigrations, plan: await loadAttemptMigrationPlan() });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

const configuredRuntimeEnvironment = Object.freeze({
  ...approvedWorkflowEnvironment,
  SUPABASE_VALIDATION_MANAGEMENT_TOKEN: fakeManagementToken,
  SUPABASE_VALIDATION_PROJECT_REF: configuredRef,
  SUPABASE_VALIDATION_DATABASE_URL:
    `postgresql://${configuredRole}:synthetic-password@db.${configuredRef}.supabase.co:5432/postgres`,
});

function syntheticManagementResponse(url, { branch = false } = {}) {
  const project = { ref: configuredRef, organization_id: 'org_synthetic', region: 'sa-east-1',
    status: 'ACTIVE_HEALTHY', database: { host: `db.${configuredRef}.supabase.co`,
      version: '17.6.1.054', postgres_engine: 'postgres', release_channel: 'ga' },
    ...(branch ? { is_branch: true } : {}) };
  const inventory = [{ ref: configuredRef, organization_id: 'org_synthetic', region: 'sa-east-1',
    status: 'ACTIVE_HEALTHY', is_branch: false,
    database: { version: '17.6.1.054', postgres_engine: 'postgres', release_channel: 'ga' } }];
  const path = new URL(url).pathname;
  if (path === `/v1/projects/${configuredRef}`) return project;
  if (path === '/v1/organizations/org-synthetic/projects') return inventory;
  if (path === `/v1/projects/${configuredRef}/database/migrations`) return syntheticMigrations;
  if (path === `/v1/projects/${configuredRef}/types/typescript`) return { types: syntheticTypes };
  throw new Error(`unexpected synthetic management API path: ${path}`);
}

test('loads only the versioned migration allowlist with pinned exact content hashes', async () => {
  const plan = await loadAttemptMigrationPlan();
  assert.ok(plan.length > 0);
  assert.deepEqual(plan.map(({ version }) => version), [...plan.map(({ version }) => version)].sort());
  for (const migration of plan) assert.match(migration.sha256, /^[a-f0-9]{64}$/u);
  assert.throws(() => validateAttemptMigrationAllowlist([
    ...plan.map(({ file }) => file), '202610010002-unreviewed.sql',
  ].sort()), { code: 'migration_allowlist_mismatch' });
});

test('rejects edited applied migrations and unknown forward registry entries', async () => {
  const plan = await loadAttemptMigrationPlan();
  const first = plan[0];
  assert.throws(() => validateAppliedAttemptMigrations(plan, [{ version: first.version,
    name: first.name, sha256: 'f'.repeat(64) }]), { code: 'migration_applied_hash_mismatch' });
  assert.throws(() => validateAppliedAttemptMigrations(plan, [{ version: '999999999999',
    name: 'unknown', sha256: 'a'.repeat(64) }]), { code: 'migration_unknown_applied' });
  assert.throws(() => validateAppliedAttemptMigrations(plan, [
    { version: first.version, name: first.name, sha256: first.sha256 },
    { version: '999999999999', name: 'unknown', sha256: 'a'.repeat(64) },
  ]), { code: 'migration_unknown_applied' });
});

test('rejects reset, bootstrap, DROP, DELETE, TRUNCATE, and unsafe conditional DDL', () => {
  for (const sql of [
    'DROP TABLE billing_validation_control.fixture_leases;',
    'DELETE FROM billing_validation_control.fixture_leases;',
    "UPDATE billing_validation_control.attempts SET state = 'cancelled';",
    'MERGE INTO protected_table AS target USING source ON (target.id = source.id) WHEN MATCHED THEN DELETE;',
    'WITH removed AS (DELETE FROM billing_validation_control.fixture_leases RETURNING *) SELECT count(*) FROM removed;',
    'EXPLAIN (ANALYZE) DELETE FROM billing_validation_control.fixture_leases;',
    'TRUNCATE billing_validation_control.fixture_leases;',
    'SET standard_conforming_strings = off;',
    'RESET ROLE;',
    'CREATE SCHEMA IF NOT EXISTS billing_validation_control;',
    'CREATE DATABASE billing_validation_control;',
    'ALTER TABLE billing_validation_control.retention_receipts DISABLE TRIGGER USER;',
    'CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN DELETE FROM protected_table; END; $$;',
    "CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN EXECUTE 'DELETE FROM protected_table'; END; $$;",
    'CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN WITH removed AS (DELETE FROM protected_table RETURNING *) SELECT count(*) INTO STRICT n FROM removed; END; $$;',
    "CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS 'BEGIN DELETE FROM protected_table; END;' ;",
    "CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS E'BEGIN UPDATE protected_table SET value = 1; END;' ;",
    "CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS E'BEGIN \\x44ELETE FROM protected_table; END;' ;",
    "CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS 'BEGIN \\x44ELETE FROM protected_table; END;' ;",
    "CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS 'BEGIN EXECUTE ''TRUNCATE protected_table''; END;' ;",
    "CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS 'BEGIN RAISE NOTICE ''--''; DELETE FROM protected_table; END;' ;",
    "CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$BEGIN RAISE NOTICE '--'; DELETE FROM protected_table; END;$$;",
    'CREATE RULE remove_attempt AS ON UPDATE TO protected_table DO ALSO DELETE FROM protected_table;',
    'CREATE FUNCTION f() RETURNS void LANGUAGE SQL BEGIN ATOMIC DELETE FROM protected_table; END;',
    'COPY protected_table FROM STDIN;',
    'GRANT ALL ON TABLE protected_table TO PUBLIC;',
    'SELECT * INTO copied_attempts FROM billing_validation_control.attempts;',
    'REFRESH MATERIALIZED VIEW protected_view;',
    'CREATE TABLE copied_attempts AS SELECT * FROM billing_validation_control.attempts;',
    'CREATE TABLE copied_attempts AS (SELECT * FROM billing_validation_control.attempts);',
    'CREATE TABLE copied_attempts AS WITH source AS (SELECT * FROM billing_validation_control.attempts) SELECT * FROM source;',
    'CREATE TABLE copied_attempts AS TABLE billing_validation_control.attempts;',
    'CREATE TABLE copied_attempts AS VALUES ((SELECT to_jsonb(a) FROM billing_validation_control.attempts a LIMIT 1));',
    'ALTER TABLE protected_table ENABLE TRIGGER ALL;',
    'CREATE OR REPLACE FUNCTION billing_validation_control.validate_fixture_case_claim() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END;$$;',
    "CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS 'BEGIN RAISE NOTICE ''DELETE''; END;' ;",
    "CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$BEGIN RAISE NOTICE '--'; END;$$;",
  ]) assert.throws(() => validateMigrationSql(sql), { code: 'migration_unsafe_sql' });
  assert.doesNotThrow(() => validateMigrationSql(
    'CREATE TABLE billing_validation_control.forward_only (id bigint PRIMARY KEY);'));
  assert.throws(() => validateMigrationSql(
    'CREATE TRIGGER untrusted AFTER INSERT ON protected_table FOR EACH ROW EXECUTE FUNCTION outside.safe_handler();'),
  { code: 'migration_unsafe_sql' });
});

for (const [endingName, lineEnding] of [['bare CR', '\r'], ['CRLF', '\r\n'], ['LF', '\n']]) {
  for (const [statementName, statement] of [
    ['DELETE', 'DELETE FROM billing_validation_control.fixture_leases;'],
    ['DROP', 'DROP TABLE billing_validation_control.fixture_leases;'],
    ['TRUNCATE', 'TRUNCATE billing_validation_control.fixture_leases;'],
    ['SQL-standard routine', 'CREATE FUNCTION unreviewed() RETURNS integer LANGUAGE SQL RETURN 1;'],
    ['dollar-quoted routine', 'CREATE FUNCTION unreviewed() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END;$$;'],
    ['trigger', 'CREATE TRIGGER unreviewed BEFORE INSERT ON billing_validation_control.fixture_leases FOR EACH ROW EXECUTE FUNCTION outside.safe_handler();'],
  ]) {
    for (const [suffixName, suffix] of [['at EOF', ''], ['before a later LF', '\nCREATE TABLE also_safe (id bigint);']]) {
      test(`line comments ending with ${endingName} cannot hide ${statementName} ${suffixName}`, () => {
        assert.throws(() => validateMigrationSql(
          `CREATE TABLE safe (id bigint); -- comment${lineEnding}${statement}${suffix}`),
        { code: 'migration_unsafe_sql' });
      });
    }
  }

  test(`line comments ending with ${endingName} allow safe DDL and keep comment text masked`, () => {
    assert.equal(validateMigrationSql(
      `CREATE TABLE safe (id bigint); -- DELETE FROM protected_table;${lineEnding}` +
      'CREATE TABLE also_safe (id bigint); -- DROP TABLE protected_table;'), true);
  });
}

test('routine attributes cannot be changed while retaining a pinned trigger body', async () => {
  const [migration] = await loadAttemptMigrationPlan();
  const altered = migration.sql.replace('LANGUAGE plpgsql\nSET search_path = pg_catalog',
    'LANGUAGE plpgsql\nSECURITY DEFINER\nSET search_path = pg_catalog');
  assert.notEqual(altered, migration.sql);
  assert.throws(() => validateMigrationSql(altered), { code: 'migration_unsafe_sql' });
});

test('duplicate trigger routine definitions cannot inherit the first definition hash', async () => {
  const [migration] = await loadAttemptMigrationPlan();
  const start = migration.sql.indexOf('CREATE OR REPLACE FUNCTION billing_validation_control.validate_fixture_case_claim()');
  const delimiter = '\n$$;';
  const end = migration.sql.indexOf(delimiter, start) + delimiter.length;
  assert.ok(start >= 0 && end > start);
  const duplicate = migration.sql.slice(start, end).replace('LANGUAGE plpgsql\nSET search_path = pg_catalog',
    'LANGUAGE plpgsql\nSECURITY DEFINER\nSET search_path = pg_catalog');
  assert.throws(() => validateMigrationSql(`${migration.sql}\n${duplicate}`),
    { code: 'migration_unsafe_sql' });
});

test('every CREATE FUNCTION requires a captured, pinned definition', async (t) => {
  const [migration] = await loadAttemptMigrationPlan();
  for (const [name, sql] of [
    ['SQL-standard RETURN expression', 'CREATE FUNCTION unreviewed() RETURNS integer LANGUAGE SQL RETURN 1;'],
    ['SQL-standard RETURN without a terminator', 'CREATE FUNCTION unreviewed() RETURNS integer LANGUAGE SQL RETURN 1'],
    ['SQL-standard replacement', 'CREATE OR REPLACE FUNCTION unreviewed() RETURNS integer LANGUAGE SQL RETURN 1;'],
    ['comment-separated SQL-standard definition', 'CREATE /* routine */ FUNCTION unreviewed() RETURNS integer LANGUAGE SQL RETURN 1;'],
    ['quoted SQL-standard name', 'CREATE FUNCTION "unreviewed"() RETURNS integer LANGUAGE SQL RETURN 1;'],
    ['uncaptured AS body', 'CREATE FUNCTION unreviewed() RETURNS integer LANGUAGE SQL AS unreviewed_body;'],
  ]) {
    await t.test(name, () => {
      assert.throws(() => validateMigrationSql(sql), { code: 'migration_unsafe_sql' });
      assert.throws(() => validateMigrationSql(`${migration.sql}\n${sql}`), { code: 'migration_unsafe_sql' });
    });
  }
});

test('SQL-standard helpers cannot shadow clock_timestamp beside pinned routines', async (t) => {
  const [migration] = await loadAttemptMigrationPlan();
  for (const name of ['clock_timestamp', 'pg_catalog.clock_timestamp', 'billing_validation_control.clock_timestamp']) {
    await t.test(name, () => {
      const helper = `CREATE OR REPLACE FUNCTION ${name}() RETURNS timestamptz LANGUAGE SQL RETURN '2099-01-01T00:00:00Z'::timestamptz;`;
      assert.throws(() => validateMigrationSql(`${helper}\n${migration.sql}`), { code: 'migration_unsafe_sql' });
      assert.throws(() => validateMigrationSql(`${migration.sql}\n${helper}`), { code: 'migration_unsafe_sql' });
    });
  }
});

test('every trigger is pinned to its full reviewed statement and binding', async (t) => {
  const [migration] = await loadAttemptMigrationPlan();
  const triggers = [...migration.sql.matchAll(/CREATE TRIGGER [\s\S]*?;/gu)].map(([statement]) => statement);
  assert.equal(triggers.length, 5);
  assert.equal(validateMigrationSql(migration.sql), true);
  for (const trigger of triggers) {
    await t.test(trigger.split('\n')[0], async (t) => {
      for (const [name, altered] of [
        ['table', trigger.replace(/\bON billing_validation_control\.[a-z_]+/u, 'ON billing_validation_control.attempts')],
        ['timing', trigger.replace('BEFORE', 'AFTER')],
        ['event', trigger.replace(/\b(?:INSERT|UPDATE OR DELETE|TRUNCATE) ON/u, 'INSERT OR UPDATE ON')],
        ['name', trigger.replace(/CREATE TRIGGER [a-z_]+/u, 'CREATE TRIGGER unreviewed')],
        ['row or statement scope', trigger.replace(/FOR EACH (ROW|STATEMENT)/u,
          (_, scope) => `FOR EACH ${scope === 'ROW' ? 'STATEMENT' : 'ROW'}`)],
        ['function arguments', trigger.replace('();', "('unreviewed');")],
        ['WHEN predicate', trigger.replace(' EXECUTE FUNCTION', ' WHEN (false) EXECUTE FUNCTION')],
        ['routine', trigger.replace(/EXECUTE FUNCTION billing_validation_control\.[a-z_]+/u,
          'EXECUTE FUNCTION billing_validation_control.validate_fixture_case_claim')],
      ]) {
        await t.test(name, () => {
          assert.notEqual(altered, trigger);
          const sql = migration.sql.replace(trigger, altered);
          assert.throws(() => validateMigrationSql(sql), { code: 'migration_unsafe_sql' });
        });
      }
    });
  }
});

test('executor refuses when it is not running after the protected Environment approval', async () => {
  let transactions = 0;
  const client = { async transaction() { transactions += 1; } };
  await assert.rejects(applyAttemptMigrations({ client }), { code: 'migration_approval_required' });
  assert.equal(transactions, 0);
});

test('executor refuses before opening a session while its trusted project policy is unconfigured', async () => {
  const { policy, targetReadback, approval } = approvedTarget();
  const calls = [];
  const client = { async transaction(fn) {
    return fn({ async query(sql) {
      calls.push(sql);
      if (sql.includes('to_regclass')) return { rows: [{ ready: false, ledger_ready: false }] };
      return { rowCount: 1, rows: [] };
    } });
  } };
  await withEnvironment(approvedWorkflowEnvironment, async () => {
    await assert.rejects(applyAttemptMigrations({ client, policy, targetReadback, approval }),
      { code: 'migration_target_unconfigured' });
  });
  assert.equal(calls.length, 0);
});

test('caller-supplied policy, readback, and approval cannot open a migration transaction', async () => {
  const { policy, targetReadback, approval } = approvedTarget();
  let transactions = 0;
  const client = { async transaction() { transactions += 1; } };
  await withEnvironment(approvedWorkflowEnvironment, async () => {
    await assert.rejects(applyAttemptMigrations({ client, policy, targetReadback, approval }),
      { code: 'migration_target_unconfigured' });
  });
  assert.equal(transactions, 0);
});

test('reads target identity from Supabase and PostgreSQL before applying the exact allowlisted migration', async () => {
  await withConfiguredMigrationExecutor(async ({ applyAttemptMigrations, plan }) => {
    const originalFetch = globalThis.fetch;
    const apiPaths = [];
    const statements = [];
    let transactions = 0;
    const client = {
      connectionParameters: { host: configuredDatabasePolicy.connection.host, port: 5432,
        database: 'postgres', user: configuredRole,
        ssl: { rejectUnauthorized: true, servername: configuredDatabasePolicy.connection.host } },
      async transaction(operation) {
        transactions += 1;
        assert.equal(apiPaths.length, 4, 'provider identity, schema, and migrations are read before SQL');
        return operation({ async query(sql) {
          statements.push(sql);
          if (sql.includes('current_database()')) return { rows: [{ database_name: 'postgres',
            role_name: configuredRole, server_version_num: '170006' }] };
          if (sql.includes('to_regclass')) return { rows: [{ ready: true, ledger_ready: false }] };
          return { rowCount: 1, rows: [] };
        } });
      },
    };
    globalThis.fetch = async (url, init) => {
      assert.equal(init.method, 'GET');
      assert.equal(init.headers.Authorization, `Bearer ${fakeManagementToken}`);
      apiPaths.push(new URL(url).pathname);
      return new Response(JSON.stringify(syntheticManagementResponse(url)), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    };
    try {
      const result = await withEnvironment(configuredRuntimeEnvironment,
        () => applyAttemptMigrations({ client }));
      assert.deepEqual(apiPaths, [
        `/v1/projects/${configuredRef}`,
        '/v1/organizations/org-synthetic/projects',
        `/v1/projects/${configuredRef}/database/migrations`,
        `/v1/projects/${configuredRef}/types/typescript`,
      ]);
      assert.equal(transactions, 1);
      assert.deepEqual(result.appliedVersions, ['202610010001']);
      assert.equal(statements[0], 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      assert.match(statements[1], /current_database\(\).*current_user.*server_version_num/isu);
      assert.equal(statements[2].includes('to_regclass'), true);
      assert.equal(statements[3], plan[0].sql);
      assert.match(statements[4], /^INSERT INTO billing_validation_control\.schema_migrations/u);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('a mismatched connected PostgreSQL role stops before baseline inspection or migration DDL', async () => {
  await withConfiguredMigrationExecutor(async ({ applyAttemptMigrations }) => {
    const originalFetch = globalThis.fetch;
    const statements = [];
    globalThis.fetch = async (url) => new Response(JSON.stringify(syntheticManagementResponse(url)), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
    const client = {
      connectionParameters: { host: configuredDatabasePolicy.connection.host, port: 5432,
        database: 'postgres', user: configuredRole,
        ssl: { rejectUnauthorized: true, servername: configuredDatabasePolicy.connection.host } },
      async transaction(operation) {
        return operation({ async query(sql) {
          statements.push(sql);
          if (sql.includes('current_database()')) return { rows: [{ database_name: 'postgres',
            role_name: 'service_role', server_version_num: '170006' }] };
          return { rowCount: 1, rows: [] };
        } });
      },
    };
    try {
      await withEnvironment(configuredRuntimeEnvironment, () => assert.rejects(
        applyAttemptMigrations({ client }), { code: 'migration_connection_identity_mismatch' }));
      assert.equal(statements.some((sql) => sql.includes('to_regclass')), false);
      assert.equal(statements.length, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('a connected PostgreSQL minor version mismatch stops before baseline inspection or migration DDL', async () => {
  await withConfiguredMigrationExecutor(async ({ applyAttemptMigrations }) => {
    const originalFetch = globalThis.fetch;
    const statements = [];
    globalThis.fetch = async (url) => new Response(JSON.stringify(syntheticManagementResponse(url)), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
    const client = {
      connectionParameters: { host: configuredDatabasePolicy.connection.host, port: 5432,
        database: 'postgres', user: configuredRole,
        ssl: { rejectUnauthorized: true, servername: configuredDatabasePolicy.connection.host } },
      async transaction(operation) {
        return operation({ async query(sql) {
        statements.push(sql);
        if (sql.includes('current_database()')) return { rows: [{ database_name: 'postgres',
          role_name: configuredRole, server_version_num: '170004' }] };
        if (sql.includes('to_regclass')) return { rows: [{ ready: true, ledger_ready: false }] };
        return { rowCount: 1, rows: [] };
        } });
      },
    };
    try {
      await withEnvironment(configuredRuntimeEnvironment, () => assert.rejects(
        applyAttemptMigrations({ client }), { code: 'migration_connection_identity_mismatch' }));
      assert.equal(statements.some((sql) => sql.includes('to_regclass')), false);
      assert.equal(statements.length, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
