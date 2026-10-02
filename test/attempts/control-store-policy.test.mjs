import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { isValidStandaloneProjectRef } from '../../src/billing/contracts.mjs';
import {
  CONTROL_STORE_POLICY,
  ControlStoreRefusal,
  loadControlStorePolicy,
  parseControlStoreRuntimeDatabaseUrl,
  parseControlStoreVerifierDatabaseUrl,
} from '../../src/attempts/control-store-policy.mjs';

const FINANCIAL_POLICY_PATH = new URL('../../policy/environment-policy.json', import.meta.url);
const CONTROL_HOST = 'db.ceindkuafycqdcplfrgs.supabase.co';
const RUNTIME_ROLE = 'billing_validation_runtime';
const VERIFIER_ROLE = 'billing_validation_verifier';
const SENTINEL_PASSWORD = 'sentinel-control-password-never-return-this';

function validUrl({
  host = CONTROL_HOST,
  port = 5432,
  database = 'postgres',
  username = VERIFIER_ROLE,
  password = SENTINEL_PASSWORD,
  query = 'sslmode=require',
} = {}) {
  const queryPart = query === null ? '' : `?${query}`;
  return `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}/${database}${queryPart}`;
}

function assertRefusal(value, expectedCode = 'control_store_target_invalid', policy = CONTROL_STORE_POLICY,
  parser = parseControlStoreVerifierDatabaseUrl) {
  let error;
  assert.throws(() => parser(value, policy), (actual) => {
    error = actual;
    return actual instanceof ControlStoreRefusal;
  });
  assert.equal(error.code, expectedCode);
  assert.equal(error.message.includes(SENTINEL_PASSWORD), false);
  assert.equal(JSON.stringify(error).includes(SENTINEL_PASSWORD), false);
  return error;
}

test('control store cannot substitute for the blocked, unconfigured financial target', async () => {
  const control = await loadControlStorePolicy();
  const financial = JSON.parse(await readFile(FINANCIAL_POLICY_PATH, 'utf8'));

  assert.equal(control.projectRef, 'ceindkuafycqdcplfrgs');
  assert.equal(control.urlEnvironment, 'BILLING_CONTROL_VERIFIER_DATABASE_URL');
  assert.equal(financial.database.kind, 'standalone');
  assert.equal(financial.database.projectRef, null);
  assert.equal(financial.database.connection, null);
  assert.equal(isValidStandaloneProjectRef('zjvqjdntasprusoqfsgw'), false);
  assert.notEqual(control.urlEnvironment, 'SUPABASE_VALIDATION_DATABASE_URL');
  assert.notEqual(control.urlEnvironment, 'BILLING_CONTROL_DATABASE_URL');
});

test('loaded control policy is closed, matches the reviewed direct endpoint, and is recursively frozen', async () => {
  const policy = await loadControlStorePolicy();

  assert.deepEqual(Object.keys(policy).sort(), [
    'connection',
    'databaseVersion',
    'projectRef',
    'region',
    'roles',
    'schema',
    'schemaVersion',
    'urlEnvironment',
  ]);
  assert.equal(policy.schemaVersion, 1);
  assert.equal(policy.projectRef, 'ceindkuafycqdcplfrgs');
  assert.equal(policy.region, 'sa-east-1');
  assert.equal(policy.databaseVersion, '17.11.0.002');
  assert.equal(policy.schema, 'billing_validation_control');
  assert.deepEqual(policy.roles, {
    owner: 'billing_validation_owner',
    runtime: RUNTIME_ROLE,
    verifier: VERIFIER_ROLE,
  });
  assert.deepEqual(policy.connection, {
    protocol: 'postgresql',
    host: CONTROL_HOST,
    port: 5432,
    database: 'postgres',
    sslMode: 'require',
  });
  assert.equal(policy.urlEnvironment, 'BILLING_CONTROL_VERIFIER_DATABASE_URL');
  assert.equal(Object.isFrozen(policy), true);
  assert.equal(Object.isFrozen(policy.roles), true);
  assert.equal(Object.isFrozen(policy.connection), true);
});

test('verifier URL validation returns only the non-secret target descriptor', async () => {
  const policy = await loadControlStorePolicy();
  const descriptor = parseControlStoreVerifierDatabaseUrl(validUrl(), policy);

  assert.deepEqual(descriptor, {
    projectRef: 'ceindkuafycqdcplfrgs',
    host: CONTROL_HOST,
    port: 5432,
    database: 'postgres',
    username: VERIFIER_ROLE,
    sslMode: 'require',
  });
  assert.deepEqual(Object.keys(descriptor).sort(), [
    'database', 'host', 'port', 'projectRef', 'sslMode', 'username',
  ]);
  assert.equal(Object.isFrozen(descriptor), true);
  assert.equal(JSON.stringify(descriptor).includes(SENTINEL_PASSWORD), false);
  assert.equal(JSON.stringify(descriptor).includes('postgresql://'), false);
  assert.equal(JSON.stringify(descriptor).includes('sslmode=require'), false);
});

test('verifier URL validation refuses the forbidden historical financial target', () => {
  const error = assertRefusal(validUrl({ host: 'db.zjvqjdntasprusoqfsgw.supabase.co' }));
  assert.equal(error.code, 'control_store_target_invalid');
});

test('verifier URL validation refuses an unreviewed hostname', () => {
  assertRefusal(validUrl({ host: 'db.ceindkuafycqdcplfrgs.supabase.co.attacker.example' }));
});

test('verifier and runtime URL validators accept only their own distinct role', () => {
  const verifierUrl = validUrl();
  const runtimeUrl = validUrl({ username: RUNTIME_ROLE });

  assert.equal(parseControlStoreVerifierDatabaseUrl(verifierUrl).username, VERIFIER_ROLE);
  assert.equal(parseControlStoreRuntimeDatabaseUrl(runtimeUrl).username, RUNTIME_ROLE);
  assertRefusal(runtimeUrl);
  assertRefusal(verifierUrl, 'control_store_target_invalid', CONTROL_STORE_POLICY,
    parseControlStoreRuntimeDatabaseUrl);
  assertRefusal(validUrl({ username: 'postgres' }));
  assertRefusal(validUrl({ username: 'postgres' }), 'control_store_target_invalid', CONTROL_STORE_POLICY,
    parseControlStoreRuntimeDatabaseUrl);
});

test('role-specific control URL validation refuses a database other than postgres', () => {
  assertRefusal(validUrl({ database: 'billing_validation_control' }));
  assertRefusal(validUrl({ username: RUNTIME_ROLE, database: 'billing_validation_control' }),
    'control_store_target_invalid', CONTROL_STORE_POLICY, parseControlStoreRuntimeDatabaseUrl);
});

test('control URL validation refuses a nonstandard port', () => {
  assertRefusal(validUrl({ port: 6543 }));
});

test('control URL validation requires the exact TLS query and refuses missing or downgraded TLS', () => {
  assertRefusal(validUrl({ query: null }));
  assertRefusal(validUrl({ query: 'sslmode=disable' }));
});

test('control URL validation refuses duplicate, extra, and hostile URL parameters', () => {
  for (const query of [
    'sslmode=require&sslmode=require',
    'sslmode=require&%73slmode=require',
    'sslmode=require&options=-c%20search_path%3Dpublic',
    'sslmode=require&host=db.zjvqjdntasprusoqfsgw.supabase.co',
    'sslmode=require&sslrootcert=/tmp/attacker.pem',
  ]) {
    assertRefusal(validUrl({ query }));
  }
});

test('control URL validation refuses malformed encodings and malformed URL syntax', () => {
  assertRefusal(
    `postgresql://${RUNTIME_ROLE}:%E0%A4%A@${CONTROL_HOST}:5432/postgres?sslmode=require`,
  );
  assertRefusal(validUrl({ query: 'sslmode=%ZZ' }));
  assertRefusal(`postgresql://${RUNTIME_ROLE}:${SENTINEL_PASSWORD}@${CONTROL_HOST}:notaport/postgres?sslmode=require`);
  assertRefusal('not a database URL');
});

test('control URL validation refuses empty credentials', () => {
  assertRefusal(validUrl({ password: '' }));
  assertRefusal(`postgresql://:${SENTINEL_PASSWORD}@${CONTROL_HOST}:5432/postgres?sslmode=require`);
});

test('invalid URL refusals do not expose sentinel credentials in any observable error field', () => {
  const error = assertRefusal(validUrl({ host: 'wrong.example' }));
  assert.equal(error.name, 'ControlStoreRefusal');
  assert.equal(error.message, 'Control store database target is invalid.');
  assert.equal(error.code, 'control_store_target_invalid');
  assert.doesNotMatch(`${error.name} ${error.message} ${error.code} ${JSON.stringify(error)}`, /sentinel-control-password-never-return-this/u);
});

test('policy loading rejects unknown keys and any change to the approved project identity', async () => {
  const approved = await loadControlStorePolicy();
  const mutations = [
    (policy) => { policy.unreviewed = true; },
    (policy) => { policy.projectRef = 'zjvqjdntasprusoqfsgw'; },
    (policy) => { policy.connection.host = 'db.zjvqjdntasprusoqfsgw.supabase.co'; },
    (policy) => { policy.connection.sslMode = 'disable'; },
    (policy) => { policy.roles.runtime = 'postgres'; },
    (policy) => { policy.roles.verifier = 'postgres'; },
  ];

  for (const mutate of mutations) {
    const candidate = structuredClone(approved);
    mutate(candidate);
    const directory = await mkdtemp(join(tmpdir(), 'billing-control-policy-'));
    const policyPath = join(directory, 'policy.json');

    try {
      await writeFile(policyPath, JSON.stringify(candidate));
      await assert.rejects(
        loadControlStorePolicy({ policyPath }),
        (error) => error instanceof ControlStoreRefusal
          && error.code === 'control_store_policy_invalid'
          && !error.message.includes(SENTINEL_PASSWORD),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('URL parsing refuses a policy object that differs from the pinned control identity', async () => {
  const policy = structuredClone(await loadControlStorePolicy());
  policy.projectRef = 'zjvqjdntasprusoqfsgw';

  const error = assertRefusal(
    validUrl(),
    'control_store_policy_invalid',
    policy,
  );
  assert.equal(error.message, 'Control store policy is invalid.');
});
