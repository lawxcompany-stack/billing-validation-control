import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadAttemptMigrationPlan, validateAppliedAttemptMigrations,
  validateAttemptMigrationAllowlist, validateMigrationSql } from '../../src/attempts/migrations.mjs';

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

test('runtime migration module has no executable migration path', async () => {
  const migrations = await import('../../src/attempts/migrations.mjs');

  assert.equal('applyAttemptMigrations' in migrations, false);
});

test('control migration rendering is an offline bundle of only pending pinned control SQL', async () => {
  const controlPlan = await (await import('../../src/attempts/control-store-bootstrap.mjs'))
    .loadControlStoreBootstrapPlan();
  const { renderControlStoreMigrationBundle } = await import('../../src/attempts/control-store-bootstrap.mjs');
  const { testBaselineDigest } = await import('./control-store-fixtures.mjs');
  const { CONTROL_STORE_POLICY } = await import('../../src/attempts/control-store-policy.mjs');
  assert.equal(typeof renderControlStoreMigrationBundle, 'function');

  const bundle = renderControlStoreMigrationBundle({
    policy: CONTROL_STORE_POLICY,
    baselineSha256: testBaselineDigest(),
    migrations: controlPlan.migrations,
    applied: controlPlan.migrations.slice(0, 2).map(({ version, name, sha256 }) => ({ version, name, sha256 })),
  });

  assert.match(bundle, /202610030001/u);
  assert.doesNotMatch(bundle, /^\s*(?:DROP|DELETE|TRUNCATE)\b/imu);
});
