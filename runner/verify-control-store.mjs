import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONTROL_STORE_POLICY, parseControlStoreVerifierDatabaseUrl } from '../src/attempts/control-store-policy.mjs';
import { verifyAttemptControlStore } from '../src/attempts/control-store-verifier.mjs';

const REFUSAL_CODE = 'control_store_runtime_refused';
const REFUSAL_MESSAGE = 'Control-store verification refused.';
const CONNECTION_TIMEOUT_MS = 5000;

function refusal() {
  const error = new Error(REFUSAL_MESSAGE);
  error.name = 'ControlStoreRuntimeRefusal';
  error.code = REFUSAL_CODE;
  return error;
}

function parseVerifierTarget(environment) {
  try {
    if (environment === null || typeof environment !== 'object' || Array.isArray(environment)) throw refusal();
    const databaseUrl = environment.BILLING_CONTROL_VERIFIER_DATABASE_URL;
    const target = parseControlStoreVerifierDatabaseUrl(databaseUrl, CONTROL_STORE_POLICY);
    const password = decodeURIComponent(new URL(databaseUrl).password);
    if (password.length === 0) throw refusal();
    return { target, password };
  } catch {
    throw refusal();
  }
}

async function createPostgresClient(config) {
  const { Client } = await import('pg');
  return new Client(config);
}

/** Verify the pinned control database without running migrations or store operations. */
export async function runControlStoreVerification({ environment = process.env, createClient } = {}) {
  const { target, password } = parseVerifierTarget(environment);
  const factory = createClient ?? createPostgresClient;
  if (typeof factory !== 'function') throw refusal();

  const config = {
    host: target.host,
    port: target.port,
    database: target.database,
    user: target.username,
    password,
    ssl: { rejectUnauthorized: true, servername: target.host },
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
  };

  let client;
  let transactionOpen = false;
  try {
    client = await factory(config);
    if (typeof client?.connect !== 'function' || typeof client?.query !== 'function' ||
        typeof client?.end !== 'function') throw refusal();

    await client.connect();
    await client.query('BEGIN READ ONLY');
    transactionOpen = true;
    const receipt = await verifyAttemptControlStore({
      queryClient: client,
      policy: CONTROL_STORE_POLICY,
      target,
    });
    await client.query('COMMIT');
    transactionOpen = false;
    return receipt;
  } catch {
    if (client && transactionOpen) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Database details remain private to the protected runtime.
      }
    }
    throw refusal();
  } finally {
    if (typeof client?.end === 'function') {
      try {
        await client.end();
      } catch {
        // Close errors are deliberately reduced to the same fixed refusal.
      }
    }
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    const receipt = await runControlStoreVerification();
    process.stdout.write(JSON.stringify(receipt) + '\n');
  } catch {
    process.stderr.write(`Control-store verification refused (${REFUSAL_CODE}).\n`);
    process.exitCode = 1;
  }
}
