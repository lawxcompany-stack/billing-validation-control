import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { test } from 'node:test';
import { certificateFixture } from './certificate-fixture.mjs';

const manifestModule = await import('../../runner/billing-result-manifest.mjs').catch(() => null);
const verifierModule = await import('../../runner/billing-result-verifier-internal.mjs').catch(() => null);
const writerModule = await import('../../runner/write-billing-result-manifest.mjs').catch(() => null);

const repository = 'lawxcompany-stack/billing-validation-control';
const workflowPath = '.github/workflows/validate-billing.yml';
const controlRef = 'refs/heads/main';
const workflowSha = 'd'.repeat(40);
const candidateSha = 'a'.repeat(40);
const candidateRepository = 'lawxcompany-stack/Plataforma-LawX';
const workflowUri = `https://github.com/${repository}/${workflowPath}`;
const runId = '123456789';
const runAttempt = '2';
const runInvocationUri = `https://github.com/${repository}/actions/runs/${runId}/attempts/${runAttempt}`;
const projectId = 'prj_lawxvalidation';
const teamId = 'team_lawxvalidation';
const projectRef = 'abcdefghijklmnopqrst';
const stripeAccountId = 'acct_testlawx123';
const CANONICAL_BILLING_45_IDS = Object.freeze([
  'signup.native', 'signup.join', 'signup.advbox', 'signup.expired-intent', 'signup.tampered-intent', 'signup.replay',
  'pricing.base-agents', 'pricing.progressive', 'pricing.combo', 'pricing.coupon-allowed', 'pricing.coupon-rejected', 'pricing.zero-total',
  'payment.approved', 'payment.declined', 'payment.3ds', 'payment.abandoned', 'payment.timeout', 'payment.refresh', 'payment.two-tabs',
  'zero.authorized', 'zero.replay',
  'subscription.add-area', 'subscription.upgrade', 'subscription.downgrade', 'subscription.proration', 'subscription.renewal', 'subscription.cancellation',
  'finance.delinquency', 'finance.recovery', 'finance.partial-refund', 'finance.partial-credit', 'finance.concurrent-adjustment',
  'access.contracted', 'access.uncontracted', 'access.other-team', 'access.extras-preprocedural', 'access.hub-blocked', 'access.custom-blocked',
  'webhook.invalid-signature', 'webhook.wrong-account', 'webhook.wrong-mode', 'webhook.replay', 'webhook.reverse-order', 'webhook.retry', 'webhook.takeover',
]);

function expectedContext() {
  return {
    control: {
      repository,
      repositoryId: '1384018279',
      ref: controlRef,
      workflowPath,
      workflowRef: `${repository}/${workflowPath}@${controlRef}`,
      workflowSha,
      runId,
      runAttempt,
      eventName: 'workflow_dispatch',
    },
    candidate: { repository: candidateRepository, pullRequestNumber: '140', sha: candidateSha },
    candidateTreeSha: 'c'.repeat(40),
    vercelProjectId: projectId,
    supabaseProjectRef: projectRef,
    stripeAccountId,
  };
}

function expectedResults() {
  return CANONICAL_BILLING_45_IDS.map((id, index) => ({
    id,
    status: 'passed',
    evidenceSha256: (index + 1).toString(16).padStart(64, '0'),
  }));
}

function producerInput() {
  return { results: expectedResults() };
}

function resolvedDeployment() {
  return { id: 'dpl_candidate123', origin: 'https://lawx-abc123def-team.vercel.app' };
}

function createManifest(input = producerInput(), trusted = expectedContext(), deployment = resolvedDeployment()) {
  assert.ok(manifestModule, 'The closed financial result manifest module is not implemented');
  return manifestModule.createBillingResultManifest(input, trusted, deployment);
}

test('result producer emits a distinct sanitized manifest only for all canonical 45 passing results', () => {
  const manifest = createManifest();
  assert.equal(manifest.results.totalCount, 45);
  assert.equal(manifest.results.passedCount, 45);
  assert.equal(manifest.results.failedCount, 0);
  assert.equal(manifest.results.suite, 'billing-45');
  assert.deepEqual(manifest.candidate, expectedContext().candidate);
  assert.deepEqual(manifest.deployment, { ...resolvedDeployment(), projectId, sha: candidateSha });
  assert.deepEqual(manifest.supabase, { projectRef });
  assert.deepEqual(manifest.stripe, { accountId: stripeAccountId, livemode: false });
  assert.equal(Object.hasOwn(manifest, 'activationCommitment'), false);
  assert.deepEqual(Object.keys(manifest), [
    'schemaVersion', 'control', 'candidate', 'deployment', 'supabase', 'stripe', 'results',
  ]);
  assert.equal(Object.hasOwn(manifest, 'databaseUrl'), false);
});

test('the result digest uses the exact ordered 45 scenario IDs from the app acceptance contract', () => {
  assert.deepEqual(manifestModule.BILLING_RESULT_45_IDS, CANONICAL_BILLING_45_IDS);
  assert.deepEqual(expectedResults().map(({ id }) => id), CANONICAL_BILLING_45_IDS);
});

test('producer fails closed on the current partial 43-result suite', () => {
  const input = producerInput();
  input.results = input.results.slice(0, 43);
  assert.throws(() => createManifest(input), { code: 'billing_result_suite_incomplete' });
});

test('producer rejects missing, failed, reordered, or forged case results', () => {
  const missing = producerInput();
  delete missing.results;
  assert.throws(() => createManifest(missing), { code: 'billing_result_suite_incomplete' });

  const failed = producerInput();
  failed.results[44].status = 'failed';
  assert.throws(() => createManifest(failed), { code: 'billing_result_manifest_invalid' });

  const forged = producerInput();
  forged.results[44].id = 'signup.advbox';
  assert.throws(() => createManifest(forged), { code: 'billing_result_manifest_invalid' });
});

test('result artifact cannot override trusted candidate, deployment, or provider identities', () => {
  for (const change of [
    (input) => { input.candidate = { repository: candidateRepository, pullRequestNumber: '141', sha: candidateSha }; },
    (input) => { input.deployment = { ...resolvedDeployment(), projectId, sha: 'b'.repeat(40) }; },
    (input) => { input.supabase = { projectRef: 'zyxwvutsrqponmlkjihg' }; },
    (input) => { input.stripe = { accountId: 'acct_other123', livemode: false }; },
  ]) {
    const input = producerInput();
    change(input);
    assert.throws(() => createManifest(input), { code: 'billing_result_manifest_invalid' });
  }
});

test('producer accepts only the exact immutable deployment identity returned by the trusted resolver', () => {
  assert.throws(() => createManifest(producerInput(), expectedContext(), {
    id: 'dpl_candidate123', origin: 'https://example.invalid',
  }), { code: 'billing_result_deployment_proof_invalid' });
  assert.throws(() => createManifest(producerInput(), expectedContext(), {
    ...resolvedDeployment(), projectId: 'prj_otherproject',
  }), { code: 'billing_result_deployment_proof_unavailable' });
});

test('closed schemas reject additional sensitive database and provider fields', () => {
  const input = producerInput();
  input.databaseUrl = 'postgres://user:password@db.example.invalid/private';
  assert.throws(() => createManifest(input), { code: 'billing_result_manifest_invalid' });

  const withSecret = producerInput();
  withSecret.stripeSecret = 'sk_test_sensitive';
  assert.throws(() => createManifest(withSecret), { code: 'billing_result_manifest_invalid' });

  const withDeploymentIdentity = producerInput();
  withDeploymentIdentity.deployment = { ...resolvedDeployment(), origin: 'https://fake.vercel.app' };
  assert.throws(() => createManifest(withDeploymentIdentity), { code: 'billing_result_manifest_invalid' });

  const canonical = manifestModule.serializeBillingResultManifest(createManifest());
  for (const addSensitiveField of [
    (manifest) => { manifest.supabase.databaseUrl = 'postgres://user:password@db.example.invalid/private'; },
    (manifest) => { manifest.stripe.secretKey = 'sk_test_sensitive'; },
    (manifest) => { manifest.databaseUrl = 'postgres://user:password@db.example.invalid/private'; },
  ]) {
    const forged = JSON.parse(canonical);
    addSensitiveField(forged);
    assert.throws(() => manifestModule.parseCanonicalBillingResultManifest(`${JSON.stringify(forged)}\n`), {
      code: 'billing_result_manifest_noncanonical',
    });
  }
});

test('producer rejects an incorrect control repository, protected ref, or workflow identity', () => {
  for (const change of [
    (trusted) => { trusted.control.repository = 'attacker/control'; },
    (trusted) => { trusted.control.repositoryId = '999'; },
    (trusted) => { trusted.control.ref = 'refs/heads/feature'; },
    (trusted) => { trusted.control.workflowPath = '.github/workflows/other.yml'; },
    (trusted) => { trusted.control.workflowRef = `${repository}/.github/workflows/other.yml@${controlRef}`; },
  ]) {
    const trusted = expectedContext();
    change(trusted);
    assert.throws(() => createManifest(producerInput(), trusted), { code: 'billing_result_manifest_invalid' });
  }
});

function workflowEnvironment(overrides = {}) {
  return {
    CONTROL_REPOSITORY: repository,
    CONTROL_REPOSITORY_ID: '1384018279',
    CONTROL_REF: controlRef,
    CONTROL_DEFAULT_BRANCH: 'main',
    CONTROL_REF_PROTECTED: 'true',
    CONTROL_WORKFLOW_REF: `${repository}/${workflowPath}@${controlRef}`,
    CONTROL_WORKFLOW_SHA: workflowSha,
    CONTROL_RUN_ID: runId,
    CONTROL_RUN_ATTEMPT: runAttempt,
    CONTROL_EVENT_NAME: 'workflow_dispatch',
    CANDIDATE_SHA: candidateSha,
    READER_CANDIDATE_SHA: candidateSha,
    READER_CANDIDATE_TREE_SHA: 'c'.repeat(40),
    CANDIDATE_PULL_NUMBER: '140',
    VERCEL_READ_ONLY_TOKEN: 'fixture-vercel-read-token',
    ...overrides,
  };
}

function configuredPolicy() {
  return {
    environment: 'billing-validation',
    vercel: { projectId, teamId },
    database: { kind: 'standalone', projectRef, organizationId: null, organizationSlug: null,
      region: null, databaseVersion: null, postgresEngine: null, releaseChannel: null,
      connection: null, schemaFingerprintSha256: null, migrationHistorySha256: null },
    stripe: { accountId: stripeAccountId, livemode: false },
  };
}

function vercelResponses({ deploymentSha = candidateSha, alias = [] } = {}) {
  return {
    list: { deployments: [{ uid: 'dpl_candidate123', projectId,
      url: 'lawx-abc123def-team.vercel.app', state: 'READY', target: null }] },
    detail: { id: 'dpl_candidate123', projectId, teamId,
      url: 'lawx-abc123def-team.vercel.app', readyState: 'READY', target: null,
      gitSource: { sha: deploymentSha }, alias },
  };
}

function vercelFetch(responses = vercelResponses()) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const parsed = new URL(url);
    if (parsed.origin !== 'https://api.vercel.com') throw new Error('unexpected API origin');
    return Response.json(parsed.pathname === '/v7/deployments' ? responses.list : responses.detail);
  };
  return { calls, fetchImpl };
}

test('trusted writer invokes the exact Vercel resolver and builds identity from API results, not artifact fields', async () => {
  assert.ok(writerModule, 'The trusted result writer is not implemented');
  const api = vercelFetch();
  const manifest = await writerModule.createTrustedWorkflowBillingResultManifest({
    environment: workflowEnvironment(), input: producerInput(), policy: configuredPolicy(), fetchImpl: api.fetchImpl,
  });

  assert.deepEqual(manifest.deployment, { ...resolvedDeployment(), projectId, sha: candidateSha });
  assert.deepEqual(api.calls.map(({ url }) => new URL(url).pathname), [
    '/v7/deployments', '/v13/deployments/dpl_candidate123',
  ]);
  for (const { options } of api.calls) {
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers.Authorization, 'Bearer fixture-vercel-read-token');
  }
});

test('trusted writer refuses schema failures before Vercel network access and rejects API SHA mismatch', async () => {
  assert.ok(writerModule, 'The trusted result writer is not implemented');
  const schemaFailure = vercelFetch();
  const forgedInput = { ...producerInput(), deployment: resolvedDeployment() };
  await assert.rejects(writerModule.createTrustedWorkflowBillingResultManifest({
    environment: workflowEnvironment(), input: forgedInput, policy: configuredPolicy(), fetchImpl: schemaFailure.fetchImpl,
  }), { code: 'billing_result_manifest_invalid' });
  assert.equal(schemaFailure.calls.length, 0);

  const mismatchedDeployment = vercelFetch(vercelResponses({ deploymentSha: 'e'.repeat(40) }));
  await assert.rejects(writerModule.createTrustedWorkflowBillingResultManifest({
    environment: workflowEnvironment(), input: producerInput(), policy: configuredPolicy(),
    fetchImpl: mismatchedDeployment.fetchImpl,
  }), { code: 'deployment_sha_mismatch' });
  assert.equal(mismatchedDeployment.calls.length, 2);
});

test('trusted writer rejects an aliased deployment returned by the shared resolver', async () => {
  const aliased = vercelFetch(vercelResponses({ alias: ['lawx-abc123def-team.vercel.app'] }));
  await assert.rejects(writerModule.createTrustedWorkflowBillingResultManifest({
    environment: workflowEnvironment(), input: producerInput(), policy: configuredPolicy(), fetchImpl: aliased.fetchImpl,
  }), { code: 'deployment_origin_invalid' });
  assert.equal(aliased.calls.length, 2);
});

test('trusted context refuses missing standalone project identity or mismatched reader candidate tree', () => {
  assert.ok(manifestModule, 'The closed financial result manifest module is not implemented');
  const environment = workflowEnvironment();
  assert.deepEqual(manifestModule.createBillingResultTrustedContext(environment, configuredPolicy()), expectedContext());
  assert.throws(() => manifestModule.createBillingResultTrustedContext(
    workflowEnvironment({ READER_CANDIDATE_TREE_SHA: '' }), configuredPolicy()),
  { code: 'billing_result_manifest_invalid' });
  assert.throws(() => manifestModule.createBillingResultTrustedContext(environment, {
    ...configuredPolicy(), database: { ...configuredPolicy().database, projectRef: null },
  }), { code: 'billing_result_manifest_invalid' });
});

test('trusted context applies the independent standalone-project denylist before signing', () => {
  for (const projectRef of ['kvmmnwmfgkhipuxmuxbr', 'gzemotsvxlgomamhtfie', 'zjvqjdntasprusoqfsgw', 'zyxwvutsrqponmlkjihg']) {
    assert.throws(() => manifestModule.createBillingResultTrustedContext(workflowEnvironment(), {
      ...configuredPolicy(), database: { ...configuredPolicy().database, projectRef },
    }), { code: 'billing_result_manifest_invalid' }, projectRef);
  }
});

function trustedCertificate(overrides = {}) {
  return {
    issuer: 'https://token.actions.githubusercontent.com',
    subjectAlternativeName: `${workflowUri}@${controlRef}`,
    buildSignerURI: `${workflowUri}@${controlRef}`,
    buildSignerDigest: workflowSha,
    runInvocationURI: runInvocationUri,
    sourceRepositoryURI: `https://github.com/${repository}`,
    sourceRepositoryIdentifier: '1384018279',
    sourceRepositoryRef: controlRef,
    sourceRepositoryDigest: workflowSha,
    githubWorkflowTrigger: 'workflow_dispatch',
    githubWorkflowRef: controlRef,
    githubWorkflowSHA: workflowSha,
    runnerEnvironment: 'github-hosted',
    ...overrides,
  };
}

function verifierOutput({ certificate = trustedCertificate(), digest, name = 'billing-result-manifest.json' } = {}) {
  return JSON.stringify([{
    attestation: { bundle: { verificationMaterial: { certificate: { rawBytes: certificateFixture() } } } },
    verificationResult: {
      signature: { certificate },
      verifiedTimestamps: [{
        type: 'rekor',
        uri: 'https://rekor.sigstore.dev/api/v1/log/entries/0123456789abcdef',
        timestamp: '2026-09-23T12:34:56Z',
      }],
      statement: {
        subject: [{ name, digest: { sha256: digest } }],
        predicateType: 'https://slsa.dev/provenance/v1',
        predicate: {},
      },
    },
  }]);
}

async function verifierBoundary(manifestBytes, output) {
  const calls = [];
  return {
    calls,
    async run(command, args, options) {
      calls.push({ command, args, options });
      assert.deepEqual(await readFile(args[2]), manifestBytes);
      assert.equal((await stat(args[2])).mode & 0o777, 0o600);
      return { stdout: typeof output === 'function' ? output() : output };
    },
  };
}

async function verify({ certificate, digest, expected = expectedContext(), output } = {}) {
  assert.ok(verifierModule, 'The trusted billing-result attestation verifier is not implemented');
  const manifest = createManifest();
  const manifestBytes = Buffer.from(manifestModule.serializeBillingResultManifest(manifest), 'utf8');
  const manifestDigest = createHash('sha256').update(manifestBytes).digest('hex');
  const boundary = await verifierBoundary(manifestBytes,
    output ?? verifierOutput({ certificate: certificate ?? trustedCertificate(), digest: digest ?? manifestDigest }));
  const result = await verifierModule.verifyBillingResultAttestationWithBoundary({
    manifestBytes,
    expectedContext: expected,
    processBoundary: boundary,
    reviewedControlRepositoryId: '1384018279',
  });
  return { result, boundary, manifestDigest };
}

test('verifier accepts only the exact result subject signed by the protected workflow attempt', async () => {
  const { result, boundary, manifestDigest } = await verify();
  assert.equal(result.manifestDigest, manifestDigest);
  assert.equal(result.manifest.results.totalCount, 45);
  assert.equal(boundary.calls.length, 1);
  const [{ command, args }] = boundary.calls;
  assert.equal(command, 'gh');
  assert.deepEqual(args.slice(0, 2), ['attestation', 'verify']);
  assert.ok(args.includes('--deny-self-hosted-runners'));
});

test('verifier rejects a missing attestation result', async () => {
  const manifest = createManifest();
  const manifestBytes = Buffer.from(manifestModule.serializeBillingResultManifest(manifest), 'utf8');
  const boundary = await verifierBoundary(manifestBytes, '[]');
  assert.ok(verifierModule, 'The trusted billing-result attestation verifier is not implemented');
  await assert.rejects(verifierModule.verifyBillingResultAttestationWithBoundary({
    manifestBytes, expectedContext: expectedContext(), processBoundary: boundary,
    reviewedControlRepositoryId: '1384018279',
  }), { code: 'billing_result_attestation_invalid' });
});

for (const [claim, mutation] of [
  ['OIDC issuer', (certificate) => ({ ...certificate, issuer: 'https://evil.invalid' })],
  ['repository identity', (certificate) => ({ ...certificate, sourceRepositoryURI: 'https://github.com/attacker/control' })],
  ['repository numeric ID', (certificate) => ({ ...certificate, sourceRepositoryIdentifier: '999' })],
  ['protected source ref', (certificate) => ({ ...certificate, sourceRepositoryRef: 'refs/heads/feature' })],
  ['workflow identity', (certificate) => ({ ...certificate, subjectAlternativeName: 'https://github.com/attacker/control/.github/workflows/validate-billing.yml@refs/heads/main' })],
  ['workflow path', (certificate) => ({ ...certificate, buildSignerURI: 'https://github.com/lawxcompany-stack/billing-validation-control/.github/workflows/other.yml@refs/heads/main' })],
  ['workflow ref', (certificate) => ({ ...certificate, githubWorkflowRef: 'refs/heads/feature' })],
  ['workflow SHA', (certificate) => ({ ...certificate, githubWorkflowSHA: 'e'.repeat(40) })],
  ['replayed run attempt', (certificate) => ({ ...certificate, runInvocationURI: `https://github.com/${repository}/actions/runs/${runId}/attempts/1` })],
]) {
  test(`verifier rejects a certificate with the wrong ${claim}`, async () => {
    await assert.rejects(verify({ certificate: mutation(trustedCertificate()) }), {
      code: 'billing_result_attestation_invalid',
    });
  });
}

test('verifier rejects a different subject digest and activation-manifest subject name', async () => {
  const wrongDigest = '0'.repeat(64);
  await assert.rejects(verify({ digest: wrongDigest }), { code: 'billing_result_attestation_invalid' });

  const manifest = createManifest();
  const manifestBytes = Buffer.from(manifestModule.serializeBillingResultManifest(manifest), 'utf8');
  const digest = createHash('sha256').update(manifestBytes).digest('hex');
  await assert.rejects(verify({ output: verifierOutput({ digest, name: 'activation-manifest.json' }) }), {
    code: 'billing_result_attestation_invalid',
  });
});

test('verifier rejects an artifact from a previous attempt even if workflow SHA is unchanged', async () => {
  const expected = expectedContext();
  expected.control.runAttempt = '3';
  await assert.rejects(verify({ expected }), { code: 'billing_result_attestation_invalid' });
});

test('verifier rejects a signed result for a different pull request', async () => {
  const expected = expectedContext();
  expected.candidate.pullRequestNumber = '141';
  await assert.rejects(verify({ expected }), { code: 'billing_result_attestation_invalid' });
});

test('verifier rejects a candidate SHA that differs from the attested deployment SHA', async () => {
  const expected = expectedContext();
  expected.candidate.sha = 'b'.repeat(40);
  await assert.rejects(verify({ expected }), { code: 'billing_result_attestation_invalid' });
});

test('closed manifest parsing refuses mismatched candidate and deployment SHAs', () => {
  const forged = JSON.parse(manifestModule.serializeBillingResultManifest(createManifest()));
  forged.deployment.sha = 'b'.repeat(40);
  assert.throws(() => manifestModule.parseCanonicalBillingResultManifest(`${JSON.stringify(forged)}\n`), {
    code: 'billing_result_manifest_noncanonical',
  });
});
