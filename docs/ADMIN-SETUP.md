# Control repository administrator setup and readback

This is an implementation checklist for the private billing control repository. It does not create or activate GitHub settings. The Task 1 workflows are a fail-closed bootstrap and do not validate billing readiness. Do not treat branch protection, environments, Apps, secrets, or runner restrictions as active until an authorized administrator completes Task 9 and records API readback.

## Repository access and default branch

Before enabling a dispatch:

1. Confirm the private repository identity is `lawxcompany-stack/billing-validation-control`; record its numeric repository ID and current default branch from the GitHub API. The workflows read the default branch from the event and refuse any other control ref.
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
- Never use this test runner for pull-request validation. The `pull_request` policy job runs on `ubuntu-latest`; only a protected and authorized `collect` dispatch may select the per-attempt self-hosted label. The runner must be registered as single-use and ephemeral, and the runner group must be restricted to this repository and workflow before Task 9 activates it.
- The Task 1 reader, test, and publisher jobs deliberately stop with failure until their later-task implementations exist. This prevents a successful bootstrap run from being mistaken for a billing readiness result.

At Task 9, read back the environment policies, installed App scopes, runner group/workflow restrictions, and one-job runner lifecycle through the relevant GitHub APIs. Preserve non-secret IDs and timestamps as evidence; do not copy secret values into the record.
