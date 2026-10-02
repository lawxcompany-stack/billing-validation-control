# Isolated billing-validation control store

**Status:** approved for local implementation; remote migrations, credentials, financial-target provisioning, and production-impacting actions remain separately gated.
**Date:** 2026-10-02

## Goal and approved boundary

The new Supabase project `ceindkuafycqdcplfrgs` (“LawX Billing Validation”, `sa-east-1`, PostgreSQL 17.11) is exclusively the trusted control store for validation attempts, leases, capacity reservations, provider intents, and receipts. It is not the application database and must contain no customer or financial-fixture data.

The initial plan named `zjvq…` as the Preview validation target. Implementation review found that ref in the application's immutable protected/historical-target denylist; read-only Supabase metadata returned `Project not found`, and the current project inventory does not contain it. The current `policy/environment-policy.json` consequently remains fail-closed with `projectRef` and `connection` set to `null`. Do not remove the denylist or connect to that historical ref. A distinct financial validation project must be separately approved and provisioned, with cost confirmed, before any financial scenario can run remotely. The app Preview receives no credential or API key for the control project; it must never be substituted for a financial database.

Supabase main/production, the other existing Supabase projects, Vercel Production, Stripe Live, and unrelated local Docker services are out of scope. No remote DDL, secret creation, environment modification, deployment, or financial test is authorized by this design document.

## Decision: operator-applied migrations, isolated verifier CI access

Two viable migration models were considered:

1. A protected GitHub job receives a dedicated migration credential and applies the allowlisted migration set. This automates rollout but places DDL authority in Actions and depends on reviewed Environment protection and a separately managed secret.
2. A trusted operator applies immutable, reviewed migrations to the exact isolated project through Supabase MCP; the test/runtime workflow receives only a restricted database role. This adds a deliberate operator step but keeps DDL credentials out of CI and Preview.

The second model is approved for the initial rollout. The project is isolated, and the GitHub Environments were observed without protection rules or secrets; an authorized reviewer identity has not yet been supplied. Do not add an automated migrator job unless a later design is approved after those gates are configured.

Supabase supports distinct PostgreSQL roles, login roles, and object grants; its guidance recommends a separate database user for each service. Custom roles can connect through the shared pooler with the project-qualified role name. These capabilities support the role split below. [Supabase PostgreSQL roles](https://supabase.com/docs/guides/database/postgres/roles), [Supabase database connections](https://supabase.com/docs/guides/database/connecting-to-postgres).

## Ownership and privilege model

- Supabase `postgres` remains an operator-only administrative identity used through the approved control plane. It is never configured in the collector, GitHub Actions, the application, Vercel Preview, or a candidate-controlled job.
- `billing_validation_owner` is a `NOLOGIN` role and owner of the private `billing_validation_control` schema and its objects. It has no superuser, database/role creation, replication, or RLS-bypass attributes. The operator assumes this role only while applying a reviewed migration.
- PostgreSQL 17's managed `CREATEROLE` path leaves one non-inheriting, non-settable admin membership for each newly created role: the created role is granted to the bootstrap operator `postgres` with `ADMIN=true, INHERIT=false, SET=false`, by a superuser. The verifier accepts only this exact catalog state; every additional or changed membership fails closed. The trusted operator remains a privileged administrative boundary because the `ADMIN` option can be used to grant further memberships.
- `billing_validation_runtime` is the business-store role. Bootstrap creates it as `NOLOGIN`; it remains `NOLOGIN` under this plan and is not the identity used by the read-only verifier. It is not a member of the owner role or any elevated role, and has no memberships other than the exact automatic row described above where it is the granted role and `postgres` is the member. It has no `CREATE` on the database or schema, no table ownership, and no ability to create/alter/disable triggers, alter schema, or access the migration ledger.
- `billing_validation_verifier` is a distinct read-only identity for the trusted control-store check. Bootstrap creates it as `NOLOGIN`; a later, separately approved credential handoff may enable `LOGIN` only after the protected GitHub Environment and reviewer policy are verified. It has no unexpected role memberships, elevated attributes, ownership, or table/sequence privileges; it receives schema `USAGE` and `EXECUTE` only on the fixed, owner-owned, read-only `verify_attempt_control_store()` function.
- The runtime role receives only the privileges required by the fixed SQL in `src/attempts/postgres-store.mjs`: read/insert/update access to the mutable attempt and current-lock state, narrowly scoped delete access only for current lease/lock rows, append-only read/insert access to reservations, claims, intents and receipts, and the required fence-sequence access. Exact tables and update columns must be derived from the final SQL statements; no blanket `GRANT ALL`, default grant, or table-wide update grant may substitute for that inventory.
- Historical ledgers remain immutable to runtime: `fixture_lease_history` permits only its required insert and narrowly scoped reads; receipts and provider history permit only their required reads/inserts; none permit `UPDATE`, `DELETE`, or `TRUNCATE`. The migration ledger receives no runtime privileges, including `SELECT`. `anon`, `authenticated`, `service_role`, and `PUBLIC` receive no schema usage or object privileges. The control schema is not exposed through the Supabase Data API.
- The protected read-only verifier verifies the exact control project/database identity, verifier session, service-role attributes, absence of unexpected memberships (allowing only the exact automatic CREATEROLE rows above), schema ownership, effective table/column/sequence/function privileges, and migration digests. The business-store adapter separately checks `current_database()`, `session_user`, `current_user`, the active role setting, and server version on its own runtime connection before store work; it does not call the verifier function or attest the full schema fingerprint. Any missing, extra, unreadable, or ambiguous verifier state fails closed in the protected job, and any wrong runtime session fails closed before store work. Because the runtime remains `NOLOGIN` in this gate, remote business-store operations are not enabled or claimed as verified.

## Bootstrap and migration lifecycle

The current `src/attempts/schema.sql` is not itself a safe repeatable bootstrap: it contains `IF NOT EXISTS`, `CREATE OR REPLACE`, and trigger drop/recreate operations. The implementation must replace implicit bootstrap behavior with an explicit, digest-pinned first-install path:

1. Read back the target project identity and health. Confirm the expected control schema and role names are absent; never reset the project or inspect/delete Auth users or financial data.
2. Create the owner/runtime/verifier roles and private schema in a reviewed, transactional bootstrap. The schema and all objects are owned by `billing_validation_owner`; neither service identity owns objects or can access the migration ledger directly.
3. Record the exact baseline digest in an append-only migration ledger, then apply only forward migrations in the reviewed allowlist. A schema that is partial, already exists without the expected receipt, has an unknown migration, or differs from a recorded hash blocks; it is never repaired by rerunning a baseline, reset, `DROP`, `DELETE`, `TRUNCATE`, or upsert.
4. Apply each remote migration manually using Supabase MCP only after its source, target project ref, and expected digest have been reviewed. Read back the applied migration history, schema fingerprint, ownership, and effective grants before enabling the read-only verifier identity. The business runtime remains NOLOGIN under this gate.
5. CI uses a read-only schema/identity verifier through the separate verifier role. Its code path cannot apply DDL and must reject the administrative role, owner role, missing baseline, migration drift, wrong project, wrong verifier role, or privilege drift in either service identity.

Migration uncertainty is not retried automatically. After an ambiguous result, perform read-only inspection; block until the database state and migration receipt are conclusively reconciled. Recovery is forward-only.

## Credential and workflow boundary

- The read-only control verifier uses `BILLING_CONTROL_VERIFIER_DATABASE_URL`, bound to the control project ref and `billing_validation_verifier`. `billing_validation_runtime` remains a separate NOLOGIN business-store identity and is not exposed through this verifier job. Existing `SUPABASE_VALIDATION_DATABASE_URL` remains reserved for the financial validation target and must not be repurposed.
- The verifier URL is available only to the protected read-only verifier job after its GitHub Environment is configured for protected control-workflow execution and an authorized reviewer is identified. It is not stored in repository files, artifacts, logs, Vercel, `.env.local`, or the candidate application environment.
- If a verifier credential is later approved, its password is generated/stored through an operator-controlled password manager and entered only through secure prompts/secret input; it must not appear in migration SQL, process arguments, shell history, tool output, or chat. The same value is installed directly into the protected control Environment. If this secure path is unavailable, leave the verifier `NOLOGIN` and keep remote CI blocked. Do not enable the business runtime role as a workaround.
- No migration/admin URL or Supabase management token is added to GitHub Actions. The collector never receives the `postgres` password, `service_role` API key, or an owner/migrator credential.
- Until the GitHub Environment has the required reviewer/branch policy and the verifier secret is installed, remote control-store checks remain blocked. Offline tests do not imply remote readiness.

## Failure handling and recovery

- Wrong project, main/production identity, region/version mismatch, unexpected schema/role, excessive privileges, missing grants, or migration drift: refuse before writes.
- Bootstrap SQL must be atomic. A failed or ambiguous bootstrap leaves the project fenced; do not replay it blindly. Inspect through read-only queries and use a new forward-only correction after review.
- Runtime database errors preserve the existing append-only recovery rules: uncertain writes retain attempt/lease state; no cleanup/reset operation may convert uncertainty into success.
- Control-plane availability failure blocks a financial validation attempt before any Preview or Stripe TEST mutation.

## Verification and acceptance criteria

Local verification must run against disposable PostgreSQL 17 in Docker and prove:

1. Bootstrap succeeds exactly once on a fresh database; a second run, partial baseline, wrong project identity, or changed baseline digest is rejected without DDL.
2. Forward migrations apply in order and verify by exact version, name, and content hash; unknown, modified, missing, or reordered entries fail closed.
3. `billing_validation_owner` owns the schema but cannot log in; `billing_validation_runtime` remains NOLOGIN and has only its explicit business-store ACLs; the verifier is a separate identity with no table/sequence privileges and only the fixed verifier function.
4. Runtime ACL behavior matches its manifest; the verifier can call only the fixed read-only verifier and cannot create/alter schema objects, mutate control tables, disable triggers, or access migration history directly.
5. Wrong role, Supabase `postgres`, parent/production ref, mismatched URL/host/database, absent credentials, and unverified TLS fail before opening a mutation-capable session.
6. The existing attempt/lease fencing, append-only receipts, capacity reservation, concurrency, recovery, and migration-scanner suites remain green.
7. Workflow tests prove no CI job invokes migration application and no candidate/Preview job receives the verifier URL.

After local review, remote control-store rollout is a separate gated phase: inspect the new project read-only, apply only the reviewed bootstrap/migrations to `ceindkuafycqdcplfrgs` via MCP, independently verify role and schema state, then provision the verifier secret only in the protected control Environment. Do not enable or provision the business runtime role as part of this read-only gate. Financial scenario rollout additionally requires a different, explicitly approved isolated project. No action targets `zjvq…`, production, Vercel Production, or Stripe Live.

## Explicit non-claims

Passing this control-store implementation does not prove the 43 financial scenarios pass, does not validate the Preview’s billing behavior, and does not establish production readiness. Those require separate remote proofs, protected GitHub configuration, scenario evidence, recovery evidence, and final human release approval.
