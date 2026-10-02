import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { isValidExpectedEnvironment } from '../contracts/evidence.mjs';

const require = createRequire(import.meta.url);
const CONTROL_POLICY = require('../../policy/environment-policy.json');
const ROLE = 'lawx_billing_validation_reader';
const READER_ID = 'lawx-billing-validation-webhook-reader-v1';
const EVENT_ID = /^evt_[A-Za-z0-9_]{1,120}$/u;
const ROW_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_ROWS = 10_000;
const CONNECT_TIMEOUT_MS = 8_000;
const OPERATION_TIMEOUT_MS = 5_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;
const STATEMENT_TIMEOUT_MS = 4_000;
const QUERY_TIMEOUT_MS = 6_000;
const IDLE_TRANSACTION_TIMEOUT_MS = 10_000;

const BEGIN_READ_ONLY = 'BEGIN READ ONLY';
const COMMIT = 'COMMIT';
const ROLLBACK = 'ROLLBACK';
const IDENTITY_SQL = `SELECT current_setting('transaction_read_only') AS transaction_read_only,
  current_user AS role_name,
  roles.rolsuper AS is_superuser,
  roles.rolbypassrls AS bypass_rls,
  roles.rolcreatedb AS can_create_database,
  roles.rolcreaterole AS can_create_role,
  roles.rolreplication AS replication,
  NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members AS memberships
    WHERE memberships.member = roles.oid
  ) AS no_role_memberships,
  NOT pg_catalog.has_database_privilege(current_user, current_database(), 'CREATE')
    AS database_create_denied,
  NOT pg_catalog.has_database_privilege(current_user, current_database(), 'TEMP')
    AS database_temp_denied,
  NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace AS schemas
    WHERE schemas.nspname !~ '^pg_' AND schemas.nspname <> 'information_schema'
      AND pg_catalog.has_schema_privilege(current_user, schemas.oid, 'CREATE')
  ) AS non_system_schema_create_denied,
  pg_catalog.has_schema_privilege(current_user, 'public', 'USAGE')
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_namespace AS schemas
      WHERE schemas.nspname !~ '^pg_' AND schemas.nspname <> 'information_schema'
        AND schemas.nspname <> 'public'
        AND pg_catalog.has_schema_privilege(current_user, schemas.oid, 'USAGE')
    ) AS allowed_schema_usage,
  NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relations
    JOIN pg_catalog.pg_namespace AS schemas ON schemas.oid = relations.relnamespace
    WHERE schemas.nspname !~ '^pg_' AND schemas.nspname <> 'information_schema'
      AND relations.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND (
        pg_catalog.has_table_privilege(current_user, relations.oid, 'INSERT')
        OR pg_catalog.has_table_privilege(current_user, relations.oid, 'UPDATE')
        OR pg_catalog.has_table_privilege(current_user, relations.oid, 'DELETE')
        OR pg_catalog.has_table_privilege(current_user, relations.oid, 'TRUNCATE')
        OR pg_catalog.has_table_privilege(current_user, relations.oid, 'REFERENCES')
        OR pg_catalog.has_table_privilege(current_user, relations.oid, 'TRIGGER')
        OR pg_catalog.has_any_column_privilege(current_user, relations.oid, 'INSERT')
        OR pg_catalog.has_any_column_privilege(current_user, relations.oid, 'UPDATE')
        OR pg_catalog.has_any_column_privilege(current_user, relations.oid, 'REFERENCES')
      )
  ) AS all_relation_writes_denied,
  NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS routines
    JOIN pg_catalog.pg_namespace AS routine_schemas
      ON routine_schemas.oid = routines.pronamespace
    WHERE routine_schemas.nspname !~ '^pg_' AND routine_schemas.nspname <> 'information_schema'
      AND pg_catalog.has_function_privilege(current_user, routines.oid, 'EXECUTE')
  ) AS all_non_system_routine_executes_denied,
  NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_largeobject_metadata AS objects
    WHERE pg_catalog.has_largeobject_privilege(current_user, objects.oid, 'UPDATE')
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS large_object_routines
    JOIN pg_catalog.pg_namespace AS routine_schemas
      ON routine_schemas.oid = large_object_routines.pronamespace
    WHERE routine_schemas.nspname = 'pg_catalog'
      AND large_object_routines.proname IN
        ('lo_creat', 'lo_create', 'lo_from_bytea', 'lo_put', 'lo_truncate', 'lo_truncate64', 'lowrite', 'lo_unlink', 'lo_import', 'lo_import_with_oid', 'lo_export')
      AND pg_catalog.has_function_privilege(current_user, large_object_routines.oid, 'EXECUTE')
  ) AS all_large_object_write_capabilities_denied,
  CASE
    WHEN pg_catalog.current_setting('server_version_num')::integer >= 170000 THEN NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS maintainable_relations
      JOIN pg_catalog.pg_namespace AS schemas ON schemas.oid = maintainable_relations.relnamespace
      WHERE schemas.nspname !~ '^pg_' AND schemas.nspname <> 'information_schema'
        AND maintainable_relations.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND pg_catalog.has_table_privilege(current_user, maintainable_relations.oid, 'MAINTAIN')
    )
    ELSE true
  END AS all_relation_maintain_denied,
  NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relations
    JOIN pg_catalog.pg_namespace AS schemas ON schemas.oid = relations.relnamespace
    WHERE schemas.nspname !~ '^pg_' AND schemas.nspname <> 'information_schema'
      AND relations.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND NOT (schemas.nspname = 'public' AND relations.relname IN
        ('webhook_events', 'billing_webhook_deliveries'))
      AND (
        pg_catalog.has_table_privilege(current_user, relations.oid, 'SELECT')
        OR pg_catalog.has_any_column_privilege(current_user, relations.oid, 'SELECT')
      )
  ) AS unapproved_relation_reads_denied,
  NOT pg_catalog.has_table_privilege(current_user, 'public.webhook_events', 'SELECT')
    AND NOT pg_catalog.has_table_privilege(current_user, 'public.billing_webhook_deliveries', 'SELECT')
    AS evidence_relation_select_denied,
  pg_catalog.has_column_privilege(current_user, 'public.webhook_events', 'event_id', 'SELECT')
    AND pg_catalog.has_column_privilege(current_user, 'public.billing_webhook_deliveries', 'id', 'SELECT')
    AND pg_catalog.has_column_privilege(current_user, 'public.billing_webhook_deliveries', 'event_id', 'SELECT')
    AS evidence_columns_granted,
  NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute AS attributes
    WHERE attributes.attnum > 0 AND NOT attributes.attisdropped
      AND (
        (attributes.attrelid = 'public.webhook_events'::regclass AND attributes.attname <> 'event_id')
        OR (attributes.attrelid = 'public.billing_webhook_deliveries'::regclass
          AND attributes.attname NOT IN ('id', 'event_id'))
      )
      AND pg_catalog.has_column_privilege(current_user, attributes.attrelid, attributes.attnum, 'SELECT')
  ) AS other_evidence_columns_denied,
  NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS evidence_relations
    JOIN pg_catalog.pg_namespace AS evidence_schemas
      ON evidence_schemas.oid = evidence_relations.relnamespace
    WHERE evidence_schemas.nspname = 'public'
      AND evidence_relations.relname IN ('webhook_events', 'billing_webhook_deliveries')
      AND evidence_relations.relrowsecurity
      AND (
        NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_policy AS policies
          WHERE policies.polrelid = evidence_relations.oid
            AND policies.polcmd IN ('r', '*')
            AND policies.polpermissive
            AND (0 = ANY(policies.polroles) OR roles.oid = ANY(policies.polroles))
            AND coalesce(pg_catalog.pg_get_expr(policies.polqual, policies.polrelid), 'true') = 'true'
        )
        OR EXISTS (
          SELECT 1
          FROM pg_catalog.pg_policy AS policies
          WHERE policies.polrelid = evidence_relations.oid
            AND policies.polcmd IN ('r', '*')
            AND NOT policies.polpermissive
            AND (0 = ANY(policies.polroles) OR roles.oid = ANY(policies.polroles))
            AND coalesce(pg_catalog.pg_get_expr(policies.polqual, policies.polrelid), 'true') <> 'true'
        )
      )
  ) AS evidence_rls_visibility_granted,
  NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS sequences
    JOIN pg_catalog.pg_namespace AS schemas ON schemas.oid = sequences.relnamespace
    WHERE schemas.nspname !~ '^pg_' AND schemas.nspname <> 'information_schema'
      AND sequences.relkind = 'S'
      AND (
        pg_catalog.has_sequence_privilege(current_user, sequences.oid, 'USAGE')
        OR pg_catalog.has_sequence_privilege(current_user, sequences.oid, 'SELECT')
        OR pg_catalog.has_sequence_privilege(current_user, sequences.oid, 'UPDATE')
      )
  ) AS all_sequence_privileges_denied
FROM pg_catalog.pg_roles AS roles
WHERE roles.rolname = current_user`;
const WEBHOOK_EVENTS_SQL = 'SELECT event_id FROM public.webhook_events WHERE event_id = $1 ORDER BY event_id LIMIT 10001';
const WEBHOOK_DELIVERIES_SQL = 'SELECT id, event_id FROM public.billing_webhook_deliveries WHERE event_id = $1 ORDER BY id, event_id LIMIT 10001';
const IDENTITY_KEYS = Object.freeze([
  'transaction_read_only', 'role_name', 'is_superuser', 'bypass_rls', 'can_create_database',
  'can_create_role', 'replication', 'no_role_memberships', 'database_create_denied', 'database_temp_denied',
  'non_system_schema_create_denied', 'allowed_schema_usage', 'all_relation_writes_denied',
  'all_non_system_routine_executes_denied', 'all_large_object_write_capabilities_denied',
  'all_relation_maintain_denied',
  'unapproved_relation_reads_denied', 'evidence_relation_select_denied', 'evidence_rls_visibility_granted',
  'evidence_columns_granted', 'other_evidence_columns_denied', 'all_sequence_privileges_denied',
]);

class ObserverRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = 'SupabaseWebhookObserverRefusal';
    this.code = code;
  }
}

function refuse(code) {
  throw new ObserverRefusal(code);
}

function snapshotExactDataRecord(value, keys) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length ||
        !ownKeys.every((key) => typeof key === 'string' && keys.includes(key))) return null;
    const snapshot = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) return null;
      Object.defineProperty(snapshot, key, { value: descriptor.value, enumerable: true });
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function snapshotExpectedEnvironment(value) {
  const top = snapshotExactDataRecord(value, ['database', 'deployment', 'stripe']);
  if (!top) return null;
  const database = snapshotExactDataRecord(top.database, ['projectRef']);
  const deployment = snapshotExactDataRecord(top.deployment, ['id', 'origin']);
  const stripe = snapshotExactDataRecord(top.stripe, ['accountId']);
  if (!database || !deployment || !stripe) return null;
  return Object.freeze({ database, deployment, stripe });
}

function forceDisconnect(client) {
  try { client?.connection?.stream?.destroy?.(); } catch { /* Timeout remains a fixed refusal. */ }
}

async function boundedOperation(operation, timeoutMs, client) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      forceDisconnect(client);
      reject(new ObserverRefusal('supabase_webhook_observer_timeout'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function exactDataRecord(value, keys) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const ownKeys = Reflect.ownKeys(value);
    return ownKeys.length === keys.length && ownKeys.every((key) => typeof key === 'string' && keys.includes(key)) &&
      keys.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true;
      });
  } catch {
    return false;
  }
}

function validateIdentityResult(result) {
  if (!result || !Array.isArray(result.rows) || result.rows.length !== 1 ||
      !exactDataRecord(result.rows[0], IDENTITY_KEYS)) {
    refuse('supabase_webhook_observer_response_invalid');
  }
  const identity = result.rows[0];
  if (identity.transaction_read_only !== 'on' || identity.role_name !== ROLE ||
      identity.is_superuser !== false || identity.bypass_rls !== false ||
      identity.can_create_database !== false || identity.can_create_role !== false ||
      identity.replication !== false || identity.no_role_memberships !== true ||
      identity.database_create_denied !== true || identity.database_temp_denied !== true ||
      identity.non_system_schema_create_denied !== true || identity.allowed_schema_usage !== true ||
      identity.all_relation_writes_denied !== true || identity.all_non_system_routine_executes_denied !== true ||
      identity.all_large_object_write_capabilities_denied !== true || identity.all_relation_maintain_denied !== true ||
      identity.unapproved_relation_reads_denied !== true ||
      identity.evidence_relation_select_denied !== true || identity.evidence_rls_visibility_granted !== true ||
      identity.evidence_columns_granted !== true || identity.other_evidence_columns_denied !== true ||
      identity.all_sequence_privileges_denied !== true) {
    refuse('supabase_webhook_observer_identity_invalid');
  }
}

function validateRows(result, columns) {
  if (!result || !Array.isArray(result.rows) || result.rows.length > MAX_ROWS) {
    refuse('supabase_webhook_observer_response_invalid');
  }
  for (const row of result.rows) {
    if (!exactDataRecord(row, columns)) refuse('supabase_webhook_observer_response_invalid');
  }
  return result.rows;
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function safeEventIdentities(result, eventId) {
  const rows = validateRows(result, ['event_id']);
  const identities = rows.map(({ event_id: actual }) => {
    if (actual !== eventId) refuse('supabase_webhook_observer_response_invalid');
    return actual;
  }).sort(compare);
  return Object.freeze({ count: identities.length, identitySha256: digest(identities) });
}

function safeDeliveryIdentities(result, eventId) {
  const rows = validateRows(result, ['id', 'event_id']);
  const identities = rows.map(({ id, event_id: actual }) => {
    if (typeof id !== 'string' || !ROW_ID.test(id) || actual !== eventId) {
      refuse('supabase_webhook_observer_response_invalid');
    }
    return [id, actual];
  }).sort(([leftId, leftEvent], [rightId, rightEvent]) => compare(leftId, rightId) || compare(leftEvent, rightEvent));
  return Object.freeze({ count: identities.length, identitySha256: digest(identities) });
}

async function defaultClientFactory(config) {
  let pg;
  try {
    pg = await import('pg');
  } catch {
    refuse('supabase_webhook_observer_unavailable');
  }
  const Client = pg.Client ?? pg.default?.Client;
  if (typeof Client !== 'function') refuse('supabase_webhook_observer_unavailable');
  return new Client(config);
}

export function createSupabaseWebhookObserver({ expectedEnvironment, password, clientFactory = defaultClientFactory } = {}) {
  const environment = snapshotExpectedEnvironment(expectedEnvironment);
  let validEnvironment = false;
  try { validEnvironment = environment !== null && isValidExpectedEnvironment(environment); } catch { /* Invalid bindings fail closed. */ }
  const pinnedProjectRef = CONTROL_POLICY.database?.projectRef;
  if (!validEnvironment || !pinnedProjectRef || environment.database.projectRef !== pinnedProjectRef ||
      typeof password !== 'string' ||
      password.length === 0 || password.length > 4096 || /[\0\r\n]/u.test(password) ||
      typeof clientFactory !== 'function') {
    refuse('supabase_webhook_observer_input_invalid');
  }

  const projectRef = environment.database.projectRef;
  const host = `db.${projectRef}.supabase.co`;
  const identity = Object.freeze({ projectRef, readerId: READER_ID, readOnly: true });
  const clientConfig = Object.freeze({
    host,
    port: 5432,
    database: 'postgres',
    user: ROLE,
    password,
    ssl: Object.freeze({ rejectUnauthorized: true, servername: host }),
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: IDLE_TRANSACTION_TIMEOUT_MS,
    options: '-c search_path=pg_catalog',
    keepAlive: false,
  });
  let closed = false;
  let closePromise;
  const activeObservations = new Set();

  async function executeObservation(readRows) {
    let client;
    let transactionStarted = false;
    let outcome;
    try {
      client = await clientFactory(clientConfig);
      if (!client || typeof client.connect !== 'function' || typeof client.query !== 'function' ||
          typeof client.end !== 'function') refuse('supabase_webhook_observer_unavailable');
      await boundedOperation(() => client.connect(), CONNECT_TIMEOUT_MS + 1_000, client);
      await boundedOperation(() => client.query(BEGIN_READ_ONLY), OPERATION_TIMEOUT_MS, client);
      transactionStarted = true;
      validateIdentityResult(await boundedOperation(() => client.query(IDENTITY_SQL), OPERATION_TIMEOUT_MS, client));
      const value = await readRows(client);
      await boundedOperation(() => client.query(COMMIT), OPERATION_TIMEOUT_MS, client);
      transactionStarted = false;
      outcome = { ok: true, value };
    } catch (error) {
      outcome = { ok: false, error: error instanceof ObserverRefusal
        ? error : new ObserverRefusal('supabase_webhook_observer_unavailable') };
    } finally {
      if (client) {
        if (transactionStarted) {
          try {
            await boundedOperation(() => client.query(ROLLBACK), OPERATION_TIMEOUT_MS, client);
          } catch { /* Refusal is already fail-closed. */ }
        }
        try {
          await boundedOperation(() => client.end(), SHUTDOWN_TIMEOUT_MS, client);
        } catch (error) {
          if (outcome?.ok) outcome = { ok: false,
            error: error instanceof ObserverRefusal ? error : new ObserverRefusal('supabase_webhook_observer_unavailable') };
        }
      }
    }
    if (!outcome?.ok) throw outcome?.error ?? new ObserverRefusal('supabase_webhook_observer_unavailable');
    return outcome.value;
  }

  function observe(readRows) {
    if (closed) return Promise.reject(new ObserverRefusal('supabase_webhook_observer_closed'));
    const pending = executeObservation(readRows);
    activeObservations.add(pending);
    return pending.finally(() => activeObservations.delete(pending));
  }

  async function readIdentity() {
    return observe(async () => identity);
  }

  async function readRejectedWebhookPersistence(input) {
    if (!exactDataRecord(input, ['eventId'])) {
      refuse('supabase_webhook_observer_input_invalid');
    }
    let eventId;
    try { eventId = Object.getOwnPropertyDescriptor(input, 'eventId').value; } catch {
      refuse('supabase_webhook_observer_input_invalid');
    }
    if (typeof eventId !== 'string' || !EVENT_ID.test(eventId)) refuse('supabase_webhook_observer_input_invalid');
    return observe(async (client) => {
      const eventResult = await boundedOperation(() => client.query(WEBHOOK_EVENTS_SQL, [eventId]),
        OPERATION_TIMEOUT_MS, client);
      const deliveryResult = await boundedOperation(() => client.query(WEBHOOK_DELIVERIES_SQL, [eventId]),
        OPERATION_TIMEOUT_MS, client);
      return Object.freeze({
        ...identity,
        webhookEvents: safeEventIdentities(eventResult, eventId),
        webhookDeliveries: safeDeliveryIdentities(deliveryResult, eventId),
      });
    });
  }

  async function close() {
    if (!closePromise) {
      closed = true;
      closePromise = Promise.allSettled([...activeObservations]).then(() => undefined);
    }
    return closePromise;
  }

  return Object.freeze({ readIdentity, readRejectedWebhookPersistence, close });
}
