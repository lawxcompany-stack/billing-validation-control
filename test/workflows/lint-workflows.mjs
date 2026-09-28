import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import YAML from 'yaml';

const paths = [
  '.github/workflows/validate-billing.yml',
  '.github/workflows/reconcile-billing-checks.yml',
];

for (const path of paths) {
  assert.ok(existsSync(path), `Required workflow is missing: ${path}`);
  const workflow = YAML.parse(readFileSync(path, 'utf8'));
  assert.ok(workflow && typeof workflow === 'object', `${path} must parse as a YAML mapping`);
  assert.ok(workflow.jobs && Object.keys(workflow.jobs).length > 0, `${path} must declare jobs`);
  assert.deepEqual(workflow.permissions, { contents: 'read' }, `${path} must default to contents: read`);
  assert.ok(!Object.hasOwn(workflow.on, 'pull_request_target'), `${path} must not use pull_request_target`);

  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    assert.ok(Number.isInteger(job['timeout-minutes']) && job['timeout-minutes'] > 0,
      `${path}:${jobId} needs a finite timeout`);
    for (const step of job.steps ?? []) {
      if (!step.uses) continue;
      assert.match(step.uses, /^[^@]+@[0-9a-f]{40}$/i, `${path}:${jobId} uses an unpinned action`);
    }
  }
}

const validate = YAML.parse(readFileSync(paths[0], 'utf8'));
for (const id of ['reader', 'test', 'publisher']) {
  assert.match(validate.jobs[id].if, /needs\.authorize\.result\s*==\s*'success'/,
    `${id} must be blocked unless the dispatch gate succeeds`);
}
assert.match(validate.jobs.test['runs-on'], /needs\.authorize\.outputs\.runner_label/);
console.log(`Workflow YAML policy lint passed for ${paths.length} workflows`);
