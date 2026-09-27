import { readFile } from 'node:fs/promises';
import { isValidExpectedEnvironment } from '../contracts/evidence.mjs';
import { createAttemptStore, refuse } from './store.mjs';
import { RETENTION_QUOTA_KEYS } from './prepare.mjs';

const PRODUCTION_LABEL = /(?:^|[-_.])(?:main|master|prod|production|primary|default)(?:$|[-_.])/i;
const PROJECT_REF = /^[a-z0-9]{20}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
function stringMatches(value, pattern) { return typeof value === 'string' && pattern.test(value); }
function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function snapshotDataRecord(value, fields, { exact = true } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  let prototype;
  let ownKeys;
  try {
    prototype = Object.getPrototypeOf(value);
    ownKeys = Reflect.ownKeys(value);
  } catch { return null; }
  if ((prototype !== Object.prototype && prototype !== null) ||
      (exact && (ownKeys.length !== fields.length ||
        ownKeys.some((key) => typeof key !== 'string' || !fields.includes(key))))) return null;
  const snapshot = Object.create(null);
  try {
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) return null;
      snapshot[field] = descriptor.value;
    }
  } catch { return null; }
  return snapshot;
}

function snapshotEnvironment(value) {
  const fields = snapshotDataRecord(value, ['database', 'deployment', 'stripe']);
  if (!fields) return null;
  const database = snapshotDataRecord(fields.database, ['projectRef', 'branchId']);
  const deployment = snapshotDataRecord(fields.deployment, ['id', 'origin']);
  const stripe = snapshotDataRecord(fields.stripe, ['accountId']);
  if (!database || !deployment || !stripe) return null;
  return Object.freeze({
    database: Object.freeze({ projectRef: database.projectRef, branchId: database.branchId }),
    deployment: Object.freeze({ id: deployment.id, origin: deployment.origin }),
    stripe: Object.freeze({ accountId: stripe.accountId }),
  });
}

function snapshotPreflight(value) {
  const fields = snapshotDataRecord(value, ['expectedEnvironment', 'providerVerification'], { exact: false });
  if (!fields) return null;
  const expectedEnvironment = snapshotEnvironment(fields.expectedEnvironment);
  const provider = snapshotDataRecord(fields.providerVerification, ['supabase', 'stripe']);
  if (!expectedEnvironment || !provider) return null;
  const supabase = snapshotDataRecord(provider.supabase, ['projectRef', 'parentProjectRef', 'branchId',
    'branchName', 'schemaFingerprintSha256', 'migrationHistorySha256']);
  const stripe = snapshotDataRecord(provider.stripe, ['accountId', 'webhookEndpointId', 'webhookUrl', 'livemode']);
  if (!supabase || !stripe) return null;
  return Object.freeze({ expectedEnvironment,
    providerVerification: Object.freeze({ supabase: Object.freeze(supabase), stripe: Object.freeze(stripe) }) });
}

function snapshotTarget(value) {
  const fields = snapshotDataRecord(value, ['projectRef', 'parentProjectRef', 'branchId', 'branchName',
    'isDefault', 'status', 'isolated'], { exact: false });
  return fields ? Object.freeze(fields) : null;
}

function verifiedTarget(preflight, target) {
  const expectedEnvironment = preflight?.expectedEnvironment;
  const expected = expectedEnvironment?.database;
  const verified = preflight?.providerVerification?.supabase;
  const stripe = preflight?.providerVerification?.stripe;
  return isValidExpectedEnvironment(expectedEnvironment) &&
    exactKeys(preflight?.providerVerification, ['supabase', 'stripe']) &&
    exactKeys(verified, ['projectRef', 'parentProjectRef', 'branchId', 'branchName',
      'schemaFingerprintSha256', 'migrationHistorySha256']) &&
    exactKeys(stripe, ['accountId', 'webhookEndpointId', 'webhookUrl', 'livemode']) &&
    typeof stripe.accountId === 'string' && typeof stripe.webhookUrl === 'string' &&
    stripe.accountId === expectedEnvironment.stripe.accountId && stripe.livemode === false &&
    stringMatches(stripe.webhookEndpointId, /^we_[A-Za-z0-9]+$/) &&
    stripe.webhookUrl === `${expectedEnvironment.deployment.origin}/api/stripe/webhook` &&
    target &&
    stringMatches(verified.projectRef, PROJECT_REF) && stringMatches(verified.parentProjectRef, PROJECT_REF) &&
    stringMatches(verified.branchId, BRANCH) && stringMatches(verified.branchName, BRANCH) &&
    stringMatches(verified.schemaFingerprintSha256, DIGEST) &&
    stringMatches(verified.migrationHistorySha256, DIGEST) &&
    stringMatches(target.projectRef, PROJECT_REF) && stringMatches(target.parentProjectRef, PROJECT_REF) &&
    stringMatches(target.branchId, BRANCH) && stringMatches(target.branchName, BRANCH) &&
    target.projectRef === expected.projectRef && target.branchId === expected.branchId &&
    verified.projectRef === target.projectRef && verified.branchId === target.branchId &&
    verified.parentProjectRef === target.parentProjectRef && verified.branchName === target.branchName &&
    typeof target.parentProjectRef === 'string' && target.parentProjectRef !== target.projectRef &&
    target.isDefault === false && target.isolated === true && target.status === 'ACTIVE_HEALTHY' &&
    !PRODUCTION_LABEL.test(target.branchId) && !PRODUCTION_LABEL.test(target.branchName) &&
    !PRODUCTION_LABEL.test(verified.branchId) && !PRODUCTION_LABEL.test(verified.branchName);
}

function assertWiring({ client, preflight, target }) {
  const preflightSnapshot = snapshotPreflight(preflight);
  const targetSnapshot = snapshotTarget(target);
  if (!preflightSnapshot || !targetSnapshot || !verifiedTarget(preflightSnapshot, targetSnapshot) ||
      typeof client?.transaction !== 'function') refuse('schema_target_unverified');
  return { preflight: preflightSnapshot, target: targetSnapshot };
}

function keyValues(key) { return [key.branchId, key.suite, key.fixtureKey]; }
function rowFromDb(db) {
  if (!db) return null;
  return {
    attemptId: db.attempt_id,
    key: { branchId: db.branch_id, suite: db.suite, fixtureKey: db.fixture_key },
    candidateSha: db.candidate_sha.trim(),
    workflow: { repository: db.workflow_repository, ref: db.workflow_ref,
      runId: db.workflow_run_id, runAttempt: db.workflow_run_attempt, runnerLabel: db.runner_label },
    environment: { database: { projectRef: db.database_project_ref.trim(), branchId: db.branch_id },
      deployment: { id: db.deployment_id, origin: db.deployment_origin },
      stripe: { accountId: db.stripe_account_id } },
    state: db.state, cleanupStatus: db.cleanup_status,
    artifact: db.artifact_id ? { id: db.artifact_id, digest: db.artifact_digest.trim(), schema: db.artifact_schema,
      retentionDays: 2 } : null,
    resourceIds: db.resource_ids,
    createdAt: Number(db.created_at_epoch), updatedAt: Number(db.updated_at_epoch),
  };
}

function jsonValue(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { refuse('retention_ledger_invalid'); }
}

function retentionReservationFromDb(db) {
  if (!db) return null;
  return {
    reservationId: db.reservation_id,
    attemptId: db.attempt_id,
    scope: { projectRef: db.project_ref.trim(), branchId: db.branch_id,
      stripeAccountId: db.stripe_account_id },
    policyVersion: db.policy_version,
    quotas: jsonValue(db.quota_limits),
    projection: jsonValue(db.projection),
    capacity: jsonValue(db.capacity_snapshot),
    createdAt: Number(db.created_at_epoch),
  };
}

function retentionReceiptFromDb(db) {
  if (!db) return null;
  return {
    receiptId: db.receipt_id,
    reservationId: db.reservation_id,
    attemptId: db.attempt_id,
    scope: { projectRef: db.project_ref.trim(), branchId: db.branch_id,
      stripeAccountId: db.stripe_account_id },
    outcome: db.outcome,
    retained: jsonValue(db.retained_usage),
    createdAt: Number(db.created_at_epoch),
  };
}

function cleanupReceiptFromDb(db) {
  if (!db) return null;
  return { receiptId: db.receipt_id, reservationId: db.reservation_id, attemptId: db.attempt_id,
    environment: { database: { projectRef: db.project_ref.trim(), branchId: db.branch_id },
      deployment: { id: db.deployment_id, origin: db.deployment_origin },
      stripe: { accountId: db.stripe_account_id } },
    fence: db.owner_fence, digest: db.cleanup_digest.trim(),
    projection: jsonValue(db.verified_projection), createdAt: Number(db.created_at_epoch) };
}

function resourceLockFromDb(db) {
  if (!db) return null;
  return { resourceType: db.resource_type, resourceId: db.resource_id,
    attemptId: db.owner_attempt_id, fence: db.fence, candidateSha: db.candidate_sha.trim(),
    workflow: { repository: db.workflow_repository, ref: db.workflow_ref,
      runId: db.workflow_run_id, runAttempt: db.workflow_run_attempt, runnerLabel: db.runner_label },
    environment: jsonValue(db.environment_identity), expiresAt: Number(db.expires_at_epoch) };
}

function stripeIntentFromDb(db) {
  if (!db) return null;
  return { intentId: db.intent_id, attemptId: db.attempt_id, fence: db.owner_fence,
    accountId: db.account_id, candidateSha: db.candidate_sha.trim(),
    workflow: { repository: db.workflow_repository, ref: db.workflow_ref,
      runId: db.workflow_run_id, runAttempt: db.workflow_run_attempt, runnerLabel: db.runner_label },
    environment: jsonValue(db.environment_identity), action: db.action, operation: db.operation,
    requestDigest: db.request_digest.trim(), idempotencyKey: db.idempotency_key,
    state: db.state, createdAt: Number(db.created_at_epoch) };
}

function stripeReceiptFromDb(db) {
  if (!db) return null;
  return { receiptId: db.receipt_id, intentId: db.intent_id, attemptId: db.attempt_id,
    fence: db.owner_fence, accountId: db.account_id, operation: db.operation,
    requestDigest: db.request_digest.trim(), idempotencyKey: db.idempotency_key,
    observationDigest: db.observation_digest.trim(), resourceIds: jsonValue(db.resource_ids),
    observedAt: Number(db.observed_at_epoch) };
}

function resourceKeys(environment) {
  return [
    { resourceType: 'supabase_branch', resourceId:
      `${environment.database.projectRef}:${environment.database.branchId}` },
    { resourceType: 'stripe_account', resourceId: environment.stripe.accountId },
  ].sort((a, b) => `${a.resourceType}:${a.resourceId}`.localeCompare(`${b.resourceType}:${b.resourceId}`));
}

function transactionAdapter(client, verifyRecovery, verifyCleanup, verifyRetentionReceipt,
  verifyProviderObservation, expectedEnvironment) {
  return { verifyRecovery, verifyCleanup, verifyRetentionReceipt, verifyProviderObservation, expectedEnvironment,
    transaction: (fn) => client.transaction(async (queryClient) => {
    if (typeof queryClient?.query !== 'function') refuse('store_client_invalid');
    await queryClient.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    const tx = {
      async lockAttempt(attemptId) {
        await queryClient.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [JSON.stringify(['attempt', attemptId])]);
      },
      async lockRetention(scope) {
        await queryClient.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [JSON.stringify(['retention', scope.projectRef, scope.branchId, scope.stripeAccountId])]);
      },
      async lockResourceLocks(environment) {
        for (const resource of resourceKeys(environment)) {
          await queryClient.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
            [JSON.stringify(['resource', resource.resourceType, resource.resourceId])]);
        }
      },
      async getResourceLocks(environment) {
        const resources = resourceKeys(environment);
        const values = resources.flatMap(({ resourceType, resourceId }) => [resourceType, resourceId]);
        const result = await queryClient.query(`SELECT resource_type, resource_id, owner_attempt_id, fence,
          candidate_sha, workflow_repository, workflow_ref, workflow_run_id, workflow_run_attempt,
          runner_label, environment_identity, extract(epoch FROM expires_at) AS expires_at_epoch
          FROM billing_validation_control.resource_locks
          WHERE (resource_type = $1 AND resource_id = $2)
             OR (resource_type = $3 AND resource_id = $4)
          ORDER BY resource_type, resource_id FOR UPDATE`, values);
        return (result.rows ?? []).map(resourceLockFromDb);
      },
      async putResourceLocks(owner, previous) {
        if (!Array.isArray(previous)) refuse('resource_lock_ledger_invalid');
        for (const resource of resourceKeys(owner.environment)) {
          const old = previous.find((candidate) => candidate.resourceType === resource.resourceType &&
            candidate.resourceId === resource.resourceId);
          const values = [resource.resourceType, resource.resourceId, owner.attemptId, owner.fence,
            owner.candidateSha, owner.workflow.repository, owner.workflow.ref, owner.workflow.runId,
            owner.workflow.runAttempt, owner.workflow.runnerLabel, JSON.stringify(owner.environment),
            owner.expiresAt];
          let result;
          if (!old) {
            result = await queryClient.query(`INSERT INTO billing_validation_control.resource_locks
              (resource_type, resource_id, owner_attempt_id, fence, candidate_sha, workflow_repository,
               workflow_ref, workflow_run_id, workflow_run_attempt, runner_label, environment_identity,
               expires_at)
              VALUES ($1,$2,$3,$4::uuid,$5,$6,$7,$8,$9,$10,$11::jsonb,to_timestamp($12))
              ON CONFLICT (resource_type, resource_id) DO NOTHING`, values);
          } else {
            result = await queryClient.query(`UPDATE billing_validation_control.resource_locks
              SET owner_attempt_id = $3, fence = $4::uuid, candidate_sha = $5,
                  workflow_repository = $6, workflow_ref = $7, workflow_run_id = $8,
                  workflow_run_attempt = $9, runner_label = $10, environment_identity = $11::jsonb,
                  expires_at = to_timestamp($12), updated_at = clock_timestamp()
              WHERE resource_type = $1 AND resource_id = $2 AND owner_attempt_id = $13
                AND fence = $14::uuid`, [...values, old.attemptId, old.fence]);
          }
          if (result.rowCount !== 1) refuse('resource_lock_held');
        }
      },
      async deleteResourceLocks(owner) {
        for (const resource of resourceKeys(owner.environment)) {
          const result = await queryClient.query(`DELETE FROM billing_validation_control.resource_locks
            WHERE resource_type = $1 AND resource_id = $2 AND owner_attempt_id = $3
              AND fence = $4::uuid AND expires_at > clock_timestamp()`,
          [resource.resourceType, resource.resourceId, owner.attemptId, owner.fence]);
          if (result.rowCount !== 1) refuse('lease_fence_lost');
        }
      },
      async hasInFlightStripeIntent(attemptId) {
        const result = await queryClient.query(`SELECT EXISTS (
          SELECT 1 FROM billing_validation_control.stripe_intents AS intent
          WHERE intent.attempt_id = $1 AND NOT EXISTS (
            SELECT 1 FROM billing_validation_control.stripe_receipts AS receipt
            WHERE receipt.intent_id = intent.intent_id
          )) AS in_flight`, [attemptId]);
        return result.rows?.[0]?.in_flight === true;
      },
      async now() {
        const result = await queryClient.query('SELECT extract(epoch FROM clock_timestamp()) AS now', []);
        return Number(result.rows[0].now);
      },
      async getAttempt(attemptId) {
        const result = await queryClient.query(`SELECT *, extract(epoch FROM created_at) AS created_at_epoch,
          extract(epoch FROM updated_at) AS updated_at_epoch
          FROM billing_validation_control.attempts WHERE attempt_id = $1`, [attemptId]);
        return rowFromDb(result.rows[0]);
      },
      async putAttempt(row) {
        const values = [row.attemptId, ...keyValues(row.key), row.candidateSha,
          row.workflow.repository, row.workflow.ref, row.workflow.runId, row.workflow.runAttempt,
          row.workflow.runnerLabel, row.environment.database.projectRef, row.environment.deployment.id,
          row.environment.deployment.origin, row.environment.stripe.accountId, row.state,
          row.cleanupStatus, row.artifact?.id ?? null, row.artifact?.digest ?? null,
          row.artifact?.schema ?? null, JSON.stringify(row.resourceIds), row.createdAt, row.updatedAt];
        const result = await queryClient.query(`INSERT INTO billing_validation_control.attempts
          (attempt_id, branch_id, suite, fixture_key, candidate_sha, workflow_repository, workflow_ref,
           workflow_run_id, workflow_run_attempt, runner_label, database_project_ref, deployment_id,
           deployment_origin, stripe_account_id, state, cleanup_status, artifact_id, artifact_digest,
           artifact_schema, resource_ids, created_at, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,
                  to_timestamp($21),to_timestamp($22))
          ON CONFLICT (attempt_id) DO UPDATE SET state = EXCLUDED.state,
            cleanup_status = EXCLUDED.cleanup_status, artifact_id = EXCLUDED.artifact_id,
            artifact_digest = EXCLUDED.artifact_digest, artifact_schema = EXCLUDED.artifact_schema,
            resource_ids = EXCLUDED.resource_ids, updated_at = EXCLUDED.updated_at
          WHERE billing_validation_control.attempts.branch_id = EXCLUDED.branch_id
            AND billing_validation_control.attempts.suite = EXCLUDED.suite
            AND billing_validation_control.attempts.fixture_key = EXCLUDED.fixture_key`, values);
        if (result.rowCount !== 1) refuse('attempt_conflict');
      },
      async getRetentionUsage(scope) {
        const result = await queryClient.query(`/* retention_capacity_snapshot */
          SELECT bucket, quota_key, SUM(units)::text AS units
          FROM (
            SELECT 'committed'::text AS bucket, usage.key AS quota_key,
              usage.value::numeric AS units
            FROM billing_validation_control.retention_receipts AS receipt
            CROSS JOIN LATERAL jsonb_each_text(receipt.retained_usage) AS usage(key, value)
            WHERE receipt.project_ref = $1 AND receipt.branch_id = $2 AND receipt.stripe_account_id = $3
            UNION ALL
            SELECT 'reserved'::text AS bucket, usage.key AS quota_key,
              usage.value::numeric AS units
            FROM billing_validation_control.retention_reservations AS reservation
            CROSS JOIN LATERAL jsonb_each_text(reservation.projection) AS usage(key, value)
            WHERE reservation.project_ref = $1 AND reservation.branch_id = $2 AND reservation.stripe_account_id = $3
              AND NOT EXISTS (
                SELECT 1 FROM billing_validation_control.retention_receipts AS settled
                WHERE settled.reservation_id = reservation.reservation_id
              )
          ) AS ledger
          GROUP BY bucket, quota_key`, [scope.projectRef, scope.branchId, scope.stripeAccountId]);
        const policies = await queryClient.query(`/* retention_policy_pin */
          SELECT quota_limits
          FROM billing_validation_control.retention_reservations
          WHERE project_ref = $1 AND branch_id = $2 AND stripe_account_id = $3
          GROUP BY quota_limits LIMIT 2`, [scope.projectRef, scope.branchId, scope.stripeAccountId]);
        if ((policies.rows ?? []).length > 1) refuse('retention_ledger_invalid');
        const committed = Object.fromEntries(RETENTION_QUOTA_KEYS.map((key) => [key, 0]));
        const reserved = Object.fromEntries(RETENTION_QUOTA_KEYS.map((key) => [key, 0]));
        const seen = new Set();
        for (const row of result.rows ?? []) {
          const target = row.bucket === 'committed' ? committed : row.bucket === 'reserved' ? reserved : null;
          const value = typeof row.units === 'string' && /^(0|[1-9][0-9]*)$/.test(row.units)
            ? Number(row.units) : Number.NaN;
          const identity = `${row.bucket}:${row.quota_key}`;
          if (!target || !Object.hasOwn(target, row.quota_key) || seen.has(identity) || !Number.isSafeInteger(value)) {
            refuse('retention_ledger_invalid');
          }
          seen.add(identity);
          target[row.quota_key] = value;
        }
        return { committed, reserved,
          policyLimits: policies.rows?.[0] ? jsonValue(policies.rows[0].quota_limits) : null };
      },
      async getRetentionReservationByAttempt(attemptId) {
        const result = await queryClient.query(`SELECT reservation_id, attempt_id, project_ref, branch_id,
          stripe_account_id, policy_version, quota_limits, projection, capacity_snapshot,
          extract(epoch FROM created_at) AS created_at_epoch
          FROM billing_validation_control.retention_reservations WHERE attempt_id = $1`, [attemptId]);
        return retentionReservationFromDb(result.rows[0]);
      },
      async getRetentionReservation(reservationId) {
        const result = await queryClient.query(`SELECT reservation_id, attempt_id, project_ref, branch_id,
          stripe_account_id, policy_version, quota_limits, projection, capacity_snapshot,
          extract(epoch FROM created_at) AS created_at_epoch
          FROM billing_validation_control.retention_reservations WHERE reservation_id = $1`, [reservationId]);
        return retentionReservationFromDb(result.rows[0]);
      },
      async getRetentionReceipt(reservationId) {
        const result = await queryClient.query(`SELECT receipt_id, reservation_id, attempt_id, project_ref,
          branch_id, stripe_account_id, outcome, retained_usage,
          extract(epoch FROM created_at) AS created_at_epoch
          FROM billing_validation_control.retention_receipts WHERE reservation_id = $1`, [reservationId]);
        return retentionReceiptFromDb(result.rows[0]);
      },
      async getCleanupReceipt(attemptId) {
        const result = await queryClient.query(`SELECT receipt_id, reservation_id, attempt_id, project_ref,
          branch_id, deployment_id, deployment_origin, stripe_account_id, owner_fence, cleanup_digest,
          verified_projection, extract(epoch FROM created_at) AS created_at_epoch
          FROM billing_validation_control.cleanup_receipts WHERE attempt_id = $1 FOR UPDATE`, [attemptId]);
        return cleanupReceiptFromDb(result.rows[0]);
      },
      async putCleanupReceipt(receipt) {
        const result = await queryClient.query(`INSERT INTO billing_validation_control.cleanup_receipts
          (receipt_id, reservation_id, attempt_id, project_ref, branch_id, deployment_id,
           deployment_origin, stripe_account_id, owner_fence, cleanup_digest, verified_projection, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::uuid,$10,$11::jsonb,to_timestamp($12))`,
        [receipt.receiptId, receipt.reservationId, receipt.attemptId,
          receipt.environment.database.projectRef, receipt.environment.database.branchId,
          receipt.environment.deployment.id, receipt.environment.deployment.origin,
          receipt.environment.stripe.accountId, receipt.fence, receipt.digest,
          JSON.stringify(receipt.projection), receipt.createdAt]);
        if (result.rowCount !== 1) refuse('cleanup_receipt_conflict');
      },
      async putRetentionReservation(reservation) {
        const result = await queryClient.query(`INSERT INTO billing_validation_control.retention_reservations
          (reservation_id, attempt_id, project_ref, branch_id, stripe_account_id, policy_version,
           quota_limits, projection, capacity_snapshot, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,to_timestamp($10))`,
        [reservation.reservationId, reservation.attemptId, reservation.scope.projectRef,
          reservation.scope.branchId, reservation.scope.stripeAccountId, reservation.policyVersion,
          JSON.stringify(reservation.quotas), JSON.stringify(reservation.projection),
          JSON.stringify(reservation.capacity), reservation.createdAt]);
        if (result.rowCount !== 1) refuse('retention_reservation_conflict');
      },
      async putRetentionReceipt(receipt) {
        const result = await queryClient.query(`INSERT INTO billing_validation_control.retention_receipts
          (receipt_id, reservation_id, attempt_id, project_ref, branch_id, stripe_account_id,
           outcome, retained_usage, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,to_timestamp($9))`,
        [receipt.receiptId, receipt.reservationId, receipt.attemptId, receipt.scope.projectRef,
          receipt.scope.branchId, receipt.scope.stripeAccountId, receipt.outcome,
          JSON.stringify(receipt.retained), receipt.createdAt]);
        if (result.rowCount !== 1) refuse('retention_receipt_conflict');
      },
      async getStripeIntentByOperation(attemptId, operation) {
        const result = await queryClient.query(`SELECT *, extract(epoch FROM created_at) AS created_at_epoch
          FROM billing_validation_control.stripe_intents
          WHERE attempt_id = $1 AND operation = $2 FOR UPDATE`, [attemptId, operation]);
        return stripeIntentFromDb(result.rows?.[0]);
      },
      async getStripeIntent(intentId) {
        const result = await queryClient.query(`SELECT *, extract(epoch FROM created_at) AS created_at_epoch
          FROM billing_validation_control.stripe_intents WHERE intent_id = $1 FOR UPDATE`, [intentId]);
        return stripeIntentFromDb(result.rows?.[0]);
      },
      async listPendingStripeIntents(attemptId) {
        const result = await queryClient.query(`SELECT intent.*,
          extract(epoch FROM intent.created_at) AS created_at_epoch
          FROM billing_validation_control.stripe_intents AS intent
          WHERE intent.attempt_id = $1 AND NOT EXISTS (
            SELECT 1 FROM billing_validation_control.stripe_receipts AS receipt
            WHERE receipt.intent_id = intent.intent_id
          )
          ORDER BY intent.created_at, intent.intent_id FOR UPDATE OF intent`, [attemptId]);
        return (result.rows ?? []).map(stripeIntentFromDb);
      },
      async insertStripeIntent(intent) {
        const result = await queryClient.query(`INSERT INTO billing_validation_control.stripe_intents
          (intent_id, attempt_id, owner_fence, account_id, candidate_sha, workflow_repository,
           workflow_ref, workflow_run_id, workflow_run_attempt, runner_label, environment_identity, action,
           operation, request_digest, idempotency_key, state, created_at)
          VALUES ($1,$2,$3::uuid,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,to_timestamp($17))`,
        [intent.intentId, intent.attemptId, intent.fence, intent.accountId, intent.candidateSha,
          intent.workflow.repository, intent.workflow.ref, intent.workflow.runId,
          intent.workflow.runAttempt, intent.workflow.runnerLabel, JSON.stringify(intent.environment),
          intent.action, intent.operation, intent.requestDigest, intent.idempotencyKey,
          intent.state, intent.createdAt]);
        if (result.rowCount !== 1) refuse('stripe_intent_conflict');
      },
      async getStripeReceipt(intentId) {
        const result = await queryClient.query(`SELECT *, extract(epoch FROM observed_at) AS observed_at_epoch
          FROM billing_validation_control.stripe_receipts WHERE intent_id = $1 FOR UPDATE`, [intentId]);
        return stripeReceiptFromDb(result.rows?.[0]);
      },
      async putStripeReceipt(receipt) {
        const result = await queryClient.query(`INSERT INTO billing_validation_control.stripe_receipts
          (receipt_id, intent_id, attempt_id, owner_fence, account_id, operation, request_digest,
           idempotency_key, observation_digest, resource_ids, observed_at)
          VALUES ($1,$2,$3,$4::uuid,$5,$6,$7,$8,$9,$10::jsonb,to_timestamp($11))`,
        [receipt.receiptId, receipt.intentId, receipt.attemptId, receipt.fence, receipt.accountId,
          receipt.operation, receipt.requestDigest, receipt.idempotencyKey, receipt.observationDigest,
          JSON.stringify(receipt.resourceIds), receipt.observedAt]);
        if (result.rowCount !== 1) refuse('stripe_receipt_conflict');
      },
      async getLease(key) {
        // This lock serializes even the first insert for an absent key. Hash collisions only reduce concurrency.
        await queryClient.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify(keyValues(key))]);
        const result = await queryClient.query(`SELECT branch_id, suite, fixture_key, attempt_id, fence,
          owner_candidate_sha, owner_repository, owner_ref, owner_run_id, owner_run_attempt,
          recovery_only, extract(epoch FROM expires_at) AS expires_at_epoch
          FROM billing_validation_control.fixture_leases
          WHERE branch_id = $1 AND suite = $2 AND fixture_key = $3 FOR UPDATE`, keyValues(key));
        const row = result.rows[0];
        return row ? { key, attemptId: row.attempt_id, fence: row.fence,
          candidateSha: row.owner_candidate_sha?.trim(), ownerRepository: row.owner_repository,
          ownerRef: row.owner_ref, ownerRunId: row.owner_run_id,
          ownerRunAttempt: row.owner_run_attempt,
          recoveryOnly: row.recovery_only === true,
          expiresAt: Number(row.expires_at_epoch) } : null;
      },
      async putLease(lease, expectedFence) {
        const result = await queryClient.query(`INSERT INTO billing_validation_control.fixture_leases
          (branch_id, suite, fixture_key, attempt_id, fence, expires_at,
           owner_candidate_sha, owner_repository, owner_ref, owner_run_id, owner_run_attempt, recovery_only)
          VALUES ($1,$2,$3,$4,$5,to_timestamp($6),$8,$9,$10,$11,$12,$13)
          ON CONFLICT (branch_id, suite, fixture_key) DO UPDATE SET
            attempt_id = EXCLUDED.attempt_id, fence = EXCLUDED.fence, expires_at = EXCLUDED.expires_at,
            owner_candidate_sha = EXCLUDED.owner_candidate_sha, owner_repository = EXCLUDED.owner_repository,
            owner_ref = EXCLUDED.owner_ref, owner_run_id = EXCLUDED.owner_run_id,
            owner_run_attempt = EXCLUDED.owner_run_attempt, recovery_only = EXCLUDED.recovery_only
          WHERE billing_validation_control.fixture_leases.fence = $7::uuid`,
        [...keyValues(lease.key), lease.attemptId, lease.fence, lease.expiresAt, expectedFence,
          lease.candidateSha, lease.ownerRepository, lease.ownerRef,
          lease.ownerRunId, lease.ownerRunAttempt, lease.recoveryOnly === true]);
        if (result.rowCount === 0) refuse('lease_fence_lost');
      },
      async deleteLease(key, attemptId, fence) {
        const result = await queryClient.query(`DELETE FROM billing_validation_control.fixture_leases
          WHERE branch_id = $1 AND suite = $2 AND fixture_key = $3 AND attempt_id = $4 AND fence = $5::uuid
            AND expires_at > clock_timestamp()`, [...keyValues(key), attemptId, fence]);
        if (result.rowCount === 0) refuse('lease_fence_lost');
      },
      fixtureMutation: (fn) => fn(queryClient),
    };
    return fn(tx);
  }) };
}

export function createPostgresAttemptStore({ client, preflight, target, verifyRecovery, verifyCleanup,
  verifyRetentionReceipt, verifyProviderObservation } = {}) {
  const verified = assertWiring({ client, preflight, target });
  return createAttemptStore(transactionAdapter(client, verifyRecovery, verifyCleanup, verifyRetentionReceipt,
    verifyProviderObservation, verified.preflight.expectedEnvironment));
}

export async function installAttemptSchema({ client, preflight, target } = {}) {
  assertWiring({ client, preflight, target });
  const ddl = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  return client.transaction(async (queryClient) => {
    if (typeof queryClient?.query !== 'function') refuse('store_client_invalid');
    await queryClient.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    return queryClient.query(ddl);
  });
}
