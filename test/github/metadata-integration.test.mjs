import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import * as ciEvidence from '../../src/github/ci-evidence.mjs';
import { findLatestPreviewRun } from './metadata-target.mjs';

const repository = 'lawxcompany-stack/Plataforma-LawX';
const workflowId = 290018021;
const workflowPath = '.github/workflows/ci.yml';
const fixtureRunId = 123456789;
const MAX_ARTIFACT_PAGES = 5;
const MAX_RUN_PAGES = 5;
const RUN_INTEGRATION = process.env.RUN_GITHUB_METADATA_INTEGRATION === '1';

test('artifact metadata reader follows full pages and stops at the first short page', async () => {
  assert.equal(typeof ciEvidence.listArtifacts, 'function', 'CI artifact reader must be reusable for metadata-only validation');
  const calls = [];
  const api = {
    async get(path) {
      calls.push(path);
      const page = Number(path.match(/page=(\d+)$/u)?.[1]);
      return { artifacts: page === 1 ? Array.from({ length: 100 }, (_, id) => ({ id })) : [{ id: 101 }] };
    },
  };
  const artifacts = await ciEvidence.listArtifacts(api, { repository }, { id: fixtureRunId });

  assert.equal(artifacts.length, 101);
  assert.deepEqual(calls, [1, 2].map((page) =>
    `/repos/${repository}/actions/runs/${fixtureRunId}/artifacts?per_page=100&page=${page}`));
});

test('artifact metadata reader fails closed when the final allowed page is still full', async () => {
  assert.equal(typeof ciEvidence.listArtifacts, 'function', 'CI artifact reader must enforce a pagination cap');
  const calls = [];
  const api = {
    async get(path) {
      calls.push(path);
      return { artifacts: Array.from({ length: 100 }, (_, id) => ({ id })) };
    },
  };

  await assert.rejects(ciEvidence.listArtifacts(api, { repository }, { id: fixtureRunId }), {
    code: 'artifact_list_too_large',
  });
  assert.equal(calls.length, MAX_ARTIFACT_PAGES);
  assert.ok(calls.at(-1).endsWith(`page=${MAX_ARTIFACT_PAGES}`));
});

function getJson(path) {
  const result = spawnSync('gh', [
    'api', '--method', 'GET',
    '-H', 'Accept: application/vnd.github+json',
    '-H', 'X-GitHub-Api-Version: 2022-11-28',
    path,
  ], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  assert.equal(result.error, undefined, 'GitHub metadata GET command could not start');
  assert.equal(result.status, 0, 'GitHub metadata GET failed');
  try {
    return JSON.parse(result.stdout);
  } catch {
    assert.fail('GitHub metadata GET returned invalid JSON');
  }
}

test('read-only GitHub metadata binds the latest successful Preview CI run, attempt and final artifact', {
  skip: RUN_INTEGRATION ? false : 'set RUN_GITHUB_METADATA_INTEGRATION=1 to run the live GitHub metadata proof',
}, async () => {
  const auth = spawnSync('gh', ['auth', 'status'], { stdio: 'ignore' });
  assert.equal(auth.error, undefined, 'GitHub CLI is unavailable for the explicitly requested metadata proof');
  assert.equal(auth.status, 0, 'GitHub CLI must be authenticated for the explicitly requested metadata proof');

  const runs = [];
  for (let page = 1; page <= MAX_RUN_PAGES; page += 1) {
    const response = getJson(`/repos/${repository}/actions/workflows/${workflowId}/runs` +
      `?event=pull_request&status=completed&per_page=100&page=${page}`);
    assert.ok(Array.isArray(response.workflow_runs), 'GitHub workflow run list must be an array');
    runs.push(...response.workflow_runs);
    if (response.workflow_runs.length < 100) break;
    assert.notEqual(page, MAX_RUN_PAGES, 'GitHub workflow run history exceeded the bounded scan');
  }

  const selected = await findLatestPreviewRun({
    runs,
    repository,
    workflowId,
    workflowPath,
    async listPulls(sha) {
      return getJson(`/repos/${repository}/commits/${sha}/pulls?per_page=100&page=1`);
    },
  });
  assert.ok(selected, 'a successful same-repository CI run for a Preview pull request must exist');
  const { id: runId, head_sha: candidateSha, run_attempt: attempt } = selected.run;
  const expectedArtifactName = `acceptance-final-${runId}-${attempt}`;

  const run = getJson(`/repos/${repository}/actions/runs/${runId}`);
  assert.equal(run.id, selected.run.id);
  assert.equal(run.workflow_id, workflowId);
  assert.equal(run.path, workflowPath);
  assert.equal(run.event, 'pull_request');
  assert.equal(run.head_sha, selected.run.head_sha);
  assert.equal(run.run_attempt, attempt);
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');
  assert.equal(run.repository?.full_name, repository);

  assert.equal(selected.pull.head.sha, candidateSha);
  assert.equal(selected.pull.base.ref, 'preview');

  const attemptResponse = getJson(`/repos/${repository}/actions/runs/${runId}/attempts/${attempt}`);
  const exactAttempt = attemptResponse.workflow_run ?? attemptResponse;
  assert.equal(exactAttempt.id, Number(runId));
  assert.equal(exactAttempt.workflow_id, workflowId);
  assert.equal(exactAttempt.run_attempt, attempt);
  assert.equal(exactAttempt.head_sha, candidateSha);
  assert.equal(exactAttempt.status, 'completed');
  assert.equal(exactAttempt.conclusion, 'success');
  assert.ok(Date.parse(exactAttempt.run_started_at ?? exactAttempt.started_at));
  assert.ok(Date.parse(exactAttempt.completed_at ?? exactAttempt.updated_at));

  const artifactRecords = await ciEvidence.listArtifacts(
    { get: async (path) => getJson(path) },
    { repository },
    { id: Number(runId) },
  );
  const matches = artifactRecords.filter(({ name }) => name === expectedArtifactName);
  assert.equal(matches.length, 1, 'exact acceptance-final artifact name must occur once');
  const [artifact] = matches;
  assert.equal(artifact.expired, false);
  assert.match(artifact.digest, /^sha256:[0-9a-f]{64}$/u);
  assert.ok(Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0);
  assert.equal(artifact.workflow_run?.id, Number(runId));
  assert.equal(artifact.workflow_run?.repository_id, run.repository?.id);
  assert.equal(artifact.workflow_run?.head_sha, candidateSha);
  assert.equal(artifact.name, `acceptance-final-${runId}-${attempt}`);
  // This test deliberately uses metadata GETs only and never requests artifact bytes.
});
