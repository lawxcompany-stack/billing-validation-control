import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { verifyDeploymentAttestation } from '../../src/runtime/vercel.mjs';

export const environment = Object.freeze({
  database: Object.freeze({ projectRef: 'abcdefghijklmnopqrst', branchId: 'validation-child-123' }),
  deployment: Object.freeze({ id: 'dpl_task6preview123', origin: 'https://lawx-abc123def-team.vercel.app' }),
  stripe: Object.freeze({ accountId: 'acct_task6test123' }),
});

export const candidate = Object.freeze({ candidateSha: 'a'.repeat(40), treeSha: 'b'.repeat(40) });
const attestationKeys = generateKeyPairSync('ed25519');
const attestationDocument = {
  origin: environment.deployment.origin,
  deploymentId: environment.deployment.id,
  commit: candidate.candidateSha,
  treeHash: candidate.treeSha,
  env: 'billing-validation',
  projectRef: environment.database.projectRef,
  timestamp: new Date().toISOString(),
};
const signedAttestationDocument = { ...attestationDocument,
  signature: sign(null, Buffer.from(JSON.stringify(attestationDocument)), attestationKeys.privateKey).toString('base64') };
export const deploymentAttestation = await verifyDeploymentAttestation({
  deployment: environment.deployment,
  candidate,
  policy: { database: { projectRef: environment.database.projectRef }, attestation: {
    publicKeyPem: attestationKeys.publicKey.export({ type: 'spki', format: 'pem' }),
  } },
  fetchImpl: async () => new Response(JSON.stringify(signedAttestationDocument), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  }),
});

export const preflight = Object.freeze({
  expectedEnvironment: environment,
  candidate,
  deploymentAttestation,
  providerVerification: Object.freeze({
    supabase: Object.freeze({ projectRef: environment.database.projectRef,
      parentProjectRef: 'zyxwvutsrqponmlkjihg', branchId: environment.database.branchId,
      branchName: 'billing-validation-task6', schemaFingerprintSha256: 'a'.repeat(64),
      migrationHistorySha256: 'b'.repeat(64) }),
    stripe: Object.freeze({ accountId: environment.stripe.accountId,
      webhookEndpointId: 'we_task6endpoint', webhookUrl: `${environment.deployment.origin}/api/stripe/webhook`,
      livemode: false }),
  }),
});

export function makeAttemptParts({ attemptId = 'attempt-task6', fence = '11111111-1111-4111-8111-111111111111',
  currentFence = fence, resourceIds = [], databaseResourceIds = [], failReceipt = false } = {}) {
  const owner = Object.freeze({ attemptId, fence, candidateSha: 'a'.repeat(40),
    workflow: Object.freeze({ repository: 'lawxcompany-stack/billing-validation-control',
      ref: 'refs/heads/main', runId: '100', runAttempt: 1,
      runnerLabel: `billing-validation-${'a'.repeat(32)}` }),
    environment, resourceIds: [...resourceIds], databaseResourceIds: structuredClone(databaseResourceIds) });
  const calls = { assertions: [], cleanup: [], mutations: [], fixtureMutations: [], intentBegins: [],
    pendingQueries: [], reconciliations: [] };
  const intents = new Map();
  const receipts = new Map();
  const attempts = {
    async assertFence(input) {
      calls.assertions.push({ ...input });
      if (input.attemptId !== attemptId || input.fence !== currentFence) {
        throw Object.assign(new Error('lease_fence_lost'), { code: 'lease_fence_lost' });
      }
      return { ...owner, state: 'collecting', cleanupStatus: 'pending' };
    },
    async beginStripeIntent(input) {
      if (input.attemptId !== attemptId || input.fence !== currentFence) {
        throw Object.assign(new Error('lease_fence_lost'), { code: 'lease_fence_lost' });
      }
      const prior = [...intents.values()].find((intent) => intent.attemptId === input.attemptId &&
        intent.operation === input.operation);
      if (prior) throw Object.assign(new Error('stripe_intent_unresolved'), { code: 'stripe_intent_unresolved' });
      calls.intentBegins.push(structuredClone(input));
      const intent = { intentId: `intent-${attemptId}-${intents.size + 1}`,
        ...structuredClone(input), accountId: input.environment.stripe.accountId, state: 'in_flight' };
      intents.set(intent.intentId, intent);
      return structuredClone(intent);
    },
    async getStripeIntent(intentId) {
      return structuredClone(intents.get(intentId) ?? null);
    },
    async listPendingStripeIntents(input) {
      calls.pendingQueries.push(structuredClone(input));
      if (input.attemptId !== attemptId || input.fence !== currentFence) {
        throw Object.assign(new Error('lease_fence_lost'), { code: 'lease_fence_lost' });
      }
      return [...intents.values()].filter((intent) => intent.attemptId === input.attemptId &&
        !receipts.has(intent.intentId)).map((intent) => structuredClone(intent));
    },
    async reconcileStripeIntent(input) {
      calls.reconciliations.push(structuredClone(input));
      if (input.attemptId !== attemptId || input.fence !== currentFence) {
        throw Object.assign(new Error('lease_fence_lost'), { code: 'lease_fence_lost' });
      }
      if (failReceipt) throw Object.assign(new Error('stripe_reconciliation_unavailable'), {
        code: 'stripe_reconciliation_unavailable',
      });
      const intent = intents.get(input.intentId);
      const observation = input.observation;
      if (!intent || intent.attemptId !== attemptId || observation.accountId !== intent.accountId ||
          observation.livemode !== false || observation.operation !== intent.operation ||
          observation.requestDigest !== intent.requestDigest ||
          observation.idempotencyKey !== intent.idempotencyKey || !Array.isArray(observation.resourceIds) ||
          observation.resourceIds.length < 1) {
        throw Object.assign(new Error('stripe_observation_mismatch'), { code: 'stripe_observation_mismatch' });
      }
      if (receipts.has(intent.intentId)) {
        throw Object.assign(new Error('stripe_intent_already_reconciled'), {
          code: 'stripe_intent_already_reconciled',
        });
      }
      const receipt = { receiptId: `receipt-${attemptId}-${receipts.size + 1}`,
        intentId: intent.intentId, attemptId, fence: input.fence,
        observation: structuredClone(observation) };
      receipts.set(intent.intentId, receipt);
      return structuredClone(receipt);
    },
    async cleanup(input) {
      calls.cleanup.push(structuredClone(input));
      if (input.attemptId !== attemptId || input.fence !== currentFence) {
        throw Object.assign(new Error('lease_fence_lost'), { code: 'lease_fence_lost' });
      }
      if ([...intents.values()].some((intent) => intent.attemptId === attemptId &&
          !receipts.has(intent.intentId))) {
        throw Object.assign(new Error('stripe_intent_unresolved'), { code: 'stripe_intent_unresolved' });
      }
      return { cleanupStatus: 'complete', cleanupReceipt: { digest: 'f'.repeat(64) } };
    },
    async fixtureMutation(input, mutation) {
      calls.fixtureMutations.push(structuredClone(input));
      if (input.attemptId !== attemptId || input.fence !== currentFence) {
        throw Object.assign(new Error('lease_fence_lost'), { code: 'lease_fence_lost' });
      }
      return mutation(Object.freeze({ attemptId, fence: currentFence }));
    },
  };
  const mutationAdapter = {
    async mutate(request) {
      calls.mutations.push(structuredClone(request));
      return { id: 'cs_task6created', client_secret: 'sk_test_private_output',
        browserState: 'private-session-state' };
    },
    async mutateInTransaction(request, transaction) {
      if (transaction?.attemptId !== attemptId || transaction?.fence !== currentFence) {
        throw Object.assign(new Error('fixture_transaction_unverified'), {
          code: 'fixture_transaction_unverified',
        });
      }
      calls.mutations.push(structuredClone(request));
    },
  };
  const readers = { expectedEnvironment: preflight.expectedEnvironment,
    expectedWebhookEndpointId: preflight.providerVerification.stripe.webhookEndpointId,
    async assertReady() { return true; } };
  const readerBinding = Object.freeze({ attemptId, caseId: 'payment.approved',
    startedAt: '2026-09-23T09:00:00.000Z' });
  return { attempts, owner, preflight, mutationAdapter, readers, readerBinding, calls, intents, receipts };
}

export async function importIfMissing(importer) {
  try { return await importer(); }
  catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw error;
  }
}

export function needExport(module, name) {
  assert.equal(typeof module?.[name], 'function', `missing required export ${name}`);
  return module[name];
}

export function needValue(module, name) {
  assert.ok(module && Object.hasOwn(module, name), `missing required export ${name}`);
  return module[name];
}

export function databaseSnapshot({ observedAt = '2026-09-23T09:20:00.000Z',
  paymentSettled = false, changedUsage = false } = {}) {
  return {
    observedAt,
    attempts: [{ id: 'attempt-task6', quoteId: 'quote_task6', status: 'complete' }],
    contexts: [{ sessionId: 'cs_task6', attemptId: 'attempt-task6', status: paymentSettled ? 'complete' : 'pending' }],
    contracts: [{ id: 'contract_task6', status: paymentSettled ? 'active' : 'pending_payment' }],
    settlements: paymentSettled ? [{ id: 'set_task6', contractId: 'contract_task6', invoiceId: 'in_task6',
      subscriptionId: 'sub_task6', customerId: 'cus_task6', amount: 2500, currency: 'BRL',
      operation: 'subscription_initial', revision: 1 }] : [],
    grants: paymentSettled ? [{ id: 'grant_task6', contractId: 'contract_task6', area: 'area_task6', status: 'active' }] : [],
    revisions: paymentSettled ? [{ id: 'revision_task6', contractId: 'contract_task6', revision: 1,
      baseId: 'base_task6', agentIds: ['agent_task6'], includedUnits: 10 }] : [],
    usage: paymentSettled || changedUsage ? [{ id: 'usage_task6', contractId: 'contract_task6',
      includedUnits: changedUsage ? 11 : 10, consumedUnits: 0, reservedUnits: 0 }] : [],
  };
}

export const paymentIdentity = Object.freeze({ customerId: 'cus_task6', sessionId: 'cs_task6',
  checkoutSessionId: 'cs_task6', eventId: 'evt_task6', subscriptionId: 'sub_task6',
  invoiceId: 'in_task6', paymentIntentId: 'pi_task6', teamId: 'team_task6' });

export const startedAt = '2026-09-23T09:00:00.000Z';
const eventCreated = Math.floor(Date.parse('2026-09-23T09:10:00.000Z') / 1000);

export function paidProviderState(overrides = {}) {
  const invoice = { id: 'in_task6', livemode: false, customer: 'cus_task6', subscription: 'sub_task6',
    payment_intent: 'pi_task6',
    status: 'paid', amount_due: 2500, amount_paid: 2500, amount_remaining: 0, currency: 'brl',
    payments: { data: [{ payment: { payment_intent: 'pi_task6' } }], has_more: false },
    client_secret: 'pi_secret_private', metadata: { operatorCapability: 'private' } };
  const intent = { id: 'pi_task6', livemode: false, customer: 'cus_task6', status: 'succeeded',
    amount_received: 2500, currency: 'brl', latest_charge: 'ch_task6', client_secret: 'pi_secret_private' };
  const charge = { id: 'ch_task6', livemode: false, customer: 'cus_task6', payment_intent: 'pi_task6',
    paid: true, amount_captured: 2500, currency: 'brl', payment_method_details: { card: { three_d_secure: {
      authentication_flow: null, result: 'authenticated', result_reason: null } } } };
  const event = { id: 'evt_task6', type: 'invoice.paid', created: eventCreated, pending_webhooks: 0,
    livemode: false, account: environment.stripe.accountId, api_version: '2026-01-01',
    data: { object: { id: 'in_task6', customer: 'cus_task6' } } };
  const inbox = { eventId: 'evt_task6', eventType: 'invoice.paid', objectId: 'in_task6',
    accountId: environment.stripe.accountId, livemode: false, status: 'processed', attempts: 1,
    receivedAt: '2026-09-23T09:10:01.000Z', processedAt: '2026-09-23T09:10:02.000Z' };
  const receipt = { id: 'receipt_task6', eventId: 'evt_task6', eventType: 'invoice.paid', objectId: 'in_task6',
    accountId: environment.stripe.accountId, livemode: false, apiVersion: '2026-01-01',
    receivedAt: '2026-09-23T09:10:01.000Z' };
  const endpoint = { id: 'we_task6endpoint', livemode: false, created: eventCreated - 30,
    url: `${environment.deployment.origin}/api/stripe/webhook`, enabledEvents: ['invoice.paid'] };
  const checkoutSession = { id: 'cs_task6', livemode: false, status: 'complete', payment_status: 'paid',
    expires_at: Math.floor(Date.now() / 1000) + 3600 };
  return { invoice: { ...invoice, ...overrides.invoice }, intent: { ...intent, ...overrides.intent },
    charge: overrides.charge === null ? null : { ...charge, ...overrides.charge },
    checkoutSession: overrides.checkoutSession === null ? null : { ...checkoutSession, ...overrides.checkoutSession },
    event: { ...event, ...overrides.event }, inbox: { ...inbox, ...overrides.inbox },
    receipts: overrides.receipts ?? [{ ...receipt, ...overrides.receipt }], endpoint: { ...endpoint, ...overrides.endpoint } };
}

export function makeReaders({ provider = paidProviderState(), baseline = databaseSnapshot(),
  current = databaseSnapshot({ paymentSettled: true }), replayStates = [], accessDecision } = {}) {
  const calls = [];
  const stripe = {
    async retrieve(type, id) {
      calls.push(`stripe.retrieve:${type}:${id}`);
      if (type === 'invoice') return structuredClone(provider.invoice);
      if (type === 'payment_intent') return structuredClone(provider.intent);
      if (type === 'charge' && provider.charge) return structuredClone(provider.charge);
      if (type === 'checkout_session' && provider.checkoutSession) return structuredClone(provider.checkoutSession);
      throw new Error('unexpected_stripe_read');
    },
    async listEvents(query) { calls.push('stripe.listEvents'); assert.equal(query.objectId, 'in_task6'); return structuredClone(provider.event ? [provider.event] : []); },
    async retrieveWebhookEndpoint(id) { calls.push('stripe.retrieveWebhookEndpoint'); assert.equal(id, 'we_task6endpoint'); return structuredClone(provider.endpoint); },
    async retrieveEvent(id) { calls.push('stripe.retrieveEvent'); assert.equal(id, provider.event.id); return structuredClone(provider.event); },
  };
  const supabase = {
    async readBillingSnapshot({ phase }) {
      calls.push(`supabase.readBillingSnapshot:${phase}`);
      return structuredClone(phase === 'baseline' ? baseline : current);
    },
    async readWebhookInbox(id) { calls.push('supabase.readWebhookInbox'); assert.equal(id, provider.event.id); return structuredClone(provider.inbox); },
    async readWebhookReceipts(id) { calls.push('supabase.readWebhookReceipts'); assert.equal(id, provider.event.id); return structuredClone(provider.receipts); },
    async readAccessDecision(input) {
      calls.push('supabase.readAccessDecision');
      if (typeof accessDecision !== 'function') throw new Error('access_decision_not_configured');
      return structuredClone(await accessDecision(input));
    },
    async readReplayState(input) {
      calls.push('supabase.readReplayState');
      assert.equal(input.eventId, provider.event.id);
      if (replayStates.length === 0) throw new Error('replay_state_not_configured');
      return structuredClone(replayStates.shift());
    },
  };
  return { stripe, supabase, calls, expectedEnvironment: environment,
    expectedWebhookEndpointId: 'we_task6endpoint', async assertReady() { return true; } };
}

export function paidDatabaseSnapshot({ observedAt } = {}) {
  return databaseSnapshot({ ...(observedAt === undefined ? {} : { observedAt }), paymentSettled: true });
}

export class OpaqueChallengeWitness {
  #opaque = true;
}

export function challengeCapabilities({ verified = true, expectedFence = '11111111-1111-4111-8111-111111111111' } = {}) {
  const witness = Object.freeze(new OpaqueChallengeWitness());
  const brand = new WeakSet([witness]);
  const calls = [];
  return {
    witness,
    calls,
    provider: { async obtain(binding) { calls.push({ kind: 'obtain', binding: { ...binding } }); return witness; } },
    verifier: { async isOpaqueCapability(candidate) { return brand.has(candidate); }, async verify(candidate, binding) {
      calls.push({ kind: 'verify', candidate, binding: { ...binding } });
      return candidate === witness && verified && binding.attemptId === 'attempt-task6' &&
        binding.fence === expectedFence && binding.caseId.length > 0 && binding.paymentIntentId === 'pi_task6';
    } },
  };
}

class OpaqueManualResendCheckpoint {
  #opaque = true;
}

export function manualResendCapabilities({ verified = true, response, eventId = 'evt_task6' } = {}) {
  const witness = response ?? Object.freeze(new OpaqueManualResendCheckpoint());
  const brand = new WeakSet(response === undefined ? [witness] : []);
  const calls = [];
  return {
    calls,
    provider: { async request(binding) { calls.push({ kind: 'request', binding: { ...binding } }); return witness; } },
    verifier: { async isOpaqueCapability(candidate) { return brand.has(candidate); }, async verify(candidate, binding) {
      calls.push({ kind: 'verify', candidate, binding: { ...binding } });
      return candidate === witness && verified && binding.attemptId === 'attempt-task6' &&
        binding.caseId.length > 0 && binding.eventId === eventId;
    } },
  };
}

export function webhookReplayStates({ unchanged = true, fresh = true } = {}) {
  const baseTime = Date.now();
  const iso = (offset) => new Date(baseTime + offset).toISOString();
  const provider = paidProviderState();
  provider.receipts = provider.receipts.map((receipt) => ({ ...receipt, receivedAt: iso(-30_000) }));
  provider.inbox = { ...provider.inbox, receivedAt: iso(-30_000), processedAt: iso(-20_000) };
  const initialSnapshot = databaseSnapshot({ observedAt: iso(-15_000), paymentSettled: true });
  const beforeSnapshot = databaseSnapshot({ observedAt: iso(-10_000), paymentSettled: true });
  const first = { observedAt: iso(-10_000), inbox: provider.inbox,
    receipts: provider.receipts, snapshot: beforeSnapshot };
  const replayReceipt = { ...provider.receipts[0], id: 'receipt_task6_replay', receivedAt: iso(60_000) };
  const after = { observedAt: iso(61_000), inbox: provider.inbox,
    receipts: fresh ? [...provider.receipts, replayReceipt] : provider.receipts,
    snapshot: unchanged ? databaseSnapshot({ observedAt: iso(61_000), paymentSettled: true }) :
      databaseSnapshot({ observedAt: iso(61_000), paymentSettled: true, changedUsage: true }) };
  return { provider, initialSnapshot, states: [first, after] };
}

export function expectRefusal(promise, code) {
  return assert.rejects(promise, (error) => error?.code === code);
}
