import { createHash } from 'node:crypto';
import { ALL_THREE_DS_SCENARIOS, threeDsScenario } from './fixtures.mjs';
import { assertCurrentAttempt, BillingControlRefusal } from './contracts.mjs';
import { expectedGrantCount, hasNoFundsCollected, isValidExpectedAccess, matchingSettlementCount,
  observeFinancialEvidence } from './observations.mjs';
import { resendWebhookDelivery, verifyDelayedWebhookDelivery } from './financial.mjs';
import { verifyChallengeCapability } from './witnesses.mjs';

function refuse(code) { throw new BillingControlRefusal(code); }

function safeId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u.test(value) &&
    !/(?:secret|cookie|token|session_state)/iu.test(value);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function evidenceDigest(evidence, caseEvidence) {
  return createHash('sha256').update(canonical({ evidenceDigest: evidence.digest, caseEvidence }), 'utf8').digest('hex');
}

function noNewAccess(evidence) {
  return evidence.database.settlementCount === 0 && evidence.database.grantCount === 0 &&
    evidence.database.revisionCount === 0 && evidence.database.usageCount === 0 &&
    evidence.database.unchanged;
}

function paidState(evidence, expectedAccess, identity) {
  return evidence.provider.stripePaid && evidence.provider.authenticationResult === 'authenticated' &&
    evidence.webhook.processed && evidence.database.contextCount === 1 && evidence.database.settlementCount === 1 &&
    matchingSettlementCount(evidence, identity, expectedAccess?.contractId) === 1 &&
    expectedGrantCount(evidence, expectedAccess) === expectedAccess?.areas?.length;
}

async function verifyChallengeWitness({ context, caseId, intentId, challengeWitnessProvider, challengeVerifier }) {
  return verifyChallengeCapability({ context, caseId, paymentIntentId: intentId,
    challengeWitnessProvider, challengeVerifier });
}

async function observeExpiredCheckoutSession(identity, readers) {
  if (!/^cs_[A-Za-z0-9_]+$/u.test(identity?.checkoutSessionId ?? '') ||
      typeof readers?.stripe?.retrieve !== 'function') return null;
  let session;
  try { session = await readers.stripe.retrieve('checkout_session', identity.checkoutSessionId); }
  catch { return null; }
  if (session?.id !== identity.checkoutSessionId || session.livemode !== false || session.status !== 'expired' ||
      session.payment_status !== 'unpaid' || !Number.isSafeInteger(session.expires_at) ||
      session.expires_at > Math.floor(Date.now() / 1000)) return null;
  return Object.freeze({ checkoutSessionId: session.id, checkoutSessionStatus: 'expired',
    checkoutPaymentStatus: 'unpaid', checkoutExpiresAt: new Date(session.expires_at * 1000).toISOString() });
}

async function observeForeignActorDenial({ context, caseId, identity, readers }) {
  if (typeof readers?.supabase?.readAccessDecision !== 'function') return null;
  let decision;
  try {
    decision = await readers.supabase.readAccessDecision({ attemptId: context.owner.attemptId, caseId,
      sessionId: identity.sessionId, resourceTeamId: identity.teamId });
  } catch { return null; }
  if (!decision || !safeId(decision.actorTeamId) || !safeId(decision.resourceTeamId) ||
      typeof decision.allowed !== 'boolean' || !Number.isSafeInteger(decision.statusCode) ||
      typeof decision.reason !== 'string' || !/^[a-z_]{1,64}$/u.test(decision.reason)) return null;
  const denied = decision.actorTeamId !== decision.resourceTeamId && decision.resourceTeamId === identity.teamId &&
    decision.allowed === false && decision.statusCode === 403 && decision.reason === 'team_mismatch';
  return Object.freeze({ actorTeamId: decision.actorTeamId, resourceTeamId: decision.resourceTeamId,
    allowed: decision.allowed, statusCode: decision.statusCode, reason: decision.reason, denied });
}

export async function runThreeDsCase({ context, caseId, identity, readers, expectedAccess,
  startedAt, challengeWitnessProvider, challengeVerifier, resendCheckpointProvider,
  resendCheckpointVerifier } = {}) {
  if (!ALL_THREE_DS_SCENARIOS.includes(caseId)) refuse('three_ds_scenario_invalid');
  const scenario = threeDsScenario(caseId);
  if (scenario.supported === false) refuse('three_ds_scenario_unsupported');
  if (['paid_challenge', 'paid_frictionless'].includes(scenario.expectedOutcome) &&
      !isValidExpectedAccess(expectedAccess)) refuse('three_ds_expected_access_invalid');
  let evidence = await observeFinancialEvidence({ context, caseId, identity, readers, startedAt });
  const failures = [];
  const witnessVerified = scenario.challenge ? await verifyChallengeWitness({ context, caseId,
    intentId: evidence.provider.intentId, challengeWitnessProvider, challengeVerifier }) : false;
  if (scenario.challenge && !witnessVerified) failures.push('challenge_witness_unverified');

  let caseEvidence = {};
  let webhookReplay;
  let webhookDelayed;
  if (scenario.webhookDelayed) {
    try {
      webhookDelayed = await verifyDelayedWebhookDelivery({ context, caseId, identity,
        initialEvidence: evidence, readers, startedAt,
        resendCheckpointProvider, resendCheckpointVerifier });
      const postEvidence = await observeFinancialEvidence({ context, caseId, identity, readers, startedAt });
      const postObservedAt = Date.parse(postEvidence.observedAt);
      if (postEvidence.database.currentDigest !== webhookDelayed.postSnapshotDigest ||
          !Number.isFinite(postObservedAt) || postObservedAt < Date.parse(webhookDelayed.afterObservedAt) ||
          postEvidence.webhook.eventId !== webhookDelayed.eventId || postEvidence.webhook.pendingWebhooks !== 0 ||
          !postEvidence.webhook.processed || !paidState(postEvidence, expectedAccess, identity)) {
        failures.push('webhook_delay_post_reconciliation_unverified');
      }
      evidence = postEvidence;
      caseEvidence.webhookDelayed = webhookDelayed;
    } catch {
      failures.push('webhook_delay_unverified');
    }
  }
  if (scenario.negativeCase === 'expired_checkout') {
    const checkout = await observeExpiredCheckoutSession(identity, readers);
    if (checkout) caseEvidence = { ...caseEvidence, ...checkout };
    else failures.push('checkout_session_expiry_unverified');
  }
  if (scenario.negativeCase === 'foreign_actor') {
    const accessDecision = await observeForeignActorDenial({ context, caseId, identity, readers });
    if (accessDecision) caseEvidence.accessDecision = accessDecision;
    else failures.push('foreign_actor_denial_unverified');
  }
  if (scenario.webhookReplay) {
    try {
      webhookReplay = await resendWebhookDelivery({ context, caseId, eventId: evidence.webhook.eventId, readers,
        resendCheckpointProvider, resendCheckpointVerifier });
      caseEvidence.webhookReplay = webhookReplay;
    } catch {
      failures.push('webhook_replay_unverified');
    }
  }

  if (scenario.expectedOutcome === 'no_new_access' || scenario.expectedOutcome === 'incomplete') {
    if (!noNewAccess(evidence)) failures.push('unexpected_access');
    if (!hasNoFundsCollected(evidence)) failures.push('unexpected_payment');
    if (scenario.negativeCase === 'cancel' &&
        !(evidence.provider.intentStatus === 'canceled' && evidence.provider.chargeId &&
          evidence.provider.authenticationFlow === 'challenge' &&
          evidence.provider.authenticationResultReason === 'canceled')) failures.push('cancellation_not_verified');
    if (scenario.negativeCase === 'failure' &&
        !(evidence.provider.intentStatus === 'requires_payment_method' &&
          evidence.provider.authenticationResult === 'failed')) failures.push('challenge_failure_not_verified');
    if (scenario.negativeCase === 'authenticated_decline' &&
        !(evidence.provider.intentStatus === 'requires_payment_method' &&
          evidence.provider.authenticationResult === 'authenticated' && evidence.provider.declineCode)) {
      failures.push('authenticated_decline_not_verified');
    }
    if (scenario.negativeCase === 'incomplete' &&
        !(evidence.provider.intentStatus === 'requires_action' &&
          ['open', 'draft'].includes(evidence.provider.invoiceStatus))) failures.push('challenge_incomplete_not_verified');
    if (scenario.negativeCase === 'expired_checkout' &&
        !(caseEvidence.checkoutSessionStatus === 'expired' && evidence.provider.intentStatus !== 'succeeded' &&
          ['open', 'draft', 'void'].includes(evidence.provider.invoiceStatus))) failures.push('checkout_session_expiry_unverified');
    if (scenario.negativeCase === 'foreign_actor' &&
        caseEvidence.accessDecision?.denied !== true) failures.push('foreign_actor_denial_unverified');
  } else {
    const paymentReconciled = paidState(evidence, expectedAccess, identity);
    if (!paymentReconciled) failures.push('payment_reconciliation_incomplete');
    if (scenario.singleEffect && !paymentReconciled) failures.push('single_effect_not_unique');
    if (scenario.expectedOutcome === 'paid_challenge' &&
        !['challenge', null].includes(evidence.provider.authenticationFlow)) failures.push('authentication_flow_not_challenge');
    if (scenario.expectedOutcome === 'paid_frictionless' &&
        evidence.provider.authenticationFlow !== 'frictionless') failures.push('authentication_flow_not_frictionless');
  }

  await assertCurrentAttempt(context);
  const sanitizedEvidence = Object.freeze({ ...evidence, ...caseEvidence,
    digest: evidenceDigest(evidence, caseEvidence) });
  const outcome = failures.length ? 'failed' : scenario.expectedOutcome;
  return Object.freeze({ caseId, outcome, passed: failures.length === 0,
    failures: Object.freeze([...new Set(failures)]), challengeWitnessVerified: witnessVerified,
    singleEffectVerified: scenario.singleEffect === true && failures.length === 0,
    webhookReplay, webhookDelayed, evidence: sanitizedEvidence });
}
