import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const supervisor = await import('../../runner/supervisor.mjs').catch(() => ({}));
const egress = await import('../../runner/egress-proxy.mjs').catch(() => ({}));
const IMAGE = `sha256:${'c'.repeat(64)}`;
const REPOSITORY = 'lawxcompany-stack/billing-validation-control';
const WORKFLOW_REF = `${REPOSITORY}/.github/workflows/validate-billing.yml@refs/heads/main`;
const ACTIONS_ENV_KEYS = ['GITHUB_REPOSITORY', 'GITHUB_EVENT_NAME', 'GITHUB_REF',
  'GITHUB_WORKFLOW_REF', 'GITHUB_REF_PROTECTED'];
const TRUSTED_ACTIONS_ENV = Object.freeze({ GITHUB_REPOSITORY: REPOSITORY,
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
  GITHUB_WORKFLOW_REF: WORKFLOW_REF, GITHUB_REF_PROTECTED: 'true' });

function workflowContext(overrides = {}) {
  const ref = 'refs/heads/main';
  return { repository: REPOSITORY, eventName: 'workflow_dispatch', defaultBranch: 'main', ref,
    workflowRef: `${REPOSITORY}/.github/workflows/validate-billing.yml@${ref}`, ...overrides };
}

async function withActionsRuntime(environment, operation) {
  const previous = new Map(ACTIONS_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ACTIONS_ENV_KEYS) {
    if (Object.hasOwn(environment, key)) process.env[key] = environment[key];
    else delete process.env[key];
  }
  try { return await operation(); }
  finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function invokeSupervisor(options, environment = TRUSTED_ACTIONS_ENV) {
  return withActionsRuntime(environment, () => supervisor.runSupervisedRunner(options));
}

async function fixture(options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'bvc-supervisor-test-'));
  const parentAuth = path.join(root, 'parent.Xauthority');
  await writeFile(parentAuth, 'test-only-empty-display-auth-file', { mode: 0o600 });
  const state = { calls: [], networks: new Map(), containers: new Map(), displayStarted: false, displayStopped: false,
    proxyStarted: false,
    tokenSeenByCreate: false, runnerStarted: false, ...options };
  const runnerWaitStarted = new Promise((resolve) => { state.markRunnerWaitStarted = resolve; });
  const dockerId = (suffix) => `${suffix}${'a'.repeat(60)}`;
  const output = (value) => ({ stdout: `${JSON.stringify(value)}\n` });
  const boundary = {
    dockerContext: 'billing-validation-isolated',
    async run(executable, args, callOptions = {}) {
      if (executable !== 'docker') {
        if (executable === 'xset') return { stdout: '' };
        throw new Error('unexpected_process');
      }
      const [group, action, ...rest] = args;
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
      return { exitCode: null, async stop() { state.displayStopped = true; } };
    },
  };
  return { state, boundary, root, parentAuth, runnerWaitStarted,
    async close() { await rm(root, { recursive: true, force: true }); } };
}

function supervisorOptions(fx, overrides = {}) {
  return { processBoundary: fx.boundary, workflowContext: workflowContext(), image: IMAGE,
    parentDisplay: ':0', parentXauthority: fx.parentAuth,
    additionalEgressHosts: ['preview.example.test', 'api.stripe.com', 'project.example.supabase.co'],
    getRegistrationToken: async () => 'test-only-registration-token', ...overrides };
}

test('caller-supplied workflow context cannot authorize without Actions runtime context', async () => {
  assert.equal(typeof supervisor.runSupervisedRunner, 'function');
  const fx = await fixture();
  let tokenRequests = 0;
  try {
    await assert.rejects(invokeSupervisor(supervisorOptions(fx, {
      workflowContext: workflowContext(),
      getRegistrationToken: async () => { tokenRequests += 1; return 'test-only-registration-token'; },
    }), {}), { code: 'runner_workflow_context_invalid' });
    assert.equal(tokenRequests, 0);
    assert.deepEqual(fx.state.calls, []);
    assert.equal(fx.state.displayStarted, false);
  } finally { await fx.close(); }
});

test('pull_request_target runtime context is rejected before credentials or process invocation', async () => {
  const fx = await fixture();
  let tokenRequests = 0;
  try {
    await assert.rejects(invokeSupervisor(supervisorOptions(fx, {
      workflowContext: workflowContext(),
      getRegistrationToken: async () => { tokenRequests += 1; return 'test-only-registration-token'; },
    }), { ...TRUSTED_ACTIONS_ENV, GITHUB_EVENT_NAME: 'pull_request_target' }),
    { code: 'runner_workflow_context_invalid' });
    assert.equal(tokenRequests, 0);
    assert.deepEqual(fx.state.calls, []);
    assert.equal(fx.state.displayStarted, false);
  } finally { await fx.close(); }
});

test('supervisor rejects mismatched or unprotected Actions runtime context before credentials', async () => {
  const rejected = [
    { ...TRUSTED_ACTIONS_ENV, GITHUB_REPOSITORY: 'untrusted/candidate' },
    { ...TRUSTED_ACTIONS_ENV, GITHUB_EVENT_NAME: 'pull_request' },
    { ...TRUSTED_ACTIONS_ENV, GITHUB_REF: 'refs/heads/feature' },
    { ...TRUSTED_ACTIONS_ENV, GITHUB_WORKFLOW_REF: `${REPOSITORY}/.github/workflows/other.yml@refs/heads/main` },
    { ...TRUSTED_ACTIONS_ENV, GITHUB_REF_PROTECTED: 'false' },
  ];
  for (const environment of rejected) {
    const fx = await fixture();
    let tokenRequests = 0;
    try {
      await assert.rejects(invokeSupervisor(supervisorOptions(fx, {
        getRegistrationToken: async () => { tokenRequests += 1; return 'test-only-registration-token'; },
      }), environment), { code: 'runner_workflow_context_invalid' });
      assert.equal(tokenRequests, 0);
      assert.deepEqual(fx.state.calls, []);
      assert.equal(fx.state.displayStarted, false);
    } finally { await fx.close(); }
  }
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
