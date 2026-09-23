import { randomBytes as secureRandomBytes } from 'node:crypto';

const issuedLabels = new Set();
const configuredLabels = new Set();
const CLEANUP_STEPS = Object.freeze(['removeRunnerContainer', 'removeProxyContainer',
  'removeNetworks', 'stopNestedDisplay', 'removeTemporaryFiles']);
const MAX_LIFECYCLE_TIMEOUT_MS = 6 * 60 * 60 * 1000;

export class RunnerPolicyRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = 'RunnerPolicyRefusal';
    this.code = code;
  }
}

function refuse(code) {
  throw new RunnerPolicyRefusal(code);
}

export function createAttemptRunnerLabel({ randomBytes = secureRandomBytes } = {}) {
  if (typeof randomBytes !== 'function') refuse('runner_random_source_invalid');
  let bytes;
  try { bytes = randomBytes(16); } catch { refuse('runner_random_source_unavailable'); }
  if (!Buffer.isBuffer(bytes) || bytes.length !== 16) refuse('runner_random_source_unavailable');
  const label = `billing-validation-${bytes.toString('hex')}`;
  if (issuedLabels.has(label)) refuse('runner_label_reused');
  issuedLabels.add(label);
  return label;
}

function attemptSuffix(label) {
  const match = /^billing-validation-([0-9a-f]{32})$/u.exec(label ?? '');
  if (!match) refuse('runner_label_invalid');
  return match[1];
}

export function verifyRunnerNetworkPair({ internal, external, proxy, proxyAlias,
  internalState, externalState } = {}) {
  const internalMatch = /^bvc-([0-9a-f]{32})-internal$/u.exec(internal ?? '');
  const externalMatch = /^bvc-([0-9a-f]{32})-external$/u.exec(external ?? '');
  const proxyMatch = /^bvc-([0-9a-f]{32})-proxy$/u.exec(proxy ?? '');
  if (!internalMatch || !externalMatch || !proxyMatch || internalMatch[1] !== externalMatch[1] ||
      internalMatch[1] !== proxyMatch[1]) refuse('runner_network_identity_invalid');
  if (proxyAlias !== 'billing-egress-proxy') refuse('runner_proxy_topology_invalid');
  if (internalState?.internal !== true) refuse('runner_network_not_internal');
  if (externalState?.internal !== false || !Array.isArray(internalState.containers) ||
      !Array.isArray(externalState.containers)) refuse('runner_proxy_topology_invalid');
  if (internalState.containers.length !== 1 || externalState.containers.length !== 1 ||
      internalState.containers[0] !== proxy || externalState.containers[0] !== proxy) {
    if (internalState.containers.includes(proxy) && externalState.containers.includes(proxy)) {
      refuse('runner_network_peer_untrusted');
    }
    refuse('runner_proxy_topology_invalid');
  }
  return true;
}

export function buildRunnerContainerArgs({ label, image, network, networkPair,
  displaySocket, xauthorityFile } = {}) {
  const suffix = attemptSuffix(label);
  if (!issuedLabels.has(label)) refuse('runner_label_unissued');
  if (configuredLabels.has(label)) refuse('runner_label_reused');
  if (typeof image !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(image)) {
    refuse('runner_image_not_pinned');
  }
  if (network !== `bvc-${suffix}-internal`) refuse('runner_network_identity_invalid');
  verifyRunnerNetworkPair(networkPair);
  if (networkPair.internal !== network) refuse('runner_network_identity_invalid');
  const displayRoot = `/run/billing-validation/display/${suffix}`;
  if (displaySocket !== `${displayRoot}/X11-unix/X99` || xauthorityFile !== `${displayRoot}/Xauthority`) {
    refuse('runner_mount_invalid');
  }

  configuredLabels.add(label);
  return Object.freeze(['run', '--rm', '--name', `bvc-${suffix}-runner`,
    '--label', `billing-validation.attempt=${suffix}`,
    '--label', `billing-validation.runner-label=${label}`,
    '--network', network, '--pull=never',
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=256',
    '--memory=8g', '--cpus=4', '--shm-size=1g',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=512m',
    '--tmpfs', '/home/billing-runner:rw,nosuid,nodev,size=128m',
    '--tmpfs', '/opt/actions-runner/_work:rw,nosuid,nodev,size=2g',
    '--mount', `type=bind,source=${displaySocket},target=/tmp/.X11-unix/X99,readonly`,
    '--mount', `type=bind,source=${xauthorityFile},target=/run/billing-validation/Xauthority,readonly`,
    '--env', 'GITHUB_REPOSITORY=lawxcompany-stack/billing-validation-control',
    '--env', `RUNNER_LABEL=${label}`, '--env', 'RUNNER_REGISTRATION_TOKEN', image]);
}

export async function runDisposableRunner({ runRunner, cleanup, signal, timeoutMs = 45 * 60 * 1000 } = {}) {
  if (typeof runRunner !== 'function' || !cleanup || typeof cleanup !== 'object' ||
      CLEANUP_STEPS.some((step) => typeof cleanup[step] !== 'function') ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_LIFECYCLE_TIMEOUT_MS ||
      (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean' ||
        typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function'))) {
    refuse('runner_lifecycle_config_invalid');
  }

  const controller = new AbortController();
  let abortCode = 'runner_cancelled';
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  void aborted.catch(() => {});
  const onAbort = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    rejectAbort(new RunnerPolicyRefusal(abortCode));
  };
  const onExternalAbort = () => onAbort();
  const timer = setTimeout(() => {
    abortCode = 'runner_timeout';
    onAbort();
  }, timeoutMs);
  signal?.addEventListener('abort', onExternalAbort, { once: true });
  if (signal?.aborted) onExternalAbort();

  let result;
  let runFailure;
  if (!controller.signal.aborted) {
    try {
      result = await Promise.race([Promise.resolve().then(() => runRunner({ signal: controller.signal })), aborted]);
    } catch (error) {
      runFailure = error instanceof RunnerPolicyRefusal ? error : new RunnerPolicyRefusal('runner_execution_failed');
    }
  } else {
    runFailure = new RunnerPolicyRefusal('runner_cancelled');
  }

  clearTimeout(timer);
  signal?.removeEventListener('abort', onExternalAbort);
  if (!controller.signal.aborted) controller.abort();

  let cleanupFailed = false;
  for (const step of CLEANUP_STEPS) {
    try { await cleanup[step](); }
    catch { cleanupFailed = true; }
  }
  if (cleanupFailed) refuse('runner_cleanup_failed');
  if (runFailure) throw runFailure;
  return result;
}
