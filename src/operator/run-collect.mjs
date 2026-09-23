import { runThreeDsCase } from '../billing/three-ds.mjs';
import { assertCurrentAttempt } from '../billing/contracts.mjs';
import { isValidExpectedAccess } from '../billing/observations.mjs';
import { threeDsScenario } from '../billing/fixtures.mjs';
import { createOperatorPanel, startOperatorEndpoint } from './endpoint.mjs';
import { createOperatorTransport } from './transport.mjs';

const SHA = /^[a-f0-9]{40}$/iu;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u;
const MAX_TIMEOUT_MS = 600_000;
const IDENTITY_KEYS = new Set(['customerId', 'sessionId', 'checkoutSessionId', 'eventId',
  'subscriptionId', 'invoiceId', 'paymentIntentId', 'teamId']);

export class OperatorRunRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = 'OperatorRunRefusal';
    this.code = code;
  }
}

function refuse(code) {
  throw new OperatorRunRefusal(code);
}

function safeId(value) {
  return typeof value === 'string' && SAFE_ID.test(value) &&
    !/(?:secret|cookie|token|session_state)/iu.test(value);
}

function sanitizedIdentity(identity) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return null;
  let prototype;
  let keys;
  try {
    prototype = Object.getPrototypeOf(identity);
    keys = Reflect.ownKeys(identity);
  } catch { return null; }
  if (prototype !== Object.prototype && prototype !== null) return null;
  if (keys.some((key) => typeof key !== 'string' || !IDENTITY_KEYS.has(key)) ||
      !['customerId', 'invoiceId', 'paymentIntentId', 'teamId'].every((key) => keys.includes(key))) return null;
  const projected = {};
  for (const key of keys) {
    let value;
    try { value = identity[key]; } catch { return null; }
    if (!safeId(value)) return null;
    projected[key] = value;
  }
  return Object.freeze(projected);
}

function validateInput({ candidateSha, controlContext, caseId, identity, readers,
  expectedAccess, startedAt, initializeBrowser, prepareScenario, timeoutMs, capabilityTtlMs }) {
  if (typeof candidateSha !== 'string' || !SHA.test(candidateSha)) refuse('operator_candidate_binding_invalid');
  const owner = controlContext?.owner;
  if (!safeId(owner?.attemptId) || !safeId(owner?.fence) ||
      typeof owner.candidateSha !== 'string' ||
      owner.candidateSha.toLowerCase() !== candidateSha.toLowerCase() ||
      !controlContext?.preflight?.expectedEnvironment || !controlContext?.preflight?.providerVerification) {
    refuse('operator_context_unverified');
  }

  let scenario;
  try { scenario = threeDsScenario(caseId); }
  catch { refuse('operator_scenario_unknown'); }
  if (scenario.supported === false) refuse('operator_scenario_unsupported');

  const trustedIdentity = sanitizedIdentity(identity);
  if (!trustedIdentity) refuse('operator_identity_invalid');
  if (['paid_challenge', 'paid_frictionless'].includes(scenario.expectedOutcome) &&
      !isValidExpectedAccess(expectedAccess)) refuse('operator_expected_access_invalid');
  if (typeof startedAt !== 'string' || !Number.isFinite(Date.parse(startedAt))) {
    refuse('operator_started_at_invalid');
  }
  if (readers?.stripe === undefined || typeof readers.stripe?.retrieve !== 'function' ||
      typeof readers.stripe?.listEvents !== 'function' ||
      typeof readers.stripe?.retrieveWebhookEndpoint !== 'function' ||
      typeof readers.supabase?.readBillingSnapshot !== 'function' ||
      typeof readers.supabase?.readWebhookInbox !== 'function' ||
      typeof readers.supabase?.readWebhookReceipts !== 'function' ||
      (scenario.webhookDelayed || scenario.webhookReplay) &&
        (typeof readers.stripe?.retrieveEvent !== 'function' ||
          typeof readers.supabase?.readReplayState !== 'function') ||
      scenario.negativeCase === 'foreign_actor' &&
        typeof readers.supabase?.readAccessDecision !== 'function') refuse('operator_readers_invalid');
  if (initializeBrowser !== undefined && typeof initializeBrowser !== 'function' ||
      prepareScenario !== undefined && typeof prepareScenario !== 'function') refuse('operator_hook_invalid');
  for (const duration of [timeoutMs, capabilityTtlMs]) {
    if (!Number.isSafeInteger(duration) || duration < 1 || duration > MAX_TIMEOUT_MS) {
      refuse('operator_timeout_invalid');
    }
  }
  return { scenario, owner, normalizedSha: candidateSha.toLowerCase(), identity: trustedIdentity };
}

async function closeQuietly(resource) {
  try { await resource?.close?.(); } catch { /* cleanup continues without exposing runtime details */ }
}

async function runAbortableHook(hook, hookContext, signal, failureCode) {
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(new OperatorRunRefusal('operator_closed'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([Promise.resolve().then(() => hook(hookContext)), aborted]);
  } catch {
    if (signal.aborted) refuse('operator_closed');
    refuse(failureCode);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function loadChromium() {
  try {
    const playwright = await import('playwright-core');
    if (typeof playwright.chromium?.launchServer !== 'function') refuse('operator_browser_unavailable');
    return playwright.chromium;
  } catch (error) {
    if (error instanceof OperatorRunRefusal) throw error;
    refuse('operator_browser_unavailable');
  }
}

export async function runCollect({ chromium, candidateSha, controlContext, caseId, identity, readers,
  expectedAccess, startedAt, initializeBrowser, prepareScenario, timeoutMs = 120_000,
  capabilityTtlMs = 120_000, randomBytes } = {}) {
  const { scenario, owner, normalizedSha, identity: trustedIdentity } = validateInput({ candidateSha, controlContext, caseId,
    identity, readers, expectedAccess, startedAt, initializeBrowser, prepareScenario,
    timeoutMs, capabilityTtlMs });

  // Task 5's lease remains authoritative. This is a fenced read only; this
  // transport neither extends nor releases an attempt.
  await assertCurrentAttempt(controlContext);

  const browserEngine = chromium ?? await loadChromium();
  const endpoint = await startOperatorEndpoint({ chromium: browserEngine,
    candidateSha: normalizedSha, attemptId: owner.attemptId, ...(randomBytes ? { randomBytes } : {}) });
  let context;
  let appPage;
  let panel;
  let transport;
  const abortController = new AbortController();
  let unsubscribe = () => {};

  try {
    const browser = endpoint.browser;
    context = await browser.newContext();
    transport = createOperatorTransport({ candidateSha: normalizedSha, attemptId: owner.attemptId,
      timeoutMs, capabilityTtlMs, ...(randomBytes ? { randomBytes } : {}),
      publish: (request) => panel?.present(request) });
    panel = await createOperatorPanel({ context, onSignal: async (signal) => {
      const accepted = await transport.acceptSignal(signal);
      if (accepted && signal?.type === 'abort') abortController.abort();
      return accepted;
    } });
    appPage = await context.newPage();
    unsubscribe = endpoint.onDisconnected(() => {
      abortController.abort();
      void transport.close();
    });

    if (endpoint.closed) refuse('operator_closed');
    const hookContext = Object.freeze({ page: appPage, context, caseId, identity: trustedIdentity,
      origin: controlContext.preflight.expectedEnvironment.deployment.origin,
      signal: abortController.signal });
    if (initializeBrowser) {
      await runAbortableHook(initializeBrowser, hookContext, abortController.signal,
        'operator_browser_initialization_failed');
    }
    if (endpoint.closed || abortController.signal.aborted) refuse('operator_closed');
    if (prepareScenario) {
      await runAbortableHook(prepareScenario, hookContext, abortController.signal,
        'operator_scenario_prepare_failed');
    }
    if (endpoint.closed || abortController.signal.aborted) refuse('operator_closed');

    const result = await runThreeDsCase({ context: controlContext, caseId, identity: trustedIdentity, readers,
      expectedAccess, startedAt,
      challengeWitnessProvider: transport.challengeWitnessProvider,
      challengeVerifier: transport.challengeVerifier,
      resendCheckpointProvider: transport.resendCheckpointProvider,
      resendCheckpointVerifier: transport.resendCheckpointVerifier });
    if (endpoint.closed || abortController.signal.aborted) refuse('operator_closed');
    return result;
  } finally {
    unsubscribe();
    abortController.abort();
    await closeQuietly(transport);
    await closeQuietly(panel);
    await closeQuietly(appPage);
    await closeQuietly(context);
    await endpoint.close();
  }
}
