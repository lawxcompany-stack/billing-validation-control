import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { CONTROL_STORE_POLICY } from '../../src/attempts/control-store-policy.mjs';
import { testBaselineDigest } from './control-store-fixtures.mjs';

const BASELINE_URL = new URL('../../src/attempts/schema.sql', import.meta.url);
const CONTROL_MIGRATION_DIRECTORY_URL = new URL('../../src/attempts/control-store-migrations/', import.meta.url);
const MIGRATIONS = [
  { version: '202610010001', name: 'standalone-lease-fencing',
    file: '202610010001-standalone-lease-fencing.sql' },
  { version: '202610020001', name: 'control-runtime-privileges',
    file: '202610020001-control-runtime-privileges.sql' },
  { version: '202610030001', name: 'control-store-verifier',
    file: '202610030001-control-store-verifier.sql' },
  { version: '202610040001', name: 'control-verifier-role',
    file: '202610040001-control-verifier-role.sql' },
];
const MIGRATION_URLS = MIGRATIONS.map(({ file }) =>
  new URL(`../../src/attempts/control-store-migrations/${file}`, import.meta.url));
const FINANCIAL_BASELINE_MIGRATION_URL = new URL(
  '../../src/attempts/migrations/202610010001-standalone-lease-fencing.sql', import.meta.url);
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
  const migrationDirectory = join(directory, 'control-store-migrations');
  await mkdir(migrationDirectory);
  const baselinePath = join(directory, 'schema.sql');
  await copyFile(BASELINE_URL, baselinePath);
  const migrationPaths = [];
  for (const migrationUrl of MIGRATION_URLS) {
    const migrationPath = join(migrationDirectory, migrationUrl.pathname.split('/').at(-1));
    await copyFile(migrationUrl, migrationPath);
    migrationPaths.push(migrationPath);
  }
  return { directory, baselinePath, migrationDirectory, migrationPaths };
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
  assert.match(sql, /CREATE ROLE billing_validation_verifier NOLOGIN;/u);
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
  assert.deepEqual(plan.migrations.map(({ version, name, file }) => ({ version, name, file })), MIGRATIONS);
  assert.deepEqual(plan.migrations.map(({ sha256: digest }) => digest), await Promise.all(
    MIGRATION_URLS.map(async (url) => sha256(await readFile(url))
  )));
  assert.equal(plan.runtimeLogin, false);
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.migrations), true);
  assert.equal(Object.isFrozen(plan.migrations[0]), true);
});

test('control-store 0001 is byte-identical to the pinned financial migration', async () => {
  const controlBytes = await readFile(MIGRATION_URLS[0]);
  const financialBytes = await readFile(FINANCIAL_BASELINE_MIGRATION_URL);

  assert.deepEqual(controlBytes, financialBytes);
  assert.equal(sha256(controlBytes), 'd733038f706135c2514084fc229c9ac7507796cccd4eca4974ca1dc981fd12fb');
});

test('control-store 0002 remains at its reviewed exact digest', async () => {
  const bytes = await readFile(MIGRATION_URLS[1]);

  assert.equal(sha256(bytes), '69fe93ee2a67e8a52588bdb8b235ab88207441f5c85608bc51e791d574347c08');
});

test('control-store 0003 pins executable verifier SQL while 0004 adds the verifier role boundary', async () => {
  const oldVerifierBytes = await readFile(MIGRATION_URLS[2]);
  const verifierRoleMigrationBytes = await readFile(MIGRATION_URLS[3]);
  const verifierRoleMigration = verifierRoleMigrationBytes.toString('utf8');

  assert.equal(sha256(oldVerifierBytes), '56ca6c77487900bbd9affc934665e08f5bc5246e42c1adb9a077d828c8034698');
  assert.equal(sha256(verifierRoleMigrationBytes), 'b7320a78a302f3164d013232003fdc30279f31748a6f74de29b4440d7d555bcc');
  assert.match(verifierRoleMigration,
    /REVOKE EXECUTE ON FUNCTION billing_validation_control\.verify_attempt_control_store\(\)\s+FROM\b[^;]*\bbilling_validation_runtime\b[^;]*;/u);
  assert.match(verifierRoleMigration, /GRANT EXECUTE ON FUNCTION billing_validation_control\.verify_attempt_control_store\(\) TO billing_validation_verifier;/u);
});

test('control bootstrap migration directory contains only its ordered pinned chain', async () => {
  const entries = await readdir(CONTROL_MIGRATION_DIRECTORY_URL, { withFileTypes: true });

  assert.ok(entries.every((entry) => entry.isFile()));
  assert.deepEqual(entries.map(({ name }) => name).sort(), MIGRATIONS.map(({ file }) => file).sort());
});

test('financial migration loader remains isolated and rejects unknown files in its own directory', async () => {
  const { loadAttemptMigrationPlan } = await import('../../src/attempts/migrations.mjs');
  const plan = await loadAttemptMigrationPlan();

  assert.deepEqual(plan.map(({ file }) => file), ['202610010001-standalone-lease-fencing.sql']);

  const directory = await mkdtemp(join(tmpdir(), 'billing-financial-migrations-'));
  try {
    await copyFile(new URL('../../src/attempts/migrations/202610010001-standalone-lease-fencing.sql', import.meta.url),
      join(directory, '202610010001-standalone-lease-fencing.sql'));
    await writeFile(join(directory, '202610020001-control-runtime-privileges.sql'), 'SELECT 1;\n');
    await assert.rejects(loadAttemptMigrationPlan({ directory: pathToFileURL(`${directory}/`) }), {
      code: 'migration_allowlist_mismatch',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('renderer emits one guarded transaction in baseline then forward-migration order', async () => {
  const { loadControlStoreBootstrapPlan, renderControlStoreBootstrap } = await loadApi();
  const plan = await loadControlStoreBootstrapPlan();
  const sql = renderControlStoreBootstrap(plan);

  const preflight = sql.indexOf('DO $control_store_preflight$');
  const ownerRole = sql.indexOf('CREATE ROLE billing_validation_owner NOLOGIN;');
  const runtimeRole = sql.indexOf('CREATE ROLE billing_validation_runtime NOLOGIN;');
  const verifierRole = sql.indexOf('CREATE ROLE billing_validation_verifier NOLOGIN;');
  const schema = sql.indexOf('CREATE SCHEMA billing_validation_control AUTHORIZATION billing_validation_owner;');
  const baseline = sql.indexOf(plan.baselineSql.trim());
  const receipt = sql.indexOf('INSERT INTO billing_validation_control.control_store_install_receipts');
  const migration = sql.indexOf('CREATE SEQUENCE billing_validation_control.fixture_lease_fence_seq');
  const migration2 = sql.indexOf('CREATE TABLE billing_validation_control.fixture_reservation_claim_events');
  const migration3 = sql.indexOf('CREATE FUNCTION billing_validation_control.verify_attempt_control_store');
  const migration4 = sql.indexOf('CREATE OR REPLACE FUNCTION billing_validation_control.verify_attempt_control_store');
  const migrationReceipts = [...sql.matchAll(/INSERT INTO billing_validation_control\.schema_migrations/gmu)]
    .map(({ index }) => index);

  assert.ok(sql.startsWith('BEGIN;\n'));
  assert.ok(preflight > 0 && preflight < ownerRole);
  assert.ok(ownerRole < runtimeRole && runtimeRole < verifierRole && verifierRole < schema);
  assert.ok(schema < baseline && baseline < receipt && receipt < migration && migration < migration2 && migration2 < migration3 && migration3 < migration4);
  assert.equal(migrationReceipts.length, 4);
  assert.ok(migrationReceipts[0] < migration2 && migration2 < migrationReceipts[1] &&
    migrationReceipts[1] < migration3 && migration3 < migrationReceipts[2] &&
    migrationReceipts[2] < migration4 && migration4 < migrationReceipts[3]);
  assert.match(sql, /VALUES \('202610010001', 'standalone-lease-fencing'/u);
  assert.match(sql, /VALUES \('202610020001', 'control-runtime-privileges'/u);
  assert.match(sql, /VALUES \('202610030001', 'control-store-verifier'/u);
  assert.match(sql, /VALUES \('202610040001', 'control-verifier-role'/u);
  assert.match(sql, /current_database\(\)\s+IS DISTINCT FROM\s+'postgres'/u);
  assert.match(sql, /current_user\s+IS DISTINCT FROM\s+'postgres'/u);
  assert.match(sql, /server_version_num/u);
  assert.match(sql, /billing_control_bootstrap_schema_already_exists/u);
  assert.match(sql, /billing_control_bootstrap_role_already_exists/u);
  assert.match(sql, /control_store_install_receipts/u);
  assert.match(sql, /project_ref[\s\S]*baseline_sha256/u);
  assert.match(sql, /COMMIT;\s*$/u);
});

test('renderer temporarily grants SET ROLE to a CREATEROLE operator then revokes it before commit', async () => {
  const { loadControlStoreBootstrapPlan, renderControlStoreBootstrap } = await loadApi();
  const sql = renderControlStoreBootstrap(await loadControlStoreBootstrapPlan());
  const createdOwner = sql.indexOf('CREATE ROLE billing_validation_owner NOLOGIN;');
  const ownerGrant = sql.indexOf('GRANT billing_validation_owner TO postgres WITH INHERIT FALSE, SET TRUE;');
  const setOwner = sql.indexOf('SET LOCAL ROLE billing_validation_owner;');
  const resetRole = sql.indexOf('RESET ROLE;');
  const revokeOwner = sql.indexOf('REVOKE billing_validation_owner FROM postgres;');
  const commit = sql.lastIndexOf('COMMIT;');

  assert.ok(createdOwner >= 0 && createdOwner < ownerGrant,
    'the owner role must exist before the bootstrap operator receives SET membership');
  assert.ok(ownerGrant < setOwner && setOwner < resetRole && resetRole < revokeOwner && revokeOwner < commit,
    'the operator membership must be temporary and removed before the transaction commits');
});

test('operator migration renderer emits only the pending control-store suffix', async () => {
  const { loadControlStoreBootstrapPlan, renderControlStoreMigrationBundle } = await loadApi();
  assert.equal(typeof renderControlStoreMigrationBundle, 'function');
  const plan = await loadControlStoreBootstrapPlan();
  const bundle = renderControlStoreMigrationBundle({
    policy: CONTROL_STORE_POLICY,
    baselineSha256: testBaselineDigest(),
    migrations: plan.migrations,
    applied: plan.migrations.slice(0, 3).map(({ version, name, sha256: digest }) => ({
      version, name, sha256: digest,
    })),
  });

  assert.match(bundle, /202610040001/u);
  assert.match(bundle, /REVOKE EXECUTE ON FUNCTION billing_validation_control\.verify_attempt_control_store/u);
  assert.match(bundle, /GRANT EXECUTE ON FUNCTION billing_validation_control\.verify_attempt_control_store\(\) TO billing_validation_verifier/u);
  assert.equal([...bundle.matchAll(/INSERT INTO billing_validation_control\.schema_migrations/gmu)].length, 1);
  assert.match(bundle, /VALUES \('202610040001', 'control-verifier-role'/u);
  assert.doesNotMatch(bundle, /VALUES \('202610010001'|VALUES \('202610020001'|VALUES \('202610030001'/u);
  assert.doesNotMatch(bundle, /^\s*(?:DROP|DELETE|TRUNCATE)\b/imu);
});

test('operator migration renderer rejects malformed applied prefixes and altered pins', async () => {
  const { loadControlStoreBootstrapPlan, renderControlStoreMigrationBundle } = await loadApi();
  const plan = await loadControlStoreBootstrapPlan();
  const args = { policy: CONTROL_STORE_POLICY, baselineSha256: testBaselineDigest(),
    migrations: plan.migrations, applied: [] };

  assert.throws(() => renderControlStoreMigrationBundle({ ...args,
    applied: [{ version: '999999999999', name: 'unknown', sha256: 'a'.repeat(64) }],
  }), { code: REFUSAL_CODE });
  assert.throws(() => renderControlStoreMigrationBundle({ ...args,
    applied: [args.migrations[1], args.migrations[0]].map(({ version, name, sha256: digest }) => ({
      version, name, sha256: digest,
    })),
  }), { code: REFUSAL_CODE });
  assert.throws(() => renderControlStoreMigrationBundle({ ...args, baselineSha256: 'f'.repeat(64) }),
    { code: REFUSAL_CODE });
  assert.throws(() => renderControlStoreMigrationBundle({ ...args,
    migrations: args.migrations.map((migration, index) => index === 2
      ? { ...migration, sql: `${migration.sql}\n-- tampered\n` } : migration),
  }), { code: REFUSAL_CODE });
});

test('operator migration renderer refuses validly shaped but unapproved project identities', async () => {
  const { loadControlStoreBootstrapPlan, renderControlStoreMigrationBundle } = await loadApi();
  const plan = await loadControlStoreBootstrapPlan();
  const args = { policy: CONTROL_STORE_POLICY, baselineSha256: testBaselineDigest(),
    migrations: plan.migrations, applied: [] };
  const alteredPolicies = [
    (() => {
      const policy = structuredClone(CONTROL_STORE_POLICY);
      policy.projectRef = 'zyxwvutsrqponmlkjihg';
      policy.connection.host = `db.${policy.projectRef}.supabase.co`;
      return policy;
    })(),
    (() => {
      const policy = structuredClone(CONTROL_STORE_POLICY);
      policy.region = 'us-east-1';
      return policy;
    })(),
    (() => {
      const policy = structuredClone(CONTROL_STORE_POLICY);
      policy.databaseVersion = '17.10.0.001';
      return policy;
    })(),
  ];

  for (const policy of alteredPolicies) {
    assert.throws(() => renderControlStoreMigrationBundle({ ...args, policy }), { code: REFUSAL_CODE });
  }
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

test('control loader refuses changed migration bytes and unknown files in its dedicated directory', async () => {
  const { loadControlStoreBootstrapPlan } = await loadApi();
  const fixture = await createSourceFixture();
  try {
    const original = await readFile(fixture.migrationPaths[1], 'utf8');
    await writeFile(fixture.migrationPaths[1], `${original}\n-- changed after review\n`);
    await assertBootstrapRefusal(() => loadControlStoreBootstrapPlan({
      baselinePath: fixture.baselinePath,
      migrationDirectory: fixture.migrationDirectory,
    }));

    await writeFile(fixture.migrationPaths[1], original);
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
