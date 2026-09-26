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
  migrationHistorySha256: 'b'.repeat(64) }, stripe: { accountId: 'acct_synthetic123',
  webhookEndpointId: 'we_synthetic123', webhookUrl: 'https://candidate.vercel.app/api/stripe/webhook',
  livemode: false } } };
const target = { ...database, isDefault: false, status: 'ACTIVE_HEALTHY', isolated: true };
const retentionPolicy = { version: 1, quotas: {
  attempts: 50, databaseRows: 500, authUsers: 50, stripeObjects: 500,
} };
const projection = { attempts: 1, databaseRows: 10, authUsers: 1, stripeObjects: 10 };

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
  assert.doesNotMatch(sql, /retention_reservations[\s\S]{0,500}expires_at/);
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
