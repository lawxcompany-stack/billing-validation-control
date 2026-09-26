CREATE SCHEMA IF NOT EXISTS billing_validation_control;
REVOKE ALL ON SCHEMA billing_validation_control FROM PUBLIC;
REVOKE ALL ON SCHEMA billing_validation_control FROM anon, authenticated;

CREATE OR REPLACE FUNCTION billing_validation_control.valid_retention_usage(document jsonb, minimum_units integer,
  require_one_attempt boolean)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  item record;
  units numeric;
  key_count integer;
BEGIN
  IF jsonb_typeof(document) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  SELECT count(*) INTO key_count FROM jsonb_object_keys(document);
  IF key_count <> 4 OR NOT (document ?& ARRAY['attempts', 'databaseRows', 'authUsers', 'stripeObjects']) THEN
    RETURN false;
  END IF;
  FOR item IN SELECT key, value FROM jsonb_each(document) LOOP
    IF jsonb_typeof(item.value) <> 'number' THEN RETURN false; END IF;
    units := (item.value #>> '{}')::numeric;
    IF units < minimum_units OR trunc(units) <> units OR units > 9007199254740991 THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN NOT require_one_attempt OR document ->> 'attempts' = '1';
END;
$$;

CREATE TABLE IF NOT EXISTS billing_validation_control.attempts (
  attempt_id text PRIMARY KEY,
  branch_id text NOT NULL,
  suite text NOT NULL,
  fixture_key text NOT NULL,
  candidate_sha char(40) NOT NULL,
  workflow_repository text NOT NULL,
  workflow_ref text NOT NULL,
  workflow_run_id text NOT NULL,
  workflow_run_attempt integer NOT NULL,
  runner_label text NOT NULL,
  database_project_ref char(20) NOT NULL,
  deployment_id text NOT NULL,
  deployment_origin text NOT NULL,
  stripe_account_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('collecting', 'collected', 'rechecking', 'complete', 'cancelled', 'timed_out')),
  cleanup_status text NOT NULL CHECK (cleanup_status IN ('pending', 'complete')),
  artifact_id text,
  artifact_digest char(64),
  artifact_schema integer,
  resource_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(resource_ids) = 'array'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (attempt_id, branch_id, suite, fixture_key)
);

CREATE TABLE IF NOT EXISTS billing_validation_control.retention_reservations (
  reservation_id text PRIMARY KEY,
  attempt_id text NOT NULL UNIQUE
    REFERENCES billing_validation_control.attempts(attempt_id),
  project_ref char(20) NOT NULL,
  branch_id text NOT NULL,
  stripe_account_id text NOT NULL,
  policy_version integer NOT NULL CHECK (policy_version = 1),
  quota_limits jsonb NOT NULL CHECK (
    billing_validation_control.valid_retention_usage(quota_limits, 1, false)
  ),
  projection jsonb NOT NULL CHECK (
    billing_validation_control.valid_retention_usage(projection, 0, true)
  ),
  capacity_snapshot jsonb NOT NULL CHECK (jsonb_typeof(capacity_snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS billing_validation_retention_scope
  ON billing_validation_control.retention_reservations (project_ref, branch_id, stripe_account_id);

CREATE TABLE IF NOT EXISTS billing_validation_control.retention_receipts (
  receipt_id text PRIMARY KEY,
  reservation_id text NOT NULL UNIQUE
    REFERENCES billing_validation_control.retention_reservations(reservation_id),
  attempt_id text NOT NULL UNIQUE
    REFERENCES billing_validation_control.attempts(attempt_id),
  project_ref char(20) NOT NULL,
  branch_id text NOT NULL,
  stripe_account_id text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('completed', 'failed', 'cancelled', 'timed_out')),
  retained_usage jsonb NOT NULL CHECK (
    billing_validation_control.valid_retention_usage(retained_usage, 0, true)
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS billing_validation_retention_receipt_scope
  ON billing_validation_control.retention_receipts (project_ref, branch_id, stripe_account_id);

CREATE OR REPLACE FUNCTION billing_validation_control.validate_retention_receipt_projection()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  reservation billing_validation_control.retention_reservations%ROWTYPE;
  quota_key text;
BEGIN
  SELECT * INTO reservation
  FROM billing_validation_control.retention_reservations
  WHERE reservation_id = NEW.reservation_id
  FOR KEY SHARE;
  IF NOT FOUND OR reservation.attempt_id <> NEW.attempt_id OR
     reservation.project_ref <> NEW.project_ref OR reservation.branch_id <> NEW.branch_id OR
     reservation.stripe_account_id <> NEW.stripe_account_id THEN
    RAISE EXCEPTION 'billing_retention_receipt_identity_mismatch' USING ERRCODE = '23514';
  END IF;
  FOREACH quota_key IN ARRAY ARRAY['attempts', 'databaseRows', 'authUsers', 'stripeObjects'] LOOP
    IF (NEW.retained_usage ->> quota_key)::numeric > (reservation.projection ->> quota_key)::numeric THEN
      RAISE EXCEPTION 'billing_retention_receipt_exceeds_reservation' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS billing_validation_receipt_within_reservation
  ON billing_validation_control.retention_receipts;
CREATE TRIGGER billing_validation_receipt_within_reservation
  BEFORE INSERT ON billing_validation_control.retention_receipts
  FOR EACH ROW EXECUTE FUNCTION billing_validation_control.validate_retention_receipt_projection();

CREATE OR REPLACE FUNCTION billing_validation_control.reject_retention_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'billing_retention_ledger_append_only' USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS billing_validation_reservation_immutable
  ON billing_validation_control.retention_reservations;
CREATE TRIGGER billing_validation_reservation_immutable
  BEFORE UPDATE OR DELETE ON billing_validation_control.retention_reservations
  FOR EACH ROW EXECUTE FUNCTION billing_validation_control.reject_retention_ledger_mutation();

DROP TRIGGER IF EXISTS billing_validation_receipt_immutable
  ON billing_validation_control.retention_receipts;
CREATE TRIGGER billing_validation_receipt_immutable
  BEFORE UPDATE OR DELETE ON billing_validation_control.retention_receipts
  FOR EACH ROW EXECUTE FUNCTION billing_validation_control.reject_retention_ledger_mutation();

DROP TRIGGER IF EXISTS billing_validation_reservation_no_truncate
  ON billing_validation_control.retention_reservations;
CREATE TRIGGER billing_validation_reservation_no_truncate
  BEFORE TRUNCATE ON billing_validation_control.retention_reservations
  FOR EACH STATEMENT EXECUTE FUNCTION billing_validation_control.reject_retention_ledger_mutation();
DROP TRIGGER IF EXISTS billing_validation_receipt_no_truncate
  ON billing_validation_control.retention_receipts;
CREATE TRIGGER billing_validation_receipt_no_truncate
  BEFORE TRUNCATE ON billing_validation_control.retention_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION billing_validation_control.reject_retention_ledger_mutation();

CREATE TABLE IF NOT EXISTS billing_validation_control.fixture_leases (
  branch_id text NOT NULL,
  suite text NOT NULL,
  fixture_key text NOT NULL,
  attempt_id text NOT NULL,
  owner_candidate_sha char(40) NOT NULL,
  owner_repository text NOT NULL,
  owner_ref text NOT NULL,
  owner_run_id text NOT NULL,
  owner_run_attempt integer NOT NULL,
  fence uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (branch_id, suite, fixture_key),
  FOREIGN KEY (attempt_id, branch_id, suite, fixture_key)
    REFERENCES billing_validation_control.attempts(attempt_id, branch_id, suite, fixture_key)
);
CREATE INDEX IF NOT EXISTS billing_validation_lease_expiry
  ON billing_validation_control.fixture_leases (expires_at);
REVOKE ALL ON ALL TABLES IN SCHEMA billing_validation_control FROM PUBLIC, anon, authenticated;
REVOKE UPDATE, DELETE, TRUNCATE ON billing_validation_control.retention_reservations
  FROM PUBLIC, anon, authenticated;
REVOKE UPDATE, DELETE, TRUNCATE ON billing_validation_control.retention_receipts
  FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA billing_validation_control REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
