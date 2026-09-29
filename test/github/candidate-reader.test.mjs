import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { readCandidatePrerequisites } from '../../src/github/candidate-reader.mjs';
import { main } from '../../scripts/read-candidate.mjs';

const repository = 'lawxcompany-stack/Plataforma-LawX';
const sha = '1'.repeat(40);
const tree = '2'.repeat(40);
const context = { repository: 'lawxcompany-stack/billing-validation-control', ref: 'refs/heads/main',
  defaultBranch: 'main', refProtected: true, eventName: 'workflow_dispatch' };

function fixture({ files = [], moveHead = false, brokenQuality = false } = {}) {
  const calls = [];
  let pullReads = 0;
  const api = { async get(path) {
    calls.push(path);
    if (path.includes(`/commits/${sha}/pulls?`)) {
      pullReads++;
      return [{ number: 139, state: 'open', head: { sha: moveHead && pullReads > 1 ? '9'.repeat(40) : sha,
        repo: { full_name: repository, id: 1234079266 } },
      base: { sha: '3'.repeat(40), ref: 'preview', repo: { full_name: repository, id: 1234079266 } } }];
    }
    if (path.includes('/pulls/139/files?')) return files;
    if (path.endsWith(`/git/commits/${sha}`)) return { sha, tree: { sha: tree } };
    if (path.includes(`/git/trees/${tree}?`)) return { sha: tree, truncated: false,
      tree: files.map((file) => ({ path: file.filename, type: 'blob', sha: '4'.repeat(40) })) };
    const run = { id: 10, workflow_id: 290018021, path: '.github/workflows/ci.yml', event: 'pull_request',
      head_sha: sha, run_attempt: 1, status: 'completed', conclusion: 'failure',
      run_started_at: '2026-09-29T10:00:00Z',
      repository: { full_name: repository, id: 1234079266 }, head_repository: { full_name: repository, id: 1234079266 },
      pull_requests: [{ number: 139, base: { ref: 'preview', sha: '3'.repeat(40) } }] };
    if (path.includes('/actions/workflows/')) return { total_count: 1, workflow_runs: [run] };
    if (path.endsWith('/attempts/1')) return run;
    if (path.includes('/attempts/1/jobs?')) return { total_count: 3,
      jobs: ['Qualidade (ESLint + TypeScript)', 'Regressão (unitários, integração e cobertura crítica)',
        'Build de produção'].map((name, i) => ({ id: 100 + i, run_id: 10, run_attempt: 1, head_sha: sha, name,
        status: 'completed', conclusion: brokenQuality && i === 0 ? 'failure' : 'success',
        started_at: '2026-09-29T10:01:00Z', completed_at: '2026-09-29T10:02:00Z' })) };
    assert.fail(`Unexpected API request ${path}`);
  } };
  return { api, calls };
}

test('protected control reader composes current PR identity with only candidate prerequisite checks', async () => {
  const f = fixture();
  const result = await readCandidatePrerequisites({ api: f.api, candidateSha: sha, context });
  assert.equal(result.scope, 'candidate-prerequisites');
  assert.equal(result.runId, '10');
  assert.equal(result.treeSha, tree);
  assert.equal(result.billingReady, undefined);
  assert.ok(f.calls.every((path) => path.startsWith(`/repos/${repository}/`)));
});

for (const change of [{ ref: 'refs/heads/feature' }, { refProtected: false }, { eventName: 'pull_request' }]) {
  test(`untrusted control context stops before credentials can be used: ${Object.keys(change)[0]}`, async () => {
    const f = fixture();
    await assert.rejects(readCandidatePrerequisites({ api: f.api, candidateSha: sha, context: { ...context, ...change } }));
    assert.equal(f.calls.length, 0);
  });
}

test('unreviewed candidate workflow changes remain blocked before prerequisite queries', async () => {
  const f = fixture({ files: [{ filename: '.github/workflows/ci.yml', status: 'modified' }] });
  await assert.rejects(readCandidatePrerequisites({ api: f.api, candidateSha: sha, context }),
    { code: 'candidate_protected_source_unreviewed' });
  assert.ok(!f.calls.some((path) => path.includes('/actions/')));
});

test('required CI job failure and moving PR head both prevent reader approval', async () => {
  await assert.rejects(readCandidatePrerequisites({ api: fixture({ brokenQuality: true }).api, candidateSha: sha, context }),
    { code: 'candidate_checks_job_not_successful' });
  await assert.rejects(readCandidatePrerequisites({ api: fixture({ moveHead: true }).api, candidateSha: sha, context }),
    { code: 'candidate_head_not_current' });
});

test('reader CLI import is inert and malformed invocation reveals no credential or environment values', () => {
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./scripts/read-candidate.mjs')"],
    { encoding: 'utf8', env: { ...process.env, CANDIDATE_READ_TOKEN: 'never-echo-this-token' } });
  assert.equal(imported.status, 0);
  assert.equal(imported.stdout, '');
  assert.equal(imported.stderr, '');
  const invoked = spawnSync(process.execPath, ['scripts/read-candidate.mjs'], { encoding: 'utf8',
    env: { PATH: process.env.PATH, CANDIDATE_READ_TOKEN: 'never-echo-this-token', CANDIDATE_SHA: sha } });
  assert.equal(invoked.status, 1);
  assert.equal(invoked.stdout, '');
  assert.match(invoked.stderr, /^candidate_reader_refused \([a-z_]+\)\n$/u);
  assert.ok(!invoked.stderr.includes('never-echo-this-token'));
});

test('reader CLI logs only a minimal prerequisite summary, never paths, repository contents or credentials', async (t) => {
  const f = fixture({ files: [{ filename: 'app/private-path-sentinel.mjs', status: 'modified' }] });
  const lines = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    return Response.json(await f.api.get(url.pathname + url.search));
  });
  t.mock.method(console, 'log', (line) => lines.push(line));
  const result = await main({ CONTROL_REPOSITORY: context.repository, CONTROL_REF: context.ref,
    CONTROL_DEFAULT_BRANCH: context.defaultBranch, CONTROL_REF_PROTECTED: 'true',
    CONTROL_EVENT_NAME: 'workflow_dispatch', CANDIDATE_SHA: sha, CANDIDATE_READ_TOKEN: 'token-sentinel' });
  assert.equal(result, 0);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { scope: 'candidate-prerequisites', candidateSha: sha,
    runId: '10', attempt: 1, checks: ['quality', 'regression', 'build'] });
  assert.doesNotMatch(lines[0], /Plataforma-LawX|private-path-sentinel|workflowPath|token-sentinel/);
});
