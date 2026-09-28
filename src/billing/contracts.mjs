import { isValidExpectedEnvironment } from '../contracts/evidence.mjs';
import { providerIdempotencyKey } from '../attempts/prepare.mjs';
import { runStripeMutation, stripeRequestDigest } from '../runtime/stripe.mjs';
import { isVerifiedDeploymentAttestation } from '../runtime/vercel.mjs';

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

function hasCurrentDeploymentAttestation(preflight, candidateSha) {
  const candidate = preflight?.candidate;
  return typeof candidateSha === 'string' && /^[0-9a-f]{40}$/u.test(candidateSha) &&
    candidate?.candidateSha === candidateSha &&
    isVerifiedDeploymentAttestation(preflight?.deploymentAttestation, {
      deployment: preflight?.expectedEnvironment?.deployment,
      candidate,
    });
}

function validReaderBinding(binding, attemptId) {
  return binding && binding.attemptId === attemptId &&
    typeof binding.caseId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u.test(binding.caseId) &&
    typeof binding.startedAt === 'string' && Number.isFinite(Date.parse(binding.startedAt));
}

export function createVerifiedContext({ attempts, owner, preflight, mutationAdapter, readers, readerBinding } = {}) {
  if (!attempts || typeof attempts.assertFence !== 'function' ||
      typeof owner?.attemptId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u.test(owner.attemptId) ||
      typeof owner.fence !== 'string' || owner.fence.length < 2 ||
      !exactVerifiedEnvironment(preflight) ||
      !hasCurrentDeploymentAttestation(preflight, owner.candidateSha) ||
      canonical(owner.environment) !== canonical(preflight.expectedEnvironment) ||
      canonical(readers?.expectedEnvironment) !== canonical(preflight.expectedEnvironment) ||
      readers?.expectedWebhookEndpointId !== preflight.providerVerification.stripe.webhookEndpointId ||
      typeof readers?.assertReady !== 'function' || !validReaderBinding(readerBinding, owner.attemptId) ||
      (mutationAdapter !== undefined && typeof mutationAdapter?.mutate !== 'function')) {
    refuse('billing_environment_unverified');
  }
  return Object.freeze({ attempts, owner, preflight, mutationAdapter, readers,
    readerBinding: Object.freeze({ ...readerBinding }) });
}

export async function assertReadersReady(context, { readers = context?.readers, binding = context?.readerBinding,
  code = 'billing_readers_unavailable' } = {}) {
  if (!context?.preflight || !validReaderBinding(binding, context.owner?.attemptId) ||
      canonical(readers?.expectedEnvironment) !== canonical(context.preflight.expectedEnvironment) ||
      readers?.expectedWebhookEndpointId !== context.preflight.providerVerification?.stripe?.webhookEndpointId ||
      typeof readers?.assertReady !== 'function') refuse(code);
  try { await readers.assertReady(Object.freeze({ ...binding })); }
  catch { refuse(code); }
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
  if (current.candidateSha !== owner.candidateSha ||
      !hasCurrentDeploymentAttestation(preflight, owner.candidateSha)) {
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

  const { owner, attempts } = context;
  if (provider === 'supabase' && (typeof attempts?.fixtureMutation !== 'function' ||
      typeof context.mutationAdapter?.mutateInTransaction !== 'function')) {
    refuse('supabase_transaction_adapter_unavailable');
  }
  await assertReadersReady(context);
  const idempotencyKey = providerIdempotencyKey(owner.attemptId, provider, operation);
  const current = await assertCurrentAttempt(context);
  if (provider === 'stripe' && typeof attempts.beginStripeIntent !== 'function') {
    refuse('stripe_intent_store_unavailable');
  }
  const requestDigest = provider === 'stripe' ? stripeRequestDigest({ action, operation, input }) : undefined;
  const request = { attemptId: owner.attemptId, fence: owner.fence,
    candidateSha: current.candidateSha, workflow: current.workflow,
    environment: current.environment, provider, action, operation, idempotencyKey,
    ...(requestDigest ? { requestDigest } : {}), input: structuredClone(input) };

  try {
    if (provider === 'stripe') {
      if (!hasCurrentDeploymentAttestation(context.preflight, owner.candidateSha)) {
        refuse('billing_environment_unverified');
      }
      const stripeOwner = { attemptId: owner.attemptId, fence: owner.fence,
        candidateSha: current.candidateSha, workflow: current.workflow,
        environment: current.environment,
        webhookEndpointId: context.preflight.providerVerification.stripe.webhookEndpointId };
      const result = await runStripeMutation({ attempts, owner: stripeOwner, action, operation,
        input, idempotencyKey, adapter: context.mutationAdapter, readers: context.readers,
        readerBinding: context.readerBinding, deploymentAttestation: context.preflight.deploymentAttestation,
        candidate: context.preflight.candidate });
      return Object.freeze({ operation, idempotencyKey, dispatched: true,
        intentId: result.intentId, requestDigest: result.requestDigest, state: result.state });
    }
    await attempts.fixtureMutation({ attemptId: owner.attemptId, fence: owner.fence },
      (tx) => {
        if (!hasCurrentDeploymentAttestation(context.preflight, owner.candidateSha)) {
          refuse('billing_environment_unverified');
        }
        return context.mutationAdapter.mutateInTransaction(request, tx);
      });
  } catch (error) {
    if (['lease_fence_lost', 'lease_expired'].includes(error?.code) ||
        (provider === 'stripe' && ['stripe_mutation_ambiguous', 'stripe_intent_unresolved',
          'stripe_intent_already_reconciled'].includes(error?.code))) {
      throw error;
    }
    refuse('provider_mutation_failed');
  }
  return Object.freeze({ operation, idempotencyKey, dispatched: true });
}

export { stripeRequestDigest };
