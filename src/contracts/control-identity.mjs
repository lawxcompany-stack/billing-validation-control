export const CONTROL_REPOSITORY = 'lawx-ai/billing-validation-control';
export const CONTROL_REPOSITORY_ID = '1384018279';

export function matchesControlRepository(repository, repositoryId) {
  if (typeof repository !== 'string' || repository !== CONTROL_REPOSITORY) return false;
  if (typeof repositoryId === 'string') return repositoryId === CONTROL_REPOSITORY_ID;
  return Number.isSafeInteger(repositoryId) && repositoryId > 0 &&
    String(repositoryId) === CONTROL_REPOSITORY_ID;
}
