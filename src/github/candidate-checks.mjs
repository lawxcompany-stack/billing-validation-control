// These are prerequisites for trusted collection, not billing/release evidence.
// Waiting for the application workflow's final financial artifact here would
// create a cycle when that workflow is itself waiting for trusted collection.
import { types } from 'node:util';

const REPOSITORY = 'lawxcompany-stack/Plataforma-LawX';
const REPOSITORY_ID = 1234079266;
const WORKFLOW_ID = 290018021;
const WORKFLOW_PATH = '.github/workflows/ci.yml';
const SHA = /^[a-f0-9]{40}$/u;
const JOBS = Object.freeze([
  { key: 'quality', name: 'Qualidade (ESLint + TypeScript)' },
  { key: 'regression', name: 'Regressão (unitários, integração e cobertura crítica)' },
  { key: 'build', name: 'Build de produção' },
]);
const MAX_PAGES = 5;
const MAX_RUNS = 50;

export class CandidateChecksRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = 'CandidateChecksRefusal';
    this.code = code;
  }
}

function refuse(suffix) { throw new CandidateChecksRefusal(`candidate_checks_${suffix}`); }
function id(value) { return Number.isSafeInteger(value) && value > 0; }
function timestamp(value) { return typeof value === 'string' ? Date.parse(value) : NaN; }

async function get(api, path) {
  try { return await api.get(path); } catch { refuse('api_unavailable'); }
}

function bound(run, candidate) {
  return run?.workflow_id === WORKFLOW_ID && run.path === WORKFLOW_PATH && run.event === 'pull_request' &&
    run.head_sha === candidate.candidateSha && run.repository?.id === candidate.repositoryId &&
    run.repository.full_name === REPOSITORY && run.head_repository?.id === candidate.repositoryId &&
    run.head_repository.full_name === REPOSITORY && Array.isArray(run.pull_requests) &&
    run.pull_requests.some((pull) => pull?.number === candidate.pullNumber &&
      pull.base?.ref === 'preview' && pull.base.sha === candidate.baseSha);
}

async function listRuns(api, candidate) {
  const runs = [];
  const seen = new Set();
  let total;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const query = new URLSearchParams({ head_sha: candidate.candidateSha, event: 'pull_request',
      per_page: '100', page: String(page) });
    const response = await get(api, `/repos/${REPOSITORY}/actions/workflows/${WORKFLOW_ID}/runs?${query}`);
    if (!Array.isArray(response?.workflow_runs) || response.workflow_runs.length > 100 ||
        !Number.isSafeInteger(response.total_count) || response.total_count < 0 ||
        (total !== undefined && total !== response.total_count)) refuse('run_list_invalid');
    total = response.total_count;
    if (total > MAX_PAGES * 100) refuse('run_list_too_large');
    for (const run of response.workflow_runs) {
      if (!id(run?.id) || seen.has(run.id)) refuse('run_list_invalid');
      seen.add(run.id);
      if (bound(run, candidate)) runs.push(run);
    }
    if (runs.length > MAX_RUNS) refuse('run_list_too_large');
    if (seen.size > total) refuse('run_list_invalid');
    if (seen.size === total) return runs;
    if (response.workflow_runs.length < 100) refuse('run_list_invalid');
  }
  refuse('run_list_too_large');
}

async function latestAttempt(api, candidate) {
  const runs = await listRuns(api, candidate);
  if (runs.length === 0) refuse('run_not_found');
  const attempts = [];
  for (const run of runs) {
    if (!id(run.run_attempt) || run.run_attempt > 20) refuse('attempt_invalid');
    // A newly queued attempt has no completed prerequisite proof of its own.
    if (!['completed', 'in_progress'].includes(run.status)) refuse('run_not_usable');
    const attempt = await get(api, `/repos/${REPOSITORY}/actions/runs/${run.id}/attempts/${run.run_attempt}`);
    if (!bound(attempt, candidate) || attempt.id !== run.id || attempt.run_attempt !== run.run_attempt ||
        attempt.status !== run.status || attempt.conclusion !== run.conclusion ||
        !Number.isFinite(timestamp(attempt.run_started_at))) refuse('attempt_invalid');
    attempts.push({ ...attempt, startedAt: timestamp(attempt.run_started_at) });
  }
  attempts.sort((a, b) => b.startedAt - a.startedAt);
  if (attempts.length > 1 && attempts[0].startedAt === attempts[1].startedAt) refuse('run_ambiguous');
  const selected = attempts[0];
  if (!(selected.status === 'in_progress' && selected.conclusion === null) &&
      !(selected.status === 'completed' && ['success', 'failure'].includes(selected.conclusion))) {
    refuse('run_not_usable');
  }
  return selected;
}

async function readJobs(api, attempt, candidate) {
  const jobs = [];
  const seen = new Set();
  let total;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await get(api, `/repos/${REPOSITORY}/actions/runs/${attempt.id}/attempts/${attempt.run_attempt}/jobs?per_page=100&page=${page}`);
    if (!Array.isArray(response?.jobs) || response.jobs.length > 100 ||
        !Number.isSafeInteger(response.total_count) || response.total_count < 0 ||
        (total !== undefined && total !== response.total_count)) refuse('job_list_invalid');
    total = response.total_count;
    for (const job of response.jobs) {
      if (!id(job?.id) || seen.has(job.id) || job.run_id !== attempt.id ||
          job.run_attempt !== attempt.run_attempt || job.head_sha !== candidate.candidateSha) {
        refuse('job_identity_invalid');
      }
      seen.add(job.id);
      jobs.push(job);
    }
    if (response.jobs.length < 100) {
      if (jobs.length !== total) refuse('job_list_invalid');
      return jobs;
    }
  }
  refuse('job_list_too_large');
}

function snapshotFields(value, keys) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) refuse('input_invalid');
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) refuse('input_invalid');
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

export async function collectCandidateChecks(input = {}) {
  const options = snapshotFields(input, ['api', 'candidate']);
  const candidate = snapshotFields(options.candidate,
    ['repository', 'repositoryId', 'pullNumber', 'candidateSha', 'baseSha', 'treeSha']);
  const client = snapshotFields(options.api, ['get']);
  if (typeof client.get !== 'function') refuse('input_invalid');
  const api = Object.freeze({ get: client.get.bind(options.api) });
  if (candidate.repository !== REPOSITORY || candidate.repositoryId !== REPOSITORY_ID || !id(candidate.pullNumber) ||
      ![candidate.candidateSha, candidate.baseSha, candidate.treeSha].every(value =>
        typeof value === 'string' && SHA.test(value))) refuse('input_invalid');

  const attempt = await latestAttempt(api, candidate);
  const jobs = await readJobs(api, attempt, candidate);
  const receipts = JOBS.map(({ key, name }) => {
    const matches = jobs.filter((job) => job.name === name);
    if (matches.length === 0) refuse('job_missing');
    if (matches.length !== 1) refuse('job_ambiguous');
    const job = matches[0];
    if (job.status !== 'completed' || job.conclusion !== 'success') refuse('job_not_successful');
    const start = timestamp(job.started_at);
    const end = timestamp(job.completed_at);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < attempt.startedAt || end < start) {
      refuse('job_identity_invalid');
    }
    return Object.freeze({ key, jobId: String(job.id), conclusion: 'success' });
  });

  // Prevent a concurrent rerun/new workflow from making the just-read jobs stale.
  const current = await latestAttempt(api, candidate);
  if (current.id !== attempt.id || current.run_attempt !== attempt.run_attempt ||
      current.startedAt !== attempt.startedAt) refuse('changed_during_read');

  return Object.freeze({ scope: 'candidate-prerequisites', repository: REPOSITORY,
    repositoryId: REPOSITORY_ID,
    candidateSha: candidate.candidateSha, treeSha: candidate.treeSha, baseSha: candidate.baseSha,
    pullNumber: candidate.pullNumber, workflowId: WORKFLOW_ID, workflowPath: WORKFLOW_PATH,
    runId: String(attempt.id), attempt: attempt.run_attempt, jobs: Object.freeze(receipts) });
}
