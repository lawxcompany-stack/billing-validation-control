# LawX Billing Validation Control

Private control plane for validating a specific LawX Preview candidate against isolated Supabase and Stripe TEST services. This repository is intentionally separate from the application repository; candidate code and artifacts are untrusted inputs and are never executed here.

No production, Supabase `main`, Stripe Live, or shared-runner operations belong in this repository.
