import { createHash } from 'node:crypto';
import { isValidExpectedEnvironment } from './evidence.mjs';

export class AttemptArtifactRefusal extends Error {
  constructor(code) { super(code); this.name = 'AttemptArtifactRefusal'; this.code = code; }
}

function refuse(code) { throw new AttemptArtifactRefusal(code); }
function same(a, b) { return canonical(a) === canonical(b); }
function keysOnly(value, allowed) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every((key) => allowed.includes(key));
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
const ROW_KEYS = ['attemptId', 'key', 'candidateSha', 'workflow', 'environment', 'state',
  'cleanupStatus', 'resourceIds', 'createdAt', 'updatedAt', 'artifact'];
const SNAPSHOT_KEYS = ['schema', 'artifactId', 'attemptId', 'key', 'candidateSha', 'workflow',
  'environment', 'state', 'cleanupStatus', 'resourceIds'];

export function validWorkflow(workflow) {
  return keysOnly(workflow, ['repository', 'ref', 'runId', 'runAttempt', 'runnerLabel']) &&
    Object.keys(workflow).length === 5 &&
    workflow.repository === 'lawxcompany-stack/billing-validation-control' &&
    /^refs\/heads\/[A-Za-z0-9._/-]+$/.test(workflow.ref) &&
    /^[1-9][0-9]{0,19}$/.test(workflow.runId) &&
    Number.isSafeInteger(workflow.runAttempt) && workflow.runAttempt > 0 &&
    /^billing-validation-[0-9a-f]{32}$/.test(workflow.runnerLabel);
}

export function validResourceIds(ids) {
  return Array.isArray(ids) && ids.length <= 100 && ids.every((id) =>
    typeof id === 'string' && /^(?:cus|in|pi|sub|price|prod|evt|ch|re|pm|seti|cs)_[A-Za-z0-9_]{1,120}$/.test(id) &&
    !/(?:^|_)secret(?:_|$)/i.test(id));
}

export function validArtifact(artifact) {
  return keysOnly(artifact, ['id', 'digest', 'schema', 'retentionDays']) &&
    typeof artifact.id === 'string' && /^[A-Za-z0-9_-]{2,128}$/.test(artifact.id) &&
    typeof artifact.digest === 'string' && /^[0-9a-f]{64}$/.test(artifact.digest) &&
    artifact.schema === 1 && (artifact.retentionDays === undefined || artifact.retentionDays === 2);
}

function project(row, artifactId) {
  return { schema: 1, artifactId, attemptId: row.attemptId, key: row.key,
    candidateSha: row.candidateSha, workflow: row.workflow, environment: row.environment,
    state: row.state, cleanupStatus: row.cleanupStatus, resourceIds: row.resourceIds };
}

function freezeTree(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

export function createSnapshot(row, artifactId) {
  if (!keysOnly(row, ROW_KEYS) || !keysOnly(row?.key, ['branchId', 'suite', 'fixtureKey']) ||
      Object.keys(row.key).length !== 3 || !validWorkflow(row.workflow) ||
      !isValidExpectedEnvironment(row.environment) ||
      !/^[a-f0-9]{40}$/.test(row.candidateSha ?? '') ||
      !validResourceIds(row.resourceIds) ||
      typeof artifactId !== 'string' || !/^[A-Za-z0-9_-]{2,128}$/.test(artifactId)) {
    refuse('attempt_private_material');
  }
  const snapshot = freezeTree(structuredClone(project(row, artifactId)));
  const digest = createHash('sha256').update(canonical(snapshot), 'utf8').digest('hex');
  return { snapshot, digest,
    artifact: Object.freeze({ id: artifactId, digest, schema: 1, retentionDays: 2 }) };
}

export function verifyRecheckSnapshot(snapshot, expected) {
  if (!keysOnly(snapshot, SNAPSHOT_KEYS) || Object.keys(snapshot).length !== SNAPSHOT_KEYS.length ||
      snapshot.schema !== 1 || !expected?.row ||
      expected.candidateSha !== expected.currentHeadSha ||
      !same(expected.workflow, expected.row.workflow) || !same(expected.environment, expected.row.environment) ||
      expected.candidateSha !== expected.row.candidateSha ||
      snapshot.artifactId !== expected.artifactId ||
      !same(snapshot, project(expected.row, expected.artifactId))) refuse('artifact_identity_mismatch');
  let sealed;
  try { sealed = createSnapshot(expected.row, expected.artifactId); }
  catch { refuse('artifact_identity_mismatch'); }
  if (sealed.digest !== expected.artifactDigest ||
      expected.row.artifact?.id !== expected.artifactId ||
      expected.row.artifact?.digest !== expected.artifactDigest ||
      expected.row.artifact?.schema !== 1) refuse('artifact_identity_mismatch');
  return true;
}
