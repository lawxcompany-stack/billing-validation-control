import { randomBytes as secureRandomBytes } from 'node:crypto';
import { mkdtemp, lstat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildEgressAllowlist } from './egress-proxy.mjs';
import { createAttemptRunnerLabel } from './container-policy.mjs';
import { ISOLATED_DOCKER_CONTEXT } from './process-boundary.mjs';
import { ISOLATED_RUNNER_GROUP, validateRunnerWorkflowContext } from './workflow-context.mjs';

const DISPLAY_NUMBER = 99;
const DISPLAY_SOCKET = `/tmp/.X11-unix/X${DISPLAY_NUMBER}`;
const DISPLAY = `:${DISPLAY_NUMBER}`;
const RUNNER_XAUTHORITY = '/run/billing-validation/Xauthority';
const INTERNAL_PROXY_ALIAS = 'billing-egress-proxy';
const PROXY_PORT = 3128;
const MAX_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const activeDisplay = { value: false };
let cleanupUnverified = false;

export class RunnerSupervisorRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = 'RunnerSupervisorRefusal';
    this.code = code;
  }
}

function refuse(code) {
  throw new RunnerSupervisorRefusal(code);
}

function suffixFromLabel(label) {
  const match = /^billing-validation-([0-9a-f]{32})$/u.exec(label ?? '');
  if (!match) refuse('runner_label_invalid');
  return match[1];
}

function parseJson(stdout, code) {
  try { return JSON.parse(stdout); } catch { refuse(code); }
}

function inspectOne(stdout, code) {
  const rows = parseJson(stdout, code);
  if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || typeof rows[0] !== 'object') refuse(code);
  return rows[0];
}

function validImageId(image) {
  return typeof image === 'string' && /^sha256:[a-f0-9]{64}$/u.test(image);
}

function validParentDisplay(display) {
  return typeof display === 'string' && /^(:[0-9]{1,4}(?:\.[0-9]{1,3})?|unix\/:[0-9]{1,4}(?:\.[0-9]{1,3})?)$/u.test(display);
}

function labelsFor(attemptSuffix, runId, role) {
  return { 'com.billing-validation.attempt': attemptSuffix,
    'com.billing-validation.run': runId, 'com.billing-validation.role': role };
}

function hasExactLabels(actual, expected) {
  return actual && typeof actual === 'object' &&
    Object.entries(expected).every(([key, value]) => actual[key] === value);
}

function networkMembers(network) {
  if (!network.Containers || typeof network.Containers !== 'object' || Array.isArray(network.Containers)) {
    refuse('runner_network_inspection_invalid');
  }
  return Object.entries(network.Containers).map(([id, container]) => ({ id, name: container?.Name }));
}

function verifyNetwork(network, { name, internal, attemptSuffix, runId, members }) {
  if (network.Name !== name || network.Driver !== 'bridge' || network.Internal !== internal ||
      network.EnableIPv6 !== false || !hasExactLabels(network.Labels, labelsFor(attemptSuffix, runId,
        internal ? 'internal-network' : 'external-network'))) {
    refuse(internal ? 'runner_network_not_internal' : 'runner_network_topology_invalid');
  }
  const actualMembers = networkMembers(network);
  const byId = new Map(actualMembers.map(({ id, name: memberName }) => [nameForId(id), memberName]));
  if (actualMembers.length !== members.length || members.some(({ id, name: memberName }) => byId.get(nameForId(id)) !== memberName)) {
    refuse('runner_network_peer_untrusted');
  }
  return network;
}

function nameForId(value) {
  return String(value).toLowerCase();
}

function parseDockerId(stdout) {
  const id = stdout.trim();
  if (!/^[a-f0-9]{12,64}$/u.test(id)) refuse('runner_resource_create_ambiguous');
  return id;
}

function resourceName(suffix, role) {
  return `bvc-${suffix}-${role}`;
}

function networkName(suffix, role) {
  return `bvc-${suffix}-${role}`;
}

function networkCreateArgs(name, internal, attemptSuffix, runId) {
  const labels = labelsFor(attemptSuffix, runId, internal ? 'internal-network' : 'external-network');
  const args = ['network', 'create', '--driver', 'bridge'];
  if (internal) args.push('--internal');
  for (const [key, value] of Object.entries(labels)) args.push('--label', `${key}=${value}`);
  args.push(name);
  return args;
}

function containerLabels(args, attemptSuffix, runId, role) {
  for (const [key, value] of Object.entries(labelsFor(attemptSuffix, runId, role))) {
    args.push('--label', `${key}=${value}`);
  }
}

function proxyCreateArgs({ name, image, internal, allowlist, attemptSuffix, runId }) {
  const args = ['create', '--name', name];
  containerLabels(args, attemptSuffix, runId, 'proxy');
  args.push('--network', internal, '--network-alias', INTERNAL_PROXY_ALIAS,
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--read-only', '--pids-limit=64',
    '--memory=256m', '--cpus=1', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=16m',
    '--env', `BVC_EGRESS_ALLOWLIST=${JSON.stringify(allowlist)}`,
    '--health-cmd', "node -e \"fetch('http://127.0.0.1:3128/health').then(r=>process.exit(r.status===204?0:1)).catch(()=>process.exit(1))\"",
    '--health-interval=2s', '--health-timeout=1s', '--health-retries=15', '--health-start-period=2s',
    '--entrypoint', 'node', image, '/opt/billing-validation/egress-proxy.mjs');
  return args;
}

function runnerCreateArgs({ name, image, internal, suffix, label, displaySocket, xauthorityFile, context }) {
  const args = ['create', '--name', name];
  containerLabels(args, suffix, context.runId, 'runner');
  args.push('--network', internal,
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=256', '--memory=8g',
    '--cpus=4', '--shm-size=1g', '--tmpfs', '/tmp:rw,nosuid,nodev,size=512m',
    '--tmpfs', '/tmp/.X11-unix:rw,nosuid,nodev,noexec,size=1m',
    '--tmpfs', '/home/billing-runner:rw,nosuid,nodev,size=128m',
    '--tmpfs', '/opt/actions-runner/_work:rw,nosuid,nodev,size=2g',
    '--mount', `type=bind,source=${displaySocket},target=/tmp/.X11-unix/X${DISPLAY_NUMBER},readonly`,
    '--mount', `type=bind,source=${xauthorityFile},target=${RUNNER_XAUTHORITY},readonly`,
    '--env', `DISPLAY=${DISPLAY}`, '--env', `XAUTHORITY=${RUNNER_XAUTHORITY}`,
    '--env', `HTTP_PROXY=http://${INTERNAL_PROXY_ALIAS}:${PROXY_PORT}`,
    '--env', `HTTPS_PROXY=http://${INTERNAL_PROXY_ALIAS}:${PROXY_PORT}`,
    '--env', `http_proxy=http://${INTERNAL_PROXY_ALIAS}:${PROXY_PORT}`,
    '--env', `https_proxy=http://${INTERNAL_PROXY_ALIAS}:${PROXY_PORT}`,
    '--env', 'NO_PROXY=localhost,127.0.0.1,::1', '--env', 'no_proxy=localhost,127.0.0.1,::1',
    '--env', `GITHUB_REPOSITORY=${context.repository}`,
    '--env', `CONTROL_REPOSITORY=${context.repository}`,
    '--env', `CONTROL_EVENT_NAME=${context.eventName}`,
    '--env', `CONTROL_DEFAULT_BRANCH=${context.defaultBranch}`,
    '--env', `CONTROL_REF=${context.ref}`,
    '--env', `CONTROL_WORKFLOW_REF=${context.workflowRef}`,
    '--env', `CONTROL_RUNNER_GROUP=${ISOLATED_RUNNER_GROUP}`,
    '--env', `RUNNER_LABEL=${label}`, '--env', 'RUNNER_REGISTRATION_TOKEN', image);
  return args;
}

function parseRunnerMounts(inspected, displaySocket, xauthorityFile) {
  const expected = [
    { source: displaySocket, destination: `/tmp/.X11-unix/X${DISPLAY_NUMBER}` },
    { source: xauthorityFile, destination: RUNNER_XAUTHORITY },
  ];
  const mounts = inspected.Mounts;
  if (!Array.isArray(mounts) || mounts.length !== expected.length) refuse('runner_mount_invalid');
  const actual = mounts.map((mount) => ({ source: mount.Source, destination: mount.Destination,
    type: mount.Type, rw: mount.RW }));
  for (const item of expected) {
    if (!actual.some((mount) => mount.source === item.source && mount.destination === item.destination &&
        mount.type === 'bind' && mount.rw === false)) refuse('runner_mount_invalid');
  }
}

function verifyContainerBase(inspected, { name, image, network, attemptSuffix, runId, role }) {
  if (inspected.Name !== `/${name}` || inspected.Image !== image ||
      !hasExactLabels(inspected.Config?.Labels, labelsFor(attemptSuffix, runId, role))) {
    refuse('runner_container_identity_invalid');
  }
  const host = inspected.HostConfig;
  if (!host || host.NetworkMode !== network || host.Privileged !== false ||
      (Array.isArray(host.Binds) && host.Binds.length !== 0) ||
      (host.Binds !== undefined && host.Binds !== null && !Array.isArray(host.Binds)) ||
      (host.CapDrop ?? []).includes('ALL') !== true ||
      !(host.SecurityOpt ?? []).some((item) => String(item).startsWith('no-new-privileges')) ||
      (host.Devices && host.Devices.length !== 0) ||
      (host.DeviceRequests && host.DeviceRequests.length !== 0) ||
      (host.PortBindings && Object.keys(host.PortBindings).length !== 0) ||
      host.PublishAllPorts === true ||
      ['PidMode', 'IpcMode', 'UTSMode', 'UsernsMode'].some((key) => host[key] === 'host')) {
    refuse('runner_container_isolation_invalid');
  }
  if (inspected.Config?.Volumes && Object.keys(inspected.Config.Volumes).length !== 0) {
    refuse('runner_mount_invalid');
  }
}

function verifyProxy(inspected, expected, running) {
  verifyContainerBase(inspected, { ...expected, role: 'proxy' });
  if (!Array.isArray(inspected.Mounts) || inspected.Mounts.length !== 0 ||
      inspected.HostConfig.ReadonlyRootfs !== true || inspected.State?.Running !== running) {
    refuse('runner_proxy_mount_invalid');
  }
  const allowed = inspected.Config?.Env?.find((entry) => typeof entry === 'string' &&
    entry.startsWith('BVC_EGRESS_ALLOWLIST='));
  if (allowed !== `BVC_EGRESS_ALLOWLIST=${JSON.stringify(expected.allowlist)}`) {
    refuse('runner_proxy_policy_invalid');
  }
  const networks = inspected.NetworkSettings?.Networks;
  if (!networks || Object.keys(networks).length !== 2 || !networks[expected.internal] ||
      !networks[expected.external] ||
      !Array.isArray(networks[expected.internal].Aliases) ||
      !networks[expected.internal].Aliases.includes(INTERNAL_PROXY_ALIAS)) {
    refuse('runner_proxy_topology_invalid');
  }
}

function verifyRunner(inspected, expected) {
  verifyContainerBase(inspected, { ...expected, role: 'runner' });
  if (inspected.State?.Running !== false) refuse('runner_container_state_invalid');
  parseRunnerMounts(inspected, expected.displaySocket, expected.xauthorityFile);
  const networks = inspected.NetworkSettings?.Networks;
  if (!networks || Object.keys(networks).length !== 1 || !networks[expected.internal]) {
    refuse('runner_network_direct_egress_refused');
  }
  const variables = new Set(inspected.Config?.Env?.filter((entry) => typeof entry === 'string') ?? []);
  const context = expected.context;
  if (!variables.has(`DISPLAY=${DISPLAY}`) || !variables.has(`XAUTHORITY=${RUNNER_XAUTHORITY}`) ||
      !variables.has(`HTTP_PROXY=http://${INTERNAL_PROXY_ALIAS}:${PROXY_PORT}`) ||
      !variables.has(`HTTPS_PROXY=http://${INTERNAL_PROXY_ALIAS}:${PROXY_PORT}`) ||
      !variables.has(`GITHUB_REPOSITORY=${context.repository}`) ||
      !variables.has(`CONTROL_REPOSITORY=${context.repository}`) ||
      !variables.has(`CONTROL_EVENT_NAME=${context.eventName}`) ||
      !variables.has(`CONTROL_DEFAULT_BRANCH=${context.defaultBranch}`) ||
      !variables.has(`CONTROL_REF=${context.ref}`) ||
      !variables.has(`CONTROL_WORKFLOW_REF=${context.workflowRef}`) ||
      !variables.has(`CONTROL_RUNNER_GROUP=${ISOLATED_RUNNER_GROUP}`) ||
      !variables.has(`RUNNER_LABEL=${expected.label}`) ||
      !(inspected.Config?.Env ?? []).some((entry) => typeof entry === 'string' &&
        entry.startsWith('RUNNER_REGISTRATION_TOKEN=') && entry.length > 'RUNNER_REGISTRATION_TOKEN='.length)) {
    refuse('runner_display_or_proxy_config_invalid');
  }
}

function networkInspectArgs(name) {
  return ['network', 'inspect', name];
}

function containerInspectArgs(name) {
  return ['container', 'inspect', name];
}

function xauthorityRecord(cookie) {
  const fields = [Buffer.alloc(0), Buffer.from(String(DISPLAY_NUMBER)),
    Buffer.from('MIT-MAGIC-COOKIE-1'), cookie];
  const family = Buffer.from([0xff, 0xff]); // FamilyWild, scoped by this one-run cookie and display number.
  return Buffer.concat([family, ...fields.flatMap((field) => {
    const length = Buffer.alloc(2);
    length.writeUInt16BE(field.length);
    return [length, field];
  })]);
}

async function readParentXauthority(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) refuse('runner_display_auth_invalid');
  let info;
  try { info = await lstat(file); } catch { refuse('runner_display_auth_invalid'); }
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    refuse('runner_display_auth_invalid');
  }
}

function dockerCommand(processBoundary, args, options = {}) {
  return Promise.resolve().then(() => processBoundary.run('docker', args, {
    timeoutMs: options.timeoutMs ?? 30_000, signal: options.signal, env: options.env,
    maxOutputBytes: options.maxOutputBytes ?? 1_048_576,
  })).then((result) => {
    if (!result || typeof result.stdout !== 'string') refuse('runner_supervisor_process_failed');
    return result.stdout;
  }).catch((error) => {
    if (error instanceof RunnerSupervisorRefusal) throw error;
    refuse('runner_supervisor_process_failed');
  });
}

async function inspectNetwork(processBoundary, name, signal) {
  return inspectOne(await dockerCommand(processBoundary, networkInspectArgs(name), { signal }),
    'runner_network_inspection_invalid');
}

async function inspectContainer(processBoundary, name, signal) {
  return inspectOne(await dockerCommand(processBoundary, containerInspectArgs(name), { signal }),
    'runner_container_inspection_invalid');
}

async function waitForProxy(processBoundary, proxyName, signal) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (signal.aborted) refuse(signal.reason?.code ?? 'runner_cancelled');
    const inspected = await inspectContainer(processBoundary, proxyName, signal);
    if (inspected.State?.Running === true && inspected.State?.Health?.Status === 'healthy') return inspected;
    if (inspected.State?.Running !== true || ['unhealthy', 'exited'].includes(inspected.State?.Health?.Status)) {
      refuse('runner_proxy_not_ready');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  refuse('runner_proxy_not_ready');
}

function listLines(stdout) {
  return stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

async function assertNoStaleRunnerResources(processBoundary, signal) {
  const [containers, networks] = await Promise.all([
    dockerCommand(processBoundary, ['container', 'ls', '-aq', '--filter', 'label=com.billing-validation.run'], { signal }),
    dockerCommand(processBoundary, ['network', 'ls', '-q', '--filter', 'label=com.billing-validation.run'], { signal }),
  ]);
  if (listLines(containers).length || listLines(networks).length) refuse('runner_stale_resources_present');
}

async function cleanupDockerResources(processBoundary, runId, expectedNames) {
  let failed = false;
  let containerIds = [];
  try {
    const stdout = await dockerCommand(processBoundary, ['container', 'ls', '-aq', '--filter',
      `label=com.billing-validation.run=${runId}`], { timeoutMs: 10_000 });
    containerIds = listLines(stdout);
  } catch { failed = true; }
  const ownedContainerIds = [];
  for (const id of containerIds) {
    try {
      const item = await inspectContainer(processBoundary, id);
      const name = item.Name?.replace(/^\//u, '');
      const role = item.Config?.Labels?.['com.billing-validation.role'];
      if (item.Config?.Labels?.['com.billing-validation.run'] !== runId ||
          !['runner', 'proxy'].includes(role) || name !== expectedNames[role]) {
        failed = true;
        continue;
      }
      ownedContainerIds.push(id);
    } catch { failed = true; }
  }
  if (ownedContainerIds.length) {
    try { await dockerCommand(processBoundary, ['container', 'rm', '--force', ...ownedContainerIds], { timeoutMs: 15_000 }); }
    catch { failed = true; }
  }

  let networkIds = [];
  try {
    const stdout = await dockerCommand(processBoundary, ['network', 'ls', '-q', '--filter',
      `label=com.billing-validation.run=${runId}`], { timeoutMs: 10_000 });
    networkIds = listLines(stdout);
  } catch { failed = true; }
  const ownedNetworkIds = [];
  for (const id of networkIds) {
    try {
      const network = await inspectNetwork(processBoundary, id);
      const role = network.Labels?.['com.billing-validation.role'];
      const expectedName = role === 'internal-network' ? expectedNames.internal :
        role === 'external-network' ? expectedNames.external : null;
      if (network.Labels?.['com.billing-validation.run'] !== runId || !expectedName || network.Name !== expectedName) {
        failed = true;
        continue;
      }
      ownedNetworkIds.push(id);
    } catch { failed = true; }
  }
  if (ownedNetworkIds.length) {
    try { await dockerCommand(processBoundary, ['network', 'rm', ...ownedNetworkIds], { timeoutMs: 15_000 }); }
    catch { failed = true; }
  }
  return failed;
}

async function stopDisplay(displayProcess) {
  if (!displayProcess || typeof displayProcess.stop !== 'function') return false;
  try { await displayProcess.stop(); return false; } catch { return true; }
}

export async function runSupervisedRunner({ processBoundary, workflowContext, image, parentDisplay,
  parentXauthority, additionalEgressHosts = [], getRegistrationToken, signal,
  timeoutMs = 45 * 60 * 1000 } = {}) {
  // Reject untrusted workflow/ref/event data before any process or credential-provider access.
  const trusted = validateRunnerWorkflowContext(workflowContext);
  if (cleanupUnverified) refuse('runner_cleanup_unverified');
  if (processBoundary && processBoundary.dockerContext !== ISOLATED_DOCKER_CONTEXT) {
    refuse('runner_docker_context_untrusted');
  }
  if (!processBoundary || typeof processBoundary.run !== 'function' || typeof processBoundary.start !== 'function' ||
      !validImageId(image) || !validParentDisplay(parentDisplay) || typeof getRegistrationToken !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS ||
      (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean' ||
        typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function'))) {
    refuse('runner_supervisor_config_invalid');
  }
  if (signal?.aborted) refuse('runner_cancelled');
  if (activeDisplay.value) refuse('runner_display_already_in_use');
  activeDisplay.value = true;
  const timerController = new AbortController();
  const timeout = setTimeout(() => timerController.abort(new RunnerSupervisorRefusal('runner_timeout')), timeoutMs);
  const onExternalAbort = () => timerController.abort(new RunnerSupervisorRefusal('runner_cancelled'));
  signal?.addEventListener('abort', onExternalAbort, { once: true });
  if (signal?.aborted) onExternalAbort();
  const operationSignal = timerController.signal;
  let allowlist;
  let label;
  let suffix;
  let runId;
  let names;
  let tempDirectory;
  let xauthorityFile;
  try {
    await readParentXauthority(parentXauthority);
    allowlist = buildEgressAllowlist(additionalEgressHosts);
    label = createAttemptRunnerLabel();
    suffix = suffixFromLabel(label);
    runId = secureRandomBytes(16).toString('hex');
    names = { internal: networkName(suffix, 'internal'), external: networkName(suffix, 'external'),
      proxy: resourceName(suffix, 'proxy'), runner: resourceName(suffix, 'runner') };
    tempDirectory = await mkdtemp(path.join(tmpdir(), `bvc-${suffix}-`));
    xauthorityFile = path.join(tempDirectory, 'Xauthority');
    if (operationSignal.aborted) refuse(operationSignal.reason?.code ?? 'runner_cancelled');
  } catch (error) {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onExternalAbort);
    if (tempDirectory) {
      try { await rm(tempDirectory, { recursive: true, force: true }); }
      catch { cleanupUnverified = true; activeDisplay.value = false; refuse('runner_cleanup_failed'); }
    }
    activeDisplay.value = false;
    if (error instanceof RunnerSupervisorRefusal) throw error;
    if (error?.code && /^(?:egress|runner)_[a-z_]+$/u.test(error.code)) {
      throw new RunnerSupervisorRefusal(error.code);
    }
    refuse('runner_supervisor_preflight_failed');
  }
  let displayProcess;
  let failure;
  let exitCode;
  let token;

  try {
    await assertNoStaleRunnerResources(processBoundary, operationSignal);
    const imageId = (await dockerCommand(processBoundary,
      ['image', 'inspect', '--format={{.Id}}', image], { signal: operationSignal })).trim();
    if (imageId !== image) refuse('runner_image_not_pinned');

    const cookie = secureRandomBytes(16);
    await writeFile(xauthorityFile, xauthorityRecord(cookie), { mode: 0o444, flag: 'wx' });
    cookie.fill(0);
    const authorityInfo = await lstat(xauthorityFile);
    if (!authorityInfo.isFile() || authorityInfo.isSymbolicLink() || (authorityInfo.mode & 0o777) !== 0o444) {
      refuse('runner_display_auth_invalid');
    }

    for (const [name, internal] of [[names.internal, true], [names.external, false]]) {
      const createdId = parseDockerId(await dockerCommand(processBoundary,
        networkCreateArgs(name, internal, suffix, runId), { signal: operationSignal }));
      const inspected = await inspectNetwork(processBoundary, name, operationSignal);
      verifyNetwork(inspected, { name, internal, attemptSuffix: suffix, runId, members: [] });
      if (inspected.Id !== createdId) refuse('runner_network_inspection_invalid');
    }

    const proxyId = parseDockerId(await dockerCommand(processBoundary, proxyCreateArgs({
      name: names.proxy, image, internal: names.internal, allowlist, attemptSuffix: suffix, runId,
    }), { signal: operationSignal }));
    await dockerCommand(processBoundary, ['network', 'connect', names.external, proxyId], { signal: operationSignal });
    const proxyCreated = await inspectContainer(processBoundary, names.proxy, operationSignal);
    verifyProxy(proxyCreated, { name: names.proxy, image, network: names.internal, internal: names.internal,
      external: names.external, attemptSuffix: suffix, runId, allowlist }, false);
    if (proxyCreated.Id !== proxyId) refuse('runner_container_inspection_invalid');
    await dockerCommand(processBoundary, ['container', 'start', proxyId], { signal: operationSignal });
    const proxyStarted = await waitForProxy(processBoundary, names.proxy, operationSignal);
    verifyProxy(proxyStarted, { name: names.proxy, image, network: names.internal, internal: names.internal,
      external: names.external, attemptSuffix: suffix, runId, allowlist }, true);
    const internalWithProxy = await inspectNetwork(processBoundary, names.internal, operationSignal);
    verifyNetwork(internalWithProxy, { name: names.internal, internal: true, attemptSuffix: suffix, runId,
      members: [{ id: proxyId, name: names.proxy }] });
    const externalWithProxy = await inspectNetwork(processBoundary, names.external, operationSignal);
    verifyNetwork(externalWithProxy, { name: names.external, internal: false, attemptSuffix: suffix, runId,
      members: [{ id: proxyId, name: names.proxy }] });

    const displayEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', DISPLAY: parentDisplay,
      XAUTHORITY: parentXauthority };
    displayProcess = await processBoundary.start('Xephyr', [DISPLAY, '-auth', xauthorityFile,
      '-screen', '1920x1080x24', '-nolisten', 'tcp'], { env: displayEnv });
    if (!displayProcess || typeof displayProcess.stop !== 'function') refuse('runner_display_start_failed');
    if (displayProcess.exitCode !== undefined && displayProcess.exitCode !== null) refuse('runner_display_start_failed');
    await processBoundary.run('xset', ['-display', DISPLAY, '-q'], { env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin', DISPLAY, XAUTHORITY: xauthorityFile,
    }, signal: operationSignal, timeoutMs: 5_000 });

    const internalBeforeRunner = await inspectNetwork(processBoundary, names.internal, operationSignal);
    verifyNetwork(internalBeforeRunner, { name: names.internal, internal: true, attemptSuffix: suffix, runId,
      members: [{ id: proxyId, name: names.proxy }] });
    const externalBeforeRunner = await inspectNetwork(processBoundary, names.external, operationSignal);
    verifyNetwork(externalBeforeRunner, { name: names.external, internal: false, attemptSuffix: suffix, runId,
      members: [{ id: proxyId, name: names.proxy }] });

    // The registration secret is not requested until workflow, image, networks, proxy, and display pass.
    token = await getRegistrationToken(Object.freeze({ runnerLabel: label, runnerGroup: ISOLATED_RUNNER_GROUP,
      repository: trusted.repository }));
    if (typeof token !== 'string' || token.length < 1 || token.length > 512 || /[\r\n\0]/u.test(token)) {
      refuse('runner_registration_unavailable');
    }
    const runnerId = parseDockerId(await dockerCommand(processBoundary, runnerCreateArgs({
      name: names.runner, image, internal: names.internal, suffix, label, displaySocket: DISPLAY_SOCKET,
      xauthorityFile, context: { ...trusted, runId },
    }), { signal: operationSignal, env: { RUNNER_REGISTRATION_TOKEN: token } }));
    token = undefined;
    const runnerCreated = await inspectContainer(processBoundary, names.runner, operationSignal);
    verifyRunner(runnerCreated, { name: names.runner, image, network: names.internal, internal: names.internal,
      attemptSuffix: suffix, runId, displaySocket: DISPLAY_SOCKET, xauthorityFile, label, context: trusted });
    if (runnerCreated.Id !== runnerId) refuse('runner_container_inspection_invalid');
    const internalWithRunner = await inspectNetwork(processBoundary, names.internal, operationSignal);
    verifyNetwork(internalWithRunner, { name: names.internal, internal: true, attemptSuffix: suffix, runId,
      members: [{ id: proxyId, name: names.proxy }, { id: runnerId, name: names.runner }] });
    const externalWithRunner = await inspectNetwork(processBoundary, names.external, operationSignal);
    verifyNetwork(externalWithRunner, { name: names.external, internal: false, attemptSuffix: suffix, runId,
      members: [{ id: proxyId, name: names.proxy }] });
    await dockerCommand(processBoundary, ['container', 'start', runnerId], { signal: operationSignal });
    const waitOutput = await dockerCommand(processBoundary, ['container', 'wait', runnerId], {
      signal: operationSignal, timeoutMs,
    });
    const parsedExit = Number(waitOutput.trim());
    if (!Number.isInteger(parsedExit) || parsedExit < 0 || parsedExit > 255) refuse('runner_exit_status_invalid');
    exitCode = parsedExit;
  } catch (error) {
    const reason = operationSignal.reason;
    if (reason instanceof RunnerSupervisorRefusal) failure = reason;
    else if (error instanceof RunnerSupervisorRefusal) failure = error;
    else if (error?.code && /^egress_[a-z_]+$/u.test(error.code)) failure = new RunnerSupervisorRefusal(error.code);
    else failure = new RunnerSupervisorRefusal('runner_supervisor_failed');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onExternalAbort);
    token = undefined;
    let cleanupFailed = await cleanupDockerResources(processBoundary, runId, names);
    cleanupFailed = (await stopDisplay(displayProcess)) || cleanupFailed;
    try { await rm(tempDirectory, { recursive: true, force: true }); }
    catch { cleanupFailed = true; }
    activeDisplay.value = false;
    if (cleanupFailed) {
      cleanupUnverified = true;
      failure = new RunnerSupervisorRefusal('runner_cleanup_failed');
    }
  }
  if (failure) throw failure;
  return Object.freeze({ runnerLabel: label, exitCode });
}
