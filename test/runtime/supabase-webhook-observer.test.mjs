import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSupabaseWebhookObserver as createProductionObserver } from '../../src/runtime/supabase-webhook-observer.mjs';

const projectRef = 'synthetictestproject';
const password = 'synthetic-only-password-not-a-credential';
const sensitiveProviderText = 'synthetic-provider-secret-payload';
const eventId = 'evt_synthetic_webhook_001';
const readerRole = 'lawx_billing_validation_reader';
const readerId = 'lawx-billing-validation-webhook-reader-v1';
const identityQueryPrefix = "SELECT current_setting('transaction_read_only')";
const webhookEventsSql = 'SELECT event_id FROM public.webhook_events WHERE event_id = $1 ORDER BY event_id LIMIT 10001';
const webhookDeliveriesSql = 'SELECT id, event_id FROM public.billing_webhook_deliveries WHERE event_id = $1 ORDER BY id, event_id LIMIT 10001';

const environment = Object.freeze({
  database: Object.freeze({ projectRef }),
  deployment: Object.freeze({ id: 'dpl_candidate123', origin: 'https://lawx-abc123def-team.vercel.app' }),
  stripe: Object.freeze({ accountId: 'acct_synthetic123' }),
});

const validIdentity = Object.freeze({
  transaction_read_only: 'on',
  role_name: readerRole,
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

let temporaryRoot;
let createConfiguredObserver;

before(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'supabase-webhook-observer-'));
  const sourceDirectory = fileURLToPath(new URL('../../src/', import.meta.url));
  const policySource = fileURLToPath(new URL('../../policy/environment-policy.json', import.meta.url));
  const temporarySource = join(temporaryRoot, 'src');
  const temporaryPolicy = join(temporaryRoot, 'policy', 'environment-policy.json');

  await cp(sourceDirectory, temporarySource, { recursive: true });
  await mkdir(dirname(temporaryPolicy), { recursive: true });
  await cp(policySource, temporaryPolicy);
  const policy = JSON.parse(await readFile(temporaryPolicy, 'utf8'));
  assert.equal(policy.database.kind, 'standalone');
  policy.database.projectRef = projectRef;
  await writeFile(temporaryPolicy, `${JSON.stringify(policy, null, 2)}\n`);

  const isolatedModule = await import(pathToFileURL(join(temporarySource,
    'runtime/supabase-webhook-observer.mjs')).href);
  createConfiguredObserver = isolatedModule.createSupabaseWebhookObserver;
});

after(async () => {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
});

function makeClientFactory({
  identity = validIdentity,
  identityResult,
  events = [{ event_id: eventId }],
  deliveries = [{ id: 'receipt-002', event_id: eventId }, { id: 'receipt-001', event_id: eventId }],
  failAt,
  hangAt,
  failFactory = false,
} = {}) {
  const clients = [];
  const configs = [];
  let factoryCalls = 0;
  const factory = (config) => {
    factoryCalls += 1;
    if (failFactory) throw new Error(`provider failure ${password} ${sensitiveProviderText}`);
    configs.push(config);
    const calls = [];
    const client = {
      calls,
      ended: false,
      destroyCalls: 0,
      connection: { stream: { destroy() { client.destroyCalls += 1; } } },
      async connect() {
        calls.push({ kind: 'connect' });
        if (failAt === 'connect') throw new Error(`connect failure ${password} ${sensitiveProviderText}`);
        if (hangAt === 'connect') return new Promise(() => {});
      },
      async query(text, values) {
        calls.push({ kind: 'query', text, values });
        const isIdentityQuery = text.startsWith(identityQueryPrefix);
        if (failAt === 'identity' && isIdentityQuery) {
          throw new Error(`query failure ${password} ${sensitiveProviderText}`);
        }
        if (hangAt === 'identity' && isIdentityQuery) return new Promise(() => {});
        if (text === 'BEGIN READ ONLY' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
        if (isIdentityQuery) return identityResult === undefined ? { rows: [identity] } : identityResult;
        if (text === webhookEventsSql) return { rows: events };
        if (text === webhookDeliveriesSql) return { rows: deliveries };
        throw new Error('unexpected SQL reached the fake client');
      },
      async end() {
        calls.push({ kind: 'end' });
        if (failAt === 'end') throw new Error(`shutdown failure ${password} ${sensitiveProviderText}`);
        if (hangAt === 'end') return new Promise(() => {});
        client.ended = true;
      },
    };
    clients.push(client);
    return client;
  };
  return { factory, clients, configs, get factoryCalls() { return factoryCalls; } };
}

function createObserver(database, expectedEnvironment = environment) {
  return createConfiguredObserver({ expectedEnvironment, password, clientFactory: database.factory });
}

function sha256(value) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function normalizedQueries(client) {
  return client.calls.filter((call) => call.kind === 'query').map(({ text, values }) => ({
    text: text.startsWith(identityQueryPrefix) ? 'IDENTITY' : text,
    values,
  }));
}

test('exports the standalone observer and keeps the unconfigured repository target fail-closed', async () => {
  assert.equal(typeof createProductionObserver, 'function');
  const policy = JSON.parse(await readFile(new URL('../../policy/environment-policy.json', import.meta.url), 'utf8'));
  assert.equal(policy.database.kind, 'standalone');
  for (const key of ['projectRef', 'databaseVersion', 'connection', 'schemaFingerprintSha256', 'migrationHistorySha256']) {
    assert.equal(policy.database[key], null);
  }

  const counter = { calls: 0 };
  assert.throws(() => createProductionObserver({ expectedEnvironment: environment, password,
    clientFactory() { counter.calls += 1; throw new Error('real target must remain uncontacted'); } }),
  { code: 'supabase_webhook_observer_input_invalid' });
  assert.equal(counter.calls, 0);
});

test('pins the synthetic target, TLS, reader role, timeouts, and read-only identity', async () => {
  const database = makeClientFactory();
  const observer = createObserver(database);
  assert.deepEqual(Object.keys(observer).sort(), ['close', 'readIdentity', 'readRejectedWebhookPersistence']);

  const identity = await observer.readIdentity();

  assert.deepEqual(database.configs[0], {
    host: `db.${projectRef}.supabase.co`,
    port: 5432,
    database: 'postgres',
    user: readerRole,
    password,
    ssl: { rejectUnauthorized: true, servername: `db.${projectRef}.supabase.co` },
    connectionTimeoutMillis: 8_000,
    query_timeout: 6_000,
    statement_timeout: 4_000,
    idle_in_transaction_session_timeout: 10_000,
    options: '-c search_path=pg_catalog',
    keepAlive: false,
  });
  assert.deepEqual(identity, { projectRef, readerId, readOnly: true });
  assert.deepEqual(normalizedQueries(database.clients[0]), [
    { text: 'BEGIN READ ONLY', values: undefined },
    { text: 'IDENTITY', values: undefined },
    { text: 'COMMIT', values: undefined },
  ]);

  const identitySql = database.clients[0].calls.find((call) => call.kind === 'query' &&
    call.text.startsWith(identityQueryPrefix)).text;
  for (const fragment of [
    "current_setting('transaction_read_only') AS transaction_read_only",
    'current_user AS role_name',
    "has_any_column_privilege(current_user, relations.oid, 'UPDATE')",
    "has_function_privilege(current_user, routines.oid, 'EXECUTE')",
    'pg_catalog.pg_policy',
    'evidence_rls_visibility_granted',
    'all_sequence_privileges_denied',
  ]) assert.ok(identitySql.includes(fragment), `identity query must audit ${fragment}`);
  assert.equal(database.clients[0].ended, true);
  await observer.close();
});

test('rejects mismatched, branch-shaped, and parent-project identities before creating a client', () => {
  const database = makeClientFactory();
  for (const candidate of [
    { ...environment, database: { projectRef: 'abcdefghijklmnopqrst' } },
    { ...environment, database: { projectRef, branchId: 'synthetic-branch' } },
    { ...environment, database: { projectRef, parentProjectRef: 'abcdefghijklmnopqrst' } },
  ]) {
    assert.throws(() => createObserver(database, candidate), { code: 'supabase_webhook_observer_input_invalid' });
  }
  assert.equal(database.factoryCalls, 0);
});

test('queries rejected webhook records with fixed parameterized SELECTs and returns sorted hashed identities', async () => {
  const database = makeClientFactory({
    events: [{ event_id: eventId }, { event_id: eventId }],
    deliveries: [{ id: 'receipt-002', event_id: eventId }, { id: 'receipt-001', event_id: eventId }],
  });
  const observer = createObserver(database);

  const observation = await observer.readRejectedWebhookPersistence({ eventId });

  assert.deepEqual(normalizedQueries(database.clients[0]), [
    { text: 'BEGIN READ ONLY', values: undefined },
    { text: 'IDENTITY', values: undefined },
    { text: webhookEventsSql, values: [eventId] },
    { text: webhookDeliveriesSql, values: [eventId] },
    { text: 'COMMIT', values: undefined },
  ]);
  assert.deepEqual(observation, {
    projectRef,
    readerId,
    readOnly: true,
    webhookEvents: { count: 2, identitySha256: sha256([eventId, eventId]) },
    webhookDeliveries: { count: 2, identitySha256: sha256([
      ['receipt-001', eventId], ['receipt-002', eventId],
    ]) },
  });
  assert.equal(JSON.stringify(observation).includes(eventId), false);
  assert.equal(JSON.stringify(observation).includes(password), false);
  assert.equal(database.clients[0].ended, true);
  await observer.close();
});

test('rejects malformed event inputs without querying or constructing a client', async () => {
  const database = makeClientFactory();
  const observer = createObserver(database);
  for (const input of [
    { eventId: '' },
    { eventId: 'evt_' },
    { eventId: `evt_${'x'.repeat(121)}` },
    { eventId: 'evt_safe;DROP_TABLE' },
    { eventId, sql: 'SELECT 1' },
    Object.create({ eventId }),
  ]) {
    await assert.rejects(observer.readRejectedWebhookPersistence(input), {
      code: 'supabase_webhook_observer_input_invalid',
    });
  }

  let getterCalls = 0;
  const accessorInput = Object.defineProperty({}, 'eventId', {
    enumerable: true,
    get() { getterCalls += 1; return eventId; },
  });
  await assert.rejects(observer.readRejectedWebhookPersistence(accessorInput), {
    code: 'supabase_webhook_observer_input_invalid',
  });
  assert.equal(getterCalls, 0);
  assert.equal(database.factoryCalls, 0);
  await observer.close();
});

test('rolls back and refuses every missing read-only identity or privilege invariant', async () => {
  const invalidFields = [
    ['transaction_read_only', 'off'],
    ['role_name', 'service_role'],
    ['is_superuser', true],
    ['bypass_rls', true],
    ['can_create_database', true],
    ['can_create_role', true],
    ['replication', true],
    ['no_role_memberships', false],
    ['database_create_denied', false],
    ['database_temp_denied', false],
    ['non_system_schema_create_denied', false],
    ['allowed_schema_usage', false],
    ['all_relation_writes_denied', false],
    ['all_non_system_routine_executes_denied', false],
    ['all_large_object_write_capabilities_denied', false],
    ['all_relation_maintain_denied', false],
    ['unapproved_relation_reads_denied', false],
    ['evidence_relation_select_denied', false],
    ['evidence_rls_visibility_granted', false],
    ['evidence_columns_granted', false],
    ['other_evidence_columns_denied', false],
    ['all_sequence_privileges_denied', false],
  ];

  for (const [field, invalidValue] of invalidFields) {
    const database = makeClientFactory({ identity: { ...validIdentity, [field]: invalidValue } });
    const observer = createObserver(database);
    await assert.rejects(observer.readRejectedWebhookPersistence({ eventId }), {
      code: 'supabase_webhook_observer_identity_invalid',
    });
    assert.deepEqual(normalizedQueries(database.clients[0]), [
      { text: 'BEGIN READ ONLY', values: undefined },
      { text: 'IDENTITY', values: undefined },
      { text: 'ROLLBACK', values: undefined },
    ], `invalid ${field} must stop before evidence reads`);
    assert.equal(database.clients[0].ended, true);
    await observer.close();
  }
});

test('rejects malformed identity and webhook rows and closes each read-only transaction', async () => {
  const cases = [
    { identityResult: { rows: [] }, code: 'supabase_webhook_observer_response_invalid', noEvidenceReads: true },
    { events: [{ event_id: 'evt_another_event' }], code: 'supabase_webhook_observer_response_invalid' },
    { events: [{ event_id: eventId, payload: sensitiveProviderText }], code: 'supabase_webhook_observer_response_invalid' },
    { deliveries: [{ id: 'receipt;drop', event_id: eventId }], code: 'supabase_webhook_observer_response_invalid' },
    { deliveries: [{ id: 'receipt-001', event_id: 'evt_another_event' }], code: 'supabase_webhook_observer_response_invalid' },
    { events: Array.from({ length: 10_001 }, () => ({ event_id: eventId })),
      code: 'supabase_webhook_observer_response_invalid' },
  ];

  for (const scenario of cases) {
    const database = makeClientFactory(scenario);
    const observer = createObserver(database);
    await assert.rejects(observer.readRejectedWebhookPersistence({ eventId }), { code: scenario.code });
    const queries = normalizedQueries(database.clients[0]);
    assert.equal(queries.some(({ text }) => text === 'ROLLBACK'), true);
    assert.equal(queries.some(({ text }) => text === 'COMMIT'), false);
    if (scenario.noEvidenceReads) {
      assert.equal(queries.some(({ text }) => text === webhookEventsSql || text === webhookDeliveriesSql), false);
    }
    assert.equal(database.clients[0].ended, true);
    await observer.close();
  }
});

test('maps client and provider failures to fixed refusal codes without leaking error text', async () => {
  const factoryFailure = makeClientFactory({ failFactory: true });
  const factoryFailureObserver = createObserver(factoryFailure);
  await assert.rejects(factoryFailureObserver.readIdentity(), (error) => {
    assert.equal(error.code, 'supabase_webhook_observer_unavailable');
    assert.equal(error.message, error.code);
    assert.equal(error.message.includes(password), false);
    assert.equal(error.message.includes(sensitiveProviderText), false);
    return true;
  });
  assert.equal(factoryFailure.factoryCalls, 1);

  const queryFailure = makeClientFactory({ failAt: 'identity' });
  const queryFailureObserver = createObserver(queryFailure);
  await assert.rejects(queryFailureObserver.readRejectedWebhookPersistence({ eventId }), (error) => {
    assert.equal(error.code, 'supabase_webhook_observer_unavailable');
    assert.equal(error.message, error.code);
    assert.equal(JSON.stringify(error).includes(password), false);
    assert.equal(JSON.stringify(error).includes(sensitiveProviderText), false);
    return true;
  });
  assert.deepEqual(normalizedQueries(queryFailure.clients[0]), [
    { text: 'BEGIN READ ONLY', values: undefined },
    { text: 'IDENTITY', values: undefined },
    { text: 'ROLLBACK', values: undefined },
  ]);
  assert.equal(queryFailure.clients[0].ended, true);
  await factoryFailureObserver.close();
  await queryFailureObserver.close();
});

test('bounds a stalled identity query, destroys the connection, rolls back, and closes it', async () => {
  const database = makeClientFactory({ hangAt: 'identity' });
  const observer = createObserver(database);

  await assert.rejects(observer.readIdentity(), { code: 'supabase_webhook_observer_timeout' });

  assert.equal(database.clients[0].destroyCalls, 1);
  assert.deepEqual(normalizedQueries(database.clients[0]), [
    { text: 'BEGIN READ ONLY', values: undefined },
    { text: 'IDENTITY', values: undefined },
    { text: 'ROLLBACK', values: undefined },
  ]);
  assert.equal(database.clients[0].ended, true);
  await observer.close();
});

test('uses a fresh client per observation and close blocks future connections', async () => {
  const database = makeClientFactory();
  const observer = createObserver(database);
  await observer.readIdentity();
  await observer.readRejectedWebhookPersistence({ eventId });
  assert.equal(database.clients.length, 2);
  assert.ok(database.clients.every((client) => client.ended));

  await observer.close();
  await assert.rejects(observer.readIdentity(), { code: 'supabase_webhook_observer_closed' });
  assert.equal(database.factoryCalls, 2);
});
