import { verifyRecheckSnapshot } from '../contracts/attempt.mjs';
import { withExternalFence } from './lock.mjs';

export function resumeRecheck(store, input) { return store.resumeRecheck(input); }

export async function recheckAttempt(store, input) {
  const row = await store.getAttempt(input.attemptId);
  verifyRecheckSnapshot(input.snapshot, { row, workflow: input.workflow,
    environment: input.environment, candidateSha: input.candidateSha,
    currentHeadSha: input.currentHeadSha, artifactId: input.artifactId,
    artifactDigest: input.artifactDigest });
  const resumed = await store.resumeRecheck({ ...input, artifact: row.artifact });
  if (input.stripe) {
    if (typeof input.stripe.verifyExisting !== 'function') throw new TypeError('stripe verifier required');
    for (const resourceId of row.resourceIds) {
      await withExternalFence(store, resumed, () => input.stripe.verifyExisting(resourceId));
    }
  }
  return resumed;
}
