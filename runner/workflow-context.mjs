export const CONTROL_REPOSITORY = 'lawxcompany-stack/billing-validation-control';
export const CONTROL_WORKFLOW_PATH = '.github/workflows/validate-billing.yml';
export const ISOLATED_RUNNER_GROUP = 'billing-validation-isolated';

export class WorkflowContextRefusal extends Error {
  constructor() {
    super('runner_workflow_context_invalid');
    this.name = 'WorkflowContextRefusal';
    this.code = 'runner_workflow_context_invalid';
  }
}

function validBranch(branch) {
  if (typeof branch !== 'string' || branch.length < 1 || branch.length > 128 ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(branch) || branch.startsWith('/') ||
      branch.endsWith('/') || branch.endsWith('.') || branch.includes('..') ||
      branch.includes('//') || branch.includes('@{')) return false;
  return branch.split('/').every((part) => part.length > 0 && !part.startsWith('.') &&
    !part.endsWith('.') && !part.endsWith('.lock'));
}

export function validateRunnerWorkflowContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context) ||
      context.repository !== CONTROL_REPOSITORY || context.eventName !== 'workflow_dispatch' ||
      !validBranch(context.defaultBranch)) throw new WorkflowContextRefusal();

  const expectedRef = `refs/heads/${context.defaultBranch}`;
  const expectedWorkflowRef = `${CONTROL_REPOSITORY}/${CONTROL_WORKFLOW_PATH}@${expectedRef}`;
  if (context.ref !== expectedRef || context.workflowRef !== expectedWorkflowRef) {
    throw new WorkflowContextRefusal();
  }
  return Object.freeze({ repository: CONTROL_REPOSITORY, eventName: 'workflow_dispatch',
    defaultBranch: context.defaultBranch, ref: expectedRef, workflowRef: expectedWorkflowRef,
    runnerGroup: ISOLATED_RUNNER_GROUP });
}
