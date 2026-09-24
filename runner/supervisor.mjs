import { createRunnerSupervisor } from './supervisor-internal.mjs';
import { verifyActivationAttestation } from './activation-verifier.mjs';
import { readSelectedRunAttempt } from './workflow-context.mjs';
import { createSystemProcessBoundary, ISOLATED_DOCKER_CONTEXT } from './process-boundary.mjs';
import { RunnerSupervisorRefusal } from './supervisor-internal.mjs';
export { RunnerSupervisorRefusal };

const SYSTEM_PROCESS_BOUNDARY = createSystemProcessBoundary({ dockerContext: ISOLATED_DOCKER_CONTEXT });
const PUBLIC_OPTION_KEYS = new Set([
  'image', 'parentDisplay', 'parentXauthority', 'additionalEgressHosts', 'getRegistrationToken',
  'presentActivation', 'selectRun', 'candidateSha', 'signal', 'timeoutMs',
]);
const run = createRunnerSupervisor({ readSelectedRunAttempt, verifyActivationAttestation });

export function runSupervisedRunner(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some((key) => !PUBLIC_OPTION_KEYS.has(key))) {
    return Promise.reject(new RunnerSupervisorRefusal('runner_supervisor_config_invalid'));
  }
  return run({ ...options, processBoundary: SYSTEM_PROCESS_BOUNDARY });
}
