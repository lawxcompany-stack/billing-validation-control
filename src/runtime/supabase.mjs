import { createHash } from 'node:crypto';

const API = 'https://api.supabase.com';
const REF = /^[a-z0-9]{20}$/u;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const VERSION = /^[0-9]{1,32}$/u;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
const PRODUCTION_BRANCH_PART = /(?:^|[-_.])(?:main|master|prod|production|primary|default)(?:$|[-_.])/u;
const REQUEST_TIMEOUT_MS = 10_000;

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
  let response;
  try {
    response = await fetchImpl(`${API}${path}`, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, 'Cache-Control': 'no-store' },
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    refuse('supabase_unavailable');
  }
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

export async function verifySupabaseEnvironment({ policy, token, fetchImpl = globalThis.fetch } = {}) {
  const db = policy?.database;
  if (!object(db) || !REF.test(db.projectRef) || !REF.test(db.parentProjectRef) ||
      db.projectRef === db.parentProjectRef || !BRANCH.test(db.branchId) || !BRANCH.test(db.branchName) ||
      PRODUCTION_BRANCH_PART.test(db.branchId.toLowerCase()) || PRODUCTION_BRANCH_PART.test(db.branchName.toLowerCase()) ||
      !DIGEST.test(db.schemaFingerprintSha256) || !DIGEST.test(db.migrationHistorySha256)) {
    refuse('supabase_policy_invalid');
  }
  if (typeof token !== 'string' || token.length === 0 || /[\r\n]/u.test(token) || typeof fetchImpl !== 'function') {
    refuse('supabase_credentials_invalid');
  }

  const branch = await getJson(`/v1/projects/${db.parentProjectRef}/branches/${db.branchName}`, token, fetchImpl, 256_000);
  if (!object(branch) || branch.id !== db.branchId || branch.name !== db.branchName ||
      branch.project_ref !== db.projectRef || branch.parent_project_ref !== db.parentProjectRef ||
      branch.is_default !== false || branch.status !== 'ACTIVE_HEALTHY' ||
      (branch.preview_project_status !== undefined && branch.preview_project_status !== null &&
       branch.preview_project_status !== 'ACTIVE_HEALTHY')) refuse('supabase_branch_mismatch');

  const migrations = await getJson(`/v1/projects/${db.projectRef}/database/migrations`, token, fetchImpl, 512_000);
  if (!Array.isArray(migrations) || migrations.length > 10_000) refuse('supabase_migrations_invalid');
  const seen = new Set();
  const canonical = [];
  for (const entry of migrations) {
    if (!object(entry) || Object.keys(entry).length !== 2 || !VERSION.test(entry.version) ||
        !NAME.test(entry.name) || seen.has(entry.version)) refuse('supabase_migrations_invalid');
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
  return Object.freeze({
    projectRef: db.projectRef,
    parentProjectRef: db.parentProjectRef,
    branchId: db.branchId,
    branchName: db.branchName,
    schemaFingerprintSha256: db.schemaFingerprintSha256,
    migrationHistorySha256: db.migrationHistorySha256,
  });
}
