import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { types } from 'node:util';
import { AuthorizationRefusal, parseAuthorizationManifest, serializeAuthorizationManifest, authorizationDigest } from './manifest.mjs';
import { assertAuthorizationChallenge } from './challenge.mjs';
import { selectRelease, validateTrustPolicy } from './release-policy.mjs';
import { withAuthorizationDeadline } from './context.mjs';
import { verifyDeploymentEnvironment } from '../../runner/attestation-environment.mjs';

const CONTROL = 'lawxcompany-stack/billing-validation-control';
const WORKFLOW = '.github/workflows/authorize-local-collector.yml';
const REF = 'refs/heads/main';
const ISSUER = 'https://token.actions.githubusercontent.com';
const PREDICATE = 'https://slsa.dev/provenance/v1';
const SUBJECT = 'local-collector-authorization.json';
const MAX_OUTPUT_BYTES = 512 * 1024;
const JOB_NAMES = ['authorize', 'reader', 'attest-activation'];
const SAFE_CODES = new Set([
  'authorization_input_invalid', 'authorization_noncanonical', 'authorization_operation_unsupported',
  'authorization_challenge_invalid', 'authorization_challenge_mismatch', 'authorization_challenge_expired',
  'authorization_challenge_consumed', 'authorization_challenge_destroyed', 'authorization_control_unreviewed',
  'authorization_release_invalid', 'authorization_release_unconfigured', 'authorization_release_ambiguous',
  'authorization_release_mismatch', 'authorization_trust_invalid', 'authorization_context_invalid',
  'authorization_expired', 'authorization_not_yet_valid', 'authorization_aborted', 'authorization_timeout',
]);
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function refuse(code = 'authorization_attestation_invalid') { throw new AuthorizationRefusal(code); }

function ownOptions(input, allowed) {
  if (!isRecord(input) || types.isProxy(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    refuse('authorization_input_invalid');
  }
  const output = {};
  for (const key of Reflect.ownKeys(input)) {
    if (!allowed.includes(key)) refuse('authorization_input_invalid');
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!Object.hasOwn(descriptor, 'value')) refuse('authorization_input_invalid');
    output[key] = descriptor.value;
  }
  return output;
}

// Internal helper shared only with the closed public entry point. It snapshots
// canonical bytes synchronously, before policy reads or other awaited work.
export function snapshotVerificationInput(input) {
  const { manifestBytes, challenge, signal } = ownOptions(input, ['manifestBytes', 'challenge', 'signal']);
  if (signal !== undefined && (types.isProxy(signal) || !(signal instanceof AbortSignal))) refuse('authorization_input_invalid');
  const manifest = parseAuthorizationManifest(manifestBytes);
  assertAuthorizationChallenge(challenge, manifest);
  return { manifestBytes: serializeAuthorizationManifest(manifest), challenge, signal };
}

function validateContext(value, manifest) {
  try {
    const context = ownOptions(value, ['controlSha', 'runId', 'runAttempt', 'workflowId', 'jobs']);
    if (context.controlSha !== manifest.control.sha || context.runId !== manifest.control.runId
      || context.runAttempt !== manifest.control.runAttempt || typeof context.workflowId !== 'string'
      || !/^[1-9][0-9]*$/u.test(context.workflowId) || !Number.isSafeInteger(Number(context.workflowId))
      || !Array.isArray(context.jobs) || context.jobs.length !== 3) refuse();
    const jobs = context.jobs.map((value, index) => {
      const job = ownOptions(value, ['name', 'jobId']);
      if (job.name !== JOB_NAMES[index] || typeof job.jobId !== 'string' || !/^[1-9][0-9]*$/u.test(job.jobId)
        || !Number.isSafeInteger(Number(job.jobId))) refuse();
      return Object.freeze(job);
    });
    if (new Set(jobs.map((job) => job.jobId)).size !== 3) refuse();
    return Object.freeze({ ...context, jobs: Object.freeze(jobs) });
  } catch { refuse('authorization_context_invalid'); }
}

function timestampNanos(value) {
  if (typeof value !== 'string' || value.length > 40) refuse();
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!match) refuse();
  const local = `${match[1]}.${((match[2] ?? '') + '000').slice(0, 3)}Z`;
  const time = Date.parse(local);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== local) refuse();
  if (match[3] !== 'Z' && (Number(match[3].slice(1, 3)) > 23 || Number(match[3].slice(4)) > 59)) refuse();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) refuse();
  // Preserve RFC3339 fractional precision at the signed/skew boundaries.
  return BigInt(parsed) * 1_000_000n + BigInt(((match[2] ?? '') + '000000000').slice(3, 9));
}

function checkTimestampWindow(timestamps, manifest, now) {
  const future = (BigInt(now) + 60_000n) * 1_000_000n;
  const issued = BigInt(Date.parse(manifest.issuedAt)) * 1_000_000n;
  const expires = BigInt(Date.parse(manifest.expiresAt)) * 1_000_000n;
  if (timestamps.some((time) => time > future)
    || !timestamps.some((time) => time >= issued && time <= expires)) refuse();
}

function checkOutput(stdout, digest, manifest, now) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout, 'utf8') > MAX_OUTPUT_BYTES) refuse();
  let output;
  try { output = JSON.parse(stdout); } catch { refuse(); }
  if (!Array.isArray(output) || output.length !== 1 || !isRecord(output[0])) refuse();
  const { attestation, verificationResult: result } = output[0];
  const certificate = result?.signature?.certificate;
  if (!isRecord(attestation) || !isRecord(result) || !isRecord(certificate)) refuse();
  const repo = `https://github.com/${CONTROL}`;
  const identity = `${repo}/${WORKFLOW}@${REF}`;
  const expected = {
    issuer: ISSUER, subjectAlternativeName: identity, buildSignerURI: identity,
    buildSignerDigest: manifest.control.sha, sourceRepositoryURI: repo,
    sourceRepositoryIdentifier: '1384018279', sourceRepositoryRef: REF,
    sourceRepositoryDigest: manifest.control.sha, githubWorkflowTrigger: 'workflow_dispatch',
    githubWorkflowRef: REF, githubWorkflowSHA: manifest.control.sha, runnerEnvironment: 'github-hosted',
    runInvocationURI: `${repo}/actions/runs/${manifest.control.runId}/attempts/${manifest.control.runAttempt}`,
  };
  if (Object.entries(expected).some(([key, value]) => certificate[key] !== value)) refuse();
  // Reads the signed leaf DER extension, never a predicate or summary fallback.
  verifyDeploymentEnvironment(attestation, certificate);
  const statement = result.statement;
  if (!isRecord(statement) || statement.predicateType !== PREDICATE
    || !Array.isArray(statement.subject) || statement.subject.length !== 1) refuse();
  const subject = statement.subject[0];
  if (!isRecord(subject) || subject.name !== SUBJECT || !isRecord(subject.digest)
    || Object.keys(subject.digest).length !== 1 || subject.digest.sha256 !== digest) refuse();
  if (!Array.isArray(result.verifiedTimestamps) || result.verifiedTimestamps.length === 0
    || result.verifiedTimestamps.length > 16) refuse();
  const timestamps = result.verifiedTimestamps.map((entry) => {
    if (!isRecord(entry) || typeof entry.type !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/u.test(entry.type)
      || typeof entry.uri !== 'string' || entry.uri.length > 2048) refuse();
    const uri = new URL(entry.uri);
    if (uri.protocol !== 'https:' || !uri.hostname || uri.username || uri.password) refuse();
    return timestampNanos(entry.timestamp);
  });
  checkTimestampWindow(timestamps, manifest, now);
  return Object.freeze(timestamps);
}

// Explicitly internal test seam: none of these authority dependencies are
// accepted by verifier.mjs. A successful result is only a consumed receipt.
export async function verifyLocalAuthorizationWithDependencies(input) {
  try {
    const options = ownOptions(input, ['manifestBytes', 'challenge', 'signal', 'boundary', 'readContext',
      'releasePolicy', 'trustPolicy', 'clock']);
    const { manifestBytes, challenge, signal } = snapshotVerificationInput({ manifestBytes: options.manifestBytes,
      challenge: options.challenge, signal: options.signal });
    const manifest = parseAuthorizationManifest(manifestBytes);
    const trust = validateTrustPolicy(options.trustPolicy);
    if (!trust.reviewedControlShas.includes(manifest.control.sha)) refuse('authorization_control_unreviewed');
    const release = selectRelease(options.releasePolicy, manifest.suite);
    for (const part of ['collectorRelease', 'policy']) {
      if (Object.keys(release[part]).some((key) => release[part][key] !== manifest[part][key])) refuse('authorization_release_mismatch');
    }
    const run = options.boundary?.run?.bind(options.boundary);
    const readContext = options.readContext;
    const clock = options.clock ?? Date.now;
    if (typeof run !== 'function' || typeof readContext !== 'function' || typeof clock !== 'function') refuse('authorization_input_invalid');
    const digest = authorizationDigest(manifestBytes);
    return await withAuthorizationDeadline(signal, 90_000, async (deadlineSignal) => {
      const fresh = () => {
        if (deadlineSignal.aborted) throw deadlineSignal.reason;
        assertAuthorizationChallenge(challenge, manifest);
        const now = clock();
        if (!Number.isSafeInteger(now) || now >= Date.parse(manifest.expiresAt)) refuse('authorization_expired');
        if (Date.parse(manifest.issuedAt) > now + 60_000) refuse('authorization_not_yet_valid');
        return now;
      };
      const context = async () => {
        fresh();
        const value = await withAuthorizationDeadline(deadlineSignal, 25_000,
          (readSignal) => readContext({ manifest, signal: readSignal }));
        fresh();
        return validateContext(value, manifest);
      };
      const before = await context();
      let directory;
      let timestamps;
      try {
        fresh();
        directory = await mkdtemp(path.join(os.tmpdir(), 'bvc-authorization-'));
        fresh();
        const file = path.join(directory, SUBJECT);
        await writeFile(file, manifestBytes, { flag: 'wx', mode: 0o600 });
        fresh();
        const ghConfig = path.join(directory, 'gh');
        await mkdir(ghConfig, { mode: 0o700 });
        fresh();
        const args = ['attestation', 'verify', file,
          '--repo', CONTROL, '--signer-workflow', `${CONTROL}/${WORKFLOW}`,
          '--signer-digest', manifest.control.sha, '--cert-identity', `https://github.com/${CONTROL}/${WORKFLOW}@${REF}`,
          '--cert-oidc-issuer', ISSUER, '--source-repo', CONTROL, '--source-ref', REF,
          '--source-digest', manifest.control.sha, '--deny-self-hosted-runners',
          '--predicate-type', PREDICATE, '--format', 'json'];
        const result = await withAuthorizationDeadline(deadlineSignal, 30_000, (processSignal) => run('gh', args, {
          signal: processSignal, timeoutMs: 30_000, maxOutputBytes: MAX_OUTPUT_BYTES,
          env: { GH_CONFIG_DIR: ghConfig, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1',
            GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1' },
        }));
        const now = fresh();
        timestamps = checkOutput(result?.stdout, digest, manifest, now);
      } finally {
        // Cleanup is part of verification, and finishes BEFORE the last context
        // read/consumption. Failure or expiry here must never yield success.
        if (directory) await withAuthorizationDeadline(undefined, 3_000, () => rm(directory, { recursive: true, force: true }));
      }
      fresh();
      const after = await context();
      if (JSON.stringify(before) !== JSON.stringify(after)) refuse('authorization_context_invalid');
      checkTimestampWindow(timestamps, manifest, fresh());
      const receipt = Object.freeze({ scope: 'authorization-only', authorizationDigest: digest,
        executionId: manifest.executionId, candidateSha: manifest.candidate.sha });
      // No await between this branded identity/freshness assertion and consume.
      assertAuthorizationChallenge(challenge, manifest);
      challenge.consume();
      return receipt;
    });
  } catch (error) {
    refuse(error instanceof AuthorizationRefusal && SAFE_CODES.has(error.code) ? error.code : 'authorization_attestation_invalid');
  }
}
