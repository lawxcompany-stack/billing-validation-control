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
    IF jsonb_typeof(item.value) <> 'number' OR item.value::text !~ '^(0|[1-9][0-9]*)$' THEN
      RETURN false;
    END IF;
    units := (item.value #>> '{}')::numeric;
    IF units < minimum_units OR trunc(units) <> units OR units > 9007199254740991 THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN NOT require_one_attempt OR document ->> 'attempts' = '1';
END;
$$;

CREATE OR REPLACE FUNCTION billing_validation_control.valid_cleanup_projection(document jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  item jsonb;
  item_type text;
  item_id text;
  item_status text;
  key_count integer;
BEGIN
  IF jsonb_typeof(document) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  SELECT count(*) INTO key_count FROM jsonb_object_keys(document);
  IF key_count <> 6 OR NOT (document ?& ARRAY['cleanupClaim', 'databaseBaselineDigest',
      'mutatedResourceIds', 'retainedDatabaseResources', 'retainedObjects',
      'removedDatabaseFixtureCount']) THEN
    RETURN false;
  END IF;
  IF document ->> 'cleanupClaim' IS DISTINCT FROM 'owned_reversible_provider_fixtures_only' OR
     jsonb_typeof(document -> 'databaseBaselineDigest') IS DISTINCT FROM 'string' OR
     document ->> 'databaseBaselineDigest' !~ '^[a-f0-9]{64}$' OR
     jsonb_typeof(document -> 'mutatedResourceIds') IS DISTINCT FROM 'array' OR
     jsonb_typeof(document -> 'retainedDatabaseResources') IS DISTINCT FROM 'array' OR
     jsonb_typeof(document -> 'retainedObjects') IS DISTINCT FROM 'array' OR
     jsonb_typeof(document -> 'removedDatabaseFixtureCount') IS DISTINCT FROM 'number' OR
     document ->> 'removedDatabaseFixtureCount' <> '0' THEN
    RETURN false;
  END IF;
  IF jsonb_array_length(document -> 'retainedDatabaseResources') <> 0 THEN RETURN false; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(document -> 'mutatedResourceIds') LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'string' OR
       item #>> '{}' !~ '^(cs|sub)_[A-Za-z0-9_]{1,120}$' THEN
      RETURN false;
    END IF;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(document -> 'retainedObjects') LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
    SELECT count(*) INTO key_count FROM jsonb_object_keys(item);
    IF key_count <> 3 OR NOT (item ?& ARRAY['id', 'type', 'status']) OR
       jsonb_typeof(item -> 'id') IS DISTINCT FROM 'string' OR
       jsonb_typeof(item -> 'type') IS DISTINCT FROM 'string' OR
       jsonb_typeof(item -> 'status') IS DISTINCT FROM 'string' THEN
      RETURN false;
    END IF;
    item_id := item ->> 'id';
    item_type := item ->> 'type';
    item_status := item ->> 'status';
    IF NOT (CASE item_type
      WHEN 'customer' THEN item_id ~ '^cus_[A-Za-z0-9_]{1,120}$' AND item_status = 'retained_test_customer'
      WHEN 'checkout_session' THEN item_id ~ '^cs_[A-Za-z0-9_]{1,120}$' AND
        item_status IN ('expired_test_checkout_session', 'completed_test_checkout_session')
      WHEN 'subscription' THEN item_id ~ '^sub_[A-Za-z0-9_]{1,120}$' AND
        item_status IN ('retained_test_subscription', 'canceled_test_subscription')
      WHEN 'payment_intent' THEN item_id ~ '^pi_[A-Za-z0-9_]{1,120}$' AND
        item_status = 'retained_test_financial_object'
      WHEN 'invoice' THEN item_id ~ '^in_[A-Za-z0-9_]{1,120}$' AND
        item_status = 'retained_test_financial_object'
      WHEN 'charge' THEN item_id ~ '^ch_[A-Za-z0-9_]{1,120}$' AND
        item_status = 'retained_test_financial_object'
      WHEN 'setup_intent' THEN item_id ~ '^seti_[A-Za-z0-9_]{1,120}$' AND
        item_status = 'retained_test_financial_object'
      WHEN 'event' THEN item_id ~ '^evt_[A-Za-z0-9_]{1,120}$' AND
        item_status = 'retained_test_financial_object'
      ELSE false
    END) THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
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

CREATE TABLE IF NOT EXISTS billing_validation_control.resource_locks (
  resource_type text NOT NULL CHECK (resource_type IN ('supabase_branch', 'stripe_account')),
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
CREATE INDEX IF NOT EXISTS billing_validation_resource_owner
  ON billing_validation_control.resource_locks (owner_attempt_id, fence);

CREATE TABLE IF NOT EXISTS billing_validation_control.stripe_intents (
  intent_id text PRIMARY KEY,
  attempt_id text NOT NULL REFERENCES billing_validation_control.attempts(attempt_id),
  owner_fence uuid NOT NULL,
  account_id text NOT NULL,
  candidate_sha char(40) NOT NULL,
  workflow_repository text NOT NULL,
  workflow_ref text NOT NULL,
  workflow_run_id text NOT NULL,
  workflow_run_attempt integer NOT NULL CHECK (workflow_run_attempt > 0),
  runner_label text NOT NULL,
  environment_identity jsonb NOT NULL CHECK (jsonb_typeof(environment_identity) = 'object'),
  action text NOT NULL,
  operation text NOT NULL,
  request_digest char(64) NOT NULL,
  idempotency_key text NOT NULL,
  state text NOT NULL CHECK (state = 'in_flight'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (attempt_id, operation),
  UNIQUE (account_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS billing_validation_stripe_intent_attempt
  ON billing_validation_control.stripe_intents (attempt_id, created_at);

CREATE TABLE IF NOT EXISTS billing_validation_control.stripe_receipts (
  receipt_id text PRIMARY KEY,
  intent_id text NOT NULL UNIQUE REFERENCES billing_validation_control.stripe_intents(intent_id),
  attempt_id text NOT NULL REFERENCES billing_validation_control.attempts(attempt_id),
  owner_fence uuid NOT NULL,
  account_id text NOT NULL,
  operation text NOT NULL,
  request_digest char(64) NOT NULL,
  idempotency_key text NOT NULL,
  observation_digest char(64) NOT NULL,
  resource_ids jsonb NOT NULL CHECK (jsonb_typeof(resource_ids) = 'array'),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp()
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

DROP TRIGGER IF EXISTS billing_validation_stripe_intent_immutable
  ON billing_validation_control.stripe_intents;
CREATE TRIGGER billing_validation_stripe_intent_immutable
  BEFORE UPDATE OR DELETE ON billing_validation_control.stripe_intents
  FOR EACH ROW EXECUTE FUNCTION billing_validation_control.reject_retention_ledger_mutation();
DROP TRIGGER IF EXISTS billing_validation_stripe_intent_no_truncate
  ON billing_validation_control.stripe_intents;
CREATE TRIGGER billing_validation_stripe_intent_no_truncate
  BEFORE TRUNCATE ON billing_validation_control.stripe_intents
  FOR EACH STATEMENT EXECUTE FUNCTION billing_validation_control.reject_retention_ledger_mutation();
DROP TRIGGER IF EXISTS billing_validation_stripe_receipt_immutable
  ON billing_validation_control.stripe_receipts;
CREATE TRIGGER billing_validation_stripe_receipt_immutable
  BEFORE UPDATE OR DELETE ON billing_validation_control.stripe_receipts
  FOR EACH ROW EXECUTE FUNCTION billing_validation_control.reject_retention_ledger_mutation();
DROP TRIGGER IF EXISTS billing_validation_stripe_receipt_no_truncate
  ON billing_validation_control.stripe_receipts;
CREATE TRIGGER billing_validation_stripe_receipt_no_truncate
  BEFORE TRUNCATE ON billing_validation_control.stripe_receipts
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
  recovery_only boolean NOT NULL DEFAULT false,
  PRIMARY KEY (branch_id, suite, fixture_key),
  FOREIGN KEY (attempt_id, branch_id, suite, fixture_key)
    REFERENCES billing_validation_control.attempts(attempt_id, branch_id, suite, fixture_key)
);
ALTER TABLE billing_validation_control.fixture_leases
  ADD COLUMN IF NOT EXISTS recovery_only boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS billing_validation_lease_expiry
  ON billing_validation_control.fixture_leases (expires_at);

CREATE TABLE IF NOT EXISTS billing_validation_control.cleanup_receipts (
  receipt_id text PRIMARY KEY,
  reservation_id text NOT NULL UNIQUE
    REFERENCES billing_validation_control.retention_reservations(reservation_id),
  attempt_id text NOT NULL UNIQUE REFERENCES billing_validation_control.attempts(attempt_id),
  project_ref char(20) NOT NULL,
  branch_id text NOT NULL,
  deployment_id text NOT NULL,
  deployment_origin text NOT NULL,
  stripe_account_id text NOT NULL,
  owner_fence uuid NOT NULL,
  cleanup_digest char(64) NOT NULL CHECK (cleanup_digest ~ '^[a-f0-9]{64}$'),
  verified_projection jsonb NOT NULL CHECK (
    billing_validation_control.valid_cleanup_projection(verified_projection)
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

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
  SELECT * INTO reservation
  FROM billing_validation_control.retention_reservations
  WHERE reservation_id = NEW.reservation_id
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'billing_cleanup_receipt_reservation_missing' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO attempt
  FROM billing_validation_control.attempts
  WHERE attempt_id = NEW.attempt_id
  FOR KEY SHARE;
  IF NOT FOUND OR reservation.attempt_id <> NEW.attempt_id OR
     reservation.project_ref <> NEW.project_ref OR reservation.branch_id <> NEW.branch_id OR
     reservation.stripe_account_id <> NEW.stripe_account_id OR
     attempt.database_project_ref <> NEW.project_ref OR attempt.branch_id <> NEW.branch_id OR
     attempt.deployment_id <> NEW.deployment_id OR attempt.deployment_origin <> NEW.deployment_origin OR
     attempt.stripe_account_id <> NEW.stripe_account_id OR attempt.state NOT IN ('complete', 'cancelled', 'timed_out') OR
     attempt.cleanup_status <> 'pending' THEN
    RAISE EXCEPTION 'billing_cleanup_receipt_identity_mismatch' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM billing_validation_control.fixture_leases
      WHERE attempt_id = NEW.attempt_id AND fence = NEW.owner_fence AND expires_at > clock_timestamp()) THEN
    RAISE EXCEPTION 'billing_cleanup_receipt_fence_mismatch' USING ERRCODE = '23514';
  END IF;
  SELECT count(*) INTO resource_count FROM billing_validation_control.resource_locks
  WHERE owner_attempt_id = NEW.attempt_id AND fence = NEW.owner_fence;
  IF resource_count <> 2 THEN
    RAISE EXCEPTION 'billing_cleanup_receipt_resource_lock_mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS billing_validation_cleanup_receipt_identity
  ON billing_validation_control.cleanup_receipts;
CREATE TRIGGER billing_validation_cleanup_receipt_identity
  BEFORE INSERT ON billing_validation_control.cleanup_receipts
  FOR EACH ROW EXECUTE FUNCTION billing_validation_control.validate_cleanup_receipt_identity();

DROP TRIGGER IF EXISTS billing_validation_cleanup_receipt_immutable
  ON billing_validation_control.cleanup_receipts;
CREATE TRIGGER billing_validation_cleanup_receipt_immutable
  BEFORE UPDATE OR DELETE ON billing_validation_control.cleanup_receipts
  FOR EACH ROW EXECUTE FUNCTION billing_validation_control.reject_retention_ledger_mutation();
DROP TRIGGER IF EXISTS billing_validation_cleanup_receipt_no_truncate
  ON billing_validation_control.cleanup_receipts;
CREATE TRIGGER billing_validation_cleanup_receipt_no_truncate
  BEFORE TRUNCATE ON billing_validation_control.cleanup_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION billing_validation_control.reject_retention_ledger_mutation();
REVOKE ALL ON ALL TABLES IN SCHEMA billing_validation_control FROM PUBLIC, anon, authenticated;
REVOKE UPDATE, DELETE, TRUNCATE ON billing_validation_control.retention_reservations
  FROM PUBLIC, anon, authenticated;
REVOKE UPDATE, DELETE, TRUNCATE ON billing_validation_control.retention_receipts
  FROM PUBLIC, anon, authenticated;
REVOKE UPDATE, DELETE, TRUNCATE ON billing_validation_control.stripe_intents
  FROM PUBLIC, anon, authenticated;
REVOKE UPDATE, DELETE, TRUNCATE ON billing_validation_control.stripe_receipts
  FROM PUBLIC, anon, authenticated;
REVOKE UPDATE, DELETE, TRUNCATE ON billing_validation_control.cleanup_receipts
  FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA billing_validation_control REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
