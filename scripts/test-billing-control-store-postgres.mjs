import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const CONTROL_STORE_DOCKER_CONTEXT = 'billing-validation-isolated';
export const CONTROL_STORE_POSTGRES_IMAGE = 'postgres:17.11';
export const CONTROL_STORE_SERVICE_ACCOUNT = 'billing-validation';

const LABEL_ROLE = 'io.lawx.billing-validation.role';
const LABEL_RUN_ID = 'io.lawx.billing-validation.run-id';
const CONTAINER_ROLE = 'control-store-postgres17-test';
const POSTGRES_TEST_ADMIN_ROLE = 'billing_control_test_admin';
const SYSTEM_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const CREATE_TIMEOUT_MS = 30_000;
const HEALTH_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 180_000;
const CLEANUP_TIMEOUT_MS = 30_000;
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

function refuse(code, message = 'Isolated PostgreSQL validation refused.') {
  const error = new Error(message);
  error.name = 'BillingControlStoreHarnessRefusal';
  error.code = code;
  throw error;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonOutput(value, code) {
  try {
    return JSON.parse(value);
  } catch {
    refuse(code);
  }
}

function runCommand(file, args, { env, timeout = CREATE_TIMEOUT_MS, input } = {}) {
  const result = spawnSync(file, args, {
    cwd: REPO_ROOT,
    env,
    input,
    encoding: 'utf8',
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    signal: result.signal ?? null,
    errorCode: result.error?.code ?? null,
  };
}

function resolveServiceAccount() {
  const result = runCommand('/usr/bin/getent', ['passwd', CONTROL_STORE_SERVICE_ACCOUNT], {
    env: { PATH: SYSTEM_PATH }, timeout: 5_000,
  });
  if (result.status !== 0) refuse('isolated_docker_account_unavailable');
  const fields = result.stdout.trimEnd().split(':');
  if (fields.length !== 7) refuse('isolated_docker_account_invalid');
  const [name, , uidText, gidText, , home, shell] = fields;
  const account = { name, uid: Number(uidText), gid: Number(gidText), home, shell };
  if (name !== CONTROL_STORE_SERVICE_ACCOUNT || !Number.isSafeInteger(account.uid) || account.uid < 1 ||
      !Number.isSafeInteger(account.gid) || account.gid < 1 || home !== '/var/lib/billing-validation' ||
      shell !== '/usr/sbin/nologin') refuse('isolated_docker_account_invalid');
  return Object.freeze(account);
}

function createDockerInvoker(account) {
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : -1;
  const isServiceAccount = currentUid === account.uid;
  return (args, { environment = {}, timeout = CREATE_TIMEOUT_MS } = {}) => {
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string') ||
        Object.keys(environment).some((key) => key !== 'POSTGRES_PASSWORD') ||
        (environment.POSTGRES_PASSWORD !== undefined &&
          (typeof environment.POSTGRES_PASSWORD !== 'string' || environment.POSTGRES_PASSWORD.length < 32))) {
      refuse('isolated_docker_invocation_invalid');
    }
    const cleanEnvironment = {
      PATH: SYSTEM_PATH,
      HOME: account.home,
      USER: account.name,
      LOGNAME: account.name,
      ...environment,
    };
    if (isServiceAccount) {
      return runCommand('/usr/bin/docker', args, { env: cleanEnvironment, timeout });
    }

    const sudoArgs = ['-n'];
    if (Object.hasOwn(environment, 'POSTGRES_PASSWORD')) sudoArgs.push('--preserve-env=POSTGRES_PASSWORD');
    sudoArgs.push('-u', account.name, '--', '/usr/bin/docker', ...args);
    const result = runCommand('/usr/bin/sudo', sudoArgs, { env: cleanEnvironment, timeout });
    if (result.status !== 0 && /(?:a password is required|a terminal is required|authentication required|not allowed to execute|must have a tty)/iu.test(result.stderr)) {
      return { ...result, errorCode: 'sudo_privilege_required' };
    }
    return result;
  };
}

export function dockerContextArgs(args) {
  if (!Array.isArray(args) || args.length === 0 || args.some((value) => typeof value !== 'string')) {
    refuse('isolated_docker_invocation_invalid');
  }
  return ['--context', CONTROL_STORE_DOCKER_CONTEXT, ...args];
}

export function validateIsolatedDockerIdentity({ account, context, securityOptions, dockerRootDir } = {}) {
  if (!isRecord(account) || account.name !== CONTROL_STORE_SERVICE_ACCOUNT ||
      !Number.isSafeInteger(account.uid) || account.uid < 1 ||
      !Number.isSafeInteger(account.gid) || account.gid < 1 || account.home !== '/var/lib/billing-validation' ||
      account.shell !== '/usr/sbin/nologin' || !Array.isArray(context) || context.length !== 1 ||
      !isRecord(context[0]) || context[0].Name !== CONTROL_STORE_DOCKER_CONTEXT ||
      context[0].Endpoints?.docker?.Host !== `unix:///run/user/${account.uid}/docker.sock` ||
      !Array.isArray(securityOptions) || !securityOptions.includes('name=rootless') ||
      dockerRootDir !== `${account.home}/.local/share/docker`) {
    refuse('isolated_docker_identity_invalid');
  }
  return true;
}

export function buildPostgres17ContainerArgs({ containerName, runId } = {}) {
  if (typeof runId !== 'string' || !/^[a-f0-9]{32}$/u.test(runId) ||
      containerName !== `billing-control-pg17-${runId}`) refuse('isolated_container_identity_invalid');
  return [
    'container', 'create',
    '--name', containerName,
    '--label', `${LABEL_ROLE}=${CONTAINER_ROLE}`,
    '--label', `${LABEL_RUN_ID}=${runId}`,
    '--publish', '127.0.0.1::5432/tcp',
    '--env', 'POSTGRES_DB=postgres',
    '--env', `POSTGRES_USER=${POSTGRES_TEST_ADMIN_ROLE}`,
    '--env', 'POSTGRES_PASSWORD',
    '--health-cmd', `pg_isready -U ${POSTGRES_TEST_ADMIN_ROLE} -d postgres`,
    '--health-interval', '1s',
    '--health-timeout', '3s',
    '--health-retries', '60',
    '--shm-size', '128m',
    '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=512m',
    CONTROL_STORE_POSTGRES_IMAGE,
  ];
}

export function validatePostgresContainerInspection(inspection, {
  containerName, containerId, runId, requirePublishedPort = false,
} = {}) {
  const invalid = (code) => refuse(code);
  if (!isRecord(inspection) || typeof containerId !== 'string' || !/^[a-f0-9]{64}$/u.test(containerId) ||
      inspection.Id !== containerId || inspection.Name !== `/${containerName}` ||
      containerName !== `billing-control-pg17-${runId}` || !/^[a-f0-9]{32}$/u.test(runId) ||
      inspection.Config?.Image !== CONTROL_STORE_POSTGRES_IMAGE ||
      inspection.Config?.Labels?.[LABEL_ROLE] !== CONTAINER_ROLE ||
      inspection.Config?.Labels?.[LABEL_RUN_ID] !== runId) {
    invalid('isolated_container_metadata_invalid');
  }
  if (inspection.HostConfig?.Privileged !== false) invalid('isolated_container_privilege_invalid');
  if (
      (inspection.HostConfig?.Binds != null &&
        (!Array.isArray(inspection.HostConfig.Binds) || inspection.HostConfig.Binds.length !== 0)) ||
      !Array.isArray(inspection.Mounts) || inspection.Mounts.some((mount) =>
        !isRecord(mount) || mount.Type === 'bind' || !['tmpfs', 'volume'].includes(mount.Type))) {
    invalid('isolated_container_mount_invalid');
  }
  if (!isRecord(inspection.HostConfig?.PortBindings) ||
      Object.keys(inspection.HostConfig.PortBindings).length !== 1 ||
      !Array.isArray(inspection.HostConfig.PortBindings['5432/tcp']) ||
      inspection.HostConfig.PortBindings['5432/tcp'].length !== 1) {
    invalid('isolated_container_port_binding_invalid');
  }

  const binding = inspection.HostConfig.PortBindings['5432/tcp'][0];
  if (!isRecord(binding) || binding.HostIp !== '127.0.0.1' ||
      (binding.HostPort !== '' && (!/^\d{1,5}$/u.test(binding.HostPort) ||
        Number(binding.HostPort) < 1 || Number(binding.HostPort) > 65535))) {
    invalid('isolated_container_port_binding_invalid');
  }

  const networkPorts = inspection.NetworkSettings?.Ports;
  if (!requirePublishedPort) {
    if (networkPorts != null && !isRecord(networkPorts)) invalid('isolated_container_port_binding_invalid');
    return binding.HostPort === '' ? null : Number(binding.HostPort);
  }

  const published = networkPorts?.['5432/tcp'];
  if (!Array.isArray(published) || published.length !== 1 ||
      Object.keys(networkPorts).length !== 1 || !isRecord(published[0]) ||
      published[0].HostIp !== '127.0.0.1' || !/^\d{1,5}$/u.test(published[0].HostPort) ||
      Number(published[0].HostPort) < 1 || Number(published[0].HostPort) > 65535) {
    invalid('isolated_container_published_port_invalid');
  }
  if (binding.HostPort !== '' && binding.HostPort !== published[0].HostPort) {
    invalid('isolated_container_published_port_mismatch');
  }
  if (inspection.State?.Status !== 'running' || inspection.State?.Health?.Status !== 'healthy') {
    invalid('isolated_container_health_invalid');
  }
  return Number(published[0].HostPort);
}

function commandResult(result, code) {
  if (result?.errorCode === 'sudo_privilege_required') refuse('isolated_docker_privilege_required');
  if (!isRecord(result) || result.status !== 0 || result.errorCode !== null) refuse(code);
  return result;
}

function classifyContainerCreateFailure(result) {
  if (result?.errorCode === 'sudo_privilege_required') return 'isolated_docker_privilege_required';
  if (result?.errorCode === 'ETIMEDOUT') return 'isolated_docker_command_timeout';
  if (result?.errorCode === 'ENOENT') return 'isolated_docker_cli_unavailable';
  const diagnostic = typeof result?.stderr === 'string' ? result.stderr.slice(0, 8_192).toLowerCase() : '';
  if (/no space left on device|disk quota exceeded/u.test(diagnostic)) {
    return 'isolated_docker_storage_exhausted';
  }
  if (/toomanyrequests|rate limit exceeded|too many requests/u.test(diagnostic)) {
    return 'isolated_registry_rate_limited';
  }
  if (/unauthorized|authentication required|pull access denied|requested access to the resource is denied/u.test(diagnostic)) {
    return 'isolated_registry_pull_denied';
  }
  if (/no such image|manifest unknown|manifest .{0,160} not found|repository does not exist/u.test(diagnostic)) {
    return 'isolated_postgres_image_unavailable';
  }
  if (/lookup [^\s]+:|no such host|temporary failure in name resolution|tls handshake timeout|network is unreachable|connection timed out|i\/o timeout/u.test(diagnostic)) {
    return 'isolated_registry_unreachable';
  }
  if (/operation not permitted|permission denied|not enough privileges/u.test(diagnostic)) {
    return 'isolated_docker_host_restriction';
  }
  if (/invalid mount|invalid reference format|unknown flag|port is already allocated|invalid argument/u.test(diagnostic)) {
    return 'isolated_container_configuration_rejected';
  }
  return 'isolated_container_create_failed';
}

function parseInspection(result, code = 'isolated_container_identity_invalid') {
  commandResult(result, code);
  const rows = parseJsonOutput(result.stdout, code);
  if (!Array.isArray(rows) || rows.length !== 1) refuse(code);
  return rows[0];
}

function validateRunId(runId) {
  if (typeof runId !== 'string' || !/^[a-f0-9]{32}$/u.test(runId)) refuse('isolated_run_id_invalid');
  return runId;
}

function parseContainerId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  return /^[a-f0-9]{64}$/u.test(id) ? id : null;
}

function resolveCreatedByName(docker, { containerName, runId }) {
  const result = docker(['container', 'inspect', containerName], { timeout: 10_000 });
  if (result.status === 0 && result.errorCode === null) {
    try {
      const rows = JSON.parse(result.stdout);
      if (Array.isArray(rows) && rows.length === 1) {
        const inspection = rows[0];
        const id = parseContainerId(inspection?.Id);
        if (id) {
          validatePostgresContainerInspection(inspection, { containerName, containerId: id, runId });
          return { containerId: id, absenceVerified: false };
        }
      }
    } catch {
      // The exact-name listing below determines whether absence can be proven.
    }
  }

  const listing = docker(['container', 'ls', '--all', '--filter', `name=^/${containerName}$`,
    '--format', '{{.ID}}'], { timeout: 10_000 });
  if (listing.status === 0 && listing.errorCode === null && listing.stdout.trim() === '') {
    return { containerId: null, absenceVerified: true };
  }
  return { containerId: null, absenceVerified: false };
}

function identityFromDocker(docker, account) {
  const contextResult = commandResult(docker(['context', 'inspect', CONTROL_STORE_DOCKER_CONTEXT]),
    'isolated_docker_context_unavailable');
  const context = parseJsonOutput(contextResult.stdout, 'isolated_docker_identity_invalid');
  const securityResult = commandResult(docker(['info', '--format', '{{json .SecurityOptions}}']),
    'isolated_docker_daemon_unavailable');
  const rootResult = commandResult(docker(['info', '--format', '{{.DockerRootDir}}']),
    'isolated_docker_daemon_unavailable');
  const securityOptions = parseJsonOutput(securityResult.stdout.trim(), 'isolated_docker_identity_invalid');
  validateIsolatedDockerIdentity({ account, context, securityOptions, dockerRootDir: rootResult.stdout.trim() });
}

function localDatabaseUrl(port, password) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 ||
      typeof password !== 'string' || password.length < 32) refuse('isolated_database_target_invalid');
  return `postgresql://${POSTGRES_TEST_ADMIN_ROLE}:${encodeURIComponent(password)}@127.0.0.1:${port}/postgres`;
}

function parseNodeTestCounts(output) {
  const extract = (field) => Number(output.match(new RegExp(`ℹ ${field} (\\d+)`, 'u'))?.[1] ?? 0);
  return { tests: extract('tests'), passed: extract('pass'), failed: extract('fail'), skipped: extract('skipped') };
}

function sanitizeOutput(output, password, url) {
  let clean = String(output ?? '');
  for (const secret of [url, password, encodeURIComponent(password)]) {
    if (secret) clean = clean.replaceAll(secret, '[redacted]');
  }
  return clean;
}

function runPostgresAssertions({ url, password }) {
  const env = {
    PATH: SYSTEM_PATH,
    BILLING_CONTROL_STORE_LOCAL_TEST_URL: url,
    BILLING_CONTROL_RUNTIME_PG_TEST: '1',
    BILLING_CONTROL_RUNTIME_PG_TEST_URL: url,
  };
  const commands = [
    ['test/attempts/control-store-postgres.integration.test.mjs'],
    ['test/attempts/control-store-privileges.test.mjs'],
  ];
  const counts = { tests: 0, passed: 0, failed: 0, skipped: 0 };
  let output = '';
  for (const files of commands) {
    const result = runCommand(process.execPath, ['--test', ...files], {
      env, timeout: TEST_TIMEOUT_MS,
    });
    output += `${result.stdout}\n${result.stderr}`;
    const parsed = parseNodeTestCounts(result.stdout + result.stderr);
    for (const key of Object.keys(counts)) counts[key] += parsed[key];
    if (result.status !== 0 || result.errorCode !== null) {
      return { status: result.status ?? 1, counts, output: sanitizeOutput(output, password, url) };
    }
  }
  return { status: 0, counts, output: sanitizeOutput(output, password, url) };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function runControlStorePostgresHarness({
  account = resolveServiceAccount(),
  docker = createDockerInvoker(account),
  runTests = runPostgresAssertions,
  wait = delay,
  isInterrupted = () => false,
  runId = randomBytes(16).toString('hex'),
  password = randomBytes(32).toString('base64url'),
  healthTimeoutMs = HEALTH_TIMEOUT_MS,
} = {}) {
  validateRunId(runId);
  const containerName = `billing-control-pg17-${runId}`;
  let containerId = null;
  let primaryError = null;
  let cleanup = 'not_needed';
  let testResult = null;
  let generatedUrl = null;

  const call = (args, options) => docker(dockerContextArgs(args), options);
  const checkIdentity = () => identityFromDocker(call, account);
  const inspectOwned = ({ requirePublishedPort = false } = {}) => {
    const result = call(['container', 'inspect', containerId], { timeout: 10_000 });
    const inspection = parseInspection(result);
    const port = validatePostgresContainerInspection(inspection,
      { containerName, containerId, runId, requirePublishedPort });
    return { inspection, port };
  };

  try {
    checkIdentity();
    if (isInterrupted()) refuse('isolated_run_interrupted');

    const collision = commandResult(call(['container', 'ls', '--all', '--filter', `name=^/${containerName}$`,
      '--format', '{{.ID}}']), 'isolated_docker_daemon_unavailable').stdout.trim();
    if (collision.length > 0) refuse('isolated_container_name_collision');

    const create = call(buildPostgres17ContainerArgs({ containerName, runId }), {
      timeout: CREATE_TIMEOUT_MS,
      environment: { POSTGRES_PASSWORD: password },
    });
    if (create.status !== 0 || create.errorCode !== null) {
      const resolution = resolveCreatedByName(call, { containerName, runId });
      containerId = resolution.containerId;
      if (!containerId && !resolution.absenceVerified) cleanup = 'needs_review';
      refuse(containerId ? 'isolated_container_create_acknowledgement_unknown'
        : classifyContainerCreateFailure(create));
    }
    containerId = parseContainerId(create.stdout);
    if (!containerId) {
      const resolution = resolveCreatedByName(call, { containerName, runId });
      containerId = resolution.containerId;
      if (!containerId && !resolution.absenceVerified) cleanup = 'needs_review';
      if (!containerId) refuse('isolated_container_identity_invalid');
    }

    inspectOwned();
    if (isInterrupted()) refuse('isolated_run_interrupted');
    commandResult(call(['container', 'start', containerId]), 'isolated_container_start_failed');

    const deadline = Date.now() + healthTimeoutMs;
    let port = null;
    while (Date.now() < deadline) {
      if (isInterrupted()) refuse('isolated_run_interrupted');
      const { inspection, port: currentPort } = inspectOwned({ requirePublishedPort: false });
      const health = inspection.State?.Health?.Status;
      if (health === 'unhealthy' || inspection.State?.Status === 'exited' || inspection.State?.Status === 'dead') {
        refuse('isolated_container_health_failed');
      }
      if (health === 'healthy') {
        port = validatePostgresContainerInspection(inspection,
          { containerName, containerId, runId, requirePublishedPort: true });
        break;
      }
      if (currentPort === null && inspection.State?.Status === 'running' && inspection.State?.Health === undefined) {
        refuse('isolated_container_health_missing');
      }
      await wait(1_000);
    }
    if (port === null) refuse('isolated_container_health_timeout');
    if (isInterrupted()) refuse('isolated_run_interrupted');

    generatedUrl = localDatabaseUrl(port, password);
    testResult = await runTests({ url: generatedUrl, password });
    if (!isRecord(testResult) || testResult.status !== 0 || !isRecord(testResult.counts) ||
        testResult.counts.failed !== 0 || testResult.counts.tests < 1 ||
        testResult.counts.passed + testResult.counts.skipped !== testResult.counts.tests) {
      const error = Object.assign(new Error('PostgreSQL 17 integration assertions failed.'), {
        name: 'BillingControlStoreHarnessRefusal', code: 'isolated_postgres_assertions_failed',
      });
      error.safeOutput = sanitizeOutput(testResult?.output, password, generatedUrl);
      throw error;
    }
  } catch (error) {
    primaryError = error?.name === 'BillingControlStoreHarnessRefusal'
      ? error
      : Object.assign(new Error('Isolated PostgreSQL validation failed.'), {
        name: 'BillingControlStoreHarnessRefusal', code: 'isolated_postgres_harness_failed',
      });
  } finally {
    if (containerId) {
      try {
        checkIdentity();
        inspectOwned();
        const removed = call(['container', 'rm', '--force', '--volumes', containerId], {
          timeout: CLEANUP_TIMEOUT_MS,
        });
        if (removed.status === 0 && removed.errorCode === null) cleanup = 'removed';
        else {
          checkIdentity();
          const absence = call(['container', 'ls', '--all', '--filter', `id=${containerId}`,
            '--format', '{{.ID}}'], { timeout: 10_000 });
          cleanup = absence.status === 0 && absence.errorCode === null && absence.stdout.trim() === ''
            ? 'removed' : 'needs_review';
        }
      } catch {
        cleanup = 'needs_review';
      }
    }
  }

  if (cleanup === 'needs_review') {
    const error = Object.assign(new Error('Exact test container cleanup could not be verified.'), {
      name: 'BillingControlStoreHarnessRefusal', code: 'isolated_container_cleanup_needs_review',
      cleanup, runId, containerName, containerId,
    });
    if (primaryError) error.cause = primaryError;
    throw error;
  }
  if (primaryError) {
    primaryError.cleanup = cleanup;
    primaryError.runId = runId;
    if (containerId) primaryError.containerId = containerId;
    if (testResult?.output) primaryError.safeOutput = sanitizeOutput(testResult.output, password, generatedUrl);
    throw primaryError;
  }
  return Object.freeze({
    runId,
    containerName,
    containerOutcome: cleanup,
    postgresImage: CONTROL_STORE_POSTGRES_IMAGE,
    counts: Object.freeze({ ...testResult.counts }),
    output: testResult.output,
  });
}

export async function main() {
  let receivedSignal = null;
  const onSignal = (signal) => { receivedSignal ??= signal; };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const result = await runControlStorePostgresHarness({ isInterrupted: () => receivedSignal !== null });
    process.stdout.write(`billing_control_store_db run=${result.runId} container=${result.containerOutcome} ` +
      `image=${result.postgresImage} tests=${result.counts.tests} passed=${result.counts.passed} ` +
      `failed=${result.counts.failed} skipped=${result.counts.skipped}\n`);
    return 0;
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[a-z0-9_]+$/u.test(error.code)
      ? error.code : 'isolated_postgres_harness_failed';
    const cleanup = ['removed', 'needs_review', 'not_needed'].includes(error?.cleanup) ? error.cleanup : null;
    process.stderr.write(`billing_control_store_db failed code=${code}` +
      `${error?.runId ? ` run=${error.runId}` : ''}` +
      `${cleanup ? ` cleanup=${cleanup}` : ''}` +
      `${error?.containerName ? ` container=${error.containerName}` : ''}` +
      `${error?.containerId ? ` id=${error.containerId}` : ''}\n`);
    if (typeof error?.safeOutput === 'string' && error.safeOutput.trim()) {
      process.stderr.write(`${error.safeOutput.trim()}\n`);
    }
    return 1;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main();
}
