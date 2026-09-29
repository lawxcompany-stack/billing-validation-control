import { assertProtectedDefaultRef, DispatchRefusal } from '../contracts/dispatch.mjs';
import { resolveCandidate, CandidateRefusal } from './candidate.mjs';
import { collectCandidateChecks } from './candidate-checks.mjs';

export async function readCandidatePrerequisites({ api, candidateSha, context } = {}) {
  assertProtectedDefaultRef(context);
  if (context.eventName !== 'workflow_dispatch') throw new DispatchRefusal('control_event_not_allowed');
  const candidate = await resolveCandidate({ api, candidateSha });
  const checks = await collectCandidateChecks({ api, candidate });
  const current = await resolveCandidate({ api, candidateSha });
  if (['repositoryId', 'pullNumber', 'candidateSha', 'baseSha', 'treeSha'].some((key) =>
    current[key] !== candidate[key])) throw new CandidateRefusal('candidate_changed_during_read');
  return checks;
}
