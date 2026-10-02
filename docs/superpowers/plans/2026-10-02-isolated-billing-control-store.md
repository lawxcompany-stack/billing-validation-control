# Isolated Billing Control Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a separately identified, least-privilege Supabase control store for trusted billing-validation attempts without changing the existing Preview financial database or any production system.

**Architecture:** Use `ceindkuafycqdcplfrgs` only for control-plane attempts, leases, reservations, intents, and receipts. The financial database policy is currently deliberately unconfigured (`projectRef` and `connection` are `null`). The previously named `zjvqjdntasprusoqfsgw` is in the application's immutable protected/historical-target denylist and is not present in the currently accessible Supabase project inventory; it must not be re-enabled or queried as a financial target. A new financial validation target requires a separate user-approved provisioning decision and cost confirmation. Install the control schema through a digest-pinned, operator-rendered, one-time SQL bundle; CI receives only the runtime URL and performs identity/integrity verification plus narrowly granted operations. Validate the complete role, migration, concurrency, and failure contract in a disposable PostgreSQL 17 container on the dedicated rootless Docker context.

**Tech Stack:** Node.js 22 ESM, `node:test`, PostgreSQL 17, Supabase MCP for a separately gated operator rollout, GitHub Actions, pnpm, and Docker context `billing-validation-isolated`.

**Spec:** `docs/superpowers/specs/2026-10-02-isolated-billing-control-store-design.md`, approved by the user on 2026-10-02.

## Global Constraints

- Control project identity is `ceindkuafycqdcplfrgs`, region `sa-east-1`, PostgreSQL `17.11`; it stores no customer or financial-fixture data.
- The financial validation target is not currently configured. `zjvqjdntasprusoqfsgw` is denylisted as a protected/historical target and Supabase returned `Project not found`; do not connect to it or change the denylist. `SUPABASE_VALIDATION_DATABASE_URL` remains separate from the control URL and must stay unusable until a distinct target is approved and provisioned.
- The only control connection setting is `BILLING_CONTROL_DATABASE_URL`; it is never passed to candidate-controlled jobs, the application, Vercel, artifacts, or logs.
- Supabase main/production, unrelated Supabase projects, Vercel Production, Stripe Live, and unrelated Docker containers and volumes are out of scope.
- The Supabase `postgres` credential, Supabase management token, and owner/migrator authority never enter CI, candidate jobs, the application, Vercel, command arguments, shell history, artifacts, or chat.
- `billing_validation_owner` remains `NOLOGIN`; `billing_validation_runtime` remains `NOLOGIN` until the separate protected-environment and secure-secret gates are confirmed.
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
- `src/attempts/postgres-store.mjs`: uses the control connection for the attempt store, checks control identity at the start of each transaction, preserves separate Preview-target proof, and never installs schema.
- `src/attempts/migrations/202610010001-standalone-lease-fencing.sql`: preserve as a pinned forward migration once the new-project install is frozen; add `202610020001-control-runtime-privileges.sql` for runtime roles, verifier, and append-only claim changes. Migration `0001` creates `schema_migrations`; the baseline receipt must therefore live in `control_store_install_receipts`, not in a table that migration `0001` creates.
- `.github/workflows/validate-billing.yml`: only a protected trusted job can receive `BILLING_CONTROL_DATABASE_URL`; PR policy checks remain credential-free and runtime jobs cannot apply migrations.
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
- Produces `parseControlStoreDatabaseUrl(value, policy)`, returning only `{ projectRef, host, port, database, username, sslMode }`; it never returns the password, original URL, query string, or a driver config containing credentials.
- Refuses invalid values with `ControlStoreRefusal` and fixed codes `control_store_policy_invalid` or `control_store_target_invalid`; refusal text never embeds input values.

- [x] **Step 1: Add failing identity-separation tests**

```js
test('control store cannot substitute for the blocked, unconfigured financial target', async () => {
  const control = await loadControlStorePolicy();
  const financial = JSON.parse(await readFile('policy/environment-policy.json', 'utf8'));
  assert.equal(control.projectRef, 'ceindkuafycqdcplfrgs');
  assert.equal(control.urlEnvironment, 'BILLING_CONTROL_DATABASE_URL');
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

Set the control identity to the approved project, region, PostgreSQL version, schema `billing_validation_control`, owner role `billing_validation_owner`, runtime role `billing_validation_runtime`, and `BILLING_CONTROL_DATABASE_URL`. Bind the URL to the approved project's exact endpoint and runtime username; require TLS and PostgreSQL database `postgres`. Reject the financial project ref, the Preview connection, malformed/duplicate URL parameters, wrong username, wrong port/database, non-TLS, unexpected host, and empty credentials. Keep secrets out of the returned descriptor and refusal messages.

```js
export function parseControlStoreDatabaseUrl(value, policy = CONTROL_STORE_POLICY) {
  const parsed = parseAndValidateExactControlTarget(value, policy);
  return Object.freeze({ projectRef: policy.projectRef, host: parsed.host, port: parsed.port,
    database: parsed.database, username: parsed.username, sslMode: parsed.sslMode });
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

Render SQL in this order: `BEGIN`; a preflight `DO` block requiring database `postgres`, operator identity `postgres`, expected PostgreSQL major, absent schema, absent owner/runtime roles, and no partial baseline marker; create `NOLOGIN` roles; create schema authorized to owner; `SET LOCAL ROLE billing_validation_owner`; execute baseline; insert the project identity and exact baseline digest into `control_store_install_receipts`; execute migrations in ascending allowlisted version order (migration `0001` creates `schema_migrations`); append each migration receipt there; commit. Compute each SHA-256 from final bytes and put the reviewed literals in `control-store-bootstrap-pins.mjs`; the renderer refuses any mismatch. Do not include a password in SQL or enable runtime login.

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
- Create: `src/attempts/migrations/202610020001-control-runtime-privileges.sql`
- Modify: `src/attempts/postgres-store.mjs`
- Modify: `src/attempts/schema.sql`
- Create: `test/attempts/control-store-fixtures.mjs`
- Test: `test/attempts/control-store-privileges.test.mjs`, `test/attempts/postgres.test.mjs`, `test/attempts/concurrency.test.mjs`

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

- [ ] **Step 7: Run focused behavior and concurrency regressions**

Run: `node --test test/attempts/control-store-privileges.test.mjs test/attempts/postgres.test.mjs test/attempts/concurrency.test.mjs`

Expected: all tests pass, including stale reservation count rejection and existing lease-fencing/concurrency behavior.

- [ ] **Step 8: Commit only Task 3 hunks**

Review the staged ACL and SQL diff carefully and commit as `feat: enforce append-only control store access`.

### Task 4: Separate operator migrations from runtime and add read-only integrity proof

**Files:**
- Modify: `src/attempts/migrations.mjs`
- Create: `src/attempts/control-store-verifier.mjs`
- Modify: `src/attempts/control-store-bootstrap.mjs`
- Modify: `src/attempts/postgres-store.mjs`
- Create: `test/attempts/control-store-verifier.test.mjs`
- Modify: `test/attempts/migrations.test.mjs`, `test/attempts/postgres.test.mjs`

**Interfaces:**
- `loadAttemptMigrationPlan()` and `validateAppliedAttemptMigrations(plan, applied)` remain pure offline functions.
- `renderControlStoreMigrationBundle({ policy, baselineSha256, migrations, applied })` returns SQL for an operator to review/apply; it cannot open a client or contact Supabase.
- `test/attempts/control-store-fixtures.mjs` exports `testControlPolicy()` and `testBaselineDigest()` using fixed synthetic identities and a computed digest only for tests.
- `verifyAttemptControlStore({ queryClient, policy, target })` performs read-only SQL checks on the same checked-out transaction client and returns a frozen safe identity receipt containing project ref, database, role, server version, baseline/migration digests, and privilege-fingerprint digest only. `target` is the redacted connection descriptor parsed from the exact URL passed to the database client.
- Every store transaction applies transaction options, then runs this verifier before any other store query or mutation; the existing `preflight`/`target` remains the independently verified financial Preview identity and is never compared to the control DB as though they were the same project.

- [ ] **Step 1: Add failing tests proving migration code cannot apply DDL**

```js
test('migration plan import and rendering cannot connect or execute SQL', async () => {
  const plan = await loadAttemptMigrationPlan();
  const bundle = renderControlStoreMigrationBundle({ policy: testControlPolicy(),
    baselineSha256: testBaselineDigest(), migrations: plan, applied: [] });
  const migrations = await import('../../src/attempts/migrations.mjs');
  assert.equal('applyAttemptMigrations' in migrations, false);
  assert.match(bundle, /202610010001/u);
});
```

- [ ] **Step 2: Run migration tests and confirm RED**

Run: `node --test test/attempts/migrations.test.mjs test/attempts/control-store-verifier.test.mjs`

Expected: FAIL because `applyAttemptMigrations` currently performs remote work and the verifier is absent.

- [ ] **Step 3: Remove remote migration application from runtime code**

Delete `applyAttemptMigrations` and `installAttemptSchema` from the runtime store API. Remove management-token and `SUPABASE_VALIDATION_DATABASE_URL` reads from control-store migration code. Keep SQL scanning, allowlist, digest, order, and applied-history validation pure; add the operator renderer that produces reviewed SQL only.

- [ ] **Step 4: Add a bounded read-only database verifier**

Add an owner-owned, fixed-search-path, read-only verifier function that exposes only the control project sentinel, server identity/version, runtime role flags/membership, schema owner, baseline/migration digest summary, and a canonical privilege fingerprint. It does not return rows, credentials, SQL, or financial values and does not grant runtime access to `schema_migrations`. Grant `EXECUTE` only to `billing_validation_runtime`; test that the function performs no writes and cannot be used to set role or run caller-supplied SQL.

- [ ] **Step 5: Bind every transaction to the control store before work**

At the first query inside each `client.transaction`, validate the connection URL against the control policy, then compare the SQL verifier receipt with exact project ref, database, role, PostgreSQL version, ownership, role flags, digests, and privilege fingerprint. Any missing/extra/ambiguous state throws a fixed refusal before fixture/provider work. Continue to validate `preflight.expectedEnvironment.database.projectRef` and `target.projectRef` independently from the control receipt; until a new safe financial target is approved and pinned, those paths must fail closed and must never fall back to the control project or `zjvq…`.

- [ ] **Step 6: Prove wrong identity and migration drift fail before writes**

Add tests for wrong project sentinel, wrong host, database, current/session user, owner login, owner membership, elevated runtime flags, changed baseline/migration hash, unknown forward migration, missing verifier function, extra grant, verifier timeout/error, and control DB equal to financial target. Each refusal test asserts no store INSERT/UPDATE/DELETE/provider call occurred and no URL/password appears in diagnostics.

- [ ] **Step 7: Run migration and store tests**

Run: `node --test test/attempts/migrations.test.mjs test/attempts/control-store-verifier.test.mjs test/attempts/postgres.test.mjs`

Expected: migration scanning remains green; there is no executable migration path in the runtime store; every remote-style mutation is preceded by the same-transaction identity verifier.

- [ ] **Step 8: Commit only Task 4 hunks**

Review staged changes for connection-boundary regressions and commit as `refactor: separate control migrations from runtime access`.

### Task 5: Wire the protected GitHub runtime without exposing secrets to PR code

**Files:**
- Modify: `.github/workflows/validate-billing.yml`
- Create: `test/workflows/control-store-boundary.test.mjs`
- Modify: `test/workflows/secret-boundary.mjs`, `test/workflows/workflow-policy.test.mjs`, and `test/workflows/lint-workflows.mjs`
- Modify: `package.json` test script registration

**Interfaces:**
- Protected runtime job reads only `secrets.BILLING_CONTROL_DATABASE_URL` from Environment `billing-validation-control` and uses the runtime role.
- PR policy, build, candidate Preview, and untrusted artifact jobs receive no control URL, management token, owner password, or `postgres` credential.
- The trusted job can verify identity and use the store but has no migration/apply step, and cannot publish the database URL as an output/artifact.

- [ ] **Step 1: Add failing workflow boundary tests**

```js
test('candidate and pull-request jobs never receive the control database URL', () => {
  const workflow = readYaml('.github/workflows/validate-billing.yml');
  assert.equal(jobHasSecret(workflow.jobs.policy, 'BILLING_CONTROL_DATABASE_URL'), false);
  assert.equal(candidateJobs(workflow).some(job => jobHasSecret(job, 'BILLING_CONTROL_DATABASE_URL')), false);
  assert.equal(workflowUsesMigrationExecutor(workflow), false);
});
```

- [ ] **Step 2: Run workflow tests and confirm RED**

Run: `node --test test/workflows/control-store-boundary.test.mjs test/workflows/workflow-policy.test.mjs`

Expected: FAIL on missing explicit control-store boundary assertions.

- [ ] **Step 3: Add a dedicated protected runtime environment gate**

Bind the trusted database-store job to `billing-validation-control`, require protected `main`/trusted dispatch context before the job, use only the control runtime URL in that job, and keep all pull-request checks credential-free. Do not embed reviewer logins or reviewer IDs that have not been supplied. If the environment lacks required-reviewer protection or the secret, the runtime job must fail closed before connecting or touching Preview/Stripe.

- [ ] **Step 4: Remove migration and privileged-secret paths from workflow**

Remove runtime calls to `installAttemptSchema`/`applyAttemptMigrations`, management API token exposure, owner/`postgres` credentials, and any DDL command. Keep `SUPABASE_VALIDATION_DATABASE_URL` only on the separately scoped financial validation job. Ensure no output, artifact, debug log, matrix value, or candidate-controlled action receives either database URL.

- [ ] **Step 5: Expand mutation-based secret-boundary tests**

Test hostile workflow changes: adding the control URL to PR/build/Preview, forwarding it through job outputs, invoking the migration renderer as SQL execution, adding a management token, broadening `permissions`, removing protected environment, or replacing the trusted branch/SHA guard. Each mutation must make the test fail.

- [ ] **Step 6: Run all workflow policy checks**

Run: `pnpm lint:workflows && pnpm check:secret-boundary && node --test test/workflows/control-store-boundary.test.mjs test/workflows/workflow-policy.test.mjs test/workflows/reader-boundary.test.mjs`

Expected: all pass; PR checks remain credential-free and the only workflow reference to `BILLING_CONTROL_DATABASE_URL` is the protected trusted runtime job plus its boundary tests.

- [ ] **Step 7: Commit only Task 5 hunks**

Review workflow permissions, conditions, and secret references in the staged diff and commit as `ci: isolate billing control store credentials`.

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

Run the rendered bootstrap once in a fresh PostgreSQL 17 database and assert success. Run it a second time and against a deliberately partial baseline; both must fail and preserve the prior schema byte-for-byte. Apply forward migrations and assert exact digest/order. Exercise all runtime store operations and forbidden operations using `SET ROLE billing_validation_runtime`; verify all role flags, ownership, memberships, ACLs, migration hashes, schema fingerprint, and default privileges directly as the local test administrator. Verify that a deliberately failed SQL statement rolls back the entire bootstrap transaction, leaving no roles, schema, receipt, or migration row behind.

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
- Runbook leaves runtime login disabled and GitHub remote checks blocked until the reviewer identity and protected `billing-validation-control` Environment are configured and independently verified.

- [ ] **Step 1: Write the non-secret operator runbook**

Document the exact generated bootstrap/migration verification commands, expected project ref, role/schema names, hash readback, post-apply ACL checks, and failure behavior for ambiguous MCP results. State explicitly: never rerun the bootstrap, never reset, and never repair with destructive SQL; inspect read-only and prepare a new reviewed forward migration instead.

- [ ] **Step 2: Document credential handoff without exposing values**

Specify that an operator generates/stores the runtime password in an approved password manager, changes runtime to LOGIN only after role/grant verification, and enters the complete runtime URL directly into the protected GitHub Environment secret UI/approved secure channel. Never use chat, SQL literals, command-line arguments, `.env.local`, Vercel, candidate artifacts, or workflow outputs. If the secure handoff or reviewer allowlist is unavailable, retain NOLOGIN and stop.

- [ ] **Step 3: Run TestSprite preflight only for applicable UI coverage**

Run: `testsprite --version && testsprite auth status`; resolve the project by the documented environment/config/list order. This change is backend database/CI infrastructure and does not modify a browser flow, so do not create a fake frontend test or spend remote-run credits. Report TestSprite as not applicable to this control-store proof unless an existing relevant UI case is identified; the PostgreSQL and workflow tests are the authoritative tests for this change.

- [ ] **Step 4: Perform final independent review**

Run `git diff --check`, inspect every final diff, verify the two Supabase refs and URL names remain separate, verify the control URL is absent from candidate/Preview code, verify the only bootstrap is operator-rendered SQL, and verify no remote mutation or production resource was touched. Run the full commands from Task 6 again after any review fix.

- [ ] **Step 5: Record truthful release status**

Report local code status separately from remote status. Remote control-store rollout remains pending until: reviewer identity supplied; GitHub Environment protection verified; operator applies SQL to `ceindkuafycqdcplfrgs` via Supabase MCP; second readback confirms roles/ACLs/hashes; runtime credential is securely provisioned; and the protected workflow passes. Financial Preview proof is a separate blocked track until a safe, distinct financial validation project is user-approved and provisioned. Do not mark production-ready based only on this plan or local tests.

- [ ] **Step 6: Commit only Task 7 documentation**

Stage only the runbook/spec-review changes and commit as `docs: document billing control store rollout gates`.

## Plan Self-Review

- **Spec coverage:** Identity separation is Task 1; one-shot/digest-pinned bootstrap and forward migrations are Task 2; NOLOGIN roles and least-privilege/append-only behavior are Task 3; no runtime DDL and read-only identity/hash verification are Task 4; protected-secret boundary is Task 5; PostgreSQL 17, ACL, concurrency, and recovery proof is Task 6; manual remote rollout and explicit non-claims are Task 7.
- **Placeholder scan:** There are no TODO/TBD implementation steps, invented reviewer IDs, secret values, or claimed migration digests. Digests are calculated from final bytes and committed as exact literals during Task 2.
- **Interface consistency:** Tasks 1–4 define the policy, plan, renderer, privilege manifest, verifier, and transaction boundary consumed by Tasks 5–6. The control URL and financial URL remain separate in every task.
- **Worktree safety:** All existing modified files are preserved; task commits stage only reviewed hunks. No remote environment or production action is part of this plan.
