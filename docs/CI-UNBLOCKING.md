# CI integration status — 2026-09-29

This is a partial integration fix, not financial acceptance or production readiness.
No Supabase, Vercel or Stripe connection/mutation was used to produce this report.

## Observed failure and dependency chain

Application PR #139 still points to `1073c5286a5bf4966e204252a545ff09aa549136`.
In application run `36381656479`, attempt `1`, Billing stopped at
`validation_reset_branch_has_auth_users`. Acceptance failed downstream; the guard
prevented a destructive reset of a persistent validation branch with Auth users.
Do not allowlist unknown users, restore reset/bootstrap, skip acceptance, or turn
that refusal into success.

Quality, regression and build in that attempt passed. The new prerequisite
collector successfully read their actual job identities from GitHub (read-only):
`108798488907`, `108799062900`, `108800377598` respectively. This was a test of
`collectCandidateChecks`, **not** complete candidate admission: reviewed source
pins and independent environment identity must still pass before activation.

Previously, control admission required the application's final financial evidence
while the planned application workflow waited for control financial evidence.
Admission now requires only quality/regression/build, bound to the exact PR base,
candidate commit/tree and latest run/attempt. Missing, skipped, failed, duplicated,
stale or mismatched prerequisite jobs still refuse admission. The old final
financial evidence validator is unchanged; a prerequisite receipt cannot replace
financial acceptance.

## Corrections in this branch

- Implement the protected hosted reader, using an installation token restricted
  to Actions/Contents/Pull requests **read** on `Plataforma-LawX`; revoke it after
  the job. No candidate checkout, dependency installation or candidate execution
  occurs in that credentialed job. Outputs contain only identifiers.
- Bound GitHub HTTP access to allowlisted read routes, response limits, deadlines,
  pinned API version and sanitized errors. Re-read candidate/run identity to
  detect changes during inspection.
- Match the scheduling selector to the ephemeral runner's actual per-attempt
  label. `--no-default-labels` means `self-hosted` and `linux` are not registered.
  This fixes label matching, **not** runner admission or registration readiness.
- Pin control repository ID `1384018279` from administrator-authenticated GitHub
  readback. Accept the REST workflow path with or without the exact `@main`
  suffix while still requiring the matching repository, dispatch, branch and SHA.
- Replace the nonexistent organization/team CODEOWNER with the verified existing
  admin/write accounts `@lawxcompany-stack` and `@netopvh`.

## Remaining gates, in execution order

| Gate | Evidence / required action | Completion criterion |
| --- | --- | --- |
| Review this control patch | Merge only after its `policy` check and independent review | Reviewed implementation on protected `main` |
| Runner admission | GitHub reports owner type `User`. Current registration assumes organization group `billing-validation-isolated` but uses a repository URL | Reviewed, externally enforced admission compatible with actual ownership; never simply remove `--runnergroup` |
| Protected environments | Created/read back the four names below, branch `main` only, no reviewers or secrets added | Complete for these settings; reverify before dispatch |
| Private candidate reader | Reader App credentials are not configured in control | Install a read-only App on only the app repository; set reader environment variable/key and verify scopes |
| Candidate review | `policy/source-pins.json` has no reviewed blobs; PR #139 changes protected paths | Review the exact candidate and record its approved blob hashes; no automatic approval |
| Environment identity | Parent project, schema/migration digests and TEST webhook ID remain unset in policy | Independent readback of only the authorized validation child and TEST endpoint; current health and immutable Preview signature verified |
| Trusted collection / publication | Workflow `test` and `publisher` still intentionally fail closed | Real fixed scenario adapters, lease/capacity/recovery evidence and authenticated publication wired and verified |
| Application integration | Remote PR #139 still runs its previous CI revision | Publish the reviewed application integration only when trusted evidence can be consumed; rerun the exact candidate |
| Release acceptance | Offline tests and skipped provider jobs are not end-to-end proof | Required SQL/concurrency, financial, supervised 3DS and acceptance checks succeed with matching SHA/run/attempt and safe cleanup |

The infrastructure issue is account type, not evidence that a paid plan is the
only solution. GitHub's [runner group documentation](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/manage-access)
describes organization-level runner access and warns about runners on public
repositories. A migration to an organization or a different admission mechanism
is an architectural/administrative decision, not a reason to weaken the guard.

Environment readback on 2026-09-29 (each has one custom **branch**, not tag, rule
named `main`; no required reviewers):

| Environment | Environment ID | Branch policy ID |
| --- | --- | --- |
| `billing-validation-reader` | `23039398630` | `61435643` |
| `billing-validation-attestation` | `23039401218` | `61435649` |
| `billing-validation-tests` | `23039404039` | `61435650` |
| `billing-validation-publisher` | `23039406554` | `61435653` |

The creation above changes only GitHub control settings; it does not install an
App, register a runner, dispatch a workflow, or grant financial credentials.

## Verification

Run `pnpm test`, `pnpm lint:workflows`, `pnpm check:secret-boundary`, and
`git diff --check`. The default suite uses deterministic provider fixtures/mocks;
a green policy job does not mean a real financial or PostgreSQL run occurred.
Keep local PostgreSQL and provider-backed results separately identified.

No automatic rerun of the old destructive workflow is part of this patch. No
production migration, merge of application PR #139, or shared-runner fallback is
authorized by a prerequisite receipt.
