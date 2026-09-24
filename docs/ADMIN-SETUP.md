# Control repository administrator setup and readback

This is an implementation checklist for the public billing control repository. Public visibility is required for GitHub Artifact Attestations on the current GitHub Free plan. Keep credentials, activation nonces, registration tokens, browser capabilities, and private operational data out of the repository, workflow artifacts, and logs. This checklist does not create or activate GitHub settings. The Task 1 workflows are a fail-closed bootstrap and do not validate billing readiness. Do not treat branch protection, environments, Apps, secrets, or runner restrictions as active until an authorized administrator completes Task 9 and records API readback.

## Repository access and default branch

Before enabling a dispatch:

1. Confirm repository identity `lawxcompany-stack/billing-validation-control`, public visibility, numeric repository ID, and default branch `main` using an authorized GitHub readback. Task 9 must pin the reviewed immutable repository ID in runtime trust policy; a request, local `GITHUB_*` value, or supervisor option must never supply it. The workflows refuse any other control ref.
2. Grant repository write access only to the `billing-validation-maintainers` team. Remove write access from other teams and individual collaborators. Because GitHub dispatch requires write access, this also limits who can start `collect` and `recheck`.
3. Protect the exact default branch with an active ruleset or branch-protection rule that requires a pull request and at least one approving review from a maintainer. Require approval from the CODEOWNER for changes covered by `.github/CODEOWNERS`, dismiss stale approvals, and require approval of the latest push.
4. Prohibit force-pushes and branch deletion. Enable administrator enforcement and leave the bypass list empty. If using a ruleset, read back its enforcement state and bypass actors; if using branch protection, read back `allow_force_pushes`, `allow_deletions`, and administrator enforcement.
5. Confirm `.github/CODEOWNERS` resolves to the intended team and that the team has write access. Require code-owner review in the same active default-branch rule.
6. Set the repository Actions default `GITHUB_TOKEN` permission to read-only and require actions to be pinned to full-length commit SHAs where the organization policy supports it.

Record the API response or settings export, repository ID, default branch, ruleset/protection ID, review count, code-owner requirement, force-push/deletion settings, bypass actors, and readback timestamp. A screenshot or this checklist alone is not evidence that the settings are active.

## Workflow environments

Create these exact environments in the control repository before any operational workflow is enabled:

| Environment | Intended job | Required deployment ref | Secrets during Task 1 |
| --- | --- | --- | --- |
| `billing-validation-reader` | GitHub-hosted candidate metadata reader | Protected default branch only | None |
| `billing-validation-tests` | Isolated billing/browser test job | Protected default branch only | None |
| `billing-validation-publisher` | GitHub-hosted check publisher | Protected default branch only | None |

Do not configure manual reviewers. Read back each environment's existence, deployment branch policy, reviewer list, and secret names without exposing values. The separate Apps and financial test credentials are later-task work; Task 1 references the environment names but does not consume secrets or create environments. An absent environment must block activation because GitHub may create an unprotected environment when a workflow first references it.

## Dispatch and runner contract

- Use only `collect` and `recheck`. `candidate_repository` must be exactly `lawxcompany-stack/Plataforma-LawX`; `candidate_sha` must be a full 40-character hexadecimal SHA. Do not add a candidate branch/ref input. Repository ownership, PR head, deployment identity, and run/artifact association still require the later read-only resolver before any test or check publication.
- `collect` requires a new per-attempt runner label of the form `billing-validation-<32 lowercase hexadecimal characters>`. Generate the 128-bit suffix with a cryptographically secure random generator for that attempt. Never reuse a fixed label. `recheck` requires `source_run_id` and `source_run_attempt` and has no runner label.
- Never use this test runner for pull-request validation. The `pull_request` policy job runs on `ubuntu-latest`; only a protected and authorized `collect` dispatch may select the per-attempt self-hosted label. The runner is configured for group `billing-validation-isolated` and single-use ephemeral mode; before Task 9 activates it, an administrator must verify by settings/API readback that this group is restricted to this repository and the trusted workflow.
- The Task 1 reader, test, and publisher jobs deliberately stop with failure until their later-task implementations exist. This prevents a successful bootstrap run from being mistaken for a billing readiness result.

At Task 9, read back the environment policies, installed App scopes, runner group/workflow restrictions, and one-job runner lifecycle through the relevant GitHub APIs. Preserve non-secret IDs and timestamps as evidence; do not copy secret values into the record.

## Immutable Preview and runtime identity

Task 3 is a read-only boundary. Its default policy is `policy/environment-policy.json`; the schema is closed and unknown keys or malformed identifiers stop preflight. The reader uses the Vercel deployments list endpoint with the exact project ID, team ID, Preview target, and candidate SHA, then retrieves details by the selected deployment ID with `withGitRepoInfo=true`. It validates the returned project, Preview target, READY state, Git SHA, immutable generated `*.vercel.app` URL, and detail identity instead of relying on API filters alone. Candidate artifacts and caller-provided URLs are never deployment discovery inputs.

For the current reviewed policy, the Vercel project and team IDs are `prj_NEAKAPvyPzh76wfoHqYF6mRSfBs0` and `team_Legw262JzvhZUhIZtv5pFE4T`. The Supabase project ref is `zjvqjdntasprusoqfsgw`; the branch ID `e2f26c0b-8a79-4cd5-ad80-faaf91fb51a2` and branch name `lawx-billing-validation-20260912` are declared expected values from the protected app `billing-validation` environment. Their continued existence and validation-branch scope have not been confirmed through the Supabase Management API. Task 4 must independently read the branch from that exact project, compare both ID and name, and stop before any mutation if the branch is absent, mismatched, or production/default.

The expected Stripe TEST account is `acct_1TWh8jF7lfHrHdNa`, independently matching a read-only TEST account response. `livemode` is pinned to `false`. The webhook endpoint ID is currently unset because no authoritative endpoint identity was obtained; Task 4 must identify and verify the matching endpoint in the same TEST account and confirm its endpoint URL and `livemode=false` before any financial mutation. A missing or mismatched endpoint is a hard stop.

The attestation policy contains only the Ed25519 SPKI public key (fingerprint `79344bd905084e536c762d3c4b7ae1cc83ac48fb8ebdcbb821cec970513ec979`). The corresponding private key is not loaded or requested here. Runtime verification issues one GET to `https://<deployment-host>.vercel.app/api/internal/deployment-identity`, with redirects rejected, a 30-second timeout, `Accept: application/json`, and `Cache-Control: no-store`; it sends no E2E or credential header. It verifies the exact producer field order and signature, deployment ID/origin, candidate commit/tree, `billing-validation` environment, Supabase project ref, and timestamp age (maximum 300 seconds; maximum future skew 60 seconds).

`preflightRuntime()` exposes the exact Task 2/Task 4 `expectedEnvironment` tuple only after Vercel and signed runtime identity checks. This tuple carries non-secret expected IDs, not evidence that Supabase still has that branch or that a Stripe webhook endpoint exists. Task 4 owns those independent provider checks. Do not copy credentials, secret values, or runtime secret scopes into policy, logs, results, or artifacts; administrators verify those scopes directly in Vercel.
