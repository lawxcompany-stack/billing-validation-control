# Owner-operated control repository transfer and readback

The approved post-transfer identity is `lawx-ai/billing-validation-control`, immutable repository ID `1384018279`, default branch `main`, owner type `Organization`, with public visibility. The last recorded pre-transfer identity is `lawxcompany-stack/billing-validation-control`; the current owner has not yet been independently observed transferring it. Transfer and all post-transfer readbacks are **PENDING** until independently observed. This PR does not transfer the repository, configure settings, register a runner, or establish production/financial readiness.

Only the repository owner performs the transfer through GitHub Settings after independent review and protected merge of the control PR. This procedure transfers only the control repository. The candidate remains `lawxcompany-stack/Plataforma-LawX`, numeric ID `1234079266`; its ownership, workflows, deployments and credentials are outside the transfer. Schema, migrations, hashes, roles, ACLs and stored data are unchanged.

The commands below are read-only operator instructions, not evidence that they were run. Use an already authorized `gh`/registry login provisioned separately; never put an API token on a command line, enable shell tracing, retrieve Environment secret values, or include credentials in the evidence record. The environment loop queries names only, never values. Do not use `.env*`, Production/Live credentials, or secrets as a substitute for missing release/package metadata.

## (a) Before transfer: freeze collect/recheck

Keep `collect`/`recheck` frozen, runner registration and financial execution blocked, and the dedicated runner offline. Leave normal pull-request policy checks on GitHub-hosted `ubuntu-latest`. No PR, fork, unprotected branch or candidate code may select the isolated runner.

Obtain independent review and merge through the protected default branch before the owner proceeds. Task 0 dedicated disposable workstation/display/network proof and Task 9 external setup/readback remain required; this transfer is not a substitute for either.

## (b) Capture current repository and GHCR metadata before transfer

Independently read back the current control identity. Require ID `1384018279`, full name `lawxcompany-stack/billing-validation-control`, branch `main` and public visibility; missing or divergent results stop the procedure.

```bash
gh api repos/lawxcompany-stack/billing-validation-control \
  --jq '{id,full_name,default_branch,visibility,private,owner_type:.owner.type}'
gh api users/lawxcompany-stack/packages/container/billing-validation-control \
  --jq '{name,package_type,visibility,version_count,repository:.repository.full_name,updated_at}'
gh api --paginate users/lawxcompany-stack/packages/container/billing-validation-control/versions \
  --jq '[.[] | {id,name,updated_at,package_html_url,metadata}]'
```

Before transfer, identify the exact digest-pinned image reference consumed from the reviewed, non-secret release record. Require an unambiguous match between that record, package/version metadata, repository linkage, tags and digest. Read the reference at the prompt so it is not placed in shell history; run this exact snippet in Bash with tracing disabled. It validates the exact registry/owner/package/SHA-256 shape and inspects the remote manifest without pulling or running the image:

```bash
(
  read -r -p 'Digest-pinned GHCR reference from the reviewed release record: ' billing_validation_image_ref
  [[ "$billing_validation_image_ref" =~ ^ghcr\.io/lawxcompany-stack/billing-validation-control@sha256:[a-f0-9]{64}$ ]] || exit 1
  docker buildx imagetools inspect "$billing_validation_image_ref"
)
```

For the GHCR record, retain only package visibility, repository linkage, version/tags, the pinned SHA-256 digest, and effective read access. Record whether the authorized operator and intended isolated runner identity have effective read access through independent permission inspection; successful operator inspection alone does not prove runner access. Do not acquire runner credentials or register a runner to test access during this freeze. Use the package's GitHub access settings for permission evidence if the returned metadata does not expose it.

If the current release record or package metadata is unavailable or ambiguous, stop: do not transfer or activate the runner. Do not retrieve or print an Environment secret to compensate. Synthetic fixtures and empty checked-in release policies are not reviewed release evidence. The legacy path `ghcr.io/lawxcompany-stack/billing-validation-control` is preserved until independently observed package/path/digest evidence supports a separately reviewed change.

## (c) Owner transfers only the control repository through GitHub Settings

After the preceding evidence is complete and independently reviewed, the owner transfers only `billing-validation-control` to `lawx-ai` using the repository's GitHub Settings transfer flow. Preserve repository name, public visibility and immutable ID. This PR and the agent do not perform the transfer; no transfer API/CLI mutation is provided here. Keep the operational freeze in effect.

## (d) After transfer: read back repository identity

This phase is pending until the transfer is independently observed.

```bash
gh api repos/lawx-ai/billing-validation-control \
  --jq '{id,full_name,default_branch,visibility,private,owner_type:.owner.type}'
```

Require exactly `lawx-ai/billing-validation-control`, ID `1384018279`, default branch `main`, `visibility: public`, `private: false` and owner type `Organization`. A redirect from an old URL is not canonical identity proof. Never automatically update the ID pin to match a different repository.

## (e) Read back branch protection and all five environments

These readbacks are pending; a dated pre-transfer record does not satisfy them.

```bash
gh api repos/lawx-ai/billing-validation-control/branches/main/protection
gh api --paginate repos/lawx-ai/billing-validation-control/environments \
  --jq '.environments[] | {name,protection_rules,deployment_branch_policy}'
for environment in billing-validation-attestation billing-validation-reader billing-validation-tests billing-validation-publisher billing-validation-control; do
  gh api "repos/lawx-ai/billing-validation-control/environments/$environment" \
    --jq '{name,protection_rules,deployment_branch_policy}'
  gh api "repos/lawx-ai/billing-validation-control/environments/$environment/secrets" \
    --jq '[.secrets[].name]'
done
```

Require active protected `main`: PR and at least one maintainer approval, CODEOWNER approval, stale-review dismissal, latest-push approval, administrator enforcement, no force pushes/deletions, and no bypass actors. Read back an active ruleset and its bypass/enforcement settings if it supplies any of those controls. A missing protection response is a stop; do not infer protection from workflow YAML.

Require all five environment names above, required reviewers with self-review disabled, and `deployment_branch_policy` with `protected_branches: true` and `custom_branch_policies: false` for each environment. The workflow's environment preflight requires these exact values; custom branch policies currently block it even when restricted to `main`. Separately review and change runtime support before considering custom branch policies. The workflow context guard still pins protected `main`. Use this supplemental read-only query when needed:

```bash
gh api --paginate repos/lawx-ai/billing-validation-control/rulesets \
  --jq '.[] | {id,name,enforcement,source_type,source}'
```

For any returned ruleset ID, independently inspect its full rules and bypass actors through its read-only settings/API view. Existence alone, empty reviewer lists or ambiguous branch rules do not pass. The secret loop emits names only; never retrieve or print values. Record non-secret IDs, policies and timestamps.

Preserve the existing Task 9 environment approval gate: exercise `billing-validation-tests` protection with a secret-free hosted check and obtain the user's explicit confirmation that the required reviewer approved that exact run and intended validation branch/deployment before any Preview secret provisioning. Provisioning is separate from this transfer procedure and this PR.

## (f) Read back Apps, collaborators, GHCR and runner restrictions

All items in this phase remain pending until independently observed. Use read-only repository/organization settings and installation-permission views to verify GitHub App installations, their selected repositories and exact scopes. The candidate reader App remains restricted to Actions, Contents and Pull requests read on only `lawxcompany-stack/Plataforma-LawX`; verify its effective installation scope independently. Do not mint tokens, retrieve private keys or install an App as a readback substitute.

Read back collaborators and Actions policy:

```bash
gh api --paginate 'repos/lawx-ai/billing-validation-control/collaborators?affiliation=all' \
  --jq '.[] | {login,role_name,permissions}'
gh api repos/lawx-ai/billing-validation-control/actions/permissions \
  --jq '{enabled,allowed_actions,sha_pinning_required}'
gh api repos/lawx-ai/billing-validation-control/actions/permissions/workflow \
  --jq '{default_workflow_permissions,can_approve_pull_request_reviews}'
```

Verify effective organization/base/team access is limited to approved maintainers, CODEOWNERS resolve to actual approved write/admin accounts, the default `GITHUB_TOKEN` is read-only, and immutable action pins are enforced where supported. The pre-transfer accounts are dated evidence, not proof of organization permissions.

```bash
# Repeat after transfer to read the package at the organization namespace.
gh api orgs/lawx-ai/packages/container/billing-validation-control \
  --jq '{name,package_type,visibility,version_count,repository:.repository.full_name,updated_at}'
gh api --paginate orgs/lawx-ai/packages/container/billing-validation-control/versions \
  --jq '[.[] | {id,name,updated_at,package_html_url,metadata}]'
```

Independently compare post-transfer GHCR visibility, repository linkage, version/tags, effective read access and the exact consumed SHA-256 digest with phase (b). Inspect the observed digest-pinned path's remote manifest without pulling/running it. Do not assume that repository transfer renames or transfers a package. If the organization namespace is absent or the metadata/path/digest/permissions are ambiguous, stop and keep the runner blocked; obtain independently reviewed package-location evidence before any separately reviewed URI change. Do not try an alternative image path or use a secret to discover the release.

Read back the exact organization runner group:

```bash
gh api 'orgs/lawx-ai/actions/runner-groups?visible_to_repository=lawx-ai/billing-validation-control' \
  --jq '.runner_groups[] | select(.name == "billing-validation-isolated") | {id,name,visibility,allows_public_repositories,restricted_to_workflows,selected_workflows,workflow_restrictions_read_only,selected_repositories_url}'
```

Require exactly one group named `billing-validation-isolated` and an unambiguous returned ID before using it below. Resolve that ID and inspect the selected repositories:

```bash
billing_runner_group_id="$(gh api 'orgs/lawx-ai/actions/runner-groups?visible_to_repository=lawx-ai/billing-validation-control' --jq '.runner_groups[] | select(.name == "billing-validation-isolated") | .id')"
gh api --paginate "orgs/lawx-ai/actions/runner-groups/${billing_runner_group_id}/repositories" \
  --jq '[.repositories[].full_name]'
```

The complete returned list must contain exactly `lawx-ai/billing-validation-control`, with group visibility limited to selected repositories. Require `restricted_to_workflows: true` and the exact selected workflow `lawx-ai/billing-validation-control/.github/workflows/validate-billing.yml@refs/heads/main`. Inspect `workflow_restrictions_read_only` and any inherited policy to establish the effective restriction. Public-repository access may be enabled only when required for this public repository and that exact restriction is independently confirmed. Never allow general repository access, PR/fork workflows, unprotected refs or candidate code.

After those restrictions are read back, inspect the group's attached runner membership before the separately supervised first registration. Use the already-resolved `billing_runner_group_id`:

```bash
set -o pipefail
gh api --paginate "orgs/lawx-ai/actions/runner-groups/${billing_runner_group_id}/runners?per_page=100" |
  jq -s -e 'if length == 1 and .[0].total_count == 0 and (.[0].runners | type == "array" and length == 0)
    then {readback_at_utc: (now | todateiso8601), total_count: .[0].total_count, attached_runner_count: (.[0].runners | length)}
    else error("runner membership unreadable, ambiguous, or nonzero") end'
```

Require a successful readback showing zero attached runners; record its UTC timestamp and non-secret count/output as evidence. Treat an API or parsing error, ambiguous response, or any attached runner as a stop: keep registration blocked and seek independent review. Do not remove or mutate runners to satisfy this check.

If GitHub cannot apply or expose these exact restrictions, do not register the runner. Do not remove `--runnergroup`, use a default/broader group, substitute a persistent or shared runner, or rely on `runs-on` labels as admission proof. Preserve ephemeral, single-job, no-default-labels registration and the random 128-bit per-attempt label with trusted reservation and stale-registration checks.

## (g) Run only hosted policy/identity checks

Only after the preceding readbacks, run reviewed secret-free policy/identity checks on GitHub-hosted `ubuntu-latest`. Normal PR checks continue there. Independently inspect the exact SHA/run/attempt and workflow context; confirm PR paths cannot schedule the local runner and wrong owner/ID/ref/group cases refuse.

Do not dispatch `collect`/`recheck`, register a runner, pull/run the collector image, execute candidate code, or treat a hosted green check as real runner, PostgreSQL, provider, financial or production proof. Record the hosted readback separately from offline unit tests.

## (h) Keep execution blocked if any readback is missing

Any absent, ambiguous or mismatched repository identity, protection, environment reviewer/deployment policy, App scope, collaborator permission, package/release/digest/access record or runner restriction keeps runner and financial execution blocked. No fallback or automatic reverse transfer is authorized. Corrections require owner action and independent readback; code/pin changes require another reviewed PR.

Task 0 must independently prove the dedicated disposable workstation, nested display and Docker context `billing-validation-isolated` point to the approved isolated host. Task 9 must independently verify external authorization, environment gates, runner repository/workflow restrictions, trusted per-attempt label reservation, one-job lifecycle, image/release pins and cleanup. Never use the shared multi-service runner as a relay or fallback. Those requirements and separately authorized isolated Preview/Supabase/Stripe TEST evidence remain prerequisites for any later financial execution. No DB access, migration, stored-data rewrite, production deployment or Live mutation is part of this cutover.

| Evidence | Status |
| --- | --- |
| Owner transfer | PENDING — independent observation required |
| Current pre-transfer repository and GHCR release/package/digest/access capture | PENDING — independent observation required |
| Post-transfer full name/ID/default branch/visibility | PENDING — independent observation required |
| Branch protection and five environment reviewer/deployment policies; secret names only | PENDING — independent observation required |
| App installations/scopes and collaborator/effective permissions | PENDING — independent observation required |
| Post-transfer GHCR path/linkage/version/digest/read access | PENDING — independent observation required |
| Exact runner group, repository list and protected workflow restrictions | PENDING — independent observation required |
| Hosted policy/identity checks after readback | PENDING — independent observation required |
| Task 0/9 and later runner/financial execution | BLOCKED — pending independent prerequisites |

For each readback, record the non-secret evidence, independent reviewer and timestamp. Keep GHCR records limited to the fields listed in phase (b). This document, this PR and passing offline tests prove no current settings or production readiness.
