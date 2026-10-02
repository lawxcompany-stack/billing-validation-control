CREATE SEQUENCE billing_validation_control.fixture_lease_fence_seq
  AS bigint START WITH 1 INCREMENT BY 1 MINVALUE 1 MAXVALUE 281474976710655 NO CYCLE;

CREATE TABLE billing_validation_control.schema_migrations (
  version text PRIMARY KEY,
  name text NOT NULL UNIQUE,
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE billing_validation_control.standalone_fixture_leases (
  project_ref char(20) NOT NULL CHECK (project_ref ~ '^[a-z0-9]{20}$'),
  suite text NOT NULL,
  fixture_key text NOT NULL,
  attempt_id text NOT NULL REFERENCES billing_validation_control.attempts(attempt_id),
  fence uuid NOT NULL,
  owner_candidate_sha char(40) NOT NULL,
  owner_repository text NOT NULL,
  owner_ref text NOT NULL,
  owner_run_id text NOT NULL CHECK (owner_run_id ~ '^[1-9][0-9]{0,19}$'),
  owner_run_attempt integer NOT NULL CHECK (owner_run_attempt > 0),
  expires_at timestamptz NOT NULL,
  recovery_only boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_ref, suite, fixture_key)
);
CREATE INDEX billing_validation_standalone_lease_expiry
  ON billing_validation_control.standalone_fixture_leases (expires_at);

CREATE TABLE billing_validation_control.standalone_resource_locks (
  resource_type text NOT NULL CHECK (resource_type IN ('supabase_project', 'stripe_account')),
  resource_id text NOT NULL,
  owner_attempt_id text NOT NULL REFERENCES billing_validation_control.attempts(attempt_id),
  fence uuid NOT NULL,
  candidate_sha char(40) NOT NULL,
  workflow_repository text NOT NULL,
  workflow_ref text NOT NULL,
  workflow_run_id text NOT NULL,
  workflow_run_attempt integer NOT NULL CHECK (workflow_run_attempt > 0),
  runner_label text NOT NULL,
  environment_identity jsonb NOT NULL CHECK (jsonb_typeof(environment_identity) = 'object'),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (resource_type, resource_id)
);
CREATE INDEX billing_validation_standalone_resource_owner
  ON billing_validation_control.standalone_resource_locks (owner_attempt_id, fence);

CREATE TABLE billing_validation_control.fixture_lease_history (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_ref char(20) NOT NULL CHECK (project_ref ~ '^[a-z0-9]{20}$'),
  suite text NOT NULL,
  fixture_key text NOT NULL,
  attempt_id text NOT NULL,
  owner_fence uuid NOT NULL,
  workflow_run_id text NOT NULL CHECK (workflow_run_id ~ '^[1-9][0-9]{0,19}$'),
  workflow_run_attempt integer NOT NULL CHECK (workflow_run_attempt > 0),
  event_type text NOT NULL CHECK (event_type IN ('acquired', 'renewed', 'takeover', 'recheck_handoff',
    'recovery_handoff', 'released')),
  expires_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE billing_validation_control.retention_receipts
  ADD COLUMN owner_fence uuid;
ALTER TABLE billing_validation_control.retention_receipts
  ADD CONSTRAINT billing_validation_retention_receipt_owner_fence_required
  CHECK (owner_fence IS NOT NULL) NOT VALID;

CREATE FUNCTION billing_validation_control.reject_append_only_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'billing_control_append_only_history';
END;
$$;

CREATE OR REPLACE FUNCTION billing_validation_control.validate_fixture_case_claim()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  attempt billing_validation_control.attempts%ROWTYPE;
  reservation billing_validation_control.retention_reservations%ROWTYPE;
  lease billing_validation_control.standalone_fixture_leases%ROWTYPE;
BEGIN
  SELECT * INTO attempt FROM billing_validation_control.attempts
    WHERE attempt_id = NEW.attempt_id FOR KEY SHARE;
  SELECT * INTO reservation FROM billing_validation_control.retention_reservations
    WHERE reservation_id = NEW.reservation_id FOR KEY SHARE;
  SELECT * INTO lease FROM billing_validation_control.standalone_fixture_leases
    WHERE attempt_id = NEW.attempt_id AND project_ref = NEW.project_ref AND fence = NEW.owner_fence
      AND expires_at > clock_timestamp() AND recovery_only = false FOR KEY SHARE;
  IF attempt.attempt_id IS NULL OR reservation.reservation_id IS NULL OR lease.attempt_id IS NULL OR
     attempt.state <> 'collecting' OR attempt.candidate_sha <> NEW.candidate_sha OR
     attempt.database_project_ref <> NEW.project_ref OR attempt.branch_id <> NEW.branch_id OR
     attempt.deployment_id <> NEW.deployment_id OR attempt.deployment_origin <> NEW.deployment_origin OR
     attempt.stripe_account_id <> NEW.stripe_account_id OR
     reservation.attempt_id <> NEW.attempt_id OR reservation.project_ref <> NEW.project_ref OR
     reservation.branch_id <> NEW.branch_id OR reservation.stripe_account_id <> NEW.stripe_account_id OR
     lease.attempt_id <> NEW.attempt_id OR lease.fence <> NEW.owner_fence THEN
    RAISE EXCEPTION 'billing_fixture_case_claim_invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION billing_validation_control.validate_cleanup_receipt_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  reservation billing_validation_control.retention_reservations%ROWTYPE;
  attempt billing_validation_control.attempts%ROWTYPE;
  resource_count integer;
BEGIN
  SELECT * INTO reservation FROM billing_validation_control.retention_reservations
    WHERE reservation_id = NEW.reservation_id FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'billing_cleanup_receipt_reservation_missing' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO attempt FROM billing_validation_control.attempts
    WHERE attempt_id = NEW.attempt_id FOR KEY SHARE;
  IF NOT FOUND OR reservation.attempt_id <> NEW.attempt_id OR
     reservation.project_ref <> NEW.project_ref OR reservation.branch_id <> NEW.branch_id OR
     reservation.stripe_account_id <> NEW.stripe_account_id OR
     attempt.database_project_ref <> NEW.project_ref OR attempt.branch_id <> NEW.branch_id OR
     attempt.deployment_id <> NEW.deployment_id OR attempt.deployment_origin <> NEW.deployment_origin OR
     attempt.stripe_account_id <> NEW.stripe_account_id OR
     attempt.state NOT IN ('complete', 'cancelled', 'timed_out') OR attempt.cleanup_status <> 'pending' THEN
    RAISE EXCEPTION 'billing_cleanup_receipt_identity_mismatch' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM billing_validation_control.standalone_fixture_leases
      WHERE attempt_id = NEW.attempt_id AND project_ref = NEW.project_ref AND
        fence = NEW.owner_fence AND expires_at > clock_timestamp()) THEN
    RAISE EXCEPTION 'billing_cleanup_receipt_fence_mismatch' USING ERRCODE = '23514';
  END IF;
  SELECT count(*) INTO resource_count FROM billing_validation_control.standalone_resource_locks
    WHERE owner_attempt_id = NEW.attempt_id AND fence = NEW.owner_fence;
  IF resource_count <> 2 THEN
    RAISE EXCEPTION 'billing_cleanup_receipt_resource_lock_mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION billing_validation_control.validate_retention_receipt_owner_fence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.owner_fence IS NULL OR NOT EXISTS (
    SELECT 1 FROM billing_validation_control.fixture_lease_history
    WHERE attempt_id = NEW.attempt_id AND project_ref = NEW.project_ref AND owner_fence = NEW.owner_fence
  ) THEN
    RAISE EXCEPTION 'billing_retention_receipt_owner_fence_invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_validation_retention_receipt_owner_fence
  BEFORE INSERT ON billing_validation_control.retention_receipts
  FOR EACH ROW EXECUTE FUNCTION billing_validation_control.validate_retention_receipt_owner_fence();

CREATE TRIGGER billing_validation_migration_history_immutable
  BEFORE UPDATE OR DELETE ON billing_validation_control.schema_migrations
  FOR EACH ROW EXECUTE FUNCTION billing_validation_control.reject_append_only_history_mutation();
CREATE TRIGGER billing_validation_migration_history_no_truncate
  BEFORE TRUNCATE ON billing_validation_control.schema_migrations
  FOR EACH STATEMENT EXECUTE FUNCTION billing_validation_control.reject_append_only_history_mutation();
CREATE TRIGGER billing_validation_fixture_lease_history_immutable
  BEFORE UPDATE OR DELETE ON billing_validation_control.fixture_lease_history
  FOR EACH ROW EXECUTE FUNCTION billing_validation_control.reject_append_only_history_mutation();
CREATE TRIGGER billing_validation_fixture_lease_history_no_truncate
  BEFORE TRUNCATE ON billing_validation_control.fixture_lease_history
  FOR EACH STATEMENT EXECUTE FUNCTION billing_validation_control.reject_append_only_history_mutation();

REVOKE ALL ON TABLE billing_validation_control.schema_migrations,
  billing_validation_control.standalone_fixture_leases,
  billing_validation_control.standalone_resource_locks,
  billing_validation_control.fixture_lease_history FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE billing_validation_control.fixture_lease_fence_seq FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION billing_validation_control.reject_append_only_history_mutation() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION billing_validation_control.validate_fixture_case_claim() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION billing_validation_control.validate_cleanup_receipt_identity() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION billing_validation_control.validate_retention_receipt_owner_fence() FROM PUBLIC, anon, authenticated;
