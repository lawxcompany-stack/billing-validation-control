CREATE SCHEMA IF NOT EXISTS billing_validation_control;
REVOKE ALL ON SCHEMA billing_validation_control FROM PUBLIC;
REVOKE ALL ON SCHEMA billing_validation_control FROM anon, authenticated;

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

CREATE TABLE IF NOT EXISTS billing_validation_control.fixture_leases (
  branch_id text NOT NULL,
  suite text NOT NULL,
  fixture_key text NOT NULL,
  attempt_id text NOT NULL REFERENCES billing_validation_control.attempts(attempt_id),
  owner_candidate_sha char(40) NOT NULL,
  owner_repository text NOT NULL,
  owner_ref text NOT NULL,
  owner_run_id text NOT NULL,
  owner_run_attempt integer NOT NULL,
  fence uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (branch_id, suite, fixture_key)
);
CREATE INDEX IF NOT EXISTS billing_validation_lease_expiry
  ON billing_validation_control.fixture_leases (expires_at);
REVOKE ALL ON ALL TABLES IN SCHEMA billing_validation_control FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA billing_validation_control REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
