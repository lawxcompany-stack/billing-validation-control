import { createHash } from 'node:crypto';

// Version 1 counts logical attempts, retained app DB rows, retained Auth users,
// and every retained Stripe TEST object/event/clock in the shared validation scope.
export const RETENTION_QUOTA_KEYS = Object.freeze([
  'attempts', 'databaseRows', 'authUsers', 'stripeObjects',
]);

export class RetentionConfigurationError extends TypeError {
  constructor() {
    super('retention_policy_invalid');
    this.name = 'RetentionConfigurationError';
    this.code = 'retention_policy_invalid';
  }
}

function exactDataRecord(value, expectedKeys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  let ownKeys;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    ownKeys = Reflect.ownKeys(value);
  } catch { return null; }
  if (ownKeys.length !== expectedKeys.length || ownKeys.some((key) =>
    typeof key !== 'string' || !expectedKeys.includes(key))) return null;
  const fields = Object.create(null);
  try {
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) return null;
      fields[key] = descriptor.value;
    }
  } catch { return null; }
  return fields;
}

function exactUsage(value, { positive = false } = {}) {
  const fields = exactDataRecord(value, RETENTION_QUOTA_KEYS);
  if (!fields) return null;
  const usage = Object.create(null);
  for (const key of RETENTION_QUOTA_KEYS) {
    const count = fields[key];
    if (!Number.isSafeInteger(count) || count < (positive ? 1 : 0)) return null;
    usage[key] = count;
  }
  return Object.freeze(Object.fromEntries(RETENTION_QUOTA_KEYS.map((key) => [key, usage[key]])));
}

export function validateRetentionConfiguration(retentionPolicy, projection) {
  const policy = exactDataRecord(retentionPolicy, ['version', 'quotas']);
  const quotas = exactUsage(policy?.quotas, { positive: true });
  const projected = exactUsage(projection);
  if (!policy || policy.version !== 1 || !quotas || !projected || projected.attempts !== 1) {
    throw new RetentionConfigurationError();
  }
  return Object.freeze({
    retentionPolicy: Object.freeze({ version: 1, quotas }),
    projection: projected,
  });
}

export function prepareAttempt(store, input) { return store.prepare(input); }

export function providerIdempotencyKey(attemptId, provider, operation) {
  if (![attemptId, provider, operation].every((value) =>
    typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/.test(value))) {
    throw new TypeError('invalid idempotency identity');
  }
  return `billing-validation-${createHash('sha256').update(JSON.stringify([attemptId, provider, operation])).digest('hex')}`;
}
