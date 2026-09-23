import assert from 'node:assert/strict';
import { test } from 'node:test';

const repository = 'lawxcompany-stack/Plataforma-LawX';
const candidateSha = 'afd8955bf0b1332aa1c6c220a8267e2a7e6c0f13';
const runId = '35810119625';
const workflowId = '290018021';
const attempt = '1';
const token = process.env.BILLING_VALIDATION_GITHUB_READ_TOKEN;

async function getJson(path) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
    redirect: 'error',
  });
  assert.equal(response.ok, true, `GitHub metadata GET returned HTTP ${response.status}`);
  return response.json();
}

test('optional metadata-only integration binds the recorded non-production run and attempt', { skip: !token }, async () => {
  const [run, attemptMetadata, artifacts] = await Promise.all([
    getJson(`/repos/${repository}/actions/runs/${runId}`),
    getJson(`/repos/${repository}/actions/runs/${runId}/attempts/${attempt}`),
    getJson(`/repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`),
  ]);
  const exactAttempt = attemptMetadata.workflow_run ?? attemptMetadata;
  assert.equal(run.workflow_id, Number(workflowId));
  assert.equal(run.event, 'pull_request');
  assert.equal(run.head_sha, candidateSha);
  assert.equal(run.run_attempt, Number(attempt));
  assert.equal(exactAttempt.run_attempt, Number(attempt));
  assert.equal(exactAttempt.head_sha, candidateSha);
  assert.ok(Date.parse(exactAttempt.run_started_at ?? exactAttempt.started_at));
  assert.ok(Array.isArray(artifacts.artifacts));
  assert.ok(artifacts.artifacts.length > 0);
  for (const artifact of artifacts.artifacts) {
    assert.equal(artifact.workflow_run?.id, Number(runId));
    assert.equal(artifact.workflow_run?.repository_id, run.repository?.id);
    assert.equal(artifact.workflow_run?.head_sha, candidateSha);
    assert.match(artifact.name, new RegExp(`-${runId}-${attempt}$`));
  }
  // Deliberately inspect metadata only. This test must never call the artifact download endpoint.
});
