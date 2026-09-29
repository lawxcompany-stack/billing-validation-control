import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';

const workflowPaths = [
  '.github/workflows/validate-billing.yml',
  '.github/workflows/reconcile-billing-checks.yml',
];

function assertReaderBoundary(job) {
  assert.equal(job.environment, 'billing-validation-reader');
  assert.equal(job.needs, 'authorize');
  assert.equal(job['continue-on-error'], undefined);
  assert.equal(job.env, undefined);
  assert.equal(job.if, "${{ github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && github.ref_protected && needs.authorize.result == 'success' }}");
  assert.equal(job.steps.length, 4, 'credentialed reader runs only the reviewed fixed steps');
  const [checkout, setup, token, consumer] = job.steps;
  for (const [step, allowed] of [
    [checkout, ['name', 'uses', 'with']], [setup, ['name', 'uses', 'with']],
    [token, ['name', 'id', 'uses', 'with']], [consumer, ['name', 'id', 'env', 'run']],
  ]) assert.deepEqual(Object.keys(step).sort(), allowed.sort());
  assert.equal(checkout.uses, 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1');
  assert.equal(checkout.with.ref, '${{ github.sha }}');
  assert.equal(checkout.with['persist-credentials'], false);
  assert.equal(checkout.with.repository, undefined);
  assert.equal(setup.uses, 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020');
  assert.deepEqual(setup.with, { 'node-version': '22', 'package-manager-cache': false });
  assert.equal(token.id, 'reader_token');
  assert.equal(token.uses, 'actions/create-github-app-token@fee1f7d63c2ff003460e3d139729b119787bc349');
  assert.deepEqual(token.with, {
    'app-id': '${{ vars.BILLING_READER_APP_ID }}',
    'private-key': '${{ secrets.BILLING_READER_APP_PRIVATE_KEY }}',
    owner: 'lawxcompany-stack', repositories: 'Plataforma-LawX',
    'permission-actions': 'read', 'permission-contents': 'read', 'permission-pull-requests': 'read',
    'skip-token-revoke': false,
  });
  assert.equal(consumer.id, 'candidate');
  assert.equal(consumer.run, 'node scripts/read-candidate.mjs');
  assert.deepEqual(consumer.env, {
    CONTROL_REPOSITORY: '${{ github.repository }}',
    CONTROL_REF: '${{ github.ref }}',
    CONTROL_DEFAULT_BRANCH: '${{ github.event.repository.default_branch }}',
    CONTROL_REF_PROTECTED: '${{ github.ref_protected }}',
    CONTROL_EVENT_NAME: '${{ github.event_name }}',
    CANDIDATE_SHA: '${{ needs.authorize.outputs.candidate_sha }}',
    CANDIDATE_READ_TOKEN: '${{ steps.reader_token.outputs.token }}',
  });
  const serialized = JSON.stringify(job);
  assert.deepEqual(serialized.match(/\$\{\{[^}]*\bsecrets\b[^}]*\}\}/gu), ['${{ secrets.BILLING_READER_APP_PRIVATE_KEY }}']);
  assert.equal((serialized.match(/steps\.reader_token\.outputs\.token/gu) ?? []).length, 1,
    'the reader token may only be consumed by the fixed reader step');
}

export function assertWorkflowSecretBoundary(workflow, path) {
  assert.deepEqual(workflow.permissions, { contents: 'read' }, `${path} must keep token permissions read-only`);

  for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
    const serializedJob = JSON.stringify(job);
    if (path === workflowPaths[0] && jobId === 'reader') assertReaderBoundary(job);
    else assert.ok(!/\$\{\{[^}]*\bsecrets\b/i.test(serializedJob),
      `${path}:${jobId} must not consume reader or financial secrets`);
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const path of workflowPaths) assertWorkflowSecretBoundary(YAML.parse(readFileSync(path, 'utf8')), path);
  console.log('Static workflow secret-boundary checks passed');
}
