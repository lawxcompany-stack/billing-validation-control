# Task 7 fix round 5 report

Implementation commit: `72f94d90c0bf756a5b79c7b7dda1e96f74ae42f4` (`fix(task7): gate runner on activation attestation`). Report is recorded in a separate local commit; nothing was pushed.

## Result

Restored `runner/supervisor.mjs` as the public entrypoint and moved orchestration/test seams behind the internal factory. Public options now reject injected process boundaries, attestation verifiers, run readers, repository IDs, and other unrecognized fields. The public wrapper fixes the real process boundary to the isolated Docker context. Synthetic integration tests cover challenge presentation, run/attempt selection, API binding, attestation verification, full manifest comparison, one-time challenge consumption, and refusal before token, Docker, or display side effects.

The workflow authorizes and normalizes the activation commitment, candidate SHA, and runner label; the hosted attestation job depends on both authorization and successful candidate-reader preflight and checks out exactly `github.sha`. Signing permissions are limited to that job. The self-hosted job depends on authorize, reader, and attestation, and its first step compares verified `CONTROL_*` values to the actual GitHub context and authorization outputs. The pre-job entrypoint checks only strict `CONTROL_*` metadata and does not read local `GITHUB_*` variables. The canonical subject uses the approved domain separator and UTF-8 JSON newline; the manifest writer pins the candidate repository.

## TDD evidence

RED/GREEN commands were run with synthetic inputs and mocked HTTP/process boundaries only:

| Regression | RED | GREEN |
| --- | --- | --- |
| GitHub CLI attestation JSON certificate/timestamp shape and source-vs-subject digest binding | `node --test --test-reporter=spec test/runner/activation-verifier.test.mjs` — 17/18 passed; valid official-shape fixture was rejected | Same command — 20/20 passed |
| Explicit run/attempt reader export and fixed API lookup | `node --test --test-reporter=spec test/runner/workflow-context.test.mjs` — 0/15 passed; production reader export was missing | Same command — 16/16 passed |
| Deterministic supervisor label seam and replay/expiry checks | `node --test --test-reporter=spec test/runner/supervisor-activation.test.mjs` — 1 passed, 5 failed because random labels caused challenge rejection before each scenario | Same command — 6/6 passed |
| Public process/proof/trust-ID injection refusal | `PATH=/home/linuxbrew/.linuxbrew/bin:/usr/bin:/bin node --test --test-reporter=spec --test-name-pattern='public supervisor' test/runner/supervisor.test.mjs` — 0/2 passed; caller seams were accepted and the public wrapper required a caller boundary | Same command — 2/2 passed |

The full offline suite explicitly includes `activation.test.mjs`, `activation-verifier.test.mjs`, `workflow-context.test.mjs`, and `supervisor-activation.test.mjs` in `package.json`.

## Final verification

All commands below completed successfully from this worktree. The restricted `PATH` excludes the installed `gh` binary.

- `PATH=/home/linuxbrew/.linuxbrew/bin:/usr/bin:/bin npm test` — 372 tests, 371 passed, 0 failed, 1 skipped.
- `PATH=/home/linuxbrew/.linuxbrew/bin:/usr/bin:/bin npm run lint:workflows` — policy lint passed for both workflows, including rendered shell/heredoc validation in workflow tests.
- `PATH=/home/linuxbrew/.linuxbrew/bin:/usr/bin:/bin npm run check:secret-boundary` — passed; signing permissions are allowed only on hosted `attest-activation`.
- `node --check` on every changed/new JavaScript module and test — passed.
- `bash -n runner/entrypoint.sh` — passed.
- `git diff --check` — passed.
- `if PATH=/home/linuxbrew/.linuxbrew/bin:/usr/bin:/bin command -v gh >/dev/null 2>&1; then exit 1; else printf 'gh absent from PATH\\n'; fi` — confirmed `gh` absent.

## Review self-checks

- Entrypoint has no `GITHUB_*` reads; actual run ID/attempt, repository, event, default branch, ref, workflow ref, workflow SHA, candidate SHA, activation commitment, and runner label are checked in the first self-hosted job step.
- `attest-activation` has exact `needs: [authorize, reader]`; the self-hosted job depends on authorize, reader, and attest-activation. Authorize and attestation checkouts both use `${{ github.sha }}`.
- Only fixed `gh attestation verify` arguments/process boundary are used in production. The source digest is the workflow SHA; the subject digest is independently computed over exact canonical manifest bytes. Certificate fields and verified timestamps use the CLI JSON shape; predicate content is not trusted.
- The public supervisor rejects caller-supplied process/proof/trust-ID seams. Challenge replay, expiry, cancellation, selector mismatch, malformed proof, and manifest tampering tests assert zero token/Docker/display calls. Challenge nonce is consumed before parent Xauthority, Docker, display, or token access and destroyed on every path.
- `node_modules/` remained untracked and was not staged or removed.

## Limitations

- The fixed reviewed control-repository numeric ID is intentionally `null` in Task 7. Production run lookup and attestation verification therefore refuse closed until Task 9 records the administrator-read ID in the immutable trust policy. No request, environment variable, or supervisor option can supply it.
- The candidate reader and collector remain fail-closed stubs. Because attestation depends on successful reader preflight, no real activation can complete from this Task 7 slice alone.
- No live GitHub API/Actions request, `gh attestation verify`, network call, Docker command, runner registration, display, shared-host operation, Supabase, Stripe, Vercel, or container was run. All attestation fixtures and process/HTTP boundaries were synthetic/mocked. This does not demonstrate real attestation success or production readiness.
