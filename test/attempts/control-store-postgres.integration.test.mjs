import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { CONTROL_STORE_POLICY } from '../../src/attempts/control-store-policy.mjs';
import { loadControlStoreBootstrapPlan, renderControlStoreBootstrap } from '../../src/attempts/control-store-bootstrap.mjs';
import { verifyAttemptControlStore } from '../../src/attempts/control-store-verifier.mjs';
import { CONTROL_STORE_BOOTSTRAP_PINS } from '../../src/attempts/control-store-bootstrap-pins.mjs';
import { parseControlStoreLocalTestUrl, testControlVerifierRow } from './control-store-fixtures.mjs';

const connectionUrl = process.env.BILLING_CONTROL_STORE_LOCAL_TEST_URL;
const projectRef = CONTROL_STORE_POLICY.projectRef;
const schema = CONTROL_STORE_POLICY.schema;
const runtimeRole = CONTROL_STORE_POLICY.roles.runtime;
const verifierRole = CONTROL_STORE_POLICY.roles.verifier;

async function readVerifierGateDiagnostics(client) {
  const result = await client.query(`
    WITH state AS (
      SELECT owner.oid AS owner_oid, runtime.oid AS runtime_oid, verifier.oid AS verifier_oid,
        bootstrap_operator.oid AS bootstrap_operator_oid,
        verifier_function.oid AS verifier_function_oid,
        verifier.rolcanlogin AS verifier_login, verifier.rolsuper AS verifier_superuser,
        verifier.rolcreaterole AS verifier_create_role, verifier.rolcreatedb AS verifier_create_database,
        verifier.rolreplication AS verifier_replication, verifier.rolbypassrls AS verifier_bypass_rls,
        pg_catalog.pg_has_role(verifier.oid, owner.oid, 'MEMBER') AS verifier_member_of_owner,
        EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members AS membership
          WHERE (membership.member = verifier.oid OR membership.roleid = verifier.oid)
            AND NOT (
              bootstrap_operator.oid IS NOT NULL
              AND membership.roleid = verifier.oid AND membership.member = bootstrap_operator.oid
              AND membership.admin_option AND NOT membership.inherit_option AND NOT membership.set_option
              AND EXISTS (SELECT 1 FROM pg_catalog.pg_roles AS grantor
                WHERE grantor.oid = membership.grantor AND grantor.rolsuper)
            ))
          AS verifier_has_role_membership,
        EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members AS membership
          WHERE (membership.member = owner.oid OR membership.roleid = owner.oid)
            AND NOT (
              bootstrap_operator.oid IS NOT NULL
              AND membership.roleid = owner.oid AND membership.member = bootstrap_operator.oid
              AND membership.admin_option AND NOT membership.inherit_option AND NOT membership.set_option
              AND EXISTS (SELECT 1 FROM pg_catalog.pg_roles AS grantor
                WHERE grantor.oid = membership.grantor AND grantor.rolsuper)
            )) AS owner_has_role_membership,
        EXISTS (SELECT 1 FROM pg_catalog.pg_class AS relation
          WHERE relation.relnamespace = namespace.oid AND relation.relowner = verifier.oid)
          OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS routine
            WHERE routine.pronamespace = namespace.oid AND routine.proowner = verifier.oid)
          AS verifier_owns_objects,
        NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class AS relation
          WHERE relation.relnamespace = namespace.oid AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
            AND relation.relowner <> owner.oid)
          AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS routine
            WHERE routine.pronamespace = namespace.oid AND routine.proowner <> owner.oid)
          AS owner_owns_objects,
        pg_catalog.has_schema_privilege(verifier.oid, namespace.oid, 'USAGE') AS verifier_schema_usage,
        pg_catalog.has_schema_privilege(verifier.oid, namespace.oid, 'CREATE') AS verifier_schema_create,
        EXISTS (SELECT 1 FROM pg_catalog.pg_class AS relation
          WHERE relation.relnamespace = namespace.oid AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND (pg_catalog.has_table_privilege(verifier.oid, relation.oid, 'SELECT') OR
              pg_catalog.has_table_privilege(verifier.oid, relation.oid, 'INSERT') OR
              pg_catalog.has_table_privilege(verifier.oid, relation.oid, 'UPDATE') OR
              pg_catalog.has_table_privilege(verifier.oid, relation.oid, 'REFERENCES') OR
              pg_catalog.has_table_privilege(verifier.oid, relation.oid, 'DELETE') OR
              pg_catalog.has_table_privilege(verifier.oid, relation.oid, 'TRUNCATE') OR
              pg_catalog.has_table_privilege(verifier.oid, relation.oid, 'TRIGGER') OR
              pg_catalog.has_table_privilege(verifier.oid, relation.oid, 'MAINTAIN') OR
              EXISTS (SELECT 1 FROM pg_catalog.pg_attribute AS attribute
                WHERE attribute.attrelid = relation.oid AND attribute.attnum > 0 AND NOT attribute.attisdropped
                  AND (pg_catalog.has_column_privilege(verifier.oid, relation.oid, attribute.attnum, 'SELECT') OR
                    pg_catalog.has_column_privilege(verifier.oid, relation.oid, attribute.attnum, 'INSERT') OR
                    pg_catalog.has_column_privilege(verifier.oid, relation.oid, attribute.attnum, 'UPDATE') OR
                    pg_catalog.has_column_privilege(verifier.oid, relation.oid, attribute.attnum, 'REFERENCES')))))
          AS verifier_table_privileges,
        EXISTS (SELECT 1 FROM pg_catalog.pg_class AS relation
          WHERE relation.relnamespace = namespace.oid AND relation.relkind = 'S'
            AND (pg_catalog.has_sequence_privilege(verifier.oid, relation.oid, 'USAGE') OR
              pg_catalog.has_sequence_privilege(verifier.oid, relation.oid, 'SELECT') OR
              pg_catalog.has_sequence_privilege(verifier.oid, relation.oid, 'UPDATE')))
          AS verifier_sequence_privileges,
        EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS routine
          WHERE routine.pronamespace = namespace.oid AND routine.oid <> verifier_function.oid
            AND pg_catalog.has_function_privilege(verifier.oid, routine.oid, 'EXECUTE'))
          AS verifier_unapproved_function_execute,
        pg_catalog.has_function_privilege(runtime.oid, verifier_function.oid, 'EXECUTE') AS runtime_can_execute_verifier,
        pg_catalog.has_function_privilege(verifier.oid, verifier_function.oid, 'EXECUTE') AS verifier_can_execute_verifier,
        EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(verifier_function.proacl,
          pg_catalog.acldefault('f', verifier_function.proowner))) AS function_acl
          WHERE function_acl.grantee = 0 AND function_acl.privilege_type = 'EXECUTE') AS public_can_execute_verifier,
        pg_catalog.has_function_privilege(anon.oid, verifier_function.oid, 'EXECUTE') AS anon_can_execute_verifier,
        pg_catalog.has_function_privilege(authenticated.oid, verifier_function.oid, 'EXECUTE')
          AS authenticated_can_execute_verifier,
        pg_catalog.has_function_privilege(service_role.oid, verifier_function.oid, 'EXECUTE')
          AS service_role_can_execute_verifier
      FROM pg_catalog.pg_roles AS owner
      CROSS JOIN pg_catalog.pg_roles AS runtime
      CROSS JOIN pg_catalog.pg_roles AS verifier
      CROSS JOIN pg_catalog.pg_roles AS anon
      CROSS JOIN pg_catalog.pg_roles AS authenticated
      CROSS JOIN pg_catalog.pg_roles AS service_role
      LEFT JOIN pg_catalog.pg_roles AS bootstrap_operator ON bootstrap_operator.rolname = 'postgres'
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.nspname = $4
      JOIN pg_catalog.pg_proc AS verifier_function ON verifier_function.pronamespace = namespace.oid
        AND verifier_function.proname = 'verify_attempt_control_store' AND verifier_function.pronargs = 0
      WHERE owner.rolname = $1 AND runtime.rolname = $2 AND verifier.rolname = $3
        AND anon.rolname = 'anon' AND authenticated.rolname = 'authenticated'
        AND service_role.rolname = 'service_role'
    )
    SELECT pg_catalog.jsonb_build_object(
      'verifier_login', verifier_login, 'verifier_superuser', verifier_superuser,
      'verifier_create_role', verifier_create_role, 'verifier_create_database', verifier_create_database,
      'verifier_replication', verifier_replication, 'verifier_bypass_rls', verifier_bypass_rls,
      'verifier_member_of_owner', verifier_member_of_owner,
      'verifier_has_role_membership', verifier_has_role_membership,
      'owner_has_role_membership', owner_has_role_membership,
      'verifier_owns_objects', verifier_owns_objects, 'owner_owns_objects', owner_owns_objects,
      'verifier_schema_usage', verifier_schema_usage, 'verifier_schema_create', verifier_schema_create,
      'verifier_table_privileges', verifier_table_privileges,
      'verifier_sequence_privileges', verifier_sequence_privileges,
      'verifier_unapproved_function_execute', verifier_unapproved_function_execute,
      'runtime_can_execute_verifier', runtime_can_execute_verifier,
      'verifier_can_execute_verifier', verifier_can_execute_verifier,
      'public_can_execute_verifier', public_can_execute_verifier,
      'anon_can_execute_verifier', anon_can_execute_verifier,
      'authenticated_can_execute_verifier', authenticated_can_execute_verifier,
      'service_role_can_execute_verifier', service_role_can_execute_verifier
    ) AS gates
    FROM state`, [CONTROL_STORE_POLICY.roles.owner, runtimeRole, verifierRole, schema]);
  return result.rows[0]?.gates ?? { diagnostic_state: 'required role/schema/function was not found' };
}

async function readControlSchemaSnapshot(client) {
  const result = await client.query(`
    WITH target AS (
      SELECT oid, nspname, nspowner, nspacl FROM pg_catalog.pg_namespace WHERE nspname = $1
    )
    SELECT jsonb_build_object(
      'schema', (SELECT jsonb_build_object('name', nspname,
        'owner', pg_catalog.pg_get_userbyid(nspowner), 'acl', nspacl::text) FROM target),
      'relations', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'name', relation.relname, 'kind', relation.relkind,
          'owner', pg_catalog.pg_get_userbyid(relation.relowner), 'acl', relation.relacl::text,
          'options', relation.reloptions,
          'columns', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
              'number', attribute.attnum, 'name', attribute.attname,
              'type', pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
              'not_null', attribute.attnotnull, 'identity', attribute.attidentity,
              'generated', attribute.attgenerated, 'acl', attribute.attacl::text,
              'default', pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid)
            ) ORDER BY attribute.attnum), '[]'::jsonb)
            FROM pg_catalog.pg_attribute AS attribute
            LEFT JOIN pg_catalog.pg_attrdef AS default_value
              ON default_value.adrelid = attribute.attrelid AND default_value.adnum = attribute.attnum
            WHERE attribute.attrelid = relation.oid AND attribute.attnum > 0 AND NOT attribute.attisdropped),
          'constraints', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
              'name', constraint_row.conname, 'type', constraint_row.contype,
              'definition', pg_catalog.pg_get_constraintdef(constraint_row.oid, true),
              'validated', constraint_row.convalidated, 'deferrable', constraint_row.condeferrable
            ) ORDER BY constraint_row.conname), '[]'::jsonb)
            FROM pg_catalog.pg_constraint AS constraint_row WHERE constraint_row.conrelid = relation.oid),
          'indexes', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
              'definition', pg_catalog.pg_get_indexdef(index_row.indexrelid),
              'valid', index_row.indisvalid, 'ready', index_row.indisready
            ) ORDER BY index_row.indexrelid), '[]'::jsonb)
            FROM pg_catalog.pg_index AS index_row WHERE index_row.indrelid = relation.oid),
          'triggers', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
              'definition', pg_catalog.pg_get_triggerdef(trigger_row.oid, true),
              'enabled', trigger_row.tgenabled
            ) ORDER BY trigger_row.tgname), '[]'::jsonb)
            FROM pg_catalog.pg_trigger AS trigger_row
            WHERE trigger_row.tgrelid = relation.oid AND NOT trigger_row.tgisinternal),
          'policies', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
              'name', policy.polname, 'command', policy.polcmd, 'roles', policy.polroles,
              'using', pg_catalog.pg_get_expr(policy.polqual, policy.polrelid),
              'check', pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid)
            ) ORDER BY policy.polname), '[]'::jsonb)
            FROM pg_catalog.pg_policy AS policy WHERE policy.polrelid = relation.oid)
        ) ORDER BY relation.relname)
        FROM pg_catalog.pg_class AS relation CROSS JOIN target
        WHERE relation.relnamespace = target.oid AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      ), '[]'::jsonb),
      'indexes', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('name', index_relation.relname,
          'owner', pg_catalog.pg_get_userbyid(index_relation.relowner), 'acl', index_relation.relacl::text)
          ORDER BY index_relation.relname)
        FROM pg_catalog.pg_class AS index_relation CROSS JOIN target
        WHERE index_relation.relnamespace = target.oid AND index_relation.relkind IN ('i', 'I')
      ), '[]'::jsonb),
      'functions', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('name', procedure.proname,
          'identity_arguments', pg_catalog.pg_get_function_identity_arguments(procedure.oid),
          'definition', pg_catalog.pg_get_functiondef(procedure.oid),
          'owner', pg_catalog.pg_get_userbyid(procedure.proowner), 'acl', procedure.proacl::text)
          ORDER BY procedure.proname, pg_catalog.pg_get_function_identity_arguments(procedure.oid))
        FROM pg_catalog.pg_proc AS procedure CROSS JOIN target WHERE procedure.pronamespace = target.oid
      ), '[]'::jsonb),
      'types', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('name', type_row.typname, 'kind', type_row.typtype,
          'owner', pg_catalog.pg_get_userbyid(type_row.typowner), 'acl', type_row.typacl::text)
          ORDER BY type_row.typname)
        FROM pg_catalog.pg_type AS type_row CROSS JOIN target WHERE type_row.typnamespace = target.oid
      ), '[]'::jsonb),
      'default_acl', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('owner', pg_catalog.pg_get_userbyid(default_acl.defaclrole),
          'object_type', default_acl.defaclobjtype, 'acl', default_acl.defaclacl::text)
          ORDER BY default_acl.defaclobjtype)
        FROM pg_catalog.pg_default_acl AS default_acl CROSS JOIN target
        WHERE default_acl.defaclnamespace = target.oid
      ), '[]'::jsonb)
    ) AS snapshot` , [schema]);
  return result.rows[0].snapshot;
}

async function assertPreflightRefusal(client, sql, savepoint, expectedMessage) {
  await client.query(`SAVEPOINT ${savepoint}`);
  let refusal;
  try {
    await client.query(sql);
  } catch (error) {
    refusal = error;
  }
  assert.ok(refusal, 'unsafe bootstrap unexpectedly completed');
  assert.equal(refusal.code, '55000');
  assert.equal(refusal.message, expectedMessage);
  await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  await client.query(`RELEASE SAVEPOINT ${savepoint}`);
}

function testAttemptRow(attemptId, runId, suffix) {
  return [attemptId, projectRef, 'control-store-db-harness', `fixture-${runId}`, 'c'.repeat(40),
    'lawx-ai/billing-validation-control', 'refs/heads/local-db-harness', String(700000 + suffix),
    1, `billing-validation-${'d'.repeat(32)}`, projectRef, `dpl_local_${suffix}`,
    'https://preview.invalid', `acct_local_${suffix}`];
}

async function insertAttempt(client, attemptId, runId, suffix) {
  const values = testAttemptRow(attemptId, runId, suffix);
  await client.query(`INSERT INTO ${schema}.attempts
    (attempt_id, branch_id, suite, fixture_key, candidate_sha, workflow_repository, workflow_ref,
     workflow_run_id, workflow_run_attempt, runner_label, database_project_ref, deployment_id,
     deployment_origin, stripe_account_id, state, cleanup_status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'collecting','pending')`, values);
}

async function nextFence(client) {
  const result = await client.query(`SELECT pg_catalog.nextval('${schema}.fixture_lease_fence_seq')::text AS value`);
  return `00000000-0000-4000-8000-${BigInt(result.rows[0].value).toString(16).padStart(12, '0')}`;
}

async function putLease(client, { attemptId, runId, suffix, fence, expectedFence, projectRef: ref,
  suite, fixtureKey, expiresAt }) {
  return client.query(`INSERT INTO ${schema}.standalone_fixture_leases
    (project_ref, suite, fixture_key, attempt_id, fence, expires_at,
     owner_candidate_sha, owner_repository, owner_ref, owner_run_id, owner_run_attempt, recovery_only)
    VALUES ($1,$2,$3,$4,$5,to_timestamp($6),$8,$9,$10,$11,$12,false)
    ON CONFLICT (project_ref, suite, fixture_key) DO UPDATE SET
      attempt_id = EXCLUDED.attempt_id, fence = EXCLUDED.fence, expires_at = EXCLUDED.expires_at,
      owner_candidate_sha = EXCLUDED.owner_candidate_sha, owner_repository = EXCLUDED.owner_repository,
      owner_ref = EXCLUDED.owner_ref, owner_run_id = EXCLUDED.owner_run_id,
      owner_run_attempt = EXCLUDED.owner_run_attempt, recovery_only = EXCLUDED.recovery_only
    WHERE ${schema}.standalone_fixture_leases.fence IS NOT DISTINCT FROM $7::uuid`,
  [ref, suite, fixtureKey, attemptId, fence, expiresAt, expectedFence, 'c'.repeat(40),
    'lawx-ai/billing-validation-control', 'refs/heads/local-db-harness', String(700000 + suffix), 1]);
}

async function appendLeaseHistory(client, { attemptId, runId, suffix, fence, projectRef: ref,
  suite, fixtureKey, expiresAt, event }) {
  await client.query(`INSERT INTO ${schema}.fixture_lease_history
    (project_ref, suite, fixture_key, attempt_id, owner_fence, workflow_run_id,
     workflow_run_attempt, event_type, expires_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($9))`,
  [ref, suite, fixtureKey, attemptId, fence, String(700000 + suffix), 1, event, expiresAt]);
}

async function waitForAdvisoryLockWait(admin, applicationName) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = await admin.query(`SELECT wait_event_type, wait_event FROM pg_catalog.pg_stat_activity
      WHERE application_name = $1`, [applicationName]);
    if (result.rows.some((row) => row.wait_event_type === 'Lock' && row.wait_event === 'advisory')) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail('second PostgreSQL session did not queue behind the advisory lease lock');
}

test('disposable PostgreSQL 17 proves atomic bootstrap, verifier boundary and persisted lease fencing', {
  skip: typeof connectionUrl !== 'string' || connectionUrl.length === 0
    ? 'run through the isolated PostgreSQL 17 Docker harness'
    : false,
}, async () => {
  const { Client } = await import('pg');
  const connection = parseControlStoreLocalTestUrl(connectionUrl);
  assert.equal(connection.user, 'billing_control_test_admin',
    'isolated PostgreSQL must use a non-bootstrap administrator to create the synthetic postgres operator');
  const clusterAdmin = new Client({ ...connection, connectionTimeoutMillis: 5_000, query_timeout: 15_000 });
  await clusterAdmin.connect();
  let client;
  try {
    const clusterIdentity = await clusterAdmin.query(`SELECT current_database() AS database_name,
      session_user AS session_role, current_user AS current_role,
      current_setting('server_version_num') AS version_num,
      role.rolsuper AS is_superuser
      FROM pg_catalog.pg_roles AS role WHERE role.rolname = current_user`);
    assert.deepEqual(clusterIdentity.rows, [{ database_name: 'postgres', session_role: 'billing_control_test_admin',
      current_role: 'billing_control_test_admin', version_num: '170011', is_superuser: true }]);

    const preexisting = await clusterAdmin.query(`SELECT nspname FROM pg_catalog.pg_namespace
      WHERE nspname = $1`, [schema]);
    assert.deepEqual(preexisting.rows, [], 'the disposable database must start without a control schema');
    const applicationRoles = await clusterAdmin.query(`SELECT rolname FROM pg_catalog.pg_roles
      WHERE rolname IN ('anon', 'authenticated', 'service_role',
        'postgres', 'billing_validation_owner', 'billing_validation_runtime', 'billing_validation_verifier')
      ORDER BY rolname`);
    assert.deepEqual(applicationRoles.rows, [], 'the disposable image must start without managed/control roles');

    // These no-login placeholders model only the three managed Supabase roles referenced by REVOKE/ACL SQL.
    await clusterAdmin.query('CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;');
    const postgresPassword = randomBytes(32).toString('base64url');
    await clusterAdmin.query(`CREATE ROLE postgres WITH LOGIN SUPERUSER PASSWORD '${postgresPassword}'`);
    await clusterAdmin.query('GRANT CONNECT, CREATE ON DATABASE postgres TO postgres');
    client = new Client({ ...connection, user: 'postgres', password: postgresPassword,
      connectionTimeoutMillis: 5_000, query_timeout: 15_000 });
    await client.connect();
    const postgresIdentity = await client.query(`SELECT current_database() AS database_name,
      session_user AS session_role, current_user AS current_role,
      current_setting('server_version_num') AS version_num,
      role.rolsuper AS is_superuser
      FROM pg_catalog.pg_roles AS role WHERE role.rolname = current_user`);
    assert.deepEqual(postgresIdentity.rows, [{ database_name: 'postgres', session_role: 'postgres',
      current_role: 'postgres', version_num: '170011', is_superuser: true }]);

    const plan = await loadControlStoreBootstrapPlan();
    const bootstrapSql = renderControlStoreBootstrap(plan);

    await client.query('BEGIN');
    try {
      await client.query(`CREATE SCHEMA ${schema} AUTHORIZATION postgres`);
      await client.query(`CREATE TABLE ${schema}.partial_probe
        (id integer PRIMARY KEY, payload text NOT NULL DEFAULT 'synthetic-preserve-me')`);
      await client.query(`INSERT INTO ${schema}.partial_probe (id) VALUES (1)`);
      const beforePartialAttempt = await readControlSchemaSnapshot(client);
      const beforePartialRows = await client.query(`SELECT id, payload FROM ${schema}.partial_probe ORDER BY id`);
      await assertPreflightRefusal(client, bootstrapSql, 'partial_bootstrap',
        'billing_control_bootstrap_schema_already_exists');
      assert.deepEqual(await readControlSchemaSnapshot(client), beforePartialAttempt,
        'a partial preexisting schema must remain unchanged after the bootstrap refusal');
      assert.deepEqual((await client.query(`SELECT id, payload FROM ${schema}.partial_probe ORDER BY id`)).rows,
        beforePartialRows.rows, 'the bootstrap must preserve data in the partial schema');
    } finally {
      await client.query('ROLLBACK');
    }

    const afterPartialRollback = await client.query(`SELECT nspname FROM pg_catalog.pg_namespace
      WHERE nspname = $1`, [schema]);
    assert.deepEqual(afterPartialRollback.rows, []);

    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL ROLE anon');
      await assertPreflightRefusal(client, bootstrapSql, 'wrong_identity_bootstrap',
        'billing_control_bootstrap_operator_required');
    } finally {
      await client.query('ROLLBACK');
    }

    // Supabase's `postgres` is a CREATEROLE/CREATEDB administrator, not a superuser.
    // This is a synthetic role, separate from the cluster bootstrap administrator.
    const operatorPassword = randomBytes(32).toString('base64url');
    let operatorRoleMayBeDemoted = false;
    let operatorClient;
    try {
      operatorRoleMayBeDemoted = true;
      await clusterAdmin.query(`ALTER ROLE postgres WITH LOGIN NOSUPERUSER CREATEROLE CREATEDB
        PASSWORD '${operatorPassword}'`);
      operatorClient = new Client({ ...connection, user: 'postgres', password: operatorPassword,
        connectionTimeoutMillis: 5_000, query_timeout: 15_000 });
      await operatorClient.connect();
      const managedOperator = await operatorClient.query(`SELECT current_user, session_user,
        role.rolsuper AS is_superuser, role.rolcreaterole AS can_create_roles,
        role.rolcreatedb AS can_create_database
        FROM pg_catalog.pg_roles AS role WHERE role.rolname = current_user`);
      assert.deepEqual(managedOperator.rows, [{ current_user: 'postgres', session_user: 'postgres',
        is_superuser: false, can_create_roles: true, can_create_database: true }]);

      await operatorClient.query(bootstrapSql);
      const memberships = await operatorClient.query(`SELECT granted.rolname AS granted_role,
        member.rolname AS member_role, grantor.rolname AS grantor_role,
        membership.admin_option, membership.inherit_option, membership.set_option
        FROM pg_catalog.pg_auth_members AS membership
        JOIN pg_catalog.pg_roles AS granted ON granted.oid = membership.roleid
        JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
        JOIN pg_catalog.pg_roles AS grantor ON grantor.oid = membership.grantor
        WHERE granted.rolname IN ('billing_validation_owner', 'billing_validation_runtime',
          'billing_validation_verifier') AND member.rolname = 'postgres'
        ORDER BY granted.rolname`);
      assert.deepEqual(memberships.rows, [
        { granted_role: 'billing_validation_owner', member_role: 'postgres',
          grantor_role: 'billing_control_test_admin', admin_option: true, inherit_option: false, set_option: false },
        { granted_role: 'billing_validation_runtime', member_role: 'postgres',
          grantor_role: 'billing_control_test_admin', admin_option: true, inherit_option: false, set_option: false },
        { granted_role: 'billing_validation_verifier', member_role: 'postgres',
          grantor_role: 'billing_control_test_admin', admin_option: true, inherit_option: false, set_option: false },
      ], 'only PostgreSQL’s automatic non-inheriting, non-settable CREATEROLE memberships may remain');
      await assert.rejects(operatorClient.query('SET ROLE billing_validation_owner'),
        (error) => error.code === '42501',
        'the temporary SET ROLE grant must be revoked before bootstrap commits');
    } finally {
      if (operatorClient) {
        await operatorClient.end();
      }
      if (operatorRoleMayBeDemoted) {
        await clusterAdmin.query('ALTER ROLE postgres WITH LOGIN SUPERUSER CREATEROLE CREATEDB');
      }
    }

    const restoredOperator = await client.query(`SELECT rolcanlogin, rolsuper, rolcreaterole, rolcreatedb
      FROM pg_catalog.pg_roles WHERE rolname = 'postgres'`);
    assert.deepEqual(restoredOperator.rows, [{ rolcanlogin: true, rolsuper: true,
      rolcreaterole: true, rolcreatedb: true }], 'the disposable superuser must be restored before later probes');

    const roleState = await client.query(`SELECT rolname, rolcanlogin, rolsuper, rolcreaterole,
        rolcreatedb, rolreplication, rolbypassrls
      FROM pg_catalog.pg_roles
      WHERE rolname IN ('billing_validation_owner', 'billing_validation_runtime', 'billing_validation_verifier')
      ORDER BY rolname`);
    assert.deepEqual(roleState.rows, [
      { rolname: 'billing_validation_owner', rolcanlogin: false, rolsuper: false, rolcreaterole: false,
        rolcreatedb: false, rolreplication: false, rolbypassrls: false },
      { rolname: 'billing_validation_runtime', rolcanlogin: false, rolsuper: false, rolcreaterole: false,
        rolcreatedb: false, rolreplication: false, rolbypassrls: false },
      { rolname: 'billing_validation_verifier', rolcanlogin: false, rolsuper: false, rolcreaterole: false,
        rolcreatedb: false, rolreplication: false, rolbypassrls: false },
    ]);
    const installReceipt = await client.query(`SELECT pg_catalog.btrim(project_ref::text) AS project_ref,
        pg_catalog.btrim(baseline_sha256::text) AS baseline_sha256
      FROM ${schema}.control_store_install_receipts`);
    assert.deepEqual(installReceipt.rows, [{ project_ref: projectRef, baseline_sha256: plan.baselineSha256 }]);
    const migrations = await client.query(`SELECT version, name, pg_catalog.btrim(sha256::text) AS sha256
      FROM ${schema}.schema_migrations ORDER BY version COLLATE "C"`);
    assert.deepEqual(migrations.rows, CONTROL_STORE_BOOTSTRAP_PINS.migrations.map(({ version, name, sha256 }) =>
      ({ version, name, sha256 })));

    const beforeRepeat = await readControlSchemaSnapshot(client);
    let repeatRefusal;
    try {
      await client.query(bootstrapSql);
    } catch (error) {
      repeatRefusal = error;
    }
    assert.ok(repeatRefusal, 'second bootstrap unexpectedly completed');
    assert.equal(repeatRefusal.code, '55000');
    assert.equal(repeatRefusal.message, 'billing_control_bootstrap_schema_already_exists');
    await client.query('ROLLBACK');
    assert.deepEqual(await readControlSchemaSnapshot(client), beforeRepeat,
      'a repeated bootstrap must preserve the complete schema, ACLs, functions and triggers');

    await client.query('BEGIN');
    try {
      // Mirror the separately gated verifier activation transactionally; rollback
      // below must preserve the bootstrap role's NOLOGIN state for later probes.
      await client.query(`ALTER ROLE ${verifierRole} LOGIN`);
      await client.query(`SET LOCAL SESSION AUTHORIZATION ${verifierRole}`);
      const verifierIdentity = await client.query('SELECT session_user, current_user');
      assert.deepEqual(verifierIdentity.rows, [{ session_user: verifierRole, current_user: verifierRole }]);
      const target = {
        projectRef,
        host: CONTROL_STORE_POLICY.connection.host,
        port: CONTROL_STORE_POLICY.connection.port,
        database: CONTROL_STORE_POLICY.connection.database,
        username: verifierRole,
        sslMode: CONTROL_STORE_POLICY.connection.sslMode,
      };
      // Keep a field-level diagnostic at the SQL boundary. The production verifier
      // intentionally collapses every database/identity mismatch to one refusal code.
      const sqlReceipt = await client.query(`SELECT * FROM ${schema}.verify_attempt_control_store()`);
      const gates = sqlReceipt.rows.length === 1 ? null : await readVerifierGateDiagnostics(client);
      assert.equal(sqlReceipt.rows.length, 1,
        `database verifier SQL returned no receipt; role/ACL gate state: ${JSON.stringify(gates)}`);
      assert.deepEqual(sqlReceipt.rows, [testControlVerifierRow(CONTROL_STORE_POLICY)],
        'database verifier SQL receipt differs from the expected disposable role, migration, or privilege state');
      const receipt = await verifyAttemptControlStore({ queryClient: client,
        policy: CONTROL_STORE_POLICY, target });
      assert.equal(receipt.projectRef, projectRef);
      assert.equal(receipt.database, 'postgres');
      assert.equal(receipt.role, verifierRole);
      assert.equal(receipt.serverVersion, '170011');
      await assert.rejects(client.query(`SELECT * FROM ${schema}.schema_migrations`),
        (error) => error.code === '42501', 'verifier must not read the migration ledger directly');
    } finally {
      await client.query('ROLLBACK');
    }

    for (const { options, changed } of [
      { options: 'WITH ADMIN TRUE, INHERIT TRUE, SET FALSE', changed: 'INHERIT' },
      { options: 'WITH ADMIN TRUE, INHERIT FALSE, SET TRUE', changed: 'SET' },
      { options: 'WITH ADMIN FALSE, INHERIT FALSE, SET FALSE', changed: 'ADMIN' },
    ]) {
      await client.query('BEGIN');
      try {
        // A superuser simulates drift in each field of the immutable automatic row.
        await client.query(`ALTER ROLE ${verifierRole} LOGIN`);
        await client.query(`GRANT ${verifierRole} TO postgres ${options}`);
        await client.query(`SET LOCAL SESSION AUTHORIZATION ${verifierRole}`);
        const changedMembershipReceipt = await client.query(`SELECT * FROM ${schema}.verify_attempt_control_store()`);
        assert.deepEqual(changedMembershipReceipt.rows, [],
          `verifier must reject an automatic CREATEROLE membership with changed ${changed} option`);
        const changedMembershipGates = await readVerifierGateDiagnostics(client);
        assert.equal(changedMembershipGates.verifier_has_role_membership, true,
          `diagnostics must identify changed ${changed} option as unexpected`);
        await client.query('ROLLBACK');
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* preserve the original verification failure */ }
        throw error;
      }
    }

    const verifierRoleState = await client.query(`SELECT rolcanlogin FROM pg_catalog.pg_roles
      WHERE rolname = $1`, [verifierRole]);
    assert.deepEqual(verifierRoleState.rows, [{ rolcanlogin: false }],
      'local verifier activation must roll back to the bootstrap NOLOGIN state');

    await proveLeaseRace(client, connection, randomBytes(16).toString('hex'));
  } finally {
    if (client) await client.end();
    try {
      // The following ACL suite uses the same disposable database and verifies
      // the CREATEROLE membership row; the harness removes this whole database.
      await clusterAdmin.query('ALTER ROLE postgres WITH LOGIN NOSUPERUSER CREATEROLE CREATEDB');
    } catch { /* a failed setup may not have created postgres; the harness removes the database */ }
    await clusterAdmin.end();
  }
});

async function proveLeaseRace(admin, connection, runId) {
  const { Client } = await import('pg');
  const suite = `lease-race-${runId}`;
  const fixtureKey = `fixture-${runId}`;
  const key = JSON.stringify([projectRef, suite, fixtureKey]);
  const attemptA = `attempt-a-${runId}`;
  const attemptB = `attempt-b-${runId}`;
  const clientA = new Client({ ...connection, application_name: `billing-control-a-${runId}`,
    connectionTimeoutMillis: 5_000, query_timeout: 15_000 });
  const clientB = new Client({ ...connection, application_name: `billing-control-b-${runId}`,
    connectionTimeoutMillis: 5_000, query_timeout: 15_000 });
  await Promise.all([clientA.connect(), clientB.connect()]);
  let aOpen = false;
  let bOpen = false;
  try {
    for (const [client, attemptId, suffix] of [[clientA, attemptA, 1], [clientB, attemptB, 2]]) {
      await client.query('BEGIN');
      await client.query(`SET LOCAL SESSION AUTHORIZATION ${runtimeRole}`);
      await insertAttempt(client, attemptId, runId, suffix);
      await client.query('COMMIT');
    }

    await clientA.query('BEGIN');
    aOpen = true;
    await clientA.query(`SET LOCAL SESSION AUTHORIZATION ${runtimeRole}`);
    await clientA.query('SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))', [key]);
    const fenceA = await nextFence(clientA);
    const expiresA = Date.now() / 1000 + 120;
    const firstClaim = await putLease(clientA, { attemptId: attemptA, runId, suffix: 1, fence: fenceA,
      expectedFence: null, projectRef, suite, fixtureKey, expiresAt: expiresA });
    assert.equal(firstClaim.rowCount, 1);
    await appendLeaseHistory(clientA, { attemptId: attemptA, runId, suffix: 1, fence: fenceA,
      projectRef, suite, fixtureKey, expiresAt: expiresA, event: 'acquired' });

    await clientB.query('BEGIN');
    bOpen = true;
    await clientB.query(`SET LOCAL SESSION AUTHORIZATION ${runtimeRole}`);
    const queuedLock = clientB.query(
      'SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))', [key]);
    await waitForAdvisoryLockWait(admin, `billing-control-b-${runId}`);
    await clientA.query('COMMIT');
    aOpen = false;
    await queuedLock;

    const active = await clientB.query(`SELECT attempt_id, fence
      FROM ${schema}.standalone_fixture_leases
      WHERE project_ref = $1 AND suite = $2 AND fixture_key = $3 FOR UPDATE`, [projectRef, suite, fixtureKey]);
    assert.deepEqual(active.rows, [{ attempt_id: attemptA, fence: fenceA }]);
    const staleClaim = await putLease(clientB, { attemptId: attemptB, runId, suffix: 2,
      fence: '00000000-0000-4000-8000-000000000000', expectedFence: null,
      projectRef, suite, fixtureKey, expiresAt: Date.now() / 1000 + 120 });
    assert.equal(staleClaim.rowCount, 0, 'a second candidate must not replace an active lease');
    await clientB.query('COMMIT');
    bOpen = false;

    await admin.query(`UPDATE ${schema}.standalone_fixture_leases
      SET expires_at = clock_timestamp() - interval '1 second'
      WHERE project_ref = $1 AND suite = $2 AND fixture_key = $3 AND attempt_id = $4 AND fence = $5::uuid`,
    [projectRef, suite, fixtureKey, attemptA, fenceA]);
    await clientB.query('BEGIN');
    bOpen = true;
    await clientB.query(`SET LOCAL SESSION AUTHORIZATION ${runtimeRole}`);
    await clientB.query('SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))', [key]);
    const oldFence = await clientB.query(`SELECT fence, expires_at <= clock_timestamp() AS expired
      FROM ${schema}.standalone_fixture_leases
      WHERE project_ref = $1 AND suite = $2 AND fixture_key = $3 FOR UPDATE`, [projectRef, suite, fixtureKey]);
    assert.equal(oldFence.rows[0].fence, fenceA);
    assert.equal(oldFence.rows[0].expired, true);
    const nextLeaseFence = await nextFence(clientB);
    assert.ok(BigInt(`0x${nextLeaseFence.slice(-12)}`) > BigInt(`0x${fenceA.slice(-12)}`));
    const expiresB = Date.now() / 1000 + 120;
    const takeover = await putLease(clientB, { attemptId: attemptB, runId, suffix: 2, fence: nextLeaseFence,
      expectedFence: fenceA, projectRef, suite, fixtureKey, expiresAt: expiresB });
    assert.equal(takeover.rowCount, 1, 'the current expected fence admits one controlled takeover');
    await appendLeaseHistory(clientB, { attemptId: attemptB, runId, suffix: 2, fence: nextLeaseFence,
      projectRef, suite, fixtureKey, expiresAt: expiresB, event: 'takeover' });
    await clientB.query('COMMIT');
    bOpen = false;

    await clientB.query('BEGIN');
    bOpen = true;
    await clientB.query(`SET LOCAL SESSION AUTHORIZATION ${runtimeRole}`);
    await clientB.query('SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))', [key]);
    await appendLeaseHistory(clientB, { attemptId: attemptB, runId, suffix: 2, fence: nextLeaseFence,
      projectRef, suite, fixtureKey, expiresAt: expiresB, event: 'released' });
    const release = await clientB.query(`DELETE FROM ${schema}.standalone_fixture_leases
      WHERE project_ref = $1 AND suite = $2 AND fixture_key = $3 AND attempt_id = $4 AND fence = $5::uuid
        AND expires_at > clock_timestamp()`, [projectRef, suite, fixtureKey, attemptB, nextLeaseFence]);
    assert.equal(release.rowCount, 1);
    await clientB.query('COMMIT');
    bOpen = false;

    const retainedHistory = await admin.query(`SELECT attempt_id, owner_fence, event_type
      FROM ${schema}.fixture_lease_history WHERE project_ref = $1 AND suite = $2 AND fixture_key = $3
      ORDER BY event_id`, [projectRef, suite, fixtureKey]);
    assert.deepEqual(retainedHistory.rows, [
      { attempt_id: attemptA, owner_fence: fenceA, event_type: 'acquired' },
      { attempt_id: attemptB, owner_fence: nextLeaseFence, event_type: 'takeover' },
      { attempt_id: attemptB, owner_fence: nextLeaseFence, event_type: 'released' },
    ]);
    const currentLease = await admin.query(`SELECT attempt_id FROM ${schema}.standalone_fixture_leases
      WHERE project_ref = $1 AND suite = $2 AND fixture_key = $3`, [projectRef, suite, fixtureKey]);
    assert.deepEqual(currentLease.rows, [], 'release clears only the current lease; append-only history remains');

    await clientA.query('BEGIN');
    aOpen = true;
    await clientA.query(`SET LOCAL SESSION AUTHORIZATION ${runtimeRole}`);
    const appendOnlyDenied = await clientA.query(`UPDATE ${schema}.fixture_lease_history
      SET event_type = 'released' WHERE project_ref = $1 AND suite = $2 AND fixture_key = $3`,
    [projectRef, suite, fixtureKey]).catch((error) => error);
    assert.equal(appendOnlyDenied.code, '42501', 'runtime cannot rewrite retained lease history');
    await clientA.query('ROLLBACK');
    aOpen = false;
  } finally {
    if (aOpen) await clientA.query('ROLLBACK').catch(() => {});
    if (bOpen) await clientB.query('ROLLBACK').catch(() => {});
    await Promise.all([clientA.end(), clientB.end()]);
  }
}
