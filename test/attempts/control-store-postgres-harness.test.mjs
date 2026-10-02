import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  buildPostgres17ContainerArgs,
  dockerContextArgs,
  runControlStorePostgresHarness,
  validateIsolatedDockerIdentity,
  validatePostgresContainerInspection,
} from '../../scripts/test-billing-control-store-postgres.mjs';

const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));

test('package exposes a dedicated PostgreSQL 17 control-store proof command', () => {
  assert.equal(packageJson.scripts['test:billing-control-store:db'],
    'node scripts/test-billing-control-store-postgres.mjs');
});

const serviceAccount = Object.freeze({ name: 'billing-validation', uid: 997, gid: 983,
  home: '/var/lib/billing-validation', shell: '/usr/sbin/nologin' });
const runId = 'a'.repeat(32);
const containerName = `billing-control-pg17-${runId}`;
const containerId = 'b'.repeat(64);

function validDockerIdentity() {
  return {
    account: serviceAccount,
    context: [{ Name: 'billing-validation-isolated', Endpoints: {
      docker: { Host: 'unix:///run/user/997/docker.sock' },
    } }],
    securityOptions: ['name=seccomp,profile=builtin', 'name=rootless', 'name=cgroupns'],
    dockerRootDir: '/var/lib/billing-validation/.local/share/docker',
  };
}

function validContainerInspection(overrides = {}) {
  return {
    Id: containerId,
    Name: `/${containerName}`,
    Config: {
      Image: 'postgres:17.11',
      Labels: {
        'io.lawx.billing-validation.role': 'control-store-postgres17-test',
        'io.lawx.billing-validation.run-id': runId,
      },
    },
    HostConfig: {
      Privileged: false,
      Binds: [],
      PortBindings: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '49152' }] },
    },
    Mounts: [{ Type: 'tmpfs', Source: '', Destination: '/var/lib/postgresql/data' }],
    NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '49152' }] } },
    State: { Status: 'running', Health: { Status: 'healthy' } },
    ...overrides,
  };
}

test('Docker identity accepts only the billing-validation rootless context and private data root', () => {
  assert.equal(validateIsolatedDockerIdentity(validDockerIdentity()), true);

  const invalid = [
    { context: [{ Name: 'default', Endpoints: { docker: { Host: 'unix:///var/run/docker.sock' } } }] },
    { context: [{ Name: 'billing-validation-isolated', Endpoints: {
      docker: { Host: 'unix:///run/user/1000/docker.sock' },
    } }] },
    { securityOptions: ['name=seccomp,profile=builtin'] },
    { dockerRootDir: '/var/lib/docker' },
    { account: { ...serviceAccount, uid: 1000 } },
  ];
  for (const override of invalid) {
    assert.throws(() => validateIsolatedDockerIdentity({ ...validDockerIdentity(), ...override }),
      { code: 'isolated_docker_identity_invalid' });
  }
});

test('Docker commands are pinned to the isolated context and carry no password argument', () => {
  const args = buildPostgres17ContainerArgs({ containerName, runId });
  const full = dockerContextArgs(args);

  assert.deepEqual(full.slice(0, 2), ['--context', 'billing-validation-isolated']);
  assert.equal(full.at(-1), 'postgres:17.11');
  assert.ok(args.includes('127.0.0.1::5432/tcp'));
  assert.ok(args.includes('POSTGRES_PASSWORD'));
  assert.ok(args.includes('POSTGRES_USER=billing_control_test_admin'));
  assert.ok(args.includes('--health-cmd') && args.includes('pg_isready -U billing_control_test_admin -d postgres'));
  assert.ok(args.every((value) => !value.includes('not-a-test-password')));
  assert.equal(args.some((value) => value.startsWith('POSTGRES_PASSWORD=')), false);
  assert.equal(args.some((value) => value.includes('DOCKER_HOST=')), false);
});

test('container proof requires exact run labels, image, mounts and loopback-only port binding', () => {
  assert.equal(validatePostgresContainerInspection(validContainerInspection(), {
    containerName, containerId, runId, requirePublishedPort: true,
  }), 49152);

  const invalid = [
    [{ Config: { ...validContainerInspection().Config, Image: 'postgres:17' } }, 'isolated_container_metadata_invalid'],
    [{ Config: { ...validContainerInspection().Config, Labels: {} } }, 'isolated_container_metadata_invalid'],
    [{ HostConfig: { ...validContainerInspection().HostConfig,
      PortBindings: { '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: '49152' }] } } },
    'isolated_container_port_binding_invalid'],
    [{ Mounts: [{ Type: 'bind', Source: '/home/angelo', Destination: '/host' }] },
    'isolated_container_mount_invalid'],
    [{ HostConfig: { ...validContainerInspection().HostConfig, Privileged: true } },
    'isolated_container_privilege_invalid'],
    [{ Id: 'c'.repeat(64) }, 'isolated_container_metadata_invalid'],
  ];
  for (const [override, code] of invalid) {
    assert.throws(() => validatePostgresContainerInspection(validContainerInspection(override), {
      containerName, containerId, runId, requirePublishedPort: true,
    }), { code });
  }
});

test('published port and health validation identify the exact rejected inspection boundary', () => {
  const dynamicHostPort = validContainerInspection({
    HostConfig: { ...validContainerInspection().HostConfig,
      PortBindings: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] } },
  });
  assert.equal(validatePostgresContainerInspection(dynamicHostPort, {
    containerName, containerId, runId, requirePublishedPort: true,
  }), 49152);

  const invalid = [
    [{ NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '49152' }],
      '5433/tcp': [] } } }, 'isolated_container_published_port_invalid'],
    [{ HostConfig: { ...validContainerInspection().HostConfig,
      PortBindings: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '49153' }] } } },
    'isolated_container_published_port_mismatch'],
    [{ State: { Status: 'running', Health: { Status: 'starting' } } },
    'isolated_container_health_invalid'],
  ];
  for (const [override, code] of invalid) {
    assert.throws(() => validatePostgresContainerInspection(validContainerInspection(override), {
      containerName, containerId, runId, requirePublishedPort: true,
    }), { code });
  }
});

function fakeDocker({ health = 'healthy', context = validDockerIdentity().context,
  contextErrorCode = null, createFailureStderr = null, createFailureErrorCode = null,
  ambiguousLookupAfterCreate = false } = {}) {
  let started = false;
  let removed = false;
  let createFailed = false;
  const calls = [];
  const docker = (args, options = {}) => {
    calls.push({ args, options });
    assert.deepEqual(args.slice(0, 2), ['--context', 'billing-validation-isolated']);
    const command = args.slice(2);
    if (command[0] === 'context' && command[1] === 'inspect') {
      if (contextErrorCode) return { status: 1, stdout: '', stderr: '', errorCode: contextErrorCode };
      return { status: 0, stdout: JSON.stringify(context), stderr: '', errorCode: null };
    }
    if (command[0] === 'info' && command[2] === '{{json .SecurityOptions}}') {
      return { status: 0, stdout: JSON.stringify(validDockerIdentity().securityOptions), stderr: '', errorCode: null };
    }
    if (command[0] === 'info' && command[2] === '{{.DockerRootDir}}') {
      return { status: 0, stdout: validDockerIdentity().dockerRootDir, stderr: '', errorCode: null };
    }
    if (command[0] === 'container' && command[1] === 'ls') {
      if (createFailed && ambiguousLookupAfterCreate) {
        return { status: 1, stdout: '', stderr: 'daemon unavailable', errorCode: null };
      }
      return { status: 0, stdout: '', stderr: '', errorCode: null };
    }
    if (command[0] === 'container' && command[1] === 'create') {
      assert.equal(options.environment.POSTGRES_PASSWORD.length >= 32, true);
      assert.equal(command.includes(`POSTGRES_PASSWORD=${options.environment.POSTGRES_PASSWORD}`), false);
      if (createFailureStderr !== null) {
        createFailed = true;
        return { status: 1, stdout: '', stderr: createFailureStderr, errorCode: createFailureErrorCode };
      }
      return { status: 0, stdout: containerId, stderr: '', errorCode: null };
    }
    if (command[0] === 'container' && command[1] === 'inspect') {
      if (createFailed && command[2] === containerName) {
        return { status: 1, stdout: '', stderr: ambiguousLookupAfterCreate
          ? 'daemon unavailable' : 'Error: No such object', errorCode: null };
      }
      return { status: 0, stdout: JSON.stringify([validContainerInspection({
        State: { Status: started ? 'running' : 'created', Health: { Status: started ? health : 'starting' } },
      })]), stderr: '', errorCode: null };
    }
    if (command[0] === 'container' && command[1] === 'start') {
      started = true;
      return { status: 0, stdout: containerId, stderr: '', errorCode: null };
    }
    if (command[0] === 'container' && command[1] === 'rm') {
      assert.deepEqual(command.slice(2), ['--force', '--volumes', containerId]);
      removed = true;
      return { status: 0, stdout: containerId, stderr: '', errorCode: null };
    }
    throw new Error(`Unexpected fake Docker operation ${command.slice(0, 2).join(' ')}`);
  };
  return { docker, calls, wasRemoved: () => removed };
}

test('harness removes only its exact owned container after an integration-test failure and redacts credentials', async () => {
  const fake = fakeDocker();
  const password = 'synthetic-test-password-1234567890';
  const expectedUrl = `postgresql://billing_control_test_admin:${password}@127.0.0.1:49152/postgres`;

  await assert.rejects(runControlStorePostgresHarness({
    account: serviceAccount,
    docker: fake.docker,
    runId,
    password,
    runTests: async ({ url }) => ({
      status: 1,
      counts: { tests: 1, passed: 0, failed: 1, skipped: 0 },
      output: `failed ${password} ${url}`,
    }),
  }), (error) => {
    assert.equal(error.code, 'isolated_postgres_assertions_failed');
    assert.equal(error.cleanup, 'removed');
    assert.equal(error.safeOutput.includes(password), false);
    assert.equal(error.safeOutput.includes(expectedUrl), false);
    return true;
  });

  assert.equal(fake.wasRemoved(), true);
  assert.equal(fake.calls.filter(({ args }) => args[2] === 'container' && args[3] === 'rm').length, 1);
  assert.ok(fake.calls.every(({ args }) => args[0] === '--context' &&
    args[1] === 'billing-validation-isolated'));
});

test('harness fails closed on the wrong Docker endpoint before creating a container', async () => {
  const wrongContext = [{ Name: 'billing-validation-isolated', Endpoints: {
    docker: { Host: 'unix:///var/run/docker.sock' },
  } }];
  const fake = fakeDocker({ context: wrongContext });

  await assert.rejects(runControlStorePostgresHarness({ account: serviceAccount, docker: fake.docker,
    runId, password: 'synthetic-test-password-1234567890' }),
  { code: 'isolated_docker_identity_invalid' });
  assert.equal(fake.wasRemoved(), false);
  assert.equal(fake.calls.some(({ args }) => args[2] === 'container' && args[3] === 'create'), false);
});

test('missing sudo authorization is reported precisely and creates no container', async () => {
  const fake = fakeDocker({ contextErrorCode: 'sudo_privilege_required' });

  await assert.rejects(runControlStorePostgresHarness({ account: serviceAccount, docker: fake.docker,
    runId, password: 'synthetic-test-password-1234567890' }),
  { code: 'isolated_docker_privilege_required' });
  assert.equal(fake.wasRemoved(), false);
  assert.equal(fake.calls.some(({ args }) => args[2] === 'container' && args[3] === 'create'), false);
});

test('container creation failures return a safe diagnostic category without exposing Docker stderr', async () => {
  const examples = [
    ['Error response from daemon: No such image: postgres:17.11', null,
      'isolated_postgres_image_unavailable'],
    ['failed to resolve reference: dial tcp: lookup registry-1.docker.io: no such host', null,
      'isolated_registry_unreachable'],
    ['Error response from daemon: pull access denied', null, 'isolated_registry_pull_denied'],
    ['Error response from daemon: toomanyrequests', null, 'isolated_registry_rate_limited'],
    ['Error response from daemon: no space left on device', null, 'isolated_docker_storage_exhausted'],
    ['Error response from daemon: operation not permitted', null, 'isolated_docker_host_restriction'],
    ['sudo: a password is required', 'sudo_privilege_required', 'isolated_docker_privilege_required'],
    ['synthetic unknown provider diagnostic', null, 'isolated_container_create_failed'],
  ];

  for (const [dockerStderr, createFailureErrorCode, expectedCode] of examples) {
    const fake = fakeDocker({ createFailureStderr: dockerStderr, createFailureErrorCode });
    await assert.rejects(runControlStorePostgresHarness({ account: serviceAccount, docker: fake.docker,
      runId, password: 'synthetic-test-password-1234567890' }), (error) => {
      assert.equal(error.code, expectedCode);
      assert.equal(error.message.includes(dockerStderr), false);
      assert.equal(error.cleanup, 'not_needed');
      return true;
    });
    assert.equal(fake.wasRemoved(), false);
  }
});

test('a failed create with unverifiable container absence requires manual review, not not-needed cleanup', async () => {
  const fake = fakeDocker({ createFailureStderr: 'opaque create error', ambiguousLookupAfterCreate: true });

  await assert.rejects(runControlStorePostgresHarness({ account: serviceAccount, docker: fake.docker,
    runId, password: 'synthetic-test-password-1234567890' }), (error) => {
    assert.equal(error.code, 'isolated_container_cleanup_needs_review');
    assert.equal(error.cleanup, 'needs_review');
    assert.equal(error.containerName, containerName);
    return true;
  });
  assert.equal(fake.wasRemoved(), false);
});

test('unhealthy and timed-out containers fail and clean only their own container', async () => {
  for (const [health, timeout] of [['unhealthy', 100], ['starting', 5]]) {
    const fake = fakeDocker({ health });
    await assert.rejects(runControlStorePostgresHarness({
      account: serviceAccount,
      docker: fake.docker,
      runId,
      password: 'synthetic-test-password-1234567890',
      healthTimeoutMs: timeout,
      wait: async () => new Promise((resolve) => setTimeout(resolve, 3)),
      runTests: async () => assert.fail('tests must not run before PostgreSQL is healthy'),
    }), (error) => {
      assert.equal(error.code, health === 'unhealthy'
        ? 'isolated_container_health_failed' : 'isolated_container_health_timeout');
      assert.equal(error.cleanup, 'removed');
      return true;
    });
    assert.equal(fake.wasRemoved(), true);
  }
});

test('interrupted harness stops before running tests and verifies exact-container cleanup', async () => {
  const fake = fakeDocker();
  let testsStarted = false;
  await assert.rejects(runControlStorePostgresHarness({
    account: serviceAccount,
    docker: fake.docker,
    runId,
    password: 'synthetic-test-password-1234567890',
    isInterrupted: () => fake.calls.some(({ args }) => args[2] === 'container' && args[3] === 'start'),
    runTests: async () => { testsStarted = true; return { status: 0, counts: { tests: 1,
      passed: 1, failed: 0, skipped: 0 }, output: '' }; },
  }), (error) => {
    assert.equal(error.code, 'isolated_run_interrupted');
    assert.equal(error.cleanup, 'removed');
    return true;
  });
  assert.equal(testsStarted, false);
  assert.equal(fake.wasRemoved(), true);
});
