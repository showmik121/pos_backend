# ADR 0006: Integration tests run on an embedded, throwaway Postgres

Status: accepted (A0) · Date: 2026-11-20

## Context
The admin work needs integration tests for RLS, grants, SECURITY DEFINER functions, migrations, rollback and concurrency. The work machine has no Postgres or Docker, and the rule is that tests never touch a live database.

## Decision
- `npm run test:pg` (`scripts/test-pg-local.ts`) starts the `embedded-postgres` dev dependency in a temp dir on a random local port (UTF-8), runs every migration **twice** (proving idempotency) as the superuser, sets throwaway random role passwords, runs the integration suite as `pos_app` / `admin_app`, then deletes everything.
- Tests that need isolation (backfill, rollback, "last super admin" races) create their own scratch database inside that cluster.
- CI keeps using the Postgres 16 service container and the same test files.

## Consequences
- The embedded binary is PostgreSQL 18.x; CI uses 16 and Supabase may differ. Behaviour used here (RLS, SECURITY DEFINER, advisory locks, `make_interval`) is stable across these versions, but the Supabase-specific layer (pooler, default grants to `anon`/`authenticated`/`service_role`) is **not** exercised locally: the staging rehearsal covers it.
- `DROP ROLE admin_app` in the rollback is not run by the local rollback test (roles are cluster-wide); the staging rehearsal runs it.
