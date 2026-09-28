import { randomBytes as secureRandomBytes } from 'node:crypto';

const issuedLabels = new Set();

export class RunnerPolicyRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = 'RunnerPolicyRefusal';
    this.code = code;
  }
}

function refuse(code) {
  throw new RunnerPolicyRefusal(code);
}

export function createAttemptRunnerLabel({ randomBytes = secureRandomBytes } = {}) {
  if (typeof randomBytes !== 'function') refuse('runner_random_source_invalid');
  let bytes;
  try { bytes = randomBytes(16); } catch { refuse('runner_random_source_unavailable'); }
  if (!Buffer.isBuffer(bytes) || bytes.length !== 16) refuse('runner_random_source_unavailable');
  const label = `billing-validation-${bytes.toString('hex')}`;
  if (issuedLabels.has(label)) refuse('runner_label_reused');
  issuedLabels.add(label);
  return label;
}
