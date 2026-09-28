# LawX Billing Validation Control

Public source for the control plane that validates a specific LawX Preview candidate against isolated Supabase and Stripe TEST services. This repository is intentionally separate from the application repository; candidate code and artifacts are untrusted inputs and are never executed here. Never commit credentials, tokens, webhook signing secrets, database passwords, or local environment files.

No production, Supabase `main`, Stripe Live, or shared-runner operations belong in this repository.

The runtime preflight compares an independently pinned digest of generated `public` schema TypeScript types and a separate digest of applied migration history. Generated types reflect the API type surface; they do not detect out-of-band RLS policy or index changes. Unknown provider pins remain `null` and preflight refuses all network access until they have been independently read back and configured in reviewed policy.
