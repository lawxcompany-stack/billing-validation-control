import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const RUNTIME_MODULE = new URL('../../src/attempts/runtime-privileges.mjs', import.meta.url);
const BASELINE_URL = new URL('../../src/attempts/schema.sql', import.meta.url);
const MIGRATION_URL = new URL('../../src/attempts/control-store-migrations/202610020001-control-runtime-privileges.sql', import.meta.url);
const PRIOR_MIGRATION_URL = new URL('../../src/attempts/migrations/202610010001-standalone-lease-fencing.sql', import.meta.url);
const VERIFIER_MIGRATION_URL = new URL('../../src/attempts/control-store-migrations/202610030001-control-store-verifier.sql', import.meta.url);
const VERIFIER_ROLE_MIGRATION_URL = new URL('../../src/attempts/control-store-migrations/202610040001-control-verifier-role.sql', import.meta.url);
const STORE_URL = new URL('../../src/attempts/postgres-store.mjs', import.meta.url);
const BASELINE_SHA256 = '830a518ee997f8824657d0a8720b8f8b13c7c91f051d945202b684bfc23739c4';
const APPEND_ONLY_TABLES = [
  'fixture_lease_history',
  'fixture_reservation_claims', 'fixture_reservation_claim_events', 'retention_reservations',
  'retention_receipts', 'cleanup_receipts', 'fixture_case_claims', 'fixture_resource_claims',
  'stripe_intents', 'stripe_receipts',
];

async function loadRuntimePrivileges() {
  try {
    return await import(RUNTIME_MODULE.href);
  } catch (error) {
    assert.fail(`runtime privilege contract is not implemented (${error.code ?? error.name})`);
  }
}

function methodBody(source, methodName) {
  const start = source.indexOf(`async ${methodName}(`);
  assert.notEqual(start, -1, `missing transaction operation ${methodName}`);
  const end = source.indexOf('\n      async ', start + 1);
  return source.slice(start, end === -1 ? source.length : end);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function topLevelSqlCommandStarts(sql) {
  const commands = [];
  let statement = '';
  let index = 0;
  const record = () => {
    const command = statement.match(/^\s*([a-z][a-z0-9_$]*)/iu)?.[1];
    if (command) commands.push(command.toUpperCase());
    statement = '';
  };

  while (index < sql.length) {
    if (sql.startsWith('--', index)) {
      const newline = sql.indexOf('\n', index + 2);
      index = newline < 0 ? sql.length : newline;
      statement += ' ';
      continue;
    }
    if (sql.startsWith('/*', index)) {
      let depth = 1;
      index += 2;
      while (index < sql.length && depth > 0) {
        if (sql.startsWith('/*', index)) {
          depth++;
          index += 2;
        } else if (sql.startsWith('*/', index)) {
          depth--;
          index += 2;
        } else index++;
      }
      statement += ' ';
      continue;
    }

    const character = sql[index];
    if (character === "'" || character === '"') {
      const quote = character;
      const escapeString = quote === "'" && /(?:^|[^a-z0-9_$])[eE]$/u.test(sql.slice(0, index));
      index++;
      while (index < sql.length) {
        if (escapeString && sql[index] === '\\') index += 2;
        else if (sql[index] === quote && sql[index + 1] === quote) index += 2;
        else if (sql[index] === quote) {
          index++;
          break;
        } else index++;
      }
      statement += ' ';
      continue;
    }

    if (character === '$') {
      const delimiter = sql.slice(index).match(/^\$(?:[a-z_][a-z0-9_]*)?\$/iu)?.[0];
      if (delimiter) {
        const closing = sql.indexOf(delimiter, index + delimiter.length);
        index = closing < 0 ? sql.length : closing + delimiter.length;
        statement += ' ';
        continue;
      }
    }

    if (character === ';') {
      record();
      index++;
      continue;
    }

    statement += character;
    index++;
  }

  record();
  return commands;
}

test('destructive SQL detection classifies executable command starts, not trigger clauses or revokes', () => {
  assert.deepEqual(topLevelSqlCommandStarts(`
    CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON control.events;
    CREATE TRIGGER no_truncate BEFORE TRUNCATE ON control.events;
    REVOKE DELETE, TRUNCATE ON TABLE control.events FROM billing_validation_runtime;
  `), ['CREATE', 'CREATE', 'REVOKE']);
  assert.deepEqual(topLevelSqlCommandStarts(`
    -- executable destructive commands must still be recognized
    DELETE FROM control.events;
    TRUNCATE control.events;
    DROP TABLE control.events;
  `), ['DELETE', 'TRUNCATE', 'DROP']);
});

test('runtime ACL inventory is deeply immutable and append-only relations have read/insert only', async () => {
  const { CONTROL_RUNTIME_PRIVILEGES } = await loadRuntimePrivileges();
  assert.equal(Object.isFrozen(CONTROL_RUNTIME_PRIVILEGES), true);
  assert.equal(Object.isFrozen(CONTROL_RUNTIME_PRIVILEGES.tables), true);
  for (const relation of APPEND_ONLY_TABLES) {
    const privileges = CONTROL_RUNTIME_PRIVILEGES.tables[relation];
    assert.ok(privileges, `missing explicit inventory for ${relation}`);
    assert.notEqual(privileges.update, true, `${relation} must never be updated by runtime`);
    assert.notEqual(privileges.delete, true, `${relation} must never be deleted by runtime`);
    assert.notEqual(privileges.truncate, true, `${relation} must never be truncated by runtime`);
    if (privileges.insert) assert.equal(Object.isFrozen(privileges.insert), true);
  }
  assert.equal(CONTROL_RUNTIME_PRIVILEGES.tables.schema_migrations, undefined);
  assert.equal(CONTROL_RUNTIME_PRIVILEGES.tables.control_store_install_receipts, undefined);
  assert.equal(CONTROL_RUNTIME_PRIVILEGES.tables.fixture_reservation_claims.select, true);
  assert.equal(CONTROL_RUNTIME_PRIVILEGES.tables.fixture_reservation_claims.insert, undefined);
  assert.deepEqual(CONTROL_RUNTIME_PRIVILEGES.tables.fixture_resource_claims.select,
    ['attempt_id', 'case_id', 'kind']);
});

test('runtime grants are closed, explicit, and preceded by revocation', async () => {
  const { CONTROL_RUNTIME_PRIVILEGES, renderControlRuntimeGrants } = await loadRuntimePrivileges();
  const sql = renderControlRuntimeGrants(CONTROL_RUNTIME_PRIVILEGES);
  const grants = [...sql.matchAll(/^GRANT\s+(.+?)\s+TO\s+([a-z0-9_]+);$/gmu)];
  const firstGrant = sql.indexOf('\nGRANT ');

  assert.ok(firstGrant > 0);
  assert.ok(sql.slice(0, firstGrant).includes('REVOKE ALL PRIVILEGES'));
  assert.ok(grants.length > 0);
  assert.ok(grants.every(([, privilege, role]) => role === 'billing_validation_runtime'));
  assert.ok(grants.every(([, privilege]) => !/^ALL(?:\s|$)/u.test(privilege)));
  assert.doesNotMatch(sql, /\b(?:PUBLIC|anon|authenticated|service_role|schema_migrations|control_store_install_receipts)\b/iu);
  assert.match(sql, /GRANT USAGE ON SCHEMA billing_validation_control TO billing_validation_runtime;/u);
  assert.match(sql, /GRANT USAGE ON SEQUENCE billing_validation_control\.fixture_lease_fence_seq TO billing_validation_runtime;/u);
  assert.match(sql,
    /GRANT SELECT \(attempt_id, case_id, kind\) ON TABLE billing_validation_control\.fixture_resource_claims TO billing_validation_runtime;/u);
  assert.doesNotMatch(sql, /GRANT\s+ALL\b|GRANT\s+[^;]+\s+ON\s+ALL\s+(?:TABLES|SEQUENCES|FUNCTIONS)/iu);
});

test('runtime privilege inspection checks owner ownership for sequences as well as tables', async () => {
  const source = await readFile(new URL('./control-store-fixtures.mjs', import.meta.url), 'utf8');
  assert.match(source,
    /NOT EXISTS \(SELECT 1 FROM pg_catalog\.pg_class AS relation[\s\S]{0,250}relation\.relkind IN \('r', 'p', 'v', 'm', 'f', 'S'\)[\s\S]{0,300}AS owner_owns_objects/u);
  assert.match(source, /expected\.select === true \? row\.all_columns : expected\.select \?\? \[\]/u);
});

test('renderer rejects omitted, widened, mutable, or prototype-bearing privilege inputs', async () => {
  const { CONTROL_RUNTIME_PRIVILEGES, renderControlRuntimeGrants } = await loadRuntimePrivileges();
  assert.throws(() => renderControlRuntimeGrants(), { code: 'control_runtime_privileges_invalid' });
  assert.throws(() => renderControlRuntimeGrants({ ...CONTROL_RUNTIME_PRIVILEGES, extra: true }),
    { code: 'control_runtime_privileges_invalid' });

  const widened = structuredClone(CONTROL_RUNTIME_PRIVILEGES);
  widened.tables.retention_reservations.update = ['projection'];
  assert.throws(() => renderControlRuntimeGrants(widened), { code: 'control_runtime_privileges_invalid' });

  const inherited = Object.assign(Object.create({ injected: true }), CONTROL_RUNTIME_PRIVILEGES);
  assert.throws(() => renderControlRuntimeGrants(inherited), { code: 'control_runtime_privileges_invalid' });
});

test('forward migration contains exactly the renderer ACL block and is one-shot', async () => {
  const [{ CONTROL_RUNTIME_PRIVILEGES, renderControlRuntimeGrants }, migrationBytes] = await Promise.all([
    loadRuntimePrivileges(), readFile(MIGRATION_URL),
  ]);
  const migration = migrationBytes.toString('utf8');
  const begin = '-- BEGIN GENERATED CONTROL RUNTIME ACLS\n';
  const end = '-- END GENERATED CONTROL RUNTIME ACLS';
  const start = migration.indexOf(begin);
  const finish = migration.indexOf(end);

  assert.ok(start >= 0 && finish > start);
  assert.equal(migration.slice(start + begin.length, finish), renderControlRuntimeGrants(CONTROL_RUNTIME_PRIVILEGES));
  assert.doesNotMatch(migration, /\b(?:IF\s+NOT\s+EXISTS|OR\s+REPLACE)\b/iu);
  assert.deepEqual(topLevelSqlCommandStarts(migration).filter((command) =>
    ['DROP', 'DELETE', 'TRUNCATE'].includes(command)), []);
  assert.doesNotMatch(migration, /\bGRANT\s+ALL\b/iu);
  assert.match(migration, /ALTER DEFAULT PRIVILEGES FOR ROLE billing_validation_owner IN SCHEMA billing_validation_control/u);
  const globalDefaultAclCommands = [...migration.matchAll(
    /^ALTER DEFAULT PRIVILEGES FOR ROLE billing_validation_owner(?! IN SCHEMA)[\s\S]*?;/gmu,
  )].map(([statement]) => statement.trim());
  assert.deepEqual(globalDefaultAclCommands, [
    'ALTER DEFAULT PRIVILEGES FOR ROLE billing_validation_owner\n  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;',
  ]);
  assert.doesNotMatch(migration, /CREATE\s+ROLE\s+billing_validation_runtime/u);
  assert.match(migration, /service_role/u);
});

test('verifier migration leaves runtime business ACLs intact and grants verifier only schema usage and fixed execute', async () => {
  const migration = await readFile(VERIFIER_ROLE_MIGRATION_URL, 'utf8');
  assert.match(migration, /CREATE OR REPLACE FUNCTION billing_validation_control\.verify_attempt_control_store\(\)/u);
  assert.match(migration, /REVOKE EXECUTE ON FUNCTION billing_validation_control\.verify_attempt_control_store\(\)\s+FROM[^;]*billing_validation_runtime/u);
  assert.match(migration, /GRANT USAGE ON SCHEMA billing_validation_control TO billing_validation_verifier;/u);
  assert.match(migration, /REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA billing_validation_control FROM billing_validation_verifier;/u);
  assert.match(migration, /REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA billing_validation_control FROM billing_validation_verifier;/u);
  assert.match(migration, /REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA billing_validation_control FROM billing_validation_verifier;/u);
  assert.match(migration, /ALTER DEFAULT PRIVILEGES FOR ROLE billing_validation_owner IN SCHEMA billing_validation_control/u);
  const verifierGrants = [...migration.matchAll(/^GRANT\s+(.+?)\s+TO\s+billing_validation_verifier;$/gmu)]
    .map(([, privilege]) => privilege);
  assert.deepEqual(verifierGrants.sort(), [
    'EXECUTE ON FUNCTION billing_validation_control.verify_attempt_control_store()',
    'USAGE ON SCHEMA billing_validation_control',
  ].sort());
  assert.doesNotMatch(migration, /GRANT\s+(?:INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALL)\b[^;]*billing_validation_verifier/iu);
});

test('claim usage is an append-only event stream with legacy preservation and stale-transition guards', async () => {
  const migration = await readFile(MIGRATION_URL, 'utf8');
  assert.match(migration, /CREATE TABLE billing_validation_control\.fixture_reservation_claim_events/u);
  assert.match(migration, /event_id text PRIMARY KEY/u);
  assert.match(migration, /previous_rows bigint NOT NULL/u);
  assert.match(migration, /current_rows bigint NOT NULL/u);
  assert.match(migration, /event_type text NOT NULL DEFAULT 'usage'/u);
  assert.match(migration, /legacy_baseline/u);
  assert.match(migration, /INSERT INTO billing_validation_control\.fixture_reservation_claim_events[\s\S]*?FROM billing_validation_control\.fixture_reservation_claims[\s\S]*?database_rows_used > 0/u);
  assert.match(migration, /NEW\.previous_rows IS DISTINCT FROM latest_rows/u);
  assert.match(migration, /NEW\.current_rows <= NEW\.previous_rows/u);
  assert.match(migration,
    /^CREATE TRIGGER billing_validation_fixture_reservation_claim_events_immutable\s+BEFORE UPDATE OR DELETE ON billing_validation_control\.fixture_reservation_claim_events\s+FOR EACH ROW EXECUTE FUNCTION billing_validation_control\.reject_retention_ledger_mutation\(\);/mu);
  assert.match(migration,
    /^CREATE TRIGGER billing_validation_fixture_reservation_claim_events_no_truncate\s+BEFORE TRUNCATE ON billing_validation_control\.fixture_reservation_claim_events\s+FOR EACH STATEMENT EXECUTE FUNCTION billing_validation_control\.reject_retention_ledger_mutation\(\);/mu);
  assert.match(migration, /BEFORE UPDATE ON billing_validation_control\.fixture_reservation_claims/u);
});

test('definer triggers pin search_path and keep privileged bodies schema-qualified', async () => {
  const [baseline, priorMigration] = await Promise.all([
    readFile(BASELINE_URL, 'utf8'), readFile(PRIOR_MIGRATION_URL, 'utf8'),
  ]);
  const installedFunctions = `${baseline}\n${priorMigration}`;
  const migration = await readFile(MIGRATION_URL, 'utf8');
  const definerFunctions = [
    'validate_fixture_case_claim', 'validate_retention_receipt_projection',
    'validate_retention_receipt_owner_fence', 'validate_cleanup_receipt_identity',
  ];

  for (const name of definerFunctions) {
    const definition = new RegExp(`CREATE FUNCTION billing_validation_control\\.${name}\\(\\)[\\s\\S]*?\\$\\$;`, 'u');
    const source = installedFunctions.match(definition)?.[0];
    assert.ok(source, `missing baseline body for ${name}`);
    assert.match(source, /SET search_path\s*=\s*pg_catalog/u, name);
    assert.match(migration, new RegExp(`ALTER FUNCTION billing_validation_control\\.${name}\\(\\) SECURITY DEFINER;`, 'u'));
  }
  assert.match(migration,
    /CREATE FUNCTION billing_validation_control\.validate_fixture_reservation_claim_event\(\)[\s\S]*?SECURITY DEFINER\s+SET search_path = pg_catalog/u);
  for (const [functionBody] of migration.matchAll(/CREATE FUNCTION billing_validation_control\.[a-z0-9_]+\(\)[\s\S]*?\$\$;/giu)) {
    assert.match(functionBody, /SET search_path\s*=\s*pg_catalog/u);
  }
});

test('reservation, claim, cleanup, and Stripe immutable reads serialize by business key without row locks', async () => {
  const source = await readFile(STORE_URL, 'utf8');
  const operations = [
    ['getRetentionReservation', /FOR\s+(?:NO\s+KEY\s+)?UPDATE/iu],
    ['getCleanupReceipt', /FOR\s+(?:NO\s+KEY\s+)?UPDATE/iu],
    ['getStripeIntentByOperation', /FOR\s+(?:NO\s+KEY\s+)?UPDATE/iu],
    ['getStripeIntent', /FOR\s+(?:NO\s+KEY\s+)?UPDATE/iu],
    ['listPendingStripeIntents', /FOR\s+(?:NO\s+KEY\s+)?UPDATE/iu],
    ['getStripeReceipt', /FOR\s+(?:NO\s+KEY\s+)?UPDATE/iu],
    ['claimFixtureCase', /FOR\s+(?:NO\s+KEY\s+)?UPDATE/iu],
  ];

  for (const [method, rowLock] of operations) {
    assert.doesNotMatch(methodBody(source, method), rowLock, `${method} must not row-lock an immutable relation`);
  }
  for (const method of ['getRetentionReservation', 'setRetentionFixtureRowsUsed', 'getCleanupReceipt',
    'putCleanupReceipt', 'getStripeIntentByOperation', 'getStripeIntent', 'listPendingStripeIntents',
    'insertStripeIntent', 'getStripeReceipt', 'putStripeReceipt', 'claimFixtureCase']) {
    assert.match(methodBody(source, method), /lock(?:Business)?Key/u, `${method} must serialize its business key`);
  }

  const write = methodBody(source, 'setRetentionFixtureRowsUsed');
  assert.match(write, /fixture_reservation_claim_events/u);
  assert.match(write, /previous_rows/u);
  assert.match(write, /current_rows/u);
  assert.doesNotMatch(write, /fixture_reservation_claims[\s\S]{0,300}DO\s+UPDATE/iu);
});

test('immutable first-install baseline and forward control migration chain remain pinned', async () => {
  const [baseline, pinsModule] = await Promise.all([
    readFile(BASELINE_URL), import('../../src/attempts/control-store-bootstrap-pins.mjs'),
  ]);
  const pins = pinsModule.CONTROL_STORE_BOOTSTRAP_PINS;
  const migrationBytes = await Promise.all([
    readFile(new URL('../../src/attempts/migrations/202610010001-standalone-lease-fencing.sql', import.meta.url)),
    readFile(MIGRATION_URL),
    readFile(VERIFIER_MIGRATION_URL),
    readFile(VERIFIER_ROLE_MIGRATION_URL),
  ]);

  assert.equal(sha256(baseline), BASELINE_SHA256);
  assert.equal(pins.baselineSha256, BASELINE_SHA256);
  assert.deepEqual(pins.migrations.map(({ version, name, file, sha256: digest }) => ({
    version, name, file, sha256: digest,
  })), [
    { version: '202610010001', name: 'standalone-lease-fencing',
      file: '202610010001-standalone-lease-fencing.sql', sha256: sha256(migrationBytes[0]) },
    { version: '202610020001', name: 'control-runtime-privileges',
      file: '202610020001-control-runtime-privileges.sql', sha256: sha256(migrationBytes[1]) },
    { version: '202610030001', name: 'control-store-verifier',
      file: '202610030001-control-store-verifier.sql', sha256: sha256(migrationBytes[2]) },
    { version: '202610040001', name: 'control-verifier-role',
      file: '202610040001-control-verifier-role.sql', sha256: sha256(migrationBytes[3]) },
  ]);
  assert.equal(pins.migrations[0].sha256, 'd733038f706135c2514084fc229c9ac7507796cccd4eca4974ca1dc981fd12fb');
  assert.equal(pins.migrations[1].sha256, '69fe93ee2a67e8a52588bdb8b235ab88207441f5c85608bc51e791d574347c08');
  assert.equal(pins.migrations[2].sha256, '56ca6c77487900bbd9affc934665e08f5bc5246e42c1adb9a077d828c8034698');
  const baselineSql = baseline.toString('utf8');
  for (const table of ['retention_reservations', 'retention_receipts', 'stripe_intents', 'stripe_receipts',
    'fixture_reservation_claims', 'fixture_case_claims', 'fixture_resource_claims', 'cleanup_receipts']) {
    assert.match(baselineSql, new RegExp(`BEFORE TRUNCATE ON billing_validation_control\\.${table}`));
  }
});

test('local PostgreSQL privilege catalog probe refuses to accept a non-loopback connection target', async () => {
  const { parseControlStoreLocalTestUrl } = await import('./control-store-fixtures.mjs');
  for (const url of [
    'postgresql://postgres:secret@db.example.invalid:5432/postgres',
    'postgresql://postgres:secret@127.0.0.1:5432/other_database',
    'postgresql://postgres:secret@127.0.0.1/postgres?hostaddr=203.0.113.2',
  ]) {
    assert.throws(() => parseControlStoreLocalTestUrl(url), { code: 'control_store_test_target_invalid' });
  }
  assert.deepEqual(parseControlStoreLocalTestUrl('postgresql://postgres:secret@127.0.0.1:55432/postgres'), {
    host: '127.0.0.1', port: 55432, database: 'postgres', user: 'postgres', password: 'secret',
  });
});

test('opt-in local PostgreSQL 17 runtime-identity verifier and NOLOGIN privilege probe', {
  skip: process.env.BILLING_CONTROL_RUNTIME_PG_TEST !== '1'
    ? 'explicit local PostgreSQL 17 opt-in and disposable target required'
    : false,
}, async () => {
  const url = process.env.BILLING_CONTROL_RUNTIME_PG_TEST_URL;
  assert.equal(typeof url, 'string');
  const { Client } = await import('pg');
  const { parseControlStoreLocalTestUrl, inspectControlStoreRuntimeRole } =
    await import('./control-store-fixtures.mjs');
  const { CONTROL_STORE_POLICY } = await import('../../src/attempts/control-store-policy.mjs');
  const { verifyAttemptControlStore } = await import('../../src/attempts/control-store-verifier.mjs');
  const client = new Client(parseControlStoreLocalTestUrl(url));
  await client.connect();
  try {
  const server = await client.query('SELECT current_setting(\'server_version_num\')::integer AS version');
    const [major, minor] = CONTROL_STORE_POLICY.databaseVersion.split('.').map(Number);
  assert.equal(server.rows[0].version, major * 10_000 + minor,
    'local verifier probe requires the policy-pinned PostgreSQL version');
  const connectedRole = await client.query(`SELECT rolsuper AS is_superuser FROM pg_catalog.pg_roles
    WHERE rolname = current_user`);
  assert.deepEqual(connectedRole.rows, [{ is_superuser: true }],
    'transaction-local NOLOGIN identity probe must connect as the disposable database superuser');
    const roleBefore = await client.query(`SELECT rolname, rolcanlogin FROM pg_catalog.pg_roles
      WHERE rolname IN ('billing_validation_runtime', 'billing_validation_verifier') ORDER BY rolname`);
    assert.deepEqual(roleBefore.rows, [
      { rolname: 'billing_validation_runtime', rolcanlogin: false },
      { rolname: 'billing_validation_verifier', rolcanlogin: false },
    ], 'bootstrap leaves both roles disabled before local-only verifier activation');
    const result = await inspectControlStoreRuntimeRole(client);
    assert.equal(result.ownerLogin, false);
    assert.equal(result.runtimeLogin, false);
    assert.equal(result.runtimeSuperuser, false);
    assert.equal(result.runtimeCreateRole, false);
    assert.equal(result.runtimeCreateDatabase, false);
    assert.equal(result.runtimeReplication, false);
    assert.equal(result.runtimeBypassRls, false);
    assert.equal(result.runtimeMemberOfOwner, false);
    assert.equal(result.runtimeHasRoleMembership, false);
    assert.equal(result.runtimeOwnsObjects, false);
    assert.equal(result.ownerOwnsObjects, true);
    assert.equal(result.schemaOwner, true);
    assert.equal(result.runtimeSchemaUsage, true);
    assert.equal(result.runtimeSchemaCreate, false);
    assert.equal(result.privilegeMatrixMatches, true,
      `runtime privilege matrix mismatch: ${JSON.stringify(result.privilegeMatrixMismatchDetails)}`);
    assert.equal(result.migrationLedgerSelect, false);
    assert.equal(result.installReceiptSelect, false);
    assert.equal(result.appendOnlyMutations, false);
    assert.equal(result.forbiddenPrincipalHasGrants, false);
    assert.equal(result.defaultAclPublicExecute, false);
    assert.equal(result.defaultAclWidensRuntime, false);
    assert.ok(Object.values(result.deniedOperations).every(Boolean),
      `runtime denial/no-effect was not proven for ${JSON.stringify(Object.entries(result.deniedOperations)
        .filter(([, denied]) => !denied).map(([name]) => name))} as ${JSON.stringify(result.denialProbeIdentity)}`);
    const target = { projectRef: CONTROL_STORE_POLICY.projectRef,
      host: CONTROL_STORE_POLICY.connection.host, port: CONTROL_STORE_POLICY.connection.port,
      database: CONTROL_STORE_POLICY.connection.database, username: CONTROL_STORE_POLICY.roles.verifier,
      sslMode: CONTROL_STORE_POLICY.connection.sslMode };
    const verifyAsLocallyActivatedVerifier = async () => {
      await client.query('BEGIN');
      try {
        // Task 6 local-only activation: rollback restores the bootstrap NOLOGIN state.
        await client.query('ALTER ROLE billing_validation_verifier LOGIN');
        await client.query('SET LOCAL SESSION AUTHORIZATION billing_validation_verifier');
        const identity = await client.query('SELECT session_user, current_user');
        assert.deepEqual(identity.rows, [{ session_user: 'billing_validation_verifier',
          current_user: 'billing_validation_verifier' }]);
        const receipt = await verifyAttemptControlStore({ queryClient: client,
          policy: CONTROL_STORE_POLICY, target });
        await client.query('ROLLBACK');
        return receipt;
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* preserve the original verification failure */ }
        throw error;
      }
    };
    const receipt = await verifyAsLocallyActivatedVerifier();
    assert.equal(receipt.projectRef, CONTROL_STORE_POLICY.projectRef);
    assert.equal(receipt.role, CONTROL_STORE_POLICY.roles.verifier);

    const unexpectedMemberships = [
      { grantedRole: 'billing_validation_runtime', memberRole: 'service_role' },
      { grantedRole: 'service_role', memberRole: 'billing_validation_runtime' },
      { grantedRole: 'billing_validation_verifier', memberRole: 'billing_validation_owner' },
      { grantedRole: 'service_role', memberRole: 'billing_validation_verifier' },
    ];
    for (const { grantedRole, memberRole } of unexpectedMemberships) {
      await client.query('BEGIN');
      try {
        await client.query(`GRANT ${grantedRole} TO ${memberRole}`);
        await client.query('ALTER ROLE billing_validation_verifier LOGIN');
        if (grantedRole === CONTROL_STORE_POLICY.roles.runtime ||
            memberRole === CONTROL_STORE_POLICY.roles.runtime) {
          const runtimeState = await inspectControlStoreRuntimeRole(client);
          assert.equal(runtimeState.runtimeHasRoleMembership, true,
            `runtime diagnostics must report membership ${grantedRole} -> ${memberRole}`);
        }
        await client.query('SET LOCAL SESSION AUTHORIZATION billing_validation_verifier');
        await assert.rejects(verifyAttemptControlStore({ queryClient: client,
          policy: CONTROL_STORE_POLICY, target }), { code: 'control_store_identity_invalid' },
        `verifier must refuse unexpected membership ${grantedRole} -> ${memberRole}`);
        await client.query('ROLLBACK');
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* preserve the original verification failure */ }
        throw error;
      }
    }

    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL SESSION AUTHORIZATION billing_validation_runtime');
      await assert.rejects(client.query('SELECT * FROM billing_validation_control.verify_attempt_control_store()'),
        (error) => error.code === '42501', 'runtime must not execute the verifier function');
      await client.query('ROLLBACK');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the original verification failure */ }
      throw error;
    }

    await client.query('BEGIN');
    try {
      await client.query('GRANT TRIGGER ON TABLE billing_validation_control.attempts TO billing_validation_runtime');
      await client.query('ALTER ROLE billing_validation_verifier LOGIN');
      await client.query('SET LOCAL SESSION AUTHORIZATION billing_validation_verifier');
      const changedFingerprint = await client.query(`SELECT privilege_fingerprint_sha256
        FROM billing_validation_control.verify_attempt_control_store()`);
      assert.equal(changedFingerprint.rowCount, 1);
      assert.notEqual(changedFingerprint.rows[0].privilege_fingerprint_sha256,
        receipt.privilegeFingerprintSha256, 'added TRIGGER privilege must change the canonical fingerprint');
      await assert.rejects(verifyAttemptControlStore({ queryClient: client,
        policy: CONTROL_STORE_POLICY, target }), { code: 'control_store_identity_invalid' });
      await client.query('ROLLBACK');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the original verification failure */ }
      throw error;
    }
    const persistentRole = await client.query(`SELECT role.rolname, role.rolcanlogin,
        pg_catalog.has_table_privilege(role.oid,
          pg_catalog.to_regclass('billing_validation_control.attempts'), 'TRIGGER') AS trigger_privilege
      FROM pg_catalog.pg_roles AS role WHERE role.rolname IN ('billing_validation_runtime', 'billing_validation_verifier')
      ORDER BY role.rolname`);
    assert.deepEqual(persistentRole.rows, [
      { rolname: 'billing_validation_runtime', rolcanlogin: false, trigger_privilege: false },
      { rolname: 'billing_validation_verifier', rolcanlogin: false, trigger_privilege: false },
    ]);
  } finally {
    await client.end();
  }
});
