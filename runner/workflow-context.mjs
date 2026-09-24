import { getReviewedControlRepositoryId } from './trust-policy.mjs';
import { readSelectedRunAttemptWithRepositoryId } from './workflow-context-internal.mjs';
export { CONTROL_REPOSITORY, CONTROL_WORKFLOW_PATH, CONTROL_DEFAULT_BRANCH,
  ISOLATED_RUNNER_GROUP, WorkflowContextRefusal } from './workflow-context-internal.mjs';

export async function readSelectedRunAttempt({ runId, runAttempt, signal } = {}) {
  let reviewedControlRepositoryId;
  try { reviewedControlRepositoryId = getReviewedControlRepositoryId(); }
  catch {
    const error = new Error('runner_workflow_context_invalid');
    error.code = 'runner_workflow_context_invalid';
    throw error;
  }
  try {
    return await readSelectedRunAttemptWithRepositoryId({ runId, runAttempt,
      reviewedControlRepositoryId, signal });
  } catch {
    const error = new Error('runner_workflow_context_invalid');
    error.code = 'runner_workflow_context_invalid';
    throw error;
  }
}
