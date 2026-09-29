import { types } from 'node:util';
import { AuthorizationRefusal, createAuthorizationManifest } from './manifest.mjs';
import { selectRelease } from './release-policy.mjs';
import { parseLocalAuthorizationDispatch, snapshotRecord, validateLocalAuthorizationContext } from './dispatch.mjs';

function invalid() { throw new AuthorizationRefusal('authorization_receipt_invalid'); }
const decimal = value => typeof value === 'string' && /^[1-9][0-9]*$/u.test(value)
  && Number.isSafeInteger(Number(value)) && String(Number(value)) === value;
const numeric = value => Number.isSafeInteger(value) && value > 0;
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);

export function validateLocalAuthorizationReceipt(value, candidateSha) {
  const r = snapshotRecord(value, ['scope', 'repository', 'repositoryId', 'candidateSha', 'treeSha', 'baseSha',
    'pullNumber', 'workflowId', 'workflowPath', 'runId', 'attempt', 'jobs']);
  if (r.scope !== 'candidate-prerequisites' || r.repository !== 'lawxcompany-stack/Plataforma-LawX'
    || r.repositoryId !== 1234079266 || !sha(r.candidateSha) || r.candidateSha !== candidateSha
    || !sha(r.treeSha) || !sha(r.baseSha) || !numeric(r.pullNumber) || r.workflowId !== 290018021
    || r.workflowPath !== '.github/workflows/ci.yml' || !decimal(r.runId) || !numeric(r.attempt)) invalid();
  if (!r.jobs || types.isProxy(r.jobs) || !Array.isArray(r.jobs)
    || Object.getPrototypeOf(r.jobs) !== Array.prototype) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(r.jobs);
  if (descriptors.length.value !== 3 || Reflect.ownKeys(descriptors).length !== 4) invalid();
  const jobs = ['quality', 'regression', 'build'].map((key, index) => {
    const d = descriptors[index];
    if (!d || !Object.hasOwn(d, 'value')) invalid();
    const job = snapshotRecord(d.value, ['key', 'jobId', 'conclusion']);
    if (job.key !== key || !decimal(job.jobId) || job.conclusion !== 'success') invalid();
    return job;
  });
  if (new Set(jobs.map(job => job.jobId)).size !== 3) invalid();
  return Object.freeze({ ...r, jobs: Object.freeze(jobs) });
}

export function emitLocalAuthorization(input) {
  const args = snapshotRecord(input, ['dispatch', 'receipt', 'context', 'releasePolicy', 'now']);
  const c = validateLocalAuthorizationContext(args.context);
  const d = parseLocalAuthorizationDispatch(args.dispatch, c);
  const release = selectRelease(args.releasePolicy, d.suite);
  const r = validateLocalAuthorizationReceipt(args.receipt, d.candidate_sha);
  const now = args.now;
  if (!now || types.isProxy(now) || !types.isDate(now) || Object.getPrototypeOf(now) !== Date.prototype
    || Reflect.ownKeys(now).length !== 0) throw new AuthorizationRefusal('authorization_time_invalid');
  const time = Date.prototype.getTime.call(now);
  if (!Number.isFinite(time) || !Number.isFinite(new Date(time + 1_200_000).getTime())) {
    throw new AuthorizationRefusal('authorization_time_invalid');
  }
  return createAuthorizationManifest({
    schemaVersion: 2, kind: 'billing-collector-authorization', executionMode: 'isolated-local', operation: 'collect',
    executionId: d.execution_id, activationCommitment: d.activation_commitment,
    candidate: { repository: r.repository, repositoryId: String(r.repositoryId), pullNumber: String(r.pullNumber),
      sha: r.candidateSha, treeSha: r.treeSha, baseSha: r.baseSha },
    prerequisites: { workflowId: String(r.workflowId), workflowPath: r.workflowPath,
      runId: r.runId, runAttempt: String(r.attempt), jobs: r.jobs },
    control: { repository: c.repository, repositoryId: c.repositoryId, ref: c.ref,
      workflowPath: '.github/workflows/authorize-local-collector.yml', sha: c.sha,
      runId: c.runId, runAttempt: c.runAttempt, event: c.eventName },
    collectorRelease: release.collectorRelease, policy: release.policy, suite: d.suite,
    issuedAt: new Date(time).toISOString(), expiresAt: new Date(time + 1_200_000).toISOString(), sourceExecutionId: null,
  });
}
