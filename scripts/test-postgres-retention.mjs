import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';

const LOCAL_SCHEMA = /^billing_validation_test_[a-f0-9]{16}$/;
const VALIDATOR = /^CREATE OR REPLACE FUNCTION billing_validation_control\.valid_retention_usage\([\s\S]*?^\$\$;[ \t]*$/m;
const CLEANUP_VALIDATOR = /^CREATE OR REPLACE FUNCTION billing_validation_control\.valid_cleanup_projection\([\s\S]*?^\$\$;[ \t]*$/m;

function refuse(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

export function parseLoopbackPostgresUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { refuse('local_postgres_url_invalid',
    'BILLING_VALIDATION_LOCAL_PG_URL must be a loopback PostgreSQL URL.'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || parsed.search || parsed.hash) {
    refuse('local_postgres_url_invalid', 'BILLING_VALIDATION_LOCAL_PG_URL must be a loopback PostgreSQL URL.');
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const isLocalhost = hostname === 'localhost';
  const ipVersion = isIP(hostname);
  const isLoopbackIp = ipVersion === 4 ? hostname.split('.')[0] === '127' : ipVersion === 6 && hostname === '::1';
  if (!isLocalhost && !isLoopbackIp) {
    refuse('local_postgres_url_invalid', 'BILLING_VALIDATION_LOCAL_PG_URL must target loopback only.');
  }

  let user;
  let password;
  let database;
  try {
    user = decodeURIComponent(parsed.username);
    password = decodeURIComponent(parsed.password);
    database = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    refuse('local_postgres_url_invalid', 'BILLING_VALIDATION_LOCAL_PG_URL contains invalid encoding.');
  }
  if (!user || !database) {
    refuse('local_postgres_url_invalid', 'BILLING_VALIDATION_LOCAL_PG_URL must include a user and database.');
  }

  const port = parsed.port || '5432';
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    refuse('local_postgres_url_invalid', 'BILLING_VALIDATION_LOCAL_PG_URL has an invalid port.');
  }
  return Object.freeze({ hostAddress: isLocalhost ? '127.0.0.1' : hostname, port, user, password, database });
}

export function buildRetentionValidationSql(schemaSql, schemaName) {
  if (typeof schemaName !== 'string' || !LOCAL_SCHEMA.test(schemaName)) {
    refuse('local_postgres_schema_invalid', 'The temporary local PostgreSQL schema name is invalid.');
  }
  const definition = schemaSql.match(VALIDATOR)?.[0];
  if (!definition) refuse('local_postgres_validator_missing',
    'Could not locate valid_retention_usage in src/attempts/schema.sql.');
  const cleanupDefinition = schemaSql.match(CLEANUP_VALIDATOR)?.[0];
  if (!cleanupDefinition) refuse('local_postgres_validator_missing',
    'Could not locate valid_cleanup_projection in src/attempts/schema.sql.');

  const localDefinition = definition.replace(
    'billing_validation_control.valid_retention_usage', `${schemaName}.valid_retention_usage`);
  const localCleanupDefinition = cleanupDefinition.replace(
    'billing_validation_control.valid_cleanup_projection', `${schemaName}.valid_cleanup_projection`);
  return `BEGIN;
CREATE SCHEMA ${schemaName};
${localDefinition}
${localCleanupDefinition}
DO $retention_assertions$
BEGIN
  IF NOT ${schemaName}.valid_retention_usage(
    '{"attempts":1,"databaseRows":2,"authUsers":0,"stripeObjects":3}'::jsonb, 0, true
  ) THEN
    RAISE EXCEPTION 'canonical_retention_usage_rejected';
  END IF;
  IF ${schemaName}.valid_retention_usage(
    '{"attempts":1,"databaseRows":2.0,"authUsers":0,"stripeObjects":3}'::jsonb, 0, true
  ) THEN
    RAISE EXCEPTION 'decimal_retention_usage_accepted';
  END IF;
END
$retention_assertions$;
DO $cleanup_assertions$
BEGIN
  IF NOT ${schemaName}.valid_cleanup_projection(
    '{"cleanupClaim":"owned_reversible_provider_fixtures_only","databaseBaselineDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","mutatedResourceIds":["cs_test123"],"retainedDatabaseResources":[],"retainedObjects":[{"id":"cus_test123","type":"customer","status":"retained_test_customer"}],"removedDatabaseFixtureCount":0}'::jsonb
  ) THEN
    RAISE EXCEPTION 'canonical_cleanup_projection_rejected';
  END IF;
  IF ${schemaName}.valid_cleanup_projection(
    '{"cleanupClaim":"owned_reversible_provider_fixtures_only","databaseBaselineDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","mutatedResourceIds":[],"retainedDatabaseResources":[],"retainedObjects":[],"removedDatabaseFixtureCount":0,"extra":true}'::jsonb
  ) THEN
    RAISE EXCEPTION 'unknown_cleanup_projection_field_accepted';
  END IF;
  IF ${schemaName}.valid_cleanup_projection('null'::jsonb) THEN
    RAISE EXCEPTION 'invalid_cleanup_projection_accepted';
  END IF;
END
$cleanup_assertions$;
ROLLBACK;
`;
}

function psqlEnvironment(connection) {
  const environment = { ...process.env };
  delete environment.PGSERVICE;
  return {
    ...environment,
    PGHOST: connection.hostAddress,
    PGHOSTADDR: connection.hostAddress,
    PGPORT: connection.port,
    PGUSER: connection.user,
    PGPASSWORD: connection.password,
    PGDATABASE: connection.database,
    PGSSLMODE: 'disable',
    PGCONNECT_TIMEOUT: '5',
    PGSERVICEFILE: '/dev/null',
    PGPASSFILE: '/dev/null',
  };
}

export function runRetentionValidation({ connectionUrl, schemaSql, spawn = spawnSync } = {}) {
  const connection = parseLoopbackPostgresUrl(connectionUrl);
  const schemaName = `billing_validation_test_${randomBytes(8).toString('hex')}`;
  const sql = buildRetentionValidationSql(schemaSql, schemaName);
  const result = spawn('psql', ['-X', '-q', '-w', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], {
    input: sql,
    encoding: 'utf8',
    timeout: 15_000,
    env: psqlEnvironment(connection),
  });
  if (result.error) {
    if (result.error.code === 'ENOENT') refuse('local_postgres_psql_missing', 'psql is required for this local integration test.');
    refuse('local_postgres_execution_failed', 'The local PostgreSQL integration test could not be executed.');
  }
  if (result.status !== 0) refuse('local_postgres_execution_failed',
    `The local PostgreSQL integration test failed (psql exit ${result.status ?? 'unknown'}).`);
}

export function main() {
  const connectionUrl = process.env.BILLING_VALIDATION_LOCAL_PG_URL;
  if (!connectionUrl) {
    refuse('local_postgres_url_required', 'Set BILLING_VALIDATION_LOCAL_PG_URL to a disposable loopback PostgreSQL URL.');
  }
  const schemaSql = readFileSync(new URL('../src/attempts/schema.sql', import.meta.url), 'utf8');
  runRetentionValidation({ connectionUrl, schemaSql });
  process.stdout.write('Local PostgreSQL retention and cleanup validators passed.\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(); } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
