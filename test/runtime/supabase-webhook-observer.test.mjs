import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

const moduleResult = await import('../../src/runtime/supabase-webhook-observer.mjs').catch((error) => {
  if (error?.code === 'ERR_MODULE_NOT_FOUND') return null;
  throw error;
});

const createSupabaseWebhookObserver = moduleResult?.createSupabaseWebhookObserver;
const environment = Object.freeze({
  database: Object.freeze({ projectRef: 'zjvqjdntasprusoqfsgw', branchId: 'e2f26c0b-8a79-4cd5-ad80-faaf91fb51a2' }),
  deployment: Object.freeze({ id: 'dpl_task6preview123', origin: 'https://lawx-abc123def-team.vercel.app' }),
  stripe: Object.freeze({ accountId: 'acct_task6test123' }),
});
const password = 'secret-never-return-this';
const rawSignature = 'whsec_synthetic_signature_do_not_return';
const rawPayload = 'synthetic_raw_payload_do_not_return';
const eventId = 'evt_synthetic_webhook_001';
const READER_ROLE = 'lawx_billing_validation_reader';

const allowedIdentity = Object.freeze({
  transaction_read_only: 'on',
  role_name: READER_ROLE,
  is_superuser: false,
  bypass_rls: false,
  can_create_database: false,
  can_create_role: false,
  replication: false,
  no_role_memberships: true,
  database_create_denied: true,
  database_temp_denied: true,
  non_system_schema_create_denied: true,
  allowed_schema_usage: true,
  all_relation_writes_denied: true,
  all_non_system_routine_executes_denied: true,
  all_large_object_write_capabilities_denied: true,
  all_relation_maintain_denied: true,
  unapproved_relation_reads_denied: true,
  evidence_relation_select_denied: true,
  evidence_rls_visibility_granted: true,
  evidence_columns_granted: true,
  other_evidence_columns_denied: true,
  all_sequence_privileges_denied: true,
});

const SQL = Object.freeze({
  begin: 'BEGIN READ ONLY',
  identityPrefix: "SELECT current_setting('transaction_read_only')",
  webhookEvents: 'SELECT event_id FROM public.webhook_events WHERE event_id = $1 ORDER BY event_id LIMIT 10001',
  webhookDeliveries: 'SELECT id, event_id FROM public.billing_webhook_deliveries WHERE event_id = $1 ORDER BY id, event_id LIMIT 10001',
  commit: 'COMMIT',
});

function makeClientFactory({ identity = allowedIdentity, events = [{ event_id: eventId }], deliveries = [
  { id: 'receipt-002', event_id: eventId }, { id: 'receipt-001', event_id: eventId },
], failQuery, hangEnd = false, hangIdentity = false } = {}) {
  const clients = [];
  const configs = [];
  const factory = (config) => {
    configs.push(config);
    const calls = [];
    const client = {
      calls,
      ended: false,
      destroyCalls: 0,
      connection: { stream: { destroy() { client.destroyCalls += 1; } } },
      async connect() { calls.push({ kind: 'connect' }); },
      async query(text, values) {
        calls.push({ kind: 'query', text, values });
        if (failQuery) throw new Error(`database failure includes ${password} ${rawSignature} ${rawPayload}`);
        if (text.startsWith(SQL.identityPrefix)) {
          if (hangIdentity) return new Promise(() => {});
          return { rows: [identity] };
        }
        if (text === SQL.webhookEvents) return { rows: events };
        if (text === SQL.webhookDeliveries) return { rows: deliveries };
        if (text === SQL.begin || text === SQL.commit) return { rows: [] };
        throw new Error(`unexpected SQL: ${text}`);
      },
      async end() {
        calls.push({ kind: 'end' });
        if (hangEnd) return new Promise(() => {});
        client.ended = true;
      },
    };
    clients.push(client);
    return client;
  };
  return { factory, clients, configs };
}

function observer(options = {}) {
  const database = options.database ?? makeClientFactory();
  const value = createSupabaseWebhookObserver({
    expectedEnvironment: options.expectedEnvironment ?? environment,
    password: options.password ?? password,
    clientFactory: database.factory,
  });
  return { value, database };
}

function sha256(value) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function identityQuery(client) {
  return client.calls.find((call) => call.kind === 'query' && call.text.startsWith(SQL.identityPrefix))?.text;
}

test('exports the read-only webhook observer factory', () => {
  assert.equal(typeof createSupabaseWebhookObserver, 'function');
});

test('the pinned pg client exposes the stream destroy primitive required by deadline cleanup', async () => {
  const pg = await import('pg');
  const Client = pg.Client ?? pg.default?.Client;
  assert.equal(typeof Client, 'function');
  const client = new Client({ host: '127.0.0.1', user: READER_ROLE, database: 'postgres', password });
  assert.equal(typeof client.connection?.stream?.destroy, 'function');
  await client.end();
});

test('pins target, TLS, fixed reader role, read-only identity, and exposes no other operations', {
  skip: typeof createSupabaseWebhookObserver !== 'function',
}, async () => {
  const database = makeClientFactory();
  const reader = createSupabaseWebhookObserver({ expectedEnvironment: environment, password,
    clientFactory: database.factory });

  assert.deepEqual(Object.keys(reader).sort(), ['close', 'readIdentity', 'readRejectedWebhookPersistence']);
  const identity = await reader.readIdentity();

  assert.deepEqual(database.configs[0], {
    host: `db.${environment.database.projectRef}.supabase.co`,
    port: 5432,
    database: 'postgres',
    user: READER_ROLE,
    password,
    ssl: { rejectUnauthorized: true, servername: `db.${environment.database.projectRef}.supabase.co` },
    connectionTimeoutMillis: 8_000,
    query_timeout: 6_000,
    statement_timeout: 4_000,
    idle_in_transaction_session_timeout: 10_000,
    options: '-c search_path=pg_catalog',
    keepAlive: false,
  });
  assert.deepEqual(identity, { projectRef: environment.database.projectRef,
    branchId: environment.database.branchId, readerId: 'lawx-billing-validation-webhook-reader-v1', readOnly: true });
  assert.deepEqual(database.clients[0].calls.filter((call) => call.kind === 'query').map(({ text }) => text),
    [SQL.begin, identityQuery(database.clients[0]), SQL.commit]);
  assert.equal(database.clients[0].ended, true);
  assert.equal(Object.hasOwn(reader, 'query'), false);
  assert.equal(Object.hasOwn(reader, 'rpc'), false);
  assert.equal(Object.hasOwn(reader, 'execute'), false);
  await reader.close();
});

test('reads rejected webhook persistence using only fixed parameterized SELECTs and returns hashed identities', {
  skip: typeof createSupabaseWebhookObserver !== 'function',
}, async () => {
  const database = makeClientFactory();
  const reader = createSupabaseWebhookObserver({ expectedEnvironment: environment, password,
    clientFactory: database.factory });

  const observation = await reader.readRejectedWebhookPersistence({ eventId });

  assert.deepEqual(database.clients[0].calls.filter((call) => call.kind === 'query').map(({ text, values }) => ({
    text, values,
  })), [
    { text: SQL.begin, values: undefined },
    { text: identityQuery(database.clients[0]), values: undefined },
    { text: SQL.webhookEvents, values: [eventId] },
    { text: SQL.webhookDeliveries, values: [eventId] },
    { text: SQL.commit, values: undefined },
  ]);
  assert.deepEqual(observation, {
    projectRef: environment.database.projectRef,
    branchId: environment.database.branchId,
    readerId: 'lawx-billing-validation-webhook-reader-v1',
    readOnly: true,
    webhookEvents: { count: 1, identitySha256: sha256([eventId]) },
    webhookDeliveries: { count: 2, identitySha256: sha256([
      ['receipt-001', eventId], ['receipt-002', eventId],
    ]) },
  });
  assert.equal(JSON.stringify(observation).includes(eventId), false);
  assert.equal(JSON.stringify(observation).includes(password), false);
  assert.equal(database.clients[0].ended, true);
});

test('each observation leases a fresh client and close prevents future connections', {
  skip: typeof createSupabaseWebhookObserver !== 'function',
}, async () => {
  const database = makeClientFactory();
  const reader = createSupabaseWebhookObserver({ expectedEnvironment: environment, password,
    clientFactory: database.factory });

  await reader.readIdentity();
  await reader.readRejectedWebhookPersistence({ eventId });
  assert.equal(database.clients.length, 2);
  assert.ok(database.clients.every((client) => client.ended));

  await reader.close();
  await assert.rejects(reader.readIdentity(), { code: 'supabase_webhook_observer_closed' });
  assert.equal(database.clients.length, 2);
});

test('rejects invalid event identifiers and extra input before contacting the database', {
  skip: typeof createSupabaseWebhookObserver !== 'function',
}, async () => {
  const database = makeClientFactory();
  const reader = createSupabaseWebhookObserver({ expectedEnvironment: environment, password,
    clientFactory: database.factory });

  for (const input of [{ eventId: '' }, { eventId: 'evt_' }, { eventId: `evt_${'x'.repeat(121)}` },
    { eventId: 'evt_safe;DROP_TABLE' }, { eventId, sql: 'SELECT 1' }, Object.create({ eventId })]) {
    await assert.rejects(reader.readRejectedWebhookPersistence(input), {
      code: 'supabase_webhook_observer_input_invalid',
    });
  }
  let getterCalls = 0;
  const accessorInput = Object.defineProperty({}, 'eventId', {
    enumerable: true,
    get() { getterCalls += 1; return eventId; },
  });
  await assert.rejects(reader.readRejectedWebhookPersistence(accessorInput), {
    code: 'supabase_webhook_observer_input_invalid',
  });
  assert.equal(getterCalls, 0);
  assert.equal(database.clients.length, 0);
});

test('refuses wrong identity and any elevated role or table/schema write privilege', {
  skip: typeof createSupabaseWebhookObserver !== 'function',
}, async () => {
  const invalidIdentities = [
    { ...allowedIdentity, transaction_read_only: 'off' },
    { ...allowedIdentity, role_name: 'service_role' },
    { ...allowedIdentity, is_superuser: true },
    { ...allowedIdentity, bypass_rls: true },
    { ...allowedIdentity, can_create_database: true },
    { ...allowedIdentity, can_create_role: true },
    { ...allowedIdentity, replication: true },
    { ...allowedIdentity, no_role_memberships: false },
    { ...allowedIdentity, database_create_denied: false },
    { ...allowedIdentity, database_temp_denied: false },
    { ...allowedIdentity, non_system_schema_create_denied: false },
    { ...allowedIdentity, allowed_schema_usage: false },
    { ...allowedIdentity, all_relation_writes_denied: false },
    { ...allowedIdentity, all_non_system_routine_executes_denied: false },
    { ...allowedIdentity, all_large_object_write_capabilities_denied: false },
    { ...allowedIdentity, all_relation_maintain_denied: false },
    { ...allowedIdentity, unapproved_relation_reads_denied: false },
    { ...allowedIdentity, evidence_relation_select_denied: false },
    { ...allowedIdentity, evidence_columns_granted: false },
    { ...allowedIdentity, other_evidence_columns_denied: false },
    { ...allowedIdentity, all_sequence_privileges_denied: false },
  ];

  for (const identity of invalidIdentities) {
    const database = makeClientFactory({ identity });
    const reader = createSupabaseWebhookObserver({ expectedEnvironment: environment, password,
      clientFactory: database.factory });
    await assert.rejects(reader.readRejectedWebhookPersistence({ eventId }), {
      code: 'supabase_webhook_observer_identity_invalid',
    });
    assert.deepEqual(database.clients[0].calls.filter((call) => call.kind === 'query').map(({ text }) => text),
      [SQL.begin, identityQuery(database.clients[0]), 'ROLLBACK']);
    assert.equal(database.clients[0].ended, true);
  }
});

test('maps provider and malformed-row failures to fixed refusal codes without leaking sensitive values', {
  skip: typeof createSupabaseWebhookObserver !== 'function',
}, async () => {
  const database = makeClientFactory({ failQuery: true });
  const reader = createSupabaseWebhookObserver({ expectedEnvironment: environment, password,
    clientFactory: database.factory });

  await assert.rejects(reader.readRejectedWebhookPersistence({ eventId }), (error) => {
    assert.equal(error.code, 'supabase_webhook_observer_unavailable');
    assert.equal(error.message, error.code);
    assert.equal(error.message.includes(password), false);
    assert.equal(error.message.includes(rawSignature), false);
    assert.equal(error.message.includes(rawPayload), false);
    assert.equal(JSON.stringify(error).includes(password), false);
    return true;
  });
  assert.equal(database.clients[0].ended, true);

  const malformedDatabase = makeClientFactory({ events: [{ event_id: 'evt_other' }] });
  const malformedReader = createSupabaseWebhookObserver({ expectedEnvironment: environment, password,
    clientFactory: malformedDatabase.factory });
  await assert.rejects(malformedReader.readRejectedWebhookPersistence({ eventId }), {
    code: 'supabase_webhook_observer_response_invalid',
  });

  const sensitiveRowDatabase = makeClientFactory({ events: [{ event_id: eventId, payload: rawPayload }] });
  const sensitiveRowReader = createSupabaseWebhookObserver({ expectedEnvironment: environment, password,
    clientFactory: sensitiveRowDatabase.factory });
  await assert.rejects(sensitiveRowReader.readRejectedWebhookPersistence({ eventId }), (error) => {
    assert.equal(error.code, 'supabase_webhook_observer_response_invalid');
    assert.equal(error.message.includes(rawPayload), false);
    return true;
  });
});

test('refuses an observation exceeding the bounded receipt identity count', {
  skip: typeof createSupabaseWebhookObserver !== 'function',
}, async () => {
  const deliveries = Array.from({ length: 10_001 }, (_, index) => ({
    id: `receipt-${String(index).padStart(5, '0')}`,
    event_id: eventId,
  }));
  const database = makeClientFactory({ deliveries });
  const reader = createSupabaseWebhookObserver({ expectedEnvironment: environment, password,
    clientFactory: database.factory });

  await assert.rejects(reader.readRejectedWebhookPersistence({ eventId }), {
    code: 'supabase_webhook_observer_response_invalid',
  });
  assert.equal(database.clients[0].ended, true);
});

test('refuses an environment without a valid pinned child project before any database connection', {
  skip: typeof createSupabaseWebhookObserver !== 'function',
}, async () => {
  const database = makeClientFactory();
  for (const databaseIdentity of [
    { ...environment.database, projectRef: 'abcdefghijklmnopqrst' },
    { ...environment.database, branchId: 'validation-child-456' },
  ]) {
    assert.throws(() => createSupabaseWebhookObserver({
      expectedEnvironment: { ...environment, database: databaseIdentity },
      password, clientFactory: database.factory,
    }), { code: 'supabase_webhook_observer_input_invalid' });
  }
  assert.equal(database.clients.length, 0);
});

test('refuses accessor-backed environment fields instead of validating one target and connecting to another', {
  skip: typeof createSupabaseWebhookObserver !== 'function',
}, () => {
  const database = makeClientFactory();
  let projectRefReads = 0;
  const databaseIdentity = { branchId: environment.database.branchId };
  Object.defineProperty(databaseIdentity, 'projectRef', {
    enumerable: true,
    get() {
      projectRefReads += 1;
      return projectRefReads < 4 ? environment.database.projectRef : 'abcdefghijklmnopqrst';
    },
  });

  assert.throws(() => createSupabaseWebhookObserver({
    expectedEnvironment: { ...environment, database: databaseIdentity },
    password,
    clientFactory: database.factory,
  }), { code: 'supabase_webhook_observer_input_invalid' });
  assert.equal(database.clients.length, 0);
});

test('audits application schemas, column-level writes, exact evidence columns, and sequences', {
  skip: typeof createSupabaseWebhookObserver !== 'function',
}, async () => {
  const database = makeClientFactory();
  const reader = createSupabaseWebhookObserver({ expectedEnvironment: environment, password,
    clientFactory: database.factory });

  await reader.readIdentity();
  const query = identityQuery(database.clients[0]);
  assert.match(query, /nspname\s*!~\s*'\^pg_'/u);
  assert.match(query, /nspname\s*<>\s*'information_schema'/u);
  assert.match(query, /(?:pg_catalog\.)?has_schema_privilege\([^)]*'USAGE'\)/u);
  assert.match(query, /(?:pg_catalog\.)?has_database_privilege[\s\S]*?'TEMP'/u);
  assert.match(query, /(?:pg_catalog\.)?has_any_column_privilege\([^)]*'INSERT'\)/u);
  assert.match(query, /(?:pg_catalog\.)?has_any_column_privilege\([^)]*'UPDATE'\)/u);
  assert.match(query, /(?:pg_catalog\.)?has_any_column_privilege\([^)]*'REFERENCES'\)/u);
  assert.match(query, /(?:pg_catalog\.)?has_function_privilege\(current_user, routines\.oid, 'EXECUTE'\)/u);
  assert.match(query, /all_non_system_routine_executes_denied/u);
  assert.match(query, /pg_largeobject_metadata/u);
  assert.match(query, /has_largeobject_privilege\(current_user, objects\.oid, 'UPDATE'\)/u);
  assert.match(query, /all_large_object_write_capabilities_denied/u);
  assert.match(query, /large_object_routines\.proname IN\s*\('lo_creat', 'lo_create', 'lo_from_bytea', 'lo_put', 'lo_truncate', 'lo_truncate64', 'lowrite', 'lo_unlink', 'lo_import', 'lo_import_with_oid', 'lo_export'\)/u);
  assert.match(query, /current_setting\('server_version_num'\)::integer\s*>=\s*170000/u);
  assert.match(query, /has_table_privilege\(current_user, maintainable_relations\.oid, 'MAINTAIN'\)/u);
  assert.match(query, /all_relation_maintain_denied/u);
  assert.match(query, /(?:pg_catalog\.)?has_sequence_privilege\([^)]*'USAGE'\)/u);
  assert.match(query, /(?:pg_catalog\.)?has_sequence_privilege\([^)]*'SELECT'\)/u);
  assert.match(query, /(?:pg_catalog\.)?has_sequence_privilege\([^)]*'UPDATE'\)/u);
  assert.match(query, /public\.webhook_events/u);
  assert.match(query, /public\.billing_webhook_deliveries/u);
  assert.match(query, /unapproved_relation_reads_denied/u);
  assert.match(query, /evidence_relation_select_denied/u);
  assert.match(query, /pg_catalog\.pg_policy/u);
  assert.match(query, /polroles/u);
  assert.match(query, /polcmd\s+IN\s+\('r', '\*'\)/u);
  assert.match(query, /polpermissive/u);
  assert.match(query, /pg_catalog\.pg_get_expr/u);
  assert.match(query, /relrowsecurity/u);
  assert.match(query, /roles\.oid\s*=\s*ANY\(policies\.polroles\)/u);
  assert.match(query, /evidence_rls_visibility_granted/u);
  assert.match(query, /other_evidence_columns_denied/u);
});

test('rejects effective privileges outside the exact read-only evidence scope', {
  skip: typeof createSupabaseWebhookObserver !== 'function',
}, async () => {
  const invalidIdentities = [
    { ...allowedIdentity, database_temp_denied: false },
    { ...allowedIdentity, non_system_schema_create_denied: false },
    { ...allowedIdentity, allowed_schema_usage: false },
    { ...allowedIdentity, all_relation_writes_denied: false },
    { ...allowedIdentity, all_non_system_routine_executes_denied: false },
    { ...allowedIdentity, all_large_object_write_capabilities_denied: false },
    { ...allowedIdentity, all_relation_maintain_denied: false },
    { ...allowedIdentity, unapproved_relation_reads_denied: false },
    { ...allowedIdentity, evidence_relation_select_denied: false },
    { ...allowedIdentity, evidence_rls_visibility_granted: false },
    { ...allowedIdentity, other_evidence_columns_denied: false },
    { ...allowedIdentity, all_sequence_privileges_denied: false },
  ];

  for (const identity of invalidIdentities) {
    const database = makeClientFactory({ identity });
    const reader = createSupabaseWebhookObserver({ expectedEnvironment: environment, password,
      clientFactory: database.factory });

    await assert.rejects(reader.readRejectedWebhookPersistence({ eventId }), {
      code: 'supabase_webhook_observer_identity_invalid',
    });
    assert.equal(database.clients[0].calls.some((call) =>
      call.text === SQL.webhookEvents || call.text === SQL.webhookDeliveries), false);
    assert.equal(database.clients[0].ended, true);
  }
});

test('bounds PostgreSQL operations and force-closes a connection that cannot shut down', {
  skip: typeof createSupabaseWebhookObserver !== 'function',
}, async () => {
  const database = makeClientFactory({ hangEnd: true });
  const reader = createSupabaseWebhookObserver({ expectedEnvironment: environment, password,
    clientFactory: database.factory });
  const startedAt = Date.now();
  let guard;
  const guardPromise = new Promise((resolve, reject) => {
    guard = setTimeout(() => reject(Object.assign(new Error('reader did not bound shutdown'), {
      code: 'test_reader_shutdown_unbounded',
    })), 3_500);
  });
  try {
    await assert.rejects(Promise.race([reader.readIdentity(), guardPromise]), {
      code: 'supabase_webhook_observer_timeout',
    });
  } finally {
    clearTimeout(guard);
  }

  assert.ok(Date.now() - startedAt < 4_000);
  assert.equal(database.clients[0].destroyCalls, 1);
  assert.ok(database.configs[0].connectionTimeoutMillis > 0);
  assert.ok(database.configs[0].query_timeout > 0);
  assert.ok(database.configs[0].statement_timeout > 0);
  assert.ok(database.configs[0].idle_in_transaction_session_timeout > 0);
});

test('bounds a stalled query and rolls back/closes without leaking the underlying error', {
  skip: typeof createSupabaseWebhookObserver !== 'function',
}, async () => {
  const database = makeClientFactory({ hangIdentity: true });
  const reader = createSupabaseWebhookObserver({ expectedEnvironment: environment, password,
    clientFactory: database.factory });
  const startedAt = Date.now();

  await assert.rejects(reader.readIdentity(), { code: 'supabase_webhook_observer_timeout' });

  assert.ok(Date.now() - startedAt < 7_000);
  assert.equal(database.clients[0].destroyCalls, 1);
  assert.ok(database.clients[0].calls.some((call) => call.text === 'ROLLBACK'));
  assert.equal(database.clients[0].ended, true);
});
