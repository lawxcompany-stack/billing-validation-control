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

function readLocalRuntimeIdentity() {
  const environment = process.env;
  const expectedRef = `refs/heads/${CONTROL_DEFAULT_BRANCH}`;
  const expectedWorkflowRef = `${CONTROL_REPOSITORY}/${CONTROL_WORKFLOW_PATH}@${expectedRef}`;
  const runId = environment.GITHUB_RUN_ID;
  const runAttempt = environment.GITHUB_RUN_ATTEMPT;
  const sha = environment.GITHUB_SHA;
  if (environment.GITHUB_REPOSITORY !== CONTROL_REPOSITORY ||
      environment.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
      environment.GITHUB_REF !== expectedRef ||
      environment.GITHUB_WORKFLOW_REF !== expectedWorkflowRef ||
      environment.GITHUB_REF_PROTECTED !== 'true' ||
      typeof runId !== 'string' || !/^[1-9][0-9]{0,15}$/u.test(runId) ||
      !Number.isSafeInteger(Number(runId)) ||
      typeof runAttempt !== 'string' || !/^[1-9][0-9]{0,8}$/u.test(runAttempt) ||
      typeof sha !== 'string' || !/^[a-f0-9]{40}$/u.test(sha)) {
    refuse();
  }
  return { runId, runAttempt, sha };
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

function matchesRunAttempt(payload, { runId, runAttempt, sha }) {
  const workflowPathAtMain = `${CONTROL_WORKFLOW_PATH}@${CONTROL_DEFAULT_BRANCH}`;
  return payload && typeof payload === 'object' && !Array.isArray(payload) &&
    Number.isSafeInteger(payload.id) && String(payload.id) === runId &&
    Number.isSafeInteger(payload.run_attempt) && String(payload.run_attempt) === runAttempt &&
    payload.repository?.full_name === CONTROL_REPOSITORY &&
    payload.path === workflowPathAtMain &&
    payload.event === 'workflow_dispatch' && payload.head_branch === CONTROL_DEFAULT_BRANCH &&
    typeof payload.head_sha === 'string' && /^[a-f0-9]{40}$/u.test(payload.head_sha) &&
    payload.head_sha === sha && payload.status === 'in_progress';
}

export async function readTrustedRunnerWorkflowContext(signal) {
  const identity = readLocalRuntimeIdentity();
  const expectedRef = `refs/heads/${CONTROL_DEFAULT_BRANCH}`;
  const expectedWorkflowRef = `${CONTROL_REPOSITORY}/${CONTROL_WORKFLOW_PATH}@${expectedRef}`;
  if (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function')) refuse();

  let requestSignal;
  try {
    const timeoutSignal = AbortSignal.timeout(RUN_LOOKUP_TIMEOUT_MS);
    requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  } catch {
    refuse();
  }
  if (requestSignal.aborted || typeof globalThis.fetch !== 'function') refuse();

  const endpoint = `${GITHUB_API_ORIGIN}/repos/${CONTROL_REPOSITORY}/actions/runs/${identity.runId}/attempts/${identity.runAttempt}`;
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
  if (requestSignal.aborted || !matchesRunAttempt(payload, identity)) refuse();

  return Object.freeze({ repository: CONTROL_REPOSITORY, eventName: 'workflow_dispatch',
    defaultBranch: CONTROL_DEFAULT_BRANCH, ref: expectedRef, workflowRef: expectedWorkflowRef,
    runnerGroup: ISOLATED_RUNNER_GROUP });
}
