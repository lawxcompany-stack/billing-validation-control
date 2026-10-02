import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const BASELINE_URL = new URL('../../src/attempts/schema.sql', import.meta.url);
const MIGRATION_NAME = '202610010001-standalone-lease-fencing.sql';
const MIGRATION_URL = new URL(`../../src/attempts/migrations/${MIGRATION_NAME}`, import.meta.url);
const MODULE_URL = new URL('../../src/attempts/control-store-bootstrap.mjs', import.meta.url);
const CONTROL_PROJECT_REF = 'ceindkuafycqdcplfrgs';
const REFUSAL_CODE = 'control_store_bootstrap_invalid';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function loadApi() {
  return import(MODULE_URL.href);
}

async function createSourceFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'billing-control-bootstrap-'));
  const migrationDirectory = join(directory, 'migrations');
  await mkdir(migrationDirectory);
  const baselinePath = join(directory, 'schema.sql');
  const migrationPath = join(migrationDirectory, MIGRATION_NAME);
  await copyFile(BASELINE_URL, baselinePath);
  await copyFile(MIGRATION_URL, migrationPath);
  return { directory, baselinePath, migrationDirectory, migrationPath };
}

async function assertBootstrapRefusal(action) {
  await assert.rejects(action, (error) => {
    assert.equal(error.code, REFUSAL_CODE);
    assert.equal(error.message, 'Control store bootstrap input is invalid.');
    return true;
  });
}

test('first-install baseline has one-shot DDL and preserves append-only truncate guards', async () => {
  const baselineSql = await readFile(BASELINE_URL, 'utf8');
  assert.doesNotMatch(baselineSql, /\b(?:IF\s+NOT\s+EXISTS|OR\s+REPLACE|DROP\s+TRIGGER|DROP\s+SCHEMA)\b/iu);
  assert.doesNotMatch(baselineSql, /^\s*TRUNCATE\b/imu);
  assert.doesNotMatch(baselineSql, /^\s*CREATE\s+SCHEMA\b/imu);
  assert.doesNotMatch(baselineSql, /\bDO\s+\$\$[\s\S]*?\bEXECUTE\s+format\b/iu);
  for (const table of ['retention_reservations', 'retention_receipts', 'stripe_intents', 'stripe_receipts',
    'fixture_reservation_claims', 'fixture_case_claims', 'fixture_resource_claims', 'cleanup_receipts']) {
    assert.match(baselineSql, new RegExp(`BEFORE TRUNCATE ON billing_validation_control\\.${table}`));
  }
  for (const [, objectName] of baselineSql.matchAll(/^CREATE\s+(?:FUNCTION|TABLE)\s+([A-Za-z0-9_.]+)/gmu)) {
    assert.ok(objectName.startsWith('billing_validation_control.'), `unexpected baseline object ${objectName}`);
  }
  for (const [, schemaName] of baselineSql.matchAll(/^CREATE\s+INDEX\s+[A-Za-z0-9_]+\s+ON\s+([A-Za-z0-9_.]+)/gmu)) {
    assert.ok(schemaName.startsWith('billing_validation_control.'), `unexpected baseline index table ${schemaName}`);
  }
  for (const [statement] of baselineSql.matchAll(/^CREATE\s+TRIGGER\b[\s\S]*?;/gmu)) {
    assert.match(statement, /\bON\s+billing_validation_control\./u);
  }

  const { loadControlStoreBootstrapPlan, renderControlStoreBootstrap } = await loadApi();
  const plan = await loadControlStoreBootstrapPlan();
  const sql = renderControlStoreBootstrap(plan);

  assert.equal(plan.projectRef, CONTROL_PROJECT_REF);
  assert.equal(plan.baselineSha256, sha256(Buffer.from(plan.baselineSql, 'utf8')));
  assert.equal(plan.runtimeLogin, false);
  assert.match(sql, /^BEGIN;\s*$/mu);
  assert.match(sql, /CREATE ROLE billing_validation_owner NOLOGIN;/u);
  assert.match(sql, /CREATE ROLE billing_validation_runtime NOLOGIN;/u);
  assert.match(sql, /CREATE SCHEMA billing_validation_control AUTHORIZATION billing_validation_owner;/u);
  assert.match(sql, /SET LOCAL ROLE billing_validation_owner;/u);
  assert.match(sql, /billing_validation_control\.control_store_install_receipts/u);
  assert.match(sql, /billing_validation_control\.schema_migrations/u);
  assert.match(sql, /COMMIT;\s*$/u);
});

test('loaded bootstrap plan is frozen, ordered, project-pinned, and digest-verified', async () => {
  const { loadControlStoreBootstrapPlan } = await loadApi();
  const plan = await loadControlStoreBootstrapPlan();

  assert.equal(plan.projectRef, CONTROL_PROJECT_REF);
  assert.equal(plan.baselineSql, await readFile(BASELINE_URL, 'utf8'));
  assert.equal(plan.baselineSha256, sha256(await readFile(BASELINE_URL)));
  assert.deepEqual(plan.migrations.map(({ version, name, file }) => ({ version, name, file })), [
    {
      version: '202610010001',
      name: 'standalone-lease-fencing',
      file: MIGRATION_NAME,
    },
  ]);
  assert.equal(plan.migrations[0].sha256, sha256(await readFile(MIGRATION_URL)));
  assert.equal(plan.runtimeLogin, false);
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.migrations), true);
  assert.equal(Object.isFrozen(plan.migrations[0]), true);
});

test('renderer emits one guarded transaction in baseline then forward-migration order', async () => {
  const { loadControlStoreBootstrapPlan, renderControlStoreBootstrap } = await loadApi();
  const plan = await loadControlStoreBootstrapPlan();
  const sql = renderControlStoreBootstrap(plan);

  const preflight = sql.indexOf('DO $control_store_preflight$');
  const ownerRole = sql.indexOf('CREATE ROLE billing_validation_owner NOLOGIN;');
  const runtimeRole = sql.indexOf('CREATE ROLE billing_validation_runtime NOLOGIN;');
  const schema = sql.indexOf('CREATE SCHEMA billing_validation_control AUTHORIZATION billing_validation_owner;');
  const baseline = sql.indexOf(plan.baselineSql.trim());
  const receipt = sql.indexOf('INSERT INTO billing_validation_control.control_store_install_receipts');
  const migration = sql.indexOf('CREATE SEQUENCE billing_validation_control.fixture_lease_fence_seq');
  const migrationReceipt = sql.indexOf('INSERT INTO billing_validation_control.schema_migrations');

  assert.ok(sql.startsWith('BEGIN;\n'));
  assert.ok(preflight > 0 && preflight < ownerRole);
  assert.ok(ownerRole < runtimeRole && runtimeRole < schema);
  assert.ok(schema < baseline && baseline < receipt && receipt < migration && migration < migrationReceipt);
  assert.match(sql, /current_database\(\)\s+IS DISTINCT FROM\s+'postgres'/u);
  assert.match(sql, /current_user\s+IS DISTINCT FROM\s+'postgres'/u);
  assert.match(sql, /server_version_num/u);
  assert.match(sql, /billing_control_bootstrap_schema_already_exists/u);
  assert.match(sql, /billing_control_bootstrap_role_already_exists/u);
  assert.match(sql, /control_store_install_receipts/u);
  assert.match(sql, /project_ref[\s\S]*baseline_sha256/u);
  assert.match(sql, /COMMIT;\s*$/u);
});

test('renderer is deterministic and refuses altered or open-ended plans', async () => {
  const { loadControlStoreBootstrapPlan, renderControlStoreBootstrap } = await loadApi();
  const plan = await loadControlStoreBootstrapPlan();

  assert.equal(renderControlStoreBootstrap(plan), renderControlStoreBootstrap(plan));
  assert.throws(() => renderControlStoreBootstrap({
    ...plan,
    baselineSql: `${plan.baselineSql}\nSELECT 'unreviewed SQL';\n`,
  }), { code: REFUSAL_CODE, message: 'Control store bootstrap input is invalid.' });
  assert.throws(() => renderControlStoreBootstrap({
    ...plan,
    unreviewed: true,
  }), { code: REFUSAL_CODE, message: 'Control store bootstrap input is invalid.' });
  assert.throws(() => renderControlStoreBootstrap({
    ...plan,
    migrations: [...plan.migrations, { version: '999999999999', sql: 'SELECT 1;' }],
  }), { code: REFUSAL_CODE, message: 'Control store bootstrap input is invalid.' });
});

test('loader refuses changed baseline bytes before rendering SQL', async () => {
  const { loadControlStoreBootstrapPlan } = await loadApi();
  const fixture = await createSourceFixture();
  try {
    const original = await readFile(fixture.baselinePath, 'utf8');
    await writeFile(fixture.baselinePath, `${original}\n-- changed after review\n`);
    await assertBootstrapRefusal(() => loadControlStoreBootstrapPlan({
      baselinePath: fixture.baselinePath,
      migrationDirectory: fixture.migrationDirectory,
    }));
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('loader refuses changed migration bytes and unknown migration SQL', async () => {
  const { loadControlStoreBootstrapPlan } = await loadApi();
  const fixture = await createSourceFixture();
  try {
    const original = await readFile(fixture.migrationPath, 'utf8');
    await writeFile(fixture.migrationPath, `${original}\n-- changed after review\n`);
    await assertBootstrapRefusal(() => loadControlStoreBootstrapPlan({
      baselinePath: fixture.baselinePath,
      migrationDirectory: fixture.migrationDirectory,
    }));

    await writeFile(fixture.migrationPath, original);
    await writeFile(join(fixture.migrationDirectory, '202610010002-unreviewed.sql'), 'SELECT 1;\n');
    await assertBootstrapRefusal(() => loadControlStoreBootstrapPlan({
      baselinePath: fixture.baselinePath,
      migrationDirectory: fixture.migrationDirectory,
    }));
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('loader refuses a policy that redirects control bootstrap to another project', async () => {
  const { loadControlStoreBootstrapPlan } = await loadApi();
  const { CONTROL_STORE_POLICY } = await import('../../src/attempts/control-store-policy.mjs');
  const alteredPolicy = structuredClone(CONTROL_STORE_POLICY);
  alteredPolicy.projectRef = 'zjvqjdntasprusoqfsgw';

  await assertBootstrapRefusal(() => loadControlStoreBootstrapPlan({ policy: alteredPolicy }));
});

test('renderer contains no credentials, repeatable baseline DDL, destructive top-level SQL, or apply API', async () => {
  const api = await loadApi();
  const plan = await api.loadControlStoreBootstrapPlan();
  const sql = api.renderControlStoreBootstrap(plan);

  assert.equal('applyControlStoreBootstrap' in api, false);
  assert.doesNotMatch(sql, /(?:postgresql:\/\/|BILLING_CONTROL_DATABASE_URL|PASSWORD\s+|CREATE\s+ROLE[\s\S]{0,100}\bLOGIN\s*;)/iu);
  assert.doesNotMatch(plan.baselineSql, /\b(?:IF\s+NOT\s+EXISTS|OR\s+REPLACE|DROP\s+TRIGGER|DROP\s+SCHEMA)\b/iu);
  assert.doesNotMatch(plan.baselineSql, /^\s*TRUNCATE\b/imu);
  assert.doesNotMatch(sql, /^\s*(?:DROP|DELETE|TRUNCATE)\b/imu);
  assert.doesNotMatch(sql, /^\s*CREATE\s+(?:TABLE|INDEX|ROLE|SCHEMA)\s+IF\s+NOT\s+EXISTS\b/imu);
  assert.doesNotMatch(sql, /\b(?:retry|retries|retrying)\b/iu);
});

test('import and render do not read credentials, spawn child processes, or access the network', () => {
  const script = String.raw`
    import { createRequire, syncBuiltinESMExports } from 'node:module';
    const require = createRequire(import.meta.url);
    const childProcess = require('node:child_process');
    const http = require('node:http');
    const https = require('node:https');
    const net = require('node:net');
    const tls = require('node:tls');
    const violations = [];
    for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
      childProcess[name] = () => { violations.push('spawn:' + name); throw new Error('blocked'); };
    }
    syncBuiltinESMExports();
    globalThis.fetch = () => { violations.push('fetch'); throw new Error('blocked'); };
    net.connect = () => { violations.push('net.connect'); throw new Error('blocked'); };
    tls.connect = () => { violations.push('tls.connect'); throw new Error('blocked'); };
    http.request = () => { violations.push('http.request'); throw new Error('blocked'); };
    https.request = () => { violations.push('https.request'); throw new Error('blocked'); };
    const originalEnv = process.env;
    process.env = new Proxy(originalEnv, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /(?:DATABASE_URL|SERVICE_ROLE|STRIPE_SECRET)/iu.test(key)) {
          violations.push('env:' + key);
        }
        return Reflect.get(target, key, receiver);
      },
    });
    try {
      const api = await import(process.argv[1]);
      const plan = await api.loadControlStoreBootstrapPlan();
      api.renderControlStoreBootstrap(plan);
      if (violations.length) throw new Error('unexpected side effects: ' + violations.join(','));
    } finally {
      process.env = originalEnv;
    }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, MODULE_URL.href], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
});
