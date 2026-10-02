import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { CONTROL_STORE_POLICY } from '../../src/attempts/control-store-policy.mjs';
import { testControlVerifierRow } from './control-store-fixtures.mjs';

const RUNNER_URL = new URL('../../runner/verify-control-store.mjs', import.meta.url);
const RUNNER_PATH = fileURLToPath(RUNNER_URL);
const DATABASE_URL = 'postgresql://billing_validation_verifier:synthetic-control-password@db.ceindkuafycqdcplfrgs.supabase.co:5432/postgres?sslmode=require';

async function loadRunner() {
  return import(RUNNER_URL.href);
}

function makeFakeClient({ row = testControlVerifierRow(CONTROL_STORE_POLICY), queryError } = {}) {
  const events = [];
  const configs = [];
  const client = {
    async connect() {
      events.push(['connect']);
    },
    async query(statement) {
      const sql = typeof statement === 'string' ? statement : statement.text;
      events.push(['query', sql, typeof statement === 'object' ? statement.query_timeout : undefined]);
      if (sql === 'BEGIN READ ONLY' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql === 'SELECT * FROM billing_validation_control.verify_attempt_control_store()') {
        if (queryError) throw queryError;
        return { rows: row === undefined ? [] : [row] };
      }
      throw new Error('Unexpected query in read-only control-store verifier test.');
    },
    async end() {
      events.push(['end']);
    },
  };

  return {
    events,
    configs,
    createClient(config) {
      events.push(['construct']);
      configs.push(config);
      return client;
    },
  };
}

test('importing the runtime verifier has no database connection or output side effects', () => {
  const importSource = 'await import(' + JSON.stringify(RUNNER_URL.href) +
    '); process.stdout.write("imported\\n");';
  const child = spawnSync(process.execPath, [
    '--input-type=module', '-e', importSource,
  ], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? '', BILLING_CONTROL_VERIFIER_DATABASE_URL: 'malformed-local-test-input' },
    encoding: 'utf8',
  });

  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, 'imported\n');
  assert.equal(child.stderr, '');
});

test('missing control URL is refused before constructing the PostgreSQL client', async () => {
  const { runControlStoreVerification } = await loadRunner();
  let constructions = 0;

  await assert.rejects(runControlStoreVerification({
    environment: {},
    createClient() {
      constructions += 1;
      throw new Error('client must not be constructed');
    },
  }), { code: 'control_store_runtime_refused' });

  assert.equal(constructions, 0);
});

test('the financial/runtime URL name cannot substitute for the verifier credential', async () => {
  const { runControlStoreVerification } = await loadRunner();
  let constructions = 0;

  await assert.rejects(runControlStoreVerification({
    environment: { BILLING_CONTROL_DATABASE_URL: DATABASE_URL },
    createClient() {
      constructions += 1;
      throw new Error('the runtime identity must not be used by the verifier');
    },
  }), { code: 'control_store_runtime_refused' });

  assert.equal(constructions, 0);
});

test('malformed or non-approved control targets are refused before connecting', async () => {
  const { runControlStoreVerification } = await loadRunner();
  const rejectedUrls = [
    'postgresql://billing_validation_verifier:sentinel@db.otherproject.invalid:5432/postgres?sslmode=require',
    'postgresql://billing_validation_verifier:sentinel@db.ceindkuafycqdcplfrgs.supabase.co:5432/postgres',
    'postgresql://billing_validation_runtime:sentinel@db.ceindkuafycqdcplfrgs.supabase.co:5432/postgres?sslmode=require',
    'postgresql://postgres:sentinel@db.ceindkuafycqdcplfrgs.supabase.co:5432/postgres?sslmode=require',
  ];

  for (const databaseUrl of rejectedUrls) {
    let constructions = 0;
    await assert.rejects(runControlStoreVerification({
      environment: { BILLING_CONTROL_VERIFIER_DATABASE_URL: databaseUrl },
      createClient() {
        constructions += 1;
        throw new Error('client must not be constructed');
      },
    }), (error) => error.code === 'control_store_runtime_refused' &&
      !error.message.includes('sentinel') && !JSON.stringify(error).includes(databaseUrl));
    assert.equal(constructions, 0);
  }
});

test('approved target uses verified TLS and exact host SNI in a read-only verifier transaction', async () => {
  const { runControlStoreVerification } = await loadRunner();
  const fake = makeFakeClient();
  const receipt = await runControlStoreVerification({
    environment: { BILLING_CONTROL_VERIFIER_DATABASE_URL: DATABASE_URL },
    createClient: fake.createClient,
  });

  assert.deepEqual(fake.configs, [{
    host: CONTROL_STORE_POLICY.connection.host,
    port: CONTROL_STORE_POLICY.connection.port,
    database: CONTROL_STORE_POLICY.connection.database,
    user: CONTROL_STORE_POLICY.roles.verifier,
    password: 'synthetic-control-password',
    ssl: { rejectUnauthorized: true, servername: CONTROL_STORE_POLICY.connection.host },
    connectionTimeoutMillis: 5000,
  }]);
  assert.deepEqual(fake.events.filter(([kind]) => kind === 'query').map(([, sql]) => sql), [
    'BEGIN READ ONLY',
    'SELECT * FROM billing_validation_control.verify_attempt_control_store()',
    'COMMIT',
  ]);
  assert.equal(fake.events[0][0], 'construct');
  assert.equal(fake.events[1][0], 'connect');
  assert.equal(fake.events.at(-1)[0], 'end');
  assert.equal(fake.events.some(([, sql = '']) =>
    /\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|COPY|CALL|DO)\b/iu.test(sql)), false);
  assert.deepEqual(receipt, {
    projectRef: CONTROL_STORE_POLICY.projectRef,
    database: 'postgres',
    role: 'billing_validation_verifier',
    serverVersion: '170011',
    baselineSha256: testControlVerifierRow(CONTROL_STORE_POLICY).baseline_sha256,
    migrationSha256: testControlVerifierRow(CONTROL_STORE_POLICY).migration_sha256,
    privilegeFingerprintSha256: testControlVerifierRow(CONTROL_STORE_POLICY).privilege_fingerprint_sha256,
  });
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(JSON.stringify(receipt).includes('synthetic-control-password'), false);
  assert.equal(JSON.stringify(receipt).includes(DATABASE_URL), false);
});

test('control identity refusal rolls back the read-only transaction', async () => {
  const { runControlStoreVerification } = await loadRunner();
  const fake = makeFakeClient({
    row: { ...testControlVerifierRow(CONTROL_STORE_POLICY), project_ref: 'abcdefghijklmnopqrst' },
  });

  await assert.rejects(runControlStoreVerification({
    environment: { BILLING_CONTROL_VERIFIER_DATABASE_URL: DATABASE_URL },
    createClient: fake.createClient,
  }), { code: 'control_store_runtime_refused' });

  assert.deepEqual(fake.events.filter(([kind]) => kind === 'query').map(([, sql]) => sql), [
    'BEGIN READ ONLY',
    'SELECT * FROM billing_validation_control.verify_attempt_control_store()',
    'ROLLBACK',
  ]);
  assert.equal(fake.events.at(-1)[0], 'end');
});

test('database errors are replaced with a fixed refusal without echoing the URL', async () => {
  const { runControlStoreVerification } = await loadRunner();
  const fake = makeFakeClient({ queryError: new Error('SQL failure for ' + DATABASE_URL) });

  await assert.rejects(runControlStoreVerification({
    environment: { BILLING_CONTROL_VERIFIER_DATABASE_URL: DATABASE_URL },
    createClient: fake.createClient,
  }), (error) => error.code === 'control_store_runtime_refused' &&
    !error.message.includes(DATABASE_URL) && !JSON.stringify(error).includes('synthetic-control-password'));

  assert.deepEqual(fake.events.filter(([kind]) => kind === 'query').map(([, sql]) => sql), [
    'BEGIN READ ONLY',
    'SELECT * FROM billing_validation_control.verify_attempt_control_store()',
    'ROLLBACK',
  ]);
  assert.equal(fake.events.at(-1)[0], 'end');
});

test('command-line refusal prints only a fixed code and never echoes configuration', () => {
  const child = spawnSync(process.execPath, [RUNNER_PATH], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? '' },
    encoding: 'utf8',
  });

  assert.equal(child.error, undefined);
  assert.equal(child.status, 1);
  assert.equal(child.stdout, '');
  assert.equal(child.stderr, 'Control-store verification refused (control_store_runtime_refused).\n');
});
