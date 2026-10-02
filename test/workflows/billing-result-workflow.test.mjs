import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import YAML from 'yaml';

const workflow = YAML.parse(readFileSync('.github/workflows/validate-billing.yml', 'utf8'));
const repository = 'lawxcompany-stack/billing-validation-control';
const github = {
  event_name: 'workflow_dispatch',
  repository,
  repository_id: '1384018279',
  ref: 'refs/heads/main',
  ref_protected: true,
  event: { repository: { default_branch: 'main' } },
};
const needs = {
  authorize: { result: 'success', outputs: { operation: 'collect', environments_verified: 'true' } },
  reader: { result: 'success' },
  'attest-activation': { result: 'success' },
  test: { result: 'success' },
  'validate-result-input': { result: 'success' },
  'attest-result': { result: 'success' },
  'verify-result': { result: 'success' },
};

function eligible(jobId, context = github, dependencies = needs, isCancelled = false) {
  const expression = workflow.jobs[jobId].if.slice(3, -2)
    .replaceAll('needs.attest-activation', 'needs["attest-activation"]')
    .replaceAll('needs.validate-result-input', 'needs["validate-result-input"]')
    .replaceAll('needs.attest-result', 'needs["attest-result"]')
    .replaceAll('needs.verify-result', 'needs["verify-result"]');
  return vm.runInNewContext(expression, {
    github: context,
    needs: dependencies,
    always: () => true,
    cancelled: () => isCancelled,
  });
}

test('the result signer is a protected hosted emitter that runs only after financial test success', () => {
  const signer = workflow.jobs['attest-result'];
  const inputValidation = workflow.jobs['validate-result-input'];
  assert.ok(inputValidation, 'The no-secret result schema gate is missing');
  assert.equal(inputValidation['runs-on'], 'ubuntu-latest');
  assert.equal(inputValidation.environment, undefined);
  assert.ok(inputValidation.needs.includes('test'));
  assert.match(inputValidation.if, /needs\.test\.result\s*==\s*'success'/);
  assert.deepEqual(inputValidation.permissions, { contents: 'read' });
  assert.equal(inputValidation.steps.at(-1).run, 'node runner/validate-billing-result-input.mjs');
  assert.equal(inputValidation.steps.at(-1).env.BILLING_RESULT_INPUT_PATH,
    '${{ runner.temp }}/billing-45-result-input.json');

  assert.ok(signer, 'The separate financial result signer is missing');
  assert.equal(signer['runs-on'], 'ubuntu-latest');
  assert.equal(signer.environment, 'billing-validation-attestation');
  assert.ok(signer.needs.includes('test'));
  assert.ok(signer.needs.includes('validate-result-input'));
  assert.match(signer.if, /needs\.validate-result-input\.result\s*==\s*'success'/);
  assert.match(signer.if, /needs\.test\.result\s*==\s*'success'/);
  assert.match(signer.if, /github\.ref\s*==\s*'refs\/heads\/main'/);
  assert.match(signer.if, /github\.ref_protected/);
  assert.match(signer.if, /needs\.authorize\.outputs\.operation\s*==\s*'collect'/);
  assert.deepEqual(signer.permissions, {
    contents: 'read',
    'id-token': 'write',
    attestations: 'write',
  });
  const producerStep = signer.steps.find((step) => step.name === 'Compose canonical financial result subject');
  assert.equal(producerStep.env.VERCEL_READ_ONLY_TOKEN,
    '${{ secrets.BILLING_VALIDATION_VERCEL_READ_ONLY_TOKEN }}');
  assert.equal(inputValidation.steps.some((step) => JSON.stringify(step).includes('VERCEL_READ_ONLY_TOKEN')), false);

  const names = signer.steps.map((step) => step.name);
  assert.ok(names.indexOf('Download sanitized financial result input') < names.indexOf('Compose canonical financial result subject'));
  assert.ok(names.indexOf('Compose canonical financial result subject') < names.indexOf('Attest only the canonical financial result subject'));
  assert.ok(names.indexOf('Attest only the canonical financial result subject') < names.indexOf('Upload only the financial result subject'));
  assert.equal(signer.steps.find((step) => step.name === 'Attest only the canonical financial result subject').with['subject-path'],
    '${{ runner.temp }}/billing-result-manifest.json');

  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    if (jobId !== 'attest-activation' && jobId !== 'attest-result') {
      assert.notEqual(job.permissions?.['id-token'], 'write', `${jobId} must not mint an OIDC token`);
      assert.notEqual(job.permissions?.attestations, 'write', `${jobId} must not sign attestations`);
    }
  }
  assert.equal(eligible('attest-result'), true);
  const invalidSchema = structuredClone(needs);
  invalidSchema['validate-result-input'].result = 'failure';
  assert.equal(eligible('attest-result', github, invalidSchema), false);
  assert.equal(eligible('attest-result'), true);
  for (const result of ['failure', 'cancelled', 'skipped']) {
    const blocked = structuredClone(needs);
    blocked.test.result = result;
    assert.equal(eligible('attest-result', github, blocked), false, result);
  }
});

test('secret-free verification gates publishing and recheck stays fail-closed pending original-run proof', () => {
  const workflowSource = readFileSync('.github/workflows/validate-billing.yml', 'utf8');
  const verifyJob = workflow.jobs['verify-result'];
  const publisher = workflow.jobs.publisher;
  assert.ok(verifyJob, 'The secret-free attestation verification gate is missing');
  assert.equal(verifyJob['runs-on'], 'ubuntu-latest');
  assert.equal(verifyJob.environment, undefined, 'verification must happen before a publisher Environment starts');
  assert.ok(verifyJob.needs.includes('attest-result'));
  assert.match(verifyJob.if, /needs\.attest-result\.result\s*==\s*'success'/);
  assert.match(verifyJob.if, /needs\.test\.result\s*==\s*'success'/);
  assert.deepEqual(verifyJob.permissions, { contents: 'read', attestations: 'read' });
  const verifyIndex = verifyJob.steps.findIndex((step) => step.name === 'Verify financial result attestation before publisher Environment');
  assert.ok(verifyIndex >= 0);
  assert.equal(verifyJob.steps[verifyIndex].run, 'node runner/verify-billing-result.mjs');
  assert.equal(verifyJob.steps[verifyIndex].env.GH_TOKEN, '${{ github.token }}');

  assert.ok(publisher.needs.includes('attest-result'));
  assert.ok(publisher.needs.includes('verify-result'));
  assert.match(publisher.if, /needs\.attest-result\.result\s*==\s*'success'/);
  assert.match(publisher.if, /needs\.verify-result\.result\s*==\s*'success'/);
  const failClosedIndex = publisher.steps.findIndex((step) => step.name.includes('Fail closed until canonical check publication'));
  assert.ok(failClosedIndex >= 0, 'Only the successful verification gate can reach publisher work');
  assert.equal(publisher.steps.some((step) => step.name.includes('Verify financial result')), false);
  assert.deepEqual(publisher.permissions, { contents: 'read' });

  assert.equal(eligible('publisher'), true);
  for (const result of ['failure', 'cancelled', 'skipped']) {
    const blocked = structuredClone(needs);
    blocked['attest-result'].result = result;
    assert.equal(eligible('verify-result', github, blocked), false, result);
    assert.equal(eligible('publisher', github, blocked), false, result);
  }
  const schemaFailure = structuredClone(needs);
  schemaFailure['verify-result'].result = 'failure';
  assert.equal(eligible('publisher', github, schemaFailure), false);
  const financialFailure = structuredClone(needs);
  financialFailure.test.result = 'failure';
  assert.equal(eligible('verify-result', github, financialFailure), false);
  assert.equal(eligible('publisher', github, financialFailure), false);
  const recheck = structuredClone(needs);
  recheck.authorize.outputs.operation = 'recheck';
  recheck['attest-activation'].result = 'skipped';
  recheck['attest-result'].result = 'skipped';
  recheck['verify-result'].result = 'skipped';
  assert.equal(eligible('publisher', github, recheck), false,
    'recheck cannot start the publisher Environment without a successful current result attestation');
  assert.match(workflowSource,
    /Recheck deliberately remains fail-closed[^\n]*original run\/attempt[^\n]*activation attestation never proves financial quality/u,
    'recheck must document that prior-run financial identity verification is deferred and activation proof is insufficient');
  assert.deepEqual(workflow.jobs.publisher.needs, [
    'authorize', 'reader', 'attest-activation', 'test', 'attest-result', 'verify-result',
  ]);
});

test('the financial job remains fail-closed and only uploads a result input after success', () => {
  const testJob = workflow.jobs.test;
  const placeholderIndex = testJob.steps.findIndex((step) => step.name === 'Fail closed until the isolated collector is implemented');
  const upload = testJob.steps.find((step) => step.name === 'Upload financial result input only after a passing test');
  assert.ok(placeholderIndex >= 0);
  assert.match(testJob.steps[placeholderIndex].run, /exit 1/u);
  assert.ok(upload);
  assert.match(upload.if, /success\(\)/);
  assert.equal(upload.uses, 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02');
  assert.equal(upload.with.name, 'billing-45-result-input');
  assert.equal(testJob.permissions?.['id-token'], undefined);
  assert.equal(testJob.permissions?.attestations, undefined);
});

test('only the result signer is a post-test writer and activation attestation stays a separate pre-test subject', () => {
  const activation = workflow.jobs['attest-activation'];
  const result = workflow.jobs['attest-result'];
  assert.ok(activation);
  assert.ok(!activation.needs.includes('test'));
  assert.ok(result.needs.includes('test'));
  assert.equal(activation.steps.some((step) => step.with?.['subject-path'] === '${{ runner.temp }}/billing-result-manifest.json'), false);
  assert.equal(result.steps.some((step) => step.with?.['subject-path'] === '${{ runner.temp }}/activation-manifest.json'), false);
});
