import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { CONTROL_REPOSITORY, CONTROL_REPOSITORY_ID } from '../../src/contracts/control-identity.mjs';
import { createAuthorizationChallenge } from '../../src/authorization/challenge.mjs';
import { serializeAuthorizationManifest } from '../../src/authorization/manifest.mjs';
import { certificateFixture } from '../runner/certificate-fixture.mjs';
import { authorizationFixture } from './fixtures.mjs';

export const CONTROL = CONTROL_REPOSITORY;
export const WORKFLOW = '.github/workflows/authorize-local-collector.yml';
export const ROOT = `https://api.github.com/repos/${CONTROL}`;
export const NOW = Date.parse('2026-09-29T12:05:00.000Z');

export function releaseFixture(manifest = authorizationFixture()) {
  return { schemaVersion: 1, releases: [{ collectorRelease: { ...manifest.collectorRelease },
    policy: { ...manifest.policy }, suites: [manifest.suite] }] };
}

// Offline API responses. Only the fixed public control repository is read.
export function authorizationApiFixture(manifest = authorizationFixture()) {
  const repo = { id: Number(CONTROL_REPOSITORY_ID), full_name: CONTROL, name: 'billing-validation-control',
    default_branch: 'main', private: false, visibility: 'public' };
  const run = { id: Number(manifest.control.runId), run_attempt: Number(manifest.control.runAttempt),
    workflow_id: 901234567, path: WORKFLOW, event: 'workflow_dispatch', head_branch: 'main',
    head_sha: manifest.control.sha, status: 'completed', conclusion: 'success',
    repository: { ...repo }, head_repository: { ...repo } };
  const runPath = `/actions/runs/${manifest.control.runId}`;
  const attemptPath = `${runPath}/attempts/${manifest.control.runAttempt}`;
  const payloads = {
    '': repo,
    [runPath]: run,
    [attemptPath]: structuredClone(run),
    '/actions/workflows/authorize-local-collector.yml': { id: 901234567, path: WORKFLOW, state: 'active' },
    [`${attemptPath}/jobs?per_page=100&page=1`]: { total_count: 3,
      jobs: ['authorize', 'reader', 'attest-activation'].map((name, i) => ({
        id: 801234560 + i, name, run_id: run.id, run_attempt: run.run_attempt, head_sha: run.head_sha,
        status: 'completed', conclusion: 'success', labels: ['ubuntu-latest'],
      })) },
    '/branches/main': { name: 'main', protected: true, commit: { sha: run.head_sha } },
  };
  const calls = [];
  return { payloads, calls, runPath, attemptPath,
    async get(url, options) {
      calls.push({ url, options });
      assert.ok(url.startsWith(ROOT));
      const suffix = url.slice(ROOT.length);
      assert.ok(Object.hasOwn(payloads, suffix), `unexpected endpoint ${suffix}`);
      return Response.json(payloads[suffix]);
    } };
}

// Structurally valid DER and gh-shaped output, deliberately NOT a signed proof.
export function verifiedOutput(manifest, digest) {
  const repo = `https://github.com/${CONTROL}`;
  const identity = `${repo}/${WORKFLOW}@refs/heads/main`;
  return [{ attestation: { bundle: { verificationMaterial: {
    certificate: { rawBytes: certificateFixture() },
  } } }, verificationResult: {
    signature: { certificate: {
      issuer: 'https://token.actions.githubusercontent.com', subjectAlternativeName: identity,
      buildSignerURI: identity, buildSignerDigest: manifest.control.sha,
      sourceRepositoryURI: repo, sourceRepositoryIdentifier: CONTROL_REPOSITORY_ID,
      sourceRepositoryRef: 'refs/heads/main', sourceRepositoryDigest: manifest.control.sha,
      githubWorkflowTrigger: 'workflow_dispatch', githubWorkflowRef: 'refs/heads/main',
      githubWorkflowSHA: manifest.control.sha, runnerEnvironment: 'github-hosted',
      runInvocationURI: `${repo}/actions/runs/${manifest.control.runId}/attempts/${manifest.control.runAttempt}`,
    } },
    verifiedTimestamps: [{ type: 'rekor', uri: 'https://rekor.sigstore.dev/api/v1/log/entries/0123456789abcdef',
      timestamp: '2026-09-29T12:01:00Z' }],
    statement: { subject: [{ name: 'local-collector-authorization.json', digest: { sha256: digest } }],
      predicateType: 'https://slsa.dev/provenance/v1', predicate: {} },
  } }];
}

export function verifierFixture(readContext, mutateOutput = () => {}) {
  const manifest = authorizationFixture();
  const challenge = createAuthorizationChallenge({ candidateSha: manifest.candidate.sha, suite: manifest.suite });
  manifest.executionId = challenge.presentation.executionId;
  manifest.activationCommitment = challenge.presentation.activationCommitment;
  const bytes = Buffer.from(serializeAuthorizationManifest(manifest));
  const calls = [];
  const contextCalls = [];
  const api = authorizationApiFixture(manifest);
  const input = { manifestBytes: bytes, challenge, clock: () => NOW,
    releasePolicy: releaseFixture(manifest), trustPolicy: { schemaVersion: 1, reviewedControlShas: [manifest.control.sha] },
    async readContext(options) {
      contextCalls.push(options);
      return readContext({ ...options, get: api.get });
    },
    boundary: { async run(command, args, options) {
      calls.push({ command, args, options });
      assert.equal(command, 'gh');
      const file = args[2];
      assert.equal(path.basename(file), 'local-collector-authorization.json');
      const written = await readFile(file);
      assert.deepEqual(written, bytes);
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
      const output = verifiedOutput(manifest, createHash('sha256').update(written).digest('hex'));
      await mutateOutput(output);
      return { stdout: JSON.stringify(output) };
    } },
  };
  return { manifest, bytes, challenge, input, calls, contextCalls, api };
}
