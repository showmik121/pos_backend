# ADR 0008: Deploy guard on an `APPLIED_MIGRATION` Actions variable

Status: accepted (A0 hardening) · Date: 2026-11-21 · Extends ADR 0007 section 2, RUNBOOK 3খ

## Context
A push to `main` auto-deploys the API once `SUPABASE_ACCESS_TOKEN` is set, and it never runs migrations. Since A1 the shop API calls `sync_touch_store()` (migration 013) on every push/pull. If the code deploys first, every shop sync fails.

## Decision
- `scripts/deploy-guard-run.mjs` (logic in `deploy-guard.mjs`) compares the highest `db/migrations/NNN_*.sql` with the Actions **variable** `APPLIED_MIGRATION` (not a secret). The deploy job runs it before install and build, and fails the deploy if the variable is missing, unparsable, or lower than the latest file. It fails closed.
- The operator raises `APPLIED_MIGRATION` only after `npm run db:migrate` succeeded on the live DB.

## Alternatives rejected
- CI queries `schema_migrations` itself: needs a live DB URL as a CI secret, a bigger blast radius than the problem.
- Do nothing, rely on RUNBOOK order: a human step with a silent, fleet-wide failure.

## Consequences
- Every new migration blocks auto-deploy until someone raises the variable. That is the intent.
- The variable can be wrong (set too early). The guard reduces the risk, it does not prove the live schema. The staging rehearsal and the post-deploy `/health` plus a shop sync check stay mandatory.
- A skipped deploy (no token) is unchanged.
- Mis-named migration files (not `NNN_name.sql`) block the deploy, because `db-migrate.ts` runs every `*.sql`.
- It only covers the CI deploy path. A manual `supabase functions deploy` is not stopped.
