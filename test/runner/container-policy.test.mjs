import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importIfMissing, needExport } from '../billing/support.mjs';

const policy = await importIfMissing(() => import('../../runner/container-policy.mjs'));
const createLabel = (...args) => needExport(policy, 'createAttemptRunnerLabel')(...args);

test('runner labels use 128 bits from the cryptographic source and cannot be reused in-process', () => {
  const label = createLabel({ randomBytes: (size) => Buffer.alloc(size, 0x41) });
  assert.equal(label, `billing-validation-${'41'.repeat(16)}`);
  assert.throws(() => createLabel({ randomBytes: (size) => Buffer.alloc(size, 0x41) }),
    { code: 'runner_label_reused' });
});

test('runner labels refuse a missing, throwing, or malformed random source', () => {
  assert.throws(() => createLabel({ randomBytes: null }), { code: 'runner_random_source_invalid' });
  assert.throws(() => createLabel({ randomBytes: () => { throw new Error('test-only'); } }),
    { code: 'runner_random_source_unavailable' });
  assert.throws(() => createLabel({ randomBytes: () => Buffer.alloc(15) }),
    { code: 'runner_random_source_unavailable' });
});
