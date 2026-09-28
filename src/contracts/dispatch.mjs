const CONTROL_REPOSITORY = 'lawxcompany-stack/billing-validation-control';
const CANDIDATE_REPOSITORY = 'lawxcompany-stack/Plataforma-LawX';
const CONTROL_DEFAULT_BRANCH = 'main';
const OPERATIONS = new Set(['collect', 'recheck']);
const INPUT_KEYS = new Set([
  'operation',
  'candidate_repository',
  'candidate_sha',
  'source_run_id',
  'source_run_attempt',
  'runner_label',
  'supervisor_activation',
]);

export class DispatchRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = 'DispatchRefusal';
    this.code = code;
  }
}

function refuse(code) {
  throw new DispatchRefusal(code);
}

export function assertProtectedDefaultRef(context = {}) {
  if (context === null || typeof context !== 'object' || Array.isArray(context)) {
    refuse('malformed_control_context');
  }
  const { ref, defaultBranch, repository, refProtected } = context;
  if (repository !== CONTROL_REPOSITORY) refuse('control_repository_not_allowed');
  if (defaultBranch !== CONTROL_DEFAULT_BRANCH) {
    refuse('default_branch_unavailable');
  }
  if (ref !== `refs/heads/${CONTROL_DEFAULT_BRANCH}` || refProtected !== true) {
    refuse('protected_ref_required');
  }
  return true;
}

export function parseDispatch(input, context) {
  assertProtectedDefaultRef(context);

  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    refuse('malformed_dispatch');
  }
  if (Object.hasOwn(input, 'candidate_ref')) refuse('candidate_ref_forbidden');
  if (Object.keys(input).some((key) => !INPUT_KEYS.has(key))) refuse('unsupported_dispatch_input');

  const operation = input.operation;
  if (typeof operation !== 'string' || !OPERATIONS.has(operation)) {
    refuse('unsupported_operation');
  }
  if (input.candidate_repository !== CANDIDATE_REPOSITORY) {
    refuse('candidate_repository_not_allowed');
  }
  if (typeof input.candidate_sha !== 'string' || !/^[0-9a-f]{40}$/i.test(input.candidate_sha)) {
    refuse('full_candidate_sha_required');
  }

  let sourceRunId = null;
  let sourceRunAttempt = null;
  let runnerLabel = null;
  let activationCommitment = null;

  if (operation === 'collect') {
    if (input.source_run_id !== '' || input.source_run_attempt !== '') {
      refuse('source_run_not_allowed_for_collect');
    }
    if (typeof input.supervisor_activation !== 'string' || input.supervisor_activation.length === 0) {
      refuse('activation_commitment_required');
    }
    if (!/^[0-9a-f]{64}$/u.test(input.supervisor_activation)) {
      refuse('malformed_activation_commitment');
    }
    activationCommitment = input.supervisor_activation;
    if (typeof input.runner_label !== 'string' ||
        !/^billing-validation-[0-9a-f]{32}$/.test(input.runner_label)) {
      refuse('per_attempt_runner_label_required');
    }
    runnerLabel = input.runner_label;
  } else {
    if (input.supervisor_activation !== '') refuse('activation_commitment_not_allowed_for_recheck');
    if (input.runner_label !== '') refuse('runner_label_not_allowed_for_recheck');
    if (typeof input.source_run_id !== 'string' || !/^[1-9][0-9]{0,19}$/.test(input.source_run_id)) {
      refuse('malformed_source_run_id');
    }
    if (typeof input.source_run_attempt !== 'string' ||
        !/^[1-9][0-9]{0,8}$/.test(input.source_run_attempt)) {
      refuse('malformed_source_run_attempt');
    }
    sourceRunId = input.source_run_id;
    sourceRunAttempt = Number(input.source_run_attempt);
  }

  return Object.freeze({
    operation,
    candidateRepository: CANDIDATE_REPOSITORY,
    candidateSha: input.candidate_sha.toLowerCase(),
    sourceRunId,
    sourceRunAttempt,
    runnerLabel,
    activationCommitment,
  });
}
