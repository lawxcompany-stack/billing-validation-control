import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolvePreviewDeployment } from '../../src/github/deployments.mjs';

const candidateSha = 'afd8955bf0b1332aa1c6c220a8267e2a7e6c0f13';
const candidateTree = 'd'.repeat(40);
const policy = {
  schema_version: 1,
  environment: 'billing-validation',
  vercel: { projectId: 'prj_lawxvalidation', teamId: 'team_lawxvalidation' },
  database: { projectRef: 'abcdefghijklmnopqrst', branchId: 'billing-validation-branch' },
  stripe: { accountId: 'acct_testlawx123', webhookEndpointId: 'we_testlawx123', livemode: false },
  attestation: { publicKeyPem: 'test public key' },
};
const candidate = { candidateSha, treeSha: candidateTree };

function listed(overrides = {}) {
  return {
    uid: 'dpl_candidate123',
    projectId: policy.vercel.projectId,
    url: 'lawx-abc123def-team.vercel.app',
    state: 'READY',
    target: null,
    ...overrides,
  };
}

function details(overrides = {}) {
  return {
    id: 'dpl_candidate123',
    projectId: policy.vercel.projectId,
    teamId: policy.vercel.teamId,
    url: 'lawx-abc123def-team.vercel.app',
    readyState: 'READY',
    target: null,
    gitSource: { sha: candidateSha, repoId: 771 },
    ...overrides,
  };
}

function apiFixture({ deployments = [listed()], deploymentDetails = details() } = {}) {
  const calls = [];
  return {
    calls,
    async get(path) {
      calls.push(path);
      if (path.startsWith('/v7/deployments?')) return { deployments };
      if (path.startsWith('/v13/deployments/')) return deploymentDetails;
      throw new Error('unexpected Vercel route');
    },
  };
}

test('selects a single immutable Preview deployment using trusted project, team, and SHA filters', async () => {
  const api = apiFixture();
  const selected = await resolvePreviewDeployment({
    api,
    candidate: { ...candidate, deploymentUrl: 'https://attacker.example.com' },
    policy,
  });

  assert.deepEqual(selected, {
    id: 'dpl_candidate123',
    origin: 'https://lawx-abc123def-team.vercel.app',
  });
  const listUrl = new URL(`https://api.vercel.com${api.calls[0]}`);
  assert.equal(listUrl.pathname, '/v7/deployments');
  assert.deepEqual(Object.fromEntries(listUrl.searchParams), {
    projectId: 'prj_lawxvalidation',
    teamId: 'team_lawxvalidation',
    target: 'preview',
    sha: candidateSha,
    state: 'READY',
    limit: '20',
  });
  assert.equal(api.calls[1], '/v13/deployments/dpl_candidate123?withGitRepoInfo=true&teamId=team_lawxvalidation');
});

test('refuses a deployment that is not READY', async () => {
  const api = apiFixture({ deployments: [listed({ state: 'BUILDING' })] });
  await assert.rejects(resolvePreviewDeployment({ api, candidate, policy }), { code: 'deployment_not_ready' });
  assert.equal(api.calls.length, 1);
});

test('refuses Production metadata even when the list filter requested Preview', async () => {
  const api = apiFixture({ deployments: [listed({ target: 'production' })] });
  await assert.rejects(resolvePreviewDeployment({ api, candidate, policy }), { code: 'deployment_environment_mismatch' });
});

test('refuses a returned deployment from a different Vercel project', async () => {
  const api = apiFixture({ deployments: [listed({ projectId: 'prj_otherproject' })] });
  await assert.rejects(resolvePreviewDeployment({ api, candidate, policy }), { code: 'deployment_project_mismatch' });
  assert.equal(api.calls.length, 1);
});

test('refuses deployment detail metadata whose Git SHA differs from the candidate', async () => {
  const api = apiFixture({ deploymentDetails: details({ gitSource: { sha: 'e'.repeat(40), repoId: 771 } }) });
  await assert.rejects(resolvePreviewDeployment({ api, candidate, policy }), { code: 'deployment_sha_mismatch' });
});

test('refuses detail metadata that is no longer READY or becomes Production', async () => {
  const notReady = apiFixture({ deploymentDetails: details({ readyState: 'BUILDING' }) });
  await assert.rejects(resolvePreviewDeployment({ api: notReady, candidate, policy }), { code: 'deployment_not_ready' });

  const production = apiFixture({ deploymentDetails: details({ target: 'production' }) });
  await assert.rejects(resolvePreviewDeployment({ api: production, candidate, policy }), {
    code: 'deployment_environment_mismatch',
  });
});

test('refuses missing Git SHA and missing immutable URL fields', async () => {
  const missingSha = apiFixture({ deploymentDetails: details({ gitSource: { repoId: 771 } }) });
  await assert.rejects(resolvePreviewDeployment({ api: missingSha, candidate, policy }), { code: 'deployment_sha_missing' });

  const missingUrl = apiFixture({ deployments: [listed({ url: null })] });
  await assert.rejects(resolvePreviewDeployment({ api: missingUrl, candidate, policy }), { code: 'deployment_origin_invalid' });
});

test('refuses mutable branch aliases and non-allowlisted deployment hosts', async () => {
  for (const url of ['lawx-git-preview-team.vercel.app', 'lawx-preview.example.com']) {
    const api = apiFixture({ deployments: [listed({ url })] });
    await assert.rejects(resolvePreviewDeployment({ api, candidate, policy }), { code: 'deployment_origin_invalid' });
    assert.equal(api.calls.length, 1);
  }

  const aliasedDetail = apiFixture({ deploymentDetails: details({ alias: ['lawx-abc123def-team.vercel.app'] }) });
  await assert.rejects(resolvePreviewDeployment({ api: aliasedDetail, candidate, policy }), {
    code: 'deployment_origin_invalid',
  });
});

test('refuses ambiguous selection and mismatched deployment detail identity', async () => {
  const ambiguous = apiFixture({ deployments: [listed(), listed({ uid: 'dpl_second123' })] });
  await assert.rejects(resolvePreviewDeployment({ api: ambiguous, candidate, policy }), { code: 'deployment_ambiguous' });

  const wrongId = apiFixture({ deploymentDetails: details({ id: 'dpl_other123' }) });
  await assert.rejects(resolvePreviewDeployment({ api: wrongId, candidate, policy }), { code: 'deployment_identity_mismatch' });
});

test('refuses conflicting detail teamId even when ownerId matches configured team', async () => {
  const api = apiFixture({ deploymentDetails: details({ teamId: 'team_other', ownerId: policy.vercel.teamId }) });
  await assert.rejects(resolvePreviewDeployment({ api, candidate, policy }), { code: 'deployment_identity_mismatch' });
});

test('requires every returned team identity field to agree and permits ownerId-only fallback', async () => {
  const conflictingOwner = apiFixture({ deploymentDetails: details({ ownerId: 'team_other' }) });
  await assert.rejects(resolvePreviewDeployment({ api: conflictingOwner, candidate, policy }), {
    code: 'deployment_identity_mismatch',
  });

  const ownerOnlyDetails = details({ ownerId: policy.vercel.teamId });
  delete ownerOnlyDetails.teamId;
  const ownerOnly = apiFixture({ deploymentDetails: ownerOnlyDetails });
  await resolvePreviewDeployment({ api: ownerOnly, candidate, policy });
});
