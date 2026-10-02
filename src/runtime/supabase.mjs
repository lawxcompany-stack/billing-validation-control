import { createHash } from 'node:crypto';
import { BILLING_43_IDS } from '../contracts/billing-43.mjs';
import { sanitizeDatabaseSnapshot, sanitizeInstalledSchemaState, sanitizeSqlConcurrencyProof } from '../billing/observations.mjs';
import { isActiveFixtureMutationTransaction } from '../attempts/store.mjs';
import { isValidBillingEnvironment, isValidStandaloneDatabasePolicy } from '../billing/contracts.mjs';

const API = 'https://api.supabase.com';
const REF = /^[a-z0-9]{20}$/u;
const VERSION = /^[0-9]{1,32}$/u;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
const REQUEST_TIMEOUT_MS = 10_000;
const SQL_READER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u;
const SQL_BARRIER_IDS = new Set(['billing-sql-barrier-a', 'billing-sql-barrier-b']);
const PROJECT_INVENTORY_PAGE_SIZE = 100;
const PROJECT_INVENTORY_MAX_PAGES = 100;

export class SupabaseRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = 'SupabaseRefusal';
    this.code = code;
  }
}

function refuse(code) { throw new SupabaseRefusal(code); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function compare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

async function getJson(path, token, fetchImpl, limit) {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(`${API}${path}`, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, 'Cache-Control': 'no-store' },
      redirect: 'error',
      cache: 'no-store',
      signal,
    });
  } catch {
    refuse('supabase_unavailable');
  }
  if (signal.aborted) refuse('supabase_unavailable');
  if (!response || response.status !== 200 || !response.headers?.get('content-type')?.toLowerCase().startsWith('application/json')) {
    refuse('supabase_unavailable');
  }
  const statedLength = response.headers.get('content-length');
  if (statedLength !== null && (!/^\d+$/u.test(statedLength) || Number(statedLength) > limit)) refuse('supabase_response_invalid');
  if (!response.body || typeof response.body.getReader !== 'function') refuse('supabase_response_invalid');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) refuse('supabase_response_invalid');
      size += value.byteLength;
      if (size > limit) refuse('supabase_response_invalid');
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    refuse('supabase_response_invalid');
  } finally {
    reader.releaseLock();
  }
}

// This seam is called only by trusted control code after Environment approval.
// It deliberately does not load process.env, dotenv files, or candidate inputs.
export function assertSupabaseRuntimeConfiguration({ policy, token, trustedConfiguration,
  fetchImpl = globalThis.fetch } = {}) {
  const db = policy?.database;
  if (!isValidStandaloneDatabasePolicy(db, { configured: true })) refuse('supabase_policy_invalid');
  if (!exactRecord(trustedConfiguration, ['environmentApproved', 'SUPABASE_VALIDATION_PROJECT_REF', 'databaseUrl']) ||
      trustedConfiguration.environmentApproved !== true ||
      trustedConfiguration.SUPABASE_VALIDATION_PROJECT_REF !== db.projectRef ||
      typeof trustedConfiguration.databaseUrl !== 'string') refuse('supabase_configuration_invalid');
  let url;
  try { url = new URL(trustedConfiguration.databaseUrl); } catch { refuse('supabase_configuration_invalid'); }
  const c = db.connection;
  if (!['postgresql:', 'postgres:'].includes(url.protocol) || url.hostname !== c.host ||
      (url.port || '5432') !== String(c.port) || url.pathname !== `/${c.database}` ||
      url.username !== c.role || !url.password || url.search || url.hash ||
      /[\r\n\0]/u.test(trustedConfiguration.databaseUrl)) {
    refuse('supabase_configuration_invalid');
  }
  if (typeof token !== 'string' || token.length === 0 || /[\r\n]/u.test(token) || typeof fetchImpl !== 'function') {
    refuse('supabase_credentials_invalid');
  }
  return Object.freeze({ ...db, connection: Object.freeze({ ...c }) });
}

function validInventoryProject(value) {
  return object(value) && typeof value.ref === 'string' && REF.test(value.ref) &&
    typeof value.organization_id === 'string' && value.organization_id.length > 0 &&
    typeof value.region === 'string' && /^[a-z0-9][a-z0-9-]{2,63}$/u.test(value.region) &&
    typeof value.status === 'string' && value.status.length > 0 && typeof value.is_branch === 'boolean' &&
    object(value.database) && typeof value.database.version === 'string' &&
    typeof value.database.postgres_engine === 'string' && typeof value.database.release_channel === 'string';
}

async function verifyOrganizationInventory({ db, project, token, fetchImpl }) {
  const seenRefs = new Set();
  const matches = [];
  let complete = false;

  for (let page = 0; page < PROJECT_INVENTORY_MAX_PAGES; page += 1) {
    const offset = page * PROJECT_INVENTORY_PAGE_SIZE;
    const path = `/v1/organizations/${encodeURIComponent(db.organizationSlug)}/projects?limit=${PROJECT_INVENTORY_PAGE_SIZE}&offset=${offset}`;
    const projects = await getJson(path, token, fetchImpl, 2_000_000);
    if (!Array.isArray(projects) || projects.length > PROJECT_INVENTORY_PAGE_SIZE) {
      refuse('supabase_project_inventory_invalid');
    }
    for (const entry of projects) {
      if (!validInventoryProject(entry)) refuse('supabase_project_inventory_invalid');
      if (seenRefs.has(entry.ref)) refuse('supabase_project_inventory_invalid');
      seenRefs.add(entry.ref);
      if (entry.organization_id !== db.organizationId) refuse('supabase_project_inventory_mismatch');
      if (entry.ref === db.projectRef) matches.push(entry);
    }
    if (projects.length < PROJECT_INVENTORY_PAGE_SIZE) {
      complete = true;
      break;
    }
  }

  if (!complete) refuse('supabase_project_inventory_invalid');
  if (matches.length !== 1) refuse('supabase_project_inventory_mismatch');
  const [target] = matches;
  if (target.is_branch !== false || target.organization_id !== project.organization_id ||
      target.region !== project.region || target.status !== project.status ||
      target.database.version !== project.database.version ||
      target.database.postgres_engine !== project.database.postgres_engine ||
      target.database.release_channel !== project.database.release_channel) {
    refuse('supabase_project_inventory_mismatch');
  }
}

export async function verifySupabaseEnvironment({ policy, token, trustedConfiguration,
  fetchImpl = globalThis.fetch } = {}) {
  const db = assertSupabaseRuntimeConfiguration({ policy, token, trustedConfiguration, fetchImpl });
  const project = await getJson(`/v1/projects/${db.projectRef}`, token, fetchImpl, 256_000);
  if (!object(project) || project.ref !== db.projectRef || project.organization_id !== db.organizationId ||
      project.region !== db.region || project.status !== 'ACTIVE_HEALTHY' || !object(project.database) ||
      project.database.host !== `db.${db.projectRef}.supabase.co` || project.database.host !== db.connection.host ||
      project.database.version !== db.databaseVersion || project.database.postgres_engine !== db.postgresEngine ||
      project.database.release_channel !== db.releaseChannel ||
      Object.hasOwn(project, 'parent_project_ref') || Object.hasOwn(project, 'branch_id') ||
      Object.hasOwn(project, 'branch_name') || project.is_branch === true) refuse('supabase_project_mismatch');

  // Project details do not prove this is a standalone project. Require the complete
  // organization inventory and an unambiguous non-branch entry before schema reads.
  await verifyOrganizationInventory({ db, project, token, fetchImpl });

  const migrations = await getJson(`/v1/projects/${db.projectRef}/database/migrations`, token, fetchImpl, 512_000);
  if (!Array.isArray(migrations) || migrations.length > 10_000) refuse('supabase_migrations_invalid');
  const seen = new Set();
  const canonical = [];
  for (const entry of migrations) {
    if (!object(entry) || Object.keys(entry).length !== 2 || typeof entry.version !== 'string' ||
        typeof entry.name !== 'string' || !VERSION.test(entry.version) || !NAME.test(entry.name) ||
        seen.has(entry.version)) refuse('supabase_migrations_invalid');
    seen.add(entry.version);
    canonical.push({ version: entry.version, name: entry.name });
  }
  canonical.sort((a, b) => compare(a.version, b.version) || compare(a.name, b.name));
  if (sha256(JSON.stringify(canonical)) !== db.migrationHistorySha256) refuse('supabase_migrations_mismatch');

  const generated = await getJson(`/v1/projects/${db.projectRef}/types/typescript?included_schemas=public`, token, fetchImpl, 4_000_000);
  if (!object(generated) || Object.keys(generated).length !== 1 || typeof generated.types !== 'string' || generated.types.length === 0) {
    refuse('supabase_types_invalid');
  }
  if (sha256(Buffer.from(generated.types, 'utf8')) !== db.schemaFingerprintSha256) refuse('supabase_types_mismatch');
  return db;
}

const FIXTURE_CAPABILITIES = Object.freeze({
  transactionalFence: true,
  transactionalReservation: true,
  rejectsExistingIds: true,
  update: false,
  delete: false,
  authAdmin: false,
});
const FIXTURE_KINDS = new Set(['catalog', 'billing_identity']);
const CASE_IDS = new Set(BILLING_43_IDS);
const SAFE_CONTROL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u;
const RESOURCE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function exactRecord(value, keys) {
  if (!object(value)) return false;
  let ownKeys;
  try { ownKeys = Reflect.ownKeys(value); } catch { return false; }
  return ownKeys.length === keys.length && ownKeys.every((key) => typeof key === 'string' && keys.includes(key)) &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true;
    });
}

function fixtureIdentity(value, expectedEnvironment) {
  return exactRecord(value, [...Object.keys(expectedEnvironment.database), 'appendOnly']) &&
    Object.keys(expectedEnvironment.database).every((key) => value[key] === expectedEnvironment.database[key]) &&
    value.appendOnly === true;
}

function safeFixtureRow(value) {
  const keys = ['fixtureId', 'namespaceId', 'attemptId', 'caseId', 'kind', 'marker', 'synthetic'];
  if (!exactRecord(value, keys) || !RESOURCE_UUID.test(value.fixtureId ?? '') ||
      !RESOURCE_UUID.test(value.namespaceId ?? '') || !SAFE_CONTROL_ID.test(value.attemptId ?? '') ||
      !CASE_IDS.has(value.caseId) || !FIXTURE_KINDS.has(value.kind) ||
      value.marker !== 'lawx-billing-validation-synthetic-v1' || value.synthetic !== true) {
    refuse('supabase_fixture_response_invalid');
  }
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, value[key]])));
}

function validateReaderBinding(input, expectedEnvironment) {
  if (!object(input) || !SAFE_CONTROL_ID.test(input.attemptId ?? '') ||
      !SAFE_CONTROL_ID.test(input.caseId ?? '') || input.environment !== undefined &&
      JSON.stringify(input.environment) !== JSON.stringify(expectedEnvironment) ||
      input.projectRef !== undefined && input.projectRef !== expectedEnvironment.database.projectRef ||
      Object.hasOwn(input, 'branchId') || Object.hasOwn(input, 'parentProjectRef') ||
      Object.hasOwn(input, 'branchName')) {
    refuse('supabase_reader_input_invalid');
  }
}

function validateWebhookReaderBinding(input, expectedEnvironment) {
  validateReaderBinding(input, expectedEnvironment);
  if (input.projectRef !== expectedEnvironment.database.projectRef ||
      !/^evt_[A-Za-z0-9_]{1,120}$/u.test(input.eventId ?? '') ||
      !/^(?:cus|in|pi|sub|price|prod|evt|ch|re|pm|seti|cs)_[A-Za-z0-9_]{1,120}$/u.test(input.objectId ?? '')) {
    refuse('supabase_reader_input_invalid');
  }
}

function validateSqlReaderBinding(input, expectedEnvironment, withBarrier = false) {
  const keys = ['projectRef', ...(withBarrier ? ['barrierId'] : [])];
  if (!exactRecord(input, keys) || input.projectRef !== expectedEnvironment.database.projectRef ||
      !REF.test(input.projectRef) ||
      withBarrier && !SQL_BARRIER_IDS.has(input.barrierId)) refuse('supabase_sql_reader_input_invalid');
  return Object.freeze({ projectRef: input.projectRef, ...(withBarrier ? { barrierId: input.barrierId } : {}) });
}

const WEBHOOK_FIELDS = Object.freeze(['id', 'attemptId', 'caseId', 'projectRef', 'eventId', 'eventType',
  'objectId', 'accountId', 'livemode', 'status', 'attempts', 'apiVersion', 'receivedAt', 'processedAt']);

function selectedSafeFields(value, allowed, required = []) {
  if (!object(value)) return null;
  const projected = {};
  try {
    for (const key of allowed) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) continue;
      if (!Object.hasOwn(descriptor, 'value')) return null;
      const field = descriptor.value;
      if (field === null || typeof field === 'string' || typeof field === 'boolean' ||
          Number.isSafeInteger(field)) projected[key] = field;
      else return null;
    }
  } catch { return null; }
  return required.every((key) => Object.hasOwn(projected, key)) ? projected : null;
}

function sanitizeWebhookInbox(value) {
  if (value === null) return null;
  const result = selectedSafeFields(value, WEBHOOK_FIELDS, ['eventId', 'status']);
  if (!result || typeof result.eventId !== 'string' || typeof result.status !== 'string' ||
      typeof result.accountId !== 'string' || !/^acct_[A-Za-z0-9_]+$/u.test(result.accountId) ||
      result.livemode !== false || typeof result.receivedAt !== 'string' || !Number.isFinite(Date.parse(result.receivedAt)) ||
      typeof result.processedAt !== 'string' || !Number.isFinite(Date.parse(result.processedAt)) ||
      Date.parse(result.processedAt) < Date.parse(result.receivedAt) ||
      result.attempts !== undefined && (!Number.isSafeInteger(result.attempts) || result.attempts < 0)) {
    refuse('supabase_webhook_response_invalid');
  }
  return Object.freeze(result);
}

function sanitizeWebhookReceipts(value) {
  if (!Array.isArray(value) || value.length > 10_000) refuse('supabase_webhook_response_invalid');
  return Object.freeze(value.map((entry) => {
    const result = selectedSafeFields(entry, WEBHOOK_FIELDS, ['id', 'eventId']);
    if (!result || typeof result.id !== 'string' || typeof result.eventId !== 'string' ||
        typeof result.accountId !== 'string' || !/^acct_[A-Za-z0-9_]+$/u.test(result.accountId) ||
        result.livemode !== false || result.status !== 'processed' ||
        typeof result.receivedAt !== 'string' || !Number.isFinite(Date.parse(result.receivedAt))) {
      refuse('supabase_webhook_response_invalid');
    }
    return Object.freeze(result);
  }));
}

/**
 * Build a read-only Supabase boundary from a trusted injected adapter.
 * No table, RPC, or HTTP endpoint is assumed here; a missing reader stays unavailable.
 */
export function createSupabaseBillingReader({ expectedEnvironment, source } = {}) {
  const required = ['readIdentity', 'readBillingSnapshot', 'listAttemptFixtures',
    'readSyntheticFixture', 'readWebhookInbox', 'readWebhookReceipts'];
  if (!isValidBillingEnvironment(expectedEnvironment) || !object(source) ||
      required.some((method) => typeof source[method] !== 'function')) {
    refuse('supabase_reader_unavailable');
  }
  const readerIdDescriptor = Object.getOwnPropertyDescriptor(source, 'trustedReaderId');
  const candidateReaderId = readerIdDescriptor && Object.hasOwn(readerIdDescriptor, 'value')
    ? readerIdDescriptor.value : null;
  const trustedReaderId = typeof candidateReaderId === 'string' && SQL_READER_ID.test(candidateReaderId)
    ? candidateReaderId : null;
  const identity = Object.freeze({ ...expectedEnvironment.database, readOnly: true });

  async function readIdentity() {
    let actual;
    try { actual = await source.readIdentity(); } catch { refuse('supabase_reader_unavailable'); }
    if (!exactRecord(actual, Object.keys(identity)) ||
        Object.keys(identity).some((key) => actual[key] !== identity[key])) refuse('supabase_reader_identity_mismatch');
    return identity;
  }

  return Object.freeze({
    identity,
    trustedReaderId,
    readIdentity,
    async readBillingSnapshot(input) {
      validateReaderBinding(input, expectedEnvironment);
      let snapshot;
      try { snapshot = await source.readBillingSnapshot(Object.freeze({ ...input })); }
      catch { refuse('supabase_reader_unavailable'); }
      try { return sanitizeDatabaseSnapshot(snapshot); }
      catch { refuse('supabase_snapshot_invalid'); }
    },
    async listAttemptFixtures(input) {
      validateReaderBinding(input, expectedEnvironment);
      if (JSON.stringify(input.environment) !== JSON.stringify(expectedEnvironment) ||
          !RESOURCE_UUID.test(input.namespaceId ?? '')) refuse('supabase_reader_input_invalid');
      let rows;
      try { rows = await source.listAttemptFixtures(Object.freeze({ ...input })); }
      catch { refuse('supabase_reader_unavailable'); }
      if (!Array.isArray(rows) || rows.length > 10_000) refuse('supabase_fixture_response_invalid');
      return Object.freeze(rows.map((row) => {
        const projected = safeFixtureRow(row);
        if (projected.attemptId !== input.attemptId || projected.caseId !== input.caseId ||
            projected.namespaceId !== input.namespaceId) refuse('supabase_fixture_response_invalid');
        return projected;
      }));
    },
    async readSyntheticFixture(input) {
      validateReaderBinding(input, expectedEnvironment);
      if (JSON.stringify(input.environment) !== JSON.stringify(expectedEnvironment) ||
          !RESOURCE_UUID.test(input.namespaceId ?? '') || !RESOURCE_UUID.test(input.fixtureId ?? '')) {
        refuse('supabase_reader_input_invalid');
      }
      let row;
      try { row = await source.readSyntheticFixture(Object.freeze({ ...input })); }
      catch { refuse('supabase_reader_unavailable'); }
      if (row === null) return null;
      const projected = safeFixtureRow(row);
      if (projected.fixtureId !== input.fixtureId || projected.attemptId !== input.attemptId ||
          projected.caseId !== input.caseId || projected.namespaceId !== input.namespaceId) {
        refuse('supabase_fixture_response_invalid');
      }
      return projected;
    },
    async readWebhookInbox(input) {
      validateWebhookReaderBinding(input, expectedEnvironment);
      try { return sanitizeWebhookInbox(await source.readWebhookInbox(Object.freeze({ ...input }))); }
      catch (error) {
        if (error instanceof SupabaseRefusal) throw error;
        refuse('supabase_reader_unavailable');
      }
    },
    async readWebhookReceipts(input) {
      validateWebhookReaderBinding(input, expectedEnvironment);
      try { return sanitizeWebhookReceipts(await source.readWebhookReceipts(Object.freeze({ ...input }))); }
      catch (error) {
        if (error instanceof SupabaseRefusal) throw error;
        refuse('supabase_reader_unavailable');
      }
    },
    async readInstalledSchemaState(input) {
      if (!trustedReaderId || typeof source.readInstalledSchemaState !== 'function') {
        refuse('supabase_sql_reader_unavailable');
      }
      const target = validateSqlReaderBinding(input, expectedEnvironment);
      await readIdentity();
      let raw;
      try {
        raw = await source.readInstalledSchemaState(Object.freeze({ ...target, readerId: trustedReaderId, readOnly: true }));
      } catch {
        refuse('supabase_sql_reader_unavailable');
      }
      let state;
      try { state = sanitizeInstalledSchemaState(raw); }
      catch { refuse('supabase_sql_response_invalid'); }
      if (state.readerId !== trustedReaderId || state.projectRef !== target.projectRef ||
          state.isStandaloneProject !== true) refuse('supabase_sql_response_invalid');
      return state;
    },
    async readConcurrencyProof(input) {
      if (!trustedReaderId || typeof source.readConcurrencyProof !== 'function') {
        refuse('supabase_sql_reader_unavailable');
      }
      const target = validateSqlReaderBinding(input, expectedEnvironment, true);
      await readIdentity();
      let raw;
      try {
        raw = await source.readConcurrencyProof(Object.freeze({ ...target, readerId: trustedReaderId, readOnly: true }));
      } catch {
        refuse('supabase_sql_reader_unavailable');
      }
      let proof;
      try { proof = sanitizeSqlConcurrencyProof(raw); }
      catch { refuse('supabase_sql_response_invalid'); }
      if (proof.readerId !== trustedReaderId || proof.projectRef !== target.projectRef ||
          proof.isStandaloneProject !== true || proof.barrierId !== target.barrierId) {
        refuse('supabase_sql_response_invalid');
      }
      return proof;
    },
  });
}

/**
 * Append-only fixture writer seam. It deliberately has no built-in RPC/schema.
 * Real publication is blocked unless a reviewed adapter proves the required
 * transactional fencing/reservation and insert-only capabilities at runtime.
 */
export function createSupabaseFixturePublisher({ expectedEnvironment, adapter, attempts, owner } = {}) {
  if (!isValidBillingEnvironment(expectedEnvironment)) refuse('supabase_fixture_adapter_unavailable');

  async function assertReadyBinding(binding = {}, verifyFence = true) {
    if (!object(adapter) || typeof adapter.readIdentity !== 'function' ||
        typeof adapter.insertAttemptFixture !== 'function' || !exactRecord(adapter.capabilities,
          Object.keys(FIXTURE_CAPABILITIES)) ||
        Object.keys(FIXTURE_CAPABILITIES).some((key) => adapter.capabilities[key] !== FIXTURE_CAPABILITIES[key]) ||
        typeof attempts?.assertFence !== 'function' ||
        typeof attempts?.fixtureMutationWithReservation !== 'function' || !owner ||
        typeof owner.reservationId !== 'string' || !object(owner.capacity) ||
        !Number.isSafeInteger(owner.capacity.requested?.databaseRows) ||
        owner.capacity.requested.databaseRows < 1 ||
        binding.environment && JSON.stringify(binding.environment) !== JSON.stringify(expectedEnvironment) ||
        typeof binding.attemptId !== 'string' || !SAFE_CONTROL_ID.test(binding.attemptId) ||
        typeof binding.reservationId !== 'string' || !SAFE_CONTROL_ID.test(binding.reservationId) ||
        typeof binding.fence !== 'string' || !SAFE_CONTROL_ID.test(binding.fence)) {
      refuse('supabase_fixture_adapter_unavailable');
    }
    if (owner && (owner.attemptId !== binding.attemptId || owner.fence !== binding.fence ||
        owner.reservationId !== binding.reservationId ||
        JSON.stringify(owner.environment) !== JSON.stringify(expectedEnvironment))) {
      refuse('supabase_fixture_adapter_unavailable');
    }
    let actual;
    try { actual = await adapter.readIdentity(); } catch { refuse('supabase_fixture_adapter_unavailable'); }
    if (!fixtureIdentity(actual, expectedEnvironment)) refuse('supabase_fixture_identity_mismatch');
    if (verifyFence && attempts && typeof attempts.assertFence === 'function') {
      try {
        const current = await attempts.assertFence({ attemptId: binding.attemptId, fence: binding.fence });
        if (current?.attemptId !== binding.attemptId || current?.fence !== binding.fence ||
            JSON.stringify(current.environment) !== JSON.stringify(expectedEnvironment)) {
          refuse('supabase_fixture_adapter_unavailable');
        }
      } catch { refuse('supabase_fixture_adapter_unavailable'); }
    }
    return true;
  }

  async function assertReady(binding = {}) {
    return assertReadyBinding(binding, true);
  }

  async function insertAttemptFixture(input) {
    const keys = ['attemptId', 'reservationId', 'fence', 'environment', 'caseId', 'namespaceId',
      'fixtureId', 'kind', 'marker', 'synthetic', 'transaction'];
    if (!exactRecord(input, keys) || !SAFE_CONTROL_ID.test(input.attemptId ?? '') ||
        !SAFE_CONTROL_ID.test(input.reservationId ?? '') || !SAFE_CONTROL_ID.test(input.fence ?? '') ||
        JSON.stringify(input.environment) !== JSON.stringify(expectedEnvironment) ||
        !CASE_IDS.has(input.caseId) || !RESOURCE_UUID.test(input.namespaceId ?? '') ||
        !RESOURCE_UUID.test(input.fixtureId ?? '') || !FIXTURE_KINDS.has(input.kind) ||
        input.marker !== 'lawx-billing-validation-synthetic-v1' || input.synthetic !== true ||
        !object(input.transaction) || input.transaction.attemptId !== input.attemptId ||
        input.transaction.fence !== input.fence || input.transaction.reservationId !== input.reservationId ||
        typeof input.transaction.transactionId !== 'string' || !SAFE_CONTROL_ID.test(input.transaction.transactionId) ||
        input.transaction.reservationLocked !== true || input.transaction.reservationValidated !== true ||
        input.transaction.reservationStatus !== 'active' || input.transaction.reservationSettled !== false ||
        !isActiveFixtureMutationTransaction(input.transaction) ||
        !Number.isSafeInteger(input.transaction.remainingDatabaseRows) ||
        input.transaction.remainingDatabaseRows < 1) refuse('supabase_fixture_input_invalid');
    await assertReadyBinding(input, false);
    let receipt;
    try { receipt = await adapter.insertAttemptFixture(input); }
    catch { refuse('fixture_mutation_ambiguous'); }
    if (!exactRecord(receipt, ['inserted', 'fixtureId', 'attemptId', 'caseId']) ||
        receipt.inserted !== true || receipt.fixtureId !== input.fixtureId ||
        receipt.attemptId !== input.attemptId || receipt.caseId !== input.caseId) {
      refuse('fixture_mutation_ambiguous');
    }
    return Object.freeze({ inserted: true, fixtureId: receipt.fixtureId,
      attemptId: receipt.attemptId, caseId: receipt.caseId });
  }

  return Object.freeze({ assertReady, insertAttemptFixture });
}
