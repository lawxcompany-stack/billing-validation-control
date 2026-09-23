import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importIfMissing, needExport } from '../billing/support.mjs';

const policy = await importIfMissing(() => import('../../runner/container-policy.mjs'));
const createLabel = (...args) => needExport(policy, 'createAttemptRunnerLabel')(...args);
const buildArgs = (...args) => needExport(policy, 'buildRunnerContainerArgs')(...args);
const verifyNetworkPair = (...args) => needExport(policy, 'verifyRunnerNetworkPair')(...args);
const runLifecycle = (...args) => needExport(policy, 'runDisposableRunner')(...args);

function attemptConfig(byte) {
  const suffix = byte.toString(16).padStart(2, '0').repeat(16);
  return { suffix, label: `billing-validation-${suffix}` };
}

function networkPair(suffix) {
  const internal = `bvc-${suffix}-internal`;
  const external = `bvc-${suffix}-external`;
  const proxy = `bvc-${suffix}-proxy`;
  return { internal, external, proxy,
    proxyAlias: 'billing-egress-proxy',
    internalState: { internal: true, containers: [proxy] },
    externalState: { internal: false, containers: [proxy] } };
}

test('runner labels are cryptographically random 128-bit attempt capabilities and cannot be reused', () => {
  const { label } = attemptConfig(0x41);
  assert.equal(createLabel({ randomBytes: (size) => Buffer.alloc(size, 0x41) }), label);
  assert.throws(() => createLabel({ randomBytes: (size) => Buffer.alloc(size, 0x41) }),
    { code: 'runner_label_reused' });
});

test('container argv uses only the dedicated internal network and two read-only display mounts', () => {
  const { suffix, label } = attemptConfig(0x42);
  createLabel({ randomBytes: (size) => Buffer.alloc(size, 0x42) });
  const args = buildArgs({ label,
    image: `sha256:${'a'.repeat(64)}`,
    network: `bvc-${suffix}-internal`,
    networkPair: networkPair(suffix),
    displaySocket: `/run/billing-validation/display/${suffix}/X11-unix/X99`,
    xauthorityFile: `/run/billing-validation/display/${suffix}/Xauthority` });

  assert.equal(args[0], 'run');
  assert.ok(args.includes('--rm'));
  assert.ok(args.includes('--network'));
  assert.equal(args[args.indexOf('--network') + 1], `bvc-${suffix}-internal`);
  const mounts = args.filter((argument) => argument.startsWith('type=bind,'));
  assert.equal(mounts.length, 2);
  assert.ok(mounts.every((mount) => mount.endsWith(',readonly')));
  assert.ok(args.includes('--cap-drop=ALL'));
  assert.ok(args.includes('--security-opt=no-new-privileges'));
  assert.ok(args.includes('RUNNER_REGISTRATION_TOKEN'));
  assert.doesNotMatch(args.join('\n'), /--network host|docker\.sock|\.worktrees|novalawx/iu);
  assert.ok(mounts.every((mount) => !/source=\/home\/|source=\/tmp\/|source=\/run\/docker\.sock/u.test(mount)));
  assert.throws(() => buildArgs({ label,
    image: `sha256:${'a'.repeat(64)}`,
    network: `bvc-${suffix}-internal`,
    networkPair: networkPair(suffix),
    displaySocket: `/run/billing-validation/display/${suffix}/X11-unix/X99`,
    xauthorityFile: `/run/billing-validation/display/${suffix}/Xauthority` }),
  { code: 'runner_label_reused' });
});

test('runner container rejects an unissued or guessed label and arbitrary host mounts', () => {
  const { suffix, label } = attemptConfig(0x43);
  const base = { image: `sha256:${'b'.repeat(64)}`,
    network: `bvc-${suffix}-internal`,
    networkPair: networkPair(suffix),
    displaySocket: `/run/billing-validation/display/${suffix}/X11-unix/X99`,
    xauthorityFile: `/run/billing-validation/display/${suffix}/Xauthority` };
  assert.throws(() => buildArgs({ ...base, label }), { code: 'runner_label_unissued' });
  createLabel({ randomBytes: (size) => Buffer.alloc(size, 0x43) });
  assert.throws(() => buildArgs({ ...base, label,
    displaySocket: '/home/angelo/.X11-unix/X0' }), { code: 'runner_mount_invalid' });
});

test('runner network pair requires internal-only runner access and one proxy on both networks', () => {
  const { suffix } = attemptConfig(0x44);
  const names = { internal: `bvc-${suffix}-internal`, external: `bvc-${suffix}-external`,
    proxy: `bvc-${suffix}-proxy` };
  const topology = { ...names, internalState: { internal: true, containers: [names.proxy] },
    externalState: { internal: false, containers: [names.proxy] }, proxyAlias: 'billing-egress-proxy' };

  assert.equal(verifyNetworkPair(topology), true);
  assert.throws(() => verifyNetworkPair({ ...topology,
    internalState: { internal: false, containers: [names.proxy] } }),
  { code: 'runner_network_not_internal' });
  assert.throws(() => verifyNetworkPair({ ...topology,
    internalState: { internal: true, containers: [names.proxy, 'unexpected-peer'] } }),
  { code: 'runner_network_peer_untrusted' });
  assert.throws(() => verifyNetworkPair({ ...topology,
    externalState: { internal: false, containers: [] } }),
  { code: 'runner_proxy_topology_invalid' });
  assert.throws(() => verifyNetworkPair({ ...topology, proxyAlias: 'unreviewed-proxy' }),
    { code: 'runner_proxy_topology_invalid' });
});

function cleanupSteps(calls, failAt = null) {
  return Object.fromEntries(['removeRunnerContainer', 'removeProxyContainer', 'removeNetworks',
    'stopNestedDisplay', 'removeTemporaryFiles'].map((name) => [name, async () => {
    calls.push(name);
    if (name === failAt) throw new Error('private cleanup failure');
  }]));
}

test('mocked runner cleanup always destroys runner, proxy, networks, display, and temp state in reverse order', async () => {
  const calls = [];
  const result = await runLifecycle({ runRunner: async () => { calls.push('run'); return 'completed'; },
    cleanup: cleanupSteps(calls) });

  assert.equal(result, 'completed');
  assert.deepEqual(calls, ['run', 'removeRunnerContainer', 'removeProxyContainer', 'removeNetworks',
    'stopNestedDisplay', 'removeTemporaryFiles']);
});

test('runner failures, timeout, cancellation, and cleanup errors are sanitized after all cleanup attempts', async () => {
  const failureCalls = [];
  await assert.rejects(runLifecycle({ runRunner: async () => { throw new Error('private runner output'); },
    cleanup: cleanupSteps(failureCalls) }), { code: 'runner_execution_failed' });
  assert.deepEqual(failureCalls, ['removeRunnerContainer', 'removeProxyContainer', 'removeNetworks',
    'stopNestedDisplay', 'removeTemporaryFiles']);

  const controller = new AbortController();
  controller.abort();
  const cancelCalls = [];
  await assert.rejects(runLifecycle({ signal: controller.signal,
    runRunner: async () => { assert.fail('cancelled runner must not start'); },
    cleanup: cleanupSteps(cancelCalls) }), { code: 'runner_cancelled' });
  assert.deepEqual(cancelCalls, ['removeRunnerContainer', 'removeProxyContainer', 'removeNetworks',
    'stopNestedDisplay', 'removeTemporaryFiles']);

  const timeoutCalls = [];
  await assert.rejects(runLifecycle({ timeoutMs: 5, runRunner: async () => new Promise(() => {}),
    cleanup: cleanupSteps(timeoutCalls) }), { code: 'runner_timeout' });
  assert.deepEqual(timeoutCalls, ['removeRunnerContainer', 'removeProxyContainer', 'removeNetworks',
    'stopNestedDisplay', 'removeTemporaryFiles']);

  const cleanupFailureCalls = [];
  await assert.rejects(runLifecycle({ runRunner: async () => 'done',
    cleanup: cleanupSteps(cleanupFailureCalls, 'removeProxyContainer') }),
  { code: 'runner_cleanup_failed' });
  assert.deepEqual(cleanupFailureCalls, ['removeRunnerContainer', 'removeProxyContainer', 'removeNetworks',
    'stopNestedDisplay', 'removeTemporaryFiles']);
});
