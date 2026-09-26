# Trusted Billing 43 collector — implementation contract

**Status:** locally approved on 2026-09-26. This copy travels with the control-repository implementation plan. The fuller approved design is in the app worktree at docs/superpowers/specs/2026-09-26-trusted-billing-43-collector-design.md.

## Goal and authority

Implement a trusted, offline-testable collector for exactly 43 billing journeys in lawxcompany-stack/billing-validation-control. Candidate application code is untrusted data: never checkout, import, or execute it in a privileged control job. The collector resolves an immutable Preview deployment by full candidate SHA and tree, then uses only the fixed trusted protocol and allowlisted HTTP/browser/provider adapters.

The current implementation has 45 listed financial scenarios but only four of the approved 43 have executable contracts. No generic pass, skipped result, or visual assertion may count as a scenario pass.

## Canonical suite

The canonical IDs, exactly once each:

- Signup: signup.native, signup.join, signup.expired-intent, signup.tampered-intent, signup.replay.
- Pricing: pricing.base-agents, pricing.progressive, pricing.combo, pricing.coupon-allowed, pricing.coupon-rejected, pricing.zero-total.
- Payment: payment.approved, payment.declined, payment.abandoned, payment.timeout, payment.refresh, payment.two-tabs.
- Zero: zero.authorized, zero.replay.
- Subscription: subscription.add-area, subscription.upgrade, subscription.downgrade, subscription.proration, subscription.renewal, subscription.cancellation.
- Finance: finance.delinquency, finance.recovery, finance.partial-refund, finance.partial-credit, finance.concurrent-adjustment.
- Access: access.contracted, access.uncontracted, access.other-team, access.extras-preprocedural, access.hub-blocked, access.custom-blocked.
- Webhook: webhook.invalid-signature, webhook.wrong-account, webhook.wrong-mode, webhook.replay, webhook.reverse-order, webhook.retry, webhook.takeover.

signup.advbox and payment.3ds are supervised workflows outside this suite and cannot be inferred from it.

## Safety invariants

- The only Supabase destination that may be configured later is child validation branch lawx-billing-validation-20260912 (project prefix zjvq…). Supabase main, Vercel Production, Stripe Live, the shared Terraform runner, secrets, remote migrations, remote tests, push, PR, merge, and deploy are out of scope for this implementation turn.
- Do not expose provider/control credentials to candidate-controlled jobs. The Preview candidate may read all its runtime variables, so its values must be disposable and branch/account scoped. Never pass control-schema credentials, GitHub App keys, activation challenges, runner tokens, Postgres-wide passwords, or production secrets to Preview or browser code.
- The collector is append-only for historical financial rows, Auth users, and Stripe objects. It may reverse only allowlisted reversible resources (expire open Checkout Sessions and cancel owned test subscriptions); it never deletes history, users, Stripe customers, payment intents, events, or Test Clocks.
- Capacity reservation, a global Supabase-branch and Stripe-account lock, attemptId, fixtureRunId, and fencing token are required before writes. Expired lease alone never permits takeover. Ambiguous provider intents retain lock and capacity until independent reconciliation.
- Stripe idempotency keys may be pruned by Stripe after at least 24 hours. Never retry an ambiguous mutation merely because the same key was persisted. Reconcile first; otherwise block. If a Test Clock reaches deletes_after before terminal reconciliation, do not delete or infer cleanup; retain the lock and require manual recovery.
- Retention policy must be finite, valid, and sufficient before the first fixture write. Missing/unbounded/exceeded capacity blocks. No automated database/branch rotation.
- Successful cleanup means ownership and projected state are reconciled, no active grants/contracts remain, reversible resources are closed, an append-only receipt is persisted, and lease/capacity may be released. It explicitly reports databaseBaselineRestored=false and fixtureReusable=false.
- Every output is sanitized, exact-schema, bound to source repo/workflow/run/attempt, full SHA/tree, immutable deployment, Supabase fingerprints, suite and cleanup receipt. Exactly 43 unique terminal passed results are required; no skipped, neutral, duplicate, extra, PII, cookie, session state, provider payload or secret.

## Independent trusted SQL/migration gate

The 43 user journeys do not replace direct database proof. A separately named trusted gate remains mandatory for checks not proved by the journeys: checkout-session RLS; C1 catalog mutation/version audit; C5 usage reservation/replay; legacy plan application and webhook compatibility; two-independent-Postgres-backend races for coupon capacity, checkout request/payment context, plan change, and adjustment; deterministic settlement lock ordering; stale renewal/completion fencing; migration history and schema fingerprint; trigger/ACL/privilege checks; shared-resource locks; and interruption/recovery/repeated-run behavior.

This gate may read installed schema/migration state but never executes candidate-owned SQL or performs db push. Existing app fixture scripts that disable triggers/history-delete guards or delete Auth/financial rows are prohibited and must not be ported or run.

## External gates

Offline tests cannot establish that Supabase validation is healthy, migrations are installed, a Preview runtime is isolated, Stripe TEST webhook points at the immutable Preview, GitHub environments are protected, or the runner is ephemeral. Existing recorded state includes Supabase MIGRATIONS_FAILED and missing fingerprints/webhook identity. Therefore the local implementation remains BLOCKED from remote mutation and is not a production-readiness declaration until independent read-only proofs close every external gate.
