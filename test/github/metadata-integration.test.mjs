import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const repository = 'lawxcompany-stack/Plataforma-LawX';
const candidateSha = 'afd8955bf0b1332aa1c6c220a8267e2a7e6c0f13';
const runId = '35810119625';
const workflowId = 290018021;
const workflowPath = '.github/workflows/ci.yml';
const attempt = 1;
const expectedArtifactName = `acceptance-final-${runId}-${attempt}`;
const auth = spawnSync('gh', ['auth', 'status'], { stdio: 'ignore' });
const ghAuthAvailable = !auth.error && auth.status === 0;

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

test('read-only GitHub metadata binds exact non-production CI run, attempt and final artifact', { skip: !ghAuthAvailable }, () => {
  const run = getJson(`/repos/${repository}/actions/runs/${runId}`);
  assert.equal(run.id, Number(runId));
  assert.equal(run.workflow_id, workflowId);
  assert.equal(run.path, workflowPath);
  assert.equal(run.event, 'pull_request');
  assert.equal(run.head_sha, candidateSha);
  assert.equal(run.run_attempt, attempt);
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');
  assert.equal(run.repository?.full_name, repository);

  const associatedPulls = getJson(`/repos/${repository}/commits/${candidateSha}/pulls?per_page=100&page=1`);
  assert.ok(Array.isArray(associatedPulls));
  const exactPreviewPulls = associatedPulls.filter((pull) => pull.head?.sha === candidateSha &&
    pull.head?.repo?.full_name === repository && pull.base?.ref === 'preview' && pull.base?.repo?.full_name === repository);
  assert.equal(exactPreviewPulls.length, 1, 'candidate SHA must resolve to exactly one Preview PR association');

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

  const artifactResponse = getJson(`/repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`);
  assert.ok(Array.isArray(artifactResponse.artifacts));
  const matches = artifactResponse.artifacts.filter(({ name }) => name === expectedArtifactName);
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
