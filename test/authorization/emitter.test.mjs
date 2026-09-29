import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { authorizationFixture } from './fixtures.mjs';
import { releaseFixture } from './task2-fixtures.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const dispatchModule = path.join(root, 'src/authorization/dispatch.mjs');
const emitterModule = path.join(root, 'src/authorization/emitter.mjs');
async function implementation() {
  assert.ok(await fs.access(dispatchModule).then(() => true, () => false), 'dispatch implementation is required');
  assert.ok(await fs.access(emitterModule).then(() => true, () => false), 'emitter implementation is required');
  return { ...await import(pathToFileURL(dispatchModule)), ...await import(pathToFileURL(emitterModule)) };
}

function fixture() {
  const m = authorizationFixture();
  return {
    dispatch: { candidate_sha: m.candidate.sha, execution_id: m.executionId,
      activation_commitment: m.activationCommitment, suite: m.suite },
    context: { repository: m.control.repository, repositoryId: m.control.repositoryId,
      ref: m.control.ref, defaultBranch: 'main', refProtected: true, eventName: 'workflow_dispatch',
      workflowRef: `${m.control.repository}/${m.control.workflowPath}@refs/heads/main`,
      workflowSha: m.control.sha, sha: m.control.sha, runId: m.control.runId, runAttempt: m.control.runAttempt },
    receipt: { scope: 'candidate-prerequisites', repository: m.candidate.repository, repositoryId: 1234079266,
      candidateSha: m.candidate.sha, treeSha: m.candidate.treeSha, baseSha: m.candidate.baseSha,
      pullNumber: 123, workflowId: 290018021, workflowPath: '.github/workflows/ci.yml',
      runId: m.prerequisites.runId, attempt: 1, jobs: structuredClone(m.prerequisites.jobs) },
    releasePolicy: releaseFixture(m), now: new Date(m.issuedAt),
  };
}

function environment(f = fixture()) {
  return { PATH: process.env.PATH, DISPATCH_INPUTS: JSON.stringify(f.dispatch),
    CANDIDATE_RECEIPT: JSON.stringify(f.receipt),
    CONTROL_REPOSITORY: f.context.repository, CONTROL_REPOSITORY_ID: f.context.repositoryId,
    CONTROL_REF: f.context.ref, CONTROL_DEFAULT_BRANCH: 'main', CONTROL_REF_PROTECTED: 'true',
    CONTROL_EVENT_NAME: 'workflow_dispatch', CONTROL_WORKFLOW_REF: f.context.workflowRef,
    CONTROL_WORKFLOW_SHA: f.context.workflowSha, CONTROL_SHA: f.context.sha,
    CONTROL_RUN_ID: f.context.runId, CONTROL_RUN_ATTEMPT: f.context.runAttempt };
}

test('emission binds the exact candidate receipt and selected release in an immutable twenty minute collect manifest', async () => {
  const { emitLocalAuthorization, parseLocalAuthorizationDispatch } = await implementation();
  const f = fixture();
  const dispatch = parseLocalAuthorizationDispatch(f.dispatch, f.context);
  assert.ok(Object.isFrozen(dispatch));
  const manifest = emitLocalAuthorization({ ...f, dispatch });
  assert.deepEqual(manifest, authorizationFixture());
  f.receipt.jobs[0].jobId = '99';
  f.releasePolicy.releases[0].policy.limitsDigest = '0'.repeat(64);
  assert.equal(manifest.prerequisites.jobs[0].jobId, '456789012');
  assert.equal(manifest.policy.limitsDigest, '7'.repeat(64));
  assert.ok(Object.isFrozen(manifest.prerequisites.jobs[0]));
});

for (const [name, change] of [
  ['unknown image', f => { f.dispatch.image = 'attacker'; }],
  ['legacy runner label', f => { f.dispatch.runner_label = 'runner'; }],
  ['recover', f => { f.dispatch.operation = 'recover'; }],
  ['recheck', f => { f.dispatch.operation = 'recheck'; }],
  ['source execution', f => { f.dispatch.source_execution_id = '2'.repeat(32); }],
  ['uppercase SHA', f => { f.dispatch.candidate_sha = 'A'.repeat(40); }],
  ['bad commitment', f => { f.dispatch.activation_commitment = 'token\n'; }],
  ['missing suite', f => { delete f.dispatch.suite; }],
  ['false protected ref', f => { f.context.refProtected = false; }],
  ['truthy protection', f => { f.context.refProtected = 'true'; }],
  ['other branch', f => { f.context.ref = 'refs/heads/preview'; }],
  ['other default branch', f => { f.context.defaultBranch = 'preview'; }],
  ['other repo', f => { f.context.repository = 'other/repo'; }],
  ['other repo ID', f => { f.context.repositoryId = '123'; }],
  ['PR event', f => { f.context.eventName = 'pull_request'; }],
  ['old workflow', f => { f.context.workflowRef = f.context.workflowRef.replace('authorize-local-collector', 'validate-billing'); }],
  ['workflow SHA mismatch', f => { f.context.workflowSha = 'f'.repeat(40); }],
  ['invalid attempt', f => { f.context.runAttempt = '01'; }],
  ['unsafe run', f => { f.context.runId = '9007199254740992'; }],
]) test(`dispatch admission and emission refuse ${name}`, async () => {
  const api = await implementation(); const f = fixture(); change(f);
  assert.throws(() => api.parseLocalAuthorizationDispatch(f.dispatch, f.context));
  assert.throws(() => api.emitLocalAuthorization(f));
});

for (const [name, change] of [
  ['different SHA', f => { f.receipt.candidateSha = 'f'.repeat(40); }],
  ['alternate repository ID', f => { f.receipt.repositoryId = 123; }],
  ['string repository ID', f => { f.receipt.repositoryId = '1234079266'; }],
  ['unknown secret', f => { f.receipt.token = 'secret'; }],
  ['wrong workflow', f => { f.receipt.workflowId = 12; }],
  ['wrong path', f => { f.receipt.workflowPath = '.github/workflows/other.yml'; }],
  ['invalid attempt', f => { f.receipt.attempt = 0; }],
  ['failed job', f => { f.receipt.jobs[0].conclusion = 'failure'; }],
  ['missing job', f => { f.receipt.jobs.pop(); }],
  ['duplicate job ID', f => { f.receipt.jobs[1].jobId = f.receipt.jobs[0].jobId; }],
  ['duplicate job name', f => { f.receipt.jobs[1].key = 'quality'; }],
  ['extra job', f => { f.receipt.jobs.push(f.receipt.jobs[0]); }],
  ['unreviewed suite', f => { f.dispatch.suite = 'billing-3ds-15'; }],
  ['invalid release', f => { f.releasePolicy.releases[0].collectorRelease.image = 'latest'; }],
  ['ambiguous release', f => { f.releasePolicy.releases.push(f.releasePolicy.releases[0]); }],
  ['invalid date', f => { f.now = new Date(NaN); }],
  ['unknown top-level input', f => { f.operation = 'recover'; }],
]) test(`emitter refuses ${name}`, async () => {
  const { emitLocalAuthorization } = await implementation(); const f = fixture(); change(f);
  assert.throws(() => emitLocalAuthorization(f));
});

test('unconfigured release has an explicit refusal', async () => {
  const { emitLocalAuthorization } = await implementation();
  assert.throws(() => emitLocalAuthorization({ ...fixture(), releasePolicy: { schemaVersion: 1, releases: [] } }),
    { code: 'authorization_release_unconfigured' });
});

test('public emitter and dispatch reject getters/proxies without invoking traps', async () => {
  const api = await implementation(); let touched = 0;
  for (const field of ['dispatch', 'context', 'receipt', 'releasePolicy', 'now']) {
    for (const mode of ['proxy', 'getter']) {
      const f = fixture();
      if (mode === 'proxy') f[field] = new Proxy(f[field], { get() { touched++; throw Error('secret'); },
        ownKeys() { touched++; throw Error('secret'); } });
      else Object.defineProperty(f, field, { get() { touched++; throw Error('secret'); } });
      assert.throws(() => api.emitLocalAuthorization(f));
    }
  }
  const f = fixture();
  Object.defineProperty(f.receipt.jobs, 0, { get() { touched++; throw Error('secret'); } });
  assert.throws(() => api.emitLocalAuthorization(f));
  const input = fixture().dispatch;
  Object.defineProperty(input, 'suite', { get() { touched++; return 'billing-43'; } });
  assert.throws(() => api.parseLocalAuthorizationDispatch(input, fixture().context));
  assert.throws(() => api.emitLocalAuthorization(new Proxy(fixture(), { ownKeys() { touched++; return []; } })));
  assert.equal(touched, 0);
});

async function temporaryControl(t, configured = true) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bvc-emitter-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const name of ['scripts', 'src', 'policy']) await fs.cp(path.join(root, name), path.join(dir, name), { recursive: true });
  if (configured) await fs.writeFile(path.join(dir, 'policy/local-collector-release.json'), JSON.stringify(releaseFixture()));
  return dir;
}
const invoke = (dir, script, env, args = []) => spawnSync(process.execPath, [path.join(dir, 'scripts', script), ...args],
  { cwd: dir, encoding: 'utf8', env });

test('real authorize CLI fails with empty release before emitting any reader admission', async t => {
  await implementation(); const dir = await temporaryControl(t, false);
  const output = path.join(dir, 'output'); await fs.writeFile(output, '');
  const result = invoke(dir, 'authorize-local-collector.mjs', { ...environment(), GITHUB_OUTPUT: output });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'local_authorization_refused (authorization_release_unconfigured)\n');
  assert.equal(result.stdout, ''); assert.equal(await fs.readFile(output, 'utf8'), '');
});

test('real authorize and writer scripts create one private canonical subject and refuse overwrite and symlink', async t => {
  await implementation(); const dir = await temporaryControl(t);
  const output = path.join(dir, 'output'); await fs.writeFile(output, '');
  const env = { ...environment(), GITHUB_OUTPUT: output, RUNNER_TEMP: dir };
  const admitted = invoke(dir, 'authorize-local-collector.mjs', env);
  assert.equal(admitted.status, 0, admitted.stderr);
  assert.equal(await fs.readFile(output, 'utf8'), `dispatch=${JSON.stringify(fixture().dispatch)}\n`);
  const result = invoke(dir, 'write-local-authorization.mjs', env);
  assert.equal(result.status, 0, result.stderr);
  const target = path.join(dir, 'local-collector-authorization.json');
  const bytes = await fs.readFile(target, 'utf8');
  const m = JSON.parse(bytes);
  assert.equal(m.candidate.repositoryId, '1234079266');
  assert.equal(m.operation, 'collect'); assert.equal(m.sourceExecutionId, null);
  assert.equal(Date.parse(m.expiresAt) - Date.parse(m.issuedAt), 1_200_000);
  assert.equal(bytes, JSON.stringify(m) + '\n');
  assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(JSON.parse(result.stdout)), ['scope', 'authorizationDigest']);
  assert.equal(JSON.parse(result.stdout).scope, 'authorization-only');
  assert.equal(JSON.parse(result.stdout).authorizationDigest, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(invoke(dir, 'write-local-authorization.mjs', env).status, 1);
  assert.equal(await fs.readFile(target, 'utf8'), bytes);
  await fs.unlink(target); await fs.symlink(output, target);
  assert.equal(invoke(dir, 'write-local-authorization.mjs', env).status, 1);
  assert.equal(await fs.readFile(output, 'utf8'), `dispatch=${JSON.stringify(fixture().dispatch)}\n`);
});

test('environment adapter refuses getters and proxies without executing them', async () => {
  const api = await implementation(); let touched = 0;
  const e = environment();
  Object.defineProperty(e, 'CONTROL_REF', { get() { touched++; return 'refs/heads/main'; } });
  assert.throws(() => api.localAuthorizationContextFromEnvironment(e));
  assert.throws(() => api.localAuthorizationContextFromEnvironment(new Proxy(environment(), {
    get() { touched++; return 'secret'; }, ownKeys() { touched++; return []; },
  })));
  assert.equal(touched, 0);
});

test('writer snapshots before policy I/O and malformed receipts or unconfigured policy never create a subject', async t => {
  await implementation(); const dir = await temporaryControl(t);
  const { main } = await import(pathToFileURL(path.join(dir, 'scripts/write-local-authorization.mjs')));
  const env = { ...environment(), RUNNER_TEMP: dir };
  const lines = []; t.mock.method(console, 'log', line => lines.push(line));
  const pending = main(env);
  env.RUNNER_TEMP = '/forbidden-path'; env.CANDIDATE_RECEIPT = 'secret'; env.DISPATCH_INPUTS = '{}';
  assert.equal(await pending, 0);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'local-collector-authorization.json'), 'utf8')).candidate.sha,
    'a'.repeat(40));
  await fs.unlink(path.join(dir, 'local-collector-authorization.json'));
  for (const mutate of [f => { f.receipt.candidateSha = 'b'.repeat(40); },
    f => { f.receipt.repositoryId = 42; }, f => { f.receipt.jobs[0].conclusion = 'failure'; }]) {
    const f = fixture(); mutate(f);
    const result = invoke(dir, 'write-local-authorization.mjs', { ...environment(f), RUNNER_TEMP: dir });
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
  }
  await fs.writeFile(path.join(dir, 'policy/local-collector-release.json'), '{"schemaVersion":1,"releases":[]}');
  const result = invoke(dir, 'write-local-authorization.mjs', { ...environment(), RUNNER_TEMP: dir,
    RELEASE_POLICY: JSON.stringify(releaseFixture()), AUTHORIZATION_MANIFEST_PATH: path.join(dir, 'injected.json') });
  assert.equal(result.status, 1);
  assert.equal(await fs.access(path.join(dir, 'local-collector-authorization.json')).then(() => true, () => false), false);
  assert.equal(await fs.access(path.join(dir, 'injected.json')).then(() => true, () => false), false);
});

test('all real CLI imports are inert and malformed invocations sanitize errors and create no artifact', async t => {
  await implementation(); const dir = await temporaryControl(t);
  for (const script of ['authorize-local-collector.mjs', 'read-local-authorization-candidate.mjs', 'write-local-authorization.mjs']) {
    const imported = spawnSync(process.execPath, ['--input-type=module', '-e',
      `await import(${JSON.stringify(pathToFileURL(path.join(dir, 'scripts', script)).href)})`],
    { encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(imported.status, 0, imported.stderr); assert.equal(imported.stdout + imported.stderr, '');
    const result = invoke(dir, script, { ...environment(), DISPATCH_INPUTS: 'secret-invalid-json',
      CANDIDATE_READ_TOKEN: 'never-echo-token', RUNNER_TEMP: dir, GITHUB_OUTPUT: path.join(dir, 'output') });
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.match(result.stderr, /^local_authorization_refused \([a-z_]+\)\n$/u);
    assert.doesNotMatch(result.stderr, /secret-invalid-json|never-echo-token/);
    const extra = invoke(dir, script, environment(), ['--image=secret']);
    assert.equal(extra.status, 1); assert.doesNotMatch(extra.stderr, /secret/);
  }
  assert.equal(await fs.access(path.join(dir, 'local-collector-authorization.json')).then(() => true, () => false), false);
});

// HTTP doubles exercise the existing scoped App client and real candidate admission.
function mockCandidate(t, mutate = () => {}, onRequest = () => {}) {
  const f = fixture(); const repo = f.receipt.repository; let reads = 0;
  const run = { id: 345678901, workflow_id: 290018021, path: '.github/workflows/ci.yml', event: 'pull_request',
    head_sha: f.dispatch.candidate_sha, run_attempt: 1, status: 'in_progress', conclusion: null,
    run_started_at: '2026-09-29T10:00:00Z', repository: { id: 1234079266, full_name: repo },
    head_repository: { id: 1234079266, full_name: repo },
    pull_requests: [{ number: 123, base: { ref: 'preview', sha: f.receipt.baseSha } }] };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    reads++; onRequest();
    assert.equal(options.headers.Authorization, 'Bearer token-sentinel');
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
    const route = new URL(url).pathname; let response;
    if (route.endsWith('/pulls')) response = [{ number: 123, state: 'open',
      head: { sha: f.dispatch.candidate_sha, repo: { id: 1234079266, full_name: repo } },
      base: { ref: 'preview', sha: f.receipt.baseSha, repo: { id: 1234079266, full_name: repo } } }];
    else if (route.endsWith('/files')) response = [];
    else if (route.includes('/git/commits/')) response = { sha: f.dispatch.candidate_sha, tree: { sha: f.receipt.treeSha } };
    else if (route.includes('/git/trees/')) response = { sha: f.receipt.treeSha, truncated: false, tree: [] };
    else if (route.endsWith('/runs')) response = { total_count: 1, workflow_runs: [structuredClone(run)] };
    else if (route.endsWith('/attempts/1')) response = structuredClone(run);
    else if (route.endsWith('/jobs')) response = { total_count: 3, jobs:
      ['Qualidade (ESLint + TypeScript)', 'Regressão (unitários, integração e cobertura crítica)', 'Build de produção']
        .map((name, i) => ({ id: 456789012 + i, name, run_id: run.id, run_attempt: 1, head_sha: run.head_sha,
          status: 'completed', conclusion: 'success', started_at: '2026-09-29T10:01:00Z', completed_at: '2026-09-29T10:02:00Z' })) };
    else assert.fail('unexpected request');
    mutate(response, route, reads);
    return Response.json(response);
  });
  return () => reads;
}

test('safe reader emits only the bounded sanitized receipt and snapshots env before HTTP awaits', async t => {
  await implementation();
  const { main } = await import('../../scripts/read-local-authorization-candidate.mjs');
  const dir = await temporaryControl(t); const output = path.join(dir, 'output'); await fs.writeFile(output, '');
  const env = { ...environment(), CANDIDATE_READ_TOKEN: 'token-sentinel', GITHUB_OUTPUT: output };
  const calls = mockCandidate(t, response => { response.privateCredential = 'secret-response'; }, () => {
    env.GITHUB_OUTPUT = path.join(dir, 'injected'); env.CONTROL_REF = 'refs/heads/evil';
    env.DISPATCH_INPUTS = '{}'; env.CANDIDATE_READ_TOKEN = 'changed';
  });
  const lines = []; t.mock.method(console, 'log', line => lines.push(line));
  assert.equal(await main(env), 0); assert.ok(calls() > 1);
  assert.equal(await fs.readFile(output, 'utf8'), `receipt=${JSON.stringify(fixture().receipt)}\n`);
  assert.deepEqual(lines, []);
  assert.equal(await fs.access(path.join(dir, 'injected')).then(() => true, () => false), false);
});

for (const scenario of ['wrong ID', 'stale attempt', 'failed job', 'upstream error', 'unsafe context']) {
  test(`safe reader refuses ${scenario} without outputs or leaking credentials`, async t => {
    await implementation(); const { main } = await import('../../scripts/read-local-authorization-candidate.mjs');
    const dir = await temporaryControl(t); const output = path.join(dir, 'output'); await fs.writeFile(output, '');
    const calls = mockCandidate(t, (response, route, reads) => {
      if (scenario === 'upstream error') throw Error('token-sentinel');
      if (scenario === 'wrong ID' && route.endsWith('/pulls')) {
        response[0].head.repo.id = 777; response[0].base.repo.id = 777;
      }
      if (scenario === 'failed job' && route.endsWith('/jobs')) response.jobs[0].conclusion = 'failure';
      if (scenario === 'stale attempt' && route.endsWith('/runs') && reads > 7) response.workflow_runs[0].run_attempt = 2;
    });
    const env = { ...environment(), CANDIDATE_READ_TOKEN: 'token-sentinel', GITHUB_OUTPUT: output };
    if (scenario === 'unsafe context') env.CONTROL_REF_PROTECTED = 'false';
    const errors = []; t.mock.method(console, 'error', line => errors.push(line));
    assert.equal(await main(env), 1); assert.equal(await fs.readFile(output, 'utf8'), '');
    assert.deepEqual(errors, ['local_authorization_refused (authorization_reader_failed)']);
    if (scenario === 'unsafe context') assert.equal(calls(), 0);
  });
}
