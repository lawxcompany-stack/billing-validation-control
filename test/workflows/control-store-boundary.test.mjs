import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import YAML from 'yaml';
import { assertWorkflowSecretBoundary } from './secret-boundary.mjs';

const WORKFLOW_PATH = '.github/workflows/validate-billing.yml';
const workflow = () => YAML.parse(readFileSync(WORKFLOW_PATH, 'utf8'));
const controlReference = '${{ secrets.BILLING_CONTROL_VERIFIER_DATABASE_URL }}';

function hasSecret(job, name) {
  return JSON.stringify(job).includes('${{ secrets.' + name + ' }}');
}

function usesMigrationExecutor(value) {
  return Object.values(value.jobs).some((job) => (job.steps ?? []).some((step) =>
    typeof step.run === 'string' && /installAttemptSchema|applyAttemptMigrations|renderControlStoreMigrationBundle|\bpsql\b/iu.test(step.run)));
}

test('candidate and pull-request jobs never receive the verifier database URL', () => {
  const value = workflow();
  assert.equal(hasSecret(value.jobs.policy, 'BILLING_CONTROL_VERIFIER_DATABASE_URL'), false);
  assert.equal(Object.entries(value.jobs).some(([id, job]) => id !== 'control-store' &&
    hasSecret(job, 'BILLING_CONTROL_VERIFIER_DATABASE_URL')), false);
  assert.equal(JSON.stringify(value).includes('BILLING_CONTROL_DATABASE_URL'), false,
    'the control verifier must not reuse the financial/runtime credential name');
  assert.equal(usesMigrationExecutor(value), false);
});

test('the trusted control verifier has one protected secret consumer and gates collect', () => {
  const value = workflow();
  const job = value.jobs['control-store'];

  assert.ok(job, 'the protected control-store verifier job must exist');
  assert.equal(job.environment, 'billing-validation-control');
  assert.equal(job.needs, 'authorize');
  assert.equal(job['runs-on'], 'ubuntu-latest');
  assert.deepEqual(job.permissions, { contents: 'read' });
  assert.equal(job.outputs, undefined);
  assert.equal(job.steps.at(-1).run, 'node runner/verify-control-store.mjs');
  assert.deepEqual(job.steps.at(-1).env, { BILLING_CONTROL_VERIFIER_DATABASE_URL: controlReference });
  assert.equal(Object.values(value.jobs).flatMap((entry) =>
    JSON.stringify(entry).match(/\$\{\{\s*secrets\.BILLING_CONTROL_VERIFIER_DATABASE_URL\s*\}\}/gu) ?? []).length, 1);
  assert.ok(value.jobs.test.needs.includes('control-store'));
  assert.match(value.jobs.test.if, /needs\.control-store\.result\s*==\s*'success'/u);
});

test('collect authorization preflights required-reviewer protection for the control environment', () => {
  const value = workflow();
  const authorize = value.jobs.authorize.steps.find((step) => step.id === 'environments');
  assert.equal(authorize.env?.CONTROL_DISPATCH_OPERATION, '${{ steps.authorize.outputs.operation }}');
  assert.match(authorize.run, /CONTROL_DISPATCH_OPERATION\s*===\s*'collect'/u);
  assert.match(authorize.run, /billing-validation-control/u);
  assert.match(authorize.run, /approval\.reviewers\.length\s*>\s*0/u);
});

for (const [name, mutate] of [
  ['a pull-request policy job secret', (value) => {
    value.jobs.policy.env = { BILLING_CONTROL_VERIFIER_DATABASE_URL: controlReference };
  }],
  ['a candidate execution job secret', (value) => {
    value.jobs.test.env = { BILLING_CONTROL_VERIFIER_DATABASE_URL: controlReference };
  }],
  ['the former shared runtime/control URL alias', (value) => {
    value.jobs.test.env = { BILLING_CONTROL_DATABASE_URL: '${{ secrets.BILLING_CONTROL_DATABASE_URL }}' };
  }],
  ['a forwarded database URL output', (value) => {
    value.jobs['control-store'].outputs = { database_url: '${{ steps.verify.outputs.BILLING_CONTROL_VERIFIER_DATABASE_URL }}' };
  }],
  ['migration execution in the credentialed job', (value) => {
    value.jobs['control-store'].steps.at(-1).run = 'node runner/render-control-store-bootstrap.mjs | psql';
  }],
  ['a management API token', (value) => {
    value.jobs['control-store'].steps.at(-1).env.SUPABASE_ACCESS_TOKEN = '${{ secrets.SUPABASE_ACCESS_TOKEN }}';
  }],
  ['broadened token permissions', (value) => {
    value.jobs['control-store'].permissions.actions = 'write';
  }],
  ['a missing protected environment', (value) => {
    delete value.jobs['control-store'].environment;
  }],
  ['a removed required-reviewer check', (value) => {
    const step = value.jobs.authorize.steps.find((entry) => entry.id === 'environments');
    step.run = step.run.replace('approval.reviewers.length > 0', 'approval.reviewers.length >= 0');
  }],
  ['a removed collect environment preflight', (value) => {
    const step = value.jobs.authorize.steps.find((entry) => entry.id === 'environments');
    step.run = step.run.replace("'billing-validation-control'", "'billing-validation-other'");
  }],
  ['a weakened protected-main dispatch guard', (value) => {
    value.jobs['control-store'].if = "${{ github.event_name == 'workflow_dispatch' && needs.authorize.result == 'success' }}";
  }],
  ['a candidate SHA checkout', (value) => {
    value.jobs['control-store'].steps[0].with.ref = '${{ needs.authorize.outputs.candidate_sha }}';
  }],
]) {
  test('workflow boundary rejects ' + name, () => {
    const value = workflow();
    assert.ok(value.jobs['control-store'], 'the control-store job must exist before testing its boundary');
    mutate(value);
    assert.throws(() => assertWorkflowSecretBoundary(value, WORKFLOW_PATH));
  });
}

test('the package exposes a focused command for control-store runtime and workflow tests', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(packageJson.scripts['test:control-store'],
    'node --test test/attempts/control-store-runtime.test.mjs test/workflows/control-store-boundary.test.mjs test/workflows/workflow-policy.test.mjs test/workflows/reader-boundary.test.mjs');
});
