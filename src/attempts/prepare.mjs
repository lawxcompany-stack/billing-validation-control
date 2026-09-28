import { createHash } from 'node:crypto';

export function prepareAttempt(store, input) { return store.prepare(input); }

export function providerIdempotencyKey(attemptId, provider, operation) {
  if (![attemptId, provider, operation].every((value) =>
    typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/.test(value))) {
    throw new TypeError('invalid idempotency identity');
  }
  return `billing-validation-${createHash('sha256').update(JSON.stringify([attemptId, provider, operation])).digest('hex')}`;
}
