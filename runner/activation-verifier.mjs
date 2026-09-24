import { createSystemProcessBoundary, ISOLATED_DOCKER_CONTEXT } from './process-boundary.mjs';
import { verifyActivationAttestationWithBoundary } from './activation-verifier-internal.mjs';
import { getReviewedControlRepositoryId } from './trust-policy.mjs';

const GH_PROCESS_BOUNDARY = createSystemProcessBoundary({ dockerContext: ISOLATED_DOCKER_CONTEXT });

export class ActivationVerifierRefusal extends Error {
  constructor() {
    super('activation_attestation_invalid');
    this.name = 'ActivationVerifierRefusal';
    this.code = 'activation_attestation_invalid';
  }
}

export async function verifyActivationAttestation({ manifest, signal } = {}) {
  let reviewedControlRepositoryId;
  try { reviewedControlRepositoryId = getReviewedControlRepositoryId(); }
  catch { throw new ActivationVerifierRefusal(); }
  try {
    return await verifyActivationAttestationWithBoundary({ manifest,
      processBoundary: GH_PROCESS_BOUNDARY, reviewedControlRepositoryId, signal });
  } catch {
    throw new ActivationVerifierRefusal();
  }
}
