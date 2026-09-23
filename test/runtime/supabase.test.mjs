import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifySupabaseEnvironment } from '../../src/runtime/supabase.mjs';
import * as supabaseModule from '../../src/runtime/supabase.mjs';
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

test('exposes no mutation operation and refuses equal parent and child refs without fetching', async () => {
  assert.deepEqual(Object.keys(supabaseModule).sort(), ['SupabaseRefusal', 'verifySupabaseEnvironment']);
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
