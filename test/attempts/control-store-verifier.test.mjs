import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  testBaselineDigest,
  testControlPolicy,
  testControlTarget,
  testControlVerifierRow,
} from './control-store-fixtures.mjs';
import { CONTROL_STORE_POLICY } from '../../src/attempts/control-store-policy.mjs';

const MIGRATION_URL = new URL('../../src/attempts/control-store-migrations/202610030001-control-store-verifier.sql', import.meta.url);
const VERIFIER_ROLE_MIGRATION_URL = new URL('../../src/attempts/control-store-migrations/202610040001-control-verifier-role.sql', import.meta.url);
const REFUSAL_CODE = 'control_store_identity_invalid';
const REFUSAL_MESSAGE = 'Control store identity verification failed.';
const verifierModule = await import('../../src/attempts/control-store-verifier.mjs').catch(() => null);

function fakeQueryClient({ row, error, rows } = {}) {
  const calls = [];
  return {
    calls,
    async query(config) {
      calls.push(config);
      if (error) throw error;
      return { rows: rows ?? [row ?? testControlVerifierRow()] };
    },
  };
}

async function getVerifierOrSkip(t) {
  if (typeof verifierModule?.verifyAttemptControlStore !== 'function') {
    t.skip('read-only control-store verifier is not implemented yet');
    return null;
  }
  return verifierModule.verifyAttemptControlStore;
}

async function assertFixedRefusal(operation, secret = 'synthetic-control-password') {
  await assert.rejects(operation, (error) => {
    assert.equal(error.code, REFUSAL_CODE);
    assert.equal(error.message, REFUSAL_MESSAGE);
    assert.equal(error.message.includes(secret), false);
    assert.equal(JSON.stringify(error).includes(secret), false);
    assert.equal(error.stack.includes(secret), false);
    return true;
  });
}

test('read-only control-store verifier module exports its verification boundary', () => {
  assert.equal(typeof verifierModule?.verifyAttemptControlStore, 'function');
});

test('immutable 0003 migration remains the original bounded verifier-function install', async () => {
  const exists = await access(MIGRATION_URL).then(() => true, () => false);
  assert.equal(exists, true, 'the forward verifier migration must be present');
  if (!exists) return;

  const sql = await readFile(MIGRATION_URL, 'utf8');
  assert.match(sql, /CREATE FUNCTION billing_validation_control\.verify_attempt_control_store\(\)/u);
  assert.match(sql, /RETURNS TABLE/u);
  assert.match(sql, /LANGUAGE sql\s+STABLE\s+SECURITY DEFINER/u);
  assert.match(sql, /SET search_path\s*=\s*pg_catalog/u);
  assert.match(sql, /ALTER FUNCTION billing_validation_control\.verify_attempt_control_store\(\) OWNER TO billing_validation_owner/u);
  assert.match(sql, /REVOKE ALL ON FUNCTION billing_validation_control\.verify_attempt_control_store\(\) FROM PUBLIC/u);
  assert.deepEqual([...sql.matchAll(/^GRANT EXECUTE ON FUNCTION billing_validation_control\.verify_attempt_control_store\(\) TO ([a-z0-9_]+);$/gmu)]
    .map(([, role]) => role), ['billing_validation_runtime']);
  assert.doesNotMatch(sql, /^\s*(?:INSERT|UPDATE|DELETE|MERGE|DROP|TRUNCATE|SET\s+(?:ROLE|SESSION\s+AUTHORIZATION))\b/imu);
  assert.doesNotMatch(sql, /^\s*EXECUTE\s+(?!ON\s+FUNCTION\b)/imu);
  assert.doesNotMatch(sql, /\b(?:postgresql:\/\/|password|BILLING_CONTROL_VERIFIER_DATABASE_URL)\b/iu);
  for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) {
    assert.match(sql, new RegExp(`has_table_privilege\\([\\s\\S]*?'${privilege}'\\)`, 'u'));
  }
  for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
    assert.match(sql, new RegExp(`has_column_privilege\\([\\s\\S]*?'${privilege}'\\)`, 'u'));
  }
});

test('forward role migration transfers EXECUTE solely to verifier and checks both role boundaries', async () => {
  const sql = await readFile(VERIFIER_ROLE_MIGRATION_URL, 'utf8');
  assert.match(sql, /CREATE OR REPLACE FUNCTION billing_validation_control\.verify_attempt_control_store\(\)/u);
  assert.match(sql, /LANGUAGE sql\s+STABLE\s+SECURITY DEFINER/u);
  assert.match(sql, /SET search_path\s*=\s*pg_catalog/u);
  assert.match(sql, /ALTER FUNCTION billing_validation_control\.verify_attempt_control_store\(\) OWNER TO billing_validation_owner/u);
  assert.match(sql, /REVOKE EXECUTE ON FUNCTION billing_validation_control\.verify_attempt_control_store\(\)\s+FROM[^;]*billing_validation_runtime/u);
  assert.deepEqual([...sql.matchAll(/^GRANT EXECUTE ON FUNCTION billing_validation_control\.verify_attempt_control_store\(\) TO ([a-z0-9_]+);$/gmu)]
    .map(([, role]) => role), ['billing_validation_verifier']);
  assert.match(sql, /GRANT USAGE ON SCHEMA billing_validation_control TO billing_validation_verifier/u);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA billing_validation_control FROM billing_validation_verifier/u);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA billing_validation_control FROM billing_validation_verifier/u);
  assert.match(sql, /verifier_has_role_membership/u);
  assert.match(sql, /verifier_owns_objects/u);
  assert.match(sql, /verifier_table_privileges/u);
  assert.match(sql, /verifier_sequence_privileges/u);
  assert.match(sql, /verifier_unapproved_function_execute/u);
  assert.match(sql, /runtime_can_execute_verifier/u);
  assert.match(sql, /verifier_can_execute_verifier/u);
});

test('valid verifier receipt returns only frozen safe control identity and digest fields', async (t) => {
  const verify = await getVerifierOrSkip(t);
  if (!verify) return;
  const policy = testControlPolicy();
  const queryClient = fakeQueryClient({ row: testControlVerifierRow(policy) });

  const receipt = await verify({ queryClient, policy, target: testControlTarget(policy) });

  assert.deepEqual(Object.keys(receipt).sort(), [
    'baselineSha256', 'database', 'migrationSha256', 'privilegeFingerprintSha256',
    'projectRef', 'role', 'serverVersion',
  ]);
  assert.deepEqual(receipt, {
    projectRef: policy.projectRef,
    database: policy.connection.database,
    role: policy.roles.verifier,
    serverVersion: '170011',
    baselineSha256: testBaselineDigest(),
    migrationSha256: testControlVerifierRow(policy).migration_sha256,
    privilegeFingerprintSha256: testControlVerifierRow(policy).privilege_fingerprint_sha256,
  });
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(queryClient.calls.length, 1);
  assert.match(queryClient.calls[0].text, /verify_attempt_control_store\(\)/u);
  assert.equal(queryClient.calls[0].query_timeout, 5000);
  assert.equal(JSON.stringify(receipt).includes('postgresql://'), false);
});

test('wrong connection descriptor is refused before querying and exposes no URL', async (t) => {
  const verify = await getVerifierOrSkip(t);
  if (!verify) return;
  const policy = testControlPolicy();
  const queryClient = fakeQueryClient();
  const wrongTargets = [
    { ...testControlTarget(policy), host: 'db.otherproject.invalid' },
    { ...testControlTarget(policy), projectRef: 'zyxwvutsrqponmlkjihg' },
    { ...testControlTarget(policy), database: 'other_database' },
    { ...testControlTarget(policy), username: 'postgres' },
    { ...testControlTarget(policy), username: policy.roles.runtime },
  ];

  for (const target of wrongTargets) {
    await assertFixedRefusal(() => verify({ queryClient, policy, target }));
  }
  assert.equal(queryClient.calls.length, 0);
});

test('wrong database, current/session identity, role flags, or ownership are refused', async (t) => {
  const verify = await getVerifierOrSkip(t);
  if (!verify) return;
  const policy = testControlPolicy();
  const invalidRows = [
    { database_name: 'other_database' },
    { session_role: 'service_role' },
    { session_role: policy.roles.runtime },
    { verifier_role: 'postgres' },
    { role_setting: 'billing_validation_runtime' },
    { owner_login: true },
    { runtime_login: true },
    { runtime_superuser: true },
    { runtime_create_role: true },
    { runtime_create_database: true },
    { runtime_replication: true },
    { runtime_bypass_rls: true },
    { runtime_member_of_owner: true },
    { runtime_has_role_membership: true },
    { runtime_owns_objects: true },
    { owner_owns_objects: false },
    { schema_owner: 'postgres' },
  ];

  for (const override of invalidRows) {
    const queryClient = fakeQueryClient({ row: testControlVerifierRow(policy, override) });
    await assertFixedRefusal(() => verify({ queryClient, policy, target: testControlTarget(policy) }));
    assert.equal(queryClient.calls.length, 1);
  }
});

test('baseline, migration history, unknown forward versions, and extra grants fail closed', async (t) => {
  const verify = await getVerifierOrSkip(t);
  if (!verify) return;
  const policy = testControlPolicy();
  const invalidRows = [
    { baseline_sha256: 'f'.repeat(64) },
    { migration_sha256: 'e'.repeat(64) },
    { migration_count: testControlVerifierRow(policy).migration_count + 1 },
    { privilege_fingerprint_sha256: 'd'.repeat(64) },
  ];

  for (const override of invalidRows) {
    const queryClient = fakeQueryClient({ row: testControlVerifierRow(policy, override) });
    await assertFixedRefusal(() => verify({ queryClient, policy, target: testControlTarget(policy) }));
    assert.equal(queryClient.calls.length, 1);
  }
});

test('missing, extra, or ambiguous verifier rows and SQL timeout/error use fixed refusals', async (t) => {
  const verify = await getVerifierOrSkip(t);
  if (!verify) return;
  const policy = testControlPolicy();
  const target = testControlTarget(policy);
  for (const rows of [[], [testControlVerifierRow(policy), testControlVerifierRow(policy)]]) {
    await assertFixedRefusal(() => verify({ queryClient: fakeQueryClient({ rows }), policy, target }));
  }
  await assertFixedRefusal(() => verify({ queryClient: fakeQueryClient({ row: {
    ...testControlVerifierRow(policy), unexpected: 'ambiguous',
  } }), policy, target }));
  const secretUrl = 'postgresql://billing_validation_verifier:synthetic-control-password@db.example.invalid/postgres';
  await assertFixedRefusal(() => verify({ queryClient: fakeQueryClient({
    error: Object.assign(new Error(`timeout at ${secretUrl}`), { code: 'ETIMEDOUT' }),
  }), policy, target }));
});
