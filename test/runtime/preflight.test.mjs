import assert from 'node:assert/strict';
import { createHash, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { preflightRuntime, validateEnvironmentPolicy } from '../../src/runtime/preflight.mjs';
import { candidate, deployment, fetchFixture, policy as configuredPolicy, signedAttestation } from './fixture.mjs';

function apiFixture({ listed = {}, detail = {} } = {}) {
  const calls = [];
  return {
    calls,
    async get(path) {
      calls.push(path);
      if (path.startsWith('/v7/deployments?')) {
        return { deployments: [{
          uid: deployment.id,
          projectId: configuredPolicy.vercel.projectId,
          url: new URL(deployment.origin).hostname,
          state: 'READY',
          target: null,
          ...listed,
        }] };
      }
      if (path.startsWith('/v13/deployments/')) {
        return {
          id: deployment.id,
          projectId: configuredPolicy.vercel.projectId,
          teamId: configuredPolicy.vercel.teamId,
          url: new URL(deployment.origin).hostname,
          readyState: 'READY',
          target: null,
          gitSource: { sha: candidate.candidateSha },
          ...detail,
        };
      }
      throw new Error('unexpected API route');
    },
  };
}

test('default policy is closed-schema and records the reviewed non-secret identity expectations', () => {
  const policy = JSON.parse(readFileSync('policy/environment-policy.json', 'utf8'));
  assert.equal(validateEnvironmentPolicy(policy), true);
  assert.equal(policy.vercel.projectId, 'prj_NEAKAPvyPzh76wfoHqYF6mRSfBs0');
  assert.equal(policy.vercel.teamId, 'team_Legw262JzvhZUhIZtv5pFE4T');
  assert.equal(policy.database.projectRef, 'zjvqjdntasprusoqfsgw');
  assert.equal(policy.database.branchId, 'e2f26c0b-8a79-4cd5-ad80-faaf91fb51a2');
  assert.equal(policy.database.branchName, 'lawx-billing-validation-20260912');
  assert.equal(policy.stripe.accountId, 'acct_1TWh8jF7lfHrHdNa');
  assert.equal(policy.stripe.webhookEndpointId, null);
  const publicKeyDer = createPublicKey(policy.attestation.publicKeyPem).export({ type: 'spki', format: 'der' });
  assert.equal(createHash('sha256').update(publicKeyDer).digest('hex'),
    '79344bd905084e536c762d3c4b7ae1cc83ac48fb8ebdcbb821cec970513ec979');
});

test('rejects absent, malformed, extra-key, and production-like environment policy', () => {
  assert.equal(validateEnvironmentPolicy(null), false);
  assert.equal(validateEnvironmentPolicy({ ...configuredPolicy, callerUrl: 'https://untrusted.invalid' }), false);
  assert.equal(validateEnvironmentPolicy({
    ...configuredPolicy,
    database: { ...configuredPolicy.database, branchId: 'main' },
  }), false);
  assert.equal(validateEnvironmentPolicy({
    ...configuredPolicy,
    database: { ...configuredPolicy.database, branchId: 'production' },
  }), false);
  assert.equal(validateEnvironmentPolicy({
    ...configuredPolicy,
    database: { ...configuredPolicy.database, branchName: 'lawx-main-preview' },
  }), false);
  assert.equal(validateEnvironmentPolicy({
    ...configuredPolicy,
    stripe: { ...configuredPolicy.stripe, accountId: 'platform' },
  }), false);
  assert.equal(validateEnvironmentPolicy({
    ...configuredPolicy,
    stripe: { ...configuredPolicy.stripe, livemode: true },
  }), false);
});

test('fails before metadata or runtime requests when any authoritative identity is unset', async () => {
  const api = apiFixture();
  let fetchCalls = 0;
  await assert.rejects(preflightRuntime({
    api,
    candidate,
    policy: { ...configuredPolicy, database: { ...configuredPolicy.database, branchId: null } },
    fetchImpl: async () => { fetchCalls += 1; throw new Error('must not fetch'); },
  }), { code: 'environment_policy_unconfigured' });
  assert.deepEqual(api.calls, []);
  assert.equal(fetchCalls, 0);
});

test('returns the exact Task 2/4 environment tuple after immutable deployment and runtime verification', async () => {
  const api = apiFixture();
  const fetch = fetchFixture(signedAttestation());
  const result = await preflightRuntime({
    api,
    candidate,
    policy: configuredPolicy,
    fetchImpl: fetch.fetchImpl,
  });

  assert.deepEqual(result.expectedEnvironment, {
    database: {
      projectRef: 'abcdefghijklmnopqrst',
      branchId: 'synthetic-billing-validation',
    },
    deployment: { id: 'dpl_candidate123', origin: 'https://lawx-abc123def-team.vercel.app' },
    stripe: { accountId: 'acct_testlawx123' },
  });
  assert.deepEqual(Object.keys(result.expectedEnvironment), ['database', 'deployment', 'stripe']);
  assert.deepEqual(Object.keys(result.expectedEnvironment.database), ['projectRef', 'branchId']);
  assert.deepEqual(Object.keys(result.expectedEnvironment.deployment), ['id', 'origin']);
  assert.deepEqual(Object.keys(result.expectedEnvironment.stripe), ['accountId']);
  assert.equal(Object.hasOwn(result, 'secret'), false);
  assert.equal(api.calls.length, 2);
  assert.equal(fetch.calls.length, 1);
});

test('refuses a Production deployment before exposing runtime identity', async () => {
  const api = apiFixture({ listed: { target: 'production' } });
  const fetch = fetchFixture(signedAttestation());
  await assert.rejects(preflightRuntime({ api, candidate, policy: configuredPolicy, fetchImpl: fetch.fetchImpl }), {
    code: 'deployment_environment_mismatch',
  });
  assert.equal(fetch.calls.length, 0);
});

test('refuses candidate tree or runtime project mismatches', async () => {
  const api = apiFixture();
  const treeMismatch = fetchFixture(signedAttestation({ overrides: { treeHash: 'f'.repeat(40) } }));
  await assert.rejects(preflightRuntime({ api, candidate, policy: configuredPolicy, fetchImpl: treeMismatch.fetchImpl }), {
    code: 'attestation_identity_mismatch',
  });

  const projectMismatch = fetchFixture(signedAttestation({ overrides: { projectRef: 'zyxwvutsrqponmlkjihg' } }));
  await assert.rejects(preflightRuntime({ api: apiFixture(), candidate, policy: configuredPolicy, fetchImpl: projectMismatch.fetchImpl }), {
    code: 'attestation_identity_mismatch',
  });
});
