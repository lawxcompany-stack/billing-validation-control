import assert from 'node:assert/strict';
import { test } from 'node:test';

const dispatchUrl = new URL('../../src/contracts/dispatch.mjs', import.meta.url);
const dispatchContract = await import(dispatchUrl.href).catch((error) => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return null;
  throw error;
});

const parseDispatch = (...args) => {
  assert.ok(dispatchContract, 'The trusted dispatch contract has not been implemented');
  return dispatchContract.parseDispatch(...args);
};

const context = Object.freeze({
  ref: 'refs/heads/main',
  defaultBranch: 'main',
  repository: 'lawxcompany-stack/billing-validation-control',
});

const sha = 'a'.repeat(40);
const collectInput = Object.freeze({
  operation: 'collect',
  candidate_repository: 'lawxcompany-stack/Plataforma-LawX',
  candidate_sha: sha,
  source_run_id: '',
  source_run_attempt: '',
  runner_label: `billing-validation-${'b'.repeat(32)}`,
});

const recheckInput = Object.freeze({
  operation: 'recheck',
  candidate_repository: 'lawxcompany-stack/Plataforma-LawX',
  candidate_sha: sha,
  source_run_id: '1234567890',
  source_run_attempt: '2',
  runner_label: '',
});

test('accepts a trusted collect identity with a per-attempt runner label', () => {
  const identity = parseDispatch(collectInput, context);

  assert.equal(identity.operation, 'collect');
  assert.equal(identity.candidateRepository, 'lawxcompany-stack/Plataforma-LawX');
  assert.equal(identity.candidateSha, sha);
  assert.equal(identity.runnerLabel, collectInput.runner_label);
  assert.ok(Object.isFrozen(identity));
});

test('accepts a recheck identity with canonical source run identifiers and no runner label', () => {
  const identity = parseDispatch(recheckInput, context);

  assert.equal(identity.operation, 'recheck');
  assert.equal(identity.sourceRunId, '1234567890');
  assert.equal(identity.sourceRunAttempt, 2);
  assert.equal(identity.runnerLabel, null);
});

test('refuses a dispatch from a non-default control ref before returning an identity', () => {
  assert.throws(
    () => parseDispatch(collectInput, { ...context, ref: 'refs/heads/untrusted' }),
    { code: 'protected_ref_required' },
  );
});

test('returns a finite refusal for a malformed workflow context', () => {
  assert.throws(
    () => dispatchContract.assertProtectedDefaultRef(null),
    { code: 'malformed_control_context' },
  );
});

test('refuses abbreviated candidate SHAs', () => {
  assert.throws(
    () => parseDispatch({ ...collectInput, candidate_sha: 'a1b2c3d4' }, context),
    { code: 'full_candidate_sha_required' },
  );
});

test('refuses candidate identities from a foreign repository', () => {
  assert.throws(
    () => parseDispatch({ ...collectInput, candidate_repository: 'attacker/Plataforma-LawX' }, context),
    { code: 'candidate_repository_not_allowed' },
  );
});

test('refuses unsupported operations', () => {
  assert.throws(
    () => parseDispatch({ ...collectInput, operation: 'approve' }, context),
    { code: 'unsupported_operation' },
  );
});

test('refuses malformed source run IDs and attempts for recheck', () => {
  assert.throws(
    () => parseDispatch({ ...recheckInput, source_run_id: '12abc' }, context),
    { code: 'malformed_source_run_id' },
  );
  assert.throws(
    () => parseDispatch({ ...recheckInput, source_run_attempt: '0' }, context),
    { code: 'malformed_source_run_attempt' },
  );
});

test('collect refuses absent or null recheck-only run selectors', () => {
  assert.throws(
    () => parseDispatch({ ...collectInput, source_run_id: undefined }, context),
    { code: 'source_run_not_allowed_for_collect' },
  );
  assert.throws(
    () => parseDispatch({ ...collectInput, source_run_attempt: null }, context),
    { code: 'source_run_not_allowed_for_collect' },
  );
});

test('refuses candidate-controlled refs as dispatch selectors', () => {
  assert.throws(
    () => parseDispatch({ ...collectInput, candidate_ref: 'refs/heads/preview' }, context),
    { code: 'candidate_ref_forbidden' },
  );
});

test('refuses missing or shared runner labels for collect and any runner label for recheck', () => {
  assert.throws(
    () => parseDispatch({ ...collectInput, runner_label: '' }, context),
    { code: 'per_attempt_runner_label_required' },
  );
  assert.throws(
    () => parseDispatch({ ...collectInput, runner_label: 'billing-validation-runner' }, context),
    { code: 'per_attempt_runner_label_required' },
  );
  assert.throws(
    () => parseDispatch({ ...recheckInput, runner_label: collectInput.runner_label }, context),
    { code: 'runner_label_not_allowed_for_recheck' },
  );
});
