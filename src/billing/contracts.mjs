import { isValidExpectedEnvironment } from '../contracts/evidence.mjs';
import { providerIdempotencyKey } from '../attempts/prepare.mjs';

export class BillingControlRefusal extends Error {
  constructor(code) { super(code); this.name = 'BillingControlRefusal'; this.code = code; }
}

function refuse(code) { throw new BillingControlRefusal(code); }

const PROVIDER_ACTIONS = Object.freeze({
  stripe: Object.freeze(['checkout.replay', 'checkout_session.expire', 'subscription.cancel']),
  supabase: Object.freeze(['fixtures.cleanup']),
});

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function exactVerifiedEnvironment(preflight) {
  const expected = preflight?.expectedEnvironment;
  const verified = preflight?.providerVerification;
  const db = verified?.supabase;
  const stripe = verified?.stripe;
  return isValidExpectedEnvironment(expected) &&
    db?.projectRef === expected.database.projectRef && db?.branchId === expected.database.branchId &&
    /^[a-z0-9]{20}$/u.test(db?.parentProjectRef ?? '') && db.parentProjectRef !== db.projectRef &&
    /^[0-9a-f]{64}$/u.test(db?.schemaFingerprintSha256 ?? '') &&
    /^[0-9a-f]{64}$/u.test(db?.migrationHistorySha256 ?? '') &&
    stripe?.accountId === expected.stripe.accountId && stripe.livemode === false &&
    /^we_[A-Za-z0-9]+$/u.test(stripe?.webhookEndpointId ?? '') &&
    stripe.webhookUrl === `${expected.deployment.origin}/api/stripe/webhook`;
}

export function createVerifiedContext({ attempts, owner, preflight, mutationAdapter } = {}) {
  if (!attempts || typeof attempts.assertFence !== 'function' ||
      typeof owner?.attemptId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u.test(owner.attemptId) ||
      typeof owner.fence !== 'string' || owner.fence.length < 2 ||
      !exactVerifiedEnvironment(preflight) ||
      canonical(owner.environment) !== canonical(preflight.expectedEnvironment) ||
      (mutationAdapter !== undefined && typeof mutationAdapter?.mutate !== 'function')) {
    refuse('billing_environment_unverified');
  }
  return Object.freeze({ attempts, owner, preflight, mutationAdapter });
}

export async function assertCurrentAttempt(context) {
  const { owner, attempts, preflight } = context ?? {};
  if (!owner || !attempts || typeof attempts.assertFence !== 'function' || !preflight) {
    refuse('billing_context_invalid');
  }
  let current;
  try { current = await attempts.assertFence({ attemptId: owner.attemptId, fence: owner.fence }); }
  catch { refuse('lease_fence_lost'); }
  if (current?.attemptId !== owner.attemptId) refuse('lease_fence_lost');
  if (current?.fence !== owner.fence) refuse('lease_fence_lost');
  if (canonical(current.environment) !== canonical(preflight.expectedEnvironment)) {
    refuse('billing_environment_unverified');
  }
  return current;
}

export async function mutateProvider(context, { provider = 'stripe', action, operation, input } = {}) {
  if (!context?.mutationAdapter || !['stripe', 'supabase'].includes(provider) ||
      typeof action !== 'string' || !/^[a-z][a-z0-9._:-]{1,63}$/u.test(action) ||
      !PROVIDER_ACTIONS[provider]?.includes(action) ||
      typeof operation !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u.test(operation) ||
      !input || typeof input !== 'object' || Array.isArray(input)) refuse('billing_mutation_invalid');

  const { owner, preflight } = context;
  const idempotencyKey = providerIdempotencyKey(owner.attemptId, provider, operation);
  await assertCurrentAttempt(context);

  try {
    await context.mutationAdapter.mutate({ attemptId: owner.attemptId, fence: owner.fence,
      environment: preflight.expectedEnvironment, provider, action, operation, idempotencyKey,
      input: structuredClone(input) });
  } catch {
    refuse('provider_mutation_failed');
  }
  return Object.freeze({ operation, idempotencyKey, dispatched: true });
}
