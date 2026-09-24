const CONTROL_REPOSITORY = 'lawxcompany-stack/billing-validation-control';
const CANDIDATE_REPOSITORY = 'lawxcompany-stack/Plataforma-LawX';
const CONTROL_REF = 'refs/heads/main';
const CONTROL_WORKFLOW_PATH = '.github/workflows/validate-billing.yml';
const CONTROL_EVENT = 'workflow_dispatch';
const MANIFEST_KEYS = Object.freeze([
  'activationCommitment',
  'candidateRepository',
  'candidateSha',
  'runnerLabel',
  'controlRepository',
  'controlRepositoryId',
  'controlRef',
  'controlWorkflowPath',
  'runId',
  'runAttempt',
  'controlWorkflowSha',
  'eventName',
]);
const MAX_MANIFEST_BYTES = 8 * 1024;

export class ActivationManifestRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = 'ActivationManifestRefusal';
    this.code = code;
  }
}

function refuse(code) {
  throw new ActivationManifestRefusal(code);
}

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function decimalId(value, maximumLength) {
  return typeof value === 'string' && value.length <= maximumLength && /^[1-9][0-9]*$/u.test(value);
}

export function createActivationManifest(input) {
  if (!isRecord(input)) refuse('activation_manifest_invalid');
  const keys = Object.keys(input);
  if (keys.length !== MANIFEST_KEYS.length || keys.some((key) => !MANIFEST_KEYS.includes(key))) {
    refuse('activation_manifest_invalid');
  }
  if (typeof input.activationCommitment !== 'string' || !/^[a-f0-9]{64}$/u.test(input.activationCommitment) ||
      input.candidateRepository !== CANDIDATE_REPOSITORY ||
      typeof input.candidateSha !== 'string' || !/^[a-f0-9]{40}$/u.test(input.candidateSha) ||
      typeof input.runnerLabel !== 'string' || !/^billing-validation-[a-f0-9]{32}$/u.test(input.runnerLabel) ||
      input.controlRepository !== CONTROL_REPOSITORY || !decimalId(input.controlRepositoryId, 20) ||
      input.controlRef !== CONTROL_REF || input.controlWorkflowPath !== CONTROL_WORKFLOW_PATH ||
      !decimalId(input.runId, 20) || !decimalId(input.runAttempt, 8) ||
      typeof input.controlWorkflowSha !== 'string' || !/^[a-f0-9]{40}$/u.test(input.controlWorkflowSha) ||
      input.eventName !== CONTROL_EVENT) {
    refuse('activation_manifest_invalid');
  }

  const manifest = {};
  for (const key of MANIFEST_KEYS) manifest[key] = input[key];
  return Object.freeze(manifest);
}

export function serializeActivationManifest(input) {
  return `${JSON.stringify(createActivationManifest(input))}\n`;
}

export function parseCanonicalActivationManifest(input) {
  let bytes;
  if (typeof input === 'string') bytes = Buffer.from(input, 'utf8');
  else if (input instanceof Uint8Array) bytes = Buffer.from(input);
  else refuse('activation_manifest_noncanonical');
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_MANIFEST_BYTES) {
    refuse('activation_manifest_noncanonical');
  }

  let text;
  let parsed;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    refuse('activation_manifest_noncanonical');
  }

  let manifest;
  try { manifest = createActivationManifest(parsed); }
  catch { refuse('activation_manifest_noncanonical'); }
  if (serializeActivationManifest(manifest) !== text) refuse('activation_manifest_noncanonical');
  return manifest;
}

export function activationManifestKeys() {
  return [...MANIFEST_KEYS];
}
