export const CONTROL_REPOSITORY = 'lawxcompany-stack/billing-validation-control';
export const CONTROL_WORKFLOW_PATH = '.github/workflows/validate-billing.yml';
export const CONTROL_DEFAULT_BRANCH = 'main';
export const ISOLATED_RUNNER_GROUP = 'billing-validation-isolated';

export class WorkflowContextRefusal extends Error {
  constructor() {
    super('runner_workflow_context_invalid');
    this.name = 'WorkflowContextRefusal';
    this.code = 'runner_workflow_context_invalid';
  }
}

export function readTrustedRunnerWorkflowContext() {
  const environment = process.env;
  const expectedRef = `refs/heads/${CONTROL_DEFAULT_BRANCH}`;
  const expectedWorkflowRef = `${CONTROL_REPOSITORY}/${CONTROL_WORKFLOW_PATH}@${expectedRef}`;
  if (environment.GITHUB_REPOSITORY !== CONTROL_REPOSITORY ||
      environment.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
      environment.GITHUB_REF !== expectedRef ||
      environment.GITHUB_WORKFLOW_REF !== expectedWorkflowRef ||
      environment.GITHUB_REF_PROTECTED !== 'true') {
    throw new WorkflowContextRefusal();
  }
  return Object.freeze({ repository: CONTROL_REPOSITORY, eventName: 'workflow_dispatch',
    defaultBranch: CONTROL_DEFAULT_BRANCH, ref: expectedRef, workflowRef: expectedWorkflowRef,
    runnerGroup: ISOLATED_RUNNER_GROUP });
}
