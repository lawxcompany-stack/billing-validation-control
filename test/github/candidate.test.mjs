import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CandidateRefusal, resolveCandidate } from '../../src/github/candidate.mjs';

const sha = 'afd8955bf0b1332aa1c6c220a8267e2a7e6c0f13';
const treeSha = 'e'.repeat(40);
const repo = 'lawxcompany-stack/Plataforma-LawX';
const pins = {
  schema_version: 1,
  protected_prefixes: ['.github/workflows/', 'scripts/billing-'],
  protected_paths: [],
  reviewed_blobs: {},
};

function makePull(overrides = {}) {
  return {
    number: 42,
    state: 'open',
    head: { sha, repo: { full_name: repo, id: 771 } },
    base: { ref: 'preview', sha: '1'.repeat(40), repo: { full_name: repo, id: 771 } },
    ...overrides,
  };
}

function apiFor({ pulls = [makePull()], files = [], tree = [] } = {}) {
  const calls = [];
  return {
    calls,
    async get(path) {
      calls.push(path);
      if (path === `/repos/${repo}/commits/${sha}/pulls?per_page=100`) return pulls;
      if (path === `/repos/${repo}/pulls/42/files?per_page=100&page=1`) return files;
      if (path === `/repos/${repo}/git/commits/${sha}`) return { sha, tree: { sha: treeSha } };
      if (path === `/repos/${repo}/git/trees/${treeSha}?recursive=1`) return { sha: treeSha, truncated: false, tree };
      throw new Error(`Unexpected API route in fixture: ${path}`);
    },
  };
}

test('resolves a current open Preview PR and exact tree/blob identities', async () => {
  const api = apiFor({
    files: [{ filename: 'src/billing.ts', status: 'modified' }],
    tree: [{ path: 'src/billing.ts', type: 'blob', sha: 'a'.repeat(40) }],
  });
  const candidate = await resolveCandidate({ api, candidateSha: sha, sourcePins: pins });

  assert.deepEqual(candidate, {
    repository: repo,
    repositoryId: 771,
    pullNumber: 42,
    candidateSha: sha,
    baseSha: '1'.repeat(40),
    treeSha,
    sourceBlobShas: { 'src/billing.ts': 'a'.repeat(40) },
    changedFiles: ['src/billing.ts'],
  });
  assert.ok(api.calls.includes(`/repos/${repo}/git/commits/${sha}`));
  assert.ok(api.calls.includes(`/repos/${repo}/git/trees/${treeSha}?recursive=1`));
});

test('refuses a candidate associated only with a foreign repository PR', async () => {
  const pull = makePull({ head: { sha, repo: { full_name: 'attacker/fork', id: 99 } } });
  const api = apiFor({ pulls: [pull] });
  await assert.rejects(resolveCandidate({ api, candidateSha: sha, sourcePins: pins }), {
    code: 'candidate_repository_not_allowed',
  });
});

test('refuses a stale PR head even if the requested old SHA is associated with the PR', async () => {
  const pull = makePull({ head: { sha: 'b'.repeat(40), repo: { full_name: repo, id: 771 } } });
  const api = apiFor({ pulls: [pull] });
  await assert.rejects(resolveCandidate({ api, candidateSha: sha, sourcePins: pins }), {
    code: 'candidate_head_not_current',
  });
});

test('refuses PRs targeting a base other than preview or with ambiguous current heads', async () => {
  const wrongBase = makePull({ base: { ref: 'main', sha: '1'.repeat(40), repo: { full_name: repo, id: 771 } } });
  const ambiguous = [makePull(), makePull({ number: 43 })];
  for (const pulls of [[wrongBase], ambiguous]) {
    const api = apiFor({ pulls });
    await assert.rejects(resolveCandidate({ api, candidateSha: sha, sourcePins: pins }), CandidateRefusal);
  }
});

test('blocks changed workflow or billing harness paths unless exact reviewed blob SHA is pinned', async () => {
  const files = [{ filename: '.github/workflows/ci.yml', status: 'modified' }];
  const tree = [{ path: '.github/workflows/ci.yml', type: 'blob', sha: 'c'.repeat(40) }];
  const api = apiFor({ files, tree });
  await assert.rejects(resolveCandidate({ api, candidateSha: sha, sourcePins: pins }), {
    code: 'candidate_protected_source_unreviewed',
  });

  const allowed = {
    ...pins,
    reviewed_blobs: { '.github/workflows/ci.yml': ['c'.repeat(40)] },
  };
  const approvedCandidate = await resolveCandidate({ api: apiFor({ files, tree }), candidateSha: sha, sourcePins: allowed });
  assert.equal(approvedCandidate.sourceBlobShas['.github/workflows/ci.yml'], 'c'.repeat(40));
});

test('uses the trusted default pin policy when the caller does not supply a test policy', async () => {
  const api = apiFor({
    files: [{ filename: '.github/workflows/ci.yml', status: 'modified' }],
    tree: [{ path: '.github/workflows/ci.yml', type: 'blob', sha: 'c'.repeat(40) }],
  });
  await assert.rejects(resolveCandidate({ api, candidateSha: sha }), {
    code: 'candidate_protected_source_unreviewed',
  });
});

test('fails closed when PR file list or candidate tree is truncated or inconsistent', async () => {
  const api = apiFor({
    files: [{ filename: 'src/missing-from-tree.ts', status: 'added' }],
    tree: [{ path: 'other.ts', type: 'blob', sha: 'd'.repeat(40) }],
  });
  await assert.rejects(resolveCandidate({ api, candidateSha: sha, sourcePins: pins }), {
    code: 'candidate_tree_inconsistent',
  });
});
