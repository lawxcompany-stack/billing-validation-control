import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createPostgresAttemptStore, installAttemptSchema } from '../../src/attempts/postgres-store.mjs';

const database = { projectRef: 'abcdefghijklmnopqrst', parentProjectRef: 'zyxwvutsrqponmlkjihg',
  branchId: 'child-validation-1', branchName: 'billing-validation-1' };
const preflight = { expectedEnvironment: {
  database: { projectRef: database.projectRef, branchId: database.branchId },
  deployment: { id: 'dpl_candidate123', origin: 'https://candidate.vercel.app' },
  stripe: { accountId: 'acct_synthetic123' },
}, providerVerification: { supabase: { ...database, schemaFingerprintSha256: 'a'.repeat(64),
  migrationHistorySha256: 'b'.repeat(64) } } };
const target = { ...database, isDefault: false, status: 'ACTIVE_HEALTHY', isolated: true };

function recordingClient() {
  const calls = [];
  const client = { calls, async transaction(fn) {
    return fn({ async query(sql, values) {
      calls.push({ sql, values });
      if (/clock_timestamp/.test(sql) && /SELECT/.test(sql)) return { rows: [{ now: 1000 }] };
      return { rows: [] };
    } });
  } };
  return client;
}

test('wrong, default, parent, or unhealthy schema target refuses before issuing DDL', async () => {
  const variants = [
    { ...target, branchId: 'other-branch' },
    { ...target, projectRef: target.parentProjectRef },
    { ...target, branchName: 'main' },
    { ...target, isDefault: true },
    { ...target, isolated: false },
    { ...target, status: 'MIGRATIONS_FAILED' },
  ];
  for (const bad of variants) {
    const client = recordingClient();
    await assert.rejects(installAttemptSchema({ client, preflight, target: bad }), { code: 'schema_target_unverified' });
    assert.equal(client.calls.length, 0);
  }
});

test('verified installer issues only the dedicated control schema DDL', async () => {
  const client = recordingClient();
  await installAttemptSchema({ client, preflight, target });
  assert.equal(client.calls.length, 1);
  assert.match(client.calls[0].sql, /CREATE SCHEMA IF NOT EXISTS billing_validation_control/);
  assert.equal([...client.calls[0].sql.matchAll(/CREATE TABLE IF NOT EXISTS ([\w.]+)/g)]
    .every((match) => match[1].startsWith('billing_validation_control.')), true);
});

test('schema gives fixture leases the exact shared key and fences owner rows', () => {
  const sql = readFileSync(new URL('../../src/attempts/schema.sql', import.meta.url), 'utf8');
  assert.match(sql, /PRIMARY KEY \(branch_id, suite, fixture_key\)/);
  assert.match(sql, /attempt_id[^,]*REFERENCES billing_validation_control\.attempts/);
  assert.match(sql, /fence uuid NOT NULL/);
  assert.match(sql, /owner_run_id text NOT NULL/);
  assert.match(sql, /owner_run_attempt integer NOT NULL/);
  assert.match(sql, /owner_candidate_sha char\(40\) NOT NULL/);
  assert.match(sql, /REVOKE ALL ON SCHEMA billing_validation_control FROM PUBLIC/);
  assert.doesNotMatch(sql, /candidate_sha, suite, fixture_key\)/);
});

test('PostgreSQL adapter accepts an injected transactional client and parameterizes key and metadata', async () => {
  const client = recordingClient();
  const store = createPostgresAttemptStore({ client, preflight, target });
  await store.prepare({ attemptId: 'attempt-a', key: { branchId: database.branchId, suite: 'billing', fixtureKey: 'invoice-a' },
    candidateSha: 'a'.repeat(40), workflow: { repository: 'lawxcompany-stack/billing-validation-control',
      ref: 'refs/heads/main', runId: '100', runAttempt: 1, runnerLabel: 'billing-validation-' + 'a'.repeat(32) },
    environment: preflight.expectedEnvironment, ttlSeconds: 60 });
  assert.ok(client.calls.some(({ sql, values }) => /pg_advisory_xact_lock/.test(sql) && values?.[0]?.includes('invoice-a')));
  assert.ok(client.calls.some(({ sql, values }) => /INSERT INTO billing_validation_control\.fixture_leases/.test(sql) &&
    values?.includes('child-validation-1')));
  assert.equal(client.calls.some(({ sql }) => sql.includes('invoice-a') || sql.includes('attempt-a')), false);
});

test('fixture SQL executes behind an owner fence in the same transaction', async () => {
  const calls = [];
  let transactions = 0;
  const fence = '11111111-1111-4111-8111-111111111111';
  const client = { async transaction(fn) {
    transactions++;
    return fn({ async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes('FROM billing_validation_control.attempts')) return { rows: [{
        attempt_id: 'attempt-a', branch_id: database.branchId, suite: 'billing', fixture_key: 'invoice-a',
        candidate_sha: 'a'.repeat(40), workflow_repository: 'lawxcompany-stack/billing-validation-control',
        workflow_ref: 'refs/heads/main', workflow_run_id: '100', workflow_run_attempt: 1,
        runner_label: 'billing-validation-' + 'a'.repeat(32), database_project_ref: database.projectRef,
        deployment_id: 'dpl_candidate123', deployment_origin: 'https://candidate.vercel.app',
        stripe_account_id: 'acct_synthetic123', state: 'collecting', cleanup_status: 'pending',
        artifact_id: null, resource_ids: [], created_at_epoch: 1000, updated_at_epoch: 1000,
      }] };
      if (sql.includes('FROM billing_validation_control.fixture_leases')) return { rows: [{
        attempt_id: 'attempt-a', fence, expires_at_epoch: 1060,
      }] };
      if (sql.includes('clock_timestamp')) return { rows: [{ now: 1000 }] };
      return { rows: [], rowCount: 1 };
    } });
  } };
  const store = createPostgresAttemptStore({ client, preflight, target });
  await store.fixtureMutation({ attemptId: 'attempt-a', fence }, (tx) =>
    tx.query('UPDATE billing_fixture SET synthetic_id = $1', ['cus_synthetic']));
  assert.equal(transactions, 1);
  assert.match(calls.at(-1).sql, /^UPDATE billing_fixture/);
  assert.ok(calls.some(({ sql }) => sql.includes('pg_advisory_xact_lock')));
  assert.ok(calls.some(({ sql }) => sql.includes('fixture_leases') && sql.includes('FOR UPDATE')));
});

test('pinned adapter refuses a different stable environment tuple before SQL', async () => {
  const client = recordingClient();
  const store = createPostgresAttemptStore({ client, preflight, target });
  await assert.rejects(store.prepare({ attemptId: 'attempt-a',
    key: { branchId: database.branchId, suite: 'billing', fixtureKey: 'invoice-a' },
    candidateSha: 'a'.repeat(40), workflow: { repository: 'lawxcompany-stack/billing-validation-control',
      ref: 'refs/heads/main', runId: '100', runAttempt: 1,
      runnerLabel: 'billing-validation-' + 'a'.repeat(32) },
    environment: { ...preflight.expectedEnvironment, database: {
      projectRef: 'zzzzzzzzzzzzzzzzzzzz', branchId: database.branchId,
    } }, ttlSeconds: 60 }), { code: 'attempt_input_invalid' });
  assert.equal(client.calls.length, 0);
});
