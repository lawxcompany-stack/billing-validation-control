import { ALL_THREE_DS_SCENARIOS, threeDsScenario } from '../billing/fixtures.mjs';

const SCENARIOS = new Set(ALL_THREE_DS_SCENARIOS);
const CHECKPOINT_SCENARIOS = new Set(['initial.webhook_delayed', 'initial.webhook_replay']);
const SIGNAL_KEYS = Object.freeze(['version', 'type', 'candidateSha', 'attemptId', 'caseId', 'nonce']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u;
const SHA = /^[a-f0-9]{40}$/iu;
const NONCE = /^[a-f0-9]{64}$/u;
const PAYMENT_INTENT = /^pi_[A-Za-z0-9_]+$/u;
const EVENT = /^evt_[A-Za-z0-9_]+$/u;
const MAX_SIGNAL_BYTES = 2048;

export class OperatorProtocolRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = 'OperatorProtocolRefusal';
    this.code = code;
  }
}

function refuse(code) {
  throw new OperatorProtocolRefusal(code);
}

function plainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function assertOperatorBinding(binding, kind) {
  const expectedKeys = kind === 'challenge' ? ['attemptId', 'fence', 'caseId', 'paymentIntentId'] :
    kind === 'checkpoint' ? ['attemptId', 'fence', 'caseId', 'eventId'] : null;
  if (!expectedKeys) refuse('operator_signal_kind_invalid');
  let keys;
  try { keys = Reflect.ownKeys(binding); } catch { refuse('operator_binding_invalid'); }
  if (!plainRecord(binding) || !ID.test(binding.attemptId ?? '') || !ID.test(binding.fence ?? '')) {
    refuse('operator_binding_invalid');
  }
  if (kind === 'challenge' && !keys.includes('paymentIntentId')) refuse('operator_challenge_binding_invalid');
  if (kind === 'checkpoint' && !keys.includes('eventId')) refuse('operator_checkpoint_binding_invalid');
  if (keys.length !== expectedKeys.length ||
      keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))) {
    refuse('operator_binding_invalid');
  }
  if (!SCENARIOS.has(binding.caseId)) refuse('operator_scenario_unknown');

  const scenario = threeDsScenario(binding.caseId);
  if (kind === 'challenge') {
    if (!scenario.challenge || scenario.supported === false ||
        !PAYMENT_INTENT.test(binding.paymentIntentId ?? '')) refuse('operator_challenge_binding_invalid');
    return Object.freeze({ ...binding });
  }
  if (kind === 'checkpoint') {
    if (!CHECKPOINT_SCENARIOS.has(binding.caseId) || !EVENT.test(binding.eventId ?? '')) {
      refuse('operator_checkpoint_binding_invalid');
    }
    return Object.freeze({ ...binding });
  }
  refuse('operator_signal_kind_invalid');
}

function decodeSignal(raw) {
  if (typeof raw === 'string') {
    if (Buffer.byteLength(raw, 'utf8') > MAX_SIGNAL_BYTES) refuse('operator_signal_too_large');
    try { raw = JSON.parse(raw); } catch { refuse('operator_signal_malformed'); }
  }
  if (!plainRecord(raw)) refuse('operator_signal_malformed');
  let keys;
  try { keys = Reflect.ownKeys(raw); } catch { refuse('operator_signal_malformed'); }
  if (keys.length !== SIGNAL_KEYS.length || keys.some((key) => typeof key !== 'string' || !SIGNAL_KEYS.includes(key))) {
    refuse('operator_signal_schema_invalid');
  }
  let signal;
  try {
    signal = Object.fromEntries(SIGNAL_KEYS.map((key) => [key, raw[key]]));
    if (Buffer.byteLength(JSON.stringify(signal), 'utf8') > MAX_SIGNAL_BYTES) refuse('operator_signal_too_large');
  } catch { refuse('operator_signal_malformed'); }
  return signal;
}

export function parseOperatorSignal(raw, { binding, candidateSha, nonce, kind } = {}) {
  const immutableBinding = assertOperatorBinding(binding, kind);
  if (typeof candidateSha !== 'string' || !SHA.test(candidateSha) || !NONCE.test(nonce ?? '')) {
    refuse('operator_request_capability_invalid');
  }

  const signal = decodeSignal(raw);
  if (signal.version !== 1 || !['complete', 'abort', 'checkpoint'].includes(signal.type) ||
      !SHA.test(signal.candidateSha ?? '') || !ID.test(signal.attemptId ?? '') ||
      !NONCE.test(signal.nonce ?? '')) refuse('operator_signal_schema_invalid');
  if (!SCENARIOS.has(signal.caseId)) refuse('operator_scenario_unknown');
  if (signal.caseId !== immutableBinding.caseId) {
    if (!SCENARIOS.has(signal.caseId)) refuse('operator_scenario_unknown');
    refuse('operator_case_binding_mismatch');
  }
  if (signal.candidateSha.toLowerCase() !== candidateSha.toLowerCase()) {
    refuse('operator_candidate_binding_mismatch');
  }
  if (signal.attemptId !== immutableBinding.attemptId) refuse('operator_attempt_binding_mismatch');
  if (signal.nonce !== nonce) refuse('operator_nonce_mismatch');

  if (signal.type === 'abort') return Object.freeze({ ...signal });
  if (kind === 'challenge' && signal.type === 'complete') return Object.freeze({ ...signal });
  if (kind === 'checkpoint' && signal.type === 'checkpoint') return Object.freeze({ ...signal });
  if (signal.type === 'checkpoint') refuse('operator_checkpoint_binding_invalid');
  refuse('operator_signal_type_invalid');
}
