export const CONTROL_REPOSITORY = 'lawxcompany-stack/billing-validation-control';
export const CONTROL_WORKFLOW_PATH = '.github/workflows/validate-billing.yml';
export const CONTROL_DEFAULT_BRANCH = 'main';
export const ISOLATED_RUNNER_GROUP = 'billing-validation-isolated';
const GITHUB_API_ORIGIN = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const RUN_LOOKUP_TIMEOUT_MS = 3_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

export class WorkflowContextRefusal extends Error {
  constructor() {
    super('runner_workflow_context_invalid');
    this.name = 'WorkflowContextRefusal';
    this.code = 'runner_workflow_context_invalid';
  }
}

function refuse() {
  throw new WorkflowContextRefusal();
}

function validDecimal(value, maximumLength) {
  return typeof value === 'string' && value.length <= maximumLength &&
    /^[1-9][0-9]*$/u.test(value) && Number.isSafeInteger(Number(value)) && String(Number(value)) === value;
}

async function readBoundedJson(response) {
  const contentType = response.headers?.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (!['application/json', 'application/vnd.github+json'].includes(contentType)) refuse();
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength) ||
      Number(contentLength) > MAX_RESPONSE_BYTES)) refuse();
  if (!response.body || typeof response.body.getReader !== 'function') refuse();

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) refuse();
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        refuse();
      }
      chunks.push(Buffer.from(value));
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, totalBytes));
    return JSON.parse(text);
  } catch {
    try { await reader.cancel(); } catch { /* response is already closed */ }
    refuse();
  } finally {
    try { reader.releaseLock(); } catch { /* an outstanding read owns the lock */ }
  }
}

function matchesRunAttempt(payload, { runId, runAttempt, reviewedControlRepositoryId }) {
  const repositoryIdMatches = (repository) => repository && typeof repository === 'object' &&
    !Array.isArray(repository) && Number.isSafeInteger(repository.id) && repository.id > 0 &&
    String(repository.id) === reviewedControlRepositoryId && repository.full_name === CONTROL_REPOSITORY;
  const workflowPathAtMain = `${CONTROL_WORKFLOW_PATH}@${CONTROL_DEFAULT_BRANCH}`;
  return payload && typeof payload === 'object' && !Array.isArray(payload) &&
    Number.isSafeInteger(payload.id) && String(payload.id) === runId &&
    Number.isSafeInteger(payload.run_attempt) && String(payload.run_attempt) === runAttempt &&
    repositoryIdMatches(payload.repository) && repositoryIdMatches(payload.head_repository) &&
    payload.path === workflowPathAtMain &&
    payload.event === 'workflow_dispatch' && payload.head_branch === CONTROL_DEFAULT_BRANCH &&
    typeof payload.head_sha === 'string' && /^[a-f0-9]{40}$/u.test(payload.head_sha) &&
    payload.status === 'in_progress';
}

// Internal seam for deterministic offline tests. Production resolves the ID
// from the immutable trust policy and exposes only selector fields.
export async function readSelectedRunAttemptWithRepositoryId({ runId, runAttempt,
  reviewedControlRepositoryId, signal } = {}) {
  if (!validDecimal(runId, 16) || !validDecimal(runAttempt, 8) ||
      !validDecimal(reviewedControlRepositoryId, 20) ||
      (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean' ||
        typeof signal.addEventListener !== 'function'))) refuse();

  let requestSignal;
  try {
    const timeoutSignal = AbortSignal.timeout(RUN_LOOKUP_TIMEOUT_MS);
    requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  } catch {
    refuse();
  }
  if (requestSignal.aborted || typeof globalThis.fetch !== 'function') refuse();

  const endpoint = `${GITHUB_API_ORIGIN}/repos/${CONTROL_REPOSITORY}/actions/runs/${runId}/attempts/${runAttempt}`;
  let response;
  try {
    response = await globalThis.fetch(endpoint, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        'User-Agent': 'billing-validation-control',
      },
      redirect: 'error',
      cache: 'no-store',
      credentials: 'omit',
      signal: requestSignal,
    });
  } catch {
    refuse();
  }
  if (requestSignal.aborted || !response || response.status !== 200 || response.redirected === true) refuse();

  let payload;
  try { payload = await readBoundedJson(response); }
  catch { refuse(); }
  if (requestSignal.aborted || !matchesRunAttempt(payload, { runId, runAttempt, reviewedControlRepositoryId })) refuse();

  const ref = `refs/heads/${CONTROL_DEFAULT_BRANCH}`;
  return Object.freeze({ repository: CONTROL_REPOSITORY, repositoryId: reviewedControlRepositoryId,
    eventName: 'workflow_dispatch', defaultBranch: CONTROL_DEFAULT_BRANCH, ref,
    workflowPath: CONTROL_WORKFLOW_PATH,
    workflowRef: `${CONTROL_REPOSITORY}/${CONTROL_WORKFLOW_PATH}@${ref}`,
    runId, runAttempt, workflowSha: payload.head_sha, runnerGroup: ISOLATED_RUNNER_GROUP });
}
