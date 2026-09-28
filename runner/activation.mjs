import { createHash, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const ACTIVATION_DOMAIN = Buffer.from('lawx/billing-validation/activation/v1\0', 'utf8');
export const ACTIVATION_CHALLENGE_TTL_MS = 20 * 60 * 1000;

export class ActivationRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = 'ActivationRefusal';
    this.code = code;
  }
}

function refuse(code) {
  throw new ActivationRefusal(code);
}

export function activationCommitment(nonce) {
  if (!(nonce instanceof Uint8Array) || nonce.byteLength !== 32) {
    refuse('activation_nonce_invalid');
  }
  return createHash('sha256').update(ACTIVATION_DOMAIN).update(nonce).digest('hex');
}

export function createActivationChallenge({ candidateSha, runnerLabel } = {}) {
  if (typeof candidateSha !== 'string' || !/^[a-f0-9]{40}$/u.test(candidateSha) ||
      typeof runnerLabel !== 'string' || !/^billing-validation-[a-f0-9]{32}$/u.test(runnerLabel)) {
    refuse('activation_challenge_invalid');
  }

  const nonce = randomBytes(32);
  const commitment = activationCommitment(nonce);
  const createdAt = performance.now();
  let consumed = false;

  const clearNonce = () => {
    nonce.fill(0);
    consumed = true;
  };
  const assertUsable = (now = performance.now()) => {
    if (consumed) refuse('activation_challenge_consumed');
    if (!Number.isFinite(now) || now < createdAt) {
      clearNonce();
      refuse('activation_challenge_expired');
    }
    if (now - createdAt >= ACTIVATION_CHALLENGE_TTL_MS) {
      clearNonce();
      refuse('activation_challenge_expired');
    }
  };
  const consume = (now = performance.now()) => {
    assertUsable(now);
    clearNonce();
  };
  const presentation = Object.freeze({ commitment, runnerLabel, candidateSha });
  return Object.freeze({
    commitment,
    candidateSha,
    runnerLabel,
    presentation,
    assertUsable,
    consume,
    destroy: clearNonce,
  });
}
