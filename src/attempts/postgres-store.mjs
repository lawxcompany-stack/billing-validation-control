import { readFile } from 'node:fs/promises';
import { createAttemptStore, refuse } from './store.mjs';

const PRODUCTION_LABEL = /(?:^|[-_.])(?:main|master|prod|production|primary|default)(?:$|[-_.])/i;

function verifiedTarget(preflight, target) {
  const expected = preflight?.expectedEnvironment?.database;
  const verified = preflight?.providerVerification?.supabase;
  return expected && verified && target &&
    target.projectRef === expected.projectRef && target.branchId === expected.branchId &&
    verified.projectRef === target.projectRef && verified.branchId === target.branchId &&
    verified.parentProjectRef === target.parentProjectRef && verified.branchName === target.branchName &&
    typeof target.parentProjectRef === 'string' && target.parentProjectRef !== target.projectRef &&
    target.isDefault === false && target.isolated === true && target.status === 'ACTIVE_HEALTHY' &&
    !PRODUCTION_LABEL.test(target.branchId) && !PRODUCTION_LABEL.test(target.branchName) &&
    !PRODUCTION_LABEL.test(verified.branchId) && !PRODUCTION_LABEL.test(verified.branchName);
}

function assertWiring({ client, preflight, target }) {
  if (!verifiedTarget(preflight, target) || typeof client?.transaction !== 'function') refuse('schema_target_unverified');
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

function transactionAdapter(client, verifyRecovery, verifyCleanup, expectedEnvironment) {
  return { verifyRecovery, verifyCleanup, expectedEnvironment,
    transaction: (fn) => client.transaction(async (queryClient) => {
    if (typeof queryClient?.query !== 'function') refuse('store_client_invalid');
    const tx = {
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
        await queryClient.query(`INSERT INTO billing_validation_control.attempts
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
      },
      async getLease(key) {
        // This lock serializes even the first insert for an absent key. Hash collisions only reduce concurrency.
        await queryClient.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify(keyValues(key))]);
        const result = await queryClient.query(`SELECT branch_id, suite, fixture_key, attempt_id, fence,
          owner_candidate_sha, owner_repository, owner_ref, owner_run_id, owner_run_attempt,
          extract(epoch FROM expires_at) AS expires_at_epoch
          FROM billing_validation_control.fixture_leases
          WHERE branch_id = $1 AND suite = $2 AND fixture_key = $3 FOR UPDATE`, keyValues(key));
        const row = result.rows[0];
        return row ? { key, attemptId: row.attempt_id, fence: row.fence,
          candidateSha: row.owner_candidate_sha?.trim(), ownerRepository: row.owner_repository,
          ownerRef: row.owner_ref, ownerRunId: row.owner_run_id,
          ownerRunAttempt: row.owner_run_attempt,
          expiresAt: Number(row.expires_at_epoch) } : null;
      },
      async putLease(lease, expectedFence) {
        const result = await queryClient.query(`INSERT INTO billing_validation_control.fixture_leases
          (branch_id, suite, fixture_key, attempt_id, fence, expires_at,
           owner_candidate_sha, owner_repository, owner_ref, owner_run_id, owner_run_attempt)
          VALUES ($1,$2,$3,$4,$5,to_timestamp($6),$8,$9,$10,$11,$12)
          ON CONFLICT (branch_id, suite, fixture_key) DO UPDATE SET
            attempt_id = EXCLUDED.attempt_id, fence = EXCLUDED.fence, expires_at = EXCLUDED.expires_at,
            owner_candidate_sha = EXCLUDED.owner_candidate_sha, owner_repository = EXCLUDED.owner_repository,
            owner_ref = EXCLUDED.owner_ref, owner_run_id = EXCLUDED.owner_run_id,
            owner_run_attempt = EXCLUDED.owner_run_attempt
          WHERE billing_validation_control.fixture_leases.fence = $7::uuid`,
        [...keyValues(lease.key), lease.attemptId, lease.fence, lease.expiresAt, expectedFence,
          lease.candidateSha, lease.ownerRepository, lease.ownerRef,
          lease.ownerRunId, lease.ownerRunAttempt]);
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

export function createPostgresAttemptStore({ client, preflight, target, verifyRecovery, verifyCleanup } = {}) {
  assertWiring({ client, preflight, target });
  return createAttemptStore(transactionAdapter(client, verifyRecovery, verifyCleanup,
    preflight.expectedEnvironment));
}

export async function installAttemptSchema({ client, preflight, target } = {}) {
  assertWiring({ client, preflight, target });
  const ddl = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  return client.transaction(async (queryClient) => {
    if (typeof queryClient?.query !== 'function') refuse('store_client_invalid');
    return queryClient.query(ddl);
  });
}
