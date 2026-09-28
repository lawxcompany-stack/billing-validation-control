import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createSupabaseBillingReader, verifySupabaseEnvironment } from '../../src/runtime/supabase.mjs';
import * as supabaseModule from '../../src/runtime/supabase.mjs';
import { environment as billingEnvironment } from '../billing/support.mjs';
import { policy } from './fixture.mjs';

const token = 'synthetic-read-token';
const branch = {
  id: policy.database.branchId,
  name: policy.database.branchName,
  project_ref: policy.database.projectRef,
  parent_project_ref: policy.database.parentProjectRef,
  is_default: false,
  status: 'ACTIVE_HEALTHY',
  preview_project_status: 'ACTIVE_HEALTHY',
};
const migrations = [
  { version: '202609230002', name: 'billing' },
  { version: '202609230001', name: 'init' },
];
const types = { types: 'export type Database = { public: true }\n' };

function fixture(replies = [branch, migrations, types]) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify(replies[calls.length - 1]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  };
}

test('verifies the exact healthy child branch and independent migration/types digests using only pinned read routes', async () => {
  const network = fixture();
  const result = await verifySupabaseEnvironment({ policy, token, fetchImpl: network.fetchImpl });
  assert.deepEqual(result, {
    projectRef: policy.database.projectRef,
    parentProjectRef: policy.database.parentProjectRef,
    branchId: policy.database.branchId,
    branchName: policy.database.branchName,
    schemaFingerprintSha256: policy.database.schemaFingerprintSha256,
    migrationHistorySha256: policy.database.migrationHistorySha256,
  });
  assert.deepEqual(network.calls.map(({ url }) => url), [
    `https://api.supabase.com/v1/projects/${policy.database.parentProjectRef}/branches/${policy.database.branchName}`,
    `https://api.supabase.com/v1/projects/${policy.database.projectRef}/database/migrations`,
    `https://api.supabase.com/v1/projects/${policy.database.projectRef}/types/typescript?included_schemas=public`,
  ]);
  for (const { options } of network.calls) {
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
  }
  assert.equal(JSON.stringify(result).includes(token), false);
});

test('rejects a production-labelled branch pin before any provider request', async () => {
  const network = fixture();
  await assert.rejects(verifySupabaseEnvironment({
    policy: { ...policy, database: { ...policy.database, branchId: 'main' } },
    token, fetchImpl: network.fetchImpl,
  }), { code: 'supabase_policy_invalid' });
  assert.equal(network.calls.length, 0);
});

test('exposes only the safe reader and append-only fixture factory; refuses equal refs without fetching', async () => {
  assert.deepEqual(Object.keys(supabaseModule).sort(), ['SupabaseRefusal', 'createSupabaseBillingReader',
    'createSupabaseFixturePublisher', 'verifySupabaseEnvironment']);
  assert.equal(Object.hasOwn(supabaseModule, 'mutateBillingData'), false);
  const network = fixture();
  await assert.rejects(verifySupabaseEnvironment({
    policy: { ...policy, database: { ...policy.database, parentProjectRef: policy.database.projectRef } },
    token, fetchImpl: network.fetchImpl,
  }), { code: 'supabase_policy_invalid' });
  assert.equal(network.calls.length, 0);
});

test('refuses every branch identity, default, and health mismatch before reading child project', async () => {
  const cases = [
    { id: 'wrong-branch' }, { name: 'wrong-name' }, { project_ref: policy.database.parentProjectRef },
    { parent_project_ref: policy.database.projectRef }, { is_default: true }, { status: 'INACTIVE' },
    { preview_project_status: 'INACTIVE' },
  ];
  for (const change of cases) {
    const network = fixture([{ ...branch, ...change }, migrations, types]);
    await assert.rejects(verifySupabaseEnvironment({ policy, token, fetchImpl: network.fetchImpl }), {
      code: 'supabase_branch_mismatch',
    });
    assert.equal(network.calls.length, 1);
  }
});

test('refuses malformed, duplicate, and drifted migration history before generated types', async () => {
  const cases = [
    { value: { data: migrations }, code: 'supabase_migrations_invalid' },
    { value: [{ version: '202609230001', name: 'init' }, { version: '202609230001', name: 'again' }], code: 'supabase_migrations_invalid' },
    { value: [{ version: 'not-a-version', name: 'init' }], code: 'supabase_migrations_invalid' },
    { value: [{ version: '202609230001', name: 'init', rollback: 'ignored' }], code: 'supabase_migrations_invalid' },
    { value: [{ version: '202609230003', name: 'drift' }], code: 'supabase_migrations_mismatch' },
  ];
  for (const { value, code } of cases) {
    const network = fixture([branch, value, types]);
    await assert.rejects(verifySupabaseEnvironment({ policy, token, fetchImpl: network.fetchImpl }), { code });
    assert.equal(network.calls.length, 2);
  }
});

test('rejects numeric migration versions and names even when their coerced values match the pinned digest', async () => {
  for (const entry of [
    { version: 202609230001, name: 'init' },
    { version: '202609230001', name: 123 },
  ]) {
    const digest = createHash('sha256').update(JSON.stringify([entry])).digest('hex');
    const network = fixture([branch, [entry], types]);
    await assert.rejects(verifySupabaseEnvironment({
      policy: { ...policy, database: { ...policy.database, migrationHistorySha256: digest } },
      token, fetchImpl: network.fetchImpl,
    }), { code: 'supabase_migrations_invalid' });
    assert.equal(network.calls.length, 2);
  }
});

test('refuses absent, empty, ambiguous, and drifted generated types without returning raw schema', async () => {
  const cases = [
    { value: {}, code: 'supabase_types_invalid' },
    { value: { types: '' }, code: 'supabase_types_invalid' },
    { value: { types: types.types, extra: true }, code: 'supabase_types_invalid' },
    { value: { types: 'export type Database = { public: false }\n' }, code: 'supabase_types_mismatch' },
  ];
  for (const { value, code } of cases) {
    const network = fixture([branch, migrations, value]);
    await assert.rejects(verifySupabaseEnvironment({ policy, token, fetchImpl: network.fetchImpl }), { code });
    assert.equal(network.calls.length, 3);
  }
});

test('bounds Supabase responses and sanitizes redirects, rate limits, timeouts, and malformed JSON', async () => {
  const cases = [
    async () => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.invalid' } }),
    async () => new Response('{}', { status: 429, headers: { 'Content-Type': 'application/json' } }),
    async () => { throw new Error(`network failed with ${token}`); },
    async () => new Response('{broken', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    async () => new Response(JSON.stringify({ pad: 'x'.repeat(256_000) }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  ];
  for (const fetchImpl of cases) {
    await assert.rejects(verifySupabaseEnvironment({ policy, token, fetchImpl }), (error) => {
      assert.match(error.code, /^supabase_(?:unavailable|response_invalid)$/u);
      assert.equal(JSON.stringify(error).includes(token), false);
      assert.equal(error.message.includes(token), false);
      return true;
    });
  }
});

test('refuses a successful-looking response after the request timeout signal aborts', async () => {
  const originalTimeout = AbortSignal.timeout;
  const controller = new AbortController();
  let timeoutMs;
  const network = fixture();
  AbortSignal.timeout = (milliseconds) => { timeoutMs = milliseconds; return controller.signal; };
  try {
    await assert.rejects(verifySupabaseEnvironment({
      policy, token,
      fetchImpl: async (url, options) => {
        assert.equal(options.signal, controller.signal);
        controller.abort(new DOMException('synthetic timeout', 'TimeoutError'));
        return network.fetchImpl(url, options);
      },
    }), { code: 'supabase_unavailable' });
    assert.equal(timeoutMs, 10_000);
    assert.equal(network.calls.length, 1);
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
});

test('rejects oversized migration and generated-types bodies at their own response boundaries', async () => {
  for (const target of ['migrations', 'types']) {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      let value = branch;
      if (url.endsWith('/database/migrations')) value = target === 'migrations' ? 'x'.repeat(512_000) : migrations;
      if (url.includes('/types/typescript?')) value = 'x'.repeat(4_000_000);
      return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    await assert.rejects(verifySupabaseEnvironment({ policy, token, fetchImpl }), { code: 'supabase_response_invalid' });
    assert.equal(calls.length, target === 'migrations' ? 2 : 3);
  }
});

test('Supabase SQL reader exposes only pinned read-only schema and concurrency reads', async () => {
  const target = {
    projectRef: billingEnvironment.database.projectRef,
    parentProjectRef: 'zyxwvutsrqponmlkjihg',
    branchId: billingEnvironment.database.branchId,
    branchName: 'billing-validation-child',
  };
  const assertionDigests = {
    checkout_rls: '1'.repeat(64),
    catalog_version_audit: '2'.repeat(64),
    usage_reservation_replay: '3'.repeat(64),
    legacy_plan_webhook_compatibility: '4'.repeat(64),
    settlement_lock_order: '5'.repeat(64),
    stale_completion_renewal_fencing: '6'.repeat(64),
  };
  const races = {
    coupon_capacity: { committedOwnerCount: 1, committedOwnerDigest: '7'.repeat(64), loserStateDigest: '8'.repeat(64) },
    checkout_payment_context_idempotency: { committedOwnerCount: 1, committedOwnerDigest: '9'.repeat(64), loserStateDigest: 'a'.repeat(64) },
    plan_change: { committedOwnerCount: 1, committedOwnerDigest: 'b'.repeat(64), loserStateDigest: 'c'.repeat(64) },
    adjustment: { committedOwnerCount: 1, committedOwnerDigest: 'd'.repeat(64), loserStateDigest: 'e'.repeat(64) },
  };
  const schemaState = {
    version: 1,
    readerId: 'sql-reader-a',
    ...target,
    isDefaultBranch: false,
    schemaFingerprintSha256: 'a'.repeat(64),
    migrationHistorySha256: 'b'.repeat(64),
    triggerDigestSha256: 'c'.repeat(64),
    aclDigestSha256: 'd'.repeat(64),
    privilegeDigestSha256: 'e'.repeat(64),
  };
  const concurrencyProof = (barrierId) => ({
    version: 1,
    readerId: 'sql-reader-a',
    ...target,
    barrierId,
    assertionDigests,
    races,
  });
  const sourceCalls = [];
  const source = {
    trustedReaderId: 'sql-reader-a',
    async readIdentity() {
      return { projectRef: billingEnvironment.database.projectRef,
        branchId: billingEnvironment.database.branchId, readOnly: true };
    },
    async readBillingSnapshot() { return {}; },
    async listAttemptFixtures() { return []; },
    async readSyntheticFixture() { return null; },
    async readWebhookInbox() { return null; },
    async readWebhookReceipts() { return []; },
    async readInstalledSchemaState(input) {
      sourceCalls.push({ method: 'schema', input });
      return schemaState;
    },
    async readConcurrencyProof(input) {
      sourceCalls.push({ method: 'barrier', input });
      return concurrencyProof(input.barrierId);
    },
  };
  const reader = createSupabaseBillingReader({ expectedEnvironment: billingEnvironment, source });

  assert.equal(reader.trustedReaderId, 'sql-reader-a');
  assert.equal(typeof reader.readInstalledSchemaState, 'function');
  assert.equal(typeof reader.readConcurrencyProof, 'function');
  assert.deepEqual(await reader.readInstalledSchemaState(target), schemaState);
  assert.deepEqual(await reader.readConcurrencyProof({ ...target, barrierId: 'billing-sql-barrier-a' }),
    concurrencyProof('billing-sql-barrier-a'));
  assert.deepEqual(sourceCalls.map(({ method }) => method), ['schema', 'barrier']);
  assert.deepEqual(sourceCalls[0].input, { ...target, readerId: 'sql-reader-a', readOnly: true });
  assert.deepEqual(sourceCalls[1].input, { ...target, readerId: 'sql-reader-a', readOnly: true,
    barrierId: 'billing-sql-barrier-a' });
  assert.equal(sourceCalls.some(({ input }) => Object.hasOwn(input, 'sql') ||
    Object.hasOwn(input, 'candidateSha') || Object.hasOwn(input, 'script')), false);
  await assert.rejects(reader.readInstalledSchemaState({ ...target, candidateSql: 'SELECT 1' }),
    { code: 'supabase_sql_reader_input_invalid' });
  await assert.rejects(reader.readConcurrencyProof({ ...target, barrierId: 'billing-sql-barrier-a',
    applyCandidateSql: true }), { code: 'supabase_sql_reader_input_invalid' });
  assert.equal(sourceCalls.length, 2);
});

test('missing trusted installed-schema or concurrency readers refuse without a generic query fallback', async () => {
  const source = {
    trustedReaderId: 'sql-reader-unavailable',
    async readIdentity() {
      return { projectRef: billingEnvironment.database.projectRef,
        branchId: billingEnvironment.database.branchId, readOnly: true };
    },
    async readBillingSnapshot() { return {}; },
    async listAttemptFixtures() { return []; },
    async readSyntheticFixture() { return null; },
    async readWebhookInbox() { return null; },
    async readWebhookReceipts() { return []; },
    async query() { throw new Error('generic query must not be used'); },
  };
  const reader = createSupabaseBillingReader({ expectedEnvironment: billingEnvironment, source });
  const target = { projectRef: billingEnvironment.database.projectRef,
    parentProjectRef: 'zyxwvutsrqponmlkjihg', branchId: billingEnvironment.database.branchId,
    branchName: 'billing-validation-child' };

  assert.equal(typeof reader.readInstalledSchemaState, 'function');
  assert.equal(typeof reader.readConcurrencyProof, 'function');
  await assert.rejects(reader.readInstalledSchemaState(target), { code: 'supabase_sql_reader_unavailable' });
  await assert.rejects(reader.readConcurrencyProof({ ...target, barrierId: 'billing-sql-barrier-a' }),
    { code: 'supabase_sql_reader_unavailable' });
});
