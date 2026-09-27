import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createPostgresAttemptStore, installAttemptSchema } from '../../src/attempts/postgres-store.mjs';
import { providerIdempotencyKey } from '../../src/attempts/prepare.mjs';
import { runStripeMutation } from '../../src/runtime/stripe.mjs';

const database = { projectRef: 'abcdefghijklmnopqrst', parentProjectRef: 'zyxwvutsrqponmlkjihg',
  branchId: 'child-validation-1', branchName: 'billing-validation-1' };
const preflight = { expectedEnvironment: {
  database: { projectRef: database.projectRef, branchId: database.branchId },
  deployment: { id: 'dpl_candidate123', origin: 'https://candidate.vercel.app' },
  stripe: { accountId: 'acct_synthetic123' },
}, providerVerification: { supabase: { ...database, schemaFingerprintSha256: 'a'.repeat(64),
  migrationHistorySha256: 'b'.repeat(64) }, stripe: { accountId: 'acct_synthetic123',
  webhookEndpointId: 'we_synthetic123', webhookUrl: 'https://candidate.vercel.app/api/stripe/webhook',
  livemode: false } } };
const target = { ...database, isDefault: false, status: 'ACTIVE_HEALTHY', isolated: true };
const retentionPolicy = { version: 1, quotas: {
  attempts: 50, databaseRows: 500, authUsers: 50, stripeObjects: 500,
} };
const projection = { attempts: 1, databaseRows: 10, authUsers: 1, stripeObjects: 10 };
const cleanupProjection = { cleanupClaim: 'owned_reversible_provider_fixtures_only',
  databaseBaselineDigest: 'c'.repeat(64), mutatedResourceIds: ['cs_synthetic123'],
  retainedDatabaseResources: [], retainedObjects: [
    { id: 'ch_synthetic123', type: 'charge', status: 'retained_test_financial_object' },
  ], removedDatabaseFixtureCount: 0 };

function recordingClient() {
  const calls = [];
  const transactions = [];
  const client = { calls, async transaction(fn) {
    const transactionCalls = [];
    transactions.push(transactionCalls);
    return fn({ async query(sql, values) {
      const call = { sql, values };
      calls.push(call);
      transactionCalls.push(call);
      if (/clock_timestamp/.test(sql) && /SELECT/.test(sql)) return { rows: [{ now: 1000 }] };
      return { rows: [], rowCount: 1 };
    } });
  } };
  client.transactions = transactions;
  return client;
}

function fixtureMutationClient({ mode = 'valid' } = {}) {
  const calls = [];
  const fixtureCaseClaims = new Map();
  const fixtureResourceClaims = new Set();
  const fence = '11111111-1111-4111-8111-111111111111';
  const workflow = { repository: 'lawxcompany-stack/billing-validation-control',
    ref: 'refs/heads/main', runId: '100', runAttempt: 1,
    runnerLabel: 'billing-validation-' + 'a'.repeat(32) };
  const attemptRow = { attempt_id: 'attempt-fixture', branch_id: database.branchId,
    suite: 'billing', fixture_key: 'fixture-a', candidate_sha: 'a'.repeat(40),
    workflow_repository: workflow.repository, workflow_ref: workflow.ref, workflow_run_id: workflow.runId,
    workflow_run_attempt: workflow.runAttempt, runner_label: workflow.runnerLabel,
    database_project_ref: database.projectRef, deployment_id: preflight.expectedEnvironment.deployment.id,
    deployment_origin: preflight.expectedEnvironment.deployment.origin,
    stripe_account_id: preflight.expectedEnvironment.stripe.accountId,
    state: 'collecting', cleanup_status: 'pending', artifact_id: null, resource_ids: [],
    created_at_epoch: 900, updated_at_epoch: 900 };
  const resources = [
    { resource_type: 'supabase_branch', resource_id: `${database.projectRef}:${database.branchId}` },
    { resource_type: 'stripe_account', resource_id: preflight.expectedEnvironment.stripe.accountId },
  ].map((resource) => ({ ...resource, owner_attempt_id: 'attempt-fixture', fence,
    candidate_sha: 'a'.repeat(40), workflow_repository: workflow.repository,
    workflow_ref: workflow.ref, workflow_run_id: workflow.runId, workflow_run_attempt: workflow.runAttempt,
    runner_label: workflow.runnerLabel, environment_identity: preflight.expectedEnvironment,
    expires_at_epoch: 1060 }));
  const reservation = { reservation_id: 'reservation-fixture',
    attempt_id: mode === 'other-attempt' ? 'attempt-other' : 'attempt-fixture',
    project_ref: database.projectRef,
    branch_id: mode === 'other-scope' ? 'other-validation-branch' : database.branchId,
    stripe_account_id: preflight.expectedEnvironment.stripe.accountId, policy_version: 1,
    quota_limits: retentionPolicy.quotas,
    projection: { ...projection, databaseRows: mode === 'insufficient' ? 0 : 1 },
    capacity_snapshot: {}, fixture_rows_used: 0, created_at_epoch: 900 };
  const client = { calls, async transaction(fn) {
    return fn({ async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes('FROM billing_validation_control.attempts')) return { rows: [attemptRow] };
      if (sql.includes('FROM billing_validation_control.resource_locks')) return { rows: resources };
      if (sql.includes('FROM billing_validation_control.fixture_leases')) return { rows: [{
        attempt_id: 'attempt-fixture', fence,
        expires_at_epoch: mode === 'expired' ? 999 : 1060,
        owner_candidate_sha: 'a'.repeat(40), owner_repository: workflow.repository,
        owner_ref: workflow.ref, owner_run_id: workflow.runId, owner_run_attempt: workflow.runAttempt,
        recovery_only: mode === 'recovery-only',
      }] };
      if (sql.includes('FROM billing_validation_control.retention_reservations')) {
        return { rows: mode === 'missing' ? [] : [reservation] };
      }
      if (sql.includes('FROM billing_validation_control.retention_receipts')) {
        return { rows: mode === 'settled' ? [{ receipt_id: 'receipt-fixture',
          reservation_id: 'reservation-fixture', attempt_id: 'attempt-fixture',
          project_ref: database.projectRef, branch_id: database.branchId,
          stripe_account_id: preflight.expectedEnvironment.stripe.accountId,
          outcome: 'completed', retained_usage: { ...projection, databaseRows: 0 },
          created_at_epoch: 950 }] : [] };
      }
      if (sql.startsWith('INSERT INTO billing_validation_control.fixture_case_claims')) {
        const [attemptId, caseId, reservationId, ownerFence, candidateSha, namespaceId,
          projectRef, branchId, deploymentId, deploymentOrigin, stripeAccountId] = values;
        const key = `${attemptId}:${caseId}`;
        if (fixtureCaseClaims.has(key)) return { rows: [], rowCount: 0 };
        fixtureCaseClaims.set(key, { reservation_id: reservationId, owner_fence: ownerFence,
          candidate_sha: candidateSha, namespace_id: namespaceId, project_ref: projectRef,
          branch_id: branchId, deployment_id: deploymentId, deployment_origin: deploymentOrigin,
          stripe_account_id: stripeAccountId });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('FROM billing_validation_control.fixture_case_claims')) {
        return { rows: [fixtureCaseClaims.get(`${values[0]}:${values[1]}`)].filter(Boolean) };
      }
      if (sql.startsWith('INSERT INTO billing_validation_control.fixture_resource_claims')) {
        const key = `${values[0]}:${values[1]}:${values[2]}`;
        if (fixtureResourceClaims.has(key)) return { rows: [], rowCount: 0 };
        fixtureResourceClaims.add(key);
        return { rows: [], rowCount: 1 };
      }
      if (/SELECT extract\(epoch FROM clock_timestamp\(\)\)/u.test(sql)) return { rows: [{ now: 1000 }] };
      return { rows: [], rowCount: 1 };
    } });
  } };
  return { client, fence, reservation, fixtureCaseClaims, fixtureResourceClaims };
}

function postgresFixtureRequest(fence, { caseId = 'payment.approved', namespaceId =
  '00000000-0000-4000-8000-000000000001', fixtureId = '00000000-0000-4000-8000-000000000101' } = {}) {
  return { attemptId: 'attempt-fixture', fence, reservationId: 'reservation-fixture',
    rows: { databaseRows: 1 }, caseId, namespaceId, fixtureId, kind: 'catalog' };
}

function withGetter(source, key, getter) {
  const copy = { ...source };
  Object.defineProperty(copy, key, { configurable: true, enumerable: true, get: getter });
  return copy;
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

test('schema installer refuses absent identity pins before issuing DDL', async () => {
  const cases = [
    { preflight: { expectedEnvironment: { database: {} },
      providerVerification: { supabase: { parentProjectRef: database.parentProjectRef } } },
      target: { parentProjectRef: database.parentProjectRef, isDefault: false,
        isolated: true, status: 'ACTIVE_HEALTHY' } },
    { preflight: { ...preflight, expectedEnvironment: {
      ...preflight.expectedEnvironment, database: { branchId: database.branchId },
    } }, target },
    { preflight, target: { ...target, branchName: undefined } },
    { preflight: { ...preflight, providerVerification: { supabase: {
      ...preflight.providerVerification.supabase, branchId: undefined,
    } } }, target },
    { preflight: { ...preflight, providerVerification: {
      supabase: preflight.providerVerification.supabase,
    } }, target },
    { preflight: { ...preflight, providerVerification: {
      ...preflight.providerVerification, stripe: {
        ...preflight.providerVerification.stripe, accountId: 'acct_other',
      },
    } }, target },
  ];
  for (const invalid of cases) {
    const client = recordingClient();
    await assert.rejects(installAttemptSchema({ client, ...invalid }),
      { code: 'schema_target_unverified' });
    assert.equal(client.calls.length, 0);
  }
});

test('schema installer refuses null or coerced child identity fields before DDL', async () => {
  const malformed = [
    { field: 'branchName', value: null },
    { field: 'branchName', value: 123 },
    { field: 'parentProjectRef', value: new String(database.parentProjectRef) },
  ];
  for (const { field, value } of malformed) {
    const client = recordingClient();
    await assert.rejects(installAttemptSchema({ client,
      preflight: { ...preflight, providerVerification: {
        ...preflight.providerVerification,
        supabase: { ...preflight.providerVerification.supabase, [field]: value },
      } },
      target: { ...target, [field]: value },
    }), { code: 'schema_target_unverified' });
    assert.equal(client.calls.length, 0);
  }
});

test('changing expected-environment getter is refused without reading it or opening a transaction', async () => {
  const otherEnvironment = {
    database: { projectRef: 'mnopqrstabcdefghijkl', branchId: 'child-validation-2' },
    deployment: { id: 'dpl_candidate456', origin: 'https://other-candidate.vercel.app' },
    stripe: { accountId: 'acct_other123' },
  };
  let reads = 0;
  const unstablePreflight = withGetter(preflight, 'expectedEnvironment', () => {
    reads++;
    return reads === 1 ? preflight.expectedEnvironment : otherEnvironment;
  });
  const client = recordingClient();

  assert.throws(() => createPostgresAttemptStore({ client, preflight: unstablePreflight, target }),
    { code: 'schema_target_unverified' });
  await assert.rejects(installAttemptSchema({ client, preflight: unstablePreflight, target }),
    { code: 'schema_target_unverified' });
  assert.equal(reads, 0);
  assert.equal(client.transactions.length, 0);
  assert.equal(client.calls.length, 0);
});

test('preflight verification and target accessors are rejected without invoking them', () => {
  const cases = [
    (counter) => ({
      preflight: { ...preflight, providerVerification: withGetter(preflight.providerVerification,
        'supabase', () => { counter.count++; return preflight.providerVerification.supabase; }) }, target,
    }),
    (counter) => ({
      preflight: { ...preflight, expectedEnvironment: { ...preflight.expectedEnvironment,
        database: withGetter(preflight.expectedEnvironment.database, 'branchId', () => {
          counter.count++; return database.branchId;
        }) } }, target,
    }),
    (counter) => ({
      preflight: { ...preflight, expectedEnvironment: { ...preflight.expectedEnvironment,
        deployment: withGetter(preflight.expectedEnvironment.deployment, 'origin', () => {
          counter.count++; return 'https://candidate.vercel.app';
        }) } }, target,
    }),
    (counter) => ({
      preflight: { ...preflight, expectedEnvironment: { ...preflight.expectedEnvironment,
        stripe: withGetter(preflight.expectedEnvironment.stripe, 'accountId', () => {
          counter.count++; return 'acct_synthetic123';
        }) } }, target,
    }),
    (counter) => ({
      preflight: { ...preflight, providerVerification: { ...preflight.providerVerification,
        supabase: withGetter(preflight.providerVerification.supabase, 'projectRef', () => {
          counter.count++; return database.projectRef;
        }) } }, target,
    }),
    (counter) => ({
      preflight: { ...preflight, providerVerification: { ...preflight.providerVerification,
        stripe: withGetter(preflight.providerVerification.stripe, 'accountId', () => {
          counter.count++; return 'acct_synthetic123';
        }) } }, target,
    }),
    (counter) => ({
      preflight: { ...preflight, providerVerification: { ...preflight.providerVerification,
        stripe: withGetter(preflight.providerVerification.stripe, 'webhookEndpointId', () => {
          counter.count++; return 'we_synthetic123';
        }) } }, target,
    }),
    (counter) => ({
      preflight, target: withGetter(target, 'branchId', () => {
        counter.count++; return database.branchId;
      }),
    }),
  ];
  for (const field of ['projectRef', 'parentProjectRef', 'branchId', 'branchName', 'isDefault', 'status', 'isolated']) {
    cases.push((counter) => ({
      preflight, target: withGetter(target, field, () => {
        counter.count++; return target[field];
      }),
    }));
  }

  for (const makeCase of cases) {
    const counter = { count: 0 };
    const client = recordingClient();
    assert.throws(() => createPostgresAttemptStore({ client, ...makeCase(counter) }),
      { code: 'schema_target_unverified' });
    assert.equal(counter.count, 0);
    assert.equal(client.transactions.length, 0);
    assert.equal(client.calls.length, 0);
  }
});

test('store remains pinned to a detached environment snapshot after source objects change', async () => {
  const sourcePreflight = structuredClone(preflight);
  const sourceTarget = structuredClone(target);
  const stableEnvironment = structuredClone(sourcePreflight.expectedEnvironment);
  const client = recordingClient();
  const store = createPostgresAttemptStore({ client, preflight: sourcePreflight, target: sourceTarget });

  sourcePreflight.expectedEnvironment.database.projectRef = 'mnopqrstabcdefghijkl';
  sourcePreflight.expectedEnvironment.database.branchId = 'other-validation-2';
  sourcePreflight.expectedEnvironment.deployment.id = 'dpl_other456';
  sourcePreflight.expectedEnvironment.deployment.origin = 'https://other-candidate.vercel.app';
  sourcePreflight.expectedEnvironment.stripe.accountId = 'acct_other123';
  sourcePreflight.providerVerification.supabase.projectRef = 'mnopqrstabcdefghijkl';
  sourcePreflight.providerVerification.supabase.branchId = 'other-validation-2';
  sourcePreflight.providerVerification.stripe.accountId = 'acct_other123';
  sourceTarget.branchId = 'other-validation-2';

  await store.prepare({ attemptId: 'attempt-stable-snapshot',
    key: { branchId: database.branchId, suite: 'billing', fixtureKey: 'invoice-snapshot' },
    candidateSha: 'a'.repeat(40), workflow: { repository: 'lawxcompany-stack/billing-validation-control',
      ref: 'refs/heads/main', runId: '100', runAttempt: 1,
      runnerLabel: 'billing-validation-' + 'a'.repeat(32) },
    environment: stableEnvironment, ttlSeconds: 60, retentionPolicy, projection });

  const insert = client.calls.find(({ sql }) => sql.includes('INSERT INTO billing_validation_control.attempts'));
  assert.ok(insert);
  assert.equal(insert.values[10], stableEnvironment.database.projectRef);
  assert.equal(insert.values[11], stableEnvironment.deployment.id);
  assert.equal(insert.values[12], stableEnvironment.deployment.origin);
  assert.equal(insert.values[13], stableEnvironment.stripe.accountId);
});

test('verified installer issues only the dedicated control schema DDL', async () => {
  const client = recordingClient();
  await installAttemptSchema({ client, preflight, target });
  assert.equal(client.transactions.length, 1);
  assert.equal(client.transactions[0][0].sql, 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
  assert.equal(client.transactions[0].length, 2);
  assert.match(client.transactions[0][1].sql, /CREATE SCHEMA IF NOT EXISTS billing_validation_control/);
  assert.equal([...client.transactions[0][1].sql.matchAll(/CREATE TABLE IF NOT EXISTS ([\w.]+)/g)]
    .every((match) => match[1].startsWith('billing_validation_control.')), true);
});

test('every PostgreSQL store transaction starts at READ COMMITTED before its first read or lock', async () => {
  const client = recordingClient();
  const store = createPostgresAttemptStore({ client, preflight, target });
  await store.prepare({ attemptId: 'attempt-a',
    key: { branchId: database.branchId, suite: 'billing', fixtureKey: 'invoice-a' },
    candidateSha: 'a'.repeat(40), workflow: { repository: 'lawxcompany-stack/billing-validation-control',
      ref: 'refs/heads/main', runId: '100', runAttempt: 1,
      runnerLabel: 'billing-validation-' + 'a'.repeat(32) },
    environment: preflight.expectedEnvironment, ttlSeconds: 60, retentionPolicy, projection });
  await store.getAttempt('attempt-a');

  assert.equal(client.transactions.length, 2);
  for (const transaction of client.transactions) {
    assert.equal(transaction[0].sql, 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
  }
});

test('schema gives fixture leases the exact shared key and fences owner rows', () => {
  const sql = readFileSync(new URL('../../src/attempts/schema.sql', import.meta.url), 'utf8');
  assert.match(sql, /PRIMARY KEY \(branch_id, suite, fixture_key\)/);
  assert.match(sql, /FOREIGN KEY \(attempt_id, branch_id, suite, fixture_key\)\s+REFERENCES billing_validation_control\.attempts\(attempt_id, branch_id, suite, fixture_key\)/);
  assert.match(sql, /fence uuid NOT NULL/);
  assert.match(sql, /owner_run_id text NOT NULL/);
  assert.match(sql, /owner_run_attempt integer NOT NULL/);
  assert.match(sql, /owner_candidate_sha char\(40\) NOT NULL/);
  assert.match(sql, /REVOKE ALL ON SCHEMA billing_validation_control FROM PUBLIC/);
  assert.doesNotMatch(sql, /candidate_sha, suite, fixture_key\)/);
});

test('schema stores append-only retention reservations and terminal receipts with update/delete denial', () => {
  const sql = readFileSync(new URL('../../src/attempts/schema.sql', import.meta.url), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS billing_validation_control\.retention_reservations/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS billing_validation_control\.retention_receipts/);
  assert.match(sql, /reservation_id text NOT NULL UNIQUE\s+REFERENCES billing_validation_control\.retention_reservations/);
  assert.match(sql, /projection jsonb NOT NULL/);
  assert.match(sql, /retained_usage jsonb NOT NULL/);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON billing_validation_control\.retention_reservations/);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON billing_validation_control\.retention_receipts/);
  assert.match(sql, /BEFORE TRUNCATE ON billing_validation_control\.retention_reservations/);
  assert.match(sql, /BEFORE TRUNCATE ON billing_validation_control\.retention_receipts/);
  assert.match(sql, /valid_retention_usage\(quota_limits, 1, false\)/);
  assert.match(sql, /valid_retention_usage\(projection, 0, true\)/);
  assert.match(sql, /retained_usage ->> quota_key/);
  assert.match(sql, /REVOKE UPDATE, DELETE, TRUNCATE ON billing_validation_control\.retention_reservations/);
  assert.match(sql, /REVOKE UPDATE, DELETE, TRUNCATE ON billing_validation_control\.retention_receipts/);
  const reservationDefinition = sql.match(/CREATE TABLE IF NOT EXISTS billing_validation_control\.retention_reservations\s*\(([\s\S]*?)\n\);/u);
  assert.ok(reservationDefinition);
  assert.doesNotMatch(reservationDefinition[1], /expires_at/u);
});

test('schema persistently accounts fixture rows without mutating append-only reservations', () => {
  const sql = readFileSync(new URL('../../src/attempts/schema.sql', import.meta.url), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS billing_validation_control\.fixture_reservation_claims/);
  assert.match(sql, /database_rows_used bigint NOT NULL CHECK \(database_rows_used >= 0\)/);
  assert.match(sql, /NEW\.database_rows_used > \(reservation\.projection ->> 'databaseRows'\)::bigint/);
  assert.match(sql, /NEW\.database_rows_used < OLD\.database_rows_used/);
  assert.match(sql, /BEFORE DELETE ON billing_validation_control\.fixture_reservation_claims/);
  assert.match(sql, /BEFORE TRUNCATE ON billing_validation_control\.fixture_reservation_claims/);
});

test('schema persists closed, attempt-bound append-only cleanup receipts', () => {
  const sql = readFileSync(new URL('../../src/attempts/schema.sql', import.meta.url), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS billing_validation_control\.cleanup_receipts/);
  assert.match(sql, /reservation_id text NOT NULL UNIQUE/);
  assert.match(sql, /owner_fence uuid NOT NULL/);
  assert.match(sql, /cleanup_digest char\(64\) NOT NULL/);
  assert.match(sql, /verified_projection jsonb NOT NULL/);
  assert.match(sql, /reservation\.attempt_id <> NEW\.attempt_id/);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON billing_validation_control\.cleanup_receipts/);
  assert.match(sql, /BEFORE TRUNCATE ON billing_validation_control\.cleanup_receipts/);
  assert.match(sql, /REVOKE UPDATE, DELETE, TRUNCATE ON billing_validation_control\.cleanup_receipts/);
});

test('schema persists global resource ownership and append-only Stripe intents and receipts', () => {
  const sql = readFileSync(new URL('../../src/attempts/schema.sql', import.meta.url), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS billing_validation_control\.resource_locks/);
  assert.match(sql, /PRIMARY KEY \(resource_type, resource_id\)/);
  for (const field of ['owner_attempt_id', 'fence', 'candidate_sha', 'workflow_run_id',
    'workflow_run_attempt', 'environment_identity', 'expires_at']) {
    assert.match(sql, new RegExp(`\\b${field}\\b`));
  }
  assert.match(sql, /CREATE TABLE IF NOT EXISTS billing_validation_control\.stripe_intents/);
  assert.match(sql, /UNIQUE \(attempt_id, operation\)/);
  assert.match(sql, /request_digest char\(64\) NOT NULL/);
  assert.match(sql, /idempotency_key text NOT NULL/);
  assert.match(sql, /state text NOT NULL CHECK \(state = 'in_flight'\)/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS billing_validation_control\.stripe_receipts/);
  assert.match(sql, /UNIQUE \(account_id, idempotency_key\)/);
  assert.match(sql, /intent_id text NOT NULL UNIQUE REFERENCES billing_validation_control\.stripe_intents/);
  for (const table of ['stripe_intents', 'stripe_receipts']) {
    const qualified = `billing_validation_control\\.${table}`;
    assert.match(sql, new RegExp(`BEFORE UPDATE OR DELETE ON ${qualified}`));
    assert.match(sql, new RegExp(`BEFORE TRUNCATE ON ${qualified}`));
    assert.match(sql, new RegExp(`REVOKE UPDATE, DELETE, TRUNCATE ON ${qualified}`));
  }
});

test('SQL retention validation rejects decimal-formatted integers before counting them', () => {
  const sql = readFileSync(new URL('../../src/attempts/schema.sql', import.meta.url), 'utf8');
  const validator = sql.match(/CREATE OR REPLACE FUNCTION billing_validation_control\.valid_retention_usage[\s\S]*?\$\$([\s\S]*?)\$\$;/)?.[1];
  assert.ok(validator);
  const canonicalIntegerPattern = validator.match(/item\.value::text !~ '([^']+)'/)?.[1];
  assert.equal(canonicalIntegerPattern, '^(0|[1-9][0-9]*)$');
  assert.equal(new RegExp(canonicalIntegerPattern).test('2.0'), false);
  assert.ok(validator.indexOf("item.value::text !~") < validator.indexOf("units := (item.value #>> '{}')::numeric"));
});

test('zero-row conflicting attempt insert cannot create an orphan fixture lease', async () => {
  const calls = [];
  const client = { async transaction(fn) {
    return fn({ async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes('clock_timestamp')) return { rows: [{ now: 1000 }] };
      if (sql.includes('INSERT INTO billing_validation_control.attempts')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    } });
  } };
  const store = createPostgresAttemptStore({ client, preflight, target });
  await assert.rejects(store.prepare({ attemptId: 'attempt-a',
    key: { branchId: database.branchId, suite: 'billing', fixtureKey: 'invoice-b' },
    candidateSha: 'a'.repeat(40), workflow: { repository: 'lawxcompany-stack/billing-validation-control',
      ref: 'refs/heads/main', runId: '100', runAttempt: 1,
      runnerLabel: 'billing-validation-' + 'a'.repeat(32) },
    environment: preflight.expectedEnvironment, ttlSeconds: 60, retentionPolicy, projection }),
  { code: 'attempt_conflict' });
  assert.equal(calls.some(({ sql }) => sql.includes('INSERT INTO billing_validation_control.fixture_leases')), false);
});

test('PostgreSQL adapter accepts an injected transactional client and parameterizes key and metadata', async () => {
  const client = recordingClient();
  const store = createPostgresAttemptStore({ client, preflight, target });
  await store.prepare({ attemptId: 'attempt-a', key: { branchId: database.branchId, suite: 'billing', fixtureKey: 'invoice-a' },
    candidateSha: 'a'.repeat(40), workflow: { repository: 'lawxcompany-stack/billing-validation-control',
      ref: 'refs/heads/main', runId: '100', runAttempt: 1, runnerLabel: 'billing-validation-' + 'a'.repeat(32) },
    environment: preflight.expectedEnvironment, ttlSeconds: 60, retentionPolicy, projection });
  const attemptLock = client.calls.findIndex(({ sql, values }) =>
    sql.includes('pg_advisory_xact_lock') && values?.[0] === '["attempt","attempt-a"]');
  const attemptRead = client.calls.findIndex(({ sql }) =>
    sql.includes('FROM billing_validation_control.attempts'));
  assert.ok(attemptLock >= 0 && attemptLock < attemptRead);
  assert.ok(client.calls.some(({ sql, values }) => /pg_advisory_xact_lock/.test(sql) && values?.[0]?.includes('invoice-a')));
  assert.ok(client.calls.some(({ sql, values }) => /INSERT INTO billing_validation_control\.fixture_leases/.test(sql) &&
    values?.includes('child-validation-1')));
  assert.ok(client.calls.some(({ sql }) => /INSERT INTO billing_validation_control\.retention_reservations/.test(sql)));
  assert.equal(client.calls.some(({ sql }) => sql.includes('invoice-a') || sql.includes('attempt-a')), false);
});

test('PostgreSQL admission locks both global provider resources before capacity and persists their exact owner', async () => {
  const client = recordingClient();
  const store = createPostgresAttemptStore({ client, preflight, target });
  await store.prepare({ attemptId: 'attempt-a', key: { branchId: database.branchId,
    suite: 'billing', fixtureKey: 'invoice-a' }, candidateSha: 'a'.repeat(40),
  workflow: { repository: 'lawxcompany-stack/billing-validation-control', ref: 'refs/heads/main',
    runId: '100', runAttempt: 1, runnerLabel: 'billing-validation-' + 'a'.repeat(32) },
  environment: preflight.expectedEnvironment, ttlSeconds: 60, retentionPolicy, projection });

  const globalLocks = client.calls.filter(({ sql }) => /resource_locks/.test(sql));
  const lockAttempts = client.calls.map(({ sql, values }, index) => ({ sql, values, index }))
    .filter(({ sql, values }) => /pg_advisory_xact_lock/.test(sql) &&
      values?.[0]?.startsWith('["resource"'));
  const capacityIndex = client.calls.findIndex(({ sql }) => sql.includes('retention_capacity_snapshot'));
  const providerLockWrites = client.calls.filter(({ sql }) =>
    /INSERT INTO billing_validation_control\.resource_locks/.test(sql));
  assert.equal(lockAttempts.length, 2);
  assert.ok(lockAttempts.every(({ index }) => index < capacityIndex));
  assert.ok(globalLocks.length >= 3);
  assert.equal(providerLockWrites.length, 2);
  assert.ok(providerLockWrites.some(({ values }) => values?.includes('attempt-a') &&
    values?.includes(`${database.projectRef}:${database.branchId}`)));
  assert.ok(providerLockWrites.some(({ values }) => values?.includes('acct_synthetic123') &&
    values?.includes('attempt-a')));
  const reservationIndex = client.calls.findIndex(({ sql }) =>
    /INSERT INTO billing_validation_control\.retention_reservations/.test(sql));
  const leaseIndex = client.calls.findIndex(({ sql }) =>
    /INSERT INTO billing_validation_control\.fixture_leases/.test(sql));
  assert.ok(capacityIndex < reservationIndex && reservationIndex < leaseIndex);
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
      if (sql.includes('FROM billing_validation_control.resource_locks')) return { rows: [
        { resource_type: 'supabase_branch', resource_id: `${database.projectRef}:${database.branchId}`,
          owner_attempt_id: 'attempt-a', fence, candidate_sha: 'a'.repeat(40),
          workflow_repository: 'lawxcompany-stack/billing-validation-control',
          workflow_ref: 'refs/heads/main', workflow_run_id: '100', workflow_run_attempt: 1,
          runner_label: 'billing-validation-' + 'a'.repeat(32),
          environment_identity: preflight.expectedEnvironment, expires_at_epoch: 1060 },
        { resource_type: 'stripe_account', resource_id: 'acct_synthetic123',
          owner_attempt_id: 'attempt-a', fence, candidate_sha: 'a'.repeat(40),
          workflow_repository: 'lawxcompany-stack/billing-validation-control',
          workflow_ref: 'refs/heads/main', workflow_run_id: '100', workflow_run_attempt: 1,
          runner_label: 'billing-validation-' + 'a'.repeat(32),
          environment_identity: preflight.expectedEnvironment, expires_at_epoch: 1060 },
      ] };
      if (sql.includes('FROM billing_validation_control.fixture_leases')) return { rows: [{
        attempt_id: 'attempt-a', fence, expires_at_epoch: 1060, owner_candidate_sha: 'a'.repeat(40),
        owner_repository: 'lawxcompany-stack/billing-validation-control', owner_ref: 'refs/heads/main',
        owner_run_id: '100', owner_run_attempt: 1,
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

test('PostgreSQL fixture reservation claim locks the exact owner and reservation before invoking the writer', async () => {
  const { client, fence } = fixtureMutationClient();
  const store = createPostgresAttemptStore({ client, preflight, target });
  const events = [];

  const result = await store.fixtureMutationWithReservation(postgresFixtureRequest(fence), async (transaction) => {
    events.push('writer');
    assert.equal(transaction.reservationLocked, true);
    assert.equal(transaction.reservationValidated, true);
    assert.equal(transaction.reservationStatus, 'active');
    assert.equal(transaction.reservationSettled, false);
    assert.equal(transaction.remainingDatabaseRows, 1);
    return 'written';
  });

  assert.equal(result, 'written');
  const index = (pattern) => client.calls.findIndex(({ sql }) => pattern.test(sql));
  const attemptLock = client.calls.findIndex(({ sql, values }) => sql.includes('pg_advisory_xact_lock') &&
    values?.[0] === '["attempt","attempt-fixture"]');
  const resourceLock = client.calls.findIndex(({ sql, values }) => sql.includes('pg_advisory_xact_lock') &&
    values?.[0]?.startsWith('["resource"'));
  const scopeLock = client.calls.findIndex(({ sql, values }) => sql.includes('pg_advisory_xact_lock') &&
    values?.[0]?.startsWith('["retention"'));
  const reservationRead = index(/FROM billing_validation_control\.retention_reservations[\s\S]*FOR UPDATE/u);
  const receiptRead = index(/FROM billing_validation_control\.retention_receipts/u);
  const claimWrite = index(/INSERT INTO billing_validation_control\.fixture_reservation_claims/u);
  assert.ok(attemptLock >= 0 && attemptLock < resourceLock && resourceLock < scopeLock &&
    scopeLock < reservationRead && reservationRead < receiptRead && receiptRead < claimWrite);
  const caseClaimWrite = index(/INSERT INTO billing_validation_control\.fixture_case_claims/u);
  assert.deepEqual(client.calls[caseClaimWrite].values, ['attempt-fixture', 'payment.approved',
    'reservation-fixture', fence, 'a'.repeat(40), '00000000-0000-4000-8000-000000000001',
    database.projectRef, database.branchId, preflight.expectedEnvironment.deployment.id,
    preflight.expectedEnvironment.deployment.origin, preflight.expectedEnvironment.stripe.accountId]);
  assert.equal(client.calls.filter(({ sql }) => /SET TRANSACTION ISOLATION LEVEL READ COMMITTED/u.test(sql)).length, 1);
  assert.deepEqual(events, ['writer']);
});

test('PostgreSQL fixture case claims survive store recreation and reject a second namespace before writer dispatch', async () => {
  const { client, fence, fixtureCaseClaims } = fixtureMutationClient();
  const firstStore = createPostgresAttemptStore({ client, preflight, target });
  let writerCalls = 0;
  await firstStore.fixtureMutationWithReservation(postgresFixtureRequest(fence), async () => {
    writerCalls++;
    return 'written';
  });

  const restartedStore = createPostgresAttemptStore({ client, preflight, target });
  await assert.rejects(restartedStore.fixtureMutationWithReservation(postgresFixtureRequest(fence, {
    namespaceId: '00000000-0000-4000-8000-000000000002',
    fixtureId: '00000000-0000-4000-8000-000000000102',
  }), async () => { writerCalls++; }), { code: 'fixture_case_duplicate' });
  assert.equal(writerCalls, 1);
  assert.equal(fixtureCaseClaims.size, 1);
});

test('PostgreSQL reservation, settlement, scope, capacity, expiry, and recovery refusals call no writer', async () => {
  const cases = [
    ['missing', 'retention_reservation_missing'],
    ['settled', 'retention_attempt_settled'],
    ['other-attempt', 'fixture_reservation_invalid'],
    ['other-scope', 'fixture_reservation_invalid'],
    ['insufficient', 'fixture_reservation_insufficient'],
    ['expired', 'lease_expired'],
    ['recovery-only', 'recovery_read_only'],
  ];

  for (const [mode, code] of cases) {
    const { client, fence } = fixtureMutationClient({ mode });
    const store = createPostgresAttemptStore({ client, preflight, target });
    let writerCalls = 0;
    await assert.rejects(store.fixtureMutationWithReservation(postgresFixtureRequest(fence),
      async () => { writerCalls++; }),
    { code }, mode);
    assert.equal(writerCalls, 0, mode);
    assert.equal(client.calls.some(({ sql }) => /(?:INSERT INTO|UPDATE) billing_validation_control\.fixture_reservation_claims/u.test(sql)), false, mode);
  }
});

test('PostgreSQL persists Stripe intents, blocks replay, and appends one independent reconciliation receipt', async () => {
  const calls = [];
  const transactions = [];
  const fence = '11111111-1111-4111-8111-111111111111';
  const workflow = { repository: 'lawxcompany-stack/billing-validation-control',
    ref: 'refs/heads/main', runId: '100', runAttempt: 1,
    runnerLabel: 'billing-validation-' + 'a'.repeat(32) };
  const attemptRow = { attempt_id: 'attempt-stripe', branch_id: database.branchId,
    suite: 'billing', fixture_key: 'invoice-a', candidate_sha: 'a'.repeat(40),
    workflow_repository: workflow.repository, workflow_ref: workflow.ref, workflow_run_id: workflow.runId,
    workflow_run_attempt: workflow.runAttempt, runner_label: workflow.runnerLabel,
    database_project_ref: database.projectRef, deployment_id: 'dpl_candidate123',
    deployment_origin: 'https://candidate.vercel.app', stripe_account_id: 'acct_synthetic123',
    state: 'collecting', cleanup_status: 'pending', artifact_id: null, resource_ids: [],
    created_at_epoch: 1000, updated_at_epoch: 1000 };
  const intentRow = { intent_id: 'intent-postgres-1', attempt_id: 'attempt-stripe',
    owner_fence: fence, account_id: 'acct_synthetic123', candidate_sha: 'a'.repeat(40),
    workflow_repository: workflow.repository, workflow_ref: workflow.ref,
    workflow_run_id: workflow.runId, workflow_run_attempt: workflow.runAttempt,
    runner_label: workflow.runnerLabel, environment_identity: preflight.expectedEnvironment,
    action: 'checkout.replay', operation: 'checkout:create:postgres', request_digest: 'd'.repeat(64),
    idempotency_key: providerIdempotencyKey('attempt-stripe', 'stripe', 'checkout:create:postgres'),
    state: 'in_flight', created_at_epoch: 1000 };
  let intentPersisted = false;
  let receiptRow = null;
  const ownerLocks = [
    { resource_type: 'supabase_branch', resource_id: `${database.projectRef}:${database.branchId}` },
    { resource_type: 'stripe_account', resource_id: 'acct_synthetic123' },
  ].map((resource) => ({ ...resource, owner_attempt_id: 'attempt-stripe', fence,
    candidate_sha: 'a'.repeat(40), workflow_repository: workflow.repository,
    workflow_ref: workflow.ref, workflow_run_id: workflow.runId, workflow_run_attempt: 1,
    runner_label: workflow.runnerLabel, environment_identity: preflight.expectedEnvironment,
    expires_at_epoch: 1060 }));
  const client = { async transaction(fn) {
    const transactionCalls = [];
    transactions.push(transactionCalls);
    return fn({ async query(sql, values) {
      calls.push({ sql, values });
      transactionCalls.push({ sql, values });
      if (/clock_timestamp/.test(sql) && /SELECT/.test(sql)) return { rows: [{ now: 1000 }] };
      if (sql.includes('FROM billing_validation_control.attempts')) return { rows: [attemptRow] };
      if (sql.includes('FROM billing_validation_control.resource_locks')) return { rows: ownerLocks };
      if (sql.includes('FROM billing_validation_control.fixture_leases')) return { rows: [{
        attempt_id: 'attempt-stripe', fence, expires_at_epoch: 1060,
        owner_candidate_sha: 'a'.repeat(40), owner_repository: workflow.repository,
        owner_ref: workflow.ref, owner_run_id: workflow.runId, owner_run_attempt: 1,
      }] };
      if (sql.includes('FROM billing_validation_control.stripe_intents')) {
        if (sql.includes('WHERE attempt_id = $1 AND operation = $2')) {
          return { rows: intentPersisted ? [intentRow] : [] };
        }
        return { rows: intentPersisted ? [intentRow] : [] };
      }
      if (sql.includes('FROM billing_validation_control.stripe_receipts')) {
        return { rows: receiptRow ? [receiptRow] : [] };
      }
      if (sql.includes('INSERT INTO billing_validation_control.stripe_intents')) {
        intentPersisted = true;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO billing_validation_control.stripe_receipts')) {
        receiptRow = { receipt_id: values[0], intent_id: values[1], attempt_id: values[2],
          owner_fence: values[3], account_id: values[4], operation: values[5],
          request_digest: values[6], idempotency_key: values[7], observation_digest: values[8],
          resource_ids: JSON.parse(values[9]), observed_at_epoch: values[10] };
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    } });
  } };
  let independentlyVerified = false;
  const store = createPostgresAttemptStore({ client, preflight, target,
    verifyProviderObservation: async ({ intent, observation }) => {
      independentlyVerified = intent.state === 'in_flight' && observation.livemode === false;
      return independentlyVerified;
    } });
  const operation = 'checkout:create:postgres';
  const idempotencyKey = providerIdempotencyKey('attempt-stripe', 'stripe', operation);
  const intent = await store.beginStripeIntent({ attemptId: 'attempt-stripe', fence,
    candidateSha: 'a'.repeat(40), workflow, environment: preflight.expectedEnvironment,
    action: 'checkout.replay', operation, requestDigest: 'd'.repeat(64), idempotencyKey });
  const intentWrite = calls.find(({ sql }) => sql.includes('INSERT INTO billing_validation_control.stripe_intents'));
  assert.ok(intentWrite);
  assert.ok(intentWrite.values.includes('d'.repeat(64)));
  assert.ok(intentWrite.values.includes(idempotencyKey));
  assert.equal(intent.state, 'in_flight');
  assert.ok(transactions[0].some(({ sql }) => sql.includes('INSERT INTO billing_validation_control.stripe_intents')));
  assert.ok(transactions[0].some(({ sql }) => sql.includes('WHERE attempt_id = $1 AND operation = $2')));
  await assert.rejects(store.beginStripeIntent({ attemptId: 'attempt-stripe', fence,
    candidateSha: 'a'.repeat(40), workflow, environment: preflight.expectedEnvironment,
    action: 'checkout.replay', operation, requestDigest: 'd'.repeat(64), idempotencyKey }),
  { code: 'stripe_intent_unresolved' });
  assert.equal(calls.filter(({ sql }) => sql.includes('INSERT INTO billing_validation_control.stripe_intents')).length, 1);

  const observation = { accountId: 'acct_synthetic123', livemode: false, operation,
    requestDigest: 'd'.repeat(64), idempotencyKey, resourceIds: ['cs_synthetic123'] };
  await store.reconcileStripeIntent({ attemptId: 'attempt-stripe', fence,
    intentId: 'intent-postgres-1', observation });
  const receiptWrite = calls.find(({ sql }) => sql.includes('INSERT INTO billing_validation_control.stripe_receipts'));
  const receiptTransaction = transactions.find((items) => items.some(({ sql }) =>
    sql.includes('INSERT INTO billing_validation_control.stripe_receipts')));
  assert.ok(independentlyVerified);
  assert.ok(receiptWrite);
  assert.ok(receiptTransaction.some(({ sql }) => sql.includes('FROM billing_validation_control.stripe_intents')));
  assert.ok(receiptTransaction.some(({ sql }) => sql.includes('FROM billing_validation_control.stripe_receipts')));
  assert.ok(receiptWrite.values.includes('d'.repeat(64)));
  assert.ok(receiptWrite.values.some((value) => typeof value === 'string' && value.includes('cs_synthetic123')));
  assert.equal(receiptWrite.values.some((value) => typeof value === 'string' && value.includes('client_secret')), false);
  await assert.rejects(store.reconcileStripeIntent({ attemptId: 'attempt-stripe', fence,
    intentId: 'intent-postgres-1', observation }), { code: 'stripe_intent_already_reconciled' });
  assert.equal(calls.filter(({ sql }) => sql.includes('INSERT INTO billing_validation_control.stripe_receipts')).length, 1);
  const ledgerMutations = calls.filter(({ sql }) => /billing_validation_control\.stripe_(?:intents|receipts)/.test(sql) &&
    /^\s*(?:UPDATE|DELETE|TRUNCATE)\b/i.test(sql));
  assert.deepEqual(ledgerMutations, []);
});

test('PostgreSQL pending intent query is authorized by the current attempt fence and excludes receipted intents', async () => {
  const calls = [];
  const fence = '11111111-1111-4111-8111-111111111111';
  const workflow = { repository: 'lawxcompany-stack/billing-validation-control',
    ref: 'refs/heads/main', runId: '100', runAttempt: 1,
    runnerLabel: 'billing-validation-' + 'a'.repeat(32) };
  const attemptRow = { attempt_id: 'attempt-pending', branch_id: database.branchId,
    suite: 'billing', fixture_key: 'invoice-pending', candidate_sha: 'a'.repeat(40),
    workflow_repository: workflow.repository, workflow_ref: workflow.ref,
    workflow_run_id: workflow.runId, workflow_run_attempt: workflow.runAttempt,
    runner_label: workflow.runnerLabel, database_project_ref: database.projectRef,
    deployment_id: 'dpl_candidate123', deployment_origin: 'https://candidate.vercel.app',
    stripe_account_id: 'acct_synthetic123', state: 'rechecking', cleanup_status: 'pending',
    artifact_id: null, resource_ids: [], created_at_epoch: 1000, updated_at_epoch: 1000 };
  const locks = [
    { resource_type: 'supabase_branch', resource_id: `${database.projectRef}:${database.branchId}` },
    { resource_type: 'stripe_account', resource_id: 'acct_synthetic123' },
  ].map((resource) => ({ ...resource, owner_attempt_id: 'attempt-pending', fence,
    candidate_sha: 'a'.repeat(40), workflow_repository: workflow.repository,
    workflow_ref: workflow.ref, workflow_run_id: workflow.runId, workflow_run_attempt: 1,
    runner_label: workflow.runnerLabel, environment_identity: preflight.expectedEnvironment,
    expires_at_epoch: 1060 }));
  const pendingRow = { intent_id: 'intent-pending-1', attempt_id: 'attempt-pending',
    owner_fence: '22222222-2222-4222-8222-222222222222', account_id: 'acct_synthetic123',
    candidate_sha: 'a'.repeat(40), workflow_repository: workflow.repository,
    workflow_ref: workflow.ref, workflow_run_id: workflow.runId, workflow_run_attempt: 1,
    runner_label: workflow.runnerLabel, environment_identity: preflight.expectedEnvironment,
    action: 'checkout.replay', operation: 'checkout:create:pending', request_digest: 'd'.repeat(64),
    idempotency_key: providerIdempotencyKey('attempt-pending', 'stripe', 'checkout:create:pending'),
    state: 'in_flight', created_at_epoch: 1000 };
  const client = { async transaction(fn) {
    return fn({ async query(sql, values) {
      calls.push({ sql, values });
      if (/clock_timestamp/.test(sql) && /SELECT/.test(sql)) return { rows: [{ now: 1000 }] };
      if (sql.includes('FROM billing_validation_control.attempts')) return { rows: [attemptRow] };
      if (sql.includes('FROM billing_validation_control.resource_locks')) return { rows: locks };
      if (sql.includes('FROM billing_validation_control.fixture_leases')) return { rows: [{
        attempt_id: 'attempt-pending', fence, expires_at_epoch: 1060,
        owner_candidate_sha: 'a'.repeat(40), owner_repository: workflow.repository,
        owner_ref: workflow.ref, owner_run_id: workflow.runId, owner_run_attempt: 1,
      }] };
      if (sql.includes('FROM billing_validation_control.stripe_intents')) return { rows: [pendingRow] };
      return { rows: [], rowCount: 1 };
    } });
  } };
  const store = createPostgresAttemptStore({ client, preflight, target });
  assert.equal(typeof store.listPendingStripeIntents, 'function');

  const pending = await store.listPendingStripeIntents({ attemptId: 'attempt-pending', fence });
  assert.deepEqual(pending, [{ intentId: 'intent-pending-1', attemptId: 'attempt-pending',
    fence: pendingRow.owner_fence, accountId: 'acct_synthetic123', candidateSha: 'a'.repeat(40),
    workflow, environment: preflight.expectedEnvironment, action: 'checkout.replay',
    operation: 'checkout:create:pending', requestDigest: 'd'.repeat(64),
    idempotencyKey: providerIdempotencyKey('attempt-pending', 'stripe', 'checkout:create:pending'),
    state: 'in_flight', createdAt: 1000 }]);
  const pendingQuery = calls.find(({ sql }) => sql.includes('FROM billing_validation_control.stripe_intents'));
  assert.ok(pendingQuery.sql.includes('NOT EXISTS'));
  assert.ok(pendingQuery.sql.includes('billing_validation_control.stripe_receipts'));
  assert.ok(pendingQuery.sql.includes('FOR UPDATE'));
  assert.deepEqual(pendingQuery.values, ['attempt-pending']);
  assert.ok(calls.some(({ sql }) => sql.includes('fixture_leases') && sql.includes('FOR UPDATE')));
  assert.ok(calls.some(({ sql, values }) => sql.includes('pg_advisory_xact_lock') &&
    values?.[0]?.startsWith('["resource"')));
  await assert.rejects(store.listPendingStripeIntents({ attemptId: 'attempt-pending',
    fence: '22222222-2222-4222-8222-222222222222' }), { code: 'lease_fence_lost' });
});

test('PostgreSQL cleanup receipt persists before release and rolls receipt, state, lease, and locks back together', async () => {
  const attemptId = 'attempt-cleanup-pg';
  const fence = '11111111-1111-4111-8111-111111111111';
  const workflow = { repository: 'lawxcompany-stack/billing-validation-control',
    ref: 'refs/heads/main', runId: '100', runAttempt: 1,
    runnerLabel: 'billing-validation-' + 'a'.repeat(32) };
  const verifiedProjection = cleanupProjection;
  function makeFixture(failure = null) {
    const state = {
      attempt: { attempt_id: attemptId, branch_id: database.branchId, suite: 'billing',
        fixture_key: 'invoice-cleanup', candidate_sha: 'a'.repeat(40),
        workflow_repository: workflow.repository, workflow_ref: workflow.ref,
        workflow_run_id: workflow.runId, workflow_run_attempt: workflow.runAttempt,
        runner_label: workflow.runnerLabel, database_project_ref: database.projectRef,
        deployment_id: 'dpl_candidate123', deployment_origin: 'https://candidate.vercel.app',
        stripe_account_id: 'acct_synthetic123', state: 'cancelled', cleanup_status: 'pending',
        artifact_id: null, resource_ids: [], created_at_epoch: 1000, updated_at_epoch: 1000 },
      lease: { attempt_id: attemptId, fence, expires_at_epoch: 1200,
        owner_candidate_sha: 'a'.repeat(40), owner_repository: workflow.repository,
        owner_ref: workflow.ref, owner_run_id: workflow.runId, owner_run_attempt: workflow.runAttempt },
      resources: [
        { resource_type: 'supabase_branch', resource_id: `${database.projectRef}:${database.branchId}` },
        { resource_type: 'stripe_account', resource_id: 'acct_synthetic123' },
      ].map((resource) => ({ ...resource, owner_attempt_id: attemptId, fence,
        candidate_sha: 'a'.repeat(40), workflow_repository: workflow.repository,
        workflow_ref: workflow.ref, workflow_run_id: workflow.runId, workflow_run_attempt: 1,
        runner_label: workflow.runnerLabel, environment_identity: preflight.expectedEnvironment,
        expires_at_epoch: 1200 })),
      reservation: { reservation_id: 'reservation-cleanup-pg', attempt_id: attemptId,
        project_ref: database.projectRef, branch_id: database.branchId,
        stripe_account_id: 'acct_synthetic123', policy_version: 1,
        quota_limits: retentionPolicy.quotas, projection: {
          attempts: 1, databaseRows: 10, authUsers: 1, stripeObjects: 10,
        }, capacity_snapshot: {}, created_at_epoch: 1000 },
      receipt: null,
    };
    const transactions = [];
    let resourceDeletes = 0;
    const client = { async transaction(fn) {
      const before = structuredClone(state);
      const transactionCalls = [];
      transactions.push(transactionCalls);
      try {
        return await fn({ async query(sql, values = []) {
          const call = { sql, values };
          transactionCalls.push(call);
          if (/SELECT extract\(epoch FROM clock_timestamp\(\)\) AS now/.test(sql)) {
            return { rows: [{ now: 1100 }] };
          }
          if (sql.startsWith('SELECT') && sql.includes('FROM billing_validation_control.attempts')) {
            return { rows: [state.attempt] };
          }
          if (sql.startsWith('SELECT') && sql.includes('FROM billing_validation_control.resource_locks')) {
            return { rows: state.resources };
          }
          if (sql.startsWith('SELECT') && sql.includes('FROM billing_validation_control.fixture_leases')) {
            return { rows: state.lease ? [state.lease] : [] };
          }
          if (sql.includes('SELECT EXISTS') && sql.includes('billing_validation_control.stripe_intents')) {
            return { rows: [{ in_flight: false }] };
          }
          if (sql.startsWith('SELECT') && sql.includes('FROM billing_validation_control.retention_reservations')) {
            return { rows: [state.reservation] };
          }
          if (sql.startsWith('SELECT') && sql.includes('FROM billing_validation_control.cleanup_receipts')) {
            return { rows: state.receipt ? [state.receipt] : [] };
          }
          if (sql.startsWith('INSERT INTO billing_validation_control.cleanup_receipts')) {
            if (failure === 'receipt-insert') {
              throw Object.assign(new Error('simulated_receipt_insert_failure'), {
                code: 'simulated_receipt_insert_failure',
              });
            }
            state.receipt = { receipt_id: values[0], reservation_id: values[1], attempt_id: values[2],
              project_ref: values[3], branch_id: values[4], deployment_id: values[5],
              deployment_origin: values[6], stripe_account_id: values[7], owner_fence: values[8],
              cleanup_digest: values[9], verified_projection: JSON.parse(values[10]), created_at_epoch: values[11] };
            return { rows: [], rowCount: 1 };
          }
          if (sql.startsWith('INSERT INTO billing_validation_control.attempts')) {
            state.attempt = { ...state.attempt, state: values[14], cleanup_status: values[15],
              updated_at_epoch: values[21] };
            return { rows: [], rowCount: 1 };
          }
          if (sql.startsWith('DELETE FROM billing_validation_control.fixture_leases')) {
            state.lease = null;
            return { rows: [], rowCount: 1 };
          }
          if (sql.startsWith('DELETE FROM billing_validation_control.resource_locks')) {
            resourceDeletes++;
            if (failure === 'resource-release' && resourceDeletes === 2) {
              throw Object.assign(new Error('simulated_resource_release_failure'), {
                code: 'simulated_resource_release_failure',
              });
            }
            state.resources = state.resources.filter((resource) =>
              resource.resource_type !== values[0] || resource.resource_id !== values[1]);
            return { rows: [], rowCount: 1 };
          }
          return { rows: [], rowCount: 1 };
        } });
      } catch (error) {
        Object.assign(state, before);
        throw error;
      }
    } };
    const store = createPostgresAttemptStore({ client, preflight, target, verifyCleanup: async () => true });
    return { state, store, transactions };
  }

  const successful = makeFixture();
  const result = await successful.store.cleanup({ attemptId, fence, projection: verifiedProjection });
  const receipt = successful.state.receipt;
  assert.ok(receipt);
  assert.equal(receipt.reservation_id, 'reservation-cleanup-pg');
  assert.equal(receipt.attempt_id, attemptId);
  assert.equal(receipt.owner_fence, fence);
  assert.deepEqual(receipt.verified_projection, verifiedProjection);
  assert.equal(result.cleanupReceipt.digest, receipt.cleanup_digest);
  const calls = successful.transactions[0];
  const index = (pattern) => calls.findIndex(({ sql }) => pattern.test(sql));
  const receiptInsert = index(/^INSERT INTO billing_validation_control\.cleanup_receipts/);
  const attemptWrite = index(/^INSERT INTO billing_validation_control\.attempts/);
  const leaseDelete = index(/^DELETE FROM billing_validation_control\.fixture_leases/);
  const resourceDelete = index(/^DELETE FROM billing_validation_control\.resource_locks/);
  assert.ok(receiptInsert >= 0 && receiptInsert < attemptWrite && attemptWrite < leaseDelete && leaseDelete < resourceDelete);
  assert.equal(successful.state.attempt.cleanup_status, 'complete');
  assert.equal(successful.state.lease, null);
  assert.equal(successful.state.resources.length, 0);

  for (const failure of ['receipt-insert', 'resource-release']) {
    const failed = makeFixture(failure);
    await assert.rejects(failed.store.cleanup({ attemptId, fence, projection: verifiedProjection }), {
      code: failure === 'receipt-insert'
        ? 'simulated_receipt_insert_failure' : 'simulated_resource_release_failure',
    });
    assert.equal(failed.state.receipt, null);
    assert.equal(failed.state.attempt.cleanup_status, 'pending');
    assert.equal(failed.state.lease.fence, fence);
    assert.equal(failed.state.resources.length, 2);
    assert.equal(failed.state.reservation.reservation_id, 'reservation-cleanup-pg');
  }
});

test('PostgreSQL recovery handoff rotates fences and keeps fixture mutation and cleanup behind recovery checks', async () => {
  const calls = [];
  const transactions = [];
  const attemptId = 'attempt-recovery-pg';
  const oldFence = '11111111-1111-4111-8111-111111111111';
  const workflow = { repository: 'lawxcompany-stack/billing-validation-control',
    ref: 'refs/heads/main', runId: '100', runAttempt: 1,
    runnerLabel: 'billing-validation-' + 'a'.repeat(32) };
  const attempt = { attempt_id: attemptId, branch_id: database.branchId, suite: 'billing',
    fixture_key: 'invoice-recovery', candidate_sha: 'a'.repeat(40),
    workflow_repository: workflow.repository, workflow_ref: workflow.ref,
    workflow_run_id: workflow.runId, workflow_run_attempt: workflow.runAttempt,
    runner_label: workflow.runnerLabel, database_project_ref: database.projectRef,
    deployment_id: 'dpl_candidate123', deployment_origin: 'https://candidate.vercel.app',
    stripe_account_id: 'acct_synthetic123', state: 'cancelled', cleanup_status: 'pending',
    artifact_id: null, artifact_digest: null, artifact_schema: null, resource_ids: [],
    created_at_epoch: 1000, updated_at_epoch: 1000 };
  const intent = { intent_id: 'intent-recovery-pg', attempt_id: attemptId, owner_fence: oldFence,
    account_id: 'acct_synthetic123', candidate_sha: 'a'.repeat(40),
    workflow_repository: workflow.repository, workflow_ref: workflow.ref,
    workflow_run_id: workflow.runId, workflow_run_attempt: workflow.runAttempt,
    runner_label: workflow.runnerLabel, environment_identity: preflight.expectedEnvironment,
    action: 'checkout.replay', operation: 'checkout:create:recovery-pg',
    request_digest: 'd'.repeat(64),
    idempotency_key: providerIdempotencyKey(attemptId, 'stripe', 'checkout:create:recovery-pg'),
    state: 'in_flight', created_at_epoch: 1000 };
  const reservation = { reservation_id: 'reservation-recovery-pg', attempt_id: attemptId,
    project_ref: database.projectRef, branch_id: database.branchId, stripe_account_id: 'acct_synthetic123',
    policy_version: 1, quota_limits: retentionPolicy.quotas, projection, capacity_snapshot: {},
    created_at_epoch: 1000 };
  let leaseFence = oldFence;
  let leaseExpiry = 1060;
  let leaseRecoveryOnly = false;
  let leaseExists = true;
  let pendingIntentsVisible = false;
  let stripeReceipt = null;
  let cleanupReceipt = null;
  let leaseOwner = { owner_repository: workflow.repository, owner_ref: workflow.ref,
    owner_run_id: workflow.runId, owner_run_attempt: workflow.runAttempt };
  const resources = [
    { resource_type: 'supabase_branch', resource_id: `${database.projectRef}:${database.branchId}` },
    { resource_type: 'stripe_account', resource_id: 'acct_synthetic123' },
  ].map((resource) => ({ ...resource, owner_attempt_id: attemptId, fence: oldFence,
    candidate_sha: 'a'.repeat(40), workflow_repository: workflow.repository,
    workflow_ref: workflow.ref, workflow_run_id: workflow.runId, workflow_run_attempt: 1,
    runner_label: workflow.runnerLabel, environment_identity: preflight.expectedEnvironment,
    expires_at_epoch: 1060 }));

  const client = { async transaction(fn) {
    const transactionCalls = [];
    transactions.push(transactionCalls);
    return fn({ async query(sql, values = []) {
      const call = { sql, values };
      calls.push(call);
      transactionCalls.push(call);
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
      if (/SELECT extract\(epoch FROM clock_timestamp\(\)\) AS now/.test(sql)) {
        return { rows: [{ now: 1100 }] };
      }
      if (sql.includes('SELECT EXISTS') && sql.includes('billing_validation_control.stripe_intents')) {
        return { rows: [{ in_flight: !stripeReceipt }] };
      }
      if (sql.startsWith('SELECT') && sql.includes('FROM billing_validation_control.attempts')) {
        return { rows: [attempt] };
      }
      if (sql.includes('FROM billing_validation_control.resource_locks')) {
        return { rows: resources };
      }
      if (sql.startsWith('SELECT') && sql.includes('FROM billing_validation_control.fixture_leases')) {
        return { rows: leaseExists ? [{ attempt_id: attemptId, fence: leaseFence,
          expires_at_epoch: leaseExpiry, recovery_only: leaseRecoveryOnly,
          owner_candidate_sha: 'a'.repeat(40), ...leaseOwner }] : [] };
      }
      if (sql.includes('FROM billing_validation_control.stripe_intents AS intent')) {
        return { rows: pendingIntentsVisible && !stripeReceipt ? [intent] : [] };
      }
      if (sql.includes('FROM billing_validation_control.stripe_intents') &&
          sql.includes('AND operation = $2')) {
        return { rows: values[1] === intent.operation ? [intent] : [] };
      }
      if (sql.includes('FROM billing_validation_control.stripe_intents')) return { rows: [intent] };
      if (sql.includes('FROM billing_validation_control.stripe_receipts')) {
        return { rows: stripeReceipt ? [stripeReceipt] : [] };
      }
      if (sql.includes('FROM billing_validation_control.cleanup_receipts')) {
        return { rows: cleanupReceipt ? [cleanupReceipt] : [] };
      }
      if (sql.includes('FROM billing_validation_control.retention_reservations')) {
        return { rows: [reservation] };
      }
      if (sql.includes('FROM billing_validation_control.retention_receipts')) return { rows: [] };
      if (sql.startsWith('INSERT INTO billing_validation_control.fixture_leases')) {
        leaseExists = true;
        leaseFence = values[4];
        leaseExpiry = values[5];
        leaseRecoveryOnly = values[12] === true;
        leaseOwner = { owner_repository: values[8], owner_ref: values[9],
          owner_run_id: values[10], owner_run_attempt: values[11] };
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE billing_validation_control.resource_locks')) {
        const resource = resources.find((item) => item.resource_type === values[0] &&
          item.resource_id === values[1]);
        if (resource) {
          Object.assign(resource, { owner_attempt_id: values[2], fence: values[3],
            candidate_sha: values[4], workflow_repository: values[5], workflow_ref: values[6],
            workflow_run_id: values[7], workflow_run_attempt: values[8], runner_label: values[9],
            environment_identity: JSON.parse(values[10]), expires_at_epoch: values[11] });
        }
        return { rows: [], rowCount: resource ? 1 : 0 };
      }
      if (sql.startsWith('INSERT INTO billing_validation_control.attempts')) {
        attempt.state = values[14];
        attempt.cleanup_status = values[15];
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('INSERT INTO billing_validation_control.stripe_receipts')) {
        stripeReceipt = { receipt_id: values[0], intent_id: values[1], attempt_id: values[2],
          owner_fence: values[3], account_id: values[4], operation: values[5],
          request_digest: values[6], idempotency_key: values[7], observation_digest: values[8],
          resource_ids: JSON.parse(values[9]), observed_at_epoch: values[10] };
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('DELETE FROM billing_validation_control.fixture_leases')) {
        leaseExists = false;
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('DELETE FROM billing_validation_control.resource_locks')) {
        const index = resources.findIndex((resource) => resource.owner_attempt_id === values[2] &&
          resource.fence === values[3]);
        if (index !== -1) resources.splice(index, 1);
        return { rows: [], rowCount: index === -1 ? 0 : 1 };
      }
      if (/^(?:DELETE|UPDATE|TRUNCATE)\b/i.test(sql)) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    } });
  } };
  const recoveryEvidence = [];
  const firstRecoveryRun = { ...workflow, runId: '200', runAttempt: 1 };
  const secondRecoveryRun = { ...workflow, runId: '300', runAttempt: 1 };
  const thirdRecoveryRun = { ...workflow, runId: '400', runAttempt: 1 };
  let currentRecoveryRun = firstRecoveryRun;
  const provenOwnerRunIds = new Set(['100', '200']);
  let cleanupVerifierCalls = 0;
  const store = createPostgresAttemptStore({ client, preflight, target,
    verifyRecovery: async (input) => {
      recoveryEvidence.push(input);
      const proof = provenOwnerRunIds.has(input.ownerRun?.runId);
      return { runTerminal: proof, runnerRemoved: proof, currentRun: currentRecoveryRun };
    },
    verifyCleanup: async () => { cleanupVerifierCalls++; return false; },
    verifyProviderObservation: async () => true,
  });

  await assert.rejects(store.handoffStripeIntentRecovery({ attemptId, fence: oldFence }), {
    code: 'recovery_unverified',
  });
  assert.equal(recoveryEvidence.length, 0);
  pendingIntentsVisible = true;
  const recovery = await store.handoffStripeIntentRecovery({ attemptId, fence: oldFence, ttlSeconds: 60 });
  assert.notEqual(recovery.fence, oldFence);
  assert.equal(recovery.state, 'rechecking');
  assert.equal(recovery.cleanupStatus, 'pending');
  assert.equal(leaseFence, recovery.fence);
  assert.equal(leaseOwner.owner_run_id, '200');
  assert.ok(resources.every((resource) => resource.fence === recovery.fence &&
    resource.workflow_run_id === '200'));
  assert.equal(recoveryEvidence[0].mode, 'stripe-intent-recovery');
  assert.deepEqual(recoveryEvidence[0].pendingIntents.map(({ intentId }) => intentId), ['intent-recovery-pg']);
  assert.equal(recoveryEvidence[0].ownerRun.runId, '100');

  currentRecoveryRun = secondRecoveryRun;
  const secondRecovery = await store.handoffStripeIntentRecovery({ attemptId,
    fence: recovery.fence, ttlSeconds: 60 });
  assert.notEqual(secondRecovery.fence, recovery.fence);
  assert.equal(leaseOwner.owner_run_id, '300');
  assert.ok(resources.every((resource) => resource.fence === secondRecovery.fence &&
    resource.workflow_run_id === '300'));
  assert.equal(recoveryEvidence[1].ownerRun.runId, '200');
  assert.equal(recoveryEvidence[1].lease.ownerRunId, '200');

  const lockedResources = structuredClone(resources);
  provenOwnerRunIds.add('300');
  currentRecoveryRun = undefined;
  await assert.rejects(store.handoffStripeIntentRecovery({ attemptId,
    fence: secondRecovery.fence, runTerminal: true, runnerRemoved: true }), {
    code: 'recovery_unverified',
  });
  provenOwnerRunIds.delete('300');
  currentRecoveryRun = { ...workflow, runId: '400', runAttempt: 1 };
  await assert.rejects(store.handoffStripeIntentRecovery({ attemptId,
    fence: secondRecovery.fence, runTerminal: true, runnerRemoved: true }), {
    code: 'recovery_unverified',
  });
  assert.equal(leaseFence, secondRecovery.fence);
  assert.equal(leaseOwner.owner_run_id, '300');
  assert.deepEqual(resources, lockedResources);
  assert.equal(attempt.state, 'rechecking');

  assert.deepEqual((await store.listPendingStripeIntents({ attemptId,
    fence: secondRecovery.fence })).map(({ intentId }) => intentId), ['intent-recovery-pg']);
  const observation = { accountId: 'acct_synthetic123', livemode: false,
    operation: intent.operation, requestDigest: intent.request_digest,
    idempotencyKey: intent.idempotency_key, resourceIds: ['cs_synthetic123'] };
  const reconciliationReceipt = await store.reconcileStripeIntent({ attemptId,
    fence: secondRecovery.fence, intentId: intent.intent_id, observation });
  assert.equal(stripeReceipt.receipt_id, reconciliationReceipt.receiptId);
  currentRecoveryRun = thirdRecoveryRun;
  await assert.rejects(store.handoffStripeIntentRecovery({ attemptId,
    fence: secondRecovery.fence }), { code: 'recovery_unverified' });
  provenOwnerRunIds.add('300');
  currentRecoveryRun = secondRecoveryRun;
  await assert.rejects(store.handoffStripeIntentRecovery({ attemptId,
    fence: secondRecovery.fence }), { code: 'recovery_unverified' });
  cleanupReceipt = { receipt_id: 'receipt-existing', reservation_id: reservation.reservation_id,
    attempt_id: attemptId, project_ref: database.projectRef, branch_id: database.branchId,
    deployment_id: attempt.deployment_id, deployment_origin: attempt.deployment_origin,
    stripe_account_id: 'acct_synthetic123', owner_fence: secondRecovery.fence,
    cleanup_digest: 'd'.repeat(64), verified_projection: cleanupProjection,
    created_at_epoch: 1100 };
  currentRecoveryRun = thirdRecoveryRun;
  await assert.rejects(store.handoffStripeIntentRecovery({ attemptId,
    fence: secondRecovery.fence }), { code: 'recovery_unverified' });
  cleanupReceipt = null;
  assert.equal(leaseFence, secondRecovery.fence);
  assert.equal(leaseOwner.owner_run_id, '300');
  provenOwnerRunIds.add('300');
  const thirdRecovery = await store.handoffStripeIntentRecovery({ attemptId,
    fence: secondRecovery.fence, ttlSeconds: 60 });
  assert.notEqual(thirdRecovery.fence, secondRecovery.fence);
  assert.equal(leaseOwner.owner_run_id, '400');
  assert.equal(leaseRecoveryOnly, true);
  assert.ok(resources.every((resource) => resource.fence === thirdRecovery.fence &&
    resource.workflow_run_id === '400'));
  const finalRecoveryEvidence = recoveryEvidence.at(-1);
  assert.equal(finalRecoveryEvidence.ownerRun.runId, '300');
  assert.deepEqual(finalRecoveryEvidence.pendingIntents, []);
  assert.equal((await store.listPendingStripeIntents({ attemptId,
    fence: thirdRecovery.fence })).length, 0);

  const handoffWrite = /^(?:INSERT INTO billing_validation_control\.fixture_leases|UPDATE billing_validation_control\.resource_locks|INSERT INTO billing_validation_control\.attempts)/;
  const handoffWrites = transactions.flat().filter(({ sql }) => handoffWrite.test(sql));
  assert.equal(handoffWrites.length, 12);
  assert.equal(transactions.filter((items) => items.some(({ sql }) => handoffWrite.test(sql))).length, 3);
  const leaseWrite = handoffWrites.find(({ sql }) => sql.startsWith('INSERT INTO billing_validation_control.fixture_leases'));
  assert.equal(leaseWrite.values[4], recovery.fence);
  assert.equal(leaseWrite.values[6], oldFence);
  assert.equal(leaseWrite.values[10], '200');
  const secondLeaseWrite = handoffWrites.filter(({ sql }) => sql.startsWith('INSERT INTO billing_validation_control.fixture_leases'))[1];
  assert.equal(secondLeaseWrite.values[4], secondRecovery.fence);
  assert.equal(secondLeaseWrite.values[6], recovery.fence);
  assert.equal(secondLeaseWrite.values[10], '300');
  const thirdLeaseWrite = handoffWrites.filter(({ sql }) => sql.startsWith('INSERT INTO billing_validation_control.fixture_leases'))[2];
  assert.equal(thirdLeaseWrite.values[4], thirdRecovery.fence);
  assert.equal(thirdLeaseWrite.values[6], secondRecovery.fence);
  assert.equal(thirdLeaseWrite.values[10], '400');
  assert.equal(thirdLeaseWrite.values[12], true);
  assert.ok(thirdLeaseWrite.sql.includes('recovery_only'));
  assert.ok(leaseWrite.sql.includes('WHERE billing_validation_control.fixture_leases.fence = $7::uuid'));
  const resourceWrites = handoffWrites.filter(({ sql }) =>
    sql.startsWith('UPDATE billing_validation_control.resource_locks'));
  assert.equal(resourceWrites.length, 6);
  assert.ok(resourceWrites.slice(0, 2).every(({ sql, values }) =>
    sql.includes('owner_attempt_id = $13') && sql.includes('fence = $14::uuid') &&
    values[12] === attemptId && values[13] === oldFence));
  assert.ok(resourceWrites.slice(2, 4).every(({ values }) => values[13] === recovery.fence));
  assert.ok(resourceWrites.slice(4).every(({ values }) => values[13] === secondRecovery.fence));
  const pendingQuery = calls.find(({ sql }) => sql.includes('FROM billing_validation_control.stripe_intents AS intent'));
  assert.ok(pendingQuery.sql.includes('NOT EXISTS'));
  assert.ok(pendingQuery.sql.includes('FOR UPDATE OF intent'));

  await assert.rejects(store.listPendingStripeIntents({ attemptId, fence: oldFence }),
    { code: 'lease_fence_lost' });
  await assert.rejects(store.listPendingStripeIntents({ attemptId, fence: recovery.fence }),
    { code: 'lease_fence_lost' });
  let fixtureMutationCalls = 0;
  await assert.rejects(store.fixtureMutation({ attemptId, fence: thirdRecovery.fence }, async () => {
    fixtureMutationCalls++;
  }), { code: 'recovery_read_only' });
  await assert.rejects(store.fixtureMutation({ attemptId, fence: oldFence }, async () => {
    fixtureMutationCalls++;
  }), { code: 'lease_fence_lost' });
  assert.equal(fixtureMutationCalls, 0);

  await store.transition({ attemptId, fence: thirdRecovery.fence, from: 'rechecking', to: 'complete' });
  let providerDispatches = 0;
  const terminalResults = await Promise.allSettled([
    store.fixtureMutation({ attemptId, fence: thirdRecovery.fence }, async () => {
      fixtureMutationCalls++;
    }),
    runStripeMutation({ attempts: store, owner: { attemptId, fence: thirdRecovery.fence,
      candidateSha: 'a'.repeat(40), workflow, environment: preflight.expectedEnvironment,
      webhookEndpointId: preflight.providerVerification.stripe.webhookEndpointId },
    action: 'checkout.replay', operation: 'checkout:create:terminal-pg', input: {},
    idempotencyKey: providerIdempotencyKey(attemptId, 'stripe', 'checkout:create:terminal-pg'),
    adapter: { mutate: async () => { providerDispatches++; } },
    readers: { expectedEnvironment: preflight.expectedEnvironment,
      expectedWebhookEndpointId: preflight.providerVerification.stripe.webhookEndpointId,
      async assertReady() { return true; } }, readerBinding: { attemptId, caseId: 'payment.approved',
      startedAt: '2026-09-23T09:00:00.000Z' } }),
  ]);
  assert.deepEqual(terminalResults.map((result) => result.status), ['rejected', 'rejected']);
  assert.deepEqual(terminalResults.map((result) => result.reason.code),
    ['recovery_read_only', 'recovery_read_only']);
  assert.equal(providerDispatches, 0);
  assert.equal(calls.filter(({ sql }) => sql.startsWith('INSERT INTO billing_validation_control.stripe_intents')).length, 0);
  assert.equal(fixtureMutationCalls, 0);
  await assert.rejects(store.cleanup({ attemptId, fence: oldFence, projection: cleanupProjection }), { code: 'lease_fence_lost' });
  await assert.rejects(store.cleanup({ attemptId, fence: secondRecovery.fence, projection: cleanupProjection }), {
    code: 'lease_fence_lost',
  });
  await assert.rejects(store.cleanup({ attemptId, fence: thirdRecovery.fence, projection: cleanupProjection }), {
    code: 'cleanup_unverified',
  });
  assert.equal(cleanupVerifierCalls, 1);
  assert.equal(calls.some(({ sql }) => sql.startsWith('DELETE FROM billing_validation_control.fixture_leases') ||
    sql.startsWith('DELETE FROM billing_validation_control.resource_locks')), false);
});

test('PostgreSQL recovery-only authority survives handoff and renewal after a terminal transition', async () => {
  const calls = [];
  const attemptId = 'attempt-recovery-terminal-pg';
  const oldFence = '22222222-2222-4222-8222-222222222222';
  const workflow = { repository: 'lawxcompany-stack/billing-validation-control', ref: 'refs/heads/main',
    runId: '100', runAttempt: 1, runnerLabel: 'billing-validation-' + 'b'.repeat(32) };
  const attempt = { attempt_id: attemptId, branch_id: database.branchId, suite: 'billing',
    fixture_key: 'invoice-terminal-recovery', candidate_sha: 'a'.repeat(40),
    workflow_repository: workflow.repository, workflow_ref: workflow.ref,
    workflow_run_id: workflow.runId, workflow_run_attempt: workflow.runAttempt,
    runner_label: workflow.runnerLabel, database_project_ref: database.projectRef,
    deployment_id: 'dpl_candidate123', deployment_origin: 'https://candidate.vercel.app',
    stripe_account_id: 'acct_synthetic123', state: 'cancelled', cleanup_status: 'pending',
    artifact_id: null, artifact_digest: null, artifact_schema: null, resource_ids: [],
    created_at_epoch: 1000, updated_at_epoch: 1000 };
  const intent = { intent_id: 'intent-terminal-recovery-pg', attempt_id: attemptId,
    owner_fence: oldFence, account_id: 'acct_synthetic123', candidate_sha: 'a'.repeat(40),
    workflow_repository: workflow.repository, workflow_ref: workflow.ref, workflow_run_id: workflow.runId,
    workflow_run_attempt: workflow.runAttempt, runner_label: workflow.runnerLabel,
    environment_identity: preflight.expectedEnvironment, action: 'checkout.replay',
    operation: 'checkout:create:terminal-existing-pg', request_digest: 'c'.repeat(64),
    idempotency_key: providerIdempotencyKey(attemptId, 'stripe', 'checkout:create:terminal-existing-pg'),
    state: 'in_flight', created_at_epoch: 1000 };
  const reservation = { reservation_id: 'reservation-terminal-recovery-pg', attempt_id: attemptId,
    project_ref: database.projectRef, branch_id: database.branchId, stripe_account_id: 'acct_synthetic123',
    policy_version: 1, quota_limits: retentionPolicy.quotas, projection, capacity_snapshot: {},
    created_at_epoch: 1000 };
  let fence = oldFence;
  let expiry = 1200;
  let recoveryOnly = false;
  let ownerRunId = '100';
  let fixtureWrites = 0;
  let providerDispatches = 0;
  let stripeIntentInserts = 0;
  const resources = [
    { resource_type: 'supabase_branch', resource_id: `${database.projectRef}:${database.branchId}` },
    { resource_type: 'stripe_account', resource_id: 'acct_synthetic123' },
  ].map((resource) => ({ ...resource, owner_attempt_id: attemptId, fence: oldFence,
    candidate_sha: 'a'.repeat(40), workflow_repository: workflow.repository,
    workflow_ref: workflow.ref, workflow_run_id: workflow.runId, workflow_run_attempt: 1,
    runner_label: workflow.runnerLabel, environment_identity: preflight.expectedEnvironment,
    expires_at_epoch: expiry }));
  const client = { async transaction(fn) {
    return fn({ async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
      if (/SELECT extract\(epoch FROM clock_timestamp\(\)\) AS now/.test(sql)) {
        return { rows: [{ now: 1100 }] };
      }
      if (sql.startsWith('SELECT') && sql.includes('FROM billing_validation_control.attempts')) {
        return { rows: [attempt] };
      }
      if (sql.includes('FROM billing_validation_control.resource_locks')) return { rows: resources };
      if (sql.startsWith('SELECT') && sql.includes('FROM billing_validation_control.fixture_leases')) {
        return { rows: [{ attempt_id: attemptId, fence, expires_at_epoch: expiry,
          recovery_only: recoveryOnly, owner_candidate_sha: 'a'.repeat(40),
          owner_repository: workflow.repository, owner_ref: workflow.ref,
          owner_run_id: ownerRunId, owner_run_attempt: 1 }] };
      }
      if (sql.includes('FROM billing_validation_control.stripe_intents AS intent')) return { rows: [intent] };
      if (sql.includes('FROM billing_validation_control.stripe_intents') && sql.includes('AND operation = $2')) {
        return { rows: [] };
      }
      if (sql.includes('FROM billing_validation_control.retention_reservations')) return { rows: [reservation] };
      if (sql.includes('FROM billing_validation_control.retention_receipts')) return { rows: [] };
      if (sql.startsWith('INSERT INTO billing_validation_control.fixture_leases')) {
        fence = values[4];
        expiry = values[5];
        ownerRunId = values[10];
        recoveryOnly = values[12] === true;
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE billing_validation_control.resource_locks')) {
        const resource = resources.find((item) => item.resource_type === values[0] &&
          item.resource_id === values[1]);
        if (resource) Object.assign(resource, { fence: values[3], workflow_run_id: values[7],
          expires_at_epoch: values[11] });
        return { rows: [], rowCount: resource ? 1 : 0 };
      }
      if (sql.startsWith('INSERT INTO billing_validation_control.attempts')) {
        attempt.state = values[14];
        attempt.cleanup_status = values[15];
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('INSERT INTO billing_validation_control.stripe_intents')) {
        stripeIntentInserts++;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    } });
  } };
  let currentRecoveryRun = { ...workflow, runId: '200' };
  const store = createPostgresAttemptStore({ client, preflight, target,
    verifyRecovery: async ({ ownerRun }) => ({ runTerminal: true, runnerRemoved: true,
      currentRun: ownerRun.runId === '100' ? currentRecoveryRun : { ...workflow, runId: '300' } }),
  });

  const first = await store.handoffStripeIntentRecovery({ attemptId, fence: oldFence });
  await store.renew({ attemptId, fence: first.fence, ttlSeconds: 90 });
  currentRecoveryRun = { ...workflow, runId: '300' };
  const latest = await store.handoffStripeIntentRecovery({ attemptId, fence: first.fence });
  await store.transition({ attemptId, fence: latest.fence, from: 'rechecking', to: 'complete' });
  const owner = { attemptId, fence: latest.fence, candidateSha: 'a'.repeat(40),
    workflow, environment: preflight.expectedEnvironment,
    webhookEndpointId: preflight.providerVerification.stripe.webhookEndpointId };
  const terminal = await Promise.allSettled([
    store.fixtureMutation(owner, async () => { fixtureWrites++; }),
    runStripeMutation({ attempts: store, owner, action: 'checkout.replay',
      operation: 'checkout:create:blocked-terminal-pg', input: {},
      idempotencyKey: providerIdempotencyKey(attemptId, 'stripe', 'checkout:create:blocked-terminal-pg'),
      adapter: { mutate: async () => { providerDispatches++; } },
      readers: { expectedEnvironment: preflight.expectedEnvironment,
        expectedWebhookEndpointId: preflight.providerVerification.stripe.webhookEndpointId,
        async assertReady() { return true; } }, readerBinding: { attemptId, caseId: 'payment.approved',
        startedAt: '2026-09-23T09:00:00.000Z' } }),
  ]);

  assert.deepEqual(terminal.map((result) => result.status), ['rejected', 'rejected']);
  assert.deepEqual(terminal.map((result) => result.reason.code),
    ['recovery_read_only', 'recovery_read_only']);
  assert.equal(fixtureWrites, 0);
  assert.equal(providerDispatches, 0);
  assert.equal(stripeIntentInserts, 0);
  assert.equal(recoveryOnly, true);
  assert.ok(calls.some(({ sql }) => sql.includes('recovery_only')));
  assert.ok(calls.filter(({ sql }) => sql.startsWith('INSERT INTO billing_validation_control.fixture_leases'))
    .every(({ values }) => values[12] === true));
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
    } }, ttlSeconds: 60, retentionPolicy, projection }), { code: 'attempt_input_invalid' });
  assert.equal(client.calls.length, 0);
});

test('PostgreSQL admission locks and aggregates receipts plus unsettled reservations before inserting the new projection', async () => {
  const calls = [];
  const capacityRows = [
    { bucket: 'committed', quota_key: 'attempts', units: '1' },
    { bucket: 'reserved', quota_key: 'attempts', units: '2' },
    { bucket: 'committed', quota_key: 'databaseRows', units: '2' },
    { bucket: 'reserved', quota_key: 'databaseRows', units: '3' },
    { bucket: 'committed', quota_key: 'authUsers', units: '1' },
  ];
  const client = { async transaction(fn) {
    return fn({ async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes('retention_capacity_snapshot')) return { rows: capacityRows };
      if (/clock_timestamp/.test(sql) && /SELECT/.test(sql)) return { rows: [{ now: 1000 }] };
      return { rows: [], rowCount: 1 };
    } });
  } };
  const store = createPostgresAttemptStore({ client, preflight, target });
  const result = await store.prepare({ attemptId: 'attempt-a',
    key: { branchId: database.branchId, suite: 'billing', fixtureKey: 'invoice-a' },
    candidateSha: 'a'.repeat(40), workflow: { repository: 'lawxcompany-stack/billing-validation-control',
      ref: 'refs/heads/main', runId: '100', runAttempt: 1,
      runnerLabel: 'billing-validation-' + 'a'.repeat(32) },
    environment: preflight.expectedEnvironment, ttlSeconds: 60,
    retentionPolicy: { version: 1, quotas: { attempts: 10, databaseRows: 10, authUsers: 10, stripeObjects: 10 } },
    projection: { attempts: 1, databaseRows: 5, authUsers: 1, stripeObjects: 2 },
  });
  const lockIndex = calls.findIndex(({ sql, values }) => /pg_advisory_xact_lock/.test(sql) &&
    values?.[0]?.startsWith('["retention"'));
  const capacityIndex = calls.findIndex(({ sql }) => sql.includes('retention_capacity_snapshot'));
  const policyIndex = calls.findIndex(({ sql }) => sql.includes('retention_policy_pin'));
  const reservationIndex = calls.findIndex(({ sql }) => /INSERT INTO billing_validation_control\.retention_reservations/.test(sql));
  assert.ok(lockIndex >= 0 && capacityIndex > lockIndex && policyIndex > capacityIndex && reservationIndex > policyIndex);
  assert.match(calls[capacityIndex].sql, /billing_validation_control\.retention_receipts/);
  assert.match(calls[capacityIndex].sql, /billing_validation_control\.retention_reservations/);
  assert.match(calls[capacityIndex].sql, /NOT EXISTS/);
  assert.doesNotMatch(calls[capacityIndex].sql, /billing_validation_control\.attempts/);
  assert.match(calls[policyIndex].sql, /GROUP BY quota_limits/);
  assert.equal(result.capacity.projected.attempts, 4);
  assert.equal(result.capacity.projected.databaseRows, 10);
  assert.equal(result.capacity.projected.authUsers, 2);
});

test('PostgreSQL admission refuses projected overflow before persisting an attempt, reservation, or lease', async () => {
  const calls = [];
  const client = { async transaction(fn) {
    return fn({ async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes('retention_capacity_snapshot')) return { rows: [
        { bucket: 'committed', quota_key: 'databaseRows', units: '4' },
        { bucket: 'reserved', quota_key: 'databaseRows', units: '3' },
      ] };
      if (/clock_timestamp/.test(sql) && /SELECT/.test(sql)) return { rows: [{ now: 1000 }] };
      return { rows: [], rowCount: 1 };
    } });
  } };
  const store = createPostgresAttemptStore({ client, preflight, target });
  await assert.rejects(store.prepare({ attemptId: 'attempt-a',
    key: { branchId: database.branchId, suite: 'billing', fixtureKey: 'invoice-a' },
    candidateSha: 'a'.repeat(40), workflow: { repository: 'lawxcompany-stack/billing-validation-control',
      ref: 'refs/heads/main', runId: '100', runAttempt: 1,
      runnerLabel: 'billing-validation-' + 'a'.repeat(32) },
    environment: preflight.expectedEnvironment, ttlSeconds: 60,
    retentionPolicy: { version: 1, quotas: { attempts: 10, databaseRows: 10, authUsers: 10, stripeObjects: 10 } },
    projection: { attempts: 1, databaseRows: 4, authUsers: 1, stripeObjects: 2 },
  }), { code: 'retention_capacity_exceeded' });
  assert.equal(calls.some(({ sql }) => sql.includes('INSERT INTO billing_validation_control.attempts')), false);
  assert.equal(calls.some(({ sql }) => sql.includes('INSERT INTO billing_validation_control.retention_reservations')), false);
  assert.equal(calls.some(({ sql }) => sql.includes('INSERT INTO billing_validation_control.fixture_leases')), false);
});

test('PostgreSQL admission refuses decimal-formatted integer usage instead of counting it ambiguously', async () => {
  const calls = [];
  const client = { async transaction(fn) {
    return fn({ async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes('retention_capacity_snapshot')) return { rows: [
        { bucket: 'committed', quota_key: 'databaseRows', units: '2.0' },
      ] };
      if (/clock_timestamp/.test(sql) && /SELECT/.test(sql)) return { rows: [{ now: 1000 }] };
      return { rows: [], rowCount: 1 };
    } });
  } };
  const store = createPostgresAttemptStore({ client, preflight, target });
  await assert.rejects(store.prepare({ attemptId: 'attempt-a',
    key: { branchId: database.branchId, suite: 'billing', fixtureKey: 'invoice-a' },
    candidateSha: 'a'.repeat(40), workflow: { repository: 'lawxcompany-stack/billing-validation-control',
      ref: 'refs/heads/main', runId: '100', runAttempt: 1,
      runnerLabel: 'billing-validation-' + 'a'.repeat(32) },
    environment: preflight.expectedEnvironment, ttlSeconds: 60,
    retentionPolicy: { version: 1, quotas: { attempts: 10, databaseRows: 10, authUsers: 10, stripeObjects: 10 } },
    projection: { attempts: 1, databaseRows: 4, authUsers: 1, stripeObjects: 2 },
  }), { code: 'retention_ledger_invalid' });
  assert.equal(calls.some(({ sql }) => sql.includes('INSERT INTO billing_validation_control.attempts')), false);
  assert.equal(calls.some(({ sql }) => sql.includes('INSERT INTO billing_validation_control.retention_reservations')), false);
  assert.equal(calls.some(({ sql }) => sql.includes('INSERT INTO billing_validation_control.fixture_leases')), false);
});
