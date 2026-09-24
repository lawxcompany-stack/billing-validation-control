import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { test } from 'node:test';

const verifierUrl = new URL('../../runner/activation-verifier.mjs', import.meta.url);
const internalVerifierUrl = new URL('../../runner/activation-verifier-internal.mjs', import.meta.url);
const verifier = await import(verifierUrl.href).catch((error) => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return null;
  throw error;
});
const internalVerifier = await import(internalVerifierUrl.href).catch((error) => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return null;
  throw error;
});

function requireVerifier() {
  assert.ok(internalVerifier, 'The internal deterministic attestation verifier factory is not implemented');
  return { verifyActivationAttestation: internalVerifier.verifyActivationAttestationWithBoundary };
}

const CONTROL_REPOSITORY = 'lawxcompany-stack/billing-validation-control';
const CONTROL_REPOSITORY_ID = '12345678';
const CONTROL_WORKFLOW_PATH = '.github/workflows/validate-billing.yml';
const CONTROL_REF = 'refs/heads/main';
const WORKFLOW_URI = `https://github.com/${CONTROL_REPOSITORY}/${CONTROL_WORKFLOW_PATH}`;
const RUN_ID = '123456789';
const RUN_ATTEMPT = '2';
const WORKFLOW_SHA = 'd'.repeat(40);
const CANDIDATE_SHA = 'a'.repeat(40);
const RUNNER_LABEL = `billing-validation-${'b'.repeat(32)}`;
const COMMITMENT = 'c'.repeat(64);
const RUN_INVOCATION_URI = `https://github.com/${CONTROL_REPOSITORY}/actions/runs/${RUN_ID}/attempts/${RUN_ATTEMPT}`;
const CANONICAL_MANIFEST_BYTES = '{"activationCommitment":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","candidateRepository":"lawxcompany-stack/Plataforma-LawX","candidateSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","runnerLabel":"billing-validation-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","controlRepository":"lawxcompany-stack/billing-validation-control","controlRepositoryId":"12345678","controlRef":"refs/heads/main","controlWorkflowPath":".github/workflows/validate-billing.yml","runId":"123456789","runAttempt":"2","controlWorkflowSha":"dddddddddddddddddddddddddddddddddddddddd","eventName":"workflow_dispatch"}\n';
const MANIFEST = Object.freeze({
  activationCommitment: COMMITMENT,
  candidateRepository: 'lawxcompany-stack/Plataforma-LawX',
  candidateSha: CANDIDATE_SHA,
  runnerLabel: RUNNER_LABEL,
  controlRepository: CONTROL_REPOSITORY,
  controlRepositoryId: CONTROL_REPOSITORY_ID,
  controlRef: CONTROL_REF,
  controlWorkflowPath: CONTROL_WORKFLOW_PATH,
  runId: RUN_ID,
  runAttempt: RUN_ATTEMPT,
  controlWorkflowSha: WORKFLOW_SHA,
  eventName: 'workflow_dispatch',
});
const MANIFEST_DIGEST = createHash('sha256').update(CANONICAL_MANIFEST_BYTES, 'utf8').digest('hex');

function trustedCertificate(overrides = {}) {
  return {
    issuer: 'https://token.actions.githubusercontent.com',
    subjectAlternativeName: `https://github.com/${CONTROL_REPOSITORY}/${CONTROL_WORKFLOW_PATH}@${CONTROL_REF}`,
    buildSignerURI: `${WORKFLOW_URI}@${CONTROL_REF}`,
    buildSignerDigest: WORKFLOW_SHA,
    runInvocationURI: RUN_INVOCATION_URI,
    sourceRepositoryURI: `https://github.com/${CONTROL_REPOSITORY}`,
    sourceRepositoryIdentifier: CONTROL_REPOSITORY_ID,
    sourceRepositoryRef: CONTROL_REF,
    sourceRepositoryDigest: WORKFLOW_SHA,
    githubWorkflowTrigger: 'workflow_dispatch',
    githubWorkflowRef: CONTROL_REF,
    githubWorkflowSHA: WORKFLOW_SHA,
    runnerEnvironment: 'github-hosted',
    ...overrides,
  };
}

function verifiedOutput({ certificate = trustedCertificate(), digest = MANIFEST_DIGEST,
  verifiedTimestamps = [{
    type: 'rekor',
    uri: 'https://rekor.sigstore.dev/api/v1/log/entries/0123456789abcdef',
    timestamp: '2026-09-23T12:34:56Z',
  }], predicate = {} } = {}) {
  return JSON.stringify([{
    attestation: { bundle: 'untrusted-for-policy-test' },
    verificationResult: {
      signature: { certificate },
      verifiedTimestamps,
      statement: {
        subject: [{ name: 'activation-manifest.json', digest: { sha256: digest } }],
        predicateType: 'https://slsa.dev/provenance/v1',
        predicate,
      },
    },
  }]);
}

function processBoundary(output = verifiedOutput()) {
  const calls = [];
  return {
    calls,
    async run(command, args, options) {
      calls.push({ command, args, options });
      const manifestPath = args[2];
      const bytes = await readFile(manifestPath);
      assert.equal(bytes.toString('utf8'), CANONICAL_MANIFEST_BYTES);
      assert.equal((await stat(manifestPath)).mode & 0o777, 0o600);
      return { stdout: typeof output === 'function' ? await output() : output };
    },
  };
}

const TRUST_POLICY = Object.freeze({ reviewedControlRepositoryId: CONTROL_REPOSITORY_ID });

test('verifier calls gh with one fixed argument vector and hashes the exact local manifest bytes', async () => {
  const { verifyActivationAttestation } = requireVerifier();
  const boundary = processBoundary();
  const result = await verifyActivationAttestation({
    manifest: MANIFEST,
    processBoundary: boundary,
    ...TRUST_POLICY,
  });

  assert.equal(boundary.calls.length, 1);
  const [{ command, args, options }] = boundary.calls;
  assert.equal(command, 'gh');
  assert.deepEqual(args, [
    'attestation', 'verify', args[2],
    '--repo', CONTROL_REPOSITORY,
    '--signer-workflow', `${CONTROL_REPOSITORY}/${CONTROL_WORKFLOW_PATH}`,
    '--source-ref', CONTROL_REF,
    '--source-digest', WORKFLOW_SHA,
    '--deny-self-hosted-runners',
    '--predicate-type', 'https://slsa.dev/provenance/v1',
    '--format', 'json',
  ]);
  assert.ok(args[2].startsWith('/'));
  assert.equal(options.shell, undefined, 'The process contract takes an argument array, never a shell command');
  assert.equal(options.timeoutMs <= 60_000, true);
  assert.equal(options.maxOutputBytes <= 512 * 1024, true);
  assert.equal(result.manifest.runId, RUN_ID);
  assert.equal(result.manifest.runAttempt, RUN_ATTEMPT);
  assert.equal(result.manifestDigest, MANIFEST_DIGEST);
});

test('production verifier refuses caller-selected repository identity and fake GH process boundary', async () => {
  let calls = 0;
  await assert.rejects(verifier.verifyActivationAttestation({
    manifest: MANIFEST,
    reviewedControlRepositoryId: CONTROL_REPOSITORY_ID,
    processBoundary: { async run() { calls += 1; return { stdout: verifiedOutput() }; } },
  }), { code: 'activation_attestation_invalid' });
  assert.equal(calls, 0);
});

for (const [claim, mutation] of [
  ['OIDC issuer', (certificate) => ({ ...certificate, issuer: 'https://evil.invalid' })],
  ['signer workflow identity', (certificate) => ({ ...certificate, subjectAlternativeName: 'https://github.com/evil/repo/.github/workflows/validate-billing.yml@refs/heads/main' })],
  ['signer workflow path', (certificate) => ({ ...certificate, buildSignerURI: 'https://github.com/evil/repo/.github/workflows/validate-billing.yml' })],
  ['signer workflow ref', (certificate) => ({ ...certificate, buildSignerURI: `${WORKFLOW_URI}@refs/heads/other` })],
  ['signer workflow SHA', (certificate) => ({ ...certificate, githubWorkflowSHA: 'e'.repeat(40) })],
  ['source repository URI', (certificate) => ({ ...certificate, sourceRepositoryURI: 'https://github.com/evil/repo' })],
  ['immutable repository ID', (certificate) => ({ ...certificate, sourceRepositoryIdentifier: '87654321' })],
  ['source ref', (certificate) => ({ ...certificate, sourceRepositoryRef: 'refs/heads/other' })],
  ['source SHA', (certificate) => ({ ...certificate, sourceRepositoryDigest: 'e'.repeat(40) })],
  ['workflow trigger', (certificate) => ({ ...certificate, githubWorkflowTrigger: 'pull_request' })],
  ['workflow ref', (certificate) => ({ ...certificate, githubWorkflowRef: 'refs/heads/other' })],
  ['hosted runner environment', (certificate) => ({ ...certificate, runnerEnvironment: 'self-hosted' })],
  ['exact run invocation URI and attempt', (certificate) => ({ ...certificate, runInvocationURI: `${RUN_INVOCATION_URI}/attempts/3` })],
]) {
  test(`verifier rejects a mismatched certificate ${claim}`, async () => {
    const { verifyActivationAttestation } = requireVerifier();
    const boundary = processBoundary(verifiedOutput({ certificate: mutation(trustedCertificate()) }));
    await assert.rejects(verifyActivationAttestation({
      manifest: MANIFEST,
      processBoundary: boundary,
      ...TRUST_POLICY,
    }), { code: 'activation_attestation_invalid' });
  });
}

test('verifier rejects an attestation whose subject digest differs from the exact manifest bytes', async () => {
  const { verifyActivationAttestation } = requireVerifier();
  const boundary = processBoundary(verifiedOutput({ digest: '0'.repeat(64) }));
  await assert.rejects(verifyActivationAttestation({
    manifest: MANIFEST,
    processBoundary: boundary,
    ...TRUST_POLICY,
  }), { code: 'activation_attestation_invalid' });
});

test('verifier requires at least one verified timestamp', async () => {
  const { verifyActivationAttestation } = requireVerifier();
  for (const timestamps of [[], null, [{}], [{
    type: 'rekor', uri: 'https://rekor.sigstore.dev', timestamp: 'not-verified',
  }]]) {
    const boundary = processBoundary(verifiedOutput({ verifiedTimestamps: timestamps }));
    await assert.rejects(verifyActivationAttestation({
      manifest: MANIFEST,
      processBoundary: boundary,
      ...TRUST_POLICY,
    }), { code: 'activation_attestation_invalid' });
  }
});

test('user-controlled provenance predicate cannot override an invalid certificate', async () => {
  const { verifyActivationAttestation } = requireVerifier();
  const boundary = processBoundary(verifiedOutput({
    certificate: trustedCertificate({ githubWorkflowTrigger: 'pull_request' }),
    predicate: { githubWorkflowTrigger: 'workflow_dispatch', sourceRepositoryIdentifier: CONTROL_REPOSITORY_ID },
  }));
  await assert.rejects(verifyActivationAttestation({
    manifest: MANIFEST,
    processBoundary: boundary,
    ...TRUST_POLICY,
  }), { code: 'activation_attestation_invalid' });
});

test('verifier rejects missing, malformed, oversized and ambiguous gh JSON', async () => {
  const { verifyActivationAttestation } = requireVerifier();
  for (const output of [
    '',
    '{malformed',
    ' '.repeat(600 * 1024),
    JSON.stringify([]),
    JSON.stringify([JSON.parse(verifiedOutput())[0], JSON.parse(verifiedOutput())[0]]),
    JSON.stringify([{ verificationResult: {} }]),
  ]) {
    const boundary = processBoundary(output);
    await assert.rejects(verifyActivationAttestation({
      manifest: MANIFEST,
      processBoundary: boundary,
      ...TRUST_POLICY,
    }), { code: 'activation_attestation_invalid' });
  }
});

test('CLI failure, timeout and cancellation refuse without retrying gh', async () => {
  const { verifyActivationAttestation } = requireVerifier();
  for (const code of ['spawn_error', 'cli_failure', 'process_timeout', 'process_cancelled']) {
    let calls = 0;
    const boundary = {
      async run() {
        calls += 1;
        const error = new Error(code);
        error.code = code;
        throw error;
      },
    };
    await assert.rejects(verifyActivationAttestation({
      manifest: MANIFEST,
      processBoundary: boundary,
      ...TRUST_POLICY,
    }), { code: 'activation_attestation_invalid' });
    assert.equal(calls, 1);
  }

  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(verifyActivationAttestation({
    manifest: MANIFEST,
    processBoundary: { async run() { calls += 1; return { stdout: verifiedOutput() }; } },
    signal: controller.signal,
    ...TRUST_POLICY,
  }), { code: 'activation_attestation_invalid' });
  assert.equal(calls, 0);
});
