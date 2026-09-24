import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';

const workflowPaths = [
  '.github/workflows/validate-billing.yml',
  '.github/workflows/reconcile-billing-checks.yml',
];

for (const path of workflowPaths) {
  const workflow = YAML.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(workflow.permissions, { contents: 'read' }, `${path} must keep token permissions read-only`);

  for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
    const serializedJob = JSON.stringify(job);
    assert.ok(!/\$\{\{\s*secrets\./i.test(serializedJob),
      `${path}:${jobId} must not consume secrets during bootstrap`);
    assert.ok(!/\$\{\{\s*needs\.[^}]+\.outputs\.(?:private_key|token|secret)/i.test(serializedJob),
      `${path}:${jobId} must not propagate credential-like outputs`);
    if (path === workflowPaths[0] && jobId === 'attest-activation') {
      assert.deepEqual(job.permissions, {
        contents: 'read',
        'id-token': 'write',
        attestations: 'write',
      }, `${path}:${jobId} must scope signing permissions to the hosted activation attestation`);
    } else {
      assert.ok(!job.permissions || JSON.stringify(job.permissions) === JSON.stringify({ contents: 'read' }),
        `${path}:${jobId} must not widen token permissions`);
    }
  }
}

console.log('Static workflow secret-boundary checks passed');
