import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const supervisor = await import('../../runner/supervisor.mjs').catch(() => ({}));
const supervisorInternal = await import('../../runner/supervisor-internal.mjs').catch(() => ({}));
const workflowContextInternal = await import('../../runner/workflow-context-internal.mjs').catch(() => ({}));
const activationVerifierInternal = await import('../../runner/activation-verifier-internal.mjs').catch(() => ({}));
const egress = await import('../../runner/egress-proxy.mjs').catch(() => ({}));
const IMAGE = `sha256:${'c'.repeat(64)}`;
const REPOSITORY = 'lawxcompany-stack/billing-validation-control';
const REPOSITORY_ID = '12345678';
const RUN_ID = '123456789';
const RUN_ATTEMPT = '2';
const CONTROL_SHA = 'd'.repeat(40);
const CANDIDATE_SHA = 'a'.repeat(40);
const CONTROL_WORKFLOW_PATH = '.github/workflows/validate-billing.yml';
const SELECTED_RUN = Object.freeze({ runId: RUN_ID, runAttempt: RUN_ATTEMPT });

function githubResponse(payload, status = 200, headers = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return new Response(body, { status, headers: { 'content-type': 'application/json', ...headers } });
}

async function withMockFetch(fetchImplementation, operation) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImplementation;
  try { return await operation(); }
  finally { globalThis.fetch = originalFetch; }
}

function validRunAttempt(overrides = {}) {
  return { id: Number(RUN_ID), run_attempt: Number(RUN_ATTEMPT),
    repository: { id: Number(REPOSITORY_ID), full_name: REPOSITORY },
    head_repository: { id: Number(REPOSITORY_ID), full_name: REPOSITORY },
    path: `${CONTROL_WORKFLOW_PATH}@main`, event: 'workflow_dispatch', head_branch: 'main',
    head_sha: CONTROL_SHA, status: 'in_progress', ...overrides };
}

function syntheticGhOutput(manifest, bytes, certificateOverrides = {}) {
  const repositoryUri = `https://github.com/${REPOSITORY}`;
  const workflowUri = `${repositoryUri}/${CONTROL_WORKFLOW_PATH}`;
  const certificate = {
    issuer: 'https://token.actions.githubusercontent.com',
    subjectAlternativeName: `${workflowUri}@refs/heads/main`,
    buildSignerURI: `${workflowUri}@refs/heads/main`,
    buildSignerDigest: manifest.controlWorkflowSha,
    runInvocationURI: `${repositoryUri}/actions/runs/${manifest.runId}/attempts/${manifest.runAttempt}`,
    sourceRepositoryURI: repositoryUri,
    sourceRepositoryIdentifier: REPOSITORY_ID,
    sourceRepositoryRef: 'refs/heads/main',
    sourceRepositoryDigest: manifest.controlWorkflowSha,
    githubWorkflowTrigger: 'workflow_dispatch',
    githubWorkflowRef: 'refs/heads/main',
    githubWorkflowSHA: manifest.controlWorkflowSha,
    runnerEnvironment: 'github-hosted',
    ...certificateOverrides,
  };
  return JSON.stringify([{
    attestation: { synthetic: true },
    verificationResult: {
      signature: { certificate },
      verifiedTimestamps: [{ type: 'rekor', uri: 'https://rekor.sigstore.dev/api/v1/log/entries/synthetic',
        timestamp: '2026-09-23T12:34:56Z' }],
      statement: { subject: [{ name: 'activation-manifest.json', digest: {
        sha256: createHash('sha256').update(bytes).digest('hex'),
      } }], predicateType: 'https://slsa.dev/provenance/v1', predicate: { untrusted: true } },
    },
  }]);
}

function createTestSupervisor(fx) {
  return supervisorInternal.createRunnerSupervisor({
    readSelectedRunAttempt: ({ runId, runAttempt, signal }) =>
      workflowContextInternal.readSelectedRunAttemptWithRepositoryId({ runId, runAttempt,
        reviewedControlRepositoryId: REPOSITORY_ID, signal }),
    verifyActivationAttestation: ({ manifest, signal }) =>
      activationVerifierInternal.verifyActivationAttestationWithBoundary({ manifest,
        processBoundary: fx.boundary, reviewedControlRepositoryId: REPOSITORY_ID, signal }),
  });
}

function invokeSupervisor(options, fetchImplementation = async () => githubResponse(validRunAttempt())) {
  const run = options.__testRun;
  const { __testRun: ignored, ...runOptions } = options;
  assert.equal(typeof run, 'function');
  return withMockFetch(async (input, init) => {
    options.processBoundary.testState.activationEvents.push('api');
    return fetchImplementation(input, init);
  }, () => run(runOptions));
}

async function fixture(options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'bvc-supervisor-test-'));
  const parentAuth = path.join(root, 'parent.Xauthority');
  await writeFile(parentAuth, 'test-only-empty-display-auth-file', { mode: 0o600 });
  const state = { calls: [], processCalls: [], activationEvents: [], networks: new Map(), containers: new Map(), displayStarted: false, displayStopped: false,
    proxyStarted: false,
    tokenSeenByCreate: false, runnerStarted: false, ...options };
  const runnerWaitStarted = new Promise((resolve) => { state.markRunnerWaitStarted = resolve; });
  const dockerId = (suffix) => `${suffix}${'a'.repeat(60)}`;
  const output = (value) => ({ stdout: `${JSON.stringify(value)}\n` });
  const boundary = {
    dockerContext: 'billing-validation-isolated',
    async run(executable, args, callOptions = {}) {
      if (executable === 'gh') {
        state.activationEvents.push('attestation');
        state.processCalls.push({ executable, args: [...args], callOptions });
        if (state.ghFailure) throw new Error('test-only-gh-failure');
        const manifestPath = args[2];
        const bytes = await readFile(manifestPath);
        state.manifestBytes = bytes;
        const manifest = JSON.parse(bytes.toString('utf8'));
        return { stdout: state.ghOutput ?? syntheticGhOutput(manifest, bytes, state.certificateOverrides) };
      }
      if (executable !== 'docker') {
        if (executable === 'xset') return { stdout: '' };
        throw new Error('unexpected_process');
      }
      const [group, action, ...rest] = args;
      if (!state.activationEvents.includes('docker')) state.activationEvents.push('docker');
      state.calls.push({ group, action, rest: rest.filter((item) => !String(item).startsWith('type=bind,source=')), hasRunnerToken:
        Object.hasOwn(callOptions.env ?? {}, 'RUNNER_REGISTRATION_TOKEN') });
      if (group === 'image' && action === 'inspect') return { stdout: `${IMAGE}\n` };
      if (group === 'network' && action === 'create') {
        const name = rest.at(-1);
        const labels = Object.fromEntries(rest.flatMap((item, index) => item === '--label' ? [rest[index + 1].split('=')] : []));
        state.networks.set(name, { Id: dockerId(name.includes('internal') ? '1' : '2'), Name: name,
          Driver: 'bridge', Internal: rest.includes('--internal'), EnableIPv6: false, Labels: labels,
          Containers: {} });
        return { stdout: `${state.networks.get(name).Id}\n` };
      }
      if (group === 'network' && action === 'inspect') {
        const network = state.networks.get(rest[0]) ?? [...state.networks.values()].find((item) => item.Id === rest[0]);
        if (!network) throw new Error('missing_network');
        const inspected = structuredClone(network);
        if (state.badInternal && inspected.Name.endsWith('-internal')) inspected.Internal = false;
        if (state.unexpectedPeer && inspected.Name.endsWith('-internal')) {
          inspected.Containers[dockerId('9')] = { Name: 'untrusted-peer' };
        }
        return output([inspected]);
      }
      if (group === 'network' && action === 'connect') {
        const [networkName, containerId] = rest.filter((item) => !item.startsWith('--'));
        const network = state.networks.get(networkName);
        const container = state.containers.get(containerId);
        network.Containers[containerId] = { Name: container.name };
        return { stdout: '' };
      }
      if (group === 'network' && action === 'rm') {
        if (state.failNetworkRemove) throw new Error('test-only-cleanup-failure');
        for (const id of rest) {
          for (const [name, network] of state.networks) if (network.Id === id) state.networks.delete(name);
        }
        return { stdout: '' };
      }
      if (group === 'network' && action === 'ls') {
        const filter = rest[rest.indexOf('--filter') + 1] ?? '';
        const ids = [...state.networks.values()].filter((network) => filter === 'label=com.billing-validation.run'
          ? true : network.Labels['com.billing-validation.run'] === filter.split('=').at(-1)).map(({ Id }) => Id);
        return { stdout: ids.join('\n') };
      }
      if (group === 'container' && action === 'ls') {
        const filter = rest[rest.indexOf('--filter') + 1] ?? '';
        const ids = [...state.containers.entries()].filter(([, container]) => filter === 'label=com.billing-validation.run'
          ? true : container.labels['com.billing-validation.run'] === filter.split('=').at(-1)).map(([id]) => id);
        if (state.staleContainer && filter === 'label=com.billing-validation.run') ids.push(dockerId('e'));
        return { stdout: ids.join('\n') };
      }
      if (group === 'container' && action === 'inspect') {
        const container = state.containers.get(rest[0]) ?? [...state.containers.values()].find((item) => item.name === rest[0]);
        if (!container) throw new Error('missing_container');
        return output([container.inspect()]);
      }
      if (group === 'create') {
        const name = rest[0];
        const id = name.endsWith('-proxy') ? dockerId('3') : dockerId('4');
        const internalName = [...state.networks.keys()].find((network) => network.endsWith('-internal'));
        const externalName = [...state.networks.keys()].find((network) => network.endsWith('-external'));
        const mounts = rest.filter((item) => item.startsWith('type=bind,')).map((item) => {
          const values = Object.fromEntries(item.split(',').map((part) => part.split('=')));
          return { Type: values.type, Source: values.source, Destination: values.target, RW: !item.endsWith(',readonly') };
        });
        const isProxy = name.endsWith('-proxy');
        const envArgs = [];
        for (let index = 0; index < rest.length; index += 1) {
          if (rest[index] === '--env') envArgs.push(rest[index + 1]);
        }
        const labels = Object.fromEntries(rest.flatMap((item, index) => item === '--label' ? [rest[index + 1].split('=')] : []));
        const inspect = () => ({ Id: id, Name: `/${name}`, Image: IMAGE,
          Config: { Image: IMAGE, Labels: labels, Env: [...envArgs,
            ...(state.tokenSeenByCreate && !isProxy ? ['RUNNER_REGISTRATION_TOKEN=test-only-value'] : [])] },
          HostConfig: { NetworkMode: internalName, Privileged: false, Binds: [],
            CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], Mounts: [],
            ReadonlyRootfs: isProxy },
          Mounts: isProxy ? [] : (state.extraRunnerMount ? [...mounts, { Type: 'bind', Source: '/host', Destination: '/host', RW: true }] : mounts),
          NetworkSettings: { Networks: isProxy ? {
            [internalName]: { Aliases: ['bvc-proxy', 'billing-egress-proxy'] },
            [externalName]: { Aliases: ['bvc-proxy'] },
          } : (state.runnerOnExternal ? {
            [internalName]: { Aliases: ['bvc-runner'] }, [externalName]: { Aliases: ['bvc-runner'] },
          } : { [internalName]: { Aliases: ['bvc-runner'] } }) },
          State: { Running: isProxy ? state.proxyStarted : state.runnerStarted, Health: { Status: 'healthy' } },
        });
        state.containers.set(id, { name, inspect, isProxy, labels });
        state.networks.get(internalName).Containers[id] = { Name: name };
        if (!isProxy) state.tokenSeenByCreate = Object.hasOwn(callOptions.env ?? {}, 'RUNNER_REGISTRATION_TOKEN');
        return { stdout: `${id}\n` };
      }
      if (group === 'container' && action === 'start') {
        const container = state.containers.get(rest[0]);
        if (container?.isProxy) state.proxyStarted = true;
        else if (container) state.runnerStarted = true;
        return { stdout: '' };
      }
      if (group === 'container' && action === 'wait') {
        if (state.blockRunnerWait) return new Promise((resolve, reject) => {
          state.markRunnerWaitStarted();
          callOptions.signal?.addEventListener('abort', () => reject(new Error('test-only-cancel')), { once: true });
        });
        return { stdout: '0\n' };
      }
      if (group === 'container' && action === 'rm') {
        for (const id of rest.filter((item) => !item.startsWith('--'))) {
          const container = state.containers.get(id);
          if (!container) continue;
          state.containers.delete(id);
          for (const network of state.networks.values()) delete network.Containers[id];
        }
        return { stdout: '' };
      }
      throw new Error('unexpected_docker_command');
    },
    async start(executable, args) {
      assert.equal(executable, 'Xephyr');
      assert.ok(args.includes('-nolisten') && args.includes('tcp'));
      state.displayStarted = true;
      state.activationEvents.push('display');
      return { exitCode: null, async stop() { state.displayStopped = true; } };
    },
  };
  boundary.testState = state;
  return { state, boundary, root, parentAuth, runnerWaitStarted,
    async close() { await rm(root, { recursive: true, force: true }); } };
}

function supervisorOptions(fx, overrides = {}) {
  const suppliedPresentation = overrides.presentActivation;
  const suppliedSelection = overrides.selectRun;
  const suppliedTokenProvider = overrides.getRegistrationToken;
  const options = { processBoundary: fx.boundary, image: IMAGE, candidateSha: CANDIDATE_SHA,
    parentDisplay: ':0', parentXauthority: fx.parentAuth,
    additionalEgressHosts: ['preview.example.test', 'api.stripe.com', 'project.example.supabase.co'],
    presentActivation: async (presentation) => {
      fx.state.activationEvents.push('present');
      fx.state.presentation = presentation;
      return suppliedPresentation?.(presentation);
    },
    selectRun: async (presentation, context) => {
      fx.state.activationEvents.push('select');
      fx.state.selectorPresentation = presentation;
      return suppliedSelection ? suppliedSelection(presentation, context) : SELECTED_RUN;
    },
    getRegistrationToken: async (...args) => {
      fx.state.activationEvents.push('token');
      return suppliedTokenProvider ? suppliedTokenProvider(...args) : 'test-only-registration-token';
    },
    ...overrides };
  options.presentActivation = async (presentation) => {
    fx.state.activationEvents.push('present');
    fx.state.presentation = presentation;
    return suppliedPresentation?.(presentation);
  };
  options.selectRun = async (presentation, context) => {
    fx.state.activationEvents.push('select');
    fx.state.selectorPresentation = presentation;
    return suppliedSelection ? suppliedSelection(presentation, context) : SELECTED_RUN;
  };
  options.getRegistrationToken = async (...args) => {
    fx.state.activationEvents.push('token');
    return suppliedTokenProvider ? suppliedTokenProvider(...args) : 'test-only-registration-token';
  };
  options.__testRun = createTestSupervisor(fx);
  return options;
}

test('public supervisor rejects caller-supplied process, proof, and trust-ID seams before callbacks', async () => {
  assert.equal(typeof supervisor.runSupervisedRunner, 'function');
  assert.equal(typeof supervisor.RunnerSupervisorRefusal, 'function');
  const options = {
    image: IMAGE,
    parentDisplay: ':0',
    parentXauthority: '/nonexistent/test-only-authority',
    candidateSha: CANDIDATE_SHA,
    presentActivation: async () => assert.fail('injected trust options must refuse before presentation'),
    selectRun: async () => SELECTED_RUN,
    getRegistrationToken: async () => assert.fail('injected trust options must refuse before token'),
  };
  const fakeBoundary = {
    dockerContext: 'billing-validation-isolated',
    async run() { assert.fail('caller-supplied process boundary must never run'); },
    async start() { assert.fail('caller-supplied process boundary must never start'); },
  };
  for (const injection of [
    { processBoundary: fakeBoundary },
    { verifyActivationAttestation: async () => ({ manifest: {}, manifestDigest: 'f'.repeat(64) }) },
    { readSelectedRunAttempt: async () => validRunAttempt() },
    { reviewedControlRepositoryId: REPOSITORY_ID },
  ]) {
    await assert.rejects(supervisor.runSupervisedRunner({ ...options, ...injection }),
      { code: 'runner_supervisor_config_invalid' });
  }
});

test('public supervisor uses only its fixed process and proof boundaries and fails closed while trust ID is unset', async () => {
  const events = [];
  let tokenCalls = 0;
  await assert.rejects(supervisor.runSupervisedRunner({
    image: IMAGE,
    parentDisplay: ':0',
    parentXauthority: '/nonexistent/test-only-authority',
    candidateSha: CANDIDATE_SHA,
    presentActivation: async () => { events.push('present'); },
    selectRun: async () => { events.push('select'); return SELECTED_RUN; },
    getRegistrationToken: async () => { tokenCalls += 1; return 'synthetic-token'; },
  }), { code: 'runner_workflow_context_invalid' });
  assert.deepEqual(events, ['present', 'select']);
  assert.equal(tokenCalls, 0);
});

test('supervisor refuses process boundaries not bound to the isolated Docker context', async () => {
  const fx = await fixture();
  let tokenRequests = 0;
  try {
    await assert.rejects(invokeSupervisor(supervisorOptions(fx, {
      processBoundary: { ...fx.boundary, dockerContext: 'default' },
      getRegistrationToken: async () => { tokenRequests += 1; return 'test-only-registration-token'; },
    })), { code: 'runner_docker_context_untrusted' });
    assert.equal(tokenRequests, 0);
    assert.deepEqual(fx.state.calls, []);
  } finally { await fx.close(); }
});

test('supervisor creates and inspects isolated networks, proxy, display and one-job runner, then cleans every resource', async () => {
  assert.equal(typeof supervisor.runSupervisedRunner, 'function');
  const fx = await fixture();
  try {
    const result = await invokeSupervisor(supervisorOptions(fx));
    assert.match(result.runnerLabel, /^billing-validation-[0-9a-f]{32}$/u);
    assert.equal(result.exitCode, 0);
    assert.equal(fx.state.runnerStarted, true);
    assert.equal(fx.state.displayStopped, true);
    assert.equal(fx.state.networks.size, 0);
    assert.equal(fx.state.containers.size, 0);
    assert.ok(fx.state.calls.some(({ group, action }) => group === 'network' && action === 'inspect'));
    assert.ok(fx.state.calls.some(({ group, action }) => group === 'container' && action === 'inspect'));
    const runnerCreate = fx.state.calls.find(({ group, rest }) => group === 'create' && rest.some((arg) => String(arg).endsWith('-runner')));
    assert.ok(runnerCreate);
    assert.ok(runnerCreate.rest.includes('--network'));
    assert.match(runnerCreate.rest[runnerCreate.rest.indexOf('--network') + 1], /-internal$/u);
    assert.equal(runnerCreate.hasRunnerToken, true);
  } finally { await fx.close(); }
});

test('supervisor refuses unsafe inspected network topology without consuming runner credentials', async () => {
  assert.equal(typeof supervisor.runSupervisedRunner, 'function');
  const fx = await fixture({ badInternal: true });
  let tokenRequests = 0;
  try {
    await assert.rejects(invokeSupervisor(supervisorOptions(fx, {
      getRegistrationToken: async () => { tokenRequests += 1; return 'test-only-registration-token'; },
      internalState: { Internal: true, Containers: {} },
    })), { code: 'runner_network_not_internal' });
    assert.equal(tokenRequests, 0);
    assert.equal(fx.state.networks.size, 0);
  } finally { await fx.close(); }
});

test('supervisor refuses unexpected network peers and runner host mounts or external attachments', async () => {
  assert.equal(typeof supervisor.runSupervisedRunner, 'function');
  for (const state of [{ unexpectedPeer: true }, { extraRunnerMount: true }, { runnerOnExternal: true }]) {
    const fx = await fixture(state);
    try {
      await assert.rejects(invokeSupervisor(supervisorOptions(fx)));
      assert.equal(fx.state.runnerStarted, false);
      assert.equal(fx.state.networks.size, 0);
      assert.equal(fx.state.containers.size, 0);
      assert.equal(!fx.state.displayStarted || fx.state.displayStopped, true);
    } finally { await fx.close(); }
  }
});

test('runner container receives headed display and Xauthority paths from the verified nested display', async () => {
  assert.equal(typeof supervisor.runSupervisedRunner, 'function');
  const fx = await fixture();
  try {
    await invokeSupervisor(supervisorOptions(fx));
    const runnerCreate = fx.state.calls.find(({ group, action, rest }) => group === 'create' && rest.some((arg) => String(arg).endsWith('-runner')));
    assert.ok(runnerCreate);
    assert.ok(runnerCreate.rest.some((arg) => arg === 'DISPLAY=:99'));
    assert.ok(runnerCreate.rest.some((arg) => arg === 'XAUTHORITY=/run/billing-validation/Xauthority'));
  } finally { await fx.close(); }
});

test('timeout and cancellation still attempt runner, proxy, network, display and temporary cleanup', async () => {
  assert.equal(typeof supervisor.runSupervisedRunner, 'function');
  for (const mode of ['cancel', 'timeout']) {
    const fx = await fixture({ blockRunnerWait: true });
    const controller = new AbortController();
    try {
      const run = invokeSupervisor(supervisorOptions(fx, mode === 'cancel'
        ? { signal: controller.signal } : { timeoutMs: 250 }));
      await fx.runnerWaitStarted;
      if (mode === 'cancel') controller.abort();
      await assert.rejects(run, { code: mode === 'cancel' ? 'runner_cancelled' : 'runner_timeout' });
      assert.equal(fx.state.networks.size, 0);
      assert.equal(fx.state.containers.size, 0);
      assert.equal(fx.state.displayStopped, true);
    } finally { await fx.close(); }
  }
});

test('supervisor refuses pre-existing labeled resources without deleting or reusing them', async () => {
  assert.equal(typeof supervisor.runSupervisedRunner, 'function');
  const fx = await fixture({ staleContainer: true });
  let tokenRequests = 0;
  try {
    await assert.rejects(invokeSupervisor(supervisorOptions(fx, {
      getRegistrationToken: async () => { tokenRequests += 1; return 'test-only-registration-token'; },
    })), { code: 'runner_stale_resources_present' });
    assert.equal(tokenRequests, 0);
    assert.equal(fx.state.runnerStarted, false);
    assert.ok(!fx.state.calls.some(({ group, action }) => group === 'create' ||
      (group === 'container' && action === 'rm') || (group === 'network' && action === 'rm')));
  } finally { await fx.close(); }
});

test('egress allowlist and address checks reject broad domains, private networks and metadata targets', () => {
  assert.equal(typeof egress.buildEgressAllowlist, 'function');
  assert.equal(typeof egress.assertPublicAddresses, 'function');
  const hosts = egress.buildEgressAllowlist(['preview.example.test', 'api.stripe.com']);
  assert.ok(hosts.includes('github.com') && hosts.includes('*.actions.githubusercontent.com'));
  assert.throws(() => egress.buildEgressAllowlist(['*.githubusercontent.com']),
    { code: 'egress_destination_not_allowlisted' });
  for (const address of ['127.0.0.1', '10.0.0.4', '169.254.169.254', '192.168.1.2', '::1', 'fe80::1']) {
    assert.throws(() => egress.assertPublicAddresses([{ address }]), { code: 'egress_private_address_refused' });
  }
  assert.doesNotThrow(() => egress.assertPublicAddresses([{ address: '8.8.8.8' }]));
});

test('ambiguous cleanup latches the supervisor closed before another attempt can start', async () => {
  assert.equal(typeof supervisor.runSupervisedRunner, 'function');
  const fx = await fixture({ failNetworkRemove: true });
  try {
    await assert.rejects(invokeSupervisor(supervisorOptions(fx)),
      { code: 'runner_cleanup_failed' });
    assert.equal(fx.state.displayStopped, true);
    const callsAfterFailure = fx.state.calls.length;
    await assert.rejects(invokeSupervisor(supervisorOptions(fx)),
      { code: 'runner_cleanup_unverified' });
    assert.equal(fx.state.calls.length, callsAfterFailure);
  } finally { await fx.close(); }
});
