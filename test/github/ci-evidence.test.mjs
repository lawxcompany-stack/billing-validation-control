import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { collectCiEvidence as collectCiEvidenceRaw } from '../../src/github/ci-evidence.mjs';
import {
  finalAcceptanceDocument,
  FINAL_ACCEPTANCE_ENVIRONMENT,
  FINAL_ACCEPTANCE_TREE_HASH,
  makeZip,
} from './zip-fixture.mjs';

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
  treeSha: FINAL_ACCEPTANCE_TREE_HASH,
};
const expectedEnvironment = FINAL_ACCEPTANCE_ENVIRONMENT;
const started = '2026-09-23T02:22:55Z';
const completed = '2026-09-23T02:28:00Z';

function collectCiEvidence(options = {}) {
  return collectCiEvidenceRaw({ expectedEnvironment, ...options });
}

function canonicalProducerJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalProducerJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalProducerJson(value[key])}`).join(',')}}`;
}

function resealProducerDocument(document) {
  delete document.manifestDigest;
  document.manifestDigest = createHash('sha256').update(canonicalProducerJson(document), 'utf8').digest('hex');
  return document;
}

function run(overrides = {}, selectedWorkflow = workflow, index = 0) {
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

function artifact(overrides = {}, selectedRun = run(), selectedWorkflow = workflow, index = 0,
  document = finalAcceptanceDocument({ candidate: { sha, treeHash: candidate.treeSha } })) {
  const bytes = makeZip([{ name: 'billing-acceptance.json', contents: JSON.stringify(document), method: 8 }]);
  return {
    id: 881 + index,
    name: `acceptance-final-${selectedRun.id}-${selectedRun.run_attempt}`,
    expired: false,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    size_in_bytes: bytes.length,
    created_at: '2026-09-23T02:26:00Z',
    workflow_run: { id: selectedRun.id, repository_id: 771, head_sha: sha },
    bytes,
    ...overrides,
  };
}

function defaultAttempts(selectedRun) {
  const attempts = {};
  const lastStart = Date.parse(selectedRun.run_started_at ?? selectedRun.created_at);
  for (let attemptNumber = 1; attemptNumber <= selectedRun.run_attempt; attemptNumber += 1) {
    const startTime = lastStart - (selectedRun.run_attempt - attemptNumber) * 10 * 60 * 1000;
    attempts[attemptNumber] = {
      id: selectedRun.id,
      workflow_id: selectedRun.workflow_id,
      head_sha: selectedRun.head_sha,
      run_attempt: attemptNumber,
      status: selectedRun.status,
      conclusion: attemptNumber === selectedRun.run_attempt ? selectedRun.conclusion : 'failure',
      started_at: new Date(startTime).toISOString(),
      ...(selectedRun.status === 'completed'
        ? { completed_at: new Date(startTime + 5 * 60 * 1000).toISOString() }
        : {}),
    };
  }
  return attempts;
}

function apiFixture({ selectedRun, attemptsByRun = {}, artifactsByRun = {}, extraRuns = [], artifactDocument } = {}) {
  const calls = [];
  const initialRun = selectedRun ?? run();
  const runRecords = new Map([[workflow.id, [initialRun, ...extraRuns]]]);
  const attemptRecordsByRun = new Map();
  const artifactRecordsByRun = new Map();
  const artifactsById = new Map();

  for (const runRecord of [initialRun, ...extraRuns]) {
    attemptRecordsByRun.set(runRecord.id, attemptsByRun[runRecord.id] ?? defaultAttempts(runRecord));
    const records = artifactsByRun[runRecord.id] ?? [artifact({}, runRecord, workflow,
      Number(runRecord.id - 35810119625), artifactDocument)];
    artifactRecordsByRun.set(runRecord.id, records);
    for (const item of records) artifactsById.set(item.id, item);
  }

  return {
    calls,
    async get(path) {
      calls.push(path);
      const workflowMatch = path.match(new RegExp(`^/repos/${repo}/actions/workflows/(\\d+)/runs\\?per_page=100&page=(\\d+)$`));
      if (workflowMatch) {
        const id = Number(workflowMatch[1]);
        const records = Number(workflowMatch[2]) === 1 ? runRecords.get(id) : [];
        return { workflow_runs: records ?? [], total_count: records?.length ?? 0 };
      }
      const attemptMatch = path.match(new RegExp(`^/repos/${repo}/actions/runs/(\\d+)/attempts/(\\d+)$`));
      if (attemptMatch) return attemptRecordsByRun.get(Number(attemptMatch[1]))?.[attemptMatch[2]] ?? null;
      const artifactMatch = path.match(new RegExp(`^/repos/${repo}/actions/runs/(\\d+)/artifacts\\?per_page=100&page=1$`));
      if (artifactMatch) {
        const records = artifactRecordsByRun.get(Number(artifactMatch[1])) ?? [];
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

test('binds exact workflow, PR SHA, latest attempt, uniquely named final artifact, and digest', async () => {
  const api = apiFixture();
  const evidence = await collectCiEvidence({ api, candidate });

  assert.deepEqual(evidence.map(({ workflowId }) => workflowId), [290018021]);
  assert.equal(evidence[0].runId, '35810119625');
  assert.equal(evidence[0].attempt, 1);
  assert.equal(evidence[0].artifactId, 881);
  assert.equal(evidence[0].diagnostics.candidateSha, sha);
  assert.equal(evidence[0].diagnostics.candidateTree, candidate.treeSha);
  assert.equal(evidence[0].diagnostics.status, 'passed');
  assert.equal(Object.hasOwn(evidence[0].diagnostics, 'stripe'), false);
  assert.ok(api.calls.some((call) => call.endsWith('/attempts/1')));
});

test('requires a resolved full candidate tree identity before querying CI', async () => {
  for (const treeSha of [undefined, 'bad-tree']) {
    const candidateWithoutTree = { ...candidate, treeSha };
    const api = apiFixture();
    await assert.rejects(collectCiEvidence({ api, candidate: candidateWithoutTree }), {
      code: 'candidate_identity_invalid',
    });
    assert.deepEqual(api.calls, []);
  }
});

test('rejects absent or malformed expected environment identities before any GitHub API call', async () => {
  const malformedEnvironments = [
    undefined,
    null,
    {},
    { ...expectedEnvironment, extra: 'not-allowed' },
    { ...expectedEnvironment, database: { projectRef: 'bad', branchId: 'billing-validation-2026' } },
    { ...expectedEnvironment, deployment: { id: 'dpl_candidate123', origin: 'http://billing-candidate.vercel.app' } },
    { ...expectedEnvironment, stripe: { accountId: 'acct_test-lawx' } },
  ];

  for (const environment of malformedEnvironments) {
    const api = apiFixture();
    await assert.rejects(collectCiEvidenceRaw({ api, candidate, expectedEnvironment: environment }), {
      code: 'expected_environment_invalid',
    });
    assert.deepEqual(api.calls, []);
  }
});

test('rejects CI manifests bound to another expected test environment', async () => {
  const mutations = [
    (document) => {
      document.database.projectRef = 'zyxwvutsrqponmlkjihg';
      document.database.bootstrap.projectRef = 'zyxwvutsrqponmlkjihg';
    },
    (document) => { document.database.branchId = 'other-validation-branch'; },
    (document) => { document.deployment.id = 'dpl_othercandidate123'; },
    (document) => {
      document.deployment.origin = 'https://other-billing-candidate.vercel.app';
      document.webhook.endpoint = `${document.deployment.origin}/api/stripe/webhook`;
    },
    (document) => { document.stripe.accountId = 'acct_othertestaccount'; },
  ];

  for (const mutate of mutations) {
    const document = structuredClone(finalAcceptanceDocument({ candidate: { sha, treeHash: candidate.treeSha } }));
    mutate(document);
    resealProducerDocument(document);
    const selected = run();
    const mismatchedArtifact = artifact({}, selected, workflow, 0, document);
    const api = apiFixture({ selectedRun: selected, artifactsByRun: { [selected.id]: [mismatchedArtifact] } });
    await assert.rejects(collectCiEvidence({ api, candidate }), (error) => {
      assert.equal(error.code, 'evidence_identity_mismatch');
      assert.equal(error.message, 'evidence_identity_mismatch');
      return true;
    });
  }
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

test('selects the run with the latest exact attempt activity, not the latest original created_at', async () => {
  const newerCreatedRun = run({ id: 35810119626, created_at: '2026-09-23T03:00:00Z' });
  const olderRunRerun = run({ id: 35810119625, run_attempt: 2, created_at: '2026-09-23T02:00:00Z' });
  const attemptsByRun = {
    [newerCreatedRun.id]: {
      1: {
        id: newerCreatedRun.id, workflow_id: workflow.id, head_sha: sha, run_attempt: 1,
        status: 'completed', conclusion: 'success', started_at: '2026-09-23T03:05:00Z', completed_at: '2026-09-23T03:10:00Z',
      },
    },
    [olderRunRerun.id]: {
      1: {
        id: olderRunRerun.id, workflow_id: workflow.id, head_sha: sha, run_attempt: 1,
        status: 'completed', conclusion: 'failure', started_at: '2026-09-23T02:01:00Z', completed_at: '2026-09-23T02:06:00Z',
      },
      2: {
        id: olderRunRerun.id, workflow_id: workflow.id, head_sha: sha, run_attempt: 2,
        status: 'completed', conclusion: 'success', started_at: '2026-09-23T04:00:00Z', completed_at: '2026-09-23T04:05:00Z',
      },
    },
  };
  const artifactsByRun = {
    [newerCreatedRun.id]: [artifact({ created_at: '2026-09-23T03:07:00Z' }, newerCreatedRun, workflow, 1)],
    [olderRunRerun.id]: [artifact({ created_at: '2026-09-23T04:02:00Z' }, olderRunRerun, workflow, 2)],
  };
  const api = apiFixture({
    selectedRun: newerCreatedRun,
    extraRuns: [olderRunRerun],
    attemptsByRun,
    artifactsByRun,
  });

  const evidence = await collectCiEvidence({ api, candidate });
  assert.equal(evidence[0].runId, String(olderRunRerun.id));
  assert.equal(evidence[0].attempt, 2);
  assert.ok(api.calls.includes(`/repos/${repo}/actions/runs/${olderRunRerun.id}/attempts/2`));
});

test('does not reuse an earlier successful attempt when the latest exact attempt failed', async () => {
  const selected = run({ run_attempt: 2, conclusion: 'failure' });
  const attempts = {
    1: { run_attempt: 1, status: 'completed', conclusion: 'success', started_at: started, completed_at: completed },
    2: { run_attempt: 2, status: 'completed', conclusion: 'failure', started_at: '2026-09-23T03:00:00Z', completed_at: '2026-09-23T03:10:00Z' },
  };
  await assert.rejects(collectCiEvidence({ api: apiFixture({ selectedRun: selected, attemptsByRun: { [selected.id]: attempts } }), candidate }), {
    code: 'ci_run_not_successful',
  });
});

test('rejects equal latest attempt activity timestamps as ambiguous', async () => {
  const selectedRun = run();
  const secondRun = run({ id: 35810119626, created_at: '2026-09-23T03:00:00Z' });
  const currentRecord = (id) => ({
    1: { id, workflow_id: workflow.id, head_sha: sha, run_attempt: 1, status: 'completed', conclusion: 'success',
      started_at: '2026-09-23T04:00:00Z', completed_at: '2026-09-23T04:05:00Z' },
  });
  await assert.rejects(collectCiEvidence({
    api: apiFixture({ selectedRun, extraRuns: [secondRun], attemptsByRun: {
      [selectedRun.id]: currentRecord(selectedRun.id),
      [secondRun.id]: currentRecord(secondRun.id),
    } }),
    candidate,
  }), { code: 'ci_run_ambiguous' });
});

test('rejects missing or duplicate exact acceptance artifacts', async () => {
  const selected = run();
  for (const artifacts of [[], [artifact({}, selected), artifact({ id: 882 }, selected, workflow, 1)]]) {
    await assert.rejects(collectCiEvidence({ api: apiFixture({ selectedRun: selected, artifactsByRun: { [selected.id]: artifacts } }), candidate }));
  }
});

test('selects only the exact acceptance-final artifact among artifacts sharing the run-attempt suffix', async () => {
  const selected = run();
  const exact = artifact({}, selected);
  const siblings = ['acceptance-quality', 'acceptance-regression', 'acceptance-build', 'acceptance-remote', 'acceptance-financial', 'billing-financial-private']
    .map((prefix, index) => artifact({ id: 900 + index, name: `${prefix}-${selected.id}-1` }, selected, workflow, index + 1));
  const evidence = await collectCiEvidence({
    api: apiFixture({ selectedRun: selected, artifactsByRun: { [selected.id]: [...siblings, exact] } }),
    candidate,
  });
  assert.equal(evidence[0].artifactId, exact.id);
});

test('rejects an artifact whose name only shares the run-attempt suffix', async () => {
  const selected = run();
  const wrongName = artifact({ name: `acceptance-quality-${selected.id}-1` }, selected);
  await assert.rejects(collectCiEvidence({ api: apiFixture({
    selectedRun: selected,
    artifactsByRun: { [selected.id]: [wrongName] },
  }), candidate }), { code: 'artifact_missing' });
});

test('rejects artifact run/repository/SHA mismatch and artifact created outside the exact attempt window', async () => {
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
      api: apiFixture({ selectedRun: selected, artifactsByRun: { [selected.id]: [artifact(overrides, selected)] } }),
      candidate,
    }));
  }
});

test('rejects an artifact whose exact name claims the current attempt but timestamp binds to an earlier rerun', async () => {
  const selected = run({ run_attempt: 2 });
  const records = {
    1: { run_attempt: 1, status: 'completed', conclusion: 'success', started_at: started, completed_at: completed },
    2: { run_attempt: 2, status: 'completed', conclusion: 'success', started_at: '2026-09-23T03:00:00Z', completed_at: '2026-09-23T03:10:00Z' },
  };
  const wrongAttemptArtifact = artifact({ created_at: '2026-09-23T02:26:00Z' }, selected);
  await assert.rejects(collectCiEvidence({
    api: apiFixture({ selectedRun: selected, attemptsByRun: { [selected.id]: records }, artifactsByRun: { [selected.id]: [wrongAttemptArtifact] } }),
    candidate,
  }), { code: 'artifact_attempt_mismatch' });
});

test('rejects digest mismatch and expired artifacts', async () => {
  const selected = run();
  for (const overrides of [{ digest: `sha256:${'0'.repeat(64)}` }, { expired: true }]) {
    await assert.rejects(collectCiEvidence({
      api: apiFixture({ selectedRun: selected, artifactsByRun: { [selected.id]: [artifact(overrides, selected)] } }),
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
  await assert.rejects(collectCiEvidence({ api: apiFixture({
    selectedRun: selected,
    attemptsByRun: { [selected.id]: attempts },
    artifactsByRun: { [selected.id]: [artifact({ created_at: '2026-09-23T03:05:00Z' }, selected)] },
  }), candidate }), { code: 'artifact_attempt_ambiguous' });
});
