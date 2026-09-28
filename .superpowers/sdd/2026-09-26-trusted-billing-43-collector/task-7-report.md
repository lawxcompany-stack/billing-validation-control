# Task 7 implementation and review notes

## Status

Task 7 is delivered as a fail-closed read-only gate scaffold, not as a production-ready schema/concurrency pass. There is deliberately no happy-path gate result in this checkout: the protected policy does not contain the required database identity pins or a digest pin for the versioned Task 7 invariant bundle. No fixture identity or invented digest was promoted into trusted configuration.

## Implementation

- Added `src/billing/sql-gates.mjs`. `verifyTrustedBillingSqlGates` accepts only versioned invariant data and independent read-only readers; it has no candidate SQL, artifact, script, migration, DDL, or alternate-policy input. It imports the configured policy directly rather than accepting a caller-selected config.
- The protected-policy binding requires the expected project/parent/child/name and schema/migration fingerprints to match the checked-in billing-validation policy, plus `billingSqlGate.version` and a protected `expectedInvariantsSha256` pin for the complete assertion/race bundle. Production/default branch names are refused. No readers are called before this binding succeeds.
- The existing `policy/environment-policy.json` has the configured project/branch ID/name, but `parentProjectRef`, `schemaFingerprintSha256`, and `migrationHistorySha256` are null and it has no `billingSqlGate` pin. The target therefore remains unconfigured and the gate fails closed. The policy file and its current values were not changed.
- Expected invariants are copied from exact own data properties into frozen schema, assertion, and race records before any asynchronous read. The shared read-only schema-comparison component has the retained mutation regression: changing a caller’s fingerprint while its reader is pending cannot change the captured expectation. That component explicitly does not authorize a target by itself; only the full gate’s protected-policy check can do so.
- Factored the two-barrier collection/comparison into a read-only evidence component used by the full gate. Component tests now invoke both independent readers, assert the two fixed barrier IDs, exercise all six assertion digests and four race outcomes, and check exact refusals for missing/mismatched assertions, non-single-owner races, wrong loser state, duplicate reader identity, and non-read-only readers. This component is not a protected-policy gate and returns no success receipt.
- Extended the Supabase reader with fixed installed-schema and concurrency source methods. They validate child binding, require distinct trusted reader identities at the gate, sanitize digest-only receipts, and refuse if the trusted source methods are missing. No generic query fallback was added.
- Added closed-shape sanitizers for installed schema and concurrency receipts. They require all six assertion digests, all four race records, one committed owner, and loser-state digests. The synthetic IDs/digests in tests exercise these local shapes only; they do not stand in for a configured target or approved invariant values.
- Added `test:task7` and included its SQL-gate test in the full `npm test` command.

## Verification

- TDD: the caller-chosen target and missing-policy-pin tests failed before the policy binding was added. The restored asynchronous mutation regression failed before its schema-comparison export existed, then passed against the shared component used by the full gate.
- `npm run test:task7`: 37 passed, 0 failed.
- Mutation regression only: 1 passed, 0 failed.
- `npm test -- --test-reporter=dot`: 534 passed, 0 failed.
- `git diff --check`: passed.
- Workflow lint and secret-boundary checks were not run because no workflow or secret-boundary files changed.

All new SQL-gate component tests use local fake readers and synthetic receipts. They exercise the comparison logic but do not identify a real target or produce an authorized full-gate pass. Because the protected policy is incomplete, installed-schema/concurrency acceptance has not been demonstrated end-to-end. Existing PostgreSQL test doubles were not used to execute any migration or DDL. No candidate SQL was run.

No GitHub, Supabase, Stripe, Vercel, production, or other remote checks were run. The TestSprite CLI/local auth status preflight had been inspected earlier, but no project setup or TestSprite run was attempted because it would violate the offline-only scope.

## Unresolved prerequisites

1. A separately reviewed protected-policy change must supply the exact configured child parent ref, installed schema and migration fingerprints, and a versioned `billingSqlGate.expectedInvariantsSha256` pin for trigger/ACL/privilege digests, the six assertions, and four exact loser states. Do not populate these from test fixtures.
2. The control runtime’s policy validator/preflight must be updated in that reviewed change to authenticate the same protected policy. The gate module and policy must be loaded from the trusted protected control checkout, never from the candidate SHA. This task intentionally accepts no per-call policy override.
3. Independent, genuinely read-only SQL readers are still absent. Their source/query review, distinct identity configuration, and exact binding to the configured child validation target remain required before enabling any installed-schema or concurrency pass.
4. Until all of the above are supplied and a later end-to-end local/approved verification covers the matching path, Task 7 has no happy-path proof and is not production-ready.
