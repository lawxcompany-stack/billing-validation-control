import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as evidence from '../../src/github/ci-evidence.mjs';

const repository = 'lawxcompany-stack/Plataforma-LawX';
const candidate = Object.freeze({ repository, repositoryId: 1234079266, pullNumber: 139,
  candidateSha: '1'.repeat(40), treeSha: '2'.repeat(40), baseSha: '3'.repeat(40) });
const names = ['Qualidade (ESLint + TypeScript)',
  'Regressão (unitários, integração e cobertura crítica)', 'Build de produção'];

function run(id = 100, overrides = {}) {
  return { id, workflow_id: 290018021, path: '.github/workflows/ci.yml', event: 'pull_request',
    head_sha: candidate.candidateSha, run_attempt: 1, status: 'completed', conclusion: 'failure',
    run_started_at: '2026-09-29T10:00:00Z', repository: { id: candidate.repositoryId, full_name: repository },
    head_repository: { id: candidate.repositoryId, full_name: repository },
    pull_requests: [{ number: 139, base: { ref: 'preview', sha: candidate.baseSha } }], ...overrides };
}

function jobs(record = run()) {
  return names.map((name, index) => ({ id: 200 + index, run_id: record.id, run_attempt: record.run_attempt,
    head_sha: candidate.candidateSha, name, status: 'completed', conclusion: 'success',
    started_at: '2026-09-29T10:01:00Z', completed_at: '2026-09-29T10:02:00Z' }));
}

function fixture({ runs = [run()], jobList = jobs(), onGet } = {}) {
  const calls = [];
  const api = { async get(path) {
    calls.push(path);
    const override = onGet?.(path, calls);
    if (override !== undefined) return override;
    const url = new URL(path, 'https://api.github.com');
    if (url.pathname.endsWith('/runs')) {
      assert.equal(url.searchParams.get('head_sha'), candidate.candidateSha);
      assert.equal(url.searchParams.get('event'), 'pull_request');
      return { workflow_runs: runs, total_count: runs.length };
    }
    if (url.pathname.endsWith('/jobs')) return { jobs: jobList, total_count: jobList.length };
    const match = url.pathname.match(/\/runs\/(\d+)\/attempts\/(\d+)$/u);
    assert.ok(match, `Unexpected endpoint: ${path}`);
    return runs.find((value) => value.id === Number(match[1]));
  } };
  return { api, calls };
}

async function collect(input) {
  assert.equal(typeof evidence.collectCandidateChecks, 'function', 'a separate prerequisite reader is required');
  return evidence.collectCandidateChecks(input);
}

test('successful candidate prerequisites do not wait for downstream billing acceptance or artifacts', async () => {
  const f = fixture({ jobList: [...jobs(), { ...jobs()[0], id: 299, name: 'Billing acceptance', conclusion: 'failure' }] });
  const result = await collect({ api: f.api, candidate });
  assert.equal(result.scope, 'candidate-prerequisites');
  assert.equal(result.runId, '100');
  assert.equal(result.attempt, 1);
  assert.equal(result.candidateSha, candidate.candidateSha);
  assert.deepEqual(result.jobs.map((job) => job.key), ['quality', 'regression', 'build']);
  assert.ok(result.jobs.every((job) => job.conclusion === 'success'));
  assert.equal(result.billingReady, undefined);
  assert.ok(!f.calls.some((path) => /artifact|download/u.test(path)));
});

test('candidate admission can finish while the workflow waits for its downstream financial evidence', async () => {
  const f = fixture({ runs: [run(100, { status: 'in_progress', conclusion: null })] });
  assert.equal((await collect({ api: f.api, candidate })).runId, '100');
});

for (const conclusion of ['failure', 'cancelled', 'skipped', 'neutral', 'timed_out']) {
  test(`required candidate job ${conclusion} blocks admission`, async () => {
    const list = jobs();
    list[1].conclusion = conclusion;
    const f = fixture({ jobList: list });
    await assert.rejects(collect({ api: f.api, candidate }), { code: 'candidate_checks_job_not_successful' });
  });
}

for (const [label, change, code] of [
  ['missing', (list) => list.pop(), 'candidate_checks_job_missing'],
  ['duplicate name', (list) => list.push({ ...list[0], id: 999 }), 'candidate_checks_job_ambiguous'],
  ['foreign SHA', (list) => { list[0].head_sha = '9'.repeat(40); }, 'candidate_checks_job_identity_invalid'],
  ['foreign run', (list) => { list[0].run_id = 999; }, 'candidate_checks_job_identity_invalid'],
  ['old attempt', (list) => { list[0].run_attempt = 2; }, 'candidate_checks_job_identity_invalid'],
  ['in progress', (list) => { list[0].status = 'in_progress'; }, 'candidate_checks_job_not_successful'],
  ['stale timestamp', (list) => { list[0].started_at = '2026-09-28T10:00:00Z'; }, 'candidate_checks_job_identity_invalid'],
]) {
  test(`${label} prerequisite cannot be filled by an older or unrelated job`, async () => {
    const list = jobs();
    change(list);
    await assert.rejects(collect({ api: fixture({ jobList: list }).api, candidate }), { code });
  });
}

test('a newer failed candidate job never falls back to an earlier successful run', async () => {
  const latest = run(101, { run_started_at: '2026-09-29T10:00:30Z' });
  const list = jobs(latest);
  list[0].conclusion = 'failure';
  const f = fixture({ runs: [run(), latest], jobList: list });
  await assert.rejects(collect({ api: f.api, candidate }), { code: 'candidate_checks_job_not_successful' });
  assert.ok(f.calls.some((path) => path.includes('/runs/101/attempts/1/jobs')));
});

test('cancelling an overall run refuses it even if its earlier prerequisite jobs passed', async () => {
  const f = fixture({ runs: [run(100, { conclusion: 'cancelled' })] });
  await assert.rejects(collect({ api: f.api, candidate }), { code: 'candidate_checks_run_not_usable' });
});

test('a queued rerun cannot reuse completed prerequisites from the previous attempt', async () => {
  const f = fixture({ runs: [run(100, { status: 'queued', conclusion: null, run_attempt: 2 })] });
  await assert.rejects(collect({ api: f.api, candidate }), { code: 'candidate_checks_run_not_usable' });
});

for (const change of [
  { event: 'push' }, { head_sha: '9'.repeat(40) }, { workflow_id: 99 },
  { path: '.github/workflows/other.yml' }, { head_repository: { id: 1, full_name: 'other/repo' } },
  { pull_requests: [{ number: 139, base: { ref: 'preview', sha: '9'.repeat(40) } }] },
]) {
  test(`mismatched workflow binding is refused: ${Object.keys(change)[0]}`, async () => {
    const f = fixture({ runs: [run(100, change)] });
    await assert.rejects(collect({ api: f.api, candidate }), { code: 'candidate_checks_run_not_found' });
  });
}

test('a rerun started during observation invalidates the receipt before it is returned', async () => {
  let lists = 0;
  const f = fixture({ onGet(path) {
    if (path.endsWith('/attempts/2')) return run(100, { run_attempt: 2 });
    if (path.includes('/actions/workflows/') && ++lists === 2) {
      return { total_count: 1, workflow_runs: [run(100, { run_attempt: 2 })] };
    }
  } });
  await assert.rejects(collect({ api: f.api, candidate }), { code: 'candidate_checks_changed_during_read' });
});

test('job pagination is complete before missing prerequisites are decided', async () => {
  const unrelated = Array.from({ length: 100 }, (_, i) => ({ ...jobs()[0], id: 1000 + i, name: `other-${i}` }));
  const f = fixture({ onGet(path) {
    if (path.includes('/jobs?')) return { total_count: 103,
      jobs: new URL(path, 'https://api.github.com').searchParams.get('page') === '1' ? unrelated : jobs() };
  } });
  assert.equal((await collect({ api: f.api, candidate })).jobs.length, 3);
});

for (const total of [undefined, null, -1, '1', 0, 2]) {
  test(`run list refuses malformed or incomplete total_count: ${String(total)}`, async () => {
    const f = fixture({ onGet(path) {
      if (path.includes('/actions/workflows/')) return { total_count: total, workflow_runs: [run()] };
    } });
    await assert.rejects(collect({ api: f.api, candidate }), { code: 'candidate_checks_run_list_invalid' });
    assert.equal(f.calls.some(path => path.includes('/attempts/')), false);
  });
}

test('run pagination includes the newest candidate attempt on a later page', async () => {
  const unrelated = Array.from({ length: 100 }, (_, i) => run(1000 + i, { event: 'push' }));
  const f = fixture({ onGet(path) {
    if (path.includes('/actions/workflows/')) return { total_count: 101,
      workflow_runs: new URL(path, 'https://api.github.com').searchParams.get('page') === '1' ? unrelated : [run()] };
  } });
  assert.equal((await collect({ api: f.api, candidate })).runId, '100');
});

test('invalid inputs fail before a GitHub request and API exceptions stay sanitized', async () => {
  const f = fixture();
  await assert.rejects(collect({ api: f.api, candidate: { ...candidate, candidateSha: 'main' } }),
    { code: 'candidate_checks_input_invalid' });
  assert.equal(f.calls.length, 0);
  await assert.rejects(collect({ candidate, api: { get() { throw new Error('token private response'); } } }),
    { message: 'candidate_checks_api_unavailable', code: 'candidate_checks_api_unavailable' });
});
