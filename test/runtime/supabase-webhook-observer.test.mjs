import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createSupabaseWebhookObserver } from '../../src/runtime/supabase-webhook-observer.mjs';

const environment = Object.freeze({
  database: Object.freeze({ projectRef: 'abcdefghijklmnopqrst' }),
  deployment: Object.freeze({ id: 'dpl_candidate123', origin: 'https://lawx-abc123def-team.vercel.app' }),
  stripe: Object.freeze({ accountId: 'acct_synthetic123' }),
});

function disconnectedFactory(counter) {
  return () => {
    counter.calls += 1;
    throw new Error('database connection is forbidden in this test');
  };
}

test('exports the standalone read-only webhook observer factory', () => {
  assert.equal(typeof createSupabaseWebhookObserver, 'function');
});

test('unconfigured real target pins keep webhook collection blocked before connecting', async () => {
  const policy = JSON.parse(await readFile(new URL('../../policy/environment-policy.json', import.meta.url), 'utf8'));
  assert.equal(policy.database.kind, 'standalone');
  for (const key of ['projectRef', 'databaseVersion', 'connection', 'schemaFingerprintSha256', 'migrationHistorySha256']) {
    assert.equal(policy.database[key], null);
  }

  const counter = { calls: 0 };
  assert.throws(() => createSupabaseWebhookObserver({ expectedEnvironment: environment,
    password: 'synthetic-test-only', clientFactory: disconnectedFactory(counter) }),
  { code: 'supabase_webhook_observer_input_invalid' });
  assert.equal(counter.calls, 0);
});

test('branch-shaped or parent-project environment identities are rejected before connection', () => {
  const counter = { calls: 0 };
  for (const database of [
    { ...environment.database, branchId: 'synthetic-branch' },
    { ...environment.database, parentProjectRef: 'zyxwvutsrqponmlkjihg' },
  ]) {
    assert.throws(() => createSupabaseWebhookObserver({
      expectedEnvironment: { ...environment, database },
      password: 'synthetic-test-only', clientFactory: disconnectedFactory(counter),
    }), { code: 'supabase_webhook_observer_input_invalid' });
  }
  assert.equal(counter.calls, 0);
});
