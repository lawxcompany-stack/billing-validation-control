import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildRetentionValidationSql, parseLoopbackPostgresUrl, runRetentionValidation }
  from '../../scripts/test-postgres-retention.mjs';

function localHarnessBaseline(schemaSql) {
  return schemaSql.replace(
    /^CREATE FUNCTION billing_validation_control\.(valid_retention_usage|valid_cleanup_projection)\b/gmu,
    'CREATE OR REPLACE FUNCTION billing_validation_control.$1',
  );
}

test('local PostgreSQL URL accepts only loopback destinations without disclosing credentials', () => {
  assert.deepEqual(parseLoopbackPostgresUrl('postgresql://tester:s3cret@localhost:55432/billing_test'), {
    hostAddress: '127.0.0.1', port: '55432', user: 'tester', password: 's3cret', database: 'billing_test',
  });
  assert.equal(parseLoopbackPostgresUrl('postgres://tester@127.0.0.8/billing_test').hostAddress, '127.0.0.8');
  assert.equal(parseLoopbackPostgresUrl('postgres://tester@[::1]/billing_test').hostAddress, '::1');

  for (const url of [
    'postgres://tester:sensitive@db.example.test/billing_test',
    'postgres://tester:sensitive@10.0.0.2/billing_test',
    'https://tester:sensitive@localhost/billing_test',
    'not a connection string',
  ]) {
    assert.throws(() => parseLoopbackPostgresUrl(url), (error) => {
      assert.equal(error.code, 'local_postgres_url_invalid');
      assert.equal(error.message.includes('sensitive'), false);
      assert.equal(error.message.includes(url), false);
      return true;
    });
  }
});

test('local PostgreSQL runner refuses remote hosts before spawning psql', () => {
  let spawned = false;
  assert.throws(() => runRetentionValidation({
    connectionUrl: 'postgres://tester:private-value@db.example.test/billing_test',
    schemaSql: 'unused',
    spawn: () => { spawned = true; return { status: 0 }; },
  }), { code: 'local_postgres_url_invalid' });
  assert.equal(spawned, false);
});

test('local PostgreSQL runner passes credentials only in environment and sends SQL on stdin', () => {
  const connectionUrl = 'postgres://tester:private-value@localhost:55432/billing_test';
  const schemaSql = localHarnessBaseline(
    readFileSync(new URL('../../src/attempts/schema.sql', import.meta.url), 'utf8'));
  let invocation;
  const inheritedService = process.env.PGSERVICE;
  process.env.PGSERVICE = 'must-not-be-inherited';
  try {
    runRetentionValidation({ connectionUrl, schemaSql, spawn: (...args) => {
      invocation = args;
      return { status: 0, stdout: '', stderr: '' };
    } });
  } finally {
    if (inheritedService === undefined) delete process.env.PGSERVICE;
    else process.env.PGSERVICE = inheritedService;
  }

  assert.equal(invocation[0], 'psql');
  assert.equal(invocation[1].includes(connectionUrl), false);
  assert.equal(invocation[1].includes('private-value'), false);
  assert.equal(Object.hasOwn(invocation[2].env, 'PGSERVICE'), false);
  assert.equal(invocation[2].env.PGHOSTADDR, '127.0.0.1');
  assert.equal(invocation[2].env.PGPORT, '55432');
  assert.equal(invocation[2].env.PGPASSWORD, 'private-value');
  assert.match(invocation[2].input, /valid_retention_usage/);
  assert.equal(invocation[2].input.includes('private-value'), false);
  assert.equal(invocation[2].timeout, 15_000);
});

test('local PostgreSQL SQL executes the checked-in validator against integer and decimal JSONB', () => {
  const schemaSql = readFileSync(new URL('../../src/attempts/schema.sql', import.meta.url), 'utf8');
  assert.match(schemaSql, /^CREATE FUNCTION billing_validation_control\.valid_retention_usage\b/mu);
  const sql = buildRetentionValidationSql(
    localHarnessBaseline(schemaSql), 'billing_validation_test_0123456789abcdef');

  assert.match(sql, /CREATE SCHEMA billing_validation_test_0123456789abcdef;/);
  assert.ok(sql.indexOf('CREATE SCHEMA billing_validation_test_0123456789abcdef;') <
    sql.indexOf('CREATE OR REPLACE FUNCTION billing_validation_test_0123456789abcdef.valid_retention_usage'));
  assert.match(sql, /CREATE OR REPLACE FUNCTION billing_validation_test_0123456789abcdef\.valid_retention_usage/);
  assert.match(sql, /\{"attempts":1,"databaseRows":2,"authUsers":0,"stripeObjects":3\}/);
  assert.match(sql, /\{"attempts":1,"databaseRows":2\.0,"authUsers":0,"stripeObjects":3\}/);
  assert.match(sql, /canonical_retention_usage_rejected/);
  assert.match(sql, /decimal_retention_usage_accepted/);
  assert.match(sql, /ROLLBACK;/);

  assert.throws(() => buildRetentionValidationSql(schemaSql, 'unsafe; DROP SCHEMA public'), {
    code: 'local_postgres_schema_invalid',
  });
});

test('local PostgreSQL cleanup projection SQL executes the checked-in closed-schema validator', () => {
  const schemaSql = readFileSync(new URL('../../src/attempts/schema.sql', import.meta.url), 'utf8');
  const sql = buildRetentionValidationSql(
    localHarnessBaseline(schemaSql), 'billing_validation_test_0123456789abcdef');

  assert.match(sql, /CREATE OR REPLACE FUNCTION billing_validation_test_0123456789abcdef\.valid_cleanup_projection/);
  assert.ok(sql.indexOf('CREATE SCHEMA billing_validation_test_0123456789abcdef;') <
    sql.indexOf('CREATE OR REPLACE FUNCTION billing_validation_test_0123456789abcdef.valid_cleanup_projection'));
  assert.match(sql, /canonical_cleanup_projection_rejected/);
  assert.match(sql, /unknown_cleanup_projection_field_accepted/);
  assert.match(sql, /invalid_cleanup_projection_accepted/);
});
