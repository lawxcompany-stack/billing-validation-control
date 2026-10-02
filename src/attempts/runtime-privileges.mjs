const RUNTIME_ROLE = 'billing_validation_runtime';
const SCHEMA = 'billing_validation_control';

const freezeDeep = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
};

export const CONTROL_RUNTIME_PRIVILEGES = freezeDeep({
  schema: SCHEMA,
  role: RUNTIME_ROLE,
  tables: {
    attempts: {
      select: true,
      insert: ['attempt_id', 'branch_id', 'suite', 'fixture_key', 'candidate_sha', 'workflow_repository',
        'workflow_ref', 'workflow_run_id', 'workflow_run_attempt', 'runner_label', 'database_project_ref',
        'deployment_id', 'deployment_origin', 'stripe_account_id', 'state', 'cleanup_status', 'artifact_id',
        'artifact_digest', 'artifact_schema', 'resource_ids', 'created_at', 'updated_at'],
      update: ['state', 'cleanup_status', 'artifact_id', 'artifact_digest', 'artifact_schema', 'resource_ids', 'updated_at'],
    },
    standalone_resource_locks: {
      select: true,
      insert: ['resource_type', 'resource_id', 'owner_attempt_id', 'fence', 'candidate_sha', 'workflow_repository',
        'workflow_ref', 'workflow_run_id', 'workflow_run_attempt', 'runner_label', 'environment_identity', 'expires_at'],
      update: ['owner_attempt_id', 'fence', 'candidate_sha', 'workflow_repository', 'workflow_ref',
        'workflow_run_id', 'workflow_run_attempt', 'runner_label', 'environment_identity', 'expires_at', 'updated_at'],
      delete: true,
    },
    stripe_intents: {
      select: true,
      insert: ['intent_id', 'attempt_id', 'owner_fence', 'account_id', 'candidate_sha', 'workflow_repository',
        'workflow_ref', 'workflow_run_id', 'workflow_run_attempt', 'runner_label', 'environment_identity',
        'action', 'operation', 'request_digest', 'idempotency_key', 'state', 'created_at'],
    },
    stripe_receipts: {
      select: true,
      insert: ['receipt_id', 'intent_id', 'attempt_id', 'owner_fence', 'account_id', 'operation',
        'request_digest', 'idempotency_key', 'observation_digest', 'resource_ids', 'observed_at'],
    },
    retention_reservations: {
      select: true,
      insert: ['reservation_id', 'attempt_id', 'project_ref', 'branch_id', 'stripe_account_id', 'policy_version',
        'quota_limits', 'projection', 'capacity_snapshot', 'created_at'],
    },
    fixture_reservation_claims: { select: true },
    fixture_reservation_claim_events: {
      select: true,
      insert: ['event_id', 'reservation_id', 'attempt_id', 'previous_rows', 'current_rows'],
    },
    retention_receipts: {
      select: true,
      insert: ['receipt_id', 'reservation_id', 'attempt_id', 'project_ref', 'branch_id', 'stripe_account_id',
        'outcome', 'retained_usage', 'owner_fence', 'created_at'],
    },
    fixture_case_claims: {
      select: true,
      insert: ['attempt_id', 'case_id', 'reservation_id', 'owner_fence', 'candidate_sha', 'namespace_id',
        'project_ref', 'branch_id', 'deployment_id', 'deployment_origin', 'stripe_account_id'],
    },
    fixture_resource_claims: {
      select: ['attempt_id', 'case_id', 'kind'],
      insert: ['attempt_id', 'case_id', 'kind', 'fixture_id'],
    },
    cleanup_receipts: {
      select: true,
      insert: ['receipt_id', 'reservation_id', 'attempt_id', 'project_ref', 'branch_id', 'deployment_id',
        'deployment_origin', 'stripe_account_id', 'owner_fence', 'cleanup_digest', 'verified_projection', 'created_at'],
    },
    standalone_fixture_leases: {
      select: true,
      insert: ['project_ref', 'suite', 'fixture_key', 'attempt_id', 'fence', 'expires_at', 'owner_candidate_sha',
        'owner_repository', 'owner_ref', 'owner_run_id', 'owner_run_attempt', 'recovery_only'],
      update: ['attempt_id', 'fence', 'expires_at', 'owner_candidate_sha', 'owner_repository', 'owner_ref',
        'owner_run_id', 'owner_run_attempt', 'recovery_only'],
      delete: true,
    },
    fixture_lease_history: {
      insert: ['project_ref', 'suite', 'fixture_key', 'attempt_id', 'owner_fence', 'workflow_run_id',
        'workflow_run_attempt', 'event_type', 'expires_at'],
    },
  },
  sequences: {
    fixture_lease_fence_seq: { usage: true },
  },
  functions: {
    'valid_retention_usage(jsonb,integer,boolean)': { execute: true },
    'valid_cleanup_projection(jsonb)': { execute: true },
  },
});

// These relations are part of the schema inventory but deliberately have no
// privileges for the runtime role. The legacy tables remain in schema.sql, and
// the lease-history identity column owns an implicit sequence.
export const CONTROL_RUNTIME_FINGERPRINT_EMPTY_TABLES = Object.freeze([
  'control_store_install_receipts',
  'fixture_leases',
  'resource_locks',
  'schema_migrations',
]);

export const CONTROL_RUNTIME_FINGERPRINT_EMPTY_SEQUENCES = Object.freeze([
  'fixture_lease_history_event_id_seq',
]);

function refuse() {
  const error = new Error('Control runtime privilege input is invalid.');
  error.name = 'ControlRuntimePrivilegesRefusal';
  error.code = 'control_runtime_privileges_invalid';
  throw error;
}

function exactDataRecord(value, expectedKeys) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expectedKeys.length || keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))) {
      return false;
    }
    return expectedKeys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true;
    });
  } catch {
    return false;
  }
}

function exactArray(value, expected) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== expected.length) {
      return false;
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expected.length + 1 || !keys.includes('length')) return false;
    return expected.every((item, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true &&
        descriptor.value === item;
    });
  } catch {
    return false;
  }
}

function matchesExact(value, expected, visited = new WeakSet()) {
  if (expected === null || typeof expected !== 'object') return value === expected;
  if (visited.has(value)) return false;
  const keys = Object.keys(expected);
  const isArray = Array.isArray(expected);
  if (isArray) {
    if (!exactArray(value, expected)) return false;
    visited.add(value);
    return expected.every((item, index) => matchesExact(value[index], item, visited));
  }
  if (!exactDataRecord(value, keys)) return false;
  visited.add(value);
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && matchesExact(descriptor.value, expected[key], visited);
  });
}

function validatePrivileges(privileges) {
  if (!matchesExact(privileges, CONTROL_RUNTIME_PRIVILEGES)) refuse();
  for (const [table, rights] of Object.entries(CONTROL_RUNTIME_PRIVILEGES.tables)) {
    if (!/^[a-z][a-z0-9_]*$/u.test(table) || Object.hasOwn(rights, 'truncate')) refuse();
    if (Object.hasOwn(rights, 'select') && rights.select !== true &&
        (!Array.isArray(rights.select) || rights.select.length === 0 ||
          rights.select.some((column) => typeof column !== 'string' || !/^[a-z][a-z0-9_]*$/u.test(column)) ||
          new Set(rights.select).size !== rights.select.length)) refuse();
    if (Object.hasOwn(rights, 'delete') && rights.delete !== true) refuse();
  }
  for (const name of [...Object.keys(CONTROL_RUNTIME_PRIVILEGES.tables),
    ...Object.keys(CONTROL_RUNTIME_PRIVILEGES.sequences)]) {
    if (!/^[a-z][a-z0-9_]*$/u.test(name)) refuse();
  }
}

export function renderControlRuntimeGrants(privileges) {
  try {
    validatePrivileges(privileges);
    const schema = SCHEMA;
    const role = RUNTIME_ROLE;
    const statements = [
      `REVOKE ALL PRIVILEGES ON SCHEMA ${schema} FROM ${role};`,
      `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${schema} FROM ${role};`,
      `REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${schema} FROM ${role};`,
      `REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA ${schema} FROM ${role};`,
      `GRANT USAGE ON SCHEMA ${schema} TO ${role};`,
    ];

    // Render from the immutable manifest after validation; never enumerate caller-owned proxies again.
    for (const [table, rights] of Object.entries(CONTROL_RUNTIME_PRIVILEGES.tables)) {
      const relation = `${schema}.${table}`;
      if (rights.select === true) statements.push(`GRANT SELECT ON TABLE ${relation} TO ${role};`);
      else if (rights.select) statements.push(`GRANT SELECT (${rights.select.join(', ')}) ON TABLE ${relation} TO ${role};`);
      if (rights.insert) statements.push(`GRANT INSERT (${rights.insert.join(', ')}) ON TABLE ${relation} TO ${role};`);
      if (rights.update) statements.push(`GRANT UPDATE (${rights.update.join(', ')}) ON TABLE ${relation} TO ${role};`);
      if (rights.delete) statements.push(`GRANT DELETE ON TABLE ${relation} TO ${role};`);
    }
    for (const [sequence, rights] of Object.entries(CONTROL_RUNTIME_PRIVILEGES.sequences)) {
      if (rights.usage) statements.push(`GRANT USAGE ON SEQUENCE ${schema}.${sequence} TO ${role};`);
    }
    for (const [signature, rights] of Object.entries(CONTROL_RUNTIME_PRIVILEGES.functions)) {
      if (rights.execute) statements.push(`GRANT EXECUTE ON FUNCTION ${schema}.${signature} TO ${role};`);
    }
    return `${statements.join('\n')}\n`;
  } catch {
    refuse();
  }
}
