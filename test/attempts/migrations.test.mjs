import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { applyAttemptMigrations, loadAttemptMigrationPlan, validateAppliedAttemptMigrations,
  validateAttemptMigrationAllowlist, validateMigrationSql } from '../../src/attempts/migrations.mjs';

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function approvedTarget() {
  const policy = { database: { kind: 'standalone', projectRef: 'abcdefghijklmnopqrst',
    organizationId: 'org_synthetic', organizationSlug: 'org-synthetic', region: 'sa-east-1',
    databaseVersion: '17.6.1.054', postgresEngine: 'postgres', releaseChannel: 'ga',
    connection: { mode: 'direct', host: 'db.abcdefghijklmnopqrst.supabase.co', port: 5432,
      database: 'postgres', role: 'billing_validation_writer' },
    schemaFingerprintSha256: 'a'.repeat(64), migrationHistorySha256: 'b'.repeat(64) } };
  const targetReadback = { projectRef: policy.database.projectRef, host: policy.database.connection.host,
    port: 5432, database: 'postgres', role: 'billing_validation_writer', databaseVersion: '17.6.1.054',
    isStandaloneProject: true, schemaFingerprintSha256: 'a'.repeat(64), migrationHistorySha256: 'b'.repeat(64) };
  const targetSha256 = createHash('sha256').update(canonical(targetReadback), 'utf8').digest('hex');
  return { policy, targetReadback, approval: { approvalId: 'CHG-2026-1001', approvedBy: 'reviewer@example.test',
    approvedAt: '2026-10-01T12:00:00.000Z', targetSha256 } };
}

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
    'TRUNCATE billing_validation_control.fixture_leases;',
    'RESET ROLE;',
    'CREATE SCHEMA IF NOT EXISTS billing_validation_control;',
    'CREATE DATABASE billing_validation_control;',
  ]) assert.throws(() => validateMigrationSql(sql), { code: 'migration_unsafe_sql' });
  assert.doesNotThrow(() => validateMigrationSql(
    'CREATE TABLE billing_validation_control.forward_only (id bigint PRIMARY KEY);'));
});

test('executor refuses until an exact configured standalone target and human approval are supplied', async () => {
  let transactions = 0;
  const client = { async transaction() { transactions += 1; } };
  await assert.rejects(applyAttemptMigrations({ client }), { code: 'migration_approval_required' });
  assert.equal(transactions, 0);
});

test('executor refuses to bootstrap when the pre-existing control schema is absent', async () => {
  const { policy, targetReadback, approval } = approvedTarget();
  const calls = [];
  const client = { async transaction(fn) {
    return fn({ async query(sql) {
      calls.push(sql);
      if (sql.includes('to_regclass')) return { rows: [{ ready: false, ledger_ready: false }] };
      return { rowCount: 1, rows: [] };
    } });
  } };
  await assert.rejects(applyAttemptMigrations({ client, policy, targetReadback, approval }),
    { code: 'migration_bootstrap_required' });
  assert.equal(calls.some((sql) => /CREATE\s+SCHEMA|schema\.sql/iu.test(sql)), false);
});

test('executor applies only the pinned forward migration after standalone readback and approval', async () => {
  const { policy, targetReadback, approval } = approvedTarget();
  const plan = await loadAttemptMigrationPlan();
  const calls = [];
  const client = { async transaction(fn) {
    return fn({ async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes('to_regclass')) return { rows: [{ ready: true, ledger_ready: false }] };
      if (sql.startsWith('INSERT INTO billing_validation_control.schema_migrations')) return { rowCount: 1 };
      return { rowCount: 1, rows: [] };
    } });
  } };
  const result = await applyAttemptMigrations({ client, policy, targetReadback, approval });
  assert.deepEqual(result.appliedVersions, [plan[0].version]);
  assert.equal(calls.some(({ sql }) => sql === plan[0].sql), true);
  assert.equal(calls.some(({ sql }) => /CREATE\s+SCHEMA|DROP\s+|DELETE\s+FROM|TRUNCATE\s/iu.test(sql) &&
    sql !== plan[0].sql), false);
  assert.equal(validateMigrationSql(plan[0].sql), true);
});
