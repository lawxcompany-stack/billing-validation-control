import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import YAML from 'yaml';
import { assertWorkflowSecretBoundary } from './secret-boundary.mjs';

const file = '.github/workflows/authorize-local-collector.yml';
function workflow() {
  assert.ok(existsSync(file), 'local authorization workflow is required');
  return YAML.parse(readFileSync(file, 'utf8'));
}

test('local authorization boundary admits only hosted authorize -> reader -> attest-activation', () => {
  const value = workflow();
  assert.doesNotThrow(() => assertWorkflowSecretBoundary(value, file));
  assert.deepEqual(Object.keys(value.jobs), ['authorize', 'reader', 'attest-activation']);
  for (const job of Object.values(value.jobs)) {
    assert.equal(job['runs-on'], 'ubuntu-latest');
    for (const step of job.steps) if (step.run) {
      const result = spawnSync('bash', ['-n'], { input: step.run, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
  }
});

for (const [name, change] of [
  ['extra event', w => { w.on.push = {}; }],
  ['extra dispatch input', w => { w.on.workflow_dispatch.inputs.image = { type: 'string' }; }],
  ['historic operation', w => { w.on.workflow_dispatch.inputs.operation = { type: 'choice', options: ['recover'] }; }],
  ['extra job', w => { w.jobs.exfiltrate = { 'runs-on': 'ubuntu-latest', steps: [{ run: 'env' }] }; }],
  ['workflow environment injection', w => { w.env = { NODE_OPTIONS: '--import attacker.mjs' }; }],
  ['workflow shell injection', w => { w.defaults = { run: { shell: 'bash -c env {0}' } }; }],
  ['top-level signing', w => { w.permissions['id-token'] = 'write'; }],
  ['authorize signing', w => { w.jobs.authorize.permissions.attestations = 'write'; }],
  ['reader signing', w => { w.jobs.reader.permissions['id-token'] = 'write'; }],
  ['authorize skipped', w => { w.jobs.authorize.steps.at(-1).if = '${{ false }}'; }],
  ['authorize extra command', w => { w.jobs.authorize.steps.at(-1).run += '\necho dispatch={} >> "$GITHUB_OUTPUT"'; }],
  ['reader extra command', w => { w.jobs.reader.steps.at(-1).run += '\nenv'; }],
  ['signer extra command', w => { w.jobs['attest-activation'].steps[2].run += '\ncurl attacker'; }],
  ['reader extra step', w => { w.jobs.reader.steps.push({ run: 'env' }); }],
  ['signer extra step', w => { w.jobs['attest-activation'].steps.unshift({ run: 'env' }); }],
  ['authorize extra step', w => { w.jobs.authorize.steps.push({ run: 'env' }); }],
  ['reordered reader steps', w => { w.jobs.reader.steps.reverse(); }],
  ['candidate checkout', w => { w.jobs.reader.steps[0].with.ref = '${{ inputs.candidate_sha }}'; }],
  ['branch checkout', w => { w.jobs.authorize.steps[0].with.ref = 'main'; }],
  ['persisted checkout token', w => { w.jobs.reader.steps[0].with['persist-credentials'] = true; }],
  ['checkout path bypass', w => { w.jobs.reader.steps[0].with.path = 'other'; }],
  ['checkout repository bypass', w => { w.jobs.reader.steps[0].with.repository = 'evil/repo'; }],
  ['checkout sparse bypass', w => { w.jobs.reader.steps[0].with['sparse-checkout'] = 'scripts'; }],
  ['working directory bypass', w => { w.jobs.reader.steps.at(-1)['working-directory'] = '/tmp/evil'; }],
  ['shell bypass', w => { w.jobs.reader.steps.at(-1).shell = 'evil {0}'; }],
  ['reader defaults bypass', w => { w.jobs.reader.defaults = { run: { 'working-directory': '/tmp' } }; }],
  ['dynamic runner', w => { w.jobs.reader['runs-on'] = '${{ inputs.runner }}'; }],
  ['self-hosted signer', w => { w.jobs['attest-activation']['runs-on'] = 'self-hosted'; }],
  ['job container', w => { w.jobs.reader.container = 'evil'; }],
  ['job services', w => { w.jobs.reader.services = { evil: { image: 'evil' } }; }],
  ['job matrix', w => { w.jobs.reader.strategy = { matrix: { command: ['env'] } }; }],
  ['reader guard OR bypass', w => { w.jobs.reader.if = w.jobs.reader.if.replace(' }}', ' || true }}'); }],
  ['signer guard bypass', w => { w.jobs['attest-activation'].if = '${{ always() }}'; }],
  ['authorize branch bypass', w => { w.jobs.authorize.if = '${{ true }}'; }],
  ['reader dependency bypass', w => { delete w.jobs.reader.needs; }],
  ['signer dependency bypass', w => { w.jobs['attest-activation'].needs = 'authorize'; }],
  ['wrong environment', w => { w.jobs['attest-activation'].environment = 'billing-validation-tests'; }],
  ['reader tolerated failure', w => { w.jobs.reader['continue-on-error'] = true; }],
  ['step tolerated failure', w => { w.jobs.reader.steps.at(-1)['continue-on-error'] = true; }],
  ['skipped read', w => { w.jobs.reader.steps.at(-1).if = '${{ false }}'; }],
  ['forged protected environment', w => { w.jobs.reader.steps.at(-1).env.CONTROL_REF_PROTECTED = 'true'; }],
  ['forged control SHA', w => { w.jobs.authorize.steps.at(-1).env.CONTROL_WORKFLOW_SHA = '${{ inputs.candidate_sha }}'; }],
  ['injected release policy', w => { w.jobs.authorize.steps.at(-1).env.RELEASE_POLICY = '${{ inputs.release }}'; }],
  ['direct signer dispatch', w => { w.jobs['attest-activation'].steps[2].env.DISPATCH_INPUTS = '${{ toJSON(inputs) }}'; }],
  ['forged reader receipt', w => { w.jobs['attest-activation'].steps[2].env.CANDIDATE_RECEIPT = '${{ inputs.receipt }}'; }],
  ['financial reader secret', w => { w.jobs.reader.steps.at(-1).env.STRIPE_SECRET_KEY = '${{ secrets.STRIPE_SECRET_KEY }}'; }],
  ['signer reader secret', w => { w.jobs['attest-activation'].steps[2].env.TOKEN = '${{ secrets.BILLING_READER_APP_PRIVATE_KEY }}'; }],
  ['App permissions widened', w => { w.jobs.reader.steps[2].with['permission-actions'] = 'write'; }],
  ['App repository widened', w => { w.jobs.reader.steps[2].with.repositories = 'Plataforma-LawX,other'; }],
  ['App revoke disabled', w => { w.jobs.reader.steps[2].with['skip-token-revoke'] = true; }],
  ['output token', w => { w.jobs.reader.outputs.receipt = '${{ steps.reader_token.outputs.token }}'; }],
  ['output token bracket', w => { w.jobs.reader.outputs.extra = "${{ steps['reader_token']['outputs']['token'] }}"; }],
  ['output token object', w => { w.jobs.reader.outputs.extra = '${{ toJSON(steps.reader_token.outputs) }}'; }],
  ['output private key', w => { w.jobs.reader.outputs.extra = "${{ secrets['BILLING_READER_APP_PRIVATE_KEY'] }}"; }],
  ['authorize output bypass', w => { w.jobs.authorize.outputs.dispatch = '${{ toJSON(inputs) }}'; }],
  ['artifact broad path', w => { w.jobs['attest-activation'].steps.at(-1).with.path = '${{ runner.temp }}'; }],
  ['artifact hidden files', w => { w.jobs['attest-activation'].steps.at(-1).with['include-hidden-files'] = true; }],
  ['artifact symlink path', w => { w.jobs['attest-activation'].steps.at(-1).with.path += '/../*'; }],
  ['attestation wrong subject', w => { w.jobs['attest-activation'].steps[3].with['subject-path'] = 'billing-result.json'; }],
  ['unpinned upload', w => { w.jobs['attest-activation'].steps.at(-1).uses = 'actions/upload-artifact@v4'; }],
  ['writer path injection', w => { w.jobs['attest-activation'].steps[2].env.RUNNER_TEMP = '${{ inputs.path }}'; }],
]) test(`local authorization boundary rejects ${name}`, () => {
  const value = workflow(); change(value);
  assert.throws(() => assertWorkflowSecretBoundary(value, file));
});

for (const output of ["${{ steps['reader_token']['outputs']['token'] }}", '${{ toJSON(steps.reader_token.outputs) }}']) {
  test(`legacy reader still rejects credential output exfiltration: ${output}`, () => {
    const legacy = '.github/workflows/validate-billing.yml';
    const value = YAML.parse(readFileSync(legacy, 'utf8'));
    value.jobs.reader.outputs.extra = output;
    assert.throws(() => assertWorkflowSecretBoundary(value, legacy));
  });
}
