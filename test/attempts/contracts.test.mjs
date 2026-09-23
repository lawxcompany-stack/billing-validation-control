import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSnapshot, verifyRecheckSnapshot } from '../../src/contracts/attempt.mjs';

const row = {
  attemptId: 'attempt-123', key: { branchId: 'child-123', suite: 'billing', fixtureKey: 'invoice-a' },
  candidateSha: 'a'.repeat(40), workflow: { repository: 'lawxcompany-stack/billing-validation-control',
    ref: 'refs/heads/main', runId: '100', runAttempt: 1, runnerLabel: 'billing-validation-' + 'a'.repeat(32) },
  environment: { database: { projectRef: 'abcdefghijklmnopqrst', branchId: 'child-123' },
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
