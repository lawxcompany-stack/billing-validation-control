// Administrator-authenticated GET /repos/lawxcompany-stack/billing-validation-control,
// read back 2026-09-29. This identity does not authorize runner activation:
// the environment, App, runner admission and collection prerequisites still apply.
// Never source this value from caller input, a dispatch field or local environment.
const REVIEWED_CONTROL_REPOSITORY_ID = '1384018279';

export function getReviewedControlRepositoryId() {
  if (typeof REVIEWED_CONTROL_REPOSITORY_ID !== 'string' ||
      !/^[1-9][0-9]{0,19}$/u.test(REVIEWED_CONTROL_REPOSITORY_ID)) {
    const error = new Error('control_repository_identity_unconfigured');
    error.code = 'control_repository_identity_unconfigured';
    throw error;
  }
  return REVIEWED_CONTROL_REPOSITORY_ID;
}
