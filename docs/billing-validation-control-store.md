# Billing validation control store runbook

**Status:** local implementation and CI contract only. This runbook does not authorize remote SQL, credential creation, login-role activation, financial tests, or production changes.

## Scope and fixed identities

The control project is `ceindkuafycqdcplfrgs` in `sa-east-1`, PostgreSQL 17.11. It stores only validation control-plane state. It is not the financial Preview database. The financial target remains unconfigured; do not substitute this project or the historical/denylisted `zjvqjdntasprusoqfsgw` reference.

The identities are distinct:

- `billing_validation_owner`: `NOLOGIN`; owns the private schema and its objects.
- `billing_validation_runtime`: `NOLOGIN`; holds the narrowly scoped business-store ACLs, but is not enabled for remote operation by this plan.
- `billing_validation_verifier`: read-only; no table or sequence access; may execute only the fixed verifier function. It remains `NOLOGIN` until the reviewer and protected GitHub Environment gate are independently verified.

`BILLING_CONTROL_VERIFIER_DATABASE_URL` is only for the protected verifier job. It must never be copied to Preview, candidate-controlled jobs, artifacts, logs, `.env.local`, or the application. `SUPABASE_VALIDATION_DATABASE_URL` remains a separate financial-target setting and is not configured by this runbook.

## Local verification

From the control repository, run:

```sh
pnpm test:control-store
pnpm lint:workflows
pnpm check:secret-boundary
pnpm exec node --test test/attempts/control-store-policy.test.mjs test/attempts/control-store-bootstrap.test.mjs test/attempts/control-store-verifier.test.mjs test/attempts/postgres.test.mjs
```

The disposable PostgreSQL 17 harness is a separate local gate. Use only Docker context `billing-validation-isolated`; do not switch or use the default context, stop unrelated containers, or prune resources. A successful unit suite is not a substitute for this database probe or remote verifier proof.

Run the isolated database gate from a terminal where your normal interactive `sudo` authorization can be refreshed:

```sh
sudo -v
pnpm test:billing-control-store:db
```

`sudo -v` is executed by you in the terminal and does not change Docker configuration. The harness invokes Docker only as the dedicated `billing-validation` service account and pins every Docker command to `billing-validation-isolated`; it verifies that the endpoint is that account's rootless socket and that the daemon's private data root is `/var/lib/billing-validation/.local/share/docker`. It creates one loopback-only PostgreSQL 17.11 container with ephemeral storage, runs the bootstrap, privilege, and lease/concurrency assertions, then removes and verifies removal of only that run's exact container. If noninteractive sudo authorization is unavailable, it stops before container creation with `isolated_docker_privilege_required`. It never falls back to Docker context `default` and does not contact Supabase, Vercel, GitHub, Stripe, or any remote database.

Container-create failures report only a safe category (for example, registry unavailable/rate-limited, image reference unavailable, storage exhausted, host restriction, or rejected configuration), never raw Docker stderr. If the harness reports `cleanup=needs_review`, do not start another run: the daemon did not prove whether the exact run-named container exists. Inspect that exact name in the isolated context and resolve it before retrying; never use broad prune or remove commands.

## Remote rollout: gated and not yet authorized

Do not proceed with the following steps until a separate authorization explicitly covers remote DDL and the required GitHub protection is verified. At present, no reviewer login/ID has been recorded, and no verifier credential may be created or enabled.

1. In Supabase read-only project metadata, confirm the exact project reference `ceindkuafycqdcplfrgs`, region, health, and PostgreSQL version. Separately run this read-only SQL in that exact project to confirm the database, server, and fresh-install boundary:

   ```sql
   SELECT current_database() AS database_name,
          current_setting('server_version_num') AS server_version_num,
          to_regnamespace('billing_validation_control') AS existing_control_schema,
          to_regrole('billing_validation_owner') AS existing_owner_role,
          to_regrole('billing_validation_runtime') AS existing_runtime_role,
          to_regrole('billing_validation_verifier') AS existing_verifier_role;
   ```

   Expected: database `postgres`; PostgreSQL 17.11; schema and role fields `NULL`. If anything is already present or the state is ambiguous, stop; never reset or try to repair it.
2. Render the operator bundle locally from the checked-in, digest-pinned source. For inspection, capture it in a private temporary file rather than adding it to the repository:

   ```sh
   umask 077
   bundle_path="$(mktemp "${TMPDIR:-/tmp}/billing-control-bootstrap.XXXXXX.sql")"
   node --input-type=module -e 'import { loadControlStoreBootstrapPlan, renderControlStoreBootstrap } from "./src/attempts/control-store-bootstrap.mjs"; const plan = await loadControlStoreBootstrapPlan(); process.stdout.write(renderControlStoreBootstrap(plan));' > "$bundle_path"
   sha256sum "$bundle_path"
   ```

   Confirm the plan targets only the pinned control project and compare migration versions, names, and SHA-256 values with `src/attempts/control-store-bootstrap-pins.mjs`. The bundle contains DDL; it contains no database password or verifier credential. Do not run it with `psql`, shell-evaluate it, or apply it through an unreviewed workflow.
3. Only after the separate remote-DDL approval and an independent source/hash review, apply the exact rendered bundle once through the approved Supabase control plane to project `ceindkuafycqdcplfrgs`. An ambiguous response is not permission to retry. Perform read-only inspection and reconcile the server state first.
4. Independently read back role attributes and memberships; schema ownership; effective verifier and runtime permissions; and ordered rows from `billing_validation_control.schema_migrations`. The following queries are read-only:

   ```sql
   SELECT rolname, rolcanlogin, rolsuper, rolcreaterole, rolcreatedb,
          rolreplication, rolbypassrls
   FROM pg_catalog.pg_roles
   WHERE rolname IN ('billing_validation_owner', 'billing_validation_runtime',
                     'billing_validation_verifier')
   ORDER BY rolname;

   SELECT namespace.nspname,
          pg_catalog.pg_get_userbyid(namespace.nspowner) AS schema_owner,
          pg_catalog.has_schema_privilege('billing_validation_verifier', namespace.oid, 'USAGE') AS verifier_usage,
          pg_catalog.has_schema_privilege('billing_validation_verifier', namespace.oid, 'CREATE') AS verifier_create
   FROM pg_catalog.pg_namespace AS namespace
   WHERE namespace.nspname = 'billing_validation_control';

   SELECT version, name, pg_catalog.btrim(sha256) AS sha256
   FROM billing_validation_control.schema_migrations
   ORDER BY version;

   SELECT pg_catalog.has_function_privilege('billing_validation_verifier',
            'billing_validation_control.verify_attempt_control_store()', 'EXECUTE') AS verifier_can_verify,
          pg_catalog.has_function_privilege('billing_validation_runtime',
            'billing_validation_control.verify_attempt_control_store()', 'EXECUTE') AS runtime_can_verify;
   ```

   Expected: owner/runtime/verifier all `NOLOGIN` at this stage; schema owner is `billing_validation_owner`; verifier has schema `USAGE` but not `CREATE`; migration rows match version/name/SHA-256 exactly in `src/attempts/control-store-bootstrap-pins.mjs`; `verifier_can_verify = true` and `runtime_can_verify = false`. Also read back all verifier table/sequence privileges as false and compare the runtime's effective relation/column/sequence/function privileges with `src/attempts/runtime-privileges.mjs`. An independent read-only call to `SELECT * FROM billing_validation_control.verify_attempt_control_store();` returns a safe digest receipt; when called as the operator, its `session_role` will be the operator role, not the verifier, so do not treat that as proof of verifier authentication.
5. A second, independent read-only verification must confirm the control project/database identity, PostgreSQL version, baseline receipt, migration digest, role state, schema fingerprint, and effective ACL fingerprint. A successful MCP “apply” response alone is not proof of the resulting state.
6. Do not create or enable the verifier credential until a named authorized reviewer is supplied and the `billing-validation-control` Environment's branch/reviewer protection is observed to be effective. Then any approved credential is entered only into that protected GitHub Environment through a secret-safe path. Never expose it in chat, command arguments, shell history, workflow output, artifacts, or Vercel.
7. Run the protected workflow only after its exact repository, protected `main`, Environment, reviewer, and verifier-secret gates pass. It performs read-only verification only. Do not enable `billing_validation_runtime` as a workaround and do not use the verifier as a business-store credential.

If any check fails, stop without mutation. Preserve the existing database and logs; investigate with read-only queries and propose a reviewed forward-only migration if required. Never rerun bootstrap, reset the project, or repair state with `DROP`, `DELETE`, or `TRUNCATE`.

## What a pass does and does not establish

A successful protected verifier proves only the pinned control-store identity, role/ACL fingerprint, and migration state. It does not execute `PostgresAttemptStore`, validate the 43 financial journeys, prove Stripe TEST/Preview behavior, or establish production readiness. The business runtime remains `NOLOGIN` and its remote writes are not enabled by this read-only gate. Financial Preview validation requires a separately approved and provisioned non-production financial project, an independently verified deployment, and Stripe TEST credentials. Production still requires separate release review and controlled rollout.
