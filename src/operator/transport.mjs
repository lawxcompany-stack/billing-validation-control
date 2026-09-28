import { randomBytes as secureRandomBytes } from 'node:crypto';
import { assertOperatorBinding, parseOperatorSignal } from './protocol.mjs';

export class OperatorTransportRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = 'OperatorTransportRefusal';
    this.code = code;
  }
}

function refuse(code) {
  throw new OperatorTransportRefusal(code);
}

function validDuration(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 600_000;
}

function sameBinding(left, right) {
  if (!left || typeof left !== 'object' || !right || typeof right !== 'object') return false;
  let leftKeys;
  let rightKeys;
  try {
    leftKeys = Reflect.ownKeys(left).sort();
    rightKeys = Reflect.ownKeys(right).sort();
  } catch { return false; }
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) =>
    key === rightKeys[index] && typeof key === 'string' && left[key] === right[key]);
}

function createOpaqueCapability() {
  const prototype = Object.create(null);
  Object.defineProperty(prototype, 'constructor', { value: function OperatorCapability() {} });
  return Object.freeze(Object.create(prototype));
}

export function createOperatorTransport({ candidateSha, attemptId, publish, randomBytes = secureRandomBytes,
  now = Date.now, timeoutMs = 120_000, capabilityTtlMs = 120_000 } = {}) {
  if (typeof candidateSha !== 'string' || !/^[a-f0-9]{40}$/iu.test(candidateSha) ||
      typeof attemptId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u.test(attemptId) ||
      typeof publish !== 'function' || typeof randomBytes !== 'function' || typeof now !== 'function' ||
      !validDuration(timeoutMs) || !validDuration(capabilityTtlMs)) refuse('operator_transport_config_invalid');

  const normalizedSha = candidateSha.toLowerCase();
  const nonces = new Set();
  const capabilities = new WeakMap();
  let active = null;
  let closed = false;

  function finishPending(error, value) {
    if (!active) return false;
    const current = active;
    active = null;
    clearTimeout(current.timer);
    if (error) current.reject(error);
    else current.resolve(value);
    return true;
  }

  function issue(kind, binding) {
    if (closed) return Promise.reject(new OperatorTransportRefusal('operator_closed'));
    let immutableBinding;
    try { immutableBinding = assertOperatorBinding(binding, kind); }
    catch (error) { return Promise.reject(error); }
    if (immutableBinding.attemptId !== attemptId) {
      return Promise.reject(new OperatorTransportRefusal('operator_attempt_binding_mismatch'));
    }
    if (active) return Promise.reject(new OperatorTransportRefusal('operator_request_in_progress'));

    let bytes;
    try { bytes = randomBytes(32); } catch { return Promise.reject(new OperatorTransportRefusal('operator_nonce_unavailable')); }
    if (!Buffer.isBuffer(bytes) || bytes.length !== 32) {
      return Promise.reject(new OperatorTransportRefusal('operator_nonce_unavailable'));
    }
    const nonce = bytes.toString('hex');
    if (nonces.has(nonce)) return Promise.reject(new OperatorTransportRefusal('operator_nonce_reused'));
    nonces.add(nonce);

    const request = Object.freeze({ kind, candidateSha: normalizedSha, attemptId,
      caseId: immutableBinding.caseId, nonce });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        finishPending(new OperatorTransportRefusal('operator_signal_timeout'));
      }, timeoutMs);
      active = { kind, binding: immutableBinding, nonce, timer, resolve, reject };
      try {
        Promise.resolve(publish(request)).catch(() => {
          if (active?.nonce === nonce) finishPending(new OperatorTransportRefusal('operator_transport_failed'));
        });
      } catch {
        if (active?.nonce === nonce) finishPending(new OperatorTransportRefusal('operator_transport_failed'));
      }
    });
  }

  function verifierFor(kind) {
    return Object.freeze({
      async isOpaqueCapability(capability, binding) {
        const record = capability && typeof capability === 'object' ? capabilities.get(capability) : null;
        if (!record || closed || record.used || record.kind !== kind || now() >= record.expiresAt) return false;
        return sameBinding(record.binding, binding);
      },
      async verify(capability, binding) {
        const record = capability && typeof capability === 'object' ? capabilities.get(capability) : null;
        if (!record || record.used) return false;
        record.used = true;
        return !closed && record.kind === kind && now() < record.expiresAt && sameBinding(record.binding, binding);
      },
    });
  }

  async function acceptSignal(raw) {
    const current = active;
    if (closed || !current) return false;
    let signal;
    try {
      signal = parseOperatorSignal(raw, { binding: current.binding, candidateSha: normalizedSha,
        nonce: current.nonce, kind: current.kind });
    } catch { return false; }

    if (signal.type === 'abort') {
      finishPending(new OperatorTransportRefusal('operator_aborted'));
      return true;
    }
    const capability = createOpaqueCapability();
    capabilities.set(capability, { kind: current.kind, binding: current.binding,
      expiresAt: now() + capabilityTtlMs, used: false });
    finishPending(null, capability);
    return true;
  }

  async function close() {
    if (closed) return;
    closed = true;
    finishPending(new OperatorTransportRefusal('operator_closed'));
    nonces.clear();
  }

  const challengeWitnessProvider = Object.freeze({ obtain: (binding) => issue('challenge', binding) });
  const resendCheckpointProvider = Object.freeze({ request: (binding) => issue('checkpoint', binding) });

  return Object.freeze({ challengeWitnessProvider, resendCheckpointProvider,
    challengeVerifier: verifierFor('challenge'), resendCheckpointVerifier: verifierFor('checkpoint'),
    acceptSignal, close, get closed() { return closed; } });
}
