import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findLatestPreviewRun } from './metadata-target.mjs';

const repository = 'lawxcompany-stack/Plataforma-LawX';
const workflowPath = '.github/workflows/ci.yml';
const workflowId = 290018021;
const SHAS = Object.freeze({ old: '1'.repeat(40), wrongBase: '2'.repeat(40), latest: '3'.repeat(40),
  failed: '4'.repeat(40), otherWorkflow: '5'.repeat(40), ambiguous: '6'.repeat(40), foreign: '7'.repeat(40) });

function run(id, sha, createdAt, overrides = {}) {
  return {
    id,
    workflow_id: workflowId,
    path: workflowPath,
    event: 'pull_request',
    head_sha: sha,
    status: 'completed',
    conclusion: 'success',
    run_attempt: 1,
    created_at: createdAt,
    repository: { full_name: repository },
    head_repository: { full_name: repository },
    ...overrides,
  };
}

function pull(number, sha, baseRef = 'preview', overrides = {}) {
  return {
    number,
    head: { sha, repo: { full_name: repository } },
    base: { ref: baseRef, repo: { full_name: repository } },
    ...overrides,
  };
}

test('selects the newest successful CI run with exactly one same-repository Preview PR', async () => {
  const calls = [];
  const runs = [
    run(100, SHAS.old, '2026-09-10T10:00:00Z'),
    run(300, SHAS.wrongBase, '2026-10-01T10:00:00Z'),
    run(200, SHAS.latest, '2026-09-30T10:00:00Z'),
    run(400, SHAS.failed, '2026-10-02T10:00:00Z', { conclusion: 'failure' }),
    run(500, SHAS.otherWorkflow, '2026-10-03T10:00:00Z', { workflow_id: 99 }),
  ];

  const selected = await findLatestPreviewRun({
    runs,
    repository,
    workflowId,
    workflowPath,
    async listPulls(sha) {
      calls.push(sha);
      if (sha === SHAS.wrongBase) return [pull(31, sha, 'main')];
      if (sha === SHAS.latest) return [pull(29, sha)];
      if (sha === SHAS.old) return [pull(10, sha)];
      return [];
    },
  });

  assert.equal(selected.run.id, 200);
  assert.equal(selected.pull.number, 29);
  assert.deepEqual(calls, [SHAS.wrongBase, SHAS.latest]);
});

test('refuses a run associated with multiple exact Preview PRs instead of guessing', async () => {
  const sha = SHAS.ambiguous;
  await assert.rejects(findLatestPreviewRun({
    runs: [run(201, sha, '2026-10-01T10:00:00Z')],
    repository,
    workflowId,
    workflowPath,
    async listPulls() { return [pull(29, sha), pull(30, sha)]; },
  }), { code: 'metadata_preview_run_ambiguous' });
});

test('returns no candidate when no successful same-repository Preview PR run exists', async () => {
  const result = await findLatestPreviewRun({
    runs: [run(201, SHAS.foreign, '2026-10-01T10:00:00Z', {
      head_repository: { full_name: 'someone/fork' },
    })],
    repository,
    workflowId,
    workflowPath,
    async listPulls() { return []; },
  });

  assert.equal(result, null);
});
