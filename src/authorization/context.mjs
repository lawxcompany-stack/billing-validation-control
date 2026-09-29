import { types } from 'node:util';
import { AuthorizationRefusal, createAuthorizationManifest } from './manifest.mjs';

const ROOT = 'https://api.github.com/repos/lawxcompany-stack/billing-validation-control';
const WORKFLOW = '.github/workflows/authorize-local-collector.yml';
const JOB_NAMES = ['authorize', 'reader', 'attest-activation'];
const MAX_RESPONSE_BYTES = 65_536;
const GET_TIMEOUT_MS = 3_000;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = (value, expected) => Number.isSafeInteger(value) && value > 0
  && (expected === undefined || String(value) === expected);
function refuse() { throw new AuthorizationRefusal('authorization_context_invalid'); }

// Shared internal I/O guard. Racing is required: injected/failed transports may
// ignore AbortSignal. The operation also receives cancellation to stop late work.
export async function withAuthorizationDeadline(signal, timeoutMs, action) {
  if (signal !== undefined && (!(signal instanceof AbortSignal) || types.isProxy(signal))) {
    throw new AuthorizationRefusal('authorization_input_invalid');
  }
  const controller = new AbortController();
  const aborted = () => controller.abort(new AuthorizationRefusal('authorization_aborted'));
  let rejectAbort;
  const failure = new Promise((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(controller.signal.reason);
  controller.signal.addEventListener('abort', onAbort, { once: true });
  signal?.addEventListener('abort', aborted, { once: true });
  const timer = setTimeout(() => controller.abort(new AuthorizationRefusal('authorization_timeout')), timeoutMs);
  if (signal?.aborted) aborted();
  try {
    return await Promise.race([failure, Promise.resolve().then(() => {
      if (controller.signal.aborted) throw controller.signal.reason;
      return action(controller.signal);
    })]);
  } catch (error) {
    controller.abort(error);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', aborted);
    controller.signal.removeEventListener('abort', onAbort);
  }
}

async function readJson(response, signal) {
  if (!response || response.status !== 200 || response.redirected === true) refuse();
  const headers = response.headers;
  const contentType = headers?.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (!['application/json', 'application/vnd.github+json'].includes(contentType)
    || headers.get('link') !== null) refuse(); // All three jobs must fit the single fixed page.
  const encoding = headers.get('content-encoding')?.trim().toLowerCase() ?? 'identity';
  if (!['identity', 'gzip', 'br', 'deflate'].includes(encoding)) refuse();
  const declared = headers.get('content-length');
  if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(declared)
    || !Number.isSafeInteger(Number(declared)) || Number(declared) > MAX_RESPONSE_BYTES)) refuse();
  if (!response.body || typeof response.body.getReader !== 'function') refuse();
  const reader = response.body.getReader();
  const cancel = () => { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* closed */ } };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks = []; let size = 0;
  try {
    while (true) {
      if (signal.aborted) refuse();
      const { done, value } = await reader.read();
      if (signal.aborted) refuse();
      if (done) break;
      if (!types.isUint8Array(value)) refuse();
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) refuse();
      chunks.push(Buffer.from(value));
    }
    // Native fetch decodes compressed bodies; Content-Length counts wire bytes.
    if (encoding === 'identity' && declared !== null && Number(declared) !== size) refuse();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
  } catch { cancel(); refuse(); }
  finally {
    signal.removeEventListener('abort', cancel);
    try { reader.releaseLock(); } catch { /* a cancelled read can still hold the lock */ }
  }
}

function repositoryMatches(repo, manifest) {
  return record(repo) && id(repo.id, manifest.control.repositoryId) && repo.full_name === manifest.control.repository;
}

function checkRun(run, manifest, workflowId) {
  const control = manifest.control;
  if (!record(run) || !id(run.id, control.runId) || !id(run.run_attempt, control.runAttempt)
    || !id(run.workflow_id) || (workflowId !== undefined && run.workflow_id !== workflowId)
    || !repositoryMatches(run.repository, manifest) || !repositoryMatches(run.head_repository, manifest)
    || ![WORKFLOW, `${WORKFLOW}@main`].includes(run.path) || run.event !== 'workflow_dispatch'
    || run.head_branch !== 'main' || run.head_sha !== control.sha
    || run.status !== 'completed' || run.conclusion !== 'success') refuse();
}

function checkJobs(payload, manifest) {
  if (!record(payload) || payload.total_count !== 3 || !Array.isArray(payload.jobs) || payload.jobs.length !== 3) refuse();
  const jobs = payload.jobs;
  for (const job of jobs) {
    if (!record(job) || !id(job.id) || !JOB_NAMES.includes(job.name)
      || !id(job.run_id, manifest.control.runId) || !id(job.run_attempt, manifest.control.runAttempt)
      || job.head_sha !== manifest.control.sha || job.status !== 'completed' || job.conclusion !== 'success'
      || !Array.isArray(job.labels) || job.labels.length !== 1 || job.labels[0] !== 'ubuntu-latest') refuse();
  }
  if (new Set(jobs.map((job) => job.id)).size !== 3 || new Set(jobs.map((job) => job.name)).size !== 3) refuse();
  return Object.freeze(JOB_NAMES.map((name) => {
    const job = jobs.find((job) => job.name === name);
    return Object.freeze({ name, jobId: String(job.id) });
  }));
}

function options(input, allowed) {
  if (!record(input) || types.isProxy(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) refuse();
  const output = {};
  for (const key of Reflect.ownKeys(input)) {
    if (!allowed.includes(key)) refuse();
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!Object.hasOwn(descriptor, 'value')) refuse();
    output[key] = descriptor.value;
  }
  return output;
}

export async function readAuthorizationContext(input) {
  if (arguments.length !== 1) refuse();
  const snapshot = options(input, ['manifest', 'signal']);
  return readAuthorizationContextWithDependencies({ ...snapshot, get: globalThis.fetch });
}

// Test-only GET seam. No caller-controlled host, URL, credential or API method.
export async function readAuthorizationContextWithDependencies(input) {
  let manifest;
  try {
    const snapshot = options(input, ['manifest', 'signal', 'get']);
    manifest = createAuthorizationManifest(snapshot.manifest);
    if (manifest.operation !== 'collect') throw new AuthorizationRefusal('authorization_operation_unsupported');
    const { get, signal } = snapshot;
    if (typeof get !== 'function' || signal?.aborted) refuse();
    const request = (suffix) => withAuthorizationDeadline(signal, GET_TIMEOUT_MS, async (requestSignal) => {
      const response = await get(`${ROOT}${suffix}`, {
        method: 'GET', redirect: 'error', cache: 'no-store', credentials: 'omit', signal: requestSignal,
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'billing-validation-control' },
      });
      if (requestSignal.aborted) refuse();
      return readJson(response, requestSignal);
    });
    const repo = await request('');
    if (!repositoryMatches(repo, manifest) || repo.name !== 'billing-validation-control'
      || repo.default_branch !== 'main' || repo.private !== false || repo.visibility !== 'public') refuse();
    const runPath = `/actions/runs/${manifest.control.runId}`;
    const attemptPath = `${runPath}/attempts/${manifest.control.runAttempt}`;
    const current = await request(runPath);
    checkRun(current, manifest);
    const attempt = await request(attemptPath);
    checkRun(attempt, manifest, current.workflow_id);
    const workflow = await request('/actions/workflows/authorize-local-collector.yml');
    if (!record(workflow) || workflow.id !== current.workflow_id || workflow.path !== WORKFLOW || workflow.state !== 'active') refuse();
    const jobs = checkJobs(await request(`${attemptPath}/jobs?per_page=100&page=1`), manifest);
    const branch = await request('/branches/main');
    if (!record(branch) || branch.name !== 'main' || branch.protected !== true || branch.commit?.sha !== manifest.control.sha) refuse();
    checkRun(await request(runPath), manifest, current.workflow_id);
    if (signal?.aborted) refuse();
    return Object.freeze({ controlSha: manifest.control.sha, runId: manifest.control.runId,
      runAttempt: manifest.control.runAttempt, workflowId: String(current.workflow_id), jobs });
  } catch (error) {
    if (error instanceof AuthorizationRefusal && error.code === 'authorization_operation_unsupported') throw error;
    refuse();
  }
}
