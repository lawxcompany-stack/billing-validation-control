import assert from 'node:assert/strict';
import { test } from 'node:test';

const moduleUrl = new URL('../../runner/workflow-context.mjs', import.meta.url);
const workflowContext = await import(moduleUrl.href).catch(() => null);
const internalModuleUrl = new URL('../../runner/workflow-context-internal.mjs', import.meta.url);
const internalContext = await import(internalModuleUrl.href).catch(() => null);
const CONTROL_REPOSITORY = 'lawxcompany-stack/billing-validation-control';
const CONTROL_REPOSITORY_ID = '12345678';
const CONTROL_WORKFLOW_PATH = '.github/workflows/validate-billing.yml';
const RUN_ID = '123456789';
const RUN_ATTEMPT = '2';
const WORKFLOW_SHA = 'd'.repeat(40);
const SELECTORS = Object.freeze({ runId: RUN_ID, runAttempt: RUN_ATTEMPT });

function validRun(overrides = {}) {
  return {
    id: Number(RUN_ID),
    run_attempt: Number(RUN_ATTEMPT),
    repository: { id: Number(CONTROL_REPOSITORY_ID), full_name: CONTROL_REPOSITORY },
    head_repository: { id: Number(CONTROL_REPOSITORY_ID), full_name: CONTROL_REPOSITORY },
    path: `${CONTROL_WORKFLOW_PATH}@main`,
    event: 'workflow_dispatch',
    head_branch: 'main',
    head_sha: WORKFLOW_SHA,
    status: 'in_progress',
    ...overrides,
  };
}

function githubResponse(payload, status = 200, headers = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return new Response(body, { status, headers: { 'content-type': 'application/json', ...headers } });
}

async function withFetch(implementation, operation) {
  const previous = globalThis.fetch;
  globalThis.fetch = implementation;
  try { return await operation(); }
  finally { globalThis.fetch = previous; }
}

function read(selectors = SELECTORS, repositoryId = CONTROL_REPOSITORY_ID) {
  assert.ok(internalContext?.readSelectedRunAttemptWithRepositoryId,
    'The internal deterministic run-attempt reader must be implemented');
  return internalContext.readSelectedRunAttemptWithRepositoryId({ ...selectors,
    reviewedControlRepositoryId: repositoryId });
}

test('selected run-attempt lookup binds explicit selectors to the fixed control repository and API identity', async () => {
  const requests = [];
  const result = await withFetch(async (input, init) => {
    requests.push({ url: String(input), init });
    return githubResponse(validRun());
  }, () => read());

  assert.deepEqual(result, {
    repository: CONTROL_REPOSITORY,
    repositoryId: CONTROL_REPOSITORY_ID,
    eventName: 'workflow_dispatch',
    defaultBranch: 'main',
    ref: 'refs/heads/main',
    workflowPath: CONTROL_WORKFLOW_PATH,
    workflowRef: `${CONTROL_REPOSITORY}/${CONTROL_WORKFLOW_PATH}@refs/heads/main`,
    runId: RUN_ID,
    runAttempt: RUN_ATTEMPT,
    workflowSha: WORKFLOW_SHA,
    runnerGroup: 'billing-validation-isolated',
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url,
    `https://api.github.com/repos/${CONTROL_REPOSITORY}/actions/runs/${RUN_ID}/attempts/${RUN_ATTEMPT}`);
  assert.equal(requests[0].init.method, 'GET');
  assert.equal(requests[0].init.redirect, 'error');
  assert.equal(requests[0].init.cache, 'no-store');
  assert.equal(requests[0].init.credentials, 'omit');
  assert.equal(new Headers(requests[0].init.headers).has('authorization'), false);
});

test('forgeable local GITHUB_* values are not selectors or trusted identity', async () => {
  const original = Object.fromEntries(['GITHUB_REPOSITORY', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_SHA']
    .map((key) => [key, process.env[key]]));
  const requests = [];
  Object.assign(process.env, {
    GITHUB_REPOSITORY: 'attacker/repository', GITHUB_RUN_ID: '1',
    GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: 'f'.repeat(40),
  });
  try {
    const result = await withFetch(async (input) => {
      requests.push(String(input));
      return githubResponse(validRun());
    }, () => read());
    assert.equal(result.runId, RUN_ID);
    assert.equal(result.runAttempt, RUN_ATTEMPT);
    assert.equal(result.workflowSha, WORKFLOW_SHA);
    assert.equal(requests.length, 1);
    assert.ok(requests[0].endsWith(`/runs/${RUN_ID}/attempts/${RUN_ATTEMPT}`));
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('malformed run selectors and unreviewed repository IDs refuse before HTTP', async () => {
  for (const [selectors, repositoryId] of [
    [{ runId: '01', runAttempt: RUN_ATTEMPT }, CONTROL_REPOSITORY_ID],
    [{ runId: RUN_ID, runAttempt: '0' }, CONTROL_REPOSITORY_ID],
    [{ runId: '1.5', runAttempt: RUN_ATTEMPT }, CONTROL_REPOSITORY_ID],
    [SELECTORS, '0'],
  ]) {
    let requests = 0;
    await withFetch(async () => { requests += 1; return githubResponse(validRun()); }, async () => {
      await assert.rejects(read(selectors, repositoryId), { code: 'runner_workflow_context_invalid' });
    });
    assert.equal(requests, 0);
  }
});

for (const [field, mutation] of [
  ['selected run ID', (run) => ({ ...run, id: 123456788 })],
  ['selected attempt', (run) => ({ ...run, run_attempt: 1 })],
  ['repository slug', (run) => ({ ...run, repository: { ...run.repository, full_name: 'attacker/repository' } })],
  ['immutable repository ID', (run) => ({ ...run, repository: { ...run.repository, id: 87654321 } })],
  ['head repository identity', (run) => ({ ...run, head_repository: { id: 87654321, full_name: 'attacker/repository' } })],
  ['workflow path', (run) => ({ ...run, path: '.github/workflows/other.yml@main' })],
  ['event', (run) => ({ ...run, event: 'pull_request_target' })],
  ['branch', (run) => ({ ...run, head_branch: 'feature' })],
  ['malformed workflow SHA', (run) => ({ ...run, head_sha: 'not-a-full-sha' })],
  ['pending run', (run) => ({ ...run, status: 'queued' })],
  ['completed run', (run) => ({ ...run, status: 'completed' })],
]) {
  test(`selected run-attempt lookup refuses mismatched ${field}`, async () => {
    await withFetch(async () => githubResponse(mutation(validRun())), async () => {
      await assert.rejects(read(), { code: 'runner_workflow_context_invalid' });
    });
  });
}

test('selected run-attempt lookup rejects malformed, oversized, redirected and non-200 responses', async () => {
  const oversizedBody = new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(70 * 1024));
  } });
  for (const response of [
    githubResponse('{malformed'),
    new Response(oversizedBody, { status: 200, headers: { 'content-type': 'application/json' } }),
    githubResponse(validRun(), 404),
    githubResponse(validRun(), 403),
    new Response('', { status: 302, headers: { location: 'https://elsewhere.invalid/' } }),
  ]) {
    await withFetch(async () => response, async () => {
      await assert.rejects(read(), { code: 'runner_workflow_context_invalid' });
    });
  }
});

test('a well-formed but unreviewed repository ID fails against the API identity claim', async () => {
  let requests = 0;
  await withFetch(async () => {
    requests += 1;
    return githubResponse(validRun());
  }, async () => {
    await assert.rejects(read(SELECTORS, '87654321'), { code: 'runner_workflow_context_invalid' });
  });
  assert.equal(requests, 1);
});

test('production run selector API ignores caller-supplied repository ID and refuses while trust policy is unset', async () => {
  let requests = 0;
  await withFetch(async () => {
    requests += 1;
    return githubResponse(validRun());
  }, async () => {
    await assert.rejects(workflowContext.readSelectedRunAttempt({ ...SELECTORS,
      reviewedControlRepositoryId: CONTROL_REPOSITORY_ID }),
    { code: 'runner_workflow_context_invalid' });
  });
  assert.equal(requests, 0);
});
