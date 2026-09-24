import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dockerfilePath = path.join(root, 'runner/Dockerfile');
const dockerignorePath = path.join(root, 'runner/Dockerfile.dockerignore');
const entrypointPath = path.join(root, 'runner/entrypoint.sh');
const registrationToken = 'placeholder-value-not-a-credential';
const runnerLabel = `billing-validation-${'a'.repeat(32)}`;

test('runner image pins matching Playwright and checksums the exact ephemeral runner archive', async () => {
  const dockerfile = await readFile(dockerfilePath, 'utf8');
  const dockerignore = await readFile(dockerignorePath, 'utf8');

  assert.match(dockerfile, /^ARG PLAYWRIGHT_BASE_DIGEST$/mu);
  assert.match(dockerfile, /^FROM mcr\.microsoft\.com\/playwright:v1\.62\.1-noble@\$\{PLAYWRIGHT_BASE_DIGEST\}$/mu);
  assert.match(dockerfile, /ARG ACTIONS_RUNNER_VERSION\b/u);
  assert.match(dockerfile, /ARG ACTIONS_RUNNER_SHA256\b/u);
  assert.match(dockerfile, /sha256sum\s+-c/u);
  assert.match(dockerfile, /USER 10001:10001/u);
  assert.match(dockerfile, /COPY --chmod=0555 entrypoint\.sh/u);
  assert.match(dockerfile, /COPY --chmod=0555 egress-proxy\.mjs/u);
  assert.match(dockerfile, /\/run\/billing-validation\/Xauthority/u);
  assert.match(dockerfile, /\/tmp\/\.X11-unix/u);
  assert.match(dockerignore, /^\*\*$/mu);
  assert.match(dockerignore, /^!entrypoint\.sh$/mu);
  assert.match(dockerignore, /^!egress-proxy\.mjs$/mu);
  assert.match(dockerignore, /^!Dockerfile$/mu);
  assert.doesNotMatch(dockerfile, /\blatest\b|\/var\/run\/docker\.sock|--network\s+host|\bVOLUME\b/iu);
});

test('runner entrypoint requires the unique per-attempt label and configures one ephemeral job', async () => {
  const entrypoint = await readFile(entrypointPath, 'utf8');

  assert.match(entrypoint, /billing-validation-\(\[0-9a-f\]\{32\}\)/u);
  assert.match(entrypoint, /--ephemeral/u);
  assert.match(entrypoint, /--disableupdate/u);
  assert.match(entrypoint, /--no-default-labels/u);
  assert.match(entrypoint, /--once/u);
  assert.match(entrypoint, /--runnergroup/u);
  assert.match(entrypoint, /CONTROL_EVENT_NAME/u);
  assert.match(entrypoint, /CONTROL_WORKFLOW_REF/u);
  assert.match(entrypoint, /CONTROL_DEFAULT_BRANCH/u);
  assert.match(entrypoint, /CONTROL_ACTIVATION_COMMITMENT/u);
  assert.doesNotMatch(entrypoint, /GITHUB_/u,
    'the entrypoint runs before GitHub assigns a job identity');
  assert.doesNotMatch(entrypoint, /--replace|--network\s+host|\/var\/run\/docker\.sock/iu);
  assert.match(entrypoint, /unset\s+RUNNER_REGISTRATION_TOKEN/u);
});

async function withFakeRunner(runStatus, operation) {
  const runnerHome = await mkdtemp(path.join(tmpdir(), 'bvc-runner-test-'));
  const capturePath = path.join(runnerHome, 'config-args.txt');
  const configPath = path.join(runnerHome, 'config.sh');
  const runPath = path.join(runnerHome, 'run.sh');
  await writeFile(configPath, `#!/bin/sh
set -eu
: > "$BVC_TEST_CONFIG_CAPTURE"
redact=no
while [ "$#" -gt 0 ]; do
  if [ "$redact" = yes ]; then
    printf '%s\\n' '[redacted]' >> "$BVC_TEST_CONFIG_CAPTURE"
    redact=no
  else
    printf '%s\\n' "$1" >> "$BVC_TEST_CONFIG_CAPTURE"
    [ "$1" = --token ] && redact=yes
  fi
  shift
done
: > "$ACTIONS_RUNNER_HOME/.credentials"
: > "$ACTIONS_RUNNER_HOME/.credentials_rsaparams"
`);
  await writeFile(runPath, `#!/bin/sh
if [ "\${BVC_TEST_BLOCK_RUNNER:-no}" = yes ]; then
  : > "$BVC_TEST_RUNNER_STARTED"
  trap 'exit 143' TERM
  while :; do sleep 0.02; done
fi
exit "$BVC_TEST_RUN_STATUS"
`);
  await import('node:fs/promises').then(({ chmod }) => Promise.all([
    chmod(configPath, 0o700), chmod(runPath, 0o700),
  ]));
  const env = { ...process.env, ACTIONS_RUNNER_HOME: runnerHome,
    GITHUB_REPOSITORY: 'forged/local-value-is-ignored',
    CONTROL_REPOSITORY: 'lawxcompany-stack/billing-validation-control',
    CONTROL_REPOSITORY_ID: '12345678',
    CONTROL_EVENT_NAME: 'workflow_dispatch', CONTROL_DEFAULT_BRANCH: 'main',
    CONTROL_REF: 'refs/heads/main',
    CONTROL_WORKFLOW_PATH: '.github/workflows/validate-billing.yml',
    CONTROL_WORKFLOW_REF: 'lawxcompany-stack/billing-validation-control/.github/workflows/validate-billing.yml@refs/heads/main',
    CONTROL_RUN_ID: '123456789', CONTROL_RUN_ATTEMPT: '2',
    CONTROL_WORKFLOW_SHA: 'd'.repeat(40), CONTROL_CANDIDATE_SHA: 'a'.repeat(40),
    CONTROL_ACTIVATION_COMMITMENT: 'c'.repeat(64), CONTROL_RUNNER_LABEL: runnerLabel,
    CONTROL_RUNNER_GROUP: 'billing-validation-isolated',
    RUNNER_LABEL: runnerLabel, RUNNER_REGISTRATION_TOKEN: registrationToken,
    BVC_TEST_CONFIG_CAPTURE: capturePath, BVC_TEST_RUNNER_STARTED: path.join(runnerHome, 'runner-started'),
    BVC_TEST_BLOCK_RUNNER: 'no', BVC_TEST_RUN_STATUS: String(runStatus) };
  try { await operation({ env, runnerHome, capturePath }); }
  finally { await rm(runnerHome, { recursive: true, force: true }); }
}

test('mocked ephemeral runner success and failure scrub credentials and preserve runner status', async () => {
  await withFakeRunner(0, async ({ env, runnerHome, capturePath }) => {
    const result = spawnSync('bash', [entrypointPath], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /placeholder-value-not-a-credential/u);
    const configArgs = await readFile(capturePath, 'utf8');
    assert.match(configArgs, /--ephemeral/u);
    assert.match(configArgs, /--disableupdate/u);
    assert.match(configArgs, /--no-default-labels/u);
    assert.match(configArgs, /--runnergroup\nbilling-validation-isolated/u);
    assert.match(configArgs, /--labels/u);
    assert.match(configArgs, /\[redacted\]/u);
    assert.doesNotMatch(configArgs, /placeholder-value-not-a-credential/u);
    await assert.rejects(access(path.join(runnerHome, '.credentials')));
    await assert.rejects(access(path.join(runnerHome, '.credentials_rsaparams')));
  });

  await withFakeRunner(37, async ({ env, runnerHome }) => {
    const result = spawnSync('bash', [entrypointPath], { env, encoding: 'utf8' });
    assert.equal(result.status, 37);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /placeholder-value-not-a-credential/u);
    await assert.rejects(access(path.join(runnerHome, '.credentials')));
    await assert.rejects(access(path.join(runnerHome, '.credentials_rsaparams')));
  });
});

test('runner entrypoint refuses a fixed or malformed label before runner registration', async () => {
  await withFakeRunner(0, async ({ env, runnerHome, capturePath }) => {
    const result = spawnSync('bash', [entrypointPath], { env: { ...env, RUNNER_LABEL: 'billing-validation-static' }, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    await assert.rejects(access(capturePath));
    await assert.rejects(access(path.join(runnerHome, '.credentials')));
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /placeholder-value-not-a-credential/u);
  });
});

test('runner entrypoint ignores forgeable local GitHub environment values', async () => {
  await withFakeRunner(0, async ({ env, runnerHome, capturePath }) => {
    const result = spawnSync('bash', [entrypointPath], { env: { ...env,
      GITHUB_REPOSITORY: 'attacker/repository', GITHUB_RUN_ID: '1',
      GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: 'f'.repeat(40) }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(await readFile(capturePath, 'utf8'), /--ephemeral/u);
    await assert.rejects(access(path.join(runnerHome, '.credentials')));
  });
});

test('runner entrypoint refuses malformed or mismatched CONTROL metadata before registration', async () => {
  const rejected = [
    { CONTROL_REPOSITORY_ID: '0' },
    { CONTROL_EVENT_NAME: 'pull_request' },
    { CONTROL_DEFAULT_BRANCH: 'trunk' },
    { CONTROL_REF: 'refs/heads/feature' },
    { CONTROL_WORKFLOW_PATH: '.github/workflows/other.yml' },
    { CONTROL_WORKFLOW_REF: 'lawxcompany-stack/billing-validation-control/.github/workflows/other.yml@refs/heads/main' },
    { CONTROL_RUN_ID: '01' },
    { CONTROL_RUN_ATTEMPT: '0' },
    { CONTROL_WORKFLOW_SHA: 'not-a-sha' },
    { CONTROL_CANDIDATE_SHA: 'A'.repeat(40) },
    { CONTROL_ACTIVATION_COMMITMENT: 'nonce-must-not-be-presented' },
    { CONTROL_RUNNER_LABEL: `billing-validation-${'b'.repeat(32)}` },
    { CONTROL_RUNNER_GROUP: 'shared-runner-group' },
  ];
  for (const override of rejected) {
    await withFakeRunner(0, async ({ env, runnerHome, capturePath }) => {
      const result = spawnSync('bash', [entrypointPath], { env: { ...env, ...override }, encoding: 'utf8' });
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, /placeholder-value-not-a-credential/u);
      await assert.rejects(access(capturePath));
      await assert.rejects(access(path.join(runnerHome, '.credentials')));
    });
  }
});

test('runner entrypoint handles cancellation and removes one-job credentials', async () => {
  await withFakeRunner(0, async ({ env, runnerHome, capturePath }) => {
    const child = spawn('bash', [entrypointPath], { env: { ...env, BVC_TEST_BLOCK_RUNNER: 'yes' }, stdio: 'ignore' });
    const startedPath = env.BVC_TEST_RUNNER_STARTED;
    const cutoff = Date.now() + 5000;
    let started = false;
    while (Date.now() < cutoff) {
      try { await access(startedPath); started = true; break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
    }
    if (!started) child.kill('SIGKILL');
    assert.equal(started, true, 'mock runner should reach its one-job loop');
    child.kill('SIGTERM');
    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code));
    });
    assert.equal(exitCode, 143);
    assert.doesNotMatch(await readFile(capturePath, 'utf8'), /placeholder-value-not-a-credential/u);
    await assert.rejects(access(path.join(runnerHome, '.credentials')));
    await assert.rejects(access(path.join(runnerHome, '.credentials_rsaparams')));
  });
});
