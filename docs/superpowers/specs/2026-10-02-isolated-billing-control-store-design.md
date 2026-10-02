# Isolated billing-validation control store

**Status:** approved for local implementation; remote migrations, credentials, financial-target provisioning, and production-impacting actions remain separately gated.
**Date:** 2026-10-02

## Goal and approved boundary

The new Supabase project `ceindkuafycqdcplfrgs` (“LawX Billing Validation”, `sa-east-1`, PostgreSQL 17.11) is exclusively the trusted control store for validation attempts, leases, capacity reservations, provider intents, and receipts. It is not the application database and must contain no customer or financial-fixture data.

The initial plan named `zjvq…` as the Preview validation target. Implementation review found that ref in the application's immutable protected/historical-target denylist; read-only Supabase metadata returned `Project not found`, and the current project inventory does not contain it. The current `policy/environment-policy.json` consequently remains fail-closed with `projectRef` and `connection` set to `null`. Do not remove the denylist or connect to that historical ref. A distinct financial validation project must be separately approved and provisioned, with cost confirmed, before any financial scenario can run remotely. The app Preview receives no credential or API key for the control project; it must never be substituted for a financial database.

Supabase main/production, the other existing Supabase projects, Vercel Production, Stripe Live, and unrelated local Docker services are out of scope. No remote DDL, secret creation, environment modification, deployment, or financial test is authorized by this design document.

## Decision: operator-applied migrations, runtime-only CI access

Two viable migration models were considered:

1. A protected GitHub job receives a dedicated migration credential and applies the allowlisted migration set. This automates rollout but places DDL authority in Actions and depends on reviewed Environment protection and a separately managed secret.
2. A trusted operator applies immutable, reviewed migrations to the exact isolated project through Supabase MCP; the test/runtime workflow receives only a restricted database role. This adds a deliberate operator step but keeps DDL credentials out of CI and Preview.

The second model is approved for the initial rollout. The project is isolated, and the GitHub Environments were observed without protection rules or secrets; an authorized reviewer identity has not yet been supplied. Do not add an automated migrator job unless a later design is approved after those gates are configured.

Supabase supports distinct PostgreSQL roles, login roles, and object grants; its guidance recommends a separate database user for each service. Custom roles can connect through the shared pooler with the project-qualified role name. These capabilities support the role split below. [Supabase PostgreSQL roles](https://supabase.com/docs/guides/database/postgres/roles), [Supabase database connections](https://supabase.com/docs/guides/database/connecting-to-postgres).

## Ownership and privilege model

- Supabase `postgres` remains an operator-only administrative identity used through the approved control plane. It is never configured in the collector, GitHub Actions, the application, Vercel Preview, or a candidate-controlled job.
- `billing_validation_owner` is a `NOLOGIN` role and owner of the private `billing_validation_control` schema and its objects. It has no superuser, database/role creation, replication, or RLS-bypass attributes. The operator assumes this role only while applying a reviewed migration.
- `billing_validation_runtime` is the sole service role used by the trusted collector. Bootstrap creates it as `NOLOGIN`; it is switched to `LOGIN` only when an out-of-band secure credential path is ready. It is not a member of the owner role or any elevated role. It has no `CREATE` on the database or schema, no table ownership, and no ability to create/alter/disable triggers, alter schema, or access the migration ledger.
- The runtime role receives only the privileges required by the fixed SQL in `src/attempts/postgres-store.mjs`: read/insert/update access to the mutable attempt and current-lock state, narrowly scoped delete access only for current lease/lock rows, append-only read/insert access to reservations, claims, intents and receipts, and the required fence-sequence access. Exact tables and update columns must be derived from the final SQL statements; no blanket `GRANT ALL`, default grant, or table-wide update grant may substitute for that inventory.
- Historical ledgers remain immutable to runtime: `fixture_lease_history` permits only its required insert and narrowly scoped reads; receipts and provider history permit only their required reads/inserts; none permit `UPDATE`, `DELETE`, or `TRUNCATE`. The migration ledger receives no runtime privileges, including `SELECT`. `anon`, `authenticated`, `service_role`, and `PUBLIC` receive no schema usage or object privileges. The control schema is not exposed through the Supabase Data API.
- Runtime preflight verifies the exact project/database identity, `session_user`/`current_user`, role flags, role memberships, schema ownership, effective table/column/sequence/function privileges, and migration digests. Any missing, extra, unreadable, or ambiguous permission fails closed before a mutation.

## Bootstrap and migration lifecycle

The current `src/attempts/schema.sql` is not itself a safe repeatable bootstrap: it contains `IF NOT EXISTS`, `CREATE OR REPLACE`, and trigger drop/recreate operations. The implementation must replace implicit bootstrap behavior with an explicit, digest-pinned first-install path:

1. Read back the target project identity and health. Confirm the expected control schema and role names are absent; never reset the project or inspect/delete Auth users or financial data.
2. Create the owner/runtime roles and private schema in a reviewed, transactional bootstrap. The schema and all objects are owned by `billing_validation_owner`; runtime has no ownership or migration-ledger access.
3. Record the exact baseline digest in an append-only migration ledger, then apply only forward migrations in the reviewed allowlist. A schema that is partial, already exists without the expected receipt, has an unknown migration, or differs from a recorded hash blocks; it is never repaired by rerunning a baseline, reset, `DROP`, `DELETE`, `TRUNCATE`, or upsert.
4. Apply each remote migration manually using Supabase MCP only after its source, target project ref, and expected digest have been reviewed. Read back the applied migration history, schema fingerprint, ownership, and effective grants before enabling runtime use.
5. CI uses a read-only schema/identity verifier plus the runtime role. Its code path cannot apply DDL and must reject the administrative role, owner role, missing baseline, migration drift, wrong project, or wrong runtime role.

Migration uncertainty is not retried automatically. After an ambiguous result, perform read-only inspection; block until the database state and migration receipt are conclusively reconciled. Recovery is forward-only.

## Credential and workflow boundary

- The control database connection uses the dedicated configuration key `BILLING_CONTROL_DATABASE_URL`, bound to the control project ref. Existing `SUPABASE_VALIDATION_DATABASE_URL` remains reserved for the financial validation target and must not be repurposed.
- The control URL is available only to the trusted collector runtime after its GitHub Environment is configured for protected control-workflow execution and an authorized reviewer is identified. It is not stored in repository files, artifacts, logs, Vercel, `.env.local`, or the candidate application environment.
- The runtime password is generated/stored through an operator-controlled password manager and entered only through secure prompts/secret input; it must not appear in migration SQL, process arguments, shell history, tool output, or chat. The same value is installed directly into the protected control Environment. If this secure path is unavailable, leave the role `NOLOGIN` and keep remote CI blocked.
- No migration/admin URL or Supabase management token is added to GitHub Actions. The collector never receives the `postgres` password, `service_role` API key, or an owner/migrator credential.
- Until the GitHub Environment has the required reviewer/branch policy and the runtime secret is installed, remote control-store checks remain blocked. Offline tests do not imply remote readiness.

## Failure handling and recovery

- Wrong project, main/production identity, region/version mismatch, unexpected schema/role, excessive privileges, missing grants, or migration drift: refuse before writes.
- Bootstrap SQL must be atomic. A failed or ambiguous bootstrap leaves the project fenced; do not replay it blindly. Inspect through read-only queries and use a new forward-only correction after review.
- Runtime database errors preserve the existing append-only recovery rules: uncertain writes retain attempt/lease state; no cleanup/reset operation may convert uncertainty into success.
- Control-plane availability failure blocks a financial validation attempt before any Preview or Stripe TEST mutation.

## Verification and acceptance criteria

Local verification must run against disposable PostgreSQL 17 in Docker and prove:

1. Bootstrap succeeds exactly once on a fresh database; a second run, partial baseline, wrong project identity, or changed baseline digest is rejected without DDL.
2. Forward migrations apply in order and verify by exact version, name, and content hash; unknown, modified, missing, or reordered entries fail closed.
3. `billing_validation_owner` owns the schema but cannot log in; the runtime login is not privileged and cannot assume the owner role.
4. Runtime can perform each required store operation and cannot create/alter schema objects, disable triggers, truncate or mutate append-only history, write the migration ledger, or exercise privileges outside its explicit inventory.
5. Wrong role, Supabase `postgres`, parent/production ref, mismatched URL/host/database, absent credentials, and unverified TLS fail before opening a mutation-capable session.
6. The existing attempt/lease fencing, append-only receipts, capacity reservation, concurrency, recovery, and migration-scanner suites remain green.
7. Workflow tests prove no CI job invokes migration application and no candidate/Preview job receives the control URL.

After local review, remote control-store rollout is a separate gated phase: inspect the new project read-only, apply only the reviewed bootstrap/migrations to `ceindkuafycqdcplfrgs` via MCP, independently verify role and schema state, then provision the runtime secret only in the protected control Environment. Financial scenario rollout additionally requires a different, explicitly approved isolated project. No action targets `zjvq…`, production, Vercel Production, or Stripe Live.

## Explicit non-claims

Passing this control-store implementation does not prove the 43 financial scenarios pass, does not validate the Preview’s billing behavior, and does not establish production readiness. Those require separate remote proofs, protected GitHub configuration, scenario evidence, recovery evidence, and final human release approval.
