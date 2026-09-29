import { createHash, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { types } from 'node:util';
import { AuthorizationRefusal, createAuthorizationManifest } from './manifest.mjs';

const CHALLENGE_TTL_MS = 1_200_000;
const COMMITMENT_DOMAIN = 'lawx/billing-validation/local-collector/activation/v2\0';
const ownedChallenges = new WeakSet();
const challengeState = new WeakMap();

function refuse(code) {
  throw new AuthorizationRefusal(code);
}

function snapshotOptions(input) {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input)) {
    refuse('authorization_challenge_invalid');
  }
  const prototype = Object.getPrototypeOf(input);
  const keys = Reflect.ownKeys(input);
  if ((prototype !== Object.prototype && prototype !== null) || keys.length !== 2
    || keys.some((key) => key !== 'candidateSha' && key !== 'suite')) {
    refuse('authorization_challenge_invalid');
  }
  const shaDescriptor = Object.getOwnPropertyDescriptor(input, 'candidateSha');
  const suiteDescriptor = Object.getOwnPropertyDescriptor(input, 'suite');
  if (!shaDescriptor || !suiteDescriptor || !Object.hasOwn(shaDescriptor, 'value')
    || !Object.hasOwn(suiteDescriptor, 'value')) refuse('authorization_challenge_invalid');
  const candidateSha = shaDescriptor.value;
  const suite = suiteDescriptor.value;
  if (typeof candidateSha !== 'string' || candidateSha.length !== 40 || !/^[a-f0-9]{40}$/u.test(candidateSha)
    || (suite !== 'billing-43' && suite !== 'billing-3ds-15')) refuse('authorization_challenge_invalid');
  return { candidateSha, suite };
}

function noArguments(args) {
  if (args.length !== 0) refuse('authorization_challenge_invalid');
}

export function createAuthorizationChallenge(input) {
  const { candidateSha, suite } = snapshotOptions(input);
  const createdAt = performance.now();
  if (!Number.isFinite(createdAt)) refuse('authorization_challenge_invalid');
  const nonce = randomBytes(32);
  const presentation = Object.freeze({
    executionId: randomBytes(16).toString('hex'),
    activationCommitment: createHash('sha256').update(COMMITMENT_DOMAIN, 'utf8').update(nonce).digest('hex'),
    candidateSha,
    suite,
  });
  let status = 'usable';
  const invalidate = (nextStatus) => {
    nonce.fill(0);
    status = nextStatus;
  };
  const assertUsable = (...args) => {
    noArguments(args);
    if (status !== 'usable') refuse(`authorization_challenge_${status}`);
    const now = performance.now();
    if (!Number.isFinite(now) || now < createdAt || now - createdAt >= CHALLENGE_TTL_MS) {
      invalidate('expired');
      refuse('authorization_challenge_expired');
    }
  };
  const consume = (...args) => {
    noArguments(args);
    assertUsable();
    invalidate('consumed');
  };
  const destroy = (...args) => {
    noArguments(args);
    if (status === 'usable') invalidate('destroyed');
  };
  const challenge = Object.freeze({ presentation, assertUsable, consume, destroy });
  ownedChallenges.add(challenge);
  challengeState.set(challenge, { presentation, assertUsable });
  return challenge;
}

export function assertAuthorizationChallenge(challenge, input) {
  // Check identity before touching any caller properties or methods.
  if (!ownedChallenges.has(challenge)) refuse('authorization_challenge_invalid');
  const state = challengeState.get(challenge);
  state.assertUsable();
  const manifest = createAuthorizationManifest(input);
  // This factory binds collect only; historical operations need authoritative admission.
  if (manifest.operation !== 'collect') refuse('authorization_operation_unsupported');
  const { presentation } = state;
  if (manifest.executionId !== presentation.executionId
    || manifest.activationCommitment !== presentation.activationCommitment
    || manifest.candidate.sha !== presentation.candidateSha
    || manifest.suite !== presentation.suite) refuse('authorization_challenge_mismatch');
}
