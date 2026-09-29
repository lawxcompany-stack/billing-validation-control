# Local collector authorization v2

This increment emits and verifies an authorization-only manifest. It cannot launch
a collector, register a runner, publish a billing result, or satisfy existing
billing acceptance. `collect` is the only admitted/emitted operation. The schema
understands `recover` and `recheck`, but admission, emission and verification refuse
historical operations until authoritative historical state is integrated.

## Current blockers

Both checked-in policies intentionally remain empty:

- `policy/local-collector-release.json`: `releases: []`. The hosted `authorize`
  job calls `selectRelease` before emitting its dispatch output, and refuses with
  `authorization_release_unconfigured`. The dependent credentialed reader cannot
  start, so no App token is minted by this workflow in that state.
- `policy/local-collector-trust.json`: `reviewedControlShas: []`. Local verification
  refuses with `authorization_control_unreviewed`. A remote branch name or a SHA
  asserted in the manifest cannot populate this policy.

There is no reviewed collector image/release or reviewed local control SHA in
these policies. Synthetic test fixtures are not release candidates or trusted
pins. Do not dispatch this workflow to work around these blockers.

## Hosted boundary

The fixed path is `.github/workflows/authorize-local-collector.yml` in
`lawxcompany-stack/billing-validation-control` (repository ID `1384018279`). Its
only trigger is `workflow_dispatch` on protected `refs/heads/main`, with default
branch `main`. The four closed dispatch fields are `candidate_sha`, `execution_id`,
`activation_commitment` and `suite` (`billing-43` or `billing-3ds-15`). No release,
source pin, URL, TTL, operation, credential or arbitrary command is an input.

| Job | Authority and result |
| --- | --- |
| `authorize` | Hosted, no environment, contents read only. Validates dispatch and trusted GitHub context, requires a unique release from the checked-out policy, emits only sanitized dispatch JSON. |
| `reader` | Depends on successful authorize; `billing-validation-reader`. Uses the existing scoped, revoked-after-job App client, restricted to candidate metadata reads. Emits one bounded `receipt` JSON through `GITHUB_OUTPUT`; no stdout dump. |
| `attest-activation` | Depends on successful authorize and reader; `billing-validation-attestation`. Only this job has `id-token: write` and `attestations: write`. Revalidates the dispatch/context/receipt/release, writes the subject, attests it and uploads only that file. No reader App or financial secrets. |

All jobs use `ubuntu-latest`, fixed timeouts, exact `${{ github.sha }}` checkout
with credential persistence disabled, and the existing immutable checkout,
setup-node, App-token and attest pins. The reviewed upload-artifact pin is
`ea165f8d65b6e75b540449e92b4886f43607fa02`. The attestation subject basename is
`local-collector-authorization.json`, consistent with the previously verified
action-source behavior. The workflow uploads only this synthetic authorization
manifest, with a one-day retention, no hidden files and no overwrite.

The reader independently resolves the current candidate PR/tree/base and the
latest CI attempt, rereads the attempt and candidate to detect movement, and
requires successful, distinct quality/regression/build jobs from workflow
`290018021`, `.github/workflows/ci.yml`. The candidate repository identity is fixed
to `lawxcompany-stack/Plataforma-LawX`, numeric ID `1234079266` (observed on
2026-09-29). The receipt retains that numeric ID, and emission independently
requires it. It is never a caller-selected identity. A receipt is an observation
at read time; no new claim of continuing candidate freshness after signing is made.

The writer reads the release policy relative to its own trusted checkout, uses
current UTC with a 1,200,000 ms window, and creates the fixed subject under
`RUNNER_TEMP` with `wx` and mode `0600`. Existing files and symlinks are refused.
Its stdout contains only `scope` and `authorizationDigest`. All three scripts have
inert imports, reject extra CLI arguments and use fixed sanitized failure messages.
Inputs are captured before asynchronous I/O; object interfaces reject accessors
and proxies and produce immutable validated snapshots.

The workflow policy checks a closed structural contract, including the exact
outputs, conditions, environment expressions, step order, commands and artifact
paths. Mutation tests cover credential outputs (including bracket notation and
`toJSON`), injected steps/commands, signing permissions, candidate/branch/path
checkout bypasses, runner/container changes and policy injection. The old v1
workflow is unchanged; its reader-output allowlist is tightened in the lint.

## Local verification and the gh profile ruling

`verifyLocalAuthorization({manifestBytes, challenge, signal})` requires a genuine
module-owned one-use challenge. It checks canonical bytes, the reviewed release
and station control SHA, completed successful exact-attempt hosted jobs/current
protected main, and cryptographic attestation results before consuming that
challenge. It returns an immutable, non-authoritative receipt:
`{scope: 'authorization-only', authorizationDigest, executionId, candidateSha}`.
Copying that receipt or challenge cannot grant execution authority.

The implementation uses the supported, compatible `gh 2.96.0` argument set:
`attestation verify <subject> --repo <control> --signer-workflow <control/workflow>
--signer-digest <sha> --source-ref refs/heads/main --source-digest <sha>
--deny-self-hosted-runners --predicate-type https://slsa.dev/provenance/v1
--format json`. It does not use the unsupported `--source-repo` flag or combine
the mutually exclusive `--signer-workflow` and `--cert-identity` flags. Certificate
identity, repository ID, event, run/attempt, signed environment, subject/digest
and timestamp bindings are also checked on the verified output.

Future real verification requires an existing authorized station login in the
default `gh` profile under the trusted supervisor's `HOME`. The process boundary
retains trusted `PATH`/`HOME`; it does not copy `GH_TOKEN`, `GITHUB_TOKEN`, enterprise
tokens, `GH_CONFIG_DIR` or caller-selected profile overrides. Provision that
station login separately. This increment adds no bundle downloader, no copied
token environment and no provider permissions.

Passing offline tests proves CLI grammar and synthetic boundary behavior only.
The grammar probe self-isolates its profile and uses absent temporary artifacts,
an absent bundle and an empty temporary custom root to avoid authentication/TUF
network initialization. Those probe-only options are not used in production.
No real signed handoff or real financial validation has been tested here.

## Offline checks

Run from the control worktree. The temporary config below prevents the legacy
optional GitHub metadata test from using the station login. The installed-gh
grammar test also isolates its own profile. No TestSprite/provider run is part
of this offline-only task.

```sh
task3_gh_config=$(mktemp -d /tmp/bvc-task3-gh.XXXXXX)
env -u GH_TOKEN -u GITHUB_TOKEN -u GH_ENTERPRISE_TOKEN -u GITHUB_ENTERPRISE_TOKEN \
  GH_CONFIG_DIR="$task3_gh_config" GH_NO_UPDATE_NOTIFIER=1 GH_NO_EXTENSION_UPDATE_NOTIFIER=1 \
  npx --yes --package=node@22 -c 'pnpm test'
rmdir "$task3_gh_config"
npx --yes --package=node@22 -c 'pnpm lint:workflows && pnpm check:secret-boundary'
git diff --check
```

The default test command discovers every `test/**/*.test.mjs`, including all v2
manifest/challenge/context/release/verifier/emitter and workflow mutation tests.
Test I/O is temporary filesystem, controlled process boundaries and mock HTTP.
Node/package availability may require the standard `npx` package acquisition;
tests do not call GitHub/provider APIs. Focused checks:

```sh
npx --yes --package=node@22 -c 'node --test test/authorization/emitter.test.mjs test/github/candidate-checks.test.mjs test/github/candidate-reader.test.mjs'
npx --yes --package=node@22 -c 'node --test test/workflows/local-authorization.test.mjs test/workflows/reader-boundary.test.mjs test/workflows/workflow-policy.test.mjs'
```

## After PR3 review

1. Scoped Task 3 and whole-branch reviews are complete, including the final HTTP
   decoding fix. Independently authorize remote integration after the underlying
   PR3 review; no push, merge or dispatch was part of this local increment.
2. Independently review a real collector release and its complete image/config/
   source/tree/policy digests and permitted suites; provision its reviewed policy.
3. After the remote control commit is final, manually review and provision that
   exact SHA into the station-local `reviewedControlShas`. This local provisioning
   step must not create another remote commit and must never auto-trust current main.
4. Provision the authorized default station `gh` login under supervisor `HOME`.
   Only after these prerequisites and separate authorization may a real handoff
   be exercised and reported as such.
5. Implement the remaining host/image/journal/lease anti-replay controls, state and
   recovery, independent readers, financial suites, publisher and app integration
   in subsequent increments. This receipt continues to grant no collector launch
   or billing acceptance authority.
