ALTER FUNCTION billing_validation_control.validate_fixture_case_claim() SECURITY DEFINER;
ALTER FUNCTION billing_validation_control.validate_retention_receipt_projection() SECURITY DEFINER;
ALTER FUNCTION billing_validation_control.validate_retention_receipt_owner_fence() SECURITY DEFINER;
ALTER FUNCTION billing_validation_control.validate_cleanup_receipt_identity() SECURITY DEFINER;

CREATE TABLE billing_validation_control.fixture_reservation_claim_events (
  event_id text PRIMARY KEY CHECK (length(event_id) BETWEEN 1 AND 256),
  reservation_id text NOT NULL
    REFERENCES billing_validation_control.retention_reservations(reservation_id),
  attempt_id text NOT NULL
    REFERENCES billing_validation_control.attempts(attempt_id),
  previous_rows bigint NOT NULL CHECK (previous_rows >= 0),
  current_rows bigint NOT NULL CHECK (current_rows > previous_rows),
  event_type text NOT NULL DEFAULT 'usage'
    CHECK (event_type IN ('legacy_baseline', 'usage')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (reservation_id, current_rows)
);

CREATE FUNCTION billing_validation_control.validate_fixture_reservation_claim_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  reservation_attempt text;
  reserved_rows bigint;
  latest_rows bigint;
  legacy_attempt text;
  legacy_rows bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('fixture-reservation-claim:' || NEW.reservation_id, 0));

  SELECT reservation.attempt_id, (reservation.projection ->> 'databaseRows')::bigint
    INTO reservation_attempt, reserved_rows
  FROM billing_validation_control.retention_reservations AS reservation
  WHERE reservation.reservation_id = NEW.reservation_id;
  IF NOT FOUND OR reservation_attempt <> NEW.attempt_id OR NEW.current_rows > reserved_rows THEN
    RAISE EXCEPTION 'billing_fixture_reservation_claim_invalid' USING ERRCODE = '23514';
  END IF;

  IF NEW.event_type = 'legacy_baseline' THEN
    SELECT claim.attempt_id, claim.database_rows_used
      INTO legacy_attempt, legacy_rows
    FROM billing_validation_control.fixture_reservation_claims AS claim
    WHERE claim.reservation_id = NEW.reservation_id;
    IF NOT FOUND OR legacy_attempt <> NEW.attempt_id OR legacy_rows <> NEW.current_rows OR
       NEW.previous_rows <> 0 OR NEW.current_rows = 0 OR EXISTS (
         SELECT 1 FROM billing_validation_control.fixture_reservation_claim_events AS event
         WHERE event.reservation_id = NEW.reservation_id
       ) THEN
      RAISE EXCEPTION 'billing_fixture_reservation_legacy_baseline_invalid' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT event.current_rows INTO latest_rows
  FROM billing_validation_control.fixture_reservation_claim_events AS event
  WHERE event.reservation_id = NEW.reservation_id
  ORDER BY event.current_rows DESC
  LIMIT 1;
  IF NOT FOUND THEN
    SELECT claim.attempt_id, claim.database_rows_used
      INTO legacy_attempt, latest_rows
    FROM billing_validation_control.fixture_reservation_claims AS claim
    WHERE claim.reservation_id = NEW.reservation_id;
    IF NOT FOUND THEN
      latest_rows := 0;
    ELSIF legacy_attempt <> NEW.attempt_id THEN
      RAISE EXCEPTION 'billing_fixture_reservation_claim_identity_invalid' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.previous_rows IS DISTINCT FROM latest_rows OR NEW.current_rows <= NEW.previous_rows THEN
    RAISE EXCEPTION 'billing_fixture_reservation_claim_stale' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER billing_validation_fixture_reservation_claim_event_valid
  BEFORE INSERT ON billing_validation_control.fixture_reservation_claim_events
  FOR EACH ROW EXECUTE FUNCTION billing_validation_control.validate_fixture_reservation_claim_event();
CREATE TRIGGER billing_validation_fixture_reservation_claim_events_immutable
  BEFORE UPDATE OR DELETE ON billing_validation_control.fixture_reservation_claim_events
  FOR EACH ROW EXECUTE FUNCTION billing_validation_control.reject_retention_ledger_mutation();
CREATE TRIGGER billing_validation_fixture_reservation_claim_events_no_truncate
  BEFORE TRUNCATE ON billing_validation_control.fixture_reservation_claim_events
  FOR EACH STATEMENT EXECUTE FUNCTION billing_validation_control.reject_retention_ledger_mutation();
CREATE TRIGGER billing_validation_fixture_reservation_claim_immutable_update
  BEFORE UPDATE ON billing_validation_control.fixture_reservation_claims
  FOR EACH ROW EXECUTE FUNCTION billing_validation_control.reject_fixture_reservation_claim_delete();

INSERT INTO billing_validation_control.fixture_reservation_claim_events
  (event_id, reservation_id, attempt_id, previous_rows, current_rows, event_type, created_at)
SELECT 'legacy:' || claim.reservation_id, claim.reservation_id, claim.attempt_id,
  0, claim.database_rows_used, 'legacy_baseline', claim.created_at
FROM billing_validation_control.fixture_reservation_claims AS claim
WHERE claim.database_rows_used > 0;

REVOKE ALL PRIVILEGES ON SCHEMA billing_validation_control
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA billing_validation_control
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA billing_validation_control
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA billing_validation_control
  FROM PUBLIC, anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE billing_validation_owner IN SCHEMA billing_validation_control
  REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated, service_role, billing_validation_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE billing_validation_owner IN SCHEMA billing_validation_control
  REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated, service_role, billing_validation_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE billing_validation_owner
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE billing_validation_owner IN SCHEMA billing_validation_control
  REVOKE ALL ON FUNCTIONS FROM PUBLIC, anon, authenticated, service_role, billing_validation_runtime;

-- BEGIN GENERATED CONTROL RUNTIME ACLS
REVOKE ALL PRIVILEGES ON SCHEMA billing_validation_control FROM billing_validation_runtime;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA billing_validation_control FROM billing_validation_runtime;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA billing_validation_control FROM billing_validation_runtime;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA billing_validation_control FROM billing_validation_runtime;
GRANT USAGE ON SCHEMA billing_validation_control TO billing_validation_runtime;
GRANT SELECT ON TABLE billing_validation_control.attempts TO billing_validation_runtime;
GRANT INSERT (attempt_id, branch_id, suite, fixture_key, candidate_sha, workflow_repository, workflow_ref, workflow_run_id, workflow_run_attempt, runner_label, database_project_ref, deployment_id, deployment_origin, stripe_account_id, state, cleanup_status, artifact_id, artifact_digest, artifact_schema, resource_ids, created_at, updated_at) ON TABLE billing_validation_control.attempts TO billing_validation_runtime;
GRANT UPDATE (state, cleanup_status, artifact_id, artifact_digest, artifact_schema, resource_ids, updated_at) ON TABLE billing_validation_control.attempts TO billing_validation_runtime;
GRANT SELECT ON TABLE billing_validation_control.standalone_resource_locks TO billing_validation_runtime;
GRANT INSERT (resource_type, resource_id, owner_attempt_id, fence, candidate_sha, workflow_repository, workflow_ref, workflow_run_id, workflow_run_attempt, runner_label, environment_identity, expires_at) ON TABLE billing_validation_control.standalone_resource_locks TO billing_validation_runtime;
GRANT UPDATE (owner_attempt_id, fence, candidate_sha, workflow_repository, workflow_ref, workflow_run_id, workflow_run_attempt, runner_label, environment_identity, expires_at, updated_at) ON TABLE billing_validation_control.standalone_resource_locks TO billing_validation_runtime;
GRANT DELETE ON TABLE billing_validation_control.standalone_resource_locks TO billing_validation_runtime;
GRANT SELECT ON TABLE billing_validation_control.stripe_intents TO billing_validation_runtime;
GRANT INSERT (intent_id, attempt_id, owner_fence, account_id, candidate_sha, workflow_repository, workflow_ref, workflow_run_id, workflow_run_attempt, runner_label, environment_identity, action, operation, request_digest, idempotency_key, state, created_at) ON TABLE billing_validation_control.stripe_intents TO billing_validation_runtime;
GRANT SELECT ON TABLE billing_validation_control.stripe_receipts TO billing_validation_runtime;
GRANT INSERT (receipt_id, intent_id, attempt_id, owner_fence, account_id, operation, request_digest, idempotency_key, observation_digest, resource_ids, observed_at) ON TABLE billing_validation_control.stripe_receipts TO billing_validation_runtime;
GRANT SELECT ON TABLE billing_validation_control.retention_reservations TO billing_validation_runtime;
GRANT INSERT (reservation_id, attempt_id, project_ref, branch_id, stripe_account_id, policy_version, quota_limits, projection, capacity_snapshot, created_at) ON TABLE billing_validation_control.retention_reservations TO billing_validation_runtime;
GRANT SELECT ON TABLE billing_validation_control.fixture_reservation_claims TO billing_validation_runtime;
GRANT SELECT ON TABLE billing_validation_control.fixture_reservation_claim_events TO billing_validation_runtime;
GRANT INSERT (event_id, reservation_id, attempt_id, previous_rows, current_rows) ON TABLE billing_validation_control.fixture_reservation_claim_events TO billing_validation_runtime;
GRANT SELECT ON TABLE billing_validation_control.retention_receipts TO billing_validation_runtime;
GRANT INSERT (receipt_id, reservation_id, attempt_id, project_ref, branch_id, stripe_account_id, outcome, retained_usage, owner_fence, created_at) ON TABLE billing_validation_control.retention_receipts TO billing_validation_runtime;
GRANT SELECT ON TABLE billing_validation_control.fixture_case_claims TO billing_validation_runtime;
GRANT INSERT (attempt_id, case_id, reservation_id, owner_fence, candidate_sha, namespace_id, project_ref, branch_id, deployment_id, deployment_origin, stripe_account_id) ON TABLE billing_validation_control.fixture_case_claims TO billing_validation_runtime;
GRANT SELECT (attempt_id, case_id, kind) ON TABLE billing_validation_control.fixture_resource_claims TO billing_validation_runtime;
GRANT INSERT (attempt_id, case_id, kind, fixture_id) ON TABLE billing_validation_control.fixture_resource_claims TO billing_validation_runtime;
GRANT SELECT ON TABLE billing_validation_control.cleanup_receipts TO billing_validation_runtime;
GRANT INSERT (receipt_id, reservation_id, attempt_id, project_ref, branch_id, deployment_id, deployment_origin, stripe_account_id, owner_fence, cleanup_digest, verified_projection, created_at) ON TABLE billing_validation_control.cleanup_receipts TO billing_validation_runtime;
GRANT SELECT ON TABLE billing_validation_control.standalone_fixture_leases TO billing_validation_runtime;
GRANT INSERT (project_ref, suite, fixture_key, attempt_id, fence, expires_at, owner_candidate_sha, owner_repository, owner_ref, owner_run_id, owner_run_attempt, recovery_only) ON TABLE billing_validation_control.standalone_fixture_leases TO billing_validation_runtime;
GRANT UPDATE (attempt_id, fence, expires_at, owner_candidate_sha, owner_repository, owner_ref, owner_run_id, owner_run_attempt, recovery_only) ON TABLE billing_validation_control.standalone_fixture_leases TO billing_validation_runtime;
GRANT DELETE ON TABLE billing_validation_control.standalone_fixture_leases TO billing_validation_runtime;
GRANT INSERT (project_ref, suite, fixture_key, attempt_id, owner_fence, workflow_run_id, workflow_run_attempt, event_type, expires_at) ON TABLE billing_validation_control.fixture_lease_history TO billing_validation_runtime;
GRANT USAGE ON SEQUENCE billing_validation_control.fixture_lease_fence_seq TO billing_validation_runtime;
GRANT EXECUTE ON FUNCTION billing_validation_control.valid_retention_usage(jsonb,integer,boolean) TO billing_validation_runtime;
GRANT EXECUTE ON FUNCTION billing_validation_control.valid_cleanup_projection(jsonb) TO billing_validation_runtime;
-- END GENERATED CONTROL RUNTIME ACLS
