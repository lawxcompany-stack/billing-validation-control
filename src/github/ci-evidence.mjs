import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { parseEvidenceArchive, EVIDENCE_ARCHIVE_LIMITS } from '../contracts/evidence.mjs';

const require = createRequire(import.meta.url);
const CANDIDATE_WORKFLOW_POLICY = require('../../policy/candidate-workflows.json');
const MAX_RUN_PAGES = 5;
const MAX_ATTEMPTS = 20;
const MAX_ARTIFACT_PAGES = 5;

export class CiEvidenceRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = 'CiEvidenceRefusal';
    this.code = code;
  }
}

function refuse(code) {
  throw new CiEvidenceRefusal(code);
}

async function getJson(api, path) {
  try {
    return await api.get(path);
  } catch {
    refuse('github_api_unavailable');
  }
}

function validTimestamp(value) {
  if (typeof value !== 'string') return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function pullBinding(run, candidate, baseBranch) {
  return Array.isArray(run.pull_requests) && run.pull_requests.some((pull) =>
    pull?.number === candidate.pullNumber && pull.base?.ref === baseBranch && pull.base?.sha === candidate.baseSha);
}

function exactRunBinding(run, candidate, workflow, baseBranch) {
  return run?.workflow_id === workflow.id && run?.path === workflow.path && run?.event === workflow.event &&
    run?.head_sha?.toLowerCase() === candidate.candidateSha &&
    run?.repository?.full_name === candidate.repository && run.repository?.id === candidate.repositoryId &&
    run?.head_repository?.full_name === candidate.repository && run.head_repository?.id === candidate.repositoryId &&
    pullBinding(run, candidate, baseBranch);
}

async function listWorkflowRuns(api, candidate, workflow) {
  const result = [];
  for (let page = 1; page <= MAX_RUN_PAGES; page += 1) {
    const response = await getJson(api,
      `/repos/${candidate.repository}/actions/workflows/${workflow.id}/runs?per_page=100&page=${page}`);
    if (!response || !Array.isArray(response.workflow_runs)) refuse('ci_run_list_invalid');
    result.push(...response.workflow_runs);
    if (response.workflow_runs.length < 100) return result;
  }
  refuse('ci_run_list_too_large');
}

function selectLatestRun(runs, candidate, workflow, baseBranch) {
  const exactRuns = runs.filter((run) => exactRunBinding(run, candidate, workflow, baseBranch));
  if (exactRuns.length === 0) refuse('ci_run_not_found');
  const timestamped = exactRuns.map((run) => ({ run, timestamp: validTimestamp(run.created_at) }));
  if (timestamped.some(({ timestamp }) => timestamp === null)) refuse('ci_run_metadata_invalid');
  timestamped.sort((left, right) => right.timestamp - left.timestamp);
  if (timestamped.length > 1 && timestamped[0].timestamp === timestamped[1].timestamp) refuse('ci_run_ambiguous');
  const latest = timestamped[0].run;
  if (!Number.isSafeInteger(latest.id) || latest.id < 1 || latest.status !== 'completed' || latest.conclusion !== 'success' ||
      !Number.isSafeInteger(latest.run_attempt) || latest.run_attempt < 1 || latest.run_attempt > MAX_ATTEMPTS) {
    refuse('ci_run_not_successful');
  }
  return latest;
}

function unwrapAttempt(response) {
  if (!response || typeof response !== 'object') return null;
  return response.workflow_run ?? response;
}

async function resolveAttemptWindows(api, candidate, run) {
  const windows = [];
  for (let attempt = 1; attempt <= run.run_attempt; attempt += 1) {
    const response = await getJson(api,
      `/repos/${candidate.repository}/actions/runs/${run.id}/attempts/${attempt}`);
    const record = unwrapAttempt(response);
    const start = validTimestamp(record?.run_started_at ?? record?.started_at);
    const end = validTimestamp(record?.completed_at ?? record?.updated_at);
    if (!record || record.run_attempt !== attempt || start === null || end === null || end < start ||
        record.status !== 'completed') refuse('ci_attempt_metadata_invalid');
    if (record.id !== undefined && record.id !== run.id) refuse('ci_attempt_identity_mismatch');
    if (record.workflow_id !== undefined && record.workflow_id !== run.workflow_id) refuse('ci_attempt_identity_mismatch');
    if (record.head_sha !== undefined && record.head_sha.toLowerCase() !== candidate.candidateSha) {
      refuse('ci_attempt_identity_mismatch');
    }
    windows.push({ attempt, start, end, conclusion: record.conclusion });
  }
  for (let index = 1; index < windows.length; index += 1) {
    if (windows[index - 1].end >= windows[index].start) refuse('artifact_attempt_ambiguous');
  }
  const current = windows.at(-1);
  if (!current || current.attempt !== run.run_attempt || current.conclusion !== 'success') refuse('ci_run_not_successful');
  return windows;
}

async function listArtifacts(api, candidate, run) {
  const artifacts = [];
  for (let page = 1; page <= MAX_ARTIFACT_PAGES; page += 1) {
    const response = await getJson(api,
      `/repos/${candidate.repository}/actions/runs/${run.id}/artifacts?per_page=100&page=${page}`);
    if (!response || !Array.isArray(response.artifacts)) refuse('artifact_list_invalid');
    artifacts.push(...response.artifacts);
    if (response.artifacts.length < 100) return artifacts;
  }
  refuse('artifact_list_too_large');
}

function selectArtifact(artifacts, run, suffixTemplate) {
  const suffix = suffixTemplate
    .replace('{run_id}', String(run.id))
    .replace('{attempt}', String(run.run_attempt));
  const matches = artifacts.filter((artifact) => typeof artifact?.name === 'string' && artifact.name.endsWith(suffix));
  if (matches.length === 0) refuse('artifact_missing');
  if (matches.length !== 1) refuse('artifact_duplicate');
  return matches[0];
}

function assertArtifactBinding(artifact, candidate, run, windows) {
  const workflowRun = artifact?.workflow_run;
  if (!Number.isSafeInteger(artifact.id) || artifact.id < 1 || artifact.expired !== false ||
      !workflowRun || workflowRun.id !== run.id || workflowRun.repository_id !== candidate.repositoryId ||
      workflowRun.head_sha?.toLowerCase() !== candidate.candidateSha) refuse('artifact_identity_mismatch');
  if (!Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes < 1 ||
      artifact.size_in_bytes > EVIDENCE_ARCHIVE_LIMITS.archiveBytes) refuse('artifact_too_large');
  if (typeof artifact.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(artifact.digest)) {
    refuse('artifact_digest_invalid');
  }
  const createdAt = validTimestamp(artifact.created_at);
  if (createdAt === null) refuse('artifact_attempt_ambiguous');
  const containing = windows.filter(({ start, end }) => createdAt >= start && createdAt <= end);
  if (containing.length > 1) refuse('artifact_attempt_ambiguous');
  if (containing.length !== 1 || containing[0].attempt !== run.run_attempt) refuse('artifact_attempt_mismatch');
}

async function readBoundedStream(stream, maxBytes) {
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') refuse('artifact_download_invalid');
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      if (!(Buffer.isBuffer(chunk) || chunk instanceof Uint8Array)) refuse('artifact_download_invalid');
      size += chunk.byteLength;
      if (size > maxBytes) refuse('artifact_too_large');
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    if (error instanceof CiEvidenceRefusal) throw error;
    refuse('artifact_download_invalid');
  }
  return Buffer.concat(chunks, size);
}

async function collectWorkflow(api, candidate, workflow, baseBranch) {
  if (!Number.isSafeInteger(workflow.id) || workflow.id < 1 || typeof workflow.path !== 'string' ||
      workflow.event !== 'pull_request' || typeof workflow.suite !== 'string' ||
      workflow.artifact_json_path !== 'evidence.json' ||
      workflow.artifact_required !== true || workflow.artifact_name_suffix !== '-{run_id}-{attempt}') {
    refuse('workflow_policy_invalid');
  }
  const runs = await listWorkflowRuns(api, candidate, workflow);
  const run = selectLatestRun(runs, candidate, workflow, baseBranch);
  const windows = await resolveAttemptWindows(api, candidate, run);
  const artifact = selectArtifact(await listArtifacts(api, candidate, run), run, workflow.artifact_name_suffix);
  assertArtifactBinding(artifact, candidate, run, windows);
  if (!api || typeof api.downloadArtifact !== 'function') refuse('artifact_download_unavailable');
  let stream;
  try {
    stream = await api.downloadArtifact(artifact.id, { maxBytes: EVIDENCE_ARCHIVE_LIMITS.archiveBytes });
  } catch {
    refuse('artifact_download_unavailable');
  }
  const bytes = await readBoundedStream(stream, EVIDENCE_ARCHIVE_LIMITS.archiveBytes);
  if (bytes.length !== artifact.size_in_bytes) refuse('artifact_size_mismatch');
  const computedDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (computedDigest !== artifact.digest) refuse('artifact_digest_mismatch');
  let diagnostics;
  try {
    diagnostics = parseEvidenceArchive(bytes, {
      digest: artifact.digest,
      expected: {
        candidateSha: candidate.candidateSha,
        workflowId: workflow.id,
        runId: String(run.id),
        attempt: run.run_attempt,
        suite: workflow.suite,
      },
    });
  } catch (error) {
    if (error?.code) refuse(error.code);
    refuse('artifact_evidence_invalid');
  }
  return Object.freeze({
    suite: workflow.suite,
    workflowId: workflow.id,
    workflowPath: workflow.path,
    runId: String(run.id),
    attempt: run.run_attempt,
    conclusion: run.conclusion,
    artifactId: artifact.id,
    artifactDigest: artifact.digest,
    artifactCreatedAt: artifact.created_at,
    diagnostics,
  });
}

export async function collectCiEvidence(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some((key) => !['api', 'candidate'].includes(key))) refuse('ci_input_invalid');
  const { api, candidate } = options;
  if (!candidate || candidate.repository !== 'lawxcompany-stack/Plataforma-LawX' ||
      !Number.isSafeInteger(candidate.repositoryId) || !Number.isSafeInteger(candidate.pullNumber) ||
      typeof candidate.candidateSha !== 'string' || !/^[0-9a-f]{40}$/u.test(candidate.candidateSha) ||
      typeof candidate.baseSha !== 'string' || !/^[0-9a-f]{40}$/u.test(candidate.baseSha) || !api) {
    refuse('candidate_identity_invalid');
  }
  const policy = CANDIDATE_WORKFLOW_POLICY;
  if (policy?.schema_version !== 1 || policy.repository !== candidate.repository ||
      policy.base_branch !== 'preview' || !Array.isArray(policy.workflows) || policy.workflows.length === 0) {
    refuse('workflow_policy_invalid');
  }
  const results = [];
  const seenIds = new Set();
  const seenSuites = new Set();
  for (const workflow of policy.workflows) {
    if (seenIds.has(workflow?.id) || seenSuites.has(workflow?.suite)) refuse('workflow_policy_invalid');
    seenIds.add(workflow?.id);
    seenSuites.add(workflow?.suite);
    results.push(await collectWorkflow(api, candidate, workflow, policy.base_branch));
  }
  return Object.freeze(results);
}
