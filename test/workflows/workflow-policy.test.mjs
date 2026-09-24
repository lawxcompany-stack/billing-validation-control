import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import YAML from 'yaml';

const workflowPaths = [
  '.github/workflows/validate-billing.yml',
  '.github/workflows/reconcile-billing-checks.yml',
];

function readWorkflow(path) {
  assert.ok(existsSync(path), `Required trusted workflow is missing: ${path}`);
  const parsed = YAML.parse(readFileSync(path, 'utf8'));
  assert.ok(parsed && typeof parsed === 'object', `${path} must parse as a YAML mapping`);
  return parsed;
}

function allSteps(workflow) {
  return Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []);
}

function allActions(workflow) {
  return allSteps(workflow).filter((step) => step.uses).map((step) => step.uses);
}

function isHostedRunner(runsOn) {
  return typeof runsOn === 'string' && runsOn.endsWith('-latest') && !runsOn.includes('self-hosted');
}

test('both workflow files parse as YAML and use only supported event triggers', () => {
  const workflows = workflowPaths.map(readWorkflow);
  const eventNames = workflows.flatMap((workflow) => Object.keys(workflow.on ?? {}));

  assert.ok(eventNames.length > 0);
  assert.ok(!eventNames.includes('pull_request_target'));
  assert.ok(!eventNames.includes('workflow_run'));
});

test('workflow token defaults are limited to contents read', () => {
  for (const path of workflowPaths) {
    const workflow = readWorkflow(path);
    assert.deepEqual(workflow.permissions, { contents: 'read' }, `${path} must use least-privilege defaults`);
    for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
      if (path === workflowPaths[0] && jobId === 'attest-activation') {
        assert.deepEqual(job.permissions, {
          contents: 'read',
          'id-token': 'write',
          attestations: 'write',
        });
        continue;
      }
      assert.ok(!job.permissions || JSON.stringify(job.permissions) === JSON.stringify({ contents: 'read' }),
        `${path}:${jobId} must not widen token permissions`);
    }
  }
});

test('every external action is pinned to a full immutable commit SHA', () => {
  for (const path of workflowPaths) {
    for (const action of allActions(readWorkflow(path))) {
      assert.match(action, /^[^@]+@[0-9a-f]{40}$/i, `${path} has an unpinned action: ${action}`);
    }
  }
});

test('every job has an explicit timeout and only the intended job environments', () => {
  const workflow = readWorkflow(workflowPaths[0]);
  for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
    assert.ok(Number.isInteger(job['timeout-minutes']) && job['timeout-minutes'] > 0,
      `${jobId} must have an explicit timeout`);
  }

  assert.equal(workflow.jobs.reader.environment, 'billing-validation-reader');
  assert.equal(workflow.jobs.test.environment, 'billing-validation-tests');
  assert.equal(workflow.jobs.publisher.environment, 'billing-validation-publisher');
  assert.equal(workflow.jobs.authorize.environment, undefined);
});

test('dispatch authorization runs hosted without an environment before all privileged jobs', () => {
  const workflow = readWorkflow(workflowPaths[0]);
  const { authorize, reader, test: testJob, publisher } = workflow.jobs;

  assert.ok(isHostedRunner(authorize['runs-on']));
  assert.equal(authorize.environment, undefined);
  assert.equal(authorize['timeout-minutes'] <= 10, true);
  assert.equal(reader.needs, 'authorize');
  assert.deepEqual(testJob.needs, ['authorize', 'reader', 'attest-activation']);
  assert.deepEqual(publisher.needs, ['authorize', 'reader', 'test']);
  for (const job of [reader, testJob, publisher]) {
    assert.match(job.if, /needs\.authorize\.result\s*==\s*'success'/);
  }
});

test('authorize and attestation checkouts pin the exact triggering workflow SHA', () => {
  const { authorize, 'attest-activation': attest } = readWorkflow(workflowPaths[0]).jobs;
  const checkoutRef = '${{ github.sha }}';
  const checkoutFor = (job) => job.steps.find((step) => step.uses?.startsWith('actions/checkout@'))?.with?.ref;

  assert.equal(checkoutFor(authorize), checkoutRef);
  assert.equal(checkoutFor(attest), checkoutRef);
});

test('attestation consumes only the validated commitment output from authorization', () => {
  const workflow = readWorkflow(workflowPaths[0]);
  const authorize = workflow.jobs.authorize;
  const attest = workflow.jobs['attest-activation'];
  const manifestStep = attest.steps.find((step) => step.name === 'Compose canonical activation subject');

  assert.equal(authorize.outputs.activation_commitment, '${{ steps.authorize.outputs.activation_commitment }}');
  assert.equal(manifestStep.env.ACTIVATION_COMMITMENT, '${{ needs.authorize.outputs.activation_commitment }}');
  assert.equal(manifestStep.env.CANDIDATE_SHA, '${{ needs.authorize.outputs.candidate_sha }}');
  assert.equal(manifestStep.env.RUNNER_LABEL, '${{ needs.authorize.outputs.runner_label }}');
  assert.equal(manifestStep.env.CANDIDATE_REPOSITORY, undefined,
    'the fixed manifest writer must not consume an untrusted dispatch input');
  assert.ok(!JSON.stringify(attest).includes('${{ inputs.supervisor_activation }}'));
});

test('only hosted collect attestation has signing permissions and runs after authorization', () => {
  const workflow = readWorkflow(workflowPaths[0]);
  const attest = workflow.jobs['attest-activation'];
  assert.ok(attest, 'A hosted attestation job must bind the workstation activation');
  assert.ok(isHostedRunner(attest['runs-on']));
  assert.deepEqual(attest.needs, ['authorize', 'reader']);
  assert.deepEqual(attest.permissions, {
    contents: 'read',
    'id-token': 'write',
    attestations: 'write',
  });
  assert.match(attest.if, /github\.event_name\s*==\s*'workflow_dispatch'/);
  assert.match(attest.if, /github\.ref\s*==\s*'refs\/heads\/main'/);
  assert.match(attest.if, /github\.ref_protected/);
  assert.match(attest.if, /needs\.authorize\.result\s*==\s*'success'/);
  assert.match(attest.if, /needs\.authorize\.outputs\.operation\s*==\s*'collect'/);
  assert.ok(attest.steps.some((step) =>
    step.uses === 'actions/attest@508db95dd578ae2727ebd6217d5ba78e4fbda05d'));

  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    if (jobId !== 'attest-activation') {
      assert.ok(!JSON.stringify(job.permissions ?? {}).includes('id-token') &&
        !JSON.stringify(job.permissions ?? {}).includes('attestations'),
      `${jobId} must not receive signing permissions`);
    }
  }
  const policy = workflow.jobs.policy;
  assert.ok(!JSON.stringify(policy.permissions ?? {}).includes('id-token'));
  assert.ok(!JSON.stringify(policy.permissions ?? {}).includes('attestations'));
});

test('attestation waits for successful candidate reader preflight before signing', () => {
  const attest = readWorkflow(workflowPaths[0]).jobs['attest-activation'];
  assert.deepEqual(attest.needs, ['authorize', 'reader']);
  assert.match(attest.if, /needs\.reader\.result\s*==\s*'success'/);
});

test('self-hosted collect job waits for attestation and makes context comparison its first step', () => {
  const workflow = readWorkflow(workflowPaths[0]);
  const testJob = workflow.jobs.test;
  assert.ok(testJob.needs.includes('attest-activation'));
  assert.equal(testJob.steps[0].name, 'Verify activation metadata before protected work');
  assert.match(testJob.if, /needs\.attest-activation\.result\s*==\s*'success'/);
  const first = testJob.steps[0];
  assert.equal(first.env.BVC_ACTIVATION_COMMITMENT, '${{ needs.authorize.outputs.activation_commitment }}');
  for (const controlField of [
    'CONTROL_REPOSITORY', 'CONTROL_REPOSITORY_ID', 'CONTROL_EVENT_NAME', 'CONTROL_DEFAULT_BRANCH', 'CONTROL_REF',
    'CONTROL_WORKFLOW_REF', 'CONTROL_RUN_ID', 'CONTROL_RUN_ATTEMPT', 'CONTROL_WORKFLOW_SHA',
    'CONTROL_CANDIDATE_SHA', 'CONTROL_ACTIVATION_COMMITMENT', 'CONTROL_RUNNER_LABEL',
  ]) assert.ok(first.run.includes(`'${controlField}'`), `${controlField} must be checked first`);
});

test('workflow run blocks remain valid shell after YAML indentation is removed', () => {
  const workflow = readWorkflow(workflowPaths[0]);
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      if (typeof step.run !== 'string') continue;
      if (step.run.includes("<<'NODE'")) {
        assert.match(step.run, /^NODE$/mu, `${jobId}:${step.name} must close its Node heredoc at column zero`);
      }
      const checked = spawnSync('bash', ['-n'], { input: step.run, encoding: 'utf8' });
      assert.equal(checked.status, 0, `${jobId}:${step.name} must parse as shell: ${checked.stderr}`);
      assert.equal(checked.stderr, '', `${jobId}:${step.name} must not leave shell parser warnings`);
    }
  }
});

test('the collect test job uses the validated per-attempt label and recheck remains hosted', () => {
  const testJob = readWorkflow(workflowPaths[0]).jobs.test;
  const runsOn = testJob['runs-on'];

  assert.equal(typeof runsOn, 'string');
  assert.match(runsOn, /needs\.authorize\.outputs\.runner_label/);
  assert.match(runsOn, /fromJSON\(/);
  assert.match(runsOn, /self-hosted/);
  assert.match(runsOn, /ubuntu-latest/);
  assert.ok(!runsOn.includes('billing-validation-runner'), 'A fixed reusable runner label is forbidden');
  assert.ok(!runsOn.includes('candidate_ref'), 'Candidate refs must not choose the runner');
});

test('PR validation is GitHub-hosted and no privileged workflow runs on pull_request', () => {
  const workflow = readWorkflow(workflowPaths[0]);
  assert.ok(Object.hasOwn(workflow.on, 'pull_request'));

  const pullRequestJobs = Object.entries(workflow.jobs).filter(([, job]) =>
    typeof job.if === 'string' && job.if.includes("github.event_name == 'pull_request'"));
  assert.ok(pullRequestJobs.length > 0);
  for (const [jobId, job] of pullRequestJobs) {
    assert.ok(isHostedRunner(job['runs-on']), `${jobId} must use a GitHub-hosted runner for PR validation`);
    assert.equal(job.environment, undefined, `${jobId} must not reference a secret-bearing environment`);
  }

  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    if (job.if?.includes("github.event_name == 'pull_request'")) continue;
    if (typeof job['runs-on'] === 'string' && job['runs-on'].includes('self-hosted')) {
      assert.match(job.if, /github\.event_name\s*==\s*'workflow_dispatch'/,
        `${jobId} may target self-hosted only for trusted workflow_dispatch runs`);
      assert.match(job.if, /needs\.authorize\.result\s*==\s*'success'/,
        `${jobId} must not target self-hosted before dispatch authorization`);
    }
  }
});

test('control checkout never names the candidate repository or candidate ref', () => {
  for (const path of workflowPaths) {
    for (const step of allSteps(readWorkflow(path))) {
      if (step.uses?.startsWith('actions/checkout@')) {
        assert.equal(step.with?.repository, undefined, 'Checkout must stay in the control repository');
        assert.ok(!JSON.stringify(step.with ?? {}).includes('candidate_ref'));
      }
    }
  }
});

test('the reconcile workflow is protected-ref gated and never targets self-hosted runners', () => {
  const workflow = readWorkflow(workflowPaths[1]);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.ok(Object.keys(workflow.on).every((event) => ['workflow_dispatch'].includes(event)));
  assert.ok(Object.values(workflow.jobs).length > 0);
  for (const job of Object.values(workflow.jobs)) {
    assert.ok(isHostedRunner(job['runs-on']));
    assert.ok(Number.isInteger(job['timeout-minutes']) && job['timeout-minutes'] > 0);
    assert.equal(job.environment, undefined);
  }
  assert.ok(allSteps(workflow).some((step) => step.name === 'Fail closed unless running from the protected default ref'));
});
