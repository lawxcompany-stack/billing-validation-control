# Isolated Billing Control Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a separately identified, least-privilege Supabase control store for trusted billing-validation attempts without changing the existing Preview financial database or any production system.

**Architecture:** Use `ceindkuafycqdcplfrgs` only for control-plane attempts, leases, reservations, intents, and receipts. The financial database policy is currently deliberately unconfigured (`projectRef` and `connection` are `null`). The previously named `zjvqjdntasprusoqfsgw` is in the application's immutable protected/historical-target denylist and is not present in the currently accessible Supabase project inventory; it must not be re-enabled or queried as a financial target. A new financial validation target requires a separate user-approved provisioning decision and cost confirmation. Install the control schema through a digest-pinned, operator-rendered, one-time SQL bundle; the protected CI verifier receives only a distinct verifier URL and performs read-only identity/integrity verification. The business runtime remains a separate NOLOGIN role. Validate the complete role, migration, concurrency, and failure contract in a disposable PostgreSQL 17 container on the dedicated rootless Docker context.

**Tech Stack:** Node.js 22 ESM, `node:test`, PostgreSQL 17, Supabase MCP for a separately gated operator rollout, GitHub Actions, pnpm, and Docker context `billing-validation-isolated`.

**Spec:** `docs/superpowers/specs/2026-10-02-isolated-billing-control-store-design.md`, approved by the user on 2026-10-02.

## Global Constraints

- Control project identity is `ceindkuafycqdcplfrgs`, region `sa-east-1`, PostgreSQL `17.11`; it stores no customer or financial-fixture data.
- The financial validation target is not currently configured. `zjvqjdntasprusoqfsgw` is denylisted as a protected/historical target and Supabase returned `Project not found`; do not connect to it or change the denylist. `SUPABASE_VALIDATION_DATABASE_URL` remains separate from the control URL and must stay unusable until a distinct target is approved and provisioned.
- The read-only verifier connection setting is `BILLING_CONTROL_VERIFIER_DATABASE_URL`; it is never passed to candidate-controlled jobs, the application, Vercel, artifacts, or logs. The verifier identity is separate from the NOLOGIN business runtime role and from `SUPABASE_VALIDATION_DATABASE_URL`.
- Supabase main/production, unrelated Supabase projects, Vercel Production, Stripe Live, and unrelated Docker containers and volumes are out of scope.
- The Supabase `postgres` credential, Supabase management token, and owner/migrator authority never enter CI, candidate jobs, the application, Vercel, command arguments, shell history, artifacts, or chat.
- `billing_validation_owner` and `billing_validation_runtime` remain `NOLOGIN`. Bootstrap also creates `billing_validation_verifier` as `NOLOGIN`; enabling it for read-only checks requires a separately gated Task 7 credential handoff and verified GitHub Environment protection.
- Runtime cannot read or write the migration ledger directly; historical ledgers cannot be updated, deleted, or truncated by runtime.
- Migrations are forward-only, ordered, and verified against committed SHA-256 pins; no reset, replay, repair, DROP, DELETE, or TRUNCATE is used to recover an uncertain install.
- Remote DDL, GitHub Environment changes, secret installation, Preview changes, deployments, and financial test dispatch are excluded from this local implementation plan and require their own explicit rollout gate.
- Preserve the six pre-existing modified paths in this worktree. Never reset, stash, overwrite, or include their pre-existing hunks in a task commit without first reviewing and explicitly staging only the intended changes.
- Every Docker command in the integration harness uses `--context billing-validation-isolated`; never switch the global Docker context, stop other services, or run prune commands.
- A passing control-store implementation does not prove the 43 financial scenarios pass or establish production readiness.

## File and Interface Map

- `policy/control-store-policy.json`: immutable, non-secret identity for the control project, connection endpoint, schema, and role names. It does not replace or edit `policy/environment-policy.json`'s financial database identity.
- `src/attempts/control-store-policy.mjs`: closed-schema policy loader and credential-redacting URL/target validator.
- `src/attempts/schema.sql`: deterministic first-install DDL for objects inside `billing_validation_control`, without creating the schema itself, conditional creation, or trigger replacement. It creates an immutable `control_store_install_receipts` relation; the renderer inserts the exact project and baseline receipt there.
- `src/attempts/control-store-bootstrap.mjs`: validates pinned source hashes and renders the only operator SQL bundle; it has no network/database client and cannot apply SQL.
- `src/attempts/migrations.mjs`: pure migration discovery, allowlist, hash, ordering, and applied-history validation; it does not connect to a database or apply DDL. The baseline digest is recorded in `control_store_install_receipts`; migration `0001` creates `schema_migrations` and its trigger-protected history.
- `src/attempts/runtime-privileges.mjs`: explicit relation/column/function/sequence privilege inventory consumed by the SQL renderer and tests.
- `src/attempts/postgres-store.mjs`: uses only the distinct runtime-role connection for attempt-store operations, checks the exact runtime session identity at the start of each transaction, preserves separate Preview-target proof, and never installs schema or calls the verifier-only function. Full schema/ACL/migration verification remains in the protected read-only verifier job; the runtime stays `NOLOGIN` and is not enabled by this gate.
- `src/attempts/migrations/202610010001-standalone-lease-fencing.sql`: financial/attempt migration directory, strictly allowlisted by the financial migration runner.
- `src/attempts/control-store-migrations/`: control-store-only migration directory with a byte-for-byte pinned copy of `202610010001-standalone-lease-fencing.sql` plus `202610020001-control-runtime-privileges.sql`. It must never be discovered or applied by the financial migration runner. The financial runner retains its original `0001` file in `src/attempts/migrations/`; a parity test pins the copy. Migration `0001` creates `schema_migrations`; the baseline receipt must therefore live in `control_store_install_receipts`, not in a table that migration `0001` creates.
- `.github/workflows/validate-billing.yml`: only a protected trusted job can receive `BILLING_CONTROL_VERIFIER_DATABASE_URL`; PR policy checks remain credential-free and business runtime jobs cannot apply migrations.
- `test/attempts/control-store-policy.test.mjs`, `control-store-bootstrap.test.mjs`, `control-store-privileges.test.mjs`, and `control-store-postgres.integration.test.mjs`: policy, SQL contract, ACL, and PostgreSQL behavior proofs.
- `test/attempts/control-store-fixtures.mjs`: synthetic-only policy, digest, and verifier fixtures shared by unit tests; it contains no project credentials or remote state.
- `scripts/test-billing-control-store-postgres.mjs`: starts and removes only its uniquely labeled disposable PostgreSQL container through the isolated Docker context.
- `test/workflows/control-store-boundary.test.mjs`: proves CI/Preview/candidate secret and migration boundaries.
- `docs/billing-validation-control-store.md`: operator runbook and explicit local-vs-remote-vs-production acceptance status.

## Execution Preflight

- [ ] Read `git status --short`, `git diff --stat`, and the complete diffs of the six pre-existing modified files before editing. Record which hunks are pre-existing; preserve them and do not infer that they belong to this plan.
- [ ] Run `git diff --check` before the first change and retain its output as the baseline.
- [ ] Confirm the checked-out branch is `feat/control-task7-standalone-db`; stop if the worktree path or branch differs.
- [ ] Resolve the `billing-validation` UID using `getent passwd billing-validation`; confirm `docker context inspect billing-validation-isolated` points to `/run/user/<uid>/docker.sock` for that UID and that `docker --context billing-validation-isolated info` reports a rootless engine; do not invoke the default Docker daemon for this plan.

---

### Task 1: Pin separate control and financial database identities

**Files:**
- Create: `policy/control-store-policy.json`
- Create: `src/attempts/control-store-policy.mjs`
- Test: `test/attempts/control-store-policy.test.mjs`
- Read-only assertion: `policy/environment-policy.json`

**Interfaces:**
- Produces `loadControlStorePolicy({ policyPath? })`, returning a recursively frozen object with exactly `schemaVersion`, `projectRef`, `region`, `databaseVersion`, `schema`, `roles`, `connection`, and `urlEnvironment`.
- Produces role-specific `parseControlStoreVerifierDatabaseUrl(value, policy)` and `parseControlStoreRuntimeDatabaseUrl(value, policy)`, each bound to its one approved role and returning only `{ projectRef, host, port, database, username, sslMode }`; neither returns the password, original URL, query string, or a driver config containing credentials.
- Refuses invalid values with `ControlStoreRefusal` and fixed codes `control_store_policy_invalid` or `control_store_target_invalid`; refusal text never embeds input values.

- [x] **Step 1: Add failing identity-separation tests**

```js
test('control store cannot substitute for the blocked, unconfigured financial target', async () => {
  const control = await loadControlStorePolicy();
  const financial = JSON.parse(await readFile('policy/environment-policy.json', 'utf8'));
  assert.equal(control.projectRef, 'ceindkuafycqdcplfrgs');
  assert.equal(control.urlEnvironment, 'BILLING_CONTROL_VERIFIER_DATABASE_URL');
  assert.equal(financial.database.projectRef, null);
  assert.equal(financial.database.connection, null);
  assert.equal(isValidStandaloneProjectRef('zjvqjdntasprusoqfsgw'), false);
  assert.notEqual(control.urlEnvironment, 'SUPABASE_VALIDATION_DATABASE_URL');
});
```

- [x] **Step 2: Run the focused test and confirm RED**

Run: `node --test test/attempts/control-store-policy.test.mjs`

Expected: FAIL because the policy loader and control policy do not exist yet; the existing financial policy remains unchanged.

- [x] **Step 3: Add the closed policy and URL validator**

Set the control identity to the approved project, region, PostgreSQL version, schema `billing_validation_control`, owner role `billing_validation_owner`, business role `billing_validation_runtime`, verifier role `billing_validation_verifier`, and `BILLING_CONTROL_VERIFIER_DATABASE_URL`. Bind this URL to the approved project's exact endpoint and verifier username; require TLS and PostgreSQL database `postgres`. Reject the financial project ref, the Preview connection, malformed/duplicate URL parameters, wrong username, wrong port/database, non-TLS, unexpected host, and empty credentials. Keep secrets out of the returned descriptor and refusal messages.

```js
export function parseControlStoreVerifierDatabaseUrl(value, policy = CONTROL_STORE_POLICY) {
  return parseControlStoreDatabaseUrlForRole(value, policy.roles.verifier, policy);
}
export function parseControlStoreRuntimeDatabaseUrl(value, policy = CONTROL_STORE_POLICY) {
  return parseControlStoreDatabaseUrlForRole(value, policy.roles.runtime, policy);
}
```

- [x] **Step 4: Prove rejection and secret redaction**

Add tests for a valid synthetic URL, wrong control ref, forbidden historical `zjvq…` URL, wrong host/user/database/port, missing TLS, hostile URL options, malformed encoding, and a sentinel password. Assert the sentinel appears neither in returned objects nor in thrown `message`, `code`, or serialized error. Assert policy unknown keys and changed project ref fail closed.

- [x] **Step 5: Run tests and inspect only Task 1 paths**

Run: `node --test test/attempts/control-store-policy.test.mjs`

Expected: all Task 1 tests pass; the financial policy remains fail-closed with null project/connection identity, the historical `zjvq…` ref remains rejected by code, and the control URL cannot be substituted for `SUPABASE_VALIDATION_DATABASE_URL`.

- [x] **Step 6: Commit only reviewed Task 1 hunks**

Stage only the new policy/module/test. Confirm `git diff --cached --stat` and `git diff --cached` contain no pre-existing worktree changes, then commit as `feat: bind billing control store identity`.

### Task 2: Make bootstrap exact, one-shot, and digest-pinned

**Files:**
- Modify: `src/attempts/schema.sql`
- Create: `src/attempts/control-store-bootstrap.mjs`
- Create: `src/attempts/control-store-bootstrap-pins.mjs`
- Test: `test/attempts/control-store-bootstrap.test.mjs`
- Modify: `test/attempts/postgres-retention-local.test.mjs`
- Modify: `test/attempts/postgres.test.mjs`

**Interfaces:**
- Produces `loadControlStoreBootstrapPlan({ policy?, baselinePath?, migrationDirectory? })`, returning a frozen `{ projectRef, baselineSha256, baselineSql, migrations, runtimeLogin: false }` after verifying every committed digest and migration order.
- Produces `renderControlStoreBootstrap(plan)`, returning UTF-8 SQL only; it has no database client, network access, environment reads, or apply function.
- The SQL bundle begins a transaction, refuses any non-fresh/partial schema or pre-existing custom role, creates both roles as `NOLOGIN`, creates the private schema owned by `billing_validation_owner`, runs the exact baseline, inserts the project/baseline receipt into `control_store_install_receipts`, applies allowlisted forward migrations, records migration hashes in the `schema_migrations` table created by migration `0001`, and commits once.

- [x] **Step 1: Add failing baseline and renderer contract tests**

```js
test('bootstrap refuses repeatable or destructive baseline constructs', async () => {
  const plan = await loadControlStoreBootstrapPlan();
  assert.doesNotMatch(plan.baselineSql, /\b(?:IF\s+NOT\s+EXISTS|OR\s+REPLACE|DROP\s+TRIGGER|DROP\s+SCHEMA)\b/iu);
  assert.doesNotMatch(plan.baselineSql, /^\s*TRUNCATE\b/imu);
  assert.match(plan.baselineSql, /BEFORE TRUNCATE ON billing_validation_control\.retention_reservations/u);
  const sql = renderControlStoreBootstrap(plan);
  assert.match(sql, /^BEGIN;/u);
  assert.match(sql, /CREATE ROLE billing_validation_owner NOLOGIN/u);
  assert.match(sql, /CREATE ROLE billing_validation_runtime NOLOGIN/u);
  assert.match(sql, /billing_validation_control\.control_store_install_receipts/u);
  assert.match(sql, /billing_validation_control\.schema_migrations/u);
  assert.match(sql, /COMMIT;\s*$/u);
});
```

- [x] **Step 2: Run focused test and confirm RED**

Run: `node --test test/attempts/control-store-bootstrap.test.mjs`

Expected: FAIL on the existing conditional schema/table creation and trigger replacement statements, and because the renderer does not exist; keep append-only truncate guards in the updated contract.

- [x] **Step 3: Convert the baseline to strict first-install DDL**

Remove schema creation from `schema.sql` because the renderer creates it with `AUTHORIZATION billing_validation_owner`; replace every remaining `CREATE ... IF NOT EXISTS` with plain `CREATE`, every `CREATE OR REPLACE` with `CREATE`, and every trigger drop/recreate or dynamic trigger replacement loop with explicit one-shot `CREATE TRIGGER` statements. Preserve all existing `BEFORE TRUNCATE` append-only guards and matching privilege revocations; they prevent truncation and do not execute it. Keep the baseline limited to deterministic objects inside that schema and ensure the local SQL harness creates its temporary namespace before applying the baseline. Do not add cleanup, reset, or data deletion.

- [x] **Step 4: Add the renderer and committed source pins**

Render SQL in this order: `BEGIN`; a preflight `DO` block requiring database `postgres`, operator identity `postgres`, expected PostgreSQL major, absent schema, absent owner/runtime/verifier roles, and no partial baseline marker; create the three roles as `NOLOGIN`; create schema authorized to owner; `SET LOCAL ROLE billing_validation_owner`; execute baseline; insert the project identity and exact baseline digest into `control_store_install_receipts`; execute migrations in ascending allowlisted version order (migration `0001` creates `schema_migrations`); append each migration receipt there; commit. Compute each SHA-256 from final bytes and put the reviewed literals in `control-store-bootstrap-pins.mjs`; the renderer refuses any mismatch. Do not include a password in SQL or enable any login role.

```js
const plan = await loadControlStoreBootstrapPlan();
const sql = renderControlStoreBootstrap(plan);
process.stdout.write(sql);
```

- [x] **Step 5: Test fail-closed rendering**

Test changed baseline bytes, migration file, migration order, unknown SQL, repeat rendering determinism, existing schema/role guard text, no secrets, and absence of destructive `DROP`, `DELETE`, or `TRUNCATE` statements, `CREATE ... IF NOT EXISTS`, or implicit retry. Assert the baseline retains append-only `BEFORE TRUNCATE` guards and matching revocations. Assert importing the module does not read credentials, spawn processes, or access the network.

- [x] **Step 6: Run unit and existing local SQL contract tests**

Run: `node --test test/attempts/control-store-bootstrap.test.mjs test/attempts/postgres-retention-local.test.mjs test/attempts/postgres.test.mjs`

Expected: all pass; existing store tests agree with the one-shot DDL, append-only truncate protections remain present, the local SQL validator still validates the exact checked-in baseline, and the renderer produces identical bytes on repeated runs.

- [x] **Step 7: Commit only Task 2 hunks**

Review the staged diff and commit as `feat: make billing control bootstrap one-shot`.

### Task 3: Enforce append-only runtime data and least-privilege ACLs

**Files:**
- Create: `src/attempts/runtime-privileges.mjs`
- Create: `src/attempts/control-store-migrations/202610010001-standalone-lease-fencing.sql` as an exact byte-for-byte copy of the existing financial-directory migration; do not alter the original.
- Create: `src/attempts/control-store-migrations/202610020001-control-runtime-privileges.sql`
- Modify: `src/attempts/control-store-bootstrap-pins.mjs`
- Modify: `src/attempts/control-store-bootstrap.mjs` only to select the dedicated control-store migration directory
- Modify: `src/attempts/postgres-store.mjs`
- Modify: `test/attempts/control-store-bootstrap.test.mjs`
- Create: `test/attempts/control-store-fixtures.mjs`
- Test: `test/attempts/control-store-privileges.test.mjs`, `test/attempts/postgres.test.mjs`, `test/attempts/concurrency.test.mjs`

**Forward-only boundary:** Task 2 pinned the exact `schema.sql` bytes as the immutable first-install baseline. Do not edit that file or replace its digest/receipt. Keep an exact copy of pinned financial migration `0001` in `src/attempts/control-store-migrations/` for the control bootstrap; assert its bytes match the original financial-directory copy. Ship every Task 3 database change as the one-shot forward migration `0002` in that dedicated directory, append its exact hash to the bootstrap migration pins, and require the ordered `0001` + `0002` chain.

**Migration-directory isolation:** Keep control-store migrations in `src/attempts/control-store-migrations/`, separate from the financial runner's `src/attempts/migrations/`. Point only the control-store bootstrap loader at its dedicated directory and prove the financial loader remains limited to its financial allowlist. Never weaken the financial unknown-file guard or add control-store DDL to its apply plan.

**Interfaces:**
- Produces `CONTROL_RUNTIME_PRIVILEGES`, an immutable explicit allowlist of relation, column, sequence, schema, and verifier-function privileges; it contains no wildcard `ALL` grants.
- Produces `renderControlRuntimeGrants(privileges)`, emitting explicit `REVOKE` then exact `GRANT` statements for `billing_validation_runtime`; it never grants to `PUBLIC`, `anon`, `authenticated`, or `service_role`.
- Keeps mutable current state (`attempts`, current fixture leases, current resource locks) separate from append-only attempt/lease history, reservations, claims, intents, receipts, and migration history.

- [ ] **Step 1: Add failing SQL-operation inventory tests**

```js
test('runtime privilege allowlist has no mutation rights on append-only ledgers', () => {
  const acl = CONTROL_RUNTIME_PRIVILEGES;
  for (const table of ['schema_migrations', 'control_store_install_receipts', 'fixture_lease_history', 'fixture_reservation_claim_events', 'retention_reservations',
    'retention_receipts', 'cleanup_receipts', 'fixture_case_claims', 'fixture_resource_claims',
    'stripe_intents', 'stripe_receipts']) {
    assert.equal(acl.tables[table]?.update, undefined);
    assert.equal(acl.tables[table]?.delete, undefined);
    assert.equal(acl.tables[table]?.truncate, undefined);
  }
});
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `node --test test/attempts/control-store-privileges.test.mjs`

Expected: FAIL because the explicit privilege inventory and final role grants do not exist.

- [ ] **Step 3: Derive an operation-to-column matrix from the store SQL**

Inventory each query in `postgres-store.mjs` and map it to only the required table and columns. Preserve the current state upserts for attempts/leases/locks, grant UPDATE only for columns assigned by those statements, and grant only required sequence use. Give append-only relations only SELECT/INSERT. Give runtime no privileges on `schema_migrations`. Do not use schema-wide, table-wide, default, or role-membership grants as a shortcut.

- [ ] **Step 4: Remove row-lock requirements from immutable relations**

Replace `FOR UPDATE` / `FOR UPDATE OF` on immutable reservations, case claims, cleanup receipts, Stripe intents, and Stripe receipts. Serialize only operations whose current-state invariants require it with a transaction advisory lock keyed by the relevant attempt/reservation/intent, then read again under that lock. Keep row locks only on mutable current-state tables. Retain the existing concurrency/fencing contract and do not add UPDATE privileges to immutable history to make row locking pass.

- [ ] **Step 5: Make fixture-reservation usage history append-only**

The current `setRetentionFixtureRowsUsed` uses `ON CONFLICT DO UPDATE` on `fixture_reservation_claims`, which conflicts with the approved append-only claims contract. Add `fixture_reservation_claim_events` with immutable event identity, reservation/attempt, previous and new row counts, and timestamp. Serialize a claim by reservation ID, verify the last recorded count equals `expectedRows`, then INSERT the next event; reject stale or duplicate transitions. Change readers to derive the current count from the latest valid event, and do not grant runtime UPDATE/DELETE on the legacy single-row table. Preserve its rows during migration; never reset or delete them.

- [ ] **Step 6: Add role and negative-operation PostgreSQL tests**

Test owner is `NOLOGIN` and schema/object owner; runtime is not owner/member and has no elevated role attributes; exact SELECT/INSERT/column-UPDATE/DELETE/sequence/function rights match the manifest; runtime operations required by the store succeed; runtime cannot create/alter schema objects, alter or disable triggers, write/read the migration ledger, update/delete/truncate append-only history, or access these tables as `anon`, `authenticated`, `service_role`, or `PUBLIC`. Assert no default ACL expands future grants.

- [ ] **Step 7: Prove migration-directory isolation and run focused behavior/concurrency regressions**

Assert the control bootstrap loads exactly its pinned dedicated migration list, the control-store `0001` bytes match the financial original, and the financial `loadAttemptMigrationPlan()` still sees only its financial allowlist; an unrecognized file in either directory remains a fail-closed error.

Run: `node --test test/attempts/control-store-privileges.test.mjs test/attempts/postgres.test.mjs test/attempts/concurrency.test.mjs`

Expected: all tests pass, including stale reservation count rejection and existing lease-fencing/concurrency behavior.

- [ ] **Step 8: Commit only Task 3 hunks**

Review the staged ACL and SQL diff carefully and commit as `feat: enforce append-only control store access`.

### Task 4: Separate operator migrations from runtime and add read-only integrity proof

**Files:**
- Modify: `src/attempts/migrations.mjs`
- Create: `src/attempts/control-store-verifier.mjs`
- Create: `src/attempts/control-store-migrations/202610030001-control-store-verifier.sql`
- Modify: `src/attempts/control-store-bootstrap-pins.mjs` to append the exact `0003` digest
- Modify: `src/attempts/control-store-bootstrap.mjs`
- Modify: `src/attempts/postgres-store.mjs`
- Modify: `test/attempts/control-store-bootstrap.test.mjs`
- Create: `test/attempts/control-store-verifier.test.mjs`
- Modify: `test/attempts/migrations.test.mjs`, `test/attempts/postgres.test.mjs`

**Interfaces:**
- `loadAttemptMigrationPlan()` and `validateAppliedAttemptMigrations(plan, applied)` remain pure offline functions for the existing financial/attempt allowlist. Do not make that loader discover control-store migrations.
- `renderControlStoreMigrationBundle({ policy, baselineSha256, migrations, applied })` consumes the exact control-store migration chain loaded from `loadControlStoreBootstrapPlan()`, validates the control policy, baseline, pins, and the already-applied ordered prefix, then returns only pending control-store forward migrations for an operator to review/apply. It cannot open a client or contact Supabase.
- The read-only verifier is installed by pinned migration `202610030001-control-store-verifier.sql`; a new forward-only migration `202610040001-control-verifier-role.sql` transfers function execution from runtime to verifier. Preserve the exact existing `0001`, `0002`, and `0003` bytes and hashes.
- Keep the business runtime role `billing_validation_runtime` as `NOLOGIN`. The separate `billing_validation_verifier` role is also `NOLOGIN` at bootstrap; only a later, separately gated Task 7 handoff may enable it for the protected read-only verifier. The local PostgreSQL verifier test may emulate `session_user`/`current_user` only inside the disposable local database using its superuser and transaction-local `SET SESSION AUTHORIZATION billing_validation_verifier`; never connect remotely or change the role in Supabase as part of local implementation.
- `test/attempts/control-store-fixtures.mjs` exports `testControlPolicy()` and `testBaselineDigest()` using fixed synthetic identities and a computed digest only for tests.
- `verifyAttemptControlStore({ queryClient, policy, target })` performs read-only SQL checks only through the protected verifier connection and returns a frozen safe receipt containing project ref, database, verifier role, server version, baseline/migration digests, and privilege-fingerprint digest. `target` is the redacted descriptor parsed by the verifier-specific URL parser.
- Every business-store transaction uses the runtime-specific URL parser and first checks the checked-out runtime connection's database, `session_user`, `current_user`, role setting, and server version. It never executes the verifier-only function. The protected verifier job separately attests schema, grants, and migration hashes; this is not a same-transaction guarantee. The existing `preflight`/`target` remains the independently verified financial Preview identity and is never compared to the control DB as though they were the same project. The runtime role remains `NOLOGIN`, so this gate does not activate remote store operations.

- [ ] **Step 1: Add failing tests proving migration code cannot apply DDL**

```js
test('migration plan import and rendering cannot connect or execute SQL', async () => {
  const controlPlan = await loadControlStoreBootstrapPlan();
  const bundle = renderControlStoreMigrationBundle({ policy: testControlPolicy(),
    baselineSha256: controlPlan.baselineSha256, migrations: controlPlan.migrations,
    applied: controlPlan.migrations.slice(0, 2).map(({ version, name, sha256 }) => ({ version, name, sha256 })) });
  const migrations = await import('../../src/attempts/migrations.mjs');
  assert.equal('applyAttemptMigrations' in migrations, false);
  assert.match(bundle, /202610030001/u);
  assert.doesNotMatch(bundle, /\b(?:DROP|DELETE|TRUNCATE)\b/iu);
});
```

- [ ] **Step 2: Run migration tests and confirm RED**

Run: `node --test test/attempts/migrations.test.mjs test/attempts/control-store-verifier.test.mjs`

Expected: FAIL because `applyAttemptMigrations` currently performs remote work, the control-only pending-migration renderer is absent, and the pinned verifier migration does not exist.

- [ ] **Step 3: Remove remote migration application from runtime code**

Delete `applyAttemptMigrations` and `installAttemptSchema` from the runtime store API. Remove management-token and `SUPABASE_VALIDATION_DATABASE_URL` reads from control-store migration code. Keep the existing financial `loadAttemptMigrationPlan()` allowlist, SQL scanning, digests, ordering, and applied-history validation pure and isolated. Add the separate operator renderer over the pinned control-store chain; it emits only pending migrations after an exact applied prefix and never imports financial migrations as control DDL.

- [ ] **Step 4: Add a bounded read-only database verifier**

Keep migration `202610030001-control-store-verifier.sql` immutable and add a forward-only `202610040001-control-verifier-role.sql` migration; append only the latter's exact digest to `CONTROL_STORE_BOOTSTRAP_PINS`. The owner-owned, fixed-search-path, read-only function exposes only the control project sentinel, server identity/version, runtime and verifier role flags/membership, schema owner, baseline/migration digest summary, and canonical privilege fingerprint. It does not return rows, credentials, SQL, or financial values and does not grant runtime access to `schema_migrations`. The new migration revokes function `EXECUTE` from `billing_validation_runtime` and grants it only to `billing_validation_verifier`; tests prove no writes and no caller-supplied SQL/role changes. Preserve exact hashes for already-pinned `0001`, `0002`, and `0003` migrations.

- [ ] **Step 5: Bind every transaction to the control store before work**

At the first query inside each `client.transaction`, validate the runtime connection URL against the exact runtime role and compare the SQL session identity with the pinned database, `session_user`, `current_user`, no active `SET ROLE`, and PostgreSQL version. Any missing, extra, ambiguous, or mismatched session data throws a fixed refusal before store work. Do not invoke `verify_attempt_control_store()` from this transaction: that function is executable only by the separate verifier role. The protected read-only job compares the verifier receipt with exact project/database identity, verifier role, ownership, role flags, effective grants, migration digests, and privilege fingerprint. This verifier and runtime operation are separate gates, not an atomic same-transaction proof; runtime stays `NOLOGIN` and business mutations remain disabled until a separately approved runtime-activation design. Continue to validate `preflight.expectedEnvironment.database.projectRef` and `target.projectRef` independently from the control receipt; until a new safe financial target is approved and pinned, those paths must fail closed and must never fall back to the control project or `zjvq…`.

- [ ] **Step 6: Prove wrong identity and migration drift fail before writes**

Add verifier tests for wrong project sentinel, wrong host/database/session role, owner login/membership, elevated runtime or verifier flags, changed baseline/migration hash, unknown forward migration, missing verifier function, extra grant to either role, verifier timeout/error, and control DB equal to the financial target. These verifier tests prove refusal and safe diagnostics without any write path. Separately test the runtime adapter's database/session/current-role/role-setting/version matrix and assert no store INSERT/UPDATE/DELETE/provider callback occurs before a valid runtime session is established. Do not connect the runtime to the verifier function.

For the PostgreSQL 17 probe, assert the fresh bootstrap leaves both service identities NOLOGIN. Exercise runtime SQL under `SET SESSION AUTHORIZATION billing_validation_runtime`; for an end-to-end verifier-authentication proof, enable LOGIN and use a generated synthetic credential only inside the disposable local container, authenticate as `billing_validation_verifier`, and assert it can call only the fixed verifier. No remote LOGIN/password or Supabase/Vercel connection is allowed in this task.

- [ ] **Step 7: Run migration and store tests**

Run: `node --test test/attempts/migrations.test.mjs test/attempts/control-store-bootstrap.test.mjs test/attempts/control-store-verifier.test.mjs test/attempts/postgres.test.mjs`

Expected: the financial migration scanner remains limited to its exact allowlist; the control renderer uses only the exact control-store chain and returns pending forward SQL; there is no executable migration path in the runtime store; the runtime adapter rejects wrong sessions before store work, while the separate protected verifier proves the full control-store identity/ACL/migration fingerprint. No remote mutation is enabled by these checks.

- [ ] **Step 8: Preserve Task 4 hunks for final integration review**

Do not stage or commit during the local-only task sequence. Preserve a scoped snapshot for review; after all tasks and the whole-branch review, resolve staging/commit with the user. No push or PR is implied.

### Task 5: Wire the protected GitHub verifier without exposing secrets to PR code

**Files:**
- Modify: `.github/workflows/validate-billing.yml`
- Modify: `policy/control-store-policy.json`, `src/attempts/control-store-policy.mjs`
- Modify: `src/attempts/control-store-bootstrap.mjs` and `src/attempts/control-store-bootstrap-pins.mjs`
- Modify: `src/attempts/control-store-verifier.mjs` and `src/attempts/control-store-migrations/202610030001-control-store-verifier.sql`
- Create: `src/attempts/control-store-migrations/202610040001-control-verifier-role.sql`
- Create: `runner/verify-control-store.mjs`
- Create: `test/attempts/control-store-runtime.test.mjs`
- Modify: `test/attempts/control-store-policy.test.mjs`, `test/attempts/control-store-bootstrap.test.mjs`, `test/attempts/control-store-verifier.test.mjs`, and `test/attempts/control-store-fixtures.mjs`
- Create: `test/workflows/control-store-boundary.test.mjs`
- Modify: `test/workflows/secret-boundary.mjs`, `test/workflows/workflow-policy.test.mjs`, `test/workflows/lint-workflows.mjs`, and `test/workflows/task4-workflow.test.mjs`
- Modify: `package.json` test script registration

**Interfaces:**
- `runner/verify-control-store.mjs` requires `BILLING_CONTROL_VERIFIER_DATABASE_URL`, validates the exact approved control identity and verifier username, creates a PostgreSQL client with certificate verification and exact host SNI, and calls the bounded verifier as a read-only transaction. Missing or malformed configuration fails before the client connects; errors and stdout contain only fixed refusal codes and the safe verifier receipt.
- Protected control-check job reads only `secrets.BILLING_CONTROL_VERIFIER_DATABASE_URL` from Environment `billing-validation-control` and invokes this fixed repository-owned verifier; PR/candidate code never runs in the credentialed job.
- PR policy, build, candidate Preview, and untrusted artifact jobs receive no control URL, management token, owner password, or `postgres` credential.
- The trusted job has no migration/apply step, performs no writes or financial provider calls, and cannot publish the database URL as an output/artifact. This gate proves control endpoint/identity only; it does not prove the 43 financial cases or exercise mutating `PostgresAttemptStore` operations. Those remain blocked until a separately approved financial runner and remote gates exist.

- [ ] **Step 1: Add failing workflow boundary tests**

Add a verifier test that proves absent credentials refuse before the PostgreSQL client is constructed, only the verifier username/environment are accepted, exact target/SNI configuration is used, and import has no connection side effects. Add workflow assertions for the protected verifier job and the exact one-job secret boundary.

```js
test('candidate and pull-request jobs never receive the control database URL', () => {
  const workflow = readYaml('.github/workflows/validate-billing.yml');
  assert.equal(jobHasSecret(workflow.jobs.policy, 'BILLING_CONTROL_VERIFIER_DATABASE_URL'), false);
  assert.equal(candidateJobs(workflow).some(job => jobHasSecret(job, 'BILLING_CONTROL_VERIFIER_DATABASE_URL')), false);
  assert.equal(workflowUsesMigrationExecutor(workflow), false);
});
```

- [ ] **Step 2: Run workflow tests and confirm RED**

Run: `node --test test/attempts/control-store-runtime.test.mjs test/workflows/control-store-boundary.test.mjs test/workflows/workflow-policy.test.mjs`

Expected: FAIL on missing explicit control-store boundary assertions.

- [ ] **Step 3: Add a dedicated protected verifier environment gate**

Bind the trusted read-only control-store check job to `billing-validation-control`, require protected `main`/trusted dispatch context before the job, and conditionally include this environment in the authorization preflight for `collect`. Require a protected environment with a required reviewer without embedding any reviewer login/ID. If reviewer protection or the secret is missing, the job must fail closed before connecting. The read-only check cannot access Preview/Stripe and does not invoke candidate code.

- [ ] **Step 4: Remove migration and privileged-secret paths from workflow**

Remove runtime calls to `installAttemptSchema`/`applyAttemptMigrations`, management API token exposure, owner/`postgres` credentials, and any DDL command. Keep `SUPABASE_VALIDATION_DATABASE_URL` only on the separately scoped financial validation job. Ensure no output, artifact, debug log, matrix value, or candidate-controlled action receives either database URL.

Install dependencies without lifecycle scripts, run only the repository-owned verifier, and pass the verifier URL only through that job's process environment. It runs a read-only transaction and emits no output containing the URL, password, or SQL error text.

- [ ] **Step 5: Expand mutation-based secret-boundary tests**

Test hostile workflow changes: adding the control URL to PR/build/Preview, forwarding it through job outputs, invoking the migration renderer as SQL execution, adding a management token, broadening `permissions`, removing protected environment/reviewer preflight, or replacing the trusted branch/SHA guard. Test runtime refusal for missing URL and no connection before identity/TLS validation. Each mutation must make the test fail.

- [ ] **Step 6: Run all workflow policy checks**

Run: `pnpm lint:workflows && pnpm check:secret-boundary && node --test test/attempts/control-store-runtime.test.mjs test/workflows/control-store-boundary.test.mjs test/workflows/workflow-policy.test.mjs test/workflows/reader-boundary.test.mjs`

Expected: all pass; PR checks remain credential-free and the only workflow reference to `BILLING_CONTROL_VERIFIER_DATABASE_URL` is the protected trusted verifier job plus its boundary tests. Also run and keep `test/workflows/task4-workflow.test.mjs` aligned with the current dispatch/Environment graph.

- [ ] **Step 7: Preserve Task 5 changes for final integration review**

Do not stage or commit during the local-only task sequence. Review workflow permissions, conditions, and secret references in a scoped snapshot; resolve staging/commit after all tasks and the whole-branch review. No push or PR is implied.

### Task 6: Prove schema, grants, recovery, and concurrency on disposable PostgreSQL 17

**Files:**
- Create: `scripts/test-billing-control-store-postgres.mjs`
- Create: `test/attempts/control-store-postgres.integration.test.mjs`
- Modify: `package.json`
- Modify: `test/attempts/postgres-retention-local.test.mjs`

**Interfaces:**
- Adds `pnpm test:billing-control-store:db`, which creates one uniquely named, labeled disposable PostgreSQL 17 container through `docker --context billing-validation-isolated`, waits for health, runs the integration suite, and removes only that exact container in `finally`.
- The harness binds only an ephemeral localhost port, uses a generated test-only credential passed via process environment, never prints a DSN/password, never mounts host paths, and never connects to Supabase, Vercel, Stripe, the default Docker context, or existing containers.
- The harness resolves the `billing-validation` UID using `getent passwd` and refuses unless the Docker context endpoint is `/run/user/<uid>/docker.sock` for that account, the daemon is rootless, the context is available, the label/name is not owned by another container, and the host port is loopback-only.

- [ ] **Step 1: Add failing harness safety tests**

Test that non-isolated/default Docker context, non-rootless endpoint, foreign container label, non-loopback publish address, failed health check, timeout, and interrupted test cause a nonzero result and remove only the exact test-run container. Test harness output contains neither generated password nor full DSN.

- [ ] **Step 2: Add PostgreSQL integration assertions**

Run the rendered bootstrap once in a fresh PostgreSQL 17 database and assert success. Run it a second time and against a deliberately partial baseline; both must fail and preserve the prior schema byte-for-byte. Apply forward migrations and assert exact digest/order. Exercise all business-store operations and forbidden operations using `SET ROLE billing_validation_runtime`; verify owner/runtime/verifier flags, ownership, memberships, ACLs, migration hashes, schema fingerprint, and default privileges as the local test administrator. Prove the verifier has no direct table/sequence privileges and can call only the fixed read-only function. Keep bootstrap verifier state NOLOGIN; if testing credential activation, enable LOGIN and use a generated test-only credential only in the disposable PostgreSQL container. Verify that a deliberately failed SQL statement rolls back the entire bootstrap transaction, leaving no roles, schema, receipt, or migration row behind.

- [ ] **Step 3: Prove failure and recovery semantics**

Run two simultaneous attempts against the same key and verify one owner/fence wins; test stale fence, lease expiry/takeover, append-only claim event serialization, ambiguous transaction outcome, retained recovery marker, and verifier drift. Assert recovery never applies DDL, clears append-only rows, or turns an earlier failure into PASS.

- [ ] **Step 4: Run the isolated PostgreSQL integration harness**

Run: `pnpm test:billing-control-store:db`

Expected: all PostgreSQL 17 integration assertions pass; output reports the run ID, container outcome, test counts, and sanitized refusal codes only.

- [ ] **Step 5: Run all existing control and billing contract tests**

Run: `pnpm test:task7 && pnpm test:task6 && pnpm test:task5 && pnpm test:task4 && pnpm test:billing-43`

Expected: all previously green billing attempt, recovery, append-only, financial-contract, fixture, and scenario tests remain green; any skipped remote proof is explicitly reported as pending, not as success.

- [ ] **Step 6: Run the full repository suite and static checks**

Run: `pnpm test && pnpm lint:workflows && pnpm check:secret-boundary && git diff --check`

Expected: zero failures; no newly introduced skipped test is presented as verified. Review any pre-existing skip separately and report it.

- [ ] **Step 7: Commit only Task 6 harness and tests**

Review Docker invocation and cleanup code for exact-container scope, then commit as `test: verify isolated billing control store on postgres 17`.

### Task 7: Document operator rollout gates and perform final independent review

**Files:**
- Create: `docs/billing-validation-control-store.md`
- Review: all files changed in Tasks 1–6

**Interfaces:**
- Runbook distinguishes offline tests, local PostgreSQL proof, remote control-store proof, financial Preview proof, and production release approval.
- Remote installation instructions require a read-only Supabase MCP readback of exact project ref/health before applying the digest-verified SQL bundle; they require a second independent readback after commit.
- Runbook leaves business runtime login disabled and verifier login disabled until the reviewer identity and protected `billing-validation-control` Environment are configured and independently verified.

- [ ] **Step 1: Write the non-secret operator runbook**

Document the exact generated bootstrap/migration verification commands, expected project ref, role/schema names, hash readback, post-apply ACL checks, and failure behavior for ambiguous MCP results. State explicitly: never rerun the bootstrap, never reset, and never repair with destructive SQL; inspect read-only and prepare a new reviewed forward migration instead.

- [ ] **Step 2: Document credential handoff without exposing values**

Specify that the operator may enable only `billing_validation_verifier` for LOGIN after role/grant verification and the protected-environment/reviewer gate; provision its URL only through the protected GitHub Environment. Keep `billing_validation_runtime` NOLOGIN and do not install its credential through this verifier workflow. Never use chat, SQL literals, command-line arguments, `.env.local`, Vercel, candidate artifacts, or workflow outputs. If the secure handoff or reviewer allowlist is unavailable, retain NOLOGIN and stop.

- [ ] **Step 3: Run TestSprite preflight only for applicable UI coverage**

Run: `testsprite --version && testsprite auth status`; resolve the project by the documented environment/config/list order. This change is backend database/CI infrastructure and does not modify a browser flow, so do not create a fake frontend test or spend remote-run credits. Report TestSprite as not applicable to this control-store proof unless an existing relevant UI case is identified; the PostgreSQL and workflow tests are the authoritative tests for this change.

- [ ] **Step 4: Perform final independent review**

Run `git diff --check`, inspect every final diff, verify the two Supabase refs and URL names remain separate, verify the control URL is absent from candidate/Preview code, verify the only bootstrap is operator-rendered SQL, and verify no remote mutation or production resource was touched. Run the full commands from Task 6 again after any review fix.

- [ ] **Step 5: Record truthful release status**

Report local code status separately from remote status. Remote control-store rollout remains pending until: reviewer identity supplied; GitHub Environment protection verified; operator applies SQL to `ceindkuafycqdcplfrgs` via Supabase MCP; second readback confirms roles/ACLs/hashes; the verifier credential is securely provisioned; and the protected workflow passes. The business runtime stays NOLOGIN under this read-only gate. Financial Preview proof is a separate blocked track until a safe, distinct financial validation project is user-approved and provisioned. Do not mark production-ready based only on this plan or local tests.

- [ ] **Step 6: Commit only Task 7 documentation**

Stage only the runbook/spec-review changes and commit as `docs: document billing control store rollout gates`.

## Plan Self-Review

- **Spec coverage:** Identity separation is Task 1; one-shot/digest-pinned bootstrap and forward migrations are Task 2; NOLOGIN roles and least-privilege/append-only behavior are Task 3; no runtime DDL and read-only identity/hash verification are Task 4; protected-secret boundary is Task 5; PostgreSQL 17, ACL, concurrency, and recovery proof is Task 6; manual remote rollout and explicit non-claims are Task 7.
- **Placeholder scan:** There are no TODO/TBD implementation steps, invented reviewer IDs, secret values, or claimed migration digests. Digests are calculated from final bytes and committed as exact literals during Task 2.
- **Interface consistency:** Tasks 1–4 define the policy, plan, renderer, privilege manifest, verifier, and transaction boundary consumed by Tasks 5–6. The control URL and financial URL remain separate in every task.
- **Worktree safety:** All existing modified files are preserved; task commits stage only reviewed hunks. No remote environment or production action is part of this plan.
