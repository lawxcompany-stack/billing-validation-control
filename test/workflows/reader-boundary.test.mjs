import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import YAML from 'yaml';
import { assertWorkflowSecretBoundary } from './secret-boundary.mjs';

const path = '.github/workflows/validate-billing.yml';
const workflow = () => YAML.parse(readFileSync(path, 'utf8'));

test('protected reader permits only a revoked-after-job App token with read access to the candidate repository', () => {
  assert.doesNotThrow(() => assertWorkflowSecretBoundary(workflow(), path));
});

for (const [name, change] of [
  ['write permission', (job) => { job.steps.find((step) => step.id === 'reader_token').with['permission-actions'] = 'write'; }],
  ['another repository', (job) => { job.steps.find((step) => step.id === 'reader_token').with.repositories = 'another-repo'; }],
  ['token not revoked', (job) => { job.steps.find((step) => step.id === 'reader_token').with['skip-token-revoke'] = true; }],
  ['unprotected ref', (job) => { job.if = "${{ github.event_name == 'workflow_dispatch' && needs.authorize.result == 'success' }}"; }],
  ['guard bypass', (job) => { job.if = job.if.replace(' }}', ' || true }}'); }],
  ['forged protected context', (job) => { job.steps.at(-1).env.CONTROL_REF_PROTECTED = 'true'; }],
  ['extra credentialed step', (job) => { job.steps.push({ run: 'node unreviewed.mjs' }); }],
  ['replaced setup step', (job) => { job.steps[1] = { uses: job.steps[0].uses, with: { repository: 'attacker/repo' } }; }],
  ['skipped reader', (job) => { job.steps.at(-1).if = '${{ false }}'; }],
  ['tolerated reader failure', (job) => { job.steps.at(-1)['continue-on-error'] = true; }],
  ['tolerated job failure', (job) => { job['continue-on-error'] = true; }],
  ['bracket secret', (job) => { job.env = { TOKEN: "${{ secrets['FINANCIAL_TOKEN'] }}" }; }],
  ['candidate checkout', (job) => { job.steps[0].with.ref = '${{ needs.authorize.outputs.candidate_sha }}'; }],
  ['financial secret', (job) => { job.steps.at(-1).env.STRIPE_SECRET_KEY = '${{ secrets.STRIPE_SECRET_KEY }}'; }],
  ['credential job output', (job) => { job.outputs.credential = '${{ steps.reader_token.outputs.token }}'; }],
]) {
  test(`reader boundary rejects ${name}`, () => {
    const value = workflow();
    change(value.jobs.reader);
    assert.throws(() => assertWorkflowSecretBoundary(value, path));
  });
}

test('candidate policy job and financial placeholder still cannot receive secrets', () => {
  for (const key of ['policy', 'test', 'publisher']) {
    const value = workflow();
    value.jobs[key].env = { TOKEN: '${{ secrets.BILLING_READER_APP_PRIVATE_KEY }}' };
    assert.throws(() => assertWorkflowSecretBoundary(value, path));
  }
});
