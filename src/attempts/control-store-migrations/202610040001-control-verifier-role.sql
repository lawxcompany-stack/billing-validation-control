CREATE OR REPLACE FUNCTION billing_validation_control.verify_attempt_control_store()
RETURNS TABLE (
  project_ref text,
  database_name text,
  session_role text,
  verifier_role text,
  role_setting text,
  server_version_num text,
  owner_login boolean,
  runtime_login boolean,
  runtime_superuser boolean,
  runtime_create_role boolean,
  runtime_create_database boolean,
  runtime_replication boolean,
  runtime_bypass_rls boolean,
  runtime_member_of_owner boolean,
  runtime_has_role_membership boolean,
  runtime_owns_objects boolean,
  owner_owns_objects boolean,
  schema_owner text,
  baseline_sha256 text,
  migration_count integer,
  migration_sha256 text,
  privilege_fingerprint_sha256 text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $control_store_verifier$
  WITH control_state AS (
    -- PostgreSQL 17 CREATEROLE leaves one superuser-granted ADMIN membership
    -- from bootstrap role postgres to each created role, with INHERIT and SET off.
    -- The checks below allow only that exact catalog row and reject any drift.
    SELECT owner.oid AS owner_oid,
      runtime.oid AS runtime_oid,
      verifier.oid AS verifier_oid,
      bootstrap_operator.oid AS bootstrap_operator_oid,
      verifier_function.oid AS verifier_function_oid,
      schema_role.rolname AS schema_owner,
      owner.rolcanlogin AS owner_login,
      runtime.rolcanlogin AS runtime_login,
      runtime.rolsuper AS runtime_superuser,
      runtime.rolcreaterole AS runtime_create_role,
      runtime.rolcreatedb AS runtime_create_database,
      runtime.rolreplication AS runtime_replication,
      runtime.rolbypassrls AS runtime_bypass_rls,
      pg_catalog.pg_has_role(runtime.oid, owner.oid, 'MEMBER') AS runtime_member_of_owner,
      EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members AS membership
        WHERE (membership.member = runtime.oid OR membership.roleid = runtime.oid)
          AND NOT (
            membership.roleid = runtime.oid AND membership.member = bootstrap_operator.oid
            AND membership.admin_option AND NOT membership.inherit_option AND NOT membership.set_option
            AND EXISTS (SELECT 1 FROM pg_catalog.pg_roles AS grantor
              WHERE grantor.oid = membership.grantor AND grantor.rolsuper)
          ))
        AS runtime_has_role_membership,
      EXISTS (SELECT 1 FROM pg_catalog.pg_class AS relation
        WHERE relation.relnamespace = namespace.oid AND relation.relowner = runtime.oid)
        OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS procedure
          WHERE procedure.pronamespace = namespace.oid AND procedure.proowner = runtime.oid)
        AS runtime_owns_objects,
      verifier.rolcanlogin AS verifier_login,
      verifier.rolsuper AS verifier_superuser,
      verifier.rolcreaterole AS verifier_create_role,
      verifier.rolcreatedb AS verifier_create_database,
      verifier.rolreplication AS verifier_replication,
      verifier.rolbypassrls AS verifier_bypass_rls,
      pg_catalog.pg_has_role(verifier.oid, owner.oid, 'MEMBER') AS verifier_member_of_owner,
      EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members AS membership
        WHERE (membership.member = verifier.oid OR membership.roleid = verifier.oid)
          AND NOT (
            membership.roleid = verifier.oid AND membership.member = bootstrap_operator.oid
            AND membership.admin_option AND NOT membership.inherit_option AND NOT membership.set_option
            AND EXISTS (SELECT 1 FROM pg_catalog.pg_roles AS grantor
              WHERE grantor.oid = membership.grantor AND grantor.rolsuper)
          ))
        AS verifier_has_role_membership,
      EXISTS (SELECT 1 FROM pg_catalog.pg_class AS relation
        WHERE relation.relnamespace = namespace.oid AND relation.relowner = verifier.oid)
        OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS procedure
          WHERE procedure.pronamespace = namespace.oid AND procedure.proowner = verifier.oid)
        AS verifier_owns_objects,
      NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class AS relation
        WHERE relation.relnamespace = namespace.oid AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
          AND relation.relowner <> owner.oid)
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS procedure
          WHERE procedure.pronamespace = namespace.oid AND procedure.proowner <> owner.oid)
        AS owner_owns_objects,
      pg_catalog.has_schema_privilege(runtime.oid, namespace.oid, 'USAGE') AS runtime_schema_usage,
      pg_catalog.has_schema_privilege(runtime.oid, namespace.oid, 'CREATE') AS runtime_schema_create,
      pg_catalog.has_schema_privilege(verifier.oid, namespace.oid, 'USAGE') AS verifier_schema_usage,
      pg_catalog.has_schema_privilege(verifier.oid, namespace.oid, 'CREATE') AS verifier_schema_create,
      EXISTS (
        SELECT 1 FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS relation_schema ON relation_schema.oid = relation.relnamespace
        WHERE relation_schema.nspname = 'billing_validation_control'
          AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND (
            pg_catalog.has_table_privilege(verifier.oid, relation.oid, 'SELECT') OR
            pg_catalog.has_table_privilege(verifier.oid, relation.oid, 'INSERT') OR
            pg_catalog.has_table_privilege(verifier.oid, relation.oid, 'UPDATE') OR
            pg_catalog.has_table_privilege(verifier.oid, relation.oid, 'REFERENCES') OR
            pg_catalog.has_table_privilege(verifier.oid, relation.oid, 'DELETE') OR
            pg_catalog.has_table_privilege(verifier.oid, relation.oid, 'TRUNCATE') OR
            pg_catalog.has_table_privilege(verifier.oid, relation.oid, 'TRIGGER') OR
            pg_catalog.has_table_privilege(verifier.oid, relation.oid, 'MAINTAIN') OR
            EXISTS (
              SELECT 1 FROM pg_catalog.pg_attribute AS attribute
              WHERE attribute.attrelid = relation.oid AND attribute.attnum > 0 AND NOT attribute.attisdropped
                AND (
                  pg_catalog.has_column_privilege(verifier.oid, relation.oid, attribute.attnum, 'SELECT') OR
                  pg_catalog.has_column_privilege(verifier.oid, relation.oid, attribute.attnum, 'INSERT') OR
                  pg_catalog.has_column_privilege(verifier.oid, relation.oid, attribute.attnum, 'UPDATE') OR
                  pg_catalog.has_column_privilege(verifier.oid, relation.oid, attribute.attnum, 'REFERENCES')
                )
            )
          )
      ) AS verifier_table_privileges,
      EXISTS (
        SELECT 1 FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS relation_schema ON relation_schema.oid = relation.relnamespace
        WHERE relation_schema.nspname = 'billing_validation_control' AND relation.relkind = 'S'
          AND (
            pg_catalog.has_sequence_privilege(verifier.oid, relation.oid, 'USAGE') OR
            pg_catalog.has_sequence_privilege(verifier.oid, relation.oid, 'SELECT') OR
            pg_catalog.has_sequence_privilege(verifier.oid, relation.oid, 'UPDATE')
          )
      ) AS verifier_sequence_privileges,
      EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc AS procedure
        JOIN pg_catalog.pg_namespace AS function_schema ON function_schema.oid = procedure.pronamespace
        WHERE function_schema.nspname = 'billing_validation_control'
          AND procedure.oid <> verifier_function.oid
          AND pg_catalog.has_function_privilege(verifier.oid, procedure.oid, 'EXECUTE')
      ) AS verifier_unapproved_function_execute,
      pg_catalog.has_function_privilege(runtime.oid, verifier_function.oid, 'EXECUTE')
        AS runtime_can_execute_verifier,
      pg_catalog.has_function_privilege(verifier.oid, verifier_function.oid, 'EXECUTE')
        AS verifier_can_execute_verifier,
      EXISTS (
        SELECT 1 FROM pg_catalog.aclexplode(
          COALESCE(verifier_function.proacl,
            pg_catalog.acldefault('f', verifier_function.proowner))
        ) AS function_acl
        WHERE function_acl.grantee = 0 AND function_acl.privilege_type = 'EXECUTE'
      ) AS public_can_execute_verifier,
      pg_catalog.has_function_privilege(anon.oid, verifier_function.oid, 'EXECUTE')
        AS anon_can_execute_verifier,
      pg_catalog.has_function_privilege(authenticated.oid, verifier_function.oid, 'EXECUTE')
        AS authenticated_can_execute_verifier,
      pg_catalog.has_function_privilege(service_role.oid, verifier_function.oid, 'EXECUTE')
        AS service_role_can_execute_verifier,
      namespace.oid AS schema_oid
    FROM pg_catalog.pg_roles AS owner
    CROSS JOIN pg_catalog.pg_roles AS runtime
    CROSS JOIN pg_catalog.pg_roles AS verifier
    CROSS JOIN pg_catalog.pg_roles AS anon
    CROSS JOIN pg_catalog.pg_roles AS authenticated
    CROSS JOIN pg_catalog.pg_roles AS service_role
    JOIN pg_catalog.pg_roles AS bootstrap_operator ON bootstrap_operator.rolname = 'postgres'
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.nspname = 'billing_validation_control'
    JOIN pg_catalog.pg_roles AS schema_role ON schema_role.oid = namespace.nspowner
    JOIN pg_catalog.pg_proc AS verifier_function ON verifier_function.pronamespace = namespace.oid
      AND verifier_function.proname = 'verify_attempt_control_store'
      AND verifier_function.pronargs = 0
    WHERE owner.rolname = 'billing_validation_owner'
      AND runtime.rolname = 'billing_validation_runtime'
      AND verifier.rolname = 'billing_validation_verifier'
      AND anon.rolname = 'anon'
      AND authenticated.rolname = 'authenticated'
      AND service_role.rolname = 'service_role'
  ), installation AS (
    SELECT CASE WHEN count(*) = 1 THEN pg_catalog.max(pg_catalog.btrim(project_ref::text)) END AS project_ref,
      CASE WHEN count(*) = 1 THEN pg_catalog.max(pg_catalog.btrim(baseline_sha256::text)) END AS baseline_sha256
    FROM billing_validation_control.control_store_install_receipts
  ), migration_state AS (
    SELECT count(*)::integer AS migration_count,
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        COALESCE(pg_catalog.string_agg(
          version || '|' || name || '|' || pg_catalog.btrim(sha256::text), E'\n' ORDER BY version COLLATE "C"), ''),
        'UTF8')), 'hex') AS migration_sha256
    FROM billing_validation_control.schema_migrations
  ), privilege_lines AS (
    SELECT 'role|owner_login|' || CASE WHEN owner_login THEN '1' ELSE '0' END AS line FROM control_state
    UNION ALL SELECT 'role|runtime_login|' || CASE WHEN runtime_login THEN '1' ELSE '0' END FROM control_state
    UNION ALL SELECT 'role|runtime_superuser|' || CASE WHEN runtime_superuser THEN '1' ELSE '0' END FROM control_state
    UNION ALL SELECT 'role|runtime_create_role|' || CASE WHEN runtime_create_role THEN '1' ELSE '0' END FROM control_state
    UNION ALL SELECT 'role|runtime_create_database|' || CASE WHEN runtime_create_database THEN '1' ELSE '0' END FROM control_state
    UNION ALL SELECT 'role|runtime_replication|' || CASE WHEN runtime_replication THEN '1' ELSE '0' END FROM control_state
    UNION ALL SELECT 'role|runtime_bypass_rls|' || CASE WHEN runtime_bypass_rls THEN '1' ELSE '0' END FROM control_state
    UNION ALL SELECT 'role|runtime_member_of_owner|' || CASE WHEN runtime_member_of_owner THEN '1' ELSE '0' END FROM control_state
    UNION ALL SELECT 'role|runtime_has_role_membership|' || CASE WHEN runtime_has_role_membership THEN '1' ELSE '0' END FROM control_state
    UNION ALL SELECT 'role|runtime_owns_objects|' || CASE WHEN runtime_owns_objects THEN '1' ELSE '0' END FROM control_state
    UNION ALL SELECT 'role|verifier_login|' || CASE WHEN verifier_login THEN '1' ELSE '0' END FROM control_state
    UNION ALL SELECT 'role|verifier_superuser|' || CASE WHEN verifier_superuser THEN '1' ELSE '0' END FROM control_state
    UNION ALL SELECT 'role|verifier_create_role|' || CASE WHEN verifier_create_role THEN '1' ELSE '0' END FROM control_state
    UNION ALL SELECT 'role|verifier_create_database|' || CASE WHEN verifier_create_database THEN '1' ELSE '0' END FROM control_state
    UNION ALL SELECT 'role|verifier_replication|' || CASE WHEN verifier_replication THEN '1' ELSE '0' END FROM control_state
    UNION ALL SELECT 'role|verifier_bypass_rls|' || CASE WHEN verifier_bypass_rls THEN '1' ELSE '0' END FROM control_state
    UNION ALL SELECT 'role|verifier_member_of_owner|' || CASE WHEN verifier_member_of_owner THEN '1' ELSE '0' END FROM control_state
    UNION ALL SELECT 'role|verifier_has_role_membership|' || CASE WHEN verifier_has_role_membership THEN '1' ELSE '0' END FROM control_state
    UNION ALL SELECT 'role|verifier_owns_objects|' || CASE WHEN verifier_owns_objects THEN '1' ELSE '0' END FROM control_state
    UNION ALL SELECT 'role|owner_owns_objects|' || CASE WHEN owner_owns_objects THEN '1' ELSE '0' END FROM control_state
    UNION ALL SELECT 'schema|owner|' || schema_owner FROM control_state
    UNION ALL SELECT 'schema|usage|' || CASE WHEN runtime_schema_usage THEN '1' ELSE '0' END FROM control_state
    UNION ALL SELECT 'schema|create|' || CASE WHEN runtime_schema_create THEN '1' ELSE '0' END FROM control_state
    UNION ALL SELECT 'schema|verifier_usage|' || CASE WHEN verifier_schema_usage THEN '1' ELSE '0' END FROM control_state
    UNION ALL SELECT 'schema|verifier_create|' || CASE WHEN verifier_schema_create THEN '1' ELSE '0' END FROM control_state
    UNION ALL SELECT 'verifier|table_privileges|' || CASE WHEN verifier_table_privileges THEN '1' ELSE '0' END FROM control_state
    UNION ALL SELECT 'verifier|sequence_privileges|' || CASE WHEN verifier_sequence_privileges THEN '1' ELSE '0' END FROM control_state
    UNION ALL SELECT 'verifier|unapproved_function_execute|' ||
      CASE WHEN verifier_unapproved_function_execute THEN '1' ELSE '0' END FROM control_state
    UNION ALL
    SELECT 'table|' || relation.relname || '|' ||
      CASE WHEN pg_catalog.has_table_privilege(control_state.runtime_oid, relation.oid, 'SELECT') THEN '1' ELSE '0' END || '|' ||
      CASE WHEN pg_catalog.has_table_privilege(control_state.runtime_oid, relation.oid, 'SELECT') THEN '' ELSE
        COALESCE((SELECT pg_catalog.string_agg(attribute.attname, ',' ORDER BY attribute.attname COLLATE "C")
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = relation.oid AND attribute.attnum > 0 AND NOT attribute.attisdropped
            AND pg_catalog.has_column_privilege(control_state.runtime_oid, relation.oid, attribute.attnum, 'SELECT')), '') END || '|' ||
      CASE WHEN pg_catalog.has_table_privilege(control_state.runtime_oid, relation.oid, 'INSERT') THEN '1' ELSE '0' END || '|' ||
      COALESCE((SELECT pg_catalog.string_agg(attribute.attname, ',' ORDER BY attribute.attname COLLATE "C")
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = relation.oid AND attribute.attnum > 0 AND NOT attribute.attisdropped
          AND pg_catalog.has_column_privilege(control_state.runtime_oid, relation.oid, attribute.attnum, 'INSERT')), '') || '|' ||
      CASE WHEN pg_catalog.has_table_privilege(control_state.runtime_oid, relation.oid, 'UPDATE') THEN '1' ELSE '0' END || '|' ||
      COALESCE((SELECT pg_catalog.string_agg(attribute.attname, ',' ORDER BY attribute.attname COLLATE "C")
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = relation.oid AND attribute.attnum > 0 AND NOT attribute.attisdropped
          AND pg_catalog.has_column_privilege(control_state.runtime_oid, relation.oid, attribute.attnum, 'UPDATE')), '') || '|' ||
      CASE WHEN pg_catalog.has_table_privilege(control_state.runtime_oid, relation.oid, 'REFERENCES') THEN '1' ELSE '0' END || '|' ||
      COALESCE((SELECT pg_catalog.string_agg(attribute.attname, ',' ORDER BY attribute.attname COLLATE "C")
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = relation.oid AND attribute.attnum > 0 AND NOT attribute.attisdropped
          AND pg_catalog.has_column_privilege(control_state.runtime_oid, relation.oid, attribute.attnum, 'REFERENCES')), '') || '|' ||
      CASE WHEN pg_catalog.has_table_privilege(control_state.runtime_oid, relation.oid, 'DELETE') THEN '1' ELSE '0' END || '|' ||
      CASE WHEN pg_catalog.has_table_privilege(control_state.runtime_oid, relation.oid, 'TRUNCATE') THEN '1' ELSE '0' END || '|' ||
      CASE WHEN pg_catalog.has_table_privilege(control_state.runtime_oid, relation.oid, 'TRIGGER') THEN '1' ELSE '0' END || '|' ||
      CASE WHEN pg_catalog.has_table_privilege(control_state.runtime_oid, relation.oid, 'MAINTAIN') THEN '1' ELSE '0' END
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    CROSS JOIN control_state
    WHERE namespace.nspname = 'billing_validation_control'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
    UNION ALL
    SELECT 'sequence|' || relation.relname || '|' ||
      CASE WHEN pg_catalog.has_sequence_privilege(control_state.runtime_oid, relation.oid, 'USAGE') THEN '1' ELSE '0' END || '|' ||
      CASE WHEN pg_catalog.has_sequence_privilege(control_state.runtime_oid, relation.oid, 'SELECT') THEN '1' ELSE '0' END || '|' ||
      CASE WHEN pg_catalog.has_sequence_privilege(control_state.runtime_oid, relation.oid, 'UPDATE') THEN '1' ELSE '0' END
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    CROSS JOIN control_state
    WHERE namespace.nspname = 'billing_validation_control' AND relation.relkind = 'S'
    UNION ALL
    SELECT 'function|' || procedure.proname || '(' || COALESCE((
      SELECT pg_catalog.string_agg(pg_catalog.format_type(argument_type, NULL), ',' ORDER BY argument_order)
      FROM pg_catalog.unnest(procedure.proargtypes::oid[]) WITH ORDINALITY AS argument(argument_type, argument_order)
    ), '') || ')|runtime|' ||
      CASE WHEN pg_catalog.has_function_privilege(control_state.runtime_oid, procedure.oid, 'EXECUTE') THEN '1' ELSE '0' END ||
      '|verifier|' ||
      CASE WHEN pg_catalog.has_function_privilege(control_state.verifier_oid, procedure.oid, 'EXECUTE') THEN '1' ELSE '0' END
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    CROSS JOIN control_state
    WHERE namespace.nspname = 'billing_validation_control'
      AND (pg_catalog.has_function_privilege(control_state.runtime_oid, procedure.oid, 'EXECUTE')
        OR pg_catalog.has_function_privilege(control_state.verifier_oid, procedure.oid, 'EXECUTE'))
  ), privilege_fingerprint AS (
    SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.string_agg(line, E'\n' ORDER BY line COLLATE "C"), 'UTF8')), 'hex') AS digest
    FROM privilege_lines
  )
  SELECT installation.project_ref,
    pg_catalog.current_database(),
    session_user::text,
    current_user::text,
    pg_catalog.current_setting('role'),
    pg_catalog.current_setting('server_version_num'),
    control_state.owner_login,
    control_state.runtime_login,
    control_state.runtime_superuser,
    control_state.runtime_create_role,
    control_state.runtime_create_database,
    control_state.runtime_replication,
    control_state.runtime_bypass_rls,
    control_state.runtime_member_of_owner,
    control_state.runtime_has_role_membership,
    control_state.runtime_owns_objects,
    control_state.owner_owns_objects,
    control_state.schema_owner,
    installation.baseline_sha256,
    migration_state.migration_count,
    migration_state.migration_sha256,
    privilege_fingerprint.digest
  FROM control_state
  CROSS JOIN installation
  CROSS JOIN migration_state
  CROSS JOIN privilege_fingerprint
  WHERE control_state.verifier_login
    AND NOT control_state.verifier_superuser
    AND NOT control_state.verifier_create_role
    AND NOT control_state.verifier_create_database
    AND NOT control_state.verifier_replication
    AND NOT control_state.verifier_bypass_rls
    AND NOT control_state.verifier_member_of_owner
    AND NOT control_state.verifier_has_role_membership
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_auth_members AS membership
      WHERE (membership.member = control_state.owner_oid OR membership.roleid = control_state.owner_oid)
        AND NOT (
          membership.roleid = control_state.owner_oid
          AND membership.member = control_state.bootstrap_operator_oid
          AND membership.admin_option AND NOT membership.inherit_option AND NOT membership.set_option
          AND EXISTS (SELECT 1 FROM pg_catalog.pg_roles AS grantor
            WHERE grantor.oid = membership.grantor AND grantor.rolsuper)
        )
    )
    AND NOT control_state.verifier_owns_objects
    AND control_state.verifier_schema_usage
    AND NOT control_state.verifier_schema_create
    AND NOT control_state.verifier_table_privileges
    AND NOT control_state.verifier_sequence_privileges
    AND NOT control_state.verifier_unapproved_function_execute
    AND NOT control_state.runtime_can_execute_verifier
    AND control_state.verifier_can_execute_verifier
    AND NOT control_state.public_can_execute_verifier
    AND NOT control_state.anon_can_execute_verifier
    AND NOT control_state.authenticated_can_execute_verifier
    AND NOT control_state.service_role_can_execute_verifier
$control_store_verifier$;

ALTER FUNCTION billing_validation_control.verify_attempt_control_store() OWNER TO billing_validation_owner;
REVOKE ALL PRIVILEGES ON SCHEMA billing_validation_control FROM billing_validation_verifier;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA billing_validation_control FROM billing_validation_verifier;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA billing_validation_control FROM billing_validation_verifier;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA billing_validation_control FROM billing_validation_verifier;
ALTER DEFAULT PRIVILEGES FOR ROLE billing_validation_owner IN SCHEMA billing_validation_control
  REVOKE ALL ON TABLES FROM billing_validation_verifier;
ALTER DEFAULT PRIVILEGES FOR ROLE billing_validation_owner IN SCHEMA billing_validation_control
  REVOKE ALL ON SEQUENCES FROM billing_validation_verifier;
ALTER DEFAULT PRIVILEGES FOR ROLE billing_validation_owner IN SCHEMA billing_validation_control
  REVOKE ALL ON FUNCTIONS FROM billing_validation_verifier;
REVOKE EXECUTE ON FUNCTION billing_validation_control.verify_attempt_control_store()
  FROM PUBLIC, anon, authenticated, service_role, billing_validation_runtime, billing_validation_verifier;
GRANT USAGE ON SCHEMA billing_validation_control TO billing_validation_verifier;
GRANT EXECUTE ON FUNCTION billing_validation_control.verify_attempt_control_store() TO billing_validation_verifier;
