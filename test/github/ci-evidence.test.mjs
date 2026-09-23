import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { collectCiEvidence } from '../../src/github/ci-evidence.mjs';
import { evidenceDocument, makeZip } from './zip-fixture.mjs';

const repo = 'lawxcompany-stack/Plataforma-LawX';
const sha = 'afd8955bf0b1332aa1c6c220a8267e2a7e6c0f13';
const workflows = JSON.parse(readFileSync('policy/candidate-workflows.json', 'utf8')).workflows;
const workflow = workflows[0];
const candidate = {
  repository: repo,
  repositoryId: 771,
  pullNumber: 42,
  candidateSha: sha,
  baseSha: '1'.repeat(40),
};
const started = '2026-09-23T02:22:55Z';
const completed = '2026-09-23T02:28:00Z';

function run(overrides = {}, selectedWorkflow = workflow, index = workflows.indexOf(selectedWorkflow)) {
  return {
    id: 35810119625 + index,
    workflow_id: selectedWorkflow.id,
    path: selectedWorkflow.path,
    event: selectedWorkflow.event,
    status: 'completed',
    conclusion: 'success',
    run_attempt: 1,
    head_sha: sha,
    head_repository: { full_name: repo, id: 771 },
    repository: { full_name: repo, id: 771 },
    pull_requests: [{ number: 42, base: { ref: 'preview', sha: candidate.baseSha } }],
    created_at: started,
    ...overrides,
  };
}

function artifact(overrides = {}, selectedWorkflow = workflow, runId = 35810119625, index = workflows.indexOf(selectedWorkflow)) {
  const document = evidenceDocument({
    workflow_id: selectedWorkflow.id,
    run_id: String(runId),
    suite: selectedWorkflow.suite,
  });
  const bytes = makeZip([{ name: 'evidence.json', contents: JSON.stringify(document), method: 8 }]);
  return {
    id: 881 + index * 10,
    name: `billing-${selectedWorkflow.suite}-${runId}-1`,
    expired: false,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    size_in_bytes: bytes.length,
    created_at: '2026-09-23T02:26:00Z',
    workflow_run: { id: runId, repository_id: 771, head_sha: sha },
    bytes,
    ...overrides,
  };
}

function apiFixture({ targetWorkflowId = workflow.id, selectedRun, attempts, artifacts: customArtifacts, extraRuns = [] } = {}) {
  const calls = [];
  const runRecords = new Map();
  const attemptRecordsByRun = new Map();
  const artifactsByRun = new Map();
  const artifactsById = new Map();

  workflows.forEach((entry, index) => {
    const currentRun = entry.id === targetWorkflowId ? (selectedRun ?? run({}, entry, index)) : run({}, entry, index);
    runRecords.set(entry.id, [currentRun, ...(entry.id === targetWorkflowId ? extraRuns : [])]);
    attemptRecordsByRun.set(currentRun.id, entry.id === targetWorkflowId && attempts ? attempts : {
      1: { run_attempt: 1, status: 'completed', conclusion: 'success', started_at: started, completed_at: completed },
    });
    const currentArtifacts = entry.id === targetWorkflowId && customArtifacts !== undefined
      ? customArtifacts
      : [artifact({}, entry, currentRun.id, index)];
    artifactsByRun.set(currentRun.id, currentArtifacts);
    for (const item of currentArtifacts) artifactsById.set(item.id, item);
  });

  return {
    calls,
    async get(path) {
      calls.push(path);
      const workflowMatch = path.match(new RegExp(`^/repos/${repo}/actions/workflows/(\\d+)/runs\\?per_page=100&page=1$`));
      if (workflowMatch) {
        const id = Number(workflowMatch[1]);
        const records = runRecords.get(id);
        return records ? { workflow_runs: records, total_count: records.length } : { workflow_runs: [], total_count: 0 };
      }
      const attemptMatch = path.match(new RegExp(`^/repos/${repo}/actions/runs/(\\d+)/attempts/(\\d+)$`));
      if (attemptMatch) return attemptRecordsByRun.get(Number(attemptMatch[1]))?.[attemptMatch[2]] ?? null;
      const artifactMatch = path.match(new RegExp(`^/repos/${repo}/actions/runs/(\\d+)/artifacts\\?per_page=100&page=1$`));
      if (artifactMatch) {
        const records = artifactsByRun.get(Number(artifactMatch[1])) ?? [];
        return { artifacts: records, total_count: records.length };
      }
      throw new Error(`Unexpected API route in fixture: ${path}`);
    },
    async downloadArtifact(id, { maxBytes }) {
      assert.ok(maxBytes > 0);
      const found = artifactsById.get(id);
      if (!found) throw new Error('unexpected artifact id');
      return (async function* stream() { yield found.bytes; })();
    },
  };
}

test('binds every statically approved workflow, exact PR SHA, attempt window, artifact, and digest', async () => {
  const api = apiFixture();
  const evidence = await collectCiEvidence({ api, candidate });

  assert.deepEqual(evidence.map(({ workflowId }) => workflowId), workflows.map(({ id }) => id));
  assert.equal(evidence[0].runId, '35810119625');
  assert.equal(evidence[0].attempt, 1);
  assert.equal(evidence[0].artifactId, 881);
  assert.equal(evidence[0].diagnostics.checks[0].id, 'billing-contract');
  assert.ok(api.calls.some((call) => call.endsWith('/attempts/1')));
});

test('refuses caller-supplied workflow policies before any GitHub API access', async () => {
  const api = apiFixture();
  await assert.rejects(collectCiEvidence({ api, candidate, workflows: [{ id: 999, event: 'pull_request' }] }), {
    code: 'ci_input_invalid',
  });
  assert.deepEqual(api.calls, []);
});

test('rejects wrong workflow, event, repository, candidate SHA, or PR head binding', async () => {
  const variants = [
    { workflow_id: 123 },
    { event: 'push' },
    { repository: { full_name: 'attacker/repo', id: 999 }, head_repository: { full_name: 'attacker/repo', id: 999 } },
    { head_sha: 'b'.repeat(40) },
    { pull_requests: [{ number: 42, base: { ref: 'preview', sha: '2'.repeat(40) } }] },
  ];
  for (const overrides of variants) {
    await assert.rejects(collectCiEvidence({ api: apiFixture({ selectedRun: run(overrides) }), candidate }));
  }
});

test('rejects failed, cancelled, or in-progress latest CI runs', async () => {
  const variants = [
    { status: 'completed', conclusion: 'failure' },
    { status: 'completed', conclusion: 'cancelled' },
    { status: 'in_progress', conclusion: null },
  ];
  for (const overrides of variants) {
    await assert.rejects(collectCiEvidence({ api: apiFixture({ selectedRun: run(overrides) }), candidate }), {
      code: 'ci_run_not_successful',
    });
  }
});

test('does not reuse an older successful run when the latest run failed', async () => {
  const latest = run({ id: 35810119626, conclusion: 'failure', created_at: '2026-09-23T03:00:00Z' });
  const earlier = run({ id: 35810119624, created_at: '2026-09-23T02:00:00Z' });
  const api = apiFixture({ selectedRun: latest, extraRuns: [earlier] });
  await assert.rejects(collectCiEvidence({ api, candidate }), { code: 'ci_run_not_successful' });
});

test('rejects missing or duplicate attempt-bound artifacts', async () => {
  const selected = run();
  for (const artifacts of [[], [artifact({}, workflow, selected.id), artifact({ id: 882 }, workflow, selected.id)]]) {
    await assert.rejects(collectCiEvidence({ api: apiFixture({ artifacts }), candidate }));
  }
});

test('rejects artifact run/repository/SHA mismatch and artifact created outside exact attempt window', async () => {
  const selected = run();
  const variants = [
    { workflow_run: { id: 1, repository_id: 771, head_sha: sha } },
    { workflow_run: { id: selected.id, repository_id: 999, head_sha: sha } },
    { workflow_run: { id: selected.id, repository_id: 771, head_sha: 'c'.repeat(40) } },
    { created_at: '2026-09-23T02:20:00Z' },
    { created_at: '2026-09-23T02:30:00Z' },
  ];
  for (const overrides of variants) {
    await assert.rejects(collectCiEvidence({
      api: apiFixture({ artifacts: [artifact(overrides, workflow, selected.id)] }),
      candidate,
    }));
  }
});

test('rejects an artifact whose name claims the current attempt but timestamp binds to an earlier rerun', async () => {
  const selected = run({ run_attempt: 2 });
  const records = {
    1: { run_attempt: 1, status: 'completed', conclusion: 'success', started_at: started, completed_at: completed },
    2: { run_attempt: 2, status: 'completed', conclusion: 'success', started_at: '2026-09-23T03:00:00Z', completed_at: '2026-09-23T03:10:00Z' },
  };
  const wrongAttemptArtifact = artifact({
    name: `billing-ci-${selected.id}-2`,
    created_at: '2026-09-23T02:26:00Z',
  }, workflow, selected.id);
  await assert.rejects(collectCiEvidence({
    api: apiFixture({ selectedRun: selected, attempts: records, artifacts: [wrongAttemptArtifact] }),
    candidate,
  }), { code: 'artifact_attempt_mismatch' });
});

test('rejects digest mismatch and expired artifacts', async () => {
  const selected = run();
  for (const overrides of [{ digest: `sha256:${'0'.repeat(64)}` }, { expired: true }]) {
    await assert.rejects(collectCiEvidence({
      api: apiFixture({ artifacts: [artifact(overrides, workflow, selected.id)] }),
      candidate,
    }));
  }
});

test('rejects overlapping or missing attempt windows as ambiguous', async () => {
  const selected = run({ run_attempt: 2 });
  const attempts = {
    1: { run_attempt: 1, status: 'completed', conclusion: 'success', started_at: started, completed_at: '2026-09-23T03:01:00Z' },
    2: { run_attempt: 2, status: 'completed', conclusion: 'success', started_at: '2026-09-23T03:00:00Z', completed_at: '2026-09-23T03:10:00Z' },
  };
  const api = apiFixture({
    selectedRun: selected,
    attempts,
    artifacts: [artifact({ name: `billing-ci-${selected.id}-2`, created_at: '2026-09-23T03:05:00Z' }, workflow, selected.id)],
  });
  await assert.rejects(collectCiEvidence({ api, candidate }), { code: 'artifact_attempt_ambiguous' });
});
