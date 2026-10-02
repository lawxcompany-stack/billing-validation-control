import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSnapshot, verifyRecheckSnapshot } from '../../src/contracts/attempt.mjs';
import { createAttemptStore } from '../../src/attempts/store.mjs';

const row = {
  attemptId: 'attempt-123', key: { projectRef: 'abcdefghijklmnopqrst', suite: 'billing', fixtureKey: 'invoice-a' },
  candidateSha: 'a'.repeat(40), workflow: { repository: 'lawxcompany-stack/billing-validation-control',
    ref: 'refs/heads/main', runId: '100', runAttempt: 1, runnerLabel: 'billing-validation-' + 'a'.repeat(32) },
  environment: { database: { projectRef: 'abcdefghijklmnopqrst' },
    deployment: { id: 'dpl_candidate123', origin: 'https://candidate.vercel.app' },
    stripe: { accountId: 'acct_synthetic123' } },
  state: 'collected', cleanupStatus: 'pending', resourceIds: ['cus_synthetic'],
  createdAt: 1000, updatedAt: 1001,
};

function fixture() {
  const { snapshot, digest, artifact } = createSnapshot(row, 'artifact-321');
  return { snapshot, digest, artifact, expected: {
    row: { ...row, artifact }, workflow: row.workflow, environment: row.environment,
    candidateSha: row.candidateSha, currentHeadSha: row.candidateSha,
    artifactId: 'artifact-321', artifactDigest: digest,
  } };
}

test('snapshot contains only synthetic public fields and has a 48-hour maximum retention', () => {
  const { snapshot, artifact } = fixture();
  assert.deepEqual(Object.keys(snapshot).sort(), ['artifactId', 'attemptId', 'candidateSha', 'cleanupStatus',
    'environment', 'key', 'resourceIds', 'schema', 'state', 'workflow'].sort());
  assert.equal(artifact.retentionDays, 2);
  assert.equal(JSON.stringify(snapshot).includes('sk_test_'), false);
});

test('recheck verifies artifact digest and authoritative database state', () => {
  const { snapshot, expected } = fixture();
  assert.equal(verifyRecheckSnapshot(snapshot, expected), true);
  const mismatches = [
    [{ ...snapshot, artifactId: 'other-artifact' }, expected],
    [{ ...snapshot, schema: 2 }, expected],
    [{ ...snapshot, resourceIds: ['cus_other'] }, expected],
    [{ ...snapshot, candidateSha: 'b'.repeat(40) }, expected],
    [snapshot, { ...expected, currentHeadSha: 'b'.repeat(40) }],
    [snapshot, { ...expected, workflow: { ...expected.workflow, runId: '999' } }],
    [snapshot, { ...expected, workflow: { ...expected.workflow, runAttempt: 2 } }],
    [snapshot, { ...expected, workflow: { ...expected.workflow, ref: 'refs/heads/other' } }],
    [snapshot, { ...expected, row: { ...expected.row, resourceIds: ['cus_other'] } }],
    [{ ...snapshot, extra: 'private material' }, expected],
  ];
  for (const [tampered, context] of mismatches) {
    assert.throws(() => verifyRecheckSnapshot(tampered, context), { code: 'artifact_identity_mismatch' });
  }
});

test('snapshot refuses credentials and private browser material', () => {
  for (const extra of [{ stripeSecret: 'sk_test_fake' }, { browserState: '{}' }, { bearer: 'token' }]) {
    assert.throws(() => createSnapshot({ ...row, ...extra }, 'artifact-321'), { code: 'attempt_private_material' });
  }
});

test('recheck accepts a reserialized snapshot with reordered object keys', () => {
  const { snapshot, expected } = fixture();
  const reordered = Object.fromEntries(Object.entries(snapshot).reverse());
  assert.equal(verifyRecheckSnapshot(reordered, expected), true);
});

test('public snapshot is immutable even when source row is later changed', () => {
  const source = structuredClone(row);
  const { snapshot } = createSnapshot(source, 'artifact-321');
  source.resourceIds.push('cus_other');
  assert.deepEqual(snapshot.resourceIds, ['cus_synthetic']);
  assert.throws(() => snapshot.resourceIds.push('cus_untrusted'), TypeError);
  assert.throws(() => { snapshot.workflow.runId = '999'; }, TypeError);
});

test('Stripe client secrets cannot be copied into public resource IDs', () => {
  for (const secret of ['pi_123_secret_abc', 'seti_123_secret_abc']) {
    assert.throws(() => createSnapshot({ ...row, resourceIds: [secret] }, 'artifact-321'),
      { code: 'attempt_private_material' });
  }
  assert.deepEqual(createSnapshot({ ...row, resourceIds: ['pi_123', 'seti_123'] },
    'artifact-321').snapshot.resourceIds, ['pi_123', 'seti_123']);
});

test('retention admission contract rejects accessors and malformed quota/projection shapes without invoking getters', async () => {
  let transactions = 0;
  const store = createAttemptStore({ async transaction() { transactions++; } });
  const validInput = {
    attemptId: 'attempt-retention', key: { projectRef: 'abcdefghijklmnopqrst', suite: 'billing', fixtureKey: 'invoice-a' },
    candidateSha: 'a'.repeat(40), workflow: row.workflow, environment: row.environment, ttlSeconds: 60,
    retentionPolicy: { version: 1, quotas: {
      attempts: 10, databaseRows: 100, authUsers: 10, stripeObjects: 100,
    } },
    projection: { attempts: 1, databaseRows: 4, authUsers: 1, stripeObjects: 4 },
  };
  const malformed = [
    { retentionPolicy: { ...validInput.retentionPolicy, version: 2 } },
    { retentionPolicy: { version: 1, quotas: { ...validInput.retentionPolicy.quotas, unknown: 1 } } },
    { retentionPolicy: { version: 1, quotas: { ...validInput.retentionPolicy.quotas, attempts: 0 } } },
    { projection: { ...validInput.projection, databaseRows: 1.25 } },
    { projection: { ...validInput.projection, attempts: 2 } },
    { projection: { ...validInput.projection, stripeObjects: -1 } },
    { projection: { ...validInput.projection, ignored: 1 } },
  ];
  for (const override of malformed) {
    await assert.rejects(store.prepare({ ...validInput, ...override }), { code: 'retention_policy_invalid' });
  }

  let getterReads = 0;
  const quotasWithGetter = { ...validInput.retentionPolicy.quotas };
  Object.defineProperty(quotasWithGetter, 'databaseRows', { enumerable: true,
    get() { getterReads++; return 100; } });
  await assert.rejects(store.prepare({ ...validInput, retentionPolicy: { version: 1, quotas: quotasWithGetter } }),
    { code: 'retention_policy_invalid' });
  assert.equal(getterReads, 0);

  let inputGetterReads = 0;
  const inputWithGetter = { ...validInput };
  Object.defineProperty(inputWithGetter, 'retentionPolicy', { enumerable: true,
    get() { inputGetterReads++; return validInput.retentionPolicy; } });
  await assert.rejects(store.prepare(inputWithGetter), { code: 'retention_policy_invalid' });
  assert.equal(inputGetterReads, 0);
  assert.equal(transactions, 0);
});
