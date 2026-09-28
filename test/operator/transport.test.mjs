import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importIfMissing, needExport } from '../billing/support.mjs';

const transportModule = await importIfMissing(() => import('../../src/operator/transport.mjs'));
const createTransport = (...args) => needExport(transportModule, 'createOperatorTransport')(...args);

const candidateSha = 'd'.repeat(40);
const challengeBinding = Object.freeze({ attemptId: 'attempt-transport-1', fence: 'fence-transport-1',
  caseId: 'initial.challenge.success', paymentIntentId: 'pi_transport1' });
const checkpointBinding = Object.freeze({ attemptId: 'attempt-transport-1', fence: 'fence-transport-1',
  caseId: 'initial.webhook_delayed', eventId: 'evt_transport1' });

function makeTransport(options = {}) {
  const prompts = [];
  let nextByte = 1;
  const transport = createTransport({ candidateSha, attemptId: challengeBinding.attemptId,
    publish: (request) => { prompts.push(request); },
    randomBytes: (size) => Buffer.alloc(size, nextByte++),
    timeoutMs: 1000,
    ...options });
  return { transport, prompts };
}

function response(prompt, overrides = {}) {
  return { version: 1, type: prompt.kind === 'challenge' ? 'complete' : 'checkpoint',
    candidateSha: prompt.candidateSha, attemptId: prompt.attemptId, caseId: prompt.caseId,
    nonce: prompt.nonce, ...overrides };
}

test('challenge completion yields an opaque, exact-binding, single-use witness', async () => {
  const { transport, prompts } = makeTransport();
  const pending = transport.challengeWitnessProvider.obtain(challengeBinding);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].kind, 'challenge');
  assert.equal(prompts[0].caseId, challengeBinding.caseId);
  assert.equal(prompts[0].paymentIntentId, undefined);
  assert.equal(await transport.acceptSignal(response(prompts[0])), true);
  const witness = await pending;

  assert.equal(Reflect.ownKeys(witness).length, 0);
  assert.notEqual(Object.getPrototypeOf(witness), Object.prototype);
  assert.equal(await transport.challengeVerifier.isOpaqueCapability(witness, challengeBinding), true);
  assert.equal(await transport.challengeVerifier.isOpaqueCapability(witness, { ...challengeBinding, fence: 'old-fence' }), false);
  assert.equal(await transport.challengeVerifier.verify(witness, challengeBinding), true);
  assert.equal(await transport.challengeVerifier.verify(witness, challengeBinding), false);
  await transport.close();
});

test('checkpoint requests are bound to the event and return no delivery result', async () => {
  const { transport, prompts } = makeTransport();
  const pending = transport.resendCheckpointProvider.request(checkpointBinding);
  assert.equal(prompts[0].kind, 'checkpoint');
  assert.equal(prompts[0].eventId, undefined);
  assert.equal(await transport.acceptSignal(response(prompts[0])), true);
  const checkpoint = await pending;

  assert.equal(await transport.resendCheckpointVerifier.isOpaqueCapability(checkpoint, checkpointBinding), true);
  assert.equal(await transport.resendCheckpointVerifier.verify(checkpoint, checkpointBinding), true);
  assert.equal(await transport.resendCheckpointVerifier.verify(checkpoint, checkpointBinding), false);
  await transport.close();
});

test('missing, wrong-attempt, and expired capabilities fail closed', async () => {
  let now = 10_000;
  const { transport, prompts } = makeTransport({ now: () => now, capabilityTtlMs: 25 });
  await assert.rejects(transport.challengeWitnessProvider.obtain({ ...challengeBinding, attemptId: 'attempt-other' }),
    { code: 'operator_attempt_binding_mismatch' });
  assert.equal(await transport.challengeVerifier.isOpaqueCapability({}, challengeBinding), false);

  const pending = transport.challengeWitnessProvider.obtain(challengeBinding);
  assert.equal(await transport.acceptSignal(response(prompts[0])), true);
  const witness = await pending;
  now += 26;
  assert.equal(await transport.challengeVerifier.isOpaqueCapability(witness, challengeBinding), false);
  assert.equal(await transport.challengeVerifier.verify(witness, challengeBinding), false);
  await transport.close();
});

test('an expired operator request rejects and mints no witness', async () => {
  const { transport } = makeTransport({ timeoutMs: 5 });
  await assert.rejects(transport.challengeWitnessProvider.obtain(challengeBinding),
    { code: 'operator_signal_timeout' });
  await transport.close();
});

test('a nonce is one-use and a prior response cannot complete the next request', async () => {
  const { transport, prompts } = makeTransport();
  const firstPending = transport.challengeWitnessProvider.obtain(challengeBinding);
  const firstResponse = response(prompts[0]);
  assert.equal(await transport.acceptSignal(firstResponse), true);
  const firstWitness = await firstPending;
  assert.equal(await transport.acceptSignal(firstResponse), false);

  const secondPending = transport.challengeWitnessProvider.obtain(challengeBinding);
  assert.notEqual(prompts[1].nonce, prompts[0].nonce);
  assert.equal(await transport.acceptSignal(firstResponse), false);
  assert.equal(await transport.challengeVerifier.verify(firstWitness, challengeBinding), true);
  assert.equal(await transport.acceptSignal(response(prompts[1])), true);
  const secondWitness = await secondPending;
  assert.equal(await transport.challengeVerifier.verify(secondWitness, challengeBinding), true);
  await transport.close();
});

test('close rejects pending requests and invalidates already issued capabilities', async () => {
  const { transport, prompts } = makeTransport();
  const pending = transport.challengeWitnessProvider.obtain(challengeBinding);
  assert.equal(await transport.acceptSignal(response(prompts[0])), true);
  const witness = await pending;
  await transport.close();

  assert.equal(await transport.challengeVerifier.isOpaqueCapability(witness, challengeBinding), false);
  assert.equal(await transport.challengeVerifier.verify(witness, challengeBinding), false);
  assert.equal(await transport.acceptSignal(response(prompts[0])), false);
  await assert.rejects(transport.challengeWitnessProvider.obtain(challengeBinding), { code: 'operator_closed' });
});

test('close rejects an in-flight operator request and rejects its later signal', async () => {
  const { transport, prompts } = makeTransport();
  const pending = transport.challengeWitnessProvider.obtain(challengeBinding);
  await transport.close();

  await assert.rejects(pending, { code: 'operator_closed' });
  assert.equal(await transport.acceptSignal(response(prompts[0])), false);
});

test('abort is an acknowledgement only and rejects the pending capability request', async () => {
  const { transport, prompts } = makeTransport();
  const pending = transport.challengeWitnessProvider.obtain(challengeBinding);

  assert.equal(await transport.acceptSignal(response(prompts[0], { type: 'abort' })), true);
  await assert.rejects(pending, { code: 'operator_aborted' });
  assert.equal(await transport.challengeVerifier.isOpaqueCapability({}, challengeBinding), false);
  await transport.close();
});
