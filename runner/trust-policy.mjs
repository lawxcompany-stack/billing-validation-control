// Task 9 must replace null only after administrator readback. Keeping this unset
// makes production activation fail closed instead of trusting a caller/env value.
const REVIEWED_CONTROL_REPOSITORY_ID = null;

export function getReviewedControlRepositoryId() {
  if (typeof REVIEWED_CONTROL_REPOSITORY_ID !== 'string' ||
      !/^[1-9][0-9]{0,19}$/u.test(REVIEWED_CONTROL_REPOSITORY_ID)) {
    const error = new Error('control_repository_identity_unconfigured');
    error.code = 'control_repository_identity_unconfigured';
    throw error;
  }
  return REVIEWED_CONTROL_REPOSITORY_ID;
}
