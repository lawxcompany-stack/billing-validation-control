# Local Authorization v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit and verify a strictly bound authorization for the future isolated local collector without launching it.

**Architecture:** Add an independent v2 manifest/challenge, completed-run context and attestation verifier, then a protected hosted authorization-only workflow. The existing v1 workflow remains unchanged and fail-closed. Real release pins are prerequisites, never fabricated to make the workflow green.

**Tech Stack:** Node 22, ESM, node:test, existing GitHub CLI boundary, YAML 2.9.1, no new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-29-attested-local-collector-design.md`, approved by user on 2026-09-29.

## Global Constraints

- First increment only: schema/emitter/verifier v2 and authorization workflow; no Docker start, registration tokens, financial credentials, DB, deploy, push, merge or financial success check.
- Repository identities: control `lawxcompany-stack/billing-validation-control` ID `1384018279`; candidate `lawxcompany-stack/Plataforma-LawX` ID `1234079266` (read back 2026-09-29).
- Workflow `.github/workflows/authorize-local-collector.yml`, ref `refs/heads/main`, event `workflow_dispatch`; signing environment `billing-validation-attestation`.
- JSON canonical UTF-8, fixed key order, trailing LF, closed nested schemas, maximum 16384 bytes, no v1 fallback.
- `schemaVersion=2`, `kind=billing-collector-authorization`, `executionMode=isolated-local`.
- Activation maximum 1200000 ms, future clock skew maximum 60000 ms; consume once with monotonic deadline and no enduring activation timer.
- Source SHA must match independently reviewed local policy, not only a claim or current main.
- Signature verification through fixed `gh attestation verify` arguments, including `--deny-self-hosted-runners`; raw signed certificate environment, subject name/digest and verified timestamp window are mandatory.
- Genuine capability is opaque/nonserializable; copies, booleans and JSON receipts confer no execution authority. This increment grants no operational capability beyond a consumed verification receipt.
- `recover`/`recheck` are understood by the schema but cannot be emitted or admitted by this increment because authoritative historical state is not yet integrated. Reject explicitly, never map to collect.
- No actual image/release is yet reviewed. Commit an empty release policy with a specific unconfigured refusal. Synthetic fixture values exist only in tests.
- Preserve user app worktrees and existing v1 contracts. All test I/O is temporary filesystem, controlled subprocess/HTTP doubles or local parsing; no provider connections.

## Interfaces and file boundaries

Manifest nested fields, in order:

```js
{
  schemaVersion, kind, executionMode, operation, executionId, activationCommitment,
  candidate: { repository, repositoryId, pullNumber, sha, treeSha, baseSha },
  prerequisites: { workflowId, workflowPath, runId, runAttempt,
    jobs: [{ key, jobId, conclusion }] },
  control: { repository, repositoryId, ref, workflowPath, sha, runId, runAttempt, event },
  collectorRelease: { image, configDigest, sourceSha, sourceTreeSha, policyDigest },
  policy: { environmentDigest, contractsDigest, egressDigest, limitsDigest },
  suite, issuedAt, expiresAt, sourceExecutionId
}
```

All IDs use canonical positive decimal strings (safe integers); SHA-1 fields use lowercase 40 hex; digests lowercase 64 hex, image `ghcr.io/lawxcompany-stack/billing-validation-control@sha256:<64hex>`, configDigest `sha256:<64hex>`. Jobs exactly quality/regression/build, distinct IDs, fixed order and success. Prerequisite workflow ID `290018021`, path `.github/workflows/ci.yml`. executionId/sourceExecutionId lowercase 32 hex, source different from current. Timestamps strict UTC ISO millisecond strings and valid calendar dates. suites `billing-43` or `billing-3ds-15`.

### Task 1: Canonical manifest and one-use local challenge

**Files:**
- Create: `src/authorization/manifest.mjs`, `challenge.mjs`
- Test: `test/authorization/manifest.test.mjs`, `challenge.test.mjs`, `fixtures.mjs`

**Interfaces:**
- Produces `createAuthorizationManifest(value)`, `serializeAuthorizationManifest(value)`, `parseAuthorizationManifest(bytes)`, `authorizationDigest(bytes)` from manifest.mjs.
- Produces `createAuthorizationChallenge({candidateSha, suite})`: frozen object with `presentation={executionId,activationCommitment,candidateSha,suite}`, `assertUsable()`, `consume()`, `destroy()`. Production creates random ID/nonce and owns a monotonic timestamp; callers cannot supply nonce/time.
- Produces `assertAuthorizationChallenge(challenge,manifest)` which proves module-owned identity in a WeakSet, checks every presentation binding and availability; no caller-provided challenge methods confer trust.
- Test fixture `authorizationFixture()` returns fresh plain object using literal synthetic values; do not export test clock injection from production. Node mock timers or a separately internal module may support deterministic expiry if necessary.

- [x] Write behavioral tests before implementation. At minimum:

```js
test('canonical parser refuses duplicate keys rather than accepting JSON last-wins', () => {
  const bytes = serializeAuthorizationManifest(authorizationFixture());
  assert.throws(() => parseAuthorizationManifest(bytes.replace(
    '"schemaVersion":2', '"schemaVersion":1,"schemaVersion":2')));
});
test('copied challenge cannot authorize the same manifest', () => {
  const challenge = createAuthorizationChallenge({ candidateSha: 'a'.repeat(40), suite: 'billing-43' });
  const m = authorizationFixture();
  Object.assign(m, { executionId: challenge.presentation.executionId,
    activationCommitment: challenge.presentation.activationCommitment });
  assert.throws(() => assertAuthorizationChallenge({ ...challenge }, m));
});
```

Also test v1/wrong kind, unknown nested keys/accessors, invalid dates/window, unsafe decimal IDs, >16KiB/invalid UTF8/BOM, duplicate jobs, wrong repository/image, deep immutability, deterministic exact bytes with an independently spelled expected prefix/order, recover/source rules, unique random challenges, consumed/destroyed challenge and wrong bindings.

- [x] Run RED: `npx --yes --package=node@22 node --test test/authorization/manifest.test.mjs test/authorization/challenge.test.mjs`. Missing module assertions may show the initial missing feature; ensure the tests reach meaningful behavior after it exists.
- [x] Implement closed canonical validation with descriptors (no accessors), own keys only, copying into recursively frozen output. Parser checks byte-for-byte reserialization, so duplicate keys/whitespace/order changes fail. Hash only canonical bytes. Errors use fixed sanitized codes.

```js
const bytes = Buffer.from(serializeAuthorizationManifest(manifest));
if (!bytes.equals(inputBytes)) throw new AuthorizationRefusal('authorization_noncanonical');
// Challenge state stays in closure/module-owned weak collection. Clear nonce on consume/destroy.
```

- [x] Run focused GREEN, existing activation tests, and full `pnpm test` under Node 22 once. Commit only task files.

### Task 2: Completed authorization context and cryptographic verifier

**Files:**
- Create: `src/authorization/context.mjs`, `verifier.mjs`, `verifier-internal.mjs`, `release-policy.mjs`
- Create: `policy/local-collector-release.json`, `policy/local-collector-trust.json`
- Modify/extract only if needed: `runner/activation-verifier-internal.mjs` and new `runner/attestation-environment.mjs` to reuse the DER environment parser without duplication or altered v1 semantics.
- Test: `test/authorization/context.test.mjs`, `verifier.test.mjs`, `release-policy.test.mjs`

**Interfaces:**
- Consumes Task1 exports; never calls legacy v1 verification.
- `validateReleasePolicy(value)` returns immutable `{schemaVersion:1,releases:[{collectorRelease,policy,suites}]}`. Empty list is valid stored policy, but `selectRelease(policy,suite)` throws `authorization_release_unconfigured`; >1 matching release is ambiguous. No selection from dispatch.
- Local trust shape `{schemaVersion:1,reviewedControlShas:[]}`; empty means `authorization_control_unreviewed`, not wildcard. Public verifier reads the files relative to its trusted code, ignores ENV and rejects extra caller inputs. This is a station-admin policy: adding a reviewed control SHA is a local provisioning step after the remote commit is final, not another remote commit that would change the SHA being pinned. Never auto-fill it from GitHub main or a manifest.
- `readAuthorizationContext({manifest,signal})` performs fixed bounded GETs only to public GitHub control API. Internal seam for tests may inject GET, not exposed from verifier public API.
- `verifyLocalAuthorization({manifestBytes,challenge,signal})` returns frozen non-authoritative receipt `{scope:'authorization-only',authorizationDigest,executionId,candidateSha}` after verification and consumes the challenge. It never offers a collector launch method.
- `verifyLocalAuthorizationWithDependencies` is an explicitly internal testing seam with fixed boundary/readContext/releasePolicy/trustPolicy/clock. Snapshot inputs before awaits. Public API has no dependency injection.

- [x] RED tests for current-run + exact-attempt + jobs + current-main validation:

```js
test('successful old attempt is refused after a rerun', async () => {
  const api = authorizationApiFixture({ currentAttempt: '3', manifestAttempt: '2' });
  await assert.rejects(readAuthorizationContextWithDependencies({manifest: authorizationFixture(), get: api.get}));
});
```

Context must validate both repo IDs/names, workflow/path/event/branch/SHA, completed/success exact attempt and current run, three unique hosted job names authorize/reader/attest-activation with matching run/attempt/head SHA and success, fixed runner labels ubuntu-latest (or documented hosted label array), no extra jobs/duplicate IDs, latest main SHA equals authorized SHA. Read current run again at end to detect rerun. Bound HTTP response bytes, timeout, redirect/status, malformed pagination and no ambient credentials. Re-read this context after signature before consume.

- [x] RED attestation tests adapted from existing certificate fixture, not hand-waving signature verification:

```js
test('a zero exit code with a wrong subject cannot consume the challenge', async () => {
  const fixture = verifierFixture({ subjectName: 'billing-result.json' });
  await assert.rejects(fixture.verify());
  assert.doesNotThrow(() => fixture.challenge.assertUsable());
});
```

Require actual `gh` invocation via process boundary (fixed args/no shell, private unique temporary canonical file), then validate its verified result against exact subject filename `local-collector-authorization.json`, digest, certificate workflow/source/repoID/ref/SHA/event/hosted/run invocation, raw signed environment and at least one verified timestamp in signed [issuedAt,expiresAt] window and not future beyond60s. Refuse ambiguous arrays/oversized outputs, aborted/deadline failures. Verify manifest UTC and local monotonic deadline before and after I/O. Do not consume on failed validation; on successful final read, assert branded challenge and consume synchronously with no interleaving await.

- [x] Implement GET/context and verifier using Node builtins, existing safe process boundary and shared DER helper. The boundary itself does not execute Docker unless commanded; this path commands only gh. Release policy must match all manifest release/policy/suite fields, plus reviewed control SHA. No broad API/authenticated GET adapter.
- [x] Test public seam injection refusal without starting gh/network, failure sanitation, changed context during verification, expiry while awaiting, unconfigured pins before I/O, correct positive synthetic boundary, challenge replay/copy rejection and read-only receipt cannot become capability. Run Node22 focused+legacy verifier+full tests and commit.

### Task 3: Protected hosted emitter workflow and policy integration

**Files:**
- Create: `src/authorization/dispatch.mjs`, `emitter.mjs`
- Create: `scripts/authorize-local-collector.mjs`, `read-local-authorization-candidate.mjs`, `write-local-authorization.mjs`
- Create: `.github/workflows/authorize-local-collector.yml`
- Modify: `src/github/candidate-checks.mjs` (retain authoritative numeric repositoryId in read receipt), `package.json`, workflow lint/secret-boundary, `.github/CODEOWNERS`
- Test: `test/authorization/emitter.test.mjs`, `test/workflows/local-authorization.test.mjs`; update prerequisite receipt assertions only where shape intentionally adds ID.
- Document: `docs/local-authorization.md`

**Interfaces:**
- Dispatch input exactly `{candidate_sha,execution_id,activation_commitment,suite}`; operation hardcoded collect. No image, source SHA, URLs, TTL, release policy, credentials, arbitrary steps or financial results as inputs.
- `parseLocalAuthorizationDispatch(inputs,context)` checks exact keys, protected main/repository ID/defaultBranch/event/current workflow ref/sha/runattempt via trusted GitHub ENV. Reject old v1 fields and unknown operation.
- Reader calls existing `readCandidatePrerequisites` with the same scoped App read client, emits one bounded sanitized JSON receipt through GITHUB_OUTPUT (IDs/SHAs/job statuses only). No token logging.
- `emitLocalAuthorization({dispatch,receipt,context,releasePolicy,now})` composes Task1 manifest with trusted selected release, now.toISOString(), expiresAt=now+1200000. Revalidates receipt repoID, SHA, jobset and context. No imports from candidate code.
- Scripts use `pathToFileURL` main guard, fixed sanitized errors, no import side effects. Writer creates the canonical subject with wx/0600; no overwrite/symlink file. Output only digest/scope, never credential/env dump.

- [x] RED emitter/CLI tests using real temporary files and controlled argv/env:

```js
test('emitter refuses a candidate receipt for a different SHA', () => {
  const fixture = emitterFixture();
  fixture.receipt.candidateSha = 'f'.repeat(40);
  assert.throws(() => emitLocalAuthorization(fixture));
});
```

Test unknown dispatch/image input, fake protected context, alternate repoID, stale/non-success/duplicate/missing jobs, invalid/unconfigured release, writer no overwrite, private mode, malformed/error outputs sanitized and import inertness.

- [x] Add workflow with exactly authorize->reader->attest-activation. Each hosted ubuntu-latest with finite timeout, exact github.sha checkout, no credential persistence. Trigger dispatch only, protected main guards before credentialed jobs. Reuse reviewed actions/setup/App/attest pins from existing workflow, exact environments. Authorize/read output JSON/identity feeds emitter; signer no provider/read App secrets. Attest local-collector-authorization.json and upload only this synthetic manifest with an independently verified immutable actions/upload-artifact pin. No test/publisher/self-hosted/Docker/financial roles.
- [x] Extend workflow policy to cover the new workflow explicitly without weakening v1 checks. Mutation tests reject secret propagation, job/step bypass, dynamic runner/candidate checkout, injected release pins, arbitrary run commands in credentialed reader, sign permissions outside signer, altered artifact paths. Lint all three workflow files. Add new tests to default test command.
- [x] Document exact local test commands, verification receipt meaning, empty release/trust blocker and sequence after PR3 review. The workflow cannot be dispatched effectively until reviewed image and local trusted control pins exist; do not fake them. No financial validation claimed.
- [x] Run Node22 all tests, lint:workflows, check:secret-boundary, git diff --check; commit task. Request scoped review, then whole-branch review before handoff. Do not push/merge/dispatch remotely in this increment.

## Coverage and explicit exclusions

The schema, emitter and local verifier portions of spec section5 and authorization portions4/10/11 are implemented. Section5's durable journal, global claim and operational recovery are not implemented by this increment. Image/host/journal/lease global anti-replay, state/recovery fixes, independent readers, financial suites, publisher and app integration (sections6–9/12) are subsequent increments. No operational authority is exposed until they exist. A valid authorization receipt is never accepted by existing billing acceptance.

## Execution record — 2026-09-29

The first authorization-only increment is complete locally; all task and final
reviews are clean. This is not completion of the full collector specification.

- Task 1: canonical manifest and branded one-use challenge, commits
  `3faf908` and `d76f6e3`.
- Task 2: completed-run context and verifier, commits `0bdb9d4` and
  `f323c86`. Review corrected unsupported/conflicting gh flags and the
  unauthenticated-profile dead end. The real gh CLI grammar was tested locally;
  no genuine signed handoff was performed.
- Task 3: protected hosted emitter workflow, policy gates and runbook,
  commit `2d61240`.
- Final review corrected native fetch's decoded-body versus wire Content-Length
  mismatch in `b14115c`. Real loopback HTTP tests cover gzip, Brotli, deflate,
  decoded limits, truncated transfers, CRC failures and retained identity-length
  checks. RED reproduced 13 expected failures; final focused GREEN was 126/126.
  The single scoped final re-review approved the correction with no new findings.

### Independent final verification

Main agent reran the complete committed code tree at `b14115c` using Node
22.23.3, cached tooling in npm offline mode, an empty temporary gh profile and
removed GH/GitHub token variables in the child environment:

```text
pnpm test: 935 discovered, 934 passed, 0 failed, 1 skipped,
           0 cancelled, 0 todo; 16034.757493 ms
pnpm lint:workflows: passed for all 3 workflows
pnpm check:secret-boundary: passed
git diff --check: passed
```

The skipped test is the optional live GitHub metadata integration, deliberately
without credentials in this offline run. It remains unverified, not passed.
The changes after this verification are this documentation record/checklist and
documentation status only. No runtime source, test or workflow changed afterward.

### Ruling and remaining gates

Ruling: the fixed read-only verifier subprocess reuses the station's authorized
default gh profile under its trusted HOME; it does not copy/export token
environment variables or give a GitHub token to a collector. The approved
contract excludes that token from the collector, not from its trusted supervisor.
This avoids introducing a second bundle downloader merely to replace existing
authentication. Cost/limitation: a station without the approved login blocks;
real signed interoperability still requires its own validation.

The empty release and station-trust policies are intentional safety gates.
A reviewed real collector release, an independently reviewed final control SHA
provisioned locally, and an authorized station login remain prerequisites.
Host/image/journal/lease, recovery, real financial collection, publication and
application integration remain subsequent increments.

No push, merge, workflow dispatch, Docker execution or financial provider access
was performed for this increment. It does not clear application PR #139 or
establish production readiness. The branch/worktree is preserved for the user's
integration choice. See `docs/local-authorization.md` for the operational limits.
