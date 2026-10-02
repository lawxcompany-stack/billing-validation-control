import {
  CONTROL_RUNTIME_FINGERPRINT_EMPTY_SEQUENCES,
  CONTROL_RUNTIME_FINGERPRINT_EMPTY_TABLES,
  CONTROL_RUNTIME_PRIVILEGES,
} from '../../src/attempts/runtime-privileges.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CONTROL_STORE_BOOTSTRAP_PINS } from '../../src/attempts/control-store-bootstrap-pins.mjs';

const SCHEMA = 'billing_validation_control';
const OWNER_ROLE = 'billing_validation_owner';
const RUNTIME_ROLE = 'billing_validation_runtime';
const VERIFIER_ROLE = 'billing_validation_verifier';

export function testControlPolicy() {
  const projectRef = 'abcdefghijklmnopqrst';
  return Object.freeze({
    schemaVersion: 1,
    projectRef,
    region: 'sa-east-1',
    databaseVersion: '17.11.0.002',
    schema: SCHEMA,
    roles: Object.freeze({ owner: OWNER_ROLE, runtime: RUNTIME_ROLE, verifier: VERIFIER_ROLE }),
    connection: Object.freeze({ protocol: 'postgresql', host: `db.${projectRef}.supabase.co`,
      port: 5432, database: 'postgres', sslMode: 'require' }),
    urlEnvironment: 'BILLING_CONTROL_VERIFIER_DATABASE_URL',
  });
}

export function testBaselineDigest() {
  const bytes = readFileSync(new URL('../../src/attempts/schema.sql', import.meta.url));
  return createHash('sha256').update(bytes).digest('hex');
}

export function testControlTarget(policy = testControlPolicy()) {
  return Object.freeze({ projectRef: policy.projectRef, host: policy.connection.host,
    port: policy.connection.port, database: policy.connection.database,
    username: policy.roles.verifier, sslMode: policy.connection.sslMode });
}

function expectedPrivilegeFingerprint(policy) {
  const rows = [
    'role|owner_login|0',
    'role|runtime_login|0',
    'role|runtime_superuser|0',
    'role|runtime_create_role|0',
    'role|runtime_create_database|0',
    'role|runtime_replication|0',
    'role|runtime_bypass_rls|0',
    'role|runtime_member_of_owner|0',
    'role|runtime_has_role_membership|0',
    'role|runtime_owns_objects|0',
    'role|verifier_login|1',
    'role|verifier_superuser|0',
    'role|verifier_create_role|0',
    'role|verifier_create_database|0',
    'role|verifier_replication|0',
    'role|verifier_bypass_rls|0',
    'role|verifier_member_of_owner|0',
    'role|verifier_has_role_membership|0',
    'role|verifier_owns_objects|0',
    'role|owner_owns_objects|1',
    `schema|owner|${policy.roles.owner}`,
    'schema|usage|1',
    'schema|create|0',
    'schema|verifier_usage|1',
    'schema|verifier_create|0',
    'verifier|table_privileges|0',
    'verifier|sequence_privileges|0',
    'verifier|unapproved_function_execute|0',
  ];
  const tables = { ...CONTROL_RUNTIME_PRIVILEGES.tables,
    ...Object.fromEntries(CONTROL_RUNTIME_FINGERPRINT_EMPTY_TABLES.map((name) => [name, {}])) };
  for (const [name, rights] of Object.entries(tables).sort(([left], [right]) => left.localeCompare(right, 'en'))) {
    const selectTable = rights.select === true;
    const selectColumns = Array.isArray(rights.select) ? [...rights.select].sort().join(',') : '';
    const referenceColumns = [...(rights.references ?? [])].sort().join(',');
    const insertColumns = [...(rights.insert ?? [])].sort().join(',');
    const updateColumns = [...(rights.update ?? [])].sort().join(',');
    rows.push(`table|${name}|${selectTable ? 1 : 0}|${selectColumns}|${rights.insertTable ? 1 : 0}|${insertColumns}|${rights.updateTable ? 1 : 0}|${updateColumns}|${rights.referencesTable ? 1 : 0}|${referenceColumns}|${rights.delete ? 1 : 0}|${rights.truncate ? 1 : 0}|${rights.trigger ? 1 : 0}|${rights.maintain ? 1 : 0}`);
  }
  const sequences = { ...CONTROL_RUNTIME_PRIVILEGES.sequences,
    ...Object.fromEntries(CONTROL_RUNTIME_FINGERPRINT_EMPTY_SEQUENCES.map((name) => [name, {}])) };
  for (const [name, rights] of Object.entries(sequences)) {
    rows.push(`sequence|${name}|${rights.usage ? 1 : 0}|${rights.select ? 1 : 0}|${rights.update ? 1 : 0}`);
  }
  for (const [signature, rights] of Object.entries(CONTROL_RUNTIME_PRIVILEGES.functions)) {
    if (rights.execute) rows.push(`function|${signature}|runtime|1|verifier|0`);
  }
  rows.push('function|verify_attempt_control_store()|runtime|0|verifier|1');
  const source = rows.sort().join('\n');
  return createHash('sha256').update(source).digest('hex');
}

export function testControlVerifierRow(policy = testControlPolicy(), overrides = {}) {
  const migrationSummary = CONTROL_STORE_BOOTSTRAP_PINS.migrations.map(({ version, name, sha256 }) =>
    `${version}|${name}|${sha256}`).join('\n');
  const migrationSha256 = createHash('sha256').update(migrationSummary).digest('hex');
  const privilegeFingerprintSha256 = expectedPrivilegeFingerprint(policy);
  return {
    project_ref: policy.projectRef,
    database_name: policy.connection.database,
    session_role: policy.roles.verifier,
    verifier_role: policy.roles.owner,
    role_setting: 'none',
    server_version_num: '170011',
    owner_login: false,
    runtime_login: false,
    runtime_superuser: false,
    runtime_create_role: false,
    runtime_create_database: false,
    runtime_replication: false,
    runtime_bypass_rls: false,
    runtime_member_of_owner: false,
    runtime_has_role_membership: false,
    runtime_owns_objects: false,
    owner_owns_objects: true,
    schema_owner: policy.roles.owner,
    baseline_sha256: testBaselineDigest(),
    migration_count: CONTROL_STORE_BOOTSTRAP_PINS.migrations.length,
    migration_sha256: migrationSha256,
    privilege_fingerprint_sha256: privilegeFingerprintSha256,
    ...overrides,
  };
}

function refuseTarget() {
  const error = new Error('Local control-store PostgreSQL target is invalid.');
  error.code = 'control_store_test_target_invalid';
  throw error;
}

export function parseControlStoreLocalTestUrl(value) {
  try {
    if (typeof value !== 'string' || value.length === 0) refuseTarget();
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[|\]$/gu, '');
    const loopback = hostname === '127.0.0.1' || hostname === '::1';
    const port = Number(url.port);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !loopback || !Number.isInteger(port) ||
        port < 1 || port > 65535 || decodeURIComponent(url.username) !== 'postgres' ||
        url.pathname !== '/postgres' || url.search !== '' || url.hash !== '') refuseTarget();
    return {
      host: hostname,
      port,
      database: 'postgres',
      user: 'postgres',
      password: decodeURIComponent(url.password),
    };
  } catch {
    refuseTarget();
  }
}

function sameSorted(actual, expected) {
  return JSON.stringify([...(actual ?? [])].sort()) === JSON.stringify([...expected].sort());
}

export async function inspectControlStoreRuntimeRole(client) {
  if (typeof client?.query !== 'function') refuseTarget();
  const roleResult = await client.query(`
    SELECT owner.rolcanlogin AS owner_login,
      runtime.rolcanlogin AS runtime_login,
      runtime.rolsuper AS runtime_superuser,
      runtime.rolcreatedb AS runtime_create_database,
      runtime.rolcreaterole AS runtime_create_role,
      runtime.rolreplication AS runtime_replication,
      runtime.rolbypassrls AS runtime_bypass_rls,
      pg_catalog.pg_has_role(runtime.oid, owner.oid, 'MEMBER') AS runtime_member_of_owner,
      EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members AS membership
        WHERE membership.member = runtime.oid OR membership.roleid = runtime.oid)
        AS runtime_has_role_membership,
      EXISTS (SELECT 1 FROM pg_catalog.pg_class AS relation
        WHERE relation.relnamespace = namespace.oid AND relation.relowner = runtime.oid)
        OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS procedure
          WHERE procedure.pronamespace = namespace.oid AND procedure.proowner = runtime.oid)
        AS runtime_owns_objects,
      NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class AS relation
        WHERE relation.relnamespace = namespace.oid AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
          AND relation.relowner <> owner.oid)
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS procedure
          WHERE procedure.pronamespace = namespace.oid AND procedure.proowner <> owner.oid)
        AS owner_owns_objects,
      namespace.nspowner = owner.oid AS schema_owner,
      pg_catalog.has_schema_privilege(runtime.oid, namespace.oid, 'USAGE') AS runtime_schema_usage,
      pg_catalog.has_schema_privilege(runtime.oid, namespace.oid, 'CREATE') AS runtime_schema_create,
      pg_catalog.has_table_privilege(runtime.oid,
        pg_catalog.to_regclass('billing_validation_control.schema_migrations'), 'SELECT') AS migration_ledger_select,
      pg_catalog.has_table_privilege(runtime.oid,
        pg_catalog.to_regclass('billing_validation_control.control_store_install_receipts'), 'SELECT') AS install_receipt_select,
      owner.oid AS owner_oid, runtime.oid AS runtime_oid, namespace.oid AS schema_oid
    FROM pg_catalog.pg_roles AS owner
    CROSS JOIN pg_catalog.pg_roles AS runtime
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.nspname = $1
    WHERE owner.rolname = $2 AND runtime.rolname = $3`, [SCHEMA, OWNER_ROLE, RUNTIME_ROLE]);
  const role = roleResult.rows?.[0];
  if (!role) refuseTarget();

  const tableResult = await client.query(`
    SELECT relation.relname,
      pg_catalog.has_table_privilege($1, relation.oid, 'SELECT') AS table_select,
      pg_catalog.has_table_privilege($1, relation.oid, 'INSERT') AS table_insert,
      pg_catalog.has_table_privilege($1, relation.oid, 'UPDATE') AS table_update,
      pg_catalog.has_table_privilege($1, relation.oid, 'DELETE') AS table_delete,
      pg_catalog.has_table_privilege($1, relation.oid, 'TRUNCATE') AS table_truncate,
      ARRAY(SELECT attribute.attname::text
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = relation.oid AND attribute.attnum > 0 AND NOT attribute.attisdropped
        ORDER BY attribute.attname) AS all_columns,
      ARRAY(SELECT attribute.attname::text
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = relation.oid AND attribute.attnum > 0 AND NOT attribute.attisdropped
          AND pg_catalog.has_column_privilege($1, relation.oid, attribute.attnum, 'SELECT')
        ORDER BY attribute.attname) AS select_columns,
      ARRAY(SELECT attribute.attname::text
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = relation.oid AND attribute.attnum > 0 AND NOT attribute.attisdropped
          AND pg_catalog.has_column_privilege($1, relation.oid, attribute.attnum, 'INSERT')
        ORDER BY attribute.attname) AS insert_columns,
      ARRAY(SELECT attribute.attname::text
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = relation.oid AND attribute.attnum > 0 AND NOT attribute.attisdropped
          AND pg_catalog.has_column_privilege($1, relation.oid, attribute.attnum, 'UPDATE')
        ORDER BY attribute.attname) AS update_columns
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = $2 AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
    ORDER BY relation.relname`, [RUNTIME_ROLE, SCHEMA]);
  const actualTables = new Map((tableResult.rows ?? []).map((row) => [row.relname, row]));
  const expectedTables = CONTROL_RUNTIME_PRIVILEGES.tables;
  let privilegeMatrixMatches = true;
  const privilegeMatrixMismatchDetails = [];
  for (const [name, row] of actualTables) {
    const expected = expectedTables[name] ?? {};
    const expectedSelect = expected.select === true ? row.all_columns : expected.select ?? [];
    const tableMatches = row.table_select === (expected.select === true) &&
      sameSorted(row.select_columns, expectedSelect) &&
      row.table_insert === false && sameSorted(row.insert_columns, expected.insert ?? []) &&
      row.table_update === false && sameSorted(row.update_columns, expected.update ?? []) &&
      row.table_delete === (expected.delete === true) && row.table_truncate === false;
    privilegeMatrixMatches &&= tableMatches;
    if (!tableMatches) {
      privilegeMatrixMismatchDetails.push({
        kind: 'table',
        name,
        actual: {
          tableSelect: row.table_select,
          selectColumns: row.select_columns,
          tableInsert: row.table_insert,
          insertColumns: row.insert_columns,
          tableUpdate: row.table_update,
          updateColumns: row.update_columns,
          tableDelete: row.table_delete,
          tableTruncate: row.table_truncate,
        },
        expected: {
          tableSelect: expected.select === true,
          selectColumns: expectedSelect,
          tableInsert: false,
          insertColumns: expected.insert ?? [],
          tableUpdate: false,
          updateColumns: expected.update ?? [],
          tableDelete: expected.delete === true,
          tableTruncate: false,
        },
      });
    }
  }
  for (const name of Object.keys(expectedTables)) {
    if (!actualTables.has(name)) {
      privilegeMatrixMatches = false;
      privilegeMatrixMismatchDetails.push({ kind: 'missing_table', name });
    }
  }

  const sequenceResult = await client.query(`
    SELECT relation.relname,
      pg_catalog.has_sequence_privilege($1, relation.oid, 'USAGE') AS usage,
      pg_catalog.has_sequence_privilege($1, relation.oid, 'SELECT') AS select,
      pg_catalog.has_sequence_privilege($1, relation.oid, 'UPDATE') AS update
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = $2 AND relation.relkind = 'S'`, [RUNTIME_ROLE, SCHEMA]);
  const expectedSequences = CONTROL_RUNTIME_PRIVILEGES.sequences;
  const actualSequences = new Map((sequenceResult.rows ?? []).map((row) => [row.relname, row]));
  for (const [name, row] of actualSequences) {
    const expected = expectedSequences[name] ?? {};
    const sequenceMatches = row.usage === (expected.usage === true) && row.select === false && row.update === false;
    privilegeMatrixMatches &&= sequenceMatches;
    if (!sequenceMatches) {
      privilegeMatrixMismatchDetails.push({ kind: 'sequence', name,
        actual: { usage: row.usage, select: row.select, update: row.update },
        expected: { usage: expected.usage === true, select: false, update: false } });
    }
  }
  for (const name of Object.keys(expectedSequences)) {
    if (!actualSequences.has(name)) {
      privilegeMatrixMatches = false;
      privilegeMatrixMismatchDetails.push({ kind: 'missing_sequence', name });
    }
  }

  const functionResult = await client.query(`
    SELECT procedure.proname || '(' || COALESCE((
      SELECT string_agg(pg_catalog.format_type(argument_type, NULL), ',' ORDER BY argument_order)
      FROM unnest(procedure.proargtypes::oid[]) WITH ORDINALITY AS argument(argument_type, argument_order)
    ), '') || ')' AS signature,
      pg_catalog.has_function_privilege($1, procedure.oid, 'EXECUTE') AS execute
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = $2`, [RUNTIME_ROLE, SCHEMA]);
  const expectedFunctions = CONTROL_RUNTIME_PRIVILEGES.functions;
  const actualFunctions = new Map((functionResult.rows ?? []).map((row) => [row.signature, row.execute]));
  for (const [signature, execute] of actualFunctions) {
    const expectedExecute = expectedFunctions[signature]?.execute === true;
    const functionMatches = execute === expectedExecute;
    privilegeMatrixMatches &&= functionMatches;
    if (!functionMatches) {
      privilegeMatrixMismatchDetails.push({ kind: 'function', signature,
        actualExecute: execute, expectedExecute });
    }
  }
  for (const signature of Object.keys(expectedFunctions)) {
    if (!actualFunctions.has(signature)) {
      privilegeMatrixMatches = false;
      privilegeMatrixMismatchDetails.push({ kind: 'missing_function', signature });
    }
  }

  const forbiddenPrincipalResult = await client.query(`
    WITH principals AS (
      SELECT 0::oid AS role_oid
      UNION ALL
      SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')
    ), object_grants AS (
      SELECT privilege.grantee
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(relation.relacl, pg_catalog.acldefault(
          CASE WHEN relation.relkind = 'S' THEN 'S'::"char" ELSE 'r'::"char" END, relation.relowner))) AS privilege
      WHERE namespace.nspname = $1
      UNION ALL
      SELECT privilege.grantee
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(procedure.proacl, pg_catalog.acldefault('f'::"char", procedure.proowner))) AS privilege
      WHERE namespace.nspname = $1
      UNION ALL
      SELECT privilege.grantee
      FROM pg_catalog.pg_namespace AS namespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(namespace.nspacl, pg_catalog.acldefault('n'::"char", namespace.nspowner))) AS privilege
      WHERE namespace.nspname = $1
    )
    SELECT EXISTS (SELECT 1 FROM object_grants
      WHERE grantee IN (SELECT role_oid FROM principals)) AS leaked`, [SCHEMA]);

  const appendOnlyTables = [
    'schema_migrations', 'control_store_install_receipts', 'fixture_lease_history',
    'fixture_reservation_claims', 'fixture_reservation_claim_events', 'retention_reservations',
    'retention_receipts', 'cleanup_receipts', 'fixture_case_claims', 'fixture_resource_claims',
    'stripe_intents', 'stripe_receipts',
  ];
  const appendOnlyMutations = appendOnlyTables.some((name) => {
    const row = actualTables.get(name);
    return row && (row.table_update || row.update_columns?.length || row.table_delete || row.table_truncate);
  });
  const denialProbe = await probeRuntimeDenials(client);
  return {
    ownerLogin: role.owner_login,
    runtimeLogin: role.runtime_login,
    runtimeSuperuser: role.runtime_superuser,
    runtimeCreateRole: role.runtime_create_role,
    runtimeCreateDatabase: role.runtime_create_database,
    runtimeReplication: role.runtime_replication,
    runtimeBypassRls: role.runtime_bypass_rls,
    runtimeMemberOfOwner: role.runtime_member_of_owner,
    runtimeHasRoleMembership: role.runtime_has_role_membership,
    runtimeOwnsObjects: role.runtime_owns_objects,
    ownerOwnsObjects: role.owner_owns_objects,
    schemaOwner: role.schema_owner,
    runtimeSchemaUsage: role.runtime_schema_usage,
    runtimeSchemaCreate: role.runtime_schema_create,
    migrationLedgerSelect: role.migration_ledger_select,
    installReceiptSelect: role.install_receipt_select,
    privilegeMatrixMatches,
    privilegeMatrixMismatchDetails,
    appendOnlyMutations,
    forbiddenPrincipalHasGrants: forbiddenPrincipalResult.rows?.[0]?.leaked === true,
    ...await probeFutureFunctionDefaultAcl(client, role),
    deniedOperations: denialProbe.operations,
    denialProbeIdentity: denialProbe.identity,
  };
}

async function probeFutureFunctionDefaultAcl(client, role) {
  const backend = await client.query('SELECT pg_catalog.pg_backend_pid() AS pid');
  const pid = Number(backend.rows?.[0]?.pid);
  if (!Number.isSafeInteger(pid) || pid < 1) refuseTarget();
  const functionName = `task3_default_acl_probe_${pid}`;
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL ROLE ${OWNER_ROLE}`);
    await client.query(`CREATE FUNCTION ${SCHEMA}.${functionName}() RETURNS integer
      LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS 'SELECT 1'`);
    await client.query('RESET ROLE');
    const result = await client.query(`SELECT
      pg_catalog.has_function_privilege($1::oid, procedure.oid, 'EXECUTE') AS runtime_execute,
      EXISTS (
        SELECT 1 FROM pg_catalog.aclexplode(COALESCE(procedure.proacl,
          pg_catalog.acldefault('f'::"char", procedure.proowner))) AS privilege
        WHERE privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE'
      ) AS public_execute
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = $2 AND procedure.proname = $3`,
    [role.runtime_oid, SCHEMA, functionName]);
    if (result.rows?.length !== 1) refuseTarget();
    await client.query('ROLLBACK');
    return {
      defaultAclPublicExecute: result.rows[0].public_execute === true,
      defaultAclWidensRuntime: result.rows[0].runtime_execute === true,
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain the primary probe failure */ }
    throw error;
  }
}

async function probeRuntimeDenials(client) {
  const probes = [
    ['migration history read', `SELECT * FROM ${SCHEMA}.schema_migrations LIMIT 0`],
    ['append-only update', `UPDATE ${SCHEMA}.fixture_reservation_claim_events
      SET current_rows = current_rows WHERE false`],
    ['append-only delete', `DELETE FROM ${SCHEMA}.fixture_reservation_claim_events WHERE false`],
    ['append-only truncate', `TRUNCATE TABLE ${SCHEMA}.fixture_reservation_claim_events`],
    ['schema create', `CREATE TABLE ${SCHEMA}.__task3_runtime_probe (id integer)`],
    ['trigger alter', `ALTER TABLE ${SCHEMA}.fixture_reservation_claim_events DISABLE TRIGGER ALL`],
    ['grant escalation no-op', `GRANT SELECT ON TABLE ${SCHEMA}.attempts TO PUBLIC`],
  ];
  const denied = {};
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL ROLE ${RUNTIME_ROLE}`);
    const identityResult = await client.query(`SELECT session_user, current_user,
        role.rolsuper AS current_user_superuser
      FROM pg_catalog.pg_roles AS role WHERE role.rolname = current_user`);
    const identity = identityResult.rows?.[0];
    if (identityResult.rows?.length !== 1 || identity.current_user !== RUNTIME_ROLE) refuseTarget();
    for (const [name, sql] of probes) {
      await client.query('SAVEPOINT runtime_privilege_probe');
      let operationError = null;
      try { await client.query(sql); } catch (error) { operationError = error; }
      let refused = operationError !== null;
      if (name === 'grant escalation no-op') {
        if (operationError) {
          refused = operationError.code === '42501';
        } else {
          // PostgreSQL can accept GRANT from a non-owner that holds the privilege,
          // emit a warning, and grant nothing when the caller lacks GRANT OPTION.
          // Verify the observable ACL effect instead of treating command completion
          // as escalation.
          const grantReadback = await client.query(`SELECT EXISTS (
              SELECT 1
              FROM pg_catalog.pg_class AS relation
              CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(relation.relacl,
                pg_catalog.acldefault('r'::"char", relation.relowner))) AS privilege
              WHERE relation.oid = pg_catalog.to_regclass($1)
                AND privilege.grantee = 0 AND privilege.privilege_type = 'SELECT'
            ) AS public_select`, [`${SCHEMA}.attempts`]);
          refused = grantReadback.rows?.length === 1 && grantReadback.rows[0].public_select === false;
        }
      }
      await client.query('ROLLBACK TO SAVEPOINT runtime_privilege_probe');
      await client.query('RELEASE SAVEPOINT runtime_privilege_probe');
      denied[name] = refused;
    }
    await client.query('ROLLBACK');
    return { identity, operations: denied };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain the primary probe failure */ }
    throw error;
  }
}
