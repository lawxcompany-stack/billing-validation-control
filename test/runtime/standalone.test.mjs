import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { preflightRuntime, validateEnvironmentPolicy } from '../../src/runtime/preflight.mjs';
import { createSupabaseBillingReader, createSupabaseFixturePublisher, verifySupabaseEnvironment } from '../../src/runtime/supabase.mjs';
import { createVerifiedContext } from '../../src/billing/contracts.mjs';
import { candidate, deployment, policy } from './fixture.mjs';
import { makeAttemptParts } from '../billing/support.mjs';
import { createSupabaseWebhookObserver } from '../../src/runtime/supabase-webhook-observer.mjs';
import { databasePolicy, trustedConfiguration, projectDetails, migrations, generatedTypes } from './standalone-fixture.mjs';

const standalonePolicy = { ...policy, schema_version: 3, database: databasePolicy };
const token = 'synthetic-read-token';
function fixture(details = projectDetails) {
  const calls = [];
  return { calls, async fetchImpl(url, options) {
    calls.push({ url, method: options.method });
    assert.equal(options.method, 'GET', 'mutable provider API must never be invoked');
    const replies = {
      [`https://api.supabase.com/v1/projects/${databasePolicy.projectRef}`]: details,
      [`https://api.supabase.com/v1/projects/${databasePolicy.projectRef}/database/migrations`]: migrations,
      [`https://api.supabase.com/v1/projects/${databasePolicy.projectRef}/types/typescript?included_schemas=public`]: generatedTypes,
    };
    assert.ok(Object.hasOwn(replies, url), 'only the narrow pinned project read routes are permitted');
    return new Response(JSON.stringify(replies[url]), { headers: { 'Content-Type': 'application/json' } });
  } };
}

test('standalone policy is accepted without inventing parent or branch identities', () => {
  assert.equal(validateEnvironmentPolicy(standalonePolicy), true);
  for (const field of ['parentProjectRef', 'branchId', 'branchName']) {
    assert.equal(validateEnvironmentPolicy({ ...standalonePolicy,
      database: { ...databasePolicy, [field]: 'synthetic-branch' } }), false);
  }
});

test('legacy branch policy cannot remain a final validation target even with complete fingerprints', async () => {
  const f = fixture();
  await assert.rejects(verifySupabaseEnvironment({ policy: { ...policy, schema_version: 2,
    database: { projectRef: 'zjvqjdntasprusoqfsgw', parentProjectRef: 'zyxwvutsrqponmlkjihg',
      branchId: 'synthetic-billing-validation', branchName: 'synthetic-validation-branch',
      schemaFingerprintSha256: databasePolicy.schemaFingerprintSha256,
      migrationHistorySha256: databasePolicy.migrationHistorySha256 } }, token,
    trustedConfiguration, fetchImpl: f.fetchImpl }), { code: 'supabase_policy_invalid' });
  assert.deepEqual(f.calls, []);
});

test('pooler and privileged or divergent connection policy pins cannot authorize a target', async () => {
  for (const change of [{ mode: 'transaction-pooler' }, { host: 'aws-0-synthetic.pooler.supabase.com' },
    { host: 'db.bbbbbbbbbbbbbbbbbbbb.supabase.co' }, { port: 6543 }, { database: 'other' },
    { role: 'postgres' }, { role: 'service_role' }, { role: 'supabase_admin' }]) {
    const f = fixture();
    await assert.rejects(verifySupabaseEnvironment({ policy: { ...standalonePolicy,
      database: { ...databasePolicy, connection: { ...databasePolicy.connection, ...change } } },
      token, trustedConfiguration, fetchImpl: f.fetchImpl }), { code: 'supabase_policy_invalid' });
    assert.deepEqual(f.calls, []);
  }
});

test('standalone identity returns the pinned project and fingerprints through narrow GETs', async () => {
  const f = fixture();
  const result = await verifySupabaseEnvironment({ policy: standalonePolicy, token,
    trustedConfiguration, fetchImpl: f.fetchImpl });
  assert.deepEqual(result, databasePolicy);
  assert.ok(Object.isFrozen(result));
  assert.deepEqual(f.calls.map(({ url }) => url), [
    'https://api.supabase.com/v1/projects/abcdefghijklmnopqrst',
    'https://api.supabase.com/v1/projects/abcdefghijklmnopqrst/database/migrations',
    'https://api.supabase.com/v1/projects/abcdefghijklmnopqrst/types/typescript?included_schemas=public',
  ]);
  for (const field of ['parentProjectRef', 'branchId', 'branchName', 'databaseUrl']) assert.equal(Object.hasOwn(result, field), false);
  assert.equal(JSON.stringify(result).includes('synthetic-password'), false);
});

test('missing or unapproved pins and Production/shared/known branch refs refuse before any I/O', async () => {
  for (const change of [
    { projectRef: null }, { approved: false }, { productionProjectRef: null },
    { projectRef: 'zjvqjdntasprusoqfsgw' }, { projectRef: 'bbbbbbbbbbbbbbbbbbbb' },
    { projectRef: 'zyxwvutsrqponmlkjihg' },
    { schemaFingerprintSha256: null }, { migrationHistorySha256: null },
  ]) {
    const f = fixture();
    await assert.rejects(verifySupabaseEnvironment({ policy: { ...standalonePolicy,
      database: { ...databasePolicy, ...change } }, token, trustedConfiguration, fetchImpl: f.fetchImpl }),
    { code: 'supabase_policy_invalid' });
    assert.deepEqual(f.calls, []);
  }
});

test('trusted ref, Environment approval, direct host, role and configuration are required before I/O', async () => {
  for (const change of [
    { SUPABASE_VALIDATION_PROJECT_REF: null }, { SUPABASE_VALIDATION_PROJECT_REF: 'bbbbbbbbbbbbbbbbbbbb' },
    { environmentApproved: false }, { databaseUrl: null },
    { databaseUrl: 'postgresql://billing_validation_reader:synthetic@db.bbbbbbbbbbbbbbbbbbbb.supabase.co:5432/postgres' },
    { databaseUrl: 'postgresql://billing_validation_reader:synthetic@aws-0-synthetic.pooler.supabase.com:6543/postgres' },
    { databaseUrl: 'postgresql://postgres:synthetic@db.abcdefghijklmnopqrst.supabase.co:5432/postgres' },
    { databaseUrl: 'postgresql://billing_validation_reader:synthetic@db.abcdefghijklmnopqrst.supabase.co:6543/postgres' },
    { databaseUrl: 'postgresql://billing_validation_reader:synthetic@db.abcdefghijklmnopqrst.supabase.co:5432/other' },
    { databaseUrl: `${trustedConfiguration.databaseUrl}?sslmode=disable` },
    { databaseUrl: `${trustedConfiguration.databaseUrl}#candidate` },
    { databaseUrl: 'postgresql://billing_validation_reader@db.abcdefghijklmnopqrst.supabase.co:5432/postgres' },
    { envFile: '.env.local' },
  ]) {
    const f = fixture();
    await assert.rejects(verifySupabaseEnvironment({ policy: standalonePolicy, token,
      trustedConfiguration: { ...trustedConfiguration, ...change }, fetchImpl: f.fetchImpl }),
    { code: 'supabase_configuration_invalid' });
    assert.deepEqual(f.calls, []);
  }
  const f = fixture();
  await assert.rejects(verifySupabaseEnvironment({ policy: standalonePolicy, token, fetchImpl: f.fetchImpl }),
    { code: 'supabase_configuration_invalid' });
  await assert.rejects(verifySupabaseEnvironment({ policy: standalonePolicy, trustedConfiguration, fetchImpl: f.fetchImpl }),
    { code: 'supabase_credentials_invalid' });
  assert.deepEqual(f.calls, []);
});

test('project metadata mismatch refuses before migration/schema reads or SQL sessions', async () => {
  for (const change of [
    { ref: 'zyxwvutsrqponmlkjihg' }, { ref: 'zjvqjdntasprusoqfsgw' },
    { organization_id: 'another-org' }, { region: 'another-region' }, { status: 'INACTIVE' },
    { database: { ...projectDetails.database, version: '15.synthetic' } },
    { database: { ...projectDetails.database, postgres_engine: 'another-engine' } },
    { database: { ...projectDetails.database, release_channel: 'preview' } },
    { database: null }, { parent_project_ref: databasePolicy.productionProjectRef }, { is_branch: true },
  ]) {
    const f = fixture({ ...projectDetails, ...change });
    await assert.rejects(verifySupabaseEnvironment({ policy: standalonePolicy, token,
      trustedConfiguration, fetchImpl: f.fetchImpl }), { code: 'supabase_project_mismatch' });
    assert.equal(f.calls.length, 1);
  }
});

test('candidate values cannot supply a missing trusted ref, URL or approval', async () => {
  let calls = 0;
  const untrusted = { ...candidate, projectRef: databasePolicy.projectRef,
    SUPABASE_VALIDATION_PROJECT_REF: databasePolicy.projectRef, databaseUrl: trustedConfiguration.databaseUrl,
    environmentApproved: true, trustedConfiguration };
  await assert.rejects(preflightRuntime({ candidate: untrusted, policy: standalonePolicy,
    api: { async get() { calls += 1; throw new Error('no metadata I/O'); } },
    fetchImpl: async () => { calls += 1; throw new Error('no provider I/O'); },
    supabaseToken: token, stripeKey: 'sk_test_synthetic123' }), { code: 'supabase_configuration_invalid' });
  assert.equal(calls, 0);
});

test('ambient synthetic environment and an env-file option cannot configure the default policy', () => {
  const moduleUrl = new URL('../../src/runtime/preflight.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { preflightRuntime } from ${JSON.stringify(moduleUrl)};
    let calls = 0;
    const options = { candidate: { candidateSha: 'a'.repeat(40), treeSha: 'b'.repeat(40) },
      api: { async get() { calls++; throw new Error('forbidden'); } },
      fetchImpl: async () => { calls++; throw new Error('forbidden'); } };
    await assert.rejects(preflightRuntime(options), { code: 'environment_policy_unconfigured' });
    await assert.rejects(preflightRuntime({ ...options, envFile: '.env.local' }), { code: 'preflight_input_invalid' });
    assert.equal(calls, 0);
  `], { encoding: 'utf8', env: { SUPABASE_VALIDATION_PROJECT_REF: databasePolicy.projectRef,
    DATABASE_URL: trustedConfiguration.databaseUrl, SUPABASE_ACCESS_TOKEN: token } });
  assert.equal(child.status, 0, child.stderr);
});

test('verified billing context accepts standalone identity and rejects legacy branch verification', () => {
  const h = makeAttemptParts();
  const standaloneEnvironment = { ...h.owner.environment, database: { projectRef: databasePolicy.projectRef } };
  const standalone = { ...h, owner: { ...h.owner, environment: standaloneEnvironment },
    readers: { ...h.readers, expectedEnvironment: standaloneEnvironment },
    preflight: { ...h.preflight, expectedEnvironment: standaloneEnvironment,
      providerVerification: { ...h.preflight.providerVerification, supabase: databasePolicy } } };
  assert.doesNotThrow(() => createVerifiedContext(standalone));
  assert.throws(() => createVerifiedContext({ ...standalone, preflight: { ...standalone.preflight,
    providerVerification: { ...standalone.preflight.providerVerification,
      supabase: { ...databasePolicy, parentProjectRef: databasePolicy.productionProjectRef, branchId: 'shared-branch' } } } }),
  { code: 'billing_environment_unverified' });
});

test('standalone reader binds project-only identities and rejects candidate project/branch overrides', async () => {
  const expectedEnvironment = { database: { projectRef: databasePolicy.projectRef }, deployment,
    stripe: { accountId: policy.stripe.accountId } };
  let reads = 0;
  const source = {
    async readIdentity() { return { projectRef: databasePolicy.projectRef, readOnly: true }; },
    async readBillingSnapshot() { reads++; return {}; }, async listAttemptFixtures() { reads++; return []; },
    async readSyntheticFixture() { reads++; return null; }, async readWebhookInbox() { reads++; return null; },
    async readWebhookReceipts() { reads++; return []; },
  };
  const reader = createSupabaseBillingReader({ expectedEnvironment, source });
  assert.deepEqual(await reader.readIdentity(), { projectRef: 'abcdefghijklmnopqrst', readOnly: true });
  for (const change of [{ projectRef: 'zjvqjdntasprusoqfsgw' }, { branchId: 'candidate-branch' }]) {
    await assert.rejects(reader.readBillingSnapshot({ attemptId: 'synthetic-attempt', caseId: 'synthetic-case', ...change }),
      { code: 'supabase_reader_input_invalid' });
  }
  assert.equal(reads, 0);
  let fenceChecks = 0;
  const owner = { attemptId: 'synthetic-attempt', fence: 'synthetic-fence', reservationId: 'synthetic-reservation',
    capacity: { requested: { databaseRows: 1 } }, environment: expectedEnvironment };
  const publisher = createSupabaseFixturePublisher({ expectedEnvironment, owner,
    attempts: { async assertFence() { fenceChecks++; return owner; }, async fixtureMutationWithReservation() {} },
    adapter: { capabilities: { transactionalFence: true, transactionalReservation: true, rejectsExistingIds: true,
      update: false, delete: false, authAdmin: false },
    async readIdentity() { return { projectRef: databasePolicy.projectRef, appendOnly: true }; },
    async insertAttemptFixture() { throw new Error('must not write in a readiness check'); } } });
  assert.equal(await publisher.assertReady(owner), true);
  assert.equal(fenceChecks, 1);
  const shared = { ...expectedEnvironment, database: { projectRef: 'zjvqjdntasprusoqfsgw', branchId: 'shared-branch' } };
  assert.throws(() => createSupabaseBillingReader({ expectedEnvironment: shared, source }), { code: 'supabase_reader_unavailable' });
  assert.throws(() => createSupabaseFixturePublisher({ expectedEnvironment: shared }), { code: 'supabase_fixture_adapter_unavailable' });
});

test('legacy concrete SQL observer stays blocked for shared and unapproved standalone targets', () => {
  let clientCreations = 0;
  for (const database of [{ projectRef: 'zjvqjdntasprusoqfsgw', branchId: 'e2f26c0b-8a79-4cd5-ad80-faaf91fb51a2' },
    { projectRef: databasePolicy.projectRef }]) {
    assert.throws(() => createSupabaseWebhookObserver({ expectedEnvironment: { database, deployment,
      stripe: { accountId: policy.stripe.accountId } }, password: 'synthetic-password',
    clientFactory: () => { clientCreations++; throw new Error('must never construct SQL client'); } }),
    { code: 'supabase_webhook_observer_input_invalid' });
  }
  assert.equal(clientCreations, 0);
});
