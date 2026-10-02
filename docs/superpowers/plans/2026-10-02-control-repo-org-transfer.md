# Control Repository Organization Transfer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare and open a reviewed PR that retargets the control plane from the personal owner to `lawx-ai`, preserves the self-hosted runner security boundary, and leaves the actual GitHub transfer as a separately approved owner operation.

**Architecture:** Add one canonical control-repository identity contract, then migrate the dispatch, authorization/attestation, runner, persisted-workflow, and workflow-guard consumers to that contract. Keep the immutable repository ID fixed at `1384018279`; reject the old owner for new operational evidence because read-only GitHub queries found no authorization or `workflow_dispatch` runs to preserve. Keep the GHCR image namespace and digest pin unchanged until post-transfer package readback proves whether GitHub moved it.

**Tech Stack:** Node.js 22 ESM, `node:test`, YAML workflow policy tests, bash runner entrypoint, GitHub CLI/API readback, PostgreSQL 17 Docker harness, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-02-control-repo-org-transfer-design.md`

## Global Constraints

- Control repository after transfer: `lawx-ai/billing-validation-control`; immutable repository ID: `1384018279`; default branch: `main`.
- Application candidate remains `lawxcompany-stack/Plataforma-LawX`, repository ID `1234079266`.
- Do not change any applied/pinned control-store migration, database role/ACL, signing key, Vercel project, Stripe account, Supabase project, or any workflow in the separate application repository.
- Never use a personal-repository runner fallback, remove `--runnergroup`, weaken the ephemeral one-job runner, or allow PR/fork jobs onto the local runner.
- Keep PR CI on GitHub-hosted runners. Operational dispatch remains frozen until post-transfer owner/ID/settings readback passes.
- Do not rename the GHCR package path or update its digest without package metadata readback and a separately reviewed change.
- Do not transfer the repository, edit GitHub settings, register a runner, add secrets, run financial workflows, deploy, or mutate any provider as part of this PR.
- Keep the spec’s explicit failure behavior: any mismatched identity or unverified runner restriction blocks operation; no automatic fallback.

---

### Task 0: Commit the approved implementation plan

**Files:**
- Add: `docs/superpowers/plans/2026-10-02-control-repo-org-transfer.md`

**Interfaces:**
- The already committed specification is `docs/superpowers/specs/2026-10-02-control-repo-org-transfer-design.md`.
- Tasks 1–8 implement only that specification; Task 1 creates the shared identity contract required by Tasks 2–5. Tasks 2–5 may proceed independently after Task 1 is committed. Task 6 follows Tasks 1–5; Tasks 7–8 follow Task 6.

- [ ] **Step 1: Check the plan for whitespace errors**

Run: `git diff --no-index --check /dev/null docs/superpowers/plans/2026-10-02-control-repo-org-transfer.md`

Expected: no whitespace diagnostics; exit status 1 is expected because the plan is a new file.

- [ ] **Step 2: Commit the approved plan**

Run: `git add docs/superpowers/plans/2026-10-02-control-repo-org-transfer.md`

Run: `git commit -m "docs: plan control repository organization transfer"`

---

### Task 1: Add the canonical control identity contract

**Files:**
- Create: `src/contracts/control-identity.mjs`
- Create: `test/contracts/control-identity.test.mjs`
- Modify: `src/contracts/dispatch.mjs`
- Modify: `scripts/read-candidate.mjs`
- Modify: `test/workflows/dispatch.test.mjs`
- Modify: `test/github/candidate-reader.test.mjs`

**Interfaces:**
- Produces `CONTROL_REPOSITORY = 'lawx-ai/billing-validation-control'` and `CONTROL_REPOSITORY_ID = '1384018279'`.
- Produces `matchesControlRepository(repository, repositoryId)`, which accepts only the exact canonical full name plus the exact decimal ID. It accepts the GitHub API’s positive safe integer ID or GitHub Actions’ canonical decimal string; it rejects all other types and leading-zero forms.
- The old full name `lawxcompany-stack/billing-validation-control` is not a valid identity for new operations. No historical alias is introduced because no operational authorization/dispatch run exists in GitHub readback.

- [ ] **Step 1: Write failing identity and dispatch tests**

Add `test/contracts/control-identity.test.mjs` with the imports and assertions below. Update the dispatch fixture in `test/workflows/dispatch.test.mjs` to include `repositoryId: '1384018279'` and add a wrong-ID refusal assertion.

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONTROL_REPOSITORY, CONTROL_REPOSITORY_ID, matchesControlRepository } from '../../src/contracts/control-identity.mjs';

test('exports the pinned control identity and matches only its exact repository and ID', () => {
  assert.equal(CONTROL_REPOSITORY, 'lawx-ai/billing-validation-control');
  assert.equal(CONTROL_REPOSITORY_ID, '1384018279');
  assert.equal(matchesControlRepository('lawx-ai/billing-validation-control', '1384018279'), true);
  assert.equal(matchesControlRepository('lawx-ai/billing-validation-control', 1384018279), true);
  assert.equal(matchesControlRepository('lawxcompany-stack/billing-validation-control', '1384018279'), false);
  assert.equal(matchesControlRepository('attacker/billing-validation-control', '1384018279'), false);
  assert.equal(matchesControlRepository('lawx-ai/billing-validation-control', '1384018278'), false);
  assert.equal(matchesControlRepository('lawx-ai/billing-validation-control', '01384018279'), false);
  assert.equal(matchesControlRepository('lawx-ai/billing-validation-control', true), false);
  assert.equal(matchesControlRepository('lawx-ai/billing-validation-control', '1384018279 '), false);
  assert.equal(matchesControlRepository(null, '1384018279'), false);
});
```

In `test/workflows/dispatch.test.mjs`, use the existing protected context and assert the wrong repository ID raises the established refusal code:

```js
assert.throws(
  () => assertProtectedDefaultRef({ ...protectedContext, repositoryId: '1384018278' }),
  { code: 'control_repository_not_allowed' },
);
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `node --test test/contracts/control-identity.test.mjs test/workflows/dispatch.test.mjs test/github/candidate-reader.test.mjs`

Expected: fail because the canonical identity helper is missing, the dispatch context still accepts the personal owner, or its callers do not pass the repository ID.

- [ ] **Step 3: Implement the exact identity helper and thread the ID through dispatch**

Implement `matchesControlRepository` using exact-type handling (no loose equality or arbitrary `String()` coercion). Update `assertProtectedDefaultRef` to require both canonical `repository` and pinned `repositoryId`. Pass `CONTROL_REPOSITORY_ID` from `scripts/read-candidate.mjs`’s protected context. Task 2 wires `${{ github.repository_id }}` into the candidate-reader step. Do not alter the persisted database schema; runtime repository ID is proven before writes, while stored workflow identity remains the exact canonical full name.

```js
export const CONTROL_REPOSITORY = 'lawx-ai/billing-validation-control';
export const CONTROL_REPOSITORY_ID = '1384018279';
export function matchesControlRepository(repository, repositoryId) {
  if (typeof repository !== 'string' || repository !== CONTROL_REPOSITORY) return false;
  if (typeof repositoryId === 'string') return repositoryId === CONTROL_REPOSITORY_ID;
  return Number.isSafeInteger(repositoryId) && repositoryId > 0 &&
    String(repositoryId) === CONTROL_REPOSITORY_ID;
}
```

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run: `node --test test/contracts/control-identity.test.mjs test/workflows/dispatch.test.mjs test/github/candidate-reader.test.mjs`

Expected: all tests pass; old owner, wrong ID, malformed ID, foreign owner, non-main ref, and unprotected-ref cases refuse before returning a dispatch identity.

- [ ] **Step 5: Commit the identity contract**

Run: `git add src/contracts/control-identity.mjs test/contracts/control-identity.test.mjs src/contracts/dispatch.mjs scripts/read-candidate.mjs test/workflows/dispatch.test.mjs test/github/candidate-reader.test.mjs`

Run: `git commit -m "feat: pin canonical control repository identity"`

---

### Task 2: Retarget workflow dispatch guards without changing runner routing

**Files:**
- Modify: `.github/workflows/authorize-local-collector.yml`
- Modify: `.github/workflows/validate-billing.yml`
- Modify: `test/workflows/task4-workflow.test.mjs`
- Modify: `test/workflows/workflow-policy.test.mjs`
- Modify: `test/workflows/billing-result-workflow.test.mjs`
- Modify: `test/workflows/secret-boundary.mjs`

**Interfaces:**
- Workflow-dispatch authorization requires `github.repository == 'lawx-ai/billing-validation-control'`, `github.repository_id == '1384018279'`, protected `refs/heads/main`, default branch `main`, and the existing dependency success conditions.
- PR policy jobs remain on `ubuntu-latest`; only the already-gated operational test job can consume the one-attempt label.

- [ ] **Step 1: Add failing workflow identity assertions**

In `test/workflows/task4-workflow.test.mjs` and `test/workflows/workflow-policy.test.mjs`, assert that every operational job-level `if` requiring dispatch contains the new canonical repository and unchanged numeric ID, and that every `pull_request` validation job resolves to a GitHub-hosted runner. Update the exact workflow snapshots in `test/workflows/secret-boundary.mjs` so they continue asserting every environment, permission, dependency, and guard field.

```js
assert.match(job.if, /github\.repository\s*==\s*'lawx-ai\/billing-validation-control'/u);
assert.match(job.if, /github\.repository_id\s*==\s*'1384018279'/u);
assert.ok(isHostedRunner(policyJob['runs-on']));
```

The preserved workflow guard shape is:

```yaml
if: ${{ github.event_name == 'workflow_dispatch' && github.repository == 'lawx-ai/billing-validation-control' && github.repository_id == '1384018279' && github.ref == 'refs/heads/main' && github.event.repository.default_branch == 'main' && github.ref_protected }}
```

- [ ] **Step 2: Run workflow tests and confirm RED**

Run: `node --test test/workflows/task4-workflow.test.mjs test/workflows/workflow-policy.test.mjs test/workflows/billing-result-workflow.test.mjs`

Expected: identity assertions fail against the old owner slug.

- [ ] **Step 3: Update only control-repository predicates and inline identity**

Replace the old control slug in both workflows’ dispatch guards and the inline reader validation. In the `validate-billing.yml` candidate-reader step, add `CONTROL_REPOSITORY_ID: ${{ github.repository_id }}` beside `CONTROL_REPOSITORY`; keep the existing repository-ID forwarding in `authorize-local-collector.yml`. Preserve every job dependency, environment gate, runner label expression, permissions block, timeout, and action pin. Do not change the candidate repository default or its ID.

- [ ] **Step 4: Run workflow tests and confirm GREEN**

Run: `node --test test/workflows/task4-workflow.test.mjs test/workflows/workflow-policy.test.mjs test/workflows/billing-result-workflow.test.mjs test/workflows/dispatch.test.mjs`

Run: `node test/workflows/secret-boundary.mjs`

Expected: all workflow identity and hosted-PR boundary assertions pass; no PR-triggered job can use a self-hosted label.

- [ ] **Step 5: Commit the workflow retargeting**

Run: `git add .github/workflows/authorize-local-collector.yml .github/workflows/validate-billing.yml test/workflows/task4-workflow.test.mjs test/workflows/workflow-policy.test.mjs test/workflows/billing-result-workflow.test.mjs test/workflows/secret-boundary.mjs`

Run: `git commit -m "fix: pin operational workflow owner after transfer"`

---

### Task 3: Migrate the authorization manifest and hosted attestation verifier

**Files:**
- Modify: `src/authorization/dispatch.mjs`
- Modify: `src/authorization/manifest.mjs`
- Modify: `src/authorization/context.mjs`
- Modify: `src/authorization/verifier-internal.mjs`
- Modify: `test/authorization/fixtures.mjs`
- Modify: `test/authorization/task2-fixtures.mjs`
- Modify: `test/authorization/manifest.test.mjs`
- Modify: `test/authorization/context.test.mjs`
- Modify: `test/authorization/verifier.test.mjs`
- Modify: `test/authorization/emitter.test.mjs`

**Interfaces:**
- New authorization manifests, API reads, GitHub checks, certificate identities, and signer workflow paths bind to `lawx-ai/billing-validation-control` and ID `1384018279`.
- The candidate remains `lawxcompany-stack/Plataforma-LawX` and ID `1234079266`.
- `collectorRelease.image` stays pinned to its existing old GHCR namespace and immutable digest until a later GHCR readback establishes the package’s post-transfer location.

- [ ] **Step 1: Write failing canonical-byte, API-root, and old-signer rejection tests**

Update test expectations first: change the `control.repository` field in the independently spelled manifest bytes and authorization API fixtures to the target owner, keep the candidate and image fields unchanged, and add a rejection case for an old-owner control manifest.

For the new owner, keep the image namespace separately pinned:

```js
assert.equal(manifest.control.repository, CONTROL_REPOSITORY);
assert.equal(manifest.control.repositoryId, CONTROL_REPOSITORY_ID);
assert.match(manifest.collectorRelease.image,
  /^ghcr\.io\/lawxcompany-stack\/billing-validation-control@sha256:[a-f0-9]{64}$/u);
```

- [ ] **Step 2: Run authorization tests and confirm RED**

Run: `node --test test/authorization/manifest.test.mjs test/authorization/context.test.mjs test/authorization/verifier.test.mjs test/authorization/emitter.test.mjs`

Expected: canonical manifest construction, fixed API route, or signature identity assertions fail until runtime code is migrated.

- [ ] **Step 3: Update authorization consumers to use the shared identity**

Import the constants/helper from `src/contracts/control-identity.mjs`. Update the fixed GitHub API root to `https://api.github.com/repos/lawx-ai/billing-validation-control`; require the exact new full name and ID in run and head-repository reads; bind manifest and verified certificate URIs to the new control owner. Keep candidate checks and the existing `ghcr.io/lawxcompany-stack/billing-validation-control@sha256:<digest>` image format unchanged.

For example, `src/authorization/context.mjs` uses the shared canonical route:

```js
import { CONTROL_REPOSITORY } from '../contracts/control-identity.mjs';
const ROOT = `https://api.github.com/repos/${CONTROL_REPOSITORY}`;
```

- [ ] **Step 4: Run authorization tests and confirm GREEN**

Run: `node --test test/authorization/manifest.test.mjs test/authorization/context.test.mjs test/authorization/verifier.test.mjs test/authorization/emitter.test.mjs`

Expected: new owner + exact repository ID succeeds; old owner, arbitrary owner, wrong ID, candidate-as-control, changed signer workflow, and modified canonical bytes fail closed.

- [ ] **Step 5: Commit authorization and attestation retargeting**

Run: `git add src/authorization/dispatch.mjs src/authorization/manifest.mjs src/authorization/context.mjs src/authorization/verifier-internal.mjs test/authorization/fixtures.mjs test/authorization/task2-fixtures.mjs test/authorization/manifest.test.mjs test/authorization/context.test.mjs test/authorization/verifier.test.mjs test/authorization/emitter.test.mjs`

Run: `git commit -m "fix: bind billing authorization to lawx-ai"`

---

### Task 4: Migrate runner context, registration target, and result/activation attestations

**Files:**
- Modify: `runner/workflow-context-internal.mjs`
- Modify: `runner/trust-policy.mjs`
- Modify: `runner/entrypoint.sh`
- Modify: `runner/activation-manifest.mjs`
- Modify: `runner/write-activation-manifest.mjs`
- Modify: `runner/activation-verifier-internal.mjs`
- Modify: `runner/billing-result-manifest.mjs`
- Modify: `runner/billing-result-verifier-internal.mjs`
- Modify: `test/runner/runner.test.mjs`
- Modify: `test/runner/workflow-context.test.mjs`
- Modify: `test/runner/activation.test.mjs`
- Modify: `test/runner/activation-verifier.test.mjs`
- Modify: `test/runner/supervisor-activation.test.mjs`
- Modify: `test/runner/supervisor.test.mjs`
- Modify: `test/runner/billing-result.test.mjs`

**Interfaces:**
- Runner API reads and attestation URIs bind to the new repository name and existing immutable ID.
- `runner/entrypoint.sh` accepts only repository `lawx-ai/billing-validation-control`, ID `1384018279`, branch/workflow/run selectors already reviewed, group `billing-validation-isolated`, and the existing random per-attempt label.
- Runner registration targets organization URL `https://github.com/lawx-ai`, uses the existing organization runner group, `--ephemeral --disableupdate --no-default-labels`, and the current one-job lifecycle. Registration tokens remain operator-supplied, short-lived, and absent from logs.

- [ ] **Step 1: Add failing API/attestation/entrypoint identity tests**

Change runner fixtures’ canonical control owner first; add explicit refusals for the old owner and wrong ID in workflow-context, activation-verifier, and entrypoint tests. Assert the runner configuration URL is the organization URL, not a personal repository URL.

The entrypoint contract being tested is:

```bash
[[ "$control_repository" == lawx-ai/billing-validation-control &&
   "$control_repository_id" == 1384018279 &&
   "$control_runner_group" == billing-validation-isolated ]]
```

- [ ] **Step 2: Run focused runner tests and confirm RED**

Run: `node --test test/runner/runner.test.mjs test/runner/workflow-context.test.mjs test/runner/activation.test.mjs test/runner/activation-verifier.test.mjs test/runner/supervisor-activation.test.mjs test/runner/supervisor.test.mjs test/runner/billing-result.test.mjs`

Expected: tests fail on stale owner, URI, API route, or registration URL.

- [ ] **Step 3: Update runner identities and organization registration URL**

Import shared control identity constants where the runner code runs from the repository checkout. Update the runner API endpoint, activation/result manifests and verifier signer URIs, exact repository ID gate in `entrypoint.sh`, and its `config.sh --url` to `https://github.com/lawx-ai`. Preserve the `--runnergroup billing-validation-isolated`, no-default-label, ephemeral, one-shot, token-unset, and cleanup behavior. Do not add a token-minting API or credential.

Runner modules import the one shared source, and the entrypoint registers at organization scope:

```js
import { CONTROL_REPOSITORY, CONTROL_REPOSITORY_ID } from '../src/contracts/control-identity.mjs';
```

```bash
"$runner_home/config.sh" --unattended --ephemeral --disableupdate --no-default-labels \
  --url https://github.com/lawx-ai --token "$RUNNER_REGISTRATION_TOKEN" \
  --name "$runner_name" --labels "$RUNNER_LABEL" --runnergroup "$control_runner_group" --work _work
```

- [ ] **Step 4: Run focused runner tests and confirm GREEN**

Run: `node --test test/runner/runner.test.mjs test/runner/workflow-context.test.mjs test/runner/activation.test.mjs test/runner/activation-verifier.test.mjs test/runner/supervisor-activation.test.mjs test/runner/supervisor.test.mjs test/runner/billing-result.test.mjs`

Expected: new owner and exact ID pass; old owner, wrong ID, altered signer URI, repository URL registration, fixed label, missing group, or missing token fail closed. Tokens in tests remain synthetic fixtures only.

- [ ] **Step 5: Commit runner and attestation retargeting**

Run: `git add runner/workflow-context-internal.mjs runner/trust-policy.mjs runner/entrypoint.sh runner/activation-manifest.mjs runner/write-activation-manifest.mjs runner/activation-verifier-internal.mjs runner/billing-result-manifest.mjs runner/billing-result-verifier-internal.mjs test/runner/runner.test.mjs test/runner/workflow-context.test.mjs test/runner/activation.test.mjs test/runner/activation-verifier.test.mjs test/runner/supervisor-activation.test.mjs test/runner/supervisor.test.mjs test/runner/billing-result.test.mjs`

Run: `git commit -m "fix: bind isolated runner to lawx-ai control repo"`

---

### Task 5: Migrate persisted attempt fixtures and operational documentation

**Files:**
- Modify: `src/contracts/attempt.mjs`
- Modify: `test/attempts/attempts.test.mjs`
- Modify: `test/attempts/concurrency.test.mjs`
- Modify: `test/attempts/contracts.test.mjs`
- Modify: `test/attempts/postgres.test.mjs`
- Modify: `test/attempts/control-store-postgres.integration.test.mjs`
- Modify: `test/billing/support.mjs`
- Modify: `test/billing/contracts.test.mjs`
- Modify: `test/runtime/stripe.test.mjs`
- Modify: `docs/ADMIN-SETUP.md`
- Modify: `docs/OPERATIONS.md`
- Modify: `docs/local-authorization.md`
- Modify: `docs/CI-UNBLOCKING.md`
- Create: `docs/control-repository-transfer.md`

**Interfaces:**
- Durable attempt validation accepts only the new canonical control slug; no database columns, schema, migration hashes, or stored data are rewritten.
- Active runbooks distinguish “current owner has not yet transferred the repository” from “post-transfer target,” preserve the explicit runner activation block, and never claim that settings or production readiness were proven.
- Historical superpowers specs/plans remain historical records; they are not mass-rewritten.

- [ ] **Step 1: Add a failing persisted-attempt identity test**

In `test/attempts/contracts.test.mjs`, assert a new canonical workflow identity is accepted and the old control owner and candidate owner are rejected. Update control-repository fixtures in `test/attempts/attempts.test.mjs`, `test/attempts/concurrency.test.mjs`, `test/attempts/postgres.test.mjs`, `test/attempts/control-store-postgres.integration.test.mjs`, `test/billing/support.mjs`, `test/billing/contracts.test.mjs`, and `test/runtime/stripe.test.mjs` to use the new full name without changing SQL or migrations. Keep candidate-repository fixtures unchanged.

- [ ] **Step 2: Run attempt and billing contract tests and confirm RED**

Run: `node --test test/attempts/contracts.test.mjs test/attempts/attempts.test.mjs test/attempts/concurrency.test.mjs test/attempts/postgres.test.mjs test/billing/contracts.test.mjs test/runtime/stripe.test.mjs`

Expected: old-owner fixtures fail validation until the canonical contract and fixtures are updated.

- [ ] **Step 3: Update the attempt identity and controlled fixtures**

Use the shared canonical constant in `src/contracts/attempt.mjs`. Update only fixtures that represent the control repository; retain candidate-repository literals and unrelated owner usernames unchanged. Keep schema/migration files byte-identical.

```js
import { CONTROL_REPOSITORY } from './control-identity.mjs';
assert.equal(workflow.repository, CONTROL_REPOSITORY);
```

- [ ] **Step 4: Add the operator transfer/readback runbook**

Create `docs/control-repository-transfer.md` with these explicit phases: (a) before transfer, freeze `collect`/`recheck`; (b) capture current repo and GHCR package metadata, linkage, permission, and the exact digest-pinned image reference consumed; (c) owner transfers only the control repo through GitHub Settings; (d) after transfer, read back full name/ID/default branch/visibility; (e) read back protection and five environment reviewer/deployment policies and secret names only; (f) read back GitHub App installation/scopes, collaborators, GHCR path/digest, and `billing-validation-isolated` repository/workflow restrictions; (g) run only hosted policy/identity checks; (h) leave runner/financial execution blocked if any readback is missing.

Include these read-only commands for repository and settings identity; add the five environment secret-name queries in a loop whose output includes only names, never values:

```bash
gh api users/lawxcompany-stack/packages/container/billing-validation-control \
  --jq '{name,package_type,visibility,version_count,repository:.repository.full_name,updated_at}'
gh api --paginate users/lawxcompany-stack/packages/container/billing-validation-control/versions \
  --jq '[.[] | {id,name,updated_at,package_html_url,metadata}]'
# Repeat after transfer to read the package at the organization namespace.
gh api orgs/lawx-ai/packages/container/billing-validation-control \
  --jq '{name,package_type,visibility,version_count,repository:.repository.full_name,updated_at}'
gh api --paginate orgs/lawx-ai/packages/container/billing-validation-control/versions \
  --jq '[.[] | {id,name,updated_at,package_html_url,metadata}]'
gh api repos/lawx-ai/billing-validation-control \
  --jq '{id,full_name,default_branch,visibility,private,owner_type:.owner.type}'
gh api repos/lawx-ai/billing-validation-control/branches/main/protection
gh api --paginate repos/lawx-ai/billing-validation-control/environments \
  --jq '.environments[] | {name,protection_rules,deployment_branch_policy}'
for environment in billing-validation-attestation billing-validation-reader billing-validation-tests billing-validation-publisher billing-validation-control; do
  gh api "repos/lawx-ai/billing-validation-control/environments/$environment" \
    --jq '{name,protection_rules,deployment_branch_policy}'
  gh api "repos/lawx-ai/billing-validation-control/environments/$environment/secrets" \
    --jq '[.secrets[].name]'
done
gh api repos/lawx-ai/billing-validation-control/actions/permissions \
  --jq '{enabled,allowed_actions,sha_pinning_required}'
gh api 'orgs/lawx-ai/actions/runner-groups?visible_to_repository=lawx-ai/billing-validation-control' \
  --jq '.runner_groups[] | select(.name == "billing-validation-isolated") | {id,name,visibility,allows_public_repositories,restricted_to_workflows,selected_workflows,workflow_restrictions_read_only,selected_repositories_url}'
```

Resolve the runner group’s returned ID and verify its selected-repository list with these read-only commands; the returned list must contain exactly `lawx-ai/billing-validation-control`:

```bash
billing_runner_group_id="$(gh api 'orgs/lawx-ai/actions/runner-groups?visible_to_repository=lawx-ai/billing-validation-control' --jq '.runner_groups[] | select(.name == "billing-validation-isolated") | .id')"
gh api --paginate "orgs/lawx-ai/actions/runner-groups/${billing_runner_group_id}/repositories" \
  --jq '[.repositories[].full_name]'
```

Commands must never accept an API token as a command argument. State that the owner performs the transfer; this PR does not.

Before transfer, identify the digest-pinned image reference from the reviewed, non-secret release record. Read it without placing it in shell history, validate its exact registry/owner/package/SHA-256 shape, and query the remote manifest without pulling or running it:

```bash
(
  read -r -p 'Digest-pinned GHCR reference from the reviewed release record: ' billing_validation_image_ref
  [[ "$billing_validation_image_ref" =~ ^ghcr\.io/lawxcompany-stack/billing-validation-control@sha256:[a-f0-9]{64}$ ]] || exit 1
  docker buildx imagetools inspect "$billing_validation_image_ref"
)
```

Record only package visibility, repository linkage, version/tags, the pinned SHA-256 digest, and effective read access. If the current release record or package metadata is unavailable or ambiguous, do not transfer or activate the runner; do not retrieve or print an Environment secret to compensate.

- [ ] **Step 5: Update active runbooks and mark cutover status accurately**

Update `ADMIN-SETUP.md`, `OPERATIONS.md`, `local-authorization.md`, and `CI-UNBLOCKING.md` to name `lawx-ai/billing-validation-control` as the approved post-transfer identity while clearly stating the transfer/readback is pending until independently observed. Replace claims that the repository is still personally owned or that organization runner groups are unavailable; state that the control repository transfer and exact group readback remain prerequisites. Preserve the requirements for public visibility, hosted PR checks, runner group restrictions, and Task 0/9. Do not edit historical specs/plans or change `Plataforma-LawX` references.

- [ ] **Step 6: Run focused persisted-contract tests and confirm GREEN**

Run: `node --test test/attempts/contracts.test.mjs test/attempts/attempts.test.mjs test/attempts/concurrency.test.mjs test/attempts/postgres.test.mjs test/billing/contracts.test.mjs test/runtime/stripe.test.mjs`

Expected: all selected contract/runtime tests pass; any credential-gated remote database test remains explicitly skipped and is not represented as a PostgreSQL proof. No migration hash or schema assertion changes.

- [ ] **Step 7: Commit persisted identity fixtures and runbooks**

Run: `git add src/contracts/attempt.mjs test/attempts/attempts.test.mjs test/attempts/concurrency.test.mjs test/attempts/contracts.test.mjs test/attempts/postgres.test.mjs test/attempts/control-store-postgres.integration.test.mjs test/billing/support.mjs test/billing/contracts.test.mjs test/runtime/stripe.test.mjs docs/ADMIN-SETUP.md docs/OPERATIONS.md docs/local-authorization.md docs/CI-UNBLOCKING.md docs/control-repository-transfer.md`

Run: `git commit -m "docs: document control repository transfer gates"`

---

### Task 6: Prove workflow boundaries and inventory remaining legacy identities

**Files:**
- Create: `test/contracts/control-owner-boundary.test.mjs`

**Interfaces:**
- Remaining `lawxcompany-stack/billing-validation-control` references in active executable code are limited to the deliberately pinned legacy GHCR package namespace in `src/authorization/manifest.mjs` and `src/authorization/release-policy.mjs`; any occurrence in a historical design/plan is retained as historical text.
- New dispatch/manifest/workflow identities reject the old owner; the unchanged candidate identity remains valid only in candidate fields.

- [ ] **Step 1: Add a static identity-boundary regression test**

Create `test/contracts/control-owner-boundary.test.mjs`. It reads this exact active identity file list: `.github/workflows/authorize-local-collector.yml`, `.github/workflows/validate-billing.yml`, `scripts/read-candidate.mjs`, `src/contracts/control-identity.mjs`, `src/contracts/dispatch.mjs`, `src/contracts/attempt.mjs`, `src/authorization/dispatch.mjs`, `src/authorization/context.mjs`, `src/authorization/manifest.mjs`, `src/authorization/verifier-internal.mjs`, `src/authorization/release-policy.mjs`, `runner/entrypoint.sh`, `runner/trust-policy.mjs`, `runner/workflow-context-internal.mjs`, `runner/activation-manifest.mjs`, `runner/write-activation-manifest.mjs`, `runner/activation-verifier-internal.mjs`, `runner/billing-result-manifest.mjs`, and `runner/billing-result-verifier-internal.mjs`. It requires `CONTROL_REPOSITORY` and `CONTROL_REPOSITORY_ID` to be exported by the shared identity module; asserts each workflow guard pins both canonical owner/name and ID; rejects the old owner slug in all runtime identity locations; allows old-owner text only as the existing GHCR image URI in the `collectorRelease.image` field of `manifest.mjs` and the matching digest-only regex in `release-policy.mjs`; and asserts that `manifest.mjs` still binds candidate identity to `lawxcompany-stack/Plataforma-LawX` / `1234079266`. Do not scan historical design/plan documents as active code.

Use this complete static-test structure:

```js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTROL_REPOSITORY, CONTROL_REPOSITORY_ID, matchesControlRepository } from '../../src/contracts/control-identity.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const IDENTITY_PATHS = [
  '.github/workflows/authorize-local-collector.yml',
  '.github/workflows/validate-billing.yml',
  'scripts/read-candidate.mjs',
  'src/contracts/control-identity.mjs',
  'src/contracts/dispatch.mjs',
  'src/contracts/attempt.mjs',
  'src/authorization/dispatch.mjs',
  'src/authorization/context.mjs',
  'src/authorization/manifest.mjs',
  'src/authorization/verifier-internal.mjs',
  'src/authorization/release-policy.mjs',
  'runner/entrypoint.sh',
  'runner/trust-policy.mjs',
  'runner/workflow-context-internal.mjs',
  'runner/activation-manifest.mjs',
  'runner/write-activation-manifest.mjs',
  'runner/activation-verifier-internal.mjs',
  'runner/billing-result-manifest.mjs',
  'runner/billing-result-verifier-internal.mjs',
];
const OLD_OWNER_PACKAGE_ALLOWLIST = new Map([
  ['src/authorization/manifest.mjs', 'ghcr.io/lawxcompany-stack/billing-validation-control@sha256:'],
  ['src/authorization/release-policy.mjs', String.raw`ghcr\.io\/lawxcompany-stack\/billing-validation-control@sha256:`],
]);

assert.equal(CONTROL_REPOSITORY, 'lawx-ai/billing-validation-control');
assert.equal(CONTROL_REPOSITORY_ID, '1384018279');
assert.equal(matchesControlRepository('lawx-ai/billing-validation-control', '1384018279'), true);
assert.equal(matchesControlRepository('lawxcompany-stack/billing-validation-control', '1384018279'), false);
assert.match(read('src/authorization/manifest.mjs'), /repository: literal\('lawxcompany-stack\/Plataforma-LawX'\),\s*repositoryId: literal\('1234079266'\)/u);

for (const workflowPath of [
  '.github/workflows/authorize-local-collector.yml',
  '.github/workflows/validate-billing.yml',
]) {
  const workflow = read(workflowPath);
  assert.match(workflow, /github\.repository == 'lawx-ai\/billing-validation-control'/u);
  assert.match(workflow, /github\.repository_id == '1384018279'/u);
}

for (const path of IDENTITY_PATHS) {
  let source = read(path).replaceAll('\\.', '.').replaceAll('\\/', '/');
  const packageReference = OLD_OWNER_PACKAGE_ALLOWLIST.get(path);
  if (packageReference !== undefined) {
    const normalizedReference = packageReference.replaceAll('\\.', '.').replaceAll('\\/', '/');
    assert.equal(source.split(normalizedReference).length - 1, 1, `${path} must retain exactly one pinned GHCR reference`);
    source = source.replace(normalizedReference, '');
  }
  assert.doesNotMatch(source, /lawxcompany-stack\/billing-validation-control/u, `${path} contains a legacy control owner`);
}
```

- [ ] **Step 2: Run the static boundary test and confirm RED**

Run: `node --test test/contracts/control-owner-boundary.test.mjs`

Expected: fail while any operational file retains the personal owner outside the two exact GHCR package contexts, either workflow lacks a canonical owner or ID guard, or candidate identity drifts. The Task 2 workflow-policy tests separately prove PR jobs remain hosted.

- [ ] **Step 3: Resolve only active control identity leftovers**

Remove the old owner from `src/contracts/dispatch.mjs`, `src/contracts/attempt.mjs`, `src/authorization/dispatch.mjs`, `src/authorization/context.mjs`, the `control.repository` value in `src/authorization/manifest.mjs`, `src/authorization/verifier-internal.mjs`, `scripts/read-candidate.mjs`, all owner-bound runner modules, both workflows, and their active fixtures/runbooks. Retain the old owner only in the exact GHCR image field and digest-only package matcher. Keep the GHCR digest unchanged. Do not edit historical design/plan documents or replace the candidate repository.

- [ ] **Step 4: Run the boundary test and confirm GREEN**

Run: `node --test test/contracts/control-owner-boundary.test.mjs test/contracts/control-identity.test.mjs test/workflows/task4-workflow.test.mjs test/workflows/workflow-policy.test.mjs test/workflows/billing-result-workflow.test.mjs`

Expected: only the approved GHCR image field and digest-only package matcher contain the old owner; shared runtime identity and workflow guards pin the canonical owner and ID, candidate identity is unchanged, and PR checks are hosted-only.

- [ ] **Step 5: Commit the identity-boundary regression test**

Run: `git add test/contracts/control-owner-boundary.test.mjs`

Run: `git commit -m "test: fence control repository identity references"`

---

### Task 7: Full local verification and TestSprite applicability check

**Files:**
- No new files; validate the complete change.

**Interfaces:**
- The GitHub `policy` check is the only PR acceptance gate for this control repository; no remote provider or self-hosted job is run by pull request.
- TestSprite is not a substitute for workflow, attestation, or PostgreSQL proofs. This change has no browser UI; do not create a fake frontend project or spend a TestSprite run on a non-UI target.

- [ ] **Step 1: Run all project tests**

Run: `pnpm test`

Expected: all Node tests pass; no skips introduced for the modified identity/runner boundary tests.

- [ ] **Step 2: Run workflow and secret-boundary checks**

Run: `pnpm lint:workflows`

Run: `pnpm check:secret-boundary`

Expected: all workflow YAML parses, pinned actions remain SHA-pinned, PR contexts remain hosted, and no credential/source boundary was expanded.

- [ ] **Step 3: Run PostgreSQL 17 control-store harness on the isolated Docker context**

Run: `sudo -v`

Run: `pnpm test:billing-control-store:db`

Expected: the harness reports its exact isolated PostgreSQL image/run and `passed` count with zero failures; it uses only Docker context `billing-validation-isolated` and removes only its own test container. If the isolated context preflight fails, stop and report it; do not use the default Docker daemon.

- [ ] **Step 4: Check patch formatting and identity inventory**

Run: `git diff --check`

Run: `rg -n 'lawxcompany-stack/billing-validation-control|ghcr\.io/lawxcompany-stack/billing-validation-control|lawx-ai/billing-validation-control' src runner .github/workflows docs/ADMIN-SETUP.md docs/OPERATIONS.md docs/local-authorization.md docs/CI-UNBLOCKING.md docs/control-repository-transfer.md`

Expected: no whitespace errors; runtime output contains the old owner only in the two reviewed GHCR package references. Documentation may mention the old slug only to identify the pre-transfer source or explicitly describe the rejected legacy identity; `lawxcompany-stack/Plataforma-LawX` remains unchanged.

- [ ] **Step 5: Run TestSprite preflight and record applicability**

Run: `testsprite --version`

Run: `testsprite auth status`

If neither `$TESTSPRITE_PROJECT_ID` nor `.testsprite/config.json` identifies a project, run: `testsprite project list --output json`

Expected: record CLI/auth status and resolve any existing project without exposing credentials. If the CLI or authentication is missing, mark TestSprite unverified and report the setup requirement; do not bootstrap a fake frontend project or create a run without a browser-facing target. Report applicability as not applicable to this control-plane PR, not as a passed E2E test. The application’s deployed Preview journeys remain a separate unresolved gate.

---

### Task 8: Pre-transfer readback, push, and open the PR

**Files:**
- No source changes after Task 7 unless a test requires a reviewed correction.

**Interfaces:**
- Pull request targets protected `main` in `lawxcompany-stack/billing-validation-control`; independent review is required.
- No transfer, runner registration, secrets, environment-policy change, dispatch, or deployment occurs in this task.

- [ ] **Step 1: Verify the current source repo and dispatch history read-only**

Run: `gh api repos/lawxcompany-stack/billing-validation-control --jq '{id,full_name,default_branch,visibility,private,owner_type:.owner.type}'`

Run: `gh run list --repo lawxcompany-stack/billing-validation-control --workflow authorize-local-collector.yml --limit 100 --json databaseId,event,status,conclusion,headBranch,url`

Run: `gh run list --repo lawxcompany-stack/billing-validation-control --workflow validate-billing.yml --event workflow_dispatch --limit 100 --json databaseId,event,status,conclusion,headBranch,url`

Expected: source identity is ID `1384018279`, public, `main`, owner type `User`; the two operational workflow queries remain empty. If not, stop and review whether any old operational evidence needs a separately scoped migration test.

- [ ] **Step 2: Verify the PR branch diff and staged changes**

Run: `git status --short --branch`

Run: `git diff --check`

Run: `git diff --stat origin/main...HEAD`

Expected: only the specified control-repository code, tests, and active runbooks are included; spec and implementation plan remain linked in the branch.

- [ ] **Step 3: Push the reviewed branch and open a draft PR**

Run: `git push -u origin feat/control-repo-org-migration`

Run: `gh pr create --repo lawxcompany-stack/billing-validation-control --base main --head feat/control-repo-org-migration --draft --title "Move billing control identity to lawx-ai" --body "Retargets only the control-plane identity to lawx-ai and preserves the isolated runner boundary. The repository transfer itself is not performed by this PR; see docs/control-repository-transfer.md for owner-operated readback gates." --reviewer netopvh`

Expected: one draft PR is created with a concise summary and runbook link, independent reviewer `netopvh` requested, and no GitHub settings or provider mutations performed.

- [ ] **Step 4: Monitor only the PR-hosted policy checks**

Run: `gh pr checks --repo lawxcompany-stack/billing-validation-control --watch`

Expected: required `policy` is successful and no operational self-hosted job was started. If any check fails, inspect its exact run/log, fix the cause in this branch, rerun the full relevant test set, and do not mark the PR ready or merge it until the checks pass.

---

## Post-PR owner-operated cutover gates (not executed by this plan)

These are acceptance gates, not automated PR steps. The repository owner must review/merge the PR, then execute the runbook’s pre-transfer readbacks and confirm the package/release identity before transferring only `billing-validation-control` through GitHub Settings. The agent must not invoke a transfer endpoint or CLI. Afterward, the owner/read-only operator must prove all of the following before enabling any runner:

1. `gh api repos/lawx-ai/billing-validation-control --jq '{id,full_name,default_branch,visibility,private,owner_type:.owner.type}'` returns ID `1384018279`, canonical full name, public visibility, and `main`.
2. `gh api repos/lawx-ai/billing-validation-control/branches/main/protection` and the repository ruleset readback show one independent approval, code-owner rules as configured, no force-push/deletion, and no bypass that defeats protection.
3. All five environments (`billing-validation-attestation`, `billing-validation-reader`, `billing-validation-tests`, `billing-validation-publisher`, `billing-validation-control`) still have the approved protected-ref and `netopvh` reviewer settings. List secret names only; never retrieve values.
4. `billing-validation-isolated` belongs to `lawx-ai`, has `visibility: selected`, allows exactly `lawx-ai/billing-validation-control`, has `restricted_to_workflows: true` with only `lawx-ai/billing-validation-control/.github/workflows/validate-billing.yml@refs/heads/main`, and has `allows_public_repositories: true` only because this repository is public and those exact restrictions are proven. The runner list is empty until its supervised first registration.
5. App installation/scopes, collaborator access, GitHub Actions permissions, and GHCR package owner/path/digest are read back and match the reviewed policy. The old GHCR URI is not changed until this proof is complete.
6. A secret-free hosted policy/identity run proves the transferred repository identity. No `collect`, `recheck`, runner registration, financial E2E, Vercel deployment, Supabase mutation, or Stripe request is part of this proof.
7. If any prerequisite fails or GitHub API readback is denied (including the current organization-token lifetime restriction), leave runner and financial workflows disabled; obtain an owner-authorized read-only credential through a safe local login flow and repeat only the readback.

## Self-review checklist

- **Spec coverage:** Task 0 preserves the approved plan; identity invariants are covered by Tasks 1–6; runner group/entrypoint by Tasks 2 and 4; GHCR uncertainty by Tasks 3, 6, and the cutover gates; post-transfer settings by Task 5 and cutover gates; PR validation and handoff by Tasks 7–8.
- **No-placeholder scan:** every task has exact files, commands, and expected behavior; transfer is explicitly owner-operated rather than an unspecified automation step.
- **Type/interface consistency:** all consumers use `matchesControlRepository(repository, repositoryId)` with string or positive safe integer IDs; workflow YAML additionally checks the fixed decimal ID; the attempt schema remains unchanged and stores only canonical repository full name.
