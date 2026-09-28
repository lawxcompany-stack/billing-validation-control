import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importIfMissing, needExport } from '../billing/support.mjs';

const protocol = await importIfMissing(() => import('../../src/operator/protocol.mjs'));
const parse = (...args) => needExport(protocol, 'parseOperatorSignal')(...args);

const candidateSha = 'a'.repeat(40);
const nonce = Buffer.alloc(32, 0xb).toString('hex');

function binding(overrides = {}) {
  return Object.freeze({ attemptId: 'attempt-operator-1', fence: 'fence-operator-1',
    caseId: 'initial.challenge.success', paymentIntentId: 'pi_operator1', ...overrides });
}

function signal(overrides = {}) {
  return { version: 1, type: 'complete', candidateSha, attemptId: 'attempt-operator-1',
    caseId: 'initial.challenge.success', nonce, ...overrides };
}

test('challenge completion is a bound signal with no payment or authentication result', () => {
  const parsed = parse(signal(), { binding: binding(), candidateSha, nonce, kind: 'challenge' });

  assert.equal(parsed.type, 'complete');
  assert.equal(parsed.caseId, binding().caseId);
  assert.equal(parsed.attemptId, binding().attemptId);
  assert.equal(parsed.candidateSha, candidateSha);
  assert.equal(parsed.nonce, nonce);
  assert.ok(Object.isFrozen(parsed));
});

test('operator input cannot carry pass, failure, payment, challenge, or delivery outcomes', () => {
  for (const field of ['passed', 'failure', 'paymentStatus', 'challengeResult', 'webhookDeliveryResult']) {
    assert.throws(() => parse(signal({ [field]: true }), {
      binding: binding(), candidateSha, nonce, kind: 'challenge' }), { code: 'operator_signal_schema_invalid' });
  }
});

test('operator bindings reject extra mutable or outcome-bearing fields', () => {
  for (const field of ['passed', 'paymentStatus', 'providerPayload']) {
    assert.throws(() => parse(signal(), { binding: binding({ [field]: 'untrusted' }),
      candidateSha, nonce, kind: 'challenge' }), { code: 'operator_binding_invalid' });
  }
});

test('a signal bound to another candidate SHA or attempt is refused', () => {
  assert.throws(() => parse(signal({ candidateSha: 'c'.repeat(40) }), {
    binding: binding(), candidateSha, nonce, kind: 'challenge' }), { code: 'operator_candidate_binding_mismatch' });
  assert.throws(() => parse(signal({ attemptId: 'attempt-other' }), {
    binding: binding(), candidateSha, nonce, kind: 'challenge' }), { code: 'operator_attempt_binding_mismatch' });
});

test('unknown 3DS scenarios are refused before any operator signal is accepted', () => {
  assert.throws(() => parse(signal({ caseId: 'initial.challenge.guessed' }), {
    binding: binding({ caseId: 'initial.challenge.guessed' }), candidateSha, nonce, kind: 'challenge' }),
  { code: 'operator_scenario_unknown' });
});

test('checkpoint input accepts only the pending webhook checkpoint signal shape', () => {
  const checkpointBinding = Object.freeze({ attemptId: 'attempt-operator-1', fence: 'fence-operator-1',
    caseId: 'initial.webhook_delayed', eventId: 'evt_operator1' });
  const message = signal({ type: 'checkpoint', caseId: checkpointBinding.caseId });
  const parsed = parse(message, { binding: checkpointBinding, candidateSha, nonce, kind: 'checkpoint' });
  assert.equal(parsed.type, 'checkpoint');

  assert.throws(() => parse(message, { binding: binding(), candidateSha, nonce, kind: 'checkpoint' }),
    { code: 'operator_checkpoint_binding_invalid' });
  assert.throws(() => parse({ ...message, eventDelivered: true }, {
    binding: checkpointBinding, candidateSha, nonce, kind: 'checkpoint' }),
  { code: 'operator_signal_schema_invalid' });
  assert.throws(() => parse({ ...message, nonce: Buffer.alloc(32, 0xc).toString('hex') }, {
    binding: checkpointBinding, candidateSha, nonce, kind: 'checkpoint' }),
  { code: 'operator_nonce_mismatch' });
});
