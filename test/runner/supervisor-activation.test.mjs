import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { serializeActivationManifest } from '../../runner/activation-manifest.mjs';
import { createRunnerSupervisor } from '../../runner/supervisor-internal.mjs';

const REPOSITORY = 'lawxcompany-stack/billing-validation-control';
const REPOSITORY_ID = '12345678';
const WORKFLOW_PATH = '.github/workflows/validate-billing.yml';
const RUN_ID = '123456789';
const RUN_ATTEMPT = '2';
const CONTROL_SHA = 'd'.repeat(40);
const CANDIDATE_SHA = 'a'.repeat(40);
const RUN_LABEL = `billing-validation-${'b'.repeat(32)}`;
const RUN_SELECTORS = Object.freeze({ runId: RUN_ID, runAttempt: RUN_ATTEMPT });

function validContext(overrides = {}) {
  return Object.freeze({
    repository: REPOSITORY,
    repositoryId: REPOSITORY_ID,
    eventName: 'workflow_dispatch',
    defaultBranch: 'main',
    ref: 'refs/heads/main',
    workflowPath: WORKFLOW_PATH,
    workflowRef: `${REPOSITORY}/${WORKFLOW_PATH}@refs/heads/main`,
    runId: RUN_ID,
    runAttempt: RUN_ATTEMPT,
    workflowSha: CONTROL_SHA,
    runnerGroup: 'billing-validation-isolated',
    ...overrides,
  });
}

function testChallenge({ candidateSha, runnerLabel }, { consumed = false, expireAt = 0 } = {}) {
  let checks = 0;
  const state = { consumeCalls: 0, destroyCalls: 0, consumed };
  const commitment = 'c'.repeat(64);
  const presentation = Object.freeze({ commitment, candidateSha, runnerLabel });
  return {
    state,
    challenge: Object.freeze({ commitment, candidateSha, runnerLabel, presentation,
      assertUsable() {
        checks += 1;
        if (state.consumed) throw Object.assign(new Error('consumed'), { code: 'activation_challenge_consumed' });
        if (checks === expireAt) throw Object.assign(new Error('expired'), { code: 'activation_challenge_expired' });
      },
      consume() { state.consumeCalls += 1; state.consumed = true; },
      destroy() { state.destroyCalls += 1; state.consumed = true; },
    }),
  };
}

function manifestFor(context, presentation) {
  return Object.freeze({
    activationCommitment: presentation.commitment,
    candidateRepository: 'lawxcompany-stack/Plataforma-LawX',
    candidateSha: presentation.candidateSha,
    runnerLabel: presentation.runnerLabel,
    controlRepository: context.repository,
    controlRepositoryId: context.repositoryId,
    controlRef: context.ref,
    controlWorkflowPath: context.workflowPath,
    runId: context.runId,
    runAttempt: context.runAttempt,
    controlWorkflowSha: context.workflowSha,
    eventName: context.eventName,
  });
}

function harness({ context = validContext(), challengeFactory, verify, readRun } = {}) {
  const state = { events: [], dockerCalls: [], displayCalls: 0, tokenCalls: 0, presentations: [], selectors: [] };
  const dependencies = {
    labelFactory: () => RUN_LABEL,
    readSelectedRunAttempt: async (selectors) => {
      state.events.push('read-run');
      state.selectors.push(selectors);
      return readRun ? readRun(selectors, context) : context;
    },
    verifyActivationAttestation: async ({ manifest }) => {
      state.events.push('verify-attestation');
      return verify ? verify(manifest) : {
        manifest,
        manifestDigest: createHash('sha256').update(serializeActivationManifest(manifest), 'utf8').digest('hex'),
      };
    },
    ...(challengeFactory ? { challengeFactory } : {}),
  };
  const run = createRunnerSupervisor(dependencies);
  const processBoundary = {
    dockerContext: 'billing-validation-isolated',
    async run(_executable, args) {
      state.events.push('docker');
      state.dockerCalls.push(args);
      return { stdout: '' };
    },
    async start() {
      state.events.push('display');
      state.displayCalls += 1;
      return { exitCode: null, async stop() {} };
    },
  };
  const options = {
    processBoundary,
    image: `sha256:${'f'.repeat(64)}`,
    parentDisplay: ':0',
    parentXauthority: '/path/that/does/not/exist',
    candidateSha: CANDIDATE_SHA,
    getRegistrationToken: async () => {
      state.events.push('token');
      state.tokenCalls += 1;
      return 'synthetic-registration-token';
    },
    presentActivation: async (presentation) => {
      state.events.push('present');
      state.presentations.push(presentation);
    },
    selectRun: async (presentation) => {
      state.events.push('select');
      assert.deepEqual(presentation, state.presentations.at(-1));
      return RUN_SELECTORS;
    },
  };
  return { state, run, options };
}

test('missing presentation or selector callbacks refuse before challenge, process, display or token', async () => {
  let challenges = 0;
  const factory = (input) => { challenges += 1; return testChallenge(input).challenge; };
  for (const missing of ['presentActivation', 'selectRun']) {
    const { state, run, options } = harness({ challengeFactory: factory });
    delete options[missing];
    await assert.rejects(run(options), { code: 'runner_supervisor_config_invalid' });
    assert.equal(challenges, 0);
    assert.equal(state.events.length, 0);
    assert.equal(state.tokenCalls, 0);
    assert.equal(state.displayCalls, 0);
    assert.equal(state.dockerCalls.length, 0);
  }
});

test('challenge is presented before untrusted selectors and consumed before parent display access', async () => {
  const challengeFixture = testChallenge({ candidateSha: CANDIDATE_SHA, runnerLabel: RUN_LABEL });
  const { state, run, options } = harness({
    challengeFactory: () => challengeFixture.challenge,
    verify: async (manifest) => ({ manifest,
      manifestDigest: createHash('sha256').update(serializeActivationManifest(manifest), 'utf8').digest('hex') }),
  });
  await assert.rejects(run(options), { code: 'runner_display_auth_invalid' });
  assert.deepEqual(Object.keys(state.presentations[0]).sort(), ['candidateSha', 'commitment', 'runnerLabel']);
  assert.deepEqual(state.events, ['present', 'select', 'read-run', 'verify-attestation']);
  assert.equal(challengeFixture.state.consumeCalls, 1);
  assert.equal(challengeFixture.state.destroyCalls, 1);
  assert.equal(state.tokenCalls, 0);
  assert.equal(state.displayCalls, 0);
  assert.equal(state.dockerCalls.length, 0);
});

test('invalid attestation refuses before challenge consumption, Xauthority, Docker, display or token', async () => {
  const challengeFixture = testChallenge({ candidateSha: CANDIDATE_SHA, runnerLabel: RUN_LABEL });
  const { state, run, options } = harness({
    challengeFactory: () => challengeFixture.challenge,
    verify: async () => { const error = new Error('invalid synthetic proof'); error.code = 'activation_attestation_invalid'; throw error; },
  });
  await assert.rejects(run(options), { code: 'activation_attestation_invalid' });
  assert.deepEqual(state.events, ['present', 'select', 'read-run', 'verify-attestation']);
  assert.equal(challengeFixture.state.consumeCalls, 0);
  assert.equal(challengeFixture.state.destroyCalls, 1);
  assert.equal(state.tokenCalls, 0);
  assert.equal(state.displayCalls, 0);
  assert.equal(state.dockerCalls.length, 0);
});

test('every attested manifest field must equal the locally reconstructed challenge manifest', async () => {
  const alterations = [
    ['activation commitment', (manifest) => ({ ...manifest, activationCommitment: 'e'.repeat(64) })],
    ['candidate SHA', (manifest) => ({ ...manifest, candidateSha: 'e'.repeat(40) })],
    ['runner label', (manifest) => ({ ...manifest, runnerLabel: `billing-validation-${'e'.repeat(32)}` })],
    ['repository ID', (manifest) => ({ ...manifest, controlRepositoryId: '87654321' })],
    ['run ID', (manifest) => ({ ...manifest, runId: '987654321' })],
    ['run attempt', (manifest) => ({ ...manifest, runAttempt: '3' })],
    ['workflow SHA', (manifest) => ({ ...manifest, controlWorkflowSha: 'e'.repeat(40) })],
  ];
  for (const [field, mutate] of alterations) {
    const challengeFixture = testChallenge({ candidateSha: CANDIDATE_SHA, runnerLabel: RUN_LABEL });
    const { state, run, options } = harness({
      challengeFactory: () => challengeFixture.challenge,
      verify: async (manifest) => ({ manifest: mutate(manifest),
        manifestDigest: createHash('sha256').update(serializeActivationManifest(manifest), 'utf8').digest('hex') }),
    });
    await assert.rejects(run(options), (error) => {
      assert.equal(error.code.startsWith('activation_'), true, field);
      return true;
    });
    assert.equal(challengeFixture.state.consumeCalls, 0, field);
    assert.equal(state.tokenCalls, 0, field);
    assert.equal(state.displayCalls, 0, field);
    assert.equal(state.dockerCalls.length, 0, field);
  }
});

test('selected run ID/attempt mismatch refuses before verifier and every protected side effect', async () => {
  for (const [field, replacement] of [['runId', '123456788'], ['runAttempt', '1']]) {
    const challengeFixture = testChallenge({ candidateSha: CANDIDATE_SHA, runnerLabel: RUN_LABEL });
    const { state, run, options } = harness({
      challengeFactory: () => challengeFixture.challenge,
      readRun: (_selectors, context) => ({ ...context, [field]: replacement }),
    });
    await assert.rejects(run(options), { code: 'runner_workflow_context_invalid' });
    assert.equal(state.events.includes('verify-attestation'), false);
    assert.equal(challengeFixture.state.consumeCalls, 0);
    assert.equal(state.tokenCalls, 0);
    assert.equal(state.displayCalls, 0);
    assert.equal(state.dockerCalls.length, 0);
  }
});

test('expired, replayed and cancelled challenges are destroyed without protected side effects', async () => {
  const expired = testChallenge({ candidateSha: CANDIDATE_SHA, runnerLabel: RUN_LABEL }, { expireAt: 2 });
  const expiredHarness = harness({ challengeFactory: () => expired.challenge });
  await assert.rejects(expiredHarness.run(expiredHarness.options), { code: 'activation_challenge_expired' });
  assert.equal(expired.state.destroyCalls, 1);
  assert.equal(expiredHarness.state.tokenCalls, 0);
  assert.equal(expiredHarness.state.dockerCalls.length, 0);
  assert.equal(expiredHarness.state.displayCalls, 0);

  const replay = testChallenge({ candidateSha: CANDIDATE_SHA, runnerLabel: RUN_LABEL });
  const replayHarness = harness({ challengeFactory: () => replay.challenge });
  await assert.rejects(replayHarness.run(replayHarness.options), { code: 'runner_display_auth_invalid' });
  const eventsAfterFirstAttempt = replayHarness.state.events.length;
  await assert.rejects(replayHarness.run(replayHarness.options), { code: 'activation_challenge_consumed' });
  assert.equal(replayHarness.state.events.slice(eventsAfterFirstAttempt).length, 0,
    'a consumed challenge must be rejected before it is presented again');
  assert.equal(replayHarness.state.tokenCalls, 0);
  assert.equal(replayHarness.state.dockerCalls.length, 0);
  assert.equal(replayHarness.state.displayCalls, 0);

  const cancelled = testChallenge({ candidateSha: CANDIDATE_SHA, runnerLabel: RUN_LABEL });
  const cancelledHarness = harness({ challengeFactory: () => cancelled.challenge });
  const controller = new AbortController();
  const cancelledOptions = { ...cancelledHarness.options, signal: controller.signal,
    selectRun: async (_presentation, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      setImmediate(() => controller.abort());
    }) };
  await assert.rejects(cancelledHarness.run(cancelledOptions), { code: 'runner_cancelled' });
  assert.equal(cancelled.state.consumeCalls, 0);
  assert.equal(cancelled.state.destroyCalls, 1);
  assert.equal(cancelledHarness.state.tokenCalls, 0);
  assert.equal(cancelledHarness.state.dockerCalls.length, 0);
  assert.equal(cancelledHarness.state.displayCalls, 0);
});
