import { randomUUID } from 'node:crypto';
import { BILLING_43_IDS } from '../contracts/billing-43.mjs';
import { isActiveFixtureMutationTransaction } from '../attempts/store.mjs';
import { assertCurrentAttempt } from './contracts.mjs';

const CASE_SET = new Set(BILLING_43_IDS);
const SIGNUP_CASES = new Set(['signup.native', 'signup.join', 'signup.expired-intent',
  'signup.tampered-intent', 'signup.replay']);
const FIXTURE_KINDS = new Set(['catalog', 'billing_identity']);
const FIXTURE_MARKER = 'lawx-billing-validation-synthetic-v1';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export class BillingFixtureRefusal extends Error {
  constructor(code) { super(code); this.name = 'BillingFixtureRefusal'; this.code = code; }
}

function refuse(code) { throw new BillingFixtureRefusal(code); }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function exactInput(value, allowedKeys) {
  if (!record(value)) return false;
  let keys;
  try { keys = Reflect.ownKeys(value); } catch { return false; }
  return keys.every((key) => typeof key === 'string' && allowedKeys.includes(key)) &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true;
    });
}

function same(left, right) {
  try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
}

function capacityRows(owner) {
  const requested = owner?.capacity?.requested?.databaseRows;
  return Number.isSafeInteger(requested) && requested > 0 ? requested : 0;
}

function makeFixtureSnapshot(value) {
  if (!record(value) || !UUID.test(value.fixtureId ?? '') || !UUID.test(value.namespaceId ?? '') ||
      !SAFE_ID.test(value.attemptId ?? '') || !CASE_SET.has(value.caseId) || !FIXTURE_KINDS.has(value.kind) ||
      value.marker !== FIXTURE_MARKER || value.synthetic !== true) refuse('fixture_readback_invalid');
  return Object.freeze({ fixtureId: value.fixtureId, namespaceId: value.namespaceId,
    attemptId: value.attemptId, caseId: value.caseId, kind: value.kind,
    marker: value.marker, synthetic: true });
}

export function createAttemptFixtureRun({ context, publisher, readers, startedAt } = {}) {
  const owner = context?.owner;
  const expectedEnvironment = context?.preflight?.expectedEnvironment;
  const expectedWebhookEndpointId = context?.preflight?.providerVerification?.stripe?.webhookEndpointId;
  if (!owner || !SAFE_ID.test(owner.attemptId ?? '') || !SAFE_ID.test(owner.fence ?? '') ||
      !SAFE_ID.test(owner.reservationId ?? '') || !expectedEnvironment ||
      !same(owner.environment, expectedEnvironment) || !Number.isFinite(Date.parse(startedAt)) ||
      typeof context?.attempts?.assertFence !== 'function' ||
      typeof context.attempts.fixtureMutationWithReservation !== 'function' ||
      capacityRows(owner) < 1 || typeof publisher?.assertReady !== 'function' ||
      typeof publisher?.insertAttemptFixture !== 'function' ||
      readers?.expectedEnvironment === undefined || !same(readers.expectedEnvironment, expectedEnvironment) ||
      readers.expectedWebhookEndpointId !== expectedWebhookEndpointId ||
      typeof readers.assertReady !== 'function' || typeof readers.supabase?.listAttemptFixtures !== 'function' ||
      typeof readers.supabase?.readSyntheticFixture !== 'function') refuse('fixture_run_unavailable');

  const opened = new Set();
  const namespaces = new Map();
  const allocatedIds = new Set();
  let nextCaseIndex = 0;

  function allocateUuid() {
    let id;
    do { id = randomUUID(); } while (allocatedIds.has(id));
    allocatedIds.add(id);
    return id;
  }

  function openCase(caseId) {
    if (typeof caseId !== 'string' || !CASE_SET.has(caseId)) refuse('fixture_case_invalid');
    if (opened.has(caseId)) refuse('fixture_case_duplicate');
    if (BILLING_43_IDS[nextCaseIndex] !== caseId) refuse('fixture_case_order_invalid');
    opened.add(caseId);
    nextCaseIndex += 1;
    const namespaceId = allocateUuid();
    namespaces.set(caseId, namespaceId);
    let unresolvedMutation = false;
    const published = new Set();

    async function publish(input) {
      if (!exactInput(input, ['kind']) || !FIXTURE_KINDS.has(input.kind) || published.has(input.kind)) {
        refuse('fixture_input_invalid');
      }
      if (unresolvedMutation) refuse('fixture_mutation_unresolved');
      const fixtureId = allocateUuid();
      const binding = Object.freeze({ attemptId: owner.attemptId, caseId, startedAt });
      try { await readers.assertReady(binding); } catch { refuse('fixture_readers_unavailable'); }
      await assertCurrentAttempt(context);
      const publisherBinding = Object.freeze({ attemptId: owner.attemptId,
        reservationId: owner.reservationId, fence: owner.fence, environment: expectedEnvironment });
      try { await publisher.assertReady(publisherBinding); }
      catch { refuse('fixture_publisher_unavailable'); }

      let existing;
      try {
        existing = await readers.supabase.listAttemptFixtures({ ...binding,
          namespaceId, environment: expectedEnvironment });
      } catch { refuse('fixture_reader_unavailable'); }
      if (!Array.isArray(existing) || existing.some((row) => row?.fixtureId === fixtureId)) {
        refuse('fixture_inventory_invalid');
      }

      const request = Object.freeze({ attemptId: owner.attemptId, reservationId: owner.reservationId,
        fence: owner.fence, environment: expectedEnvironment, caseId, namespaceId, fixtureId,
        kind: input.kind, marker: FIXTURE_MARKER, synthetic: true });
      let receipt;
      unresolvedMutation = true;
      try {
        receipt = await context.attempts.fixtureMutationWithReservation({ attemptId: owner.attemptId,
          fence: owner.fence, reservationId: owner.reservationId,
          rows: Object.freeze({ databaseRows: 1 }) }, async (transaction) => {
          if (!record(transaction) || transaction.attemptId !== owner.attemptId ||
              !isActiveFixtureMutationTransaction(transaction) ||
              transaction.fence !== owner.fence || transaction.reservationId !== owner.reservationId ||
              typeof transaction.transactionId !== 'string' || !SAFE_ID.test(transaction.transactionId) ||
              transaction.reservationLocked !== true || transaction.reservationValidated !== true ||
              transaction.reservationStatus !== 'active' || transaction.reservationSettled !== false ||
              !Number.isSafeInteger(transaction.remainingDatabaseRows) ||
              transaction.remainingDatabaseRows < 1) refuse('fixture_transaction_unavailable');
          return publisher.insertAttemptFixture(Object.freeze({ ...request, transaction }));
        });
      } catch (error) {
        if (['lease_fence_lost', 'lease_expired', 'fixture_reservation_insufficient',
          'fixture_reservation_invalid', 'retention_reservation_missing', 'retention_attempt_settled',
          'recovery_read_only', 'fixture_transaction_unavailable', 'fixture_mutation_ambiguous'].includes(error?.code)) {
          refuse(error.code);
        }
        refuse('fixture_mutation_ambiguous');
      }
      if (!receipt || receipt.inserted !== true || receipt.fixtureId !== fixtureId ||
          receipt.attemptId !== owner.attemptId || receipt.caseId !== caseId) {
        refuse('fixture_mutation_ambiguous');
      }

      let readback;
      try {
        readback = await readers.supabase.readSyntheticFixture({ ...binding,
          namespaceId, fixtureId, environment: expectedEnvironment });
      } catch { refuse('fixture_readback_failed'); }
      const snapshot = makeFixtureSnapshot(readback);
      if (snapshot.fixtureId !== fixtureId || snapshot.namespaceId !== namespaceId ||
          snapshot.attemptId !== owner.attemptId || snapshot.caseId !== caseId || snapshot.kind !== input.kind) {
        refuse('fixture_readback_mismatch');
      }
      unresolvedMutation = false;
      published.add(input.kind);
      return snapshot;
    }

    return Object.freeze({ caseId, namespaceId, publish });
  }

  return Object.freeze({ attemptId: owner.attemptId, openCase });
}

export async function assertNativeSignupReady({ caseId } = {}) {
  if (typeof caseId !== 'string' || !SIGNUP_CASES.has(caseId)) refuse('signup_case_invalid');
  // No verifier-owned signup policy or isolated inbox capability exists yet.
  // Caller booleans and caller-implemented `verify()` callbacks are not evidence.
  refuse('signup_confirmation_policy_unverified');
}
