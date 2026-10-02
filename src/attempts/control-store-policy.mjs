import { readFile } from 'node:fs/promises';

const POLICY_MESSAGES = Object.freeze({
  control_store_policy_invalid: 'Control store policy is invalid.',
  control_store_target_invalid: 'Control store database target is invalid.',
});

const APPROVED_POLICY = Object.freeze({
  schemaVersion: 1,
  projectRef: 'ceindkuafycqdcplfrgs',
  region: 'sa-east-1',
  databaseVersion: '17.11.0.002',
  schema: 'billing_validation_control',
  roles: Object.freeze({
    owner: 'billing_validation_owner',
    runtime: 'billing_validation_runtime',
    verifier: 'billing_validation_verifier',
  }),
  connection: Object.freeze({
    protocol: 'postgresql',
    host: 'db.ceindkuafycqdcplfrgs.supabase.co',
    port: 5432,
    database: 'postgres',
    sslMode: 'require',
  }),
  urlEnvironment: 'BILLING_CONTROL_VERIFIER_DATABASE_URL',
});

const DEFAULT_POLICY_PATH = new URL('../../policy/control-store-policy.json', import.meta.url);

export class ControlStoreRefusal extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(POLICY_MESSAGES, code)
      ? code
      : 'control_store_policy_invalid';
    super(POLICY_MESSAGES[safeCode]);
    this.name = 'ControlStoreRefusal';
    this.code = safeCode;
  }
}

function refusePolicy() {
  throw new ControlStoreRefusal('control_store_policy_invalid');
}

function refuseTarget() {
  throw new ControlStoreRefusal('control_store_target_invalid');
}

function recursivelyFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) recursivelyFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function matchesApprovedShape(value, approved) {
  if (approved === null || typeof approved !== 'object') return value === approved;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;

  const ownKeys = Reflect.ownKeys(value);
  const expectedKeys = Object.keys(approved);
  if (ownKeys.length !== expectedKeys.length) return false;
  if (ownKeys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))) return false;

  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return false;
    if (!matchesApprovedShape(descriptor.value, approved[key])) return false;
  }

  return true;
}

function assertApprovedPolicy(policy) {
  try {
    if (!matchesApprovedShape(policy, APPROVED_POLICY)) refusePolicy();
  } catch {
    refusePolicy();
  }
}

export async function loadControlStorePolicy(options = {}) {
  try {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) refusePolicy();
    const optionKeys = Reflect.ownKeys(options);
    if (optionKeys.some((key) => key !== 'policyPath')) refusePolicy();

    const pathDescriptor = Object.getOwnPropertyDescriptor(options, 'policyPath');
    if (pathDescriptor && !Object.hasOwn(pathDescriptor, 'value')) refusePolicy();
    const policyPath = pathDescriptor?.value ?? DEFAULT_POLICY_PATH;
    if (typeof policyPath !== 'string' && !(policyPath instanceof URL)) refusePolicy();

    const contents = await readFile(policyPath, 'utf8');
    const policy = JSON.parse(contents);
    assertApprovedPolicy(policy);
    return recursivelyFreeze(policy);
  } catch {
    refusePolicy();
  }
}

function parseControlStoreDatabaseUrlForRole(value, role, policy) {
  assertApprovedPolicy(policy);

  try {
    if (typeof value !== 'string' || value.length === 0 || value.length > 4096) refuseTarget();
    if (value.trim() !== value || value.includes('\\') || !value.startsWith('postgresql://')) refuseTarget();

    const url = new URL(value);
    const username = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);

    if (url.protocol !== APPROVED_POLICY.connection.protocol + ':') refuseTarget();
    if (url.hostname.toLowerCase() !== APPROVED_POLICY.connection.host) refuseTarget();
    if (url.port !== String(APPROVED_POLICY.connection.port)) refuseTarget();
    if (url.pathname !== `/${APPROVED_POLICY.connection.database}`) refuseTarget();
    if (url.hash !== '' || url.search !== '?sslmode=require') refuseTarget();
    if (username !== role || password.length === 0) refuseTarget();

    return Object.freeze({
      projectRef: APPROVED_POLICY.projectRef,
      host: APPROVED_POLICY.connection.host,
      port: APPROVED_POLICY.connection.port,
      database: APPROVED_POLICY.connection.database,
      username: role,
      sslMode: APPROVED_POLICY.connection.sslMode,
    });
  } catch (error) {
    if (error instanceof ControlStoreRefusal && error.code === 'control_store_policy_invalid') throw error;
    refuseTarget();
  }
}

export function parseControlStoreVerifierDatabaseUrl(value, policy = CONTROL_STORE_POLICY) {
  return parseControlStoreDatabaseUrlForRole(value, APPROVED_POLICY.roles.verifier, policy);
}

export function parseControlStoreRuntimeDatabaseUrl(value, policy = CONTROL_STORE_POLICY) {
  return parseControlStoreDatabaseUrlForRole(value, APPROVED_POLICY.roles.runtime, policy);
}

export const CONTROL_STORE_POLICY = await loadControlStorePolicy();
