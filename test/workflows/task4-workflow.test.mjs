import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import YAML from 'yaml';
import { parseDispatch } from '../../src/contracts/dispatch.mjs';
import { resolveCandidate } from '../../src/github/candidate.mjs';
import { readCandidatePrerequisites } from '../../src/github/candidate-reader.mjs';

const workflow = YAML.parse(readFileSync('.github/workflows/validate-billing.yml', 'utf8'));
const repository = 'lawx-ai/billing-validation-control';
const candidateRepository = 'lawxcompany-stack/Plataforma-LawX';
const environments = ['billing-validation-reader', 'billing-validation-attestation',
  'billing-validation-tests', 'billing-validation-publisher', 'billing-validation-control'];
const recheckEnvironments = environments.filter(name => name !== 'billing-validation-control');
const github = { event_name: 'workflow_dispatch', repository, repository_id: '1384018279',
  ref: 'refs/heads/main', ref_protected: true, event: { repository: { default_branch: 'main' } } };
const needs = { authorize: { result: 'success', outputs: { operation: 'collect', environments_verified: 'true' } },
  reader: { result: 'success' }, 'attest-activation': { result: 'success' },
  'control-store': { result: 'success' }, test: { result: 'success' },
  'validate-result-input': { result: 'success' }, 'attest-result': { result: 'success' },
  'verify-result': { result: 'success' } };

for (const [id, job] of Object.entries(workflow.jobs).filter(([, job]) => job.if.includes('workflow_dispatch'))) {
  test(`${id} dispatch guard pins the transferred control repository and stable ID`, () => {
    assert.match(job.if, /github\.repository\s*==\s*'lawx-ai\/billing-validation-control'/u);
    assert.match(job.if, /github\.repository_id\s*==\s*'1384018279'/u);
    assert.equal(eligible(id), true);
    assert.equal(eligible(id, { ...github, repository: 'lawxcompany-stack/billing-validation-control' }), false);
  });
}

function eligible(jobId, context = github, dependencies = needs, cancelled = false) {
  const expression = workflow.jobs[jobId].if.slice(3, -2)
    .replaceAll('needs.attest-activation', 'needs["attest-activation"]')
    .replaceAll('needs.control-store', 'needs["control-store"]')
    .replaceAll('needs.validate-result-input', 'needs["validate-result-input"]')
    .replaceAll('needs.attest-result', 'needs["attest-result"]')
    .replaceAll('needs.verify-result', 'needs["verify-result"]');
  return vm.runInNewContext(expression, { github: context, needs: dependencies,
    always: () => true, cancelled: () => cancelled });
}

test('PR policy is hosted, has no Environment/secrets and keeps a read-only token', () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ['pull_request', 'workflow_dispatch']);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(workflow.jobs.policy.environment, undefined);
  assert.equal(workflow.jobs.policy['runs-on'], 'ubuntu-latest');
  assert.deepEqual(workflow.jobs.policy.permissions ?? workflow.permissions, { contents: 'read' });
  assert.doesNotMatch(JSON.stringify(workflow.jobs.policy), /\bsecrets\b|id-token|attestations|STRIPE|SUPABASE/);
  for (const id of ['authorize', 'reader', 'attest-activation', 'control-store', 'test', 'validate-result-input', 'attest-result', 'verify-result', 'publisher']) {
    assert.equal(eligible(id, { ...github, event_name: 'pull_request' }), false, id);
  }
});

for (const [name, change] of [
  ['foreign repository', { repository: 'attacker/control' }],
  ['recreated repository', { repository_id: '999' }],
  ['untrusted ref', { ref: 'refs/heads/feature' }],
  ['main tag', { ref: 'refs/tags/main' }],
  ['unprotected ref', { ref_protected: false }],
  ['another default branch', { event: { repository: { default_branch: 'preview' } } }],
]) test(`all dispatch/protected jobs refuse ${name} before scheduling`, () => {
  for (const id of ['authorize', 'reader', 'attest-activation', 'control-store', 'test', 'validate-result-input', 'attest-result', 'verify-result', 'publisher']) {
    assert.equal(eligible(id, { ...github, ...change }), false, id);
  }
});

test('only the secret-free hosted authorization job can read Environment configuration', () => {
  assert.deepEqual(workflow.jobs.authorize.permissions, { contents: 'read', actions: 'read' });
  assert.equal(workflow.jobs.authorize.environment, undefined);
  assert.equal(workflow.jobs.authorize['runs-on'], 'ubuntu-latest');
  assert.doesNotMatch(JSON.stringify(workflow.jobs.authorize), /\$\{\{[^}]*\bsecrets\b/u);
  assert.equal(workflow.jobs.authorize['continue-on-error'], undefined);
  for (const [id, job] of Object.entries(workflow.jobs)) {
    if (id !== 'authorize') assert.equal(job.permissions?.actions, undefined, id);
  }
});

for (const result of ['failure', 'cancelled', 'skipped']) {
  test(`authorization ${result} blocks every Environment job`, () => {
    const dependencies = structuredClone(needs);
    dependencies.authorize.result = result;
    for (const id of ['reader', 'attest-activation', 'control-store', 'test', 'validate-result-input', 'attest-result', 'verify-result', 'publisher']) {
      assert.equal(eligible(id, github, dependencies), false, id);
    }
  });
  test(`reader ${result} blocks signing, financial execution and publication`, () => {
    const dependencies = structuredClone(needs);
    dependencies.reader.result = result;
    for (const id of ['attest-activation', 'test', 'validate-result-input', 'attest-result', 'verify-result', 'publisher']) {
      assert.equal(eligible(id, github, dependencies), false, id);
    }
  });
  test(`collect attestation ${result} blocks financial execution and publication`, () => {
    const dependencies = structuredClone(needs);
    dependencies['attest-activation'].result = result;
    dependencies.test.result = 'skipped';
    for (const id of ['test', 'validate-result-input', 'attest-result', 'verify-result', 'publisher']) assert.equal(eligible(id, github, dependencies), false, id);
  });
  test(`financial ${result} blocks publication`, () => {
    const dependencies = structuredClone(needs);
    dependencies.test.result = result;
    assert.equal(eligible('attest-result', github, dependencies), false);
    assert.equal(eligible('validate-result-input', github, dependencies), false);
    assert.equal(eligible('verify-result', github, dependencies), false);
    assert.equal(eligible('publisher', github, dependencies), false);
  });
}

test('a result-schema failure blocks the credentialed emitter and publisher before their environments', () => {
  const dependencies = structuredClone(needs);
  dependencies['validate-result-input'].result = 'failure';
  dependencies['attest-result'].result = 'skipped';
  dependencies['verify-result'].result = 'skipped';
  assert.equal(eligible('attest-result', github, dependencies), false);
  assert.equal(eligible('verify-result', github, dependencies), false);
  assert.equal(eligible('publisher', github, dependencies), false);
  assert.equal(workflow.jobs['validate-result-input'].environment, undefined);
  assert.equal(workflow.jobs['validate-result-input'].permissions['id-token'], undefined);
});

test('Environment readback must explicitly succeed before any Environment job', () => {
  assert.equal(workflow.jobs.authorize.outputs.environments_verified, '${{ steps.environments.outputs.verified }}');
  assert.equal(workflow.jobs.test.environment, 'billing-validation-tests');
  assert.equal(workflow.jobs.test.env.BILLING_VALIDATION_APPROVAL_ENVIRONMENT,
    workflow.jobs.test.environment);
  for (const value of ['', 'false', undefined]) {
    const dependencies = structuredClone(needs);
    dependencies.authorize.outputs.environments_verified = value;
    for (const id of ['reader', 'attest-activation', 'control-store', 'test', 'validate-result-input', 'attest-result', 'verify-result', 'publisher']) {
      assert.equal(eligible(id, github, dependencies), false, id);
    }
  }
  for (const id of ['reader', 'attest-activation', 'control-store', 'test', 'validate-result-input', 'attest-result', 'verify-result', 'publisher']) assert.equal(eligible(id), true, id);
  assert.deepEqual(workflow.jobs.publisher.needs, ['authorize', 'reader', 'attest-activation', 'test', 'attest-result', 'verify-result']);
});

test('control-store success gates collect while failure or skip blocks it', () => {
  assert.equal(eligible('control-store'), true);
  assert.equal(eligible('test'), true);
  for (const result of ['failure', 'cancelled', 'skipped']) {
    const dependencies = structuredClone(needs);
    dependencies['control-store'].result = result;
    assert.equal(eligible('test', github, dependencies), false, result);
  }
});

test('recheck may run its test gate but cannot reach publisher without result attestation', () => {
  const dependencies = structuredClone(needs);
  dependencies.authorize.outputs.operation = 'recheck';
  dependencies['attest-activation'].result = 'skipped';
  dependencies['control-store'].result = 'skipped';
  dependencies['validate-result-input'].result = 'skipped';
  dependencies['attest-result'].result = 'skipped';
  dependencies['verify-result'].result = 'skipped';
  assert.equal(eligible('attest-activation', github, dependencies), false);
  assert.equal(eligible('control-store', github, dependencies), false);
  assert.equal(eligible('attest-result', github, dependencies), false);
  assert.equal(eligible('validate-result-input', github, dependencies), false);
  assert.equal(eligible('verify-result', github, dependencies), false);
  assert.equal(eligible('test', github, dependencies), true);
  assert.equal(eligible('test', github, { ...dependencies, 'attest-activation': { result: 'failure' } }), false);
  assert.equal(eligible('publisher', github, dependencies), false);
  assert.equal(eligible('publisher', github, { ...dependencies, 'attest-result': { result: 'failure' } }), false);
  assert.equal(eligible('publisher', github, { ...dependencies, 'verify-result': { result: 'failure' } }), false);
  assert.match(readFileSync('.github/workflows/validate-billing.yml', 'utf8'),
    /Recheck deliberately remains fail-closed until the original run\/attempt result attestation can be retrieved and identity-verified; activation attestation never proves financial quality\./u);
});

test('workflow cancellation blocks financial execution and publication even after successful predecessors', () => {
  for (const id of ['test', 'validate-result-input', 'attest-result', 'verify-result', 'publisher']) assert.equal(eligible(id, github, needs, true), false, id);
});

test('trusted jobs never checkout or execute candidate inputs and keep shell expressions out of run blocks', () => {
  for (const [id, job] of Object.entries(workflow.jobs)) {
    if (id === 'policy') continue;
    for (const step of job.steps) {
      if (step.uses?.startsWith('actions/checkout@')) {
        assert.deepEqual(step.with, { ref: '${{ github.sha }}', 'persist-credentials': false }, id);
      }
      if (step.run) {
        assert.doesNotMatch(step.run, /\$\{\{/u, id);
        assert.doesNotMatch(step.run, /\b(?:eval|exec|spawn|require)\s*\(|import\s*\(\s*process\.env/u, id);
      }
    }
  }
});

const dispatchContext = { repository, repositoryId: github.repository_id,
  ref: github.ref, defaultBranch: 'main', refProtected: true };
const sha = 'a'.repeat(40);
const input = { operation: 'collect', candidate_repository: candidateRepository, candidate_sha: sha,
  source_run_id: '', source_run_attempt: '', runner_label: `billing-validation-${'b'.repeat(32)}`,
  supervisor_activation: 'c'.repeat(64) };

function runtimeControlEnv(step, context = github) {
  return Object.fromEntries(Object.entries(step.env).filter(([key]) => key.startsWith('CONTROL_'))
    .map(([key, expression]) => [key, String(vm.runInNewContext(expression.slice(3, -2), { github: context }))]));
}

test('inline dispatch parser receives the runtime repository ID and refuses absent or foreign IDs', () => {
  const step = workflow.jobs.authorize.steps.find(step => step.id === 'authorize');
  assert.equal(step.env.CONTROL_REPOSITORY_ID, '${{ github.repository_id }}');
  const source = step.run.match(/<<'NODE'\n([\s\S]*?)\nNODE\n?$/u)?.[1]
    .replace(/^import .*;\n/gmu, '');
  assert.ok(source);
  for (const repositoryId of ['1384018279', undefined, '999']) {
    const env = { ...runtimeControlEnv(step), DISPATCH_INPUTS: JSON.stringify(input), GITHUB_OUTPUT: 'output' };
    if (repositoryId === undefined) delete env.CONTROL_REPOSITORY_ID;
    else env.CONTROL_REPOSITORY_ID = repositoryId;
    const processFixture = { env, exitCode: 0 }, receipts = [], errors = [];
    vm.runInNewContext(source, { process: processFixture, parseDispatch,
      appendFileSync: (path, text) => { assert.equal(path, 'output'); receipts.push(text); },
      console: { log() {}, error: text => errors.push(text) } });
    assert.equal(processFixture.exitCode, repositoryId === '1384018279' ? 0 : 1);
    assert.deepEqual(receipts, repositoryId === '1384018279'
      ? [`operation=collect\ncandidate_sha=${sha}\nrunner_label=${input.runner_label}\nactivation_commitment=${input.supervisor_activation}\n`] : []);
    assert.deepEqual(errors, repositoryId === '1384018279' ? [] : ['Dispatch refused (control_repository_not_allowed).']);
  }
});

test('candidate reader receives the runtime repository ID before any candidate API access', async () => {
  const step = workflow.jobs.reader.steps.find(step => step.id === 'candidate');
  assert.equal(step.env.CONTROL_REPOSITORY_ID, '${{ github.repository_id }}');
  const env = runtimeControlEnv(step);
  const context = { repository: env.CONTROL_REPOSITORY, repositoryId: env.CONTROL_REPOSITORY_ID,
    ref: env.CONTROL_REF, defaultBranch: env.CONTROL_DEFAULT_BRANCH,
    refProtected: env.CONTROL_REF_PROTECTED === 'true', eventName: env.CONTROL_EVENT_NAME };
  for (const repositoryId of [context.repositoryId, undefined, '999']) {
    const calls = [];
    await assert.rejects(readCandidatePrerequisites({ candidateSha: sha, context: { ...context, repositoryId },
      api: { async get(path) { calls.push(path); return []; } } }),
    { code: repositoryId === '1384018279' ? 'candidate_pr_not_found' : 'control_repository_not_allowed' });
    assert.deepEqual(calls, repositoryId === '1384018279'
      ? [`/repos/${candidateRepository}/commits/${sha}/pulls?per_page=100&page=1`] : []);
  }
});
test('candidate IDs remain validated data, including shell-injection spellings', () => {
  assert.equal(parseDispatch(input, dispatchContext).candidateSha, sha);
  for (const value of ['$(touch /tmp/task4)', '`id`', 'a\noperation=recheck', sha + ';id']) {
    assert.throws(() => parseDispatch({ ...input, candidate_sha: value }, dispatchContext));
    assert.throws(() => parseDispatch({ ...input, candidate_repository: value }, dispatchContext));
  }
});

for (const [name, pull, code] of [
  ['closed pull request', { state: 'closed', head: { sha } }, 'candidate_pr_not_found'],
  ['head SHA mismatch', { state: 'open', head: { sha: 'f'.repeat(40) } }, 'candidate_head_not_current'],
]) test(`rejected ${name} proof makes the reader fail before scheduling attestation or finance`, async () => {
  const calls = [];
  const api = { async get(path) {
    calls.push(path);
    return [{ number: 140, state: pull.state,
      head: { ...pull.head, repo: { full_name: candidateRepository, id: 1234079266 } },
      base: { ref: 'preview', sha: 'd'.repeat(40), repo: { full_name: candidateRepository, id: 1234079266 } } }];
  } };
  await assert.rejects(readCandidatePrerequisites({ api, candidateSha: sha,
    context: { ...dispatchContext, eventName: 'workflow_dispatch' } }), { code });
  assert.deepEqual(calls, [`/repos/${candidateRepository}/commits/${sha}/pulls?per_page=100&page=1`]);

  const blocked = structuredClone(needs);
  blocked.reader.result = 'failure';
  for (const job of ['attest-activation', 'test', 'validate-result-input', 'attest-result', 'verify-result', 'publisher']) {
    assert.equal(eligible(job, github, blocked), false, `${name}: ${job}`);
  }
});

for (const [name, change, code] of [
  ['closed PR', { state: 'closed' }, 'candidate_pr_not_found'],
  ['stale SHA', { head: { sha: 'f'.repeat(40), repo: { full_name: candidateRepository, id: 1234079266 } } }, 'candidate_head_not_current'],
]) test(`read-only candidate resolution blocks ${name} before reading candidate content`, async () => {
  const calls = [];
  const api = { async get(path) {
    calls.push(path);
    return [{ number: 140, state: 'open',
      head: { sha, repo: { full_name: candidateRepository, id: 1234079266 } },
      base: { ref: 'preview', sha: 'd'.repeat(40), repo: { full_name: candidateRepository, id: 1234079266 } }, ...change }];
  } };
  await assert.rejects(resolveCandidate({ api, candidateSha: sha }), { code });
  assert.deepEqual(calls, [`/repos/${candidateRepository}/commits/${sha}/pulls?per_page=100&page=1`]);
});

function environment(name) {
  const url = `https://api.github.com/repos/${repository}/environments/${name}`;
  return { id: 161088068, node_id: 'environment-node', name, url,
    html_url: `https://github.com/${repository}/deployments/activity_log?environments_filter=${name}`,
    created_at: '2020-11-23T22:00:40Z', updated_at: '2026-10-01T00:00:00Z',
    protection_rules: [
      { id: 3755, node_id: 'review-rule', type: 'required_reviewers', prevent_self_review: true,
        reviewers: [{ type: 'User', reviewer: { id: 42, login: 'synthetic-reviewer', type: 'User' } }] },
      { id: 3756, node_id: 'branch-rule', type: 'branch_policy' },
    ], deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } };
}

async function runPreflight({ transform = value => value, respond, env = {}, operation = 'collect',
  expire = false, clock = performance } = {}) {
  const step = workflow.jobs.authorize.steps.find(step => step.id === 'environments');
  assert.ok(step, 'Missing fail-closed Environment preflight');
  assert.equal(step.if, undefined);
  assert.equal(step['continue-on-error'], undefined);
  let source = /^node --input-type=module <<'NODE'\n([\s\S]*)\nNODE\n?$/.exec(step.run)?.[1];
  assert.ok(source, 'Environment preflight must be an executable fixed Node heredoc');
  // Keep the production body intact; isolate only its fixed filesystem import.
  assert.match(source, /^import \{ appendFileSync \} from 'node:fs';\n/u);
  source = source.replace(/^import \{ appendFileSync \} from 'node:fs';\n/u, '');
  const calls = [], output = [], errors = [], receipts = [];
  const processFixture = { env: { CONTROL_REPOSITORY: repository, CONTROL_REPOSITORY_ID: github.repository_id,
    CONTROL_REF: github.ref, CONTROL_DEFAULT_BRANCH: 'main', CONTROL_REF_PROTECTED: 'true',
    CONTROL_EVENT_NAME: 'workflow_dispatch', CONTROL_DISPATCH_OPERATION: operation,
    ENVIRONMENT_READ_TOKEN: 'synthetic-token',
    GITHUB_OUTPUT: 'synthetic-output', ...env }, exitCode: 0 };
  const fetch = async (url, options) => {
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    assert.ok(options.signal instanceof AbortSignal);
    const base = `https://api.github.com/repos/${repository}/environments/`;
    assert.ok(url.startsWith(base));
    const suffix = url.slice(base.length);
    const name = suffix.split('/')[0];
    const requiredForOperation = processFixture.env.CONTROL_DISPATCH_OPERATION === 'collect'
      ? environments : recheckEnvironments;
    assert.ok(requiredForOperation.includes(name));
    assert.ok(suffix === name || suffix === `${name}/deployment-branch-policies?per_page=100&page=1`);
    calls.push(url);
    if (respond) return respond(url, options);
    return Response.json(suffix === name ? transform(environment(name)) : {
      // Documented list response; it does not prove branch-vs-tag type.
      total_count: 1, branch_policies: [{ id: 11, node_id: 'branch-node', name: 'main' }],
    });
  };
  const context = { process: processFixture, fetch, AbortController, TextDecoder, Uint8Array,
    appendFileSync: (path, text) => { assert.equal(path, 'synthetic-output'); receipts.push(text); },
    performance: clock, setTimeout: expire ? fn => setTimeout(fn, 1) : setTimeout, clearTimeout,
    console: { log: line => output.push(line), error: line => errors.push(line) } };
  await vm.runInNewContext(`(async () => {${source}\n})()`, context, { timeout: 1000 });
  if (processFixture.exitCode === 0) assert.deepEqual(receipts, ['verified=true\n']);
  else assert.deepEqual(receipts, [], 'a refusal must never publish a success receipt');
  return { code: processFixture.exitCode, calls, output, errors };
}

test('preflight accepts protected-only Environments for exact protected main without listing custom rules', async () => {
  const result = await runPreflight();
  assert.equal(result.code, 0);
  assert.deepEqual(result.calls, environments.map(name => `https://api.github.com/repos/${repository}/environments/${name}`));
  assert.deepEqual(result.output, ['Environment protection verified for all required jobs.']);
  assert.deepEqual(result.errors, []);
});

test('collect preflights the control Environment while recheck does not', async () => {
  const collect = await runPreflight({ operation: 'collect' });
  const recheck = await runPreflight({ operation: 'recheck' });
  assert.equal(collect.code, 0);
  assert.deepEqual(collect.calls, environments.map(name =>
    `https://api.github.com/repos/${repository}/environments/${name}`));
  assert.equal(recheck.code, 0);
  assert.deepEqual(recheck.calls, recheckEnvironments.map(name =>
    `https://api.github.com/repos/${repository}/environments/${name}`));
  assert.equal(recheck.calls.some(url => url.endsWith('/billing-validation-control')), false);
});

for (const [name, transform] of [
  ['absent reviewer rule', value => ({ ...value, protection_rules: value.protection_rules.slice(1) })],
  ['empty reviewers', value => { value.protection_rules[0].reviewers = []; return value; }],
  ['self-review allowed', value => { value.protection_rules[0].prevent_self_review = false; return value; }],
  ['missing self-review flag', value => { delete value.protection_rules[0].prevent_self_review; return value; }],
  ['malformed reviewer', value => { value.protection_rules[0].reviewers[0].reviewer.id = '42'; return value; }],
  ['invalid reviewer type', value => { value.protection_rules[0].reviewers[0].type = 'Bot'; return value; }],
  ['duplicate reviewer rules', value => { value.protection_rules.push(value.protection_rules[0]); return value; }],
  ['duplicate reviewers', value => { value.protection_rules[0].reviewers.push(value.protection_rules[0].reviewers[0]); return value; }],
  ['wrong Environment name', value => ({ ...value, name: 'production' })],
  ['wrong Environment URL', value => ({ ...value, url: 'https://api.github.com/repos/attacker/control/environments/foo' })],
  ['missing rules', value => { delete value.protection_rules; return value; }],
  ['unrestricted branches', value => ({ ...value, deployment_branch_policy: null })],
  ['conflicting branch mode', value => ({ ...value, deployment_branch_policy: { protected_branches: true, custom_branch_policies: true } })],
  ['both branch flags false', value => ({ ...value, deployment_branch_policy: { protected_branches: false, custom_branch_policies: false } })],
  ['missing protected flag', value => ({ ...value, deployment_branch_policy: { custom_branch_policies: false } })],
  ['missing custom flag', value => ({ ...value, deployment_branch_policy: { protected_branches: true } })],
  ['nonboolean protected flag', value => ({ ...value, deployment_branch_policy: { protected_branches: 'true', custom_branch_policies: false } })],
  ['nonboolean custom flag', value => ({ ...value, deployment_branch_policy: { protected_branches: true, custom_branch_policies: 0 } })],
  ['array branch policy', value => ({ ...value, deployment_branch_policy: [] })],
]) test(`preflight refuses ${name} with sanitized output`, async () => {
  const result = await runPreflight({ transform });
  assert.equal(result.code, 1);
  assert.deepEqual(result.output, []);
  assert.deepEqual(result.errors, ['Environment protection preflight refused.']);
});

test('one unprotected later Environment blocks the entire dispatch', async () => {
  for (const name of environments) {
    const result = await runPreflight({ transform: value => value.name === name ? { ...value, protection_rules: [] } : value });
    assert.equal(result.code, 1, name);
    assert.deepEqual(result.output, []);
  }
});

test('preflight accepts a documented Team reviewer and protected-branch mode', async () => {
  const result = await runPreflight({ transform: value => {
    value.protection_rules[0].reviewers = [{ type: 'Team', reviewer: { id: 10, slug: 'synthetic-reviewers' } }];
    value.deployment_branch_policy = { protected_branches: true, custom_branch_policies: false };
    return value;
  } });
  assert.equal(result.code, 0);
  assert.equal(result.calls.length, 5);
});

for (const [name, list] of [
  ['documented main list without type', { total_count: 1, branch_policies: [{ id: 11, node_id: 'branch-node', name: 'main' }] }],
  ['main with injected branch type', { total_count: 1, branch_policies: [{ id: 11, node_id: 'branch-node', name: 'main', type: 'branch' }] }],
  ['main tag', { total_count: 1, branch_policies: [{ id: 11, node_id: 'tag-node', name: 'main', type: 'tag' }] }],
  ['wildcard', { total_count: 1, branch_policies: [{ id: 11, node_id: 'branch-node', name: '*' }] }],
  ['broad pattern', { total_count: 1, branch_policies: [{ id: 11, node_id: 'branch-node', name: 'release/*' }] }],
  ['malformed list', null],
]) test(`custom policy refuses ${name} before attempting a rule-list read`, async () => {
  const result = await runPreflight({ respond: async url => {
    if (url.includes('/deployment-branch-policies?')) return Response.json(list);
    const value = environment(url.split('/').at(-1));
    value.deployment_branch_policy = { protected_branches: false, custom_branch_policies: true };
    return Response.json(value);
  } });
  assert.equal(result.code, 1);
  assert.deepEqual(result.output, []);
  assert.deepEqual(result.errors, ['Environment protection preflight refused.']);
  assert.deepEqual(result.calls, [`https://api.github.com/repos/${repository}/environments/billing-validation-reader`]);
});

for (const [name, respond] of [
  ['HTTP 403', async () => new Response('private-upstream-body', { status: 403 })],
  ['HTTP 404', async () => new Response('private-upstream-body', { status: 404 })],
  ['redirect', async () => ({ ok: true, status: 200, redirected: true })],
  ['invalid JSON', async () => new Response('{private-upstream-body')],
  ['null JSON', async () => Response.json(null)],
  ['oversized body', async () => new Response('x'.repeat(65537))],
  ['unavailable readback', async () => { throw new Error('private-upstream-body synthetic-token'); }],
]) test(`preflight fails closed on ${name}`, async () => {
  const result = await runPreflight({ respond });
  assert.equal(result.code, 1);
  assert.deepEqual(result.output, []);
  assert.deepEqual(result.errors, ['Environment protection preflight refused.']);
});

test('a stalled readback times out instead of authorizing later jobs', async () => {
  const result = await runPreflight({ respond: () => new Promise(() => {}), expire: true });
  assert.equal(result.code, 1);
  assert.deepEqual(result.output, []);
});

test('unacknowledged body cancellation cannot prevent a timeout refusal', async () => {
  const stalled = new Promise(() => {});
  const result = await Promise.race([
    runPreflight({ respond: async () => ({ ok: true, status: 200, redirected: false,
      body: { getReader: () => ({ read: () => stalled, cancel: () => stalled }) } }), expire: true }),
    new Promise(resolve => setTimeout(() => resolve('cleanup_stalled'), 100)),
  ]);
  assert.notEqual(result, 'cleanup_stalled');
  assert.equal(result.code, 1);
  assert.deepEqual(result.output, []);
});

test('elapsed readback deadline is checked while consuming the body', async () => {
  let now = 0;
  const result = await runPreflight({ clock: { now: () => { now += 6000; return now; } } });
  assert.equal(result.code, 1);
  assert.deepEqual(result.output, []);
});

for (const change of [{ CONTROL_REPOSITORY: 'attacker/control' }, { CONTROL_REPOSITORY_ID: '9' },
  { CONTROL_REF: 'refs/heads/feature' }, { CONTROL_REF: 'refs/tags/main' }, { CONTROL_REF_PROTECTED: 'false' },
  { CONTROL_DEFAULT_BRANCH: 'preview' }, { CONTROL_EVENT_NAME: 'pull_request' },
  { CONTROL_DISPATCH_OPERATION: '' }, { CONTROL_DISPATCH_OPERATION: 'unknown' },
  { ENVIRONMENT_READ_TOKEN: '' }]) test(`preflight refuses invalid ${Object.keys(change)[0]} before API use`, async () => {
  const result = await runPreflight({ env: change });
  assert.equal(result.code, 1);
  assert.deepEqual(result.calls, []);
});
