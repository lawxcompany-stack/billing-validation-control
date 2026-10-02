import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createSupabaseBillingReader, verifySupabaseEnvironment as verify } from '../../src/runtime/supabase.mjs';
import * as supabaseModule from '../../src/runtime/supabase.mjs';
import { environment as billingEnvironment } from '../billing/support.mjs';
import { policy } from './fixture.mjs';
import { organizationProjects, projectDetails, trustedConfiguration } from './standalone-fixture.mjs';

function verifySupabaseEnvironment(options) { return verify({ trustedConfiguration, ...options }); }

const token = 'synthetic-read-token';
const project = projectDetails;
const migrations = [
  { version: '202609230002', name: 'billing' },
  { version: '202609230001', name: 'init' },
];
const types = { types: 'export type Database = { public: true }\n' };

function fixture(replies = [project, migrations, types]) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const parsed = new URL(url);
      const value = parsed.pathname === `/v1/organizations/${policy.database.organizationSlug}/projects`
        ? organizationProjects
        : parsed.pathname.endsWith('/database/migrations') ? replies[1]
          : parsed.pathname.endsWith('/types/typescript') ? replies[2] : replies[0];
      return new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  };
}

test('verifies the exact healthy standalone project and independent migration/types digests using pinned read routes', async () => {
  const network = fixture();
  const result = await verifySupabaseEnvironment({ policy, token, fetchImpl: network.fetchImpl });
  assert.deepEqual(result, policy.database);
  assert.deepEqual(network.calls.map(({ url }) => url), [
    `https://api.supabase.com/v1/projects/${policy.database.projectRef}`,
    `https://api.supabase.com/v1/organizations/${policy.database.organizationSlug}/projects?limit=100&offset=0`,
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
    'assertSupabaseRuntimeConfiguration', 'createSupabaseFixturePublisher', 'verifySupabaseEnvironment'].sort());
  assert.equal(Object.hasOwn(supabaseModule, 'mutateBillingData'), false);
  const network = fixture();
  await assert.rejects(verifySupabaseEnvironment({
    policy: { ...policy, database: { ...policy.database, parentProjectRef: policy.database.projectRef } },
    token, fetchImpl: network.fetchImpl,
  }), { code: 'supabase_policy_invalid' });
  assert.equal(network.calls.length, 0);
});

test('refuses project, organization, region, branch and health mismatches before reading schema', async () => {
  const cases = [
    { ref: 'zyxwvutsrqponmlkjihg' }, { organization_id: 'another-org' }, { region: 'another-region' },
    { parent_project_ref: policy.database.projectRef }, { is_branch: true }, { status: 'INACTIVE' },
  ];
  for (const change of cases) {
    const network = fixture([{ ...project, ...change }, migrations, types]);
    await assert.rejects(verifySupabaseEnvironment({ policy, token, fetchImpl: network.fetchImpl }), {
      code: 'supabase_project_mismatch',
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
    const network = fixture([project, value, types]);
    await assert.rejects(verifySupabaseEnvironment({ policy, token, fetchImpl: network.fetchImpl }), { code });
    assert.equal(network.calls.length, 3);
  }
});

test('rejects numeric migration versions and names even when their coerced values match the pinned digest', async () => {
  for (const entry of [
    { version: 202609230001, name: 'init' },
    { version: '202609230001', name: 123 },
  ]) {
    const digest = createHash('sha256').update(JSON.stringify([entry])).digest('hex');
    const network = fixture([project, [entry], types]);
    await assert.rejects(verifySupabaseEnvironment({
      policy: { ...policy, database: { ...policy.database, migrationHistorySha256: digest } },
      token, fetchImpl: network.fetchImpl,
    }), { code: 'supabase_migrations_invalid' });
    assert.equal(network.calls.length, 3);
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
    const network = fixture([project, migrations, value]);
    await assert.rejects(verifySupabaseEnvironment({ policy, token, fetchImpl: network.fetchImpl }), { code });
    assert.equal(network.calls.length, 4);
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
      let value = url.includes('/organizations/') ? organizationProjects : project;
      if (url.endsWith('/database/migrations')) value = target === 'migrations' ? 'x'.repeat(512_000) : migrations;
      if (url.includes('/types/typescript?')) value = 'x'.repeat(4_000_000);
      return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    await assert.rejects(verifySupabaseEnvironment({ policy, token, fetchImpl }), { code: 'supabase_response_invalid' });
    assert.equal(calls.length, target === 'migrations' ? 3 : 4);
  }
});

test('legacy branch-bound SQL readers are refused before opening a reader session', () => {
  let reads = 0;
  const source = {
    trustedReaderId: 'sql-reader-a',
    async readIdentity() { reads += 1; return {}; },
    async readBillingSnapshot() { reads += 1; return {}; },
    async listAttemptFixtures() { reads += 1; return []; },
    async readSyntheticFixture() { reads += 1; return null; },
    async readWebhookInbox() { reads += 1; return null; },
    async readWebhookReceipts() { reads += 1; return []; },
    async readInstalledSchemaState() { reads += 1; return {}; },
    async readConcurrencyProof() { reads += 1; return {}; },
    async query() { reads += 1; throw new Error('generic query must not be used'); },
  };
  assert.throws(() => createSupabaseBillingReader({ expectedEnvironment: billingEnvironment, source }),
    { code: 'supabase_reader_unavailable' });
  assert.equal(reads, 0);
});
