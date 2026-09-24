import { createHash } from 'node:crypto';
import { assertCurrentAttempt, mutateProvider, BillingControlRefusal } from './contracts.mjs';
import { databaseSnapshotDigest, databaseSnapshotsEqual, sanitizeDatabaseSnapshot } from './observations.mjs';

export class BillingCleanupRefusal extends Error {
  constructor(code, details = {}) { super(code); this.name = 'BillingCleanupRefusal'; this.code = code;
    Object.assign(this, details); }
}

function refuse(code) { throw new BillingCleanupRefusal(code); }

const RESOURCE_PREFIX = Object.freeze({ customer: 'cus_', checkout_session: 'cs_', payment_intent: 'pi_',
  invoice: 'in_', subscription: 'sub_', charge: 'ch_', setup_intent: 'seti_', event: 'evt_' });
const RETAINED_TYPES = new Set(['payment_intent', 'invoice', 'charge', 'setup_intent', 'event']);
const DATABASE_RESOURCE_TARGETS = Object.freeze({
  checkout_attempt: Object.freeze({ schema: 'public', table: 'billing_checkout_attempts', snapshotTable: 'attempts', snapshotId: 'id' }),
  payment_context: Object.freeze({ schema: 'public', table: 'billing_payment_contexts', snapshotTable: 'contexts', snapshotId: 'sessionId' }),
  contract: Object.freeze({ schema: 'public', table: 'billing_contracts', snapshotTable: 'contracts', snapshotId: 'id' }),
  settlement_effect: Object.freeze({ schema: 'public', table: 'billing_settlement_effects', snapshotTable: 'settlements', snapshotId: 'id' }),
  area_grant: Object.freeze({ schema: 'public', table: 'billing_area_grants', snapshotTable: 'grants', snapshotId: 'id' }),
  contract_revision: Object.freeze({ schema: 'public', table: 'billing_contract_revisions', snapshotTable: 'revisions', snapshotId: 'id' }),
  usage_period: Object.freeze({ schema: 'public', table: 'billing_usage_periods', snapshotTable: 'usage', snapshotId: 'id' }),
  usage_event: Object.freeze({ schema: 'public', table: 'billing_usage_events', snapshotTable: 'usage', snapshotId: 'id' }),
  auth_user: Object.freeze({ schema: 'auth', table: 'users', snapshotTable: null, snapshotId: null }),
});
const SNAPSHOT_TABLES = Object.freeze(['attempts', 'contexts', 'contracts', 'settlements', 'grants', 'revisions', 'usage']);

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

function validResource(resource, owner, environment) {
  const prefix = RESOURCE_PREFIX[resource?.type];
  return resource && Object.keys(resource).length === 7 &&
    ['id', 'type', 'status', 'ownerAttemptId', 'accountId', 'livemode', 'sequence']
      .every((key) => Object.hasOwn(resource, key)) && prefix && resource.id.startsWith(prefix) &&
    /^[A-Za-z0-9_]{1,120}$/u.test(resource.id.slice(prefix.length)) && safeId(resource.id) &&
    /^[a-z_]{1,64}$/u.test(resource.status) && resource.ownerAttemptId === owner.attemptId &&
    resource.accountId === environment.stripe.accountId && resource.livemode === false &&
    Number.isSafeInteger(resource.sequence) && resource.sequence >= 0 && owner.resourceIds.includes(resource.id);
}

function inventory(resources, context) {
  if (!Array.isArray(resources) || !resources.every((item) => validResource(item, context.owner,
      context.preflight.expectedEnvironment)) || new Set(resources.map((item) => item.id)).size !== resources.length) {
    refuse('cleanup_ownership_invalid');
  }
  return [...resources].sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
}

function ownedDatabaseRows(rows, context) {
  if (!Array.isArray(rows) || !rows.every((row) => row && Object.keys(row).length === 3 &&
      Object.keys(row).every((key) => ['kind', 'id', 'ownerAttemptId'].includes(key)) &&
      Object.hasOwn(DATABASE_RESOURCE_TARGETS, row.kind) && safeId(row.id) &&
      row.ownerAttemptId === context.owner.attemptId) ||
      new Set(rows.map((row) => `${row.kind}:${row.id}`)).size !== rows.length) {
    refuse('cleanup_database_ownership_invalid');
  }
  return rows.map(({ kind, id, ownerAttemptId }) => ({ kind, id, ownerAttemptId,
    ...DATABASE_RESOURCE_TARGETS[kind] }))
    .sort((a, b) => a.schema.localeCompare(b.schema) || a.table.localeCompare(b.table) || a.id.localeCompare(b.id));
}

function providerAction(resource) {
  if (resource.type === 'customer') return { action: null, retainedStatus: 'retained_test_customer' };
  if (resource.type === 'checkout_session') {
    if (resource.status === 'open') return { action: 'checkout_session.expire', retainedAfter: 'expired' };
    if (resource.status === 'expired' || resource.status === 'complete') {
      return { action: null, retainedStatus: resource.status === 'expired' ? 'expired_test_checkout_session' : 'completed_test_checkout_session' };
    }
    refuse('cleanup_resource_state_unsupported');
  }
  if (resource.type === 'subscription') {
    if (['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused'].includes(resource.status)) {
      return { action: 'subscription.cancel', retainedAfter: 'canceled' };
    }
    if (['canceled', 'incomplete_expired'].includes(resource.status)) {
      return { action: null, retainedStatus: 'canceled_test_subscription' };
    }
    refuse('cleanup_resource_state_unsupported');
  }
  if (RETAINED_TYPES.has(resource.type)) return { action: null, retainedStatus: 'retained_test_financial_object' };
  refuse('cleanup_resource_type_unsupported');
}

function expectedInventory(initial) {
  return initial.map((resource) => {
    const plan = providerAction(resource);
    const status = plan.retainedAfter ?? (plan.action === 'checkout_session.expire' ? 'expired' :
      plan.action === 'subscription.cancel' ? 'canceled' : resource.status);
    return { id: resource.id, type: resource.type, status };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function summarizedRetained(initial) {
  return initial.flatMap((resource) => {
    const plan = providerAction(resource);
    const status = plan.retainedStatus ?? (resource.type === 'checkout_session' && plan.retainedAfter
      ? 'expired_test_checkout_session' : plan.retainedAfter ? `retained_test_${resource.type}` : null);
    return status ? [{ id: resource.id, type: resource.type, status }] : [];
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function summarizedDatabaseRetention(rows) {
  return rows.map(({ kind, id, ownerAttemptId, schema, table }) => ({ kind, id, ownerAttemptId,
    schema, table, status: 'retained_test_database_evidence' }))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
}

function ownedActiveAccess(current, ownedRows) {
  const contractIds = new Set(ownedRows.filter((row) => row.kind === 'contract').map((row) => row.id));
  const grantIds = new Set(ownedRows.filter((row) => row.kind === 'area_grant').map((row) => row.id));
  return {
    contractIds: current.contracts.filter((row) => contractIds.has(row.id) && row.status === 'active')
      .map((row) => row.id).sort(),
    grantIds: current.grants.filter((row) => grantIds.has(row.id) && row.status === 'active')
      .map((row) => row.id).sort(),
  };
}

function refuseWithRetainedEvidence(code, databaseRows, activeAccess = { contractIds: [], grantIds: [] }) {
  const error = new BillingCleanupRefusal(code, {
    fixtureReusable: false,
    databaseBaselineRestored: false,
    retainedDatabaseResources: Object.freeze(summarizedDatabaseRetention(databaseRows)),
    activeDatabaseAccess: Object.freeze({ contractIds: Object.freeze(activeAccess.contractIds),
      grantIds: Object.freeze(activeAccess.grantIds) }),
  });
  throw error;
}

function comparable(resources) {
  return resources.map(({ id, type, status }) => ({ id, type, status }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function rowsDifference(rows, baselineRows) {
  const remaining = new Map();
  for (const row of baselineRows) {
    const key = canonical(row);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  const extras = [];
  for (const row of rows) {
    const key = canonical(row);
    const count = remaining.get(key) ?? 0;
    if (count) remaining.set(key, count - 1);
    else extras.push(row);
  }
  return { extras, baselineMissing: [...remaining.values()].some((count) => count > 0) };
}

function verifyDatabaseOwnershipProjection(baseline, current, ownedRows) {
  const retained = ownedRows.filter((row) => row.snapshotTable !== null);
  for (const table of SNAPSHOT_TABLES) {
    const diff = rowsDifference(current[table], baseline[table]);
    if (diff.baselineMissing) refuse('cleanup_database_changed');
    const expected = retained.filter((row) => row.snapshotTable === table);
    const expectedIds = expected.map((row) => row.id);
    if (new Set(expectedIds).size !== expectedIds.length) refuse('cleanup_database_ownership_invalid');
    const actualIds = diff.extras.map((row) => row[expected[0]?.snapshotId ?? 'id']);
    if (diff.extras.some((row) => !safeId(row[expected[0]?.snapshotId ?? 'id']) ||
        !expectedIds.includes(row[expected[0]?.snapshotId ?? 'id']))) refuse('cleanup_database_unowned_delta');
    if (actualIds.length !== expectedIds.length || expectedIds.some((id) => !actualIds.includes(id))) {
      refuse('cleanup_database_retained_evidence_missing');
    }
  }
}

function sameDatabaseResourceInventory(before, after) {
  return canonical(before.map(({ kind, id, ownerAttemptId, schema, table }) =>
    ({ kind, id, ownerAttemptId, schema, table }))) === canonical(after.map(({ kind, id, ownerAttemptId, schema, table }) =>
    ({ kind, id, ownerAttemptId, schema, table })));
}

export async function cleanupOwnedResources({ context, adapter } = {}) {
  if (!context?.attempts || !Array.isArray(context.owner?.resourceIds) ||
      typeof adapter?.listOwnedResources !== 'function' ||
      typeof adapter?.listOwnedDatabaseResources !== 'function' ||
      typeof adapter?.readDatabaseBaseline !== 'function' ||
      typeof adapter?.readDatabaseCurrent !== 'function') refuse('cleanup_input_invalid');

  let baseline;
  let initial;
  let initialDatabaseRows;
  let beforeDatabase;
  try {
    await assertCurrentAttempt(context);
    baseline = sanitizeDatabaseSnapshot(await adapter.readDatabaseBaseline({ attemptId: context.owner.attemptId,
      fence: context.owner.fence, environment: context.preflight.expectedEnvironment }));
    initial = inventory(await adapter.listOwnedResources({ attemptId: context.owner.attemptId,
      fence: context.owner.fence, environment: context.preflight.expectedEnvironment }), context);
    initialDatabaseRows = ownedDatabaseRows(await adapter.listOwnedDatabaseResources({
      attemptId: context.owner.attemptId, fence: context.owner.fence,
      environment: context.preflight.expectedEnvironment }), context);
    beforeDatabase = sanitizeDatabaseSnapshot(await adapter.readDatabaseCurrent({ attemptId: context.owner.attemptId,
      fence: context.owner.fence, environment: context.preflight.expectedEnvironment, phase: 'before-cleanup' }));
    verifyDatabaseOwnershipProjection(baseline, beforeDatabase, initialDatabaseRows);
  } catch (error) {
    if (error instanceof BillingCleanupRefusal || error instanceof BillingControlRefusal) throw error;
    refuse('cleanup_observation_failed');
  }

  const activeAccess = ownedActiveAccess(beforeDatabase, initialDatabaseRows);
  if (activeAccess.contractIds.length || activeAccess.grantIds.length) {
    refuseWithRetainedEvidence('cleanup_database_active_access_retained', initialDatabaseRows, activeAccess);
  }
  if (initialDatabaseRows.length) {
    refuseWithRetainedEvidence('cleanup_database_retained_not_reusable', initialDatabaseRows, activeAccess);
  }

  const retainedObjects = summarizedRetained(initial);
  const retainedDatabaseResources = [];
  const toActOn = initial.filter((resource) => providerAction(resource).action !== null).reverse();
  const mutatedResourceIds = [];
  for (const resource of toActOn) {
    const plan = providerAction(resource);
    try {
      await mutateProvider(context, { provider: 'stripe', action: plan.action,
        operation: `cleanup:${resource.id}`,
        input: { resourceId: resource.id, resourceType: resource.type } });
      mutatedResourceIds.push(resource.id);
    } catch {
      refuse('cleanup_mutation_failed');
    }
  }

  try {
    await mutateProvider(context, { provider: 'supabase', action: 'fixtures.cleanup',
      operation: 'cleanup:database-fixtures', input: { databaseResources: [] } });
  } catch {
    refuse('cleanup_mutation_failed');
  }

  let after;
  let afterDatabaseRows;
  let current;
  try {
    await assertCurrentAttempt(context);
    after = inventory(await adapter.listOwnedResources({ attemptId: context.owner.attemptId,
      fence: context.owner.fence, environment: context.preflight.expectedEnvironment }), context);
    afterDatabaseRows = ownedDatabaseRows(await adapter.listOwnedDatabaseResources({
      attemptId: context.owner.attemptId, fence: context.owner.fence,
      environment: context.preflight.expectedEnvironment }), context);
    current = sanitizeDatabaseSnapshot(await adapter.readDatabaseCurrent({ attemptId: context.owner.attemptId,
      fence: context.owner.fence, environment: context.preflight.expectedEnvironment, phase: 'after-cleanup' }));
    verifyDatabaseOwnershipProjection(baseline, current, afterDatabaseRows);
  } catch (error) {
    if (error instanceof BillingCleanupRefusal || error instanceof BillingControlRefusal) throw error;
    refuse('cleanup_reobservation_failed');
  }

  if (JSON.stringify(comparable(after)) !== JSON.stringify(expectedInventory(initial))) {
    refuse('cleanup_resource_leaked');
  }
  if (!sameDatabaseResourceInventory(initialDatabaseRows, afterDatabaseRows)) {
    refuse('cleanup_database_retained_evidence_missing');
  }
  if (!databaseSnapshotsEqual(beforeDatabase, current)) refuse('cleanup_database_changed');

  try { await context.attempts.cleanup({ attemptId: context.owner.attemptId, fence: context.owner.fence }); }
  catch { refuse('cleanup_lease_release_failed'); }
  const databaseBaselineDigest = databaseSnapshotDigest(baseline);
  const cleanupClaim = 'owned_reversible_provider_fixtures_only';
  const cleanupDigest = createHash('sha256').update(JSON.stringify({ mutatedResourceIds, retainedObjects,
    retainedDatabaseResources, databaseBaselineDigest, cleanupClaim }), 'utf8').digest('hex');
  return Object.freeze({ completed: true, cleanupClaim, databaseBaselineRestored: databaseSnapshotsEqual(baseline, current),
    fixtureReusable: true,
    mutatedResourceIds: Object.freeze(mutatedResourceIds), retainedObjects: Object.freeze(retainedObjects),
    retainedDatabaseResources: Object.freeze(retainedDatabaseResources), removedDatabaseFixtureCount: 0,
    databaseBaselineDigest, cleanupDigest });
}
