-- ROLLBACK of 014_admin_health.sql. NEVER run by scripts/db-migrate.ts (it scans db/migrations only).
-- ORDER: newest first. Run this BEFORE 013_down.sql and 012_down.sql (013_down refuses while error_triage exists).
-- Run by hand with the `postgres` role, after a fresh backup. 014 is self-contained: the shop API never calls it, so there is no
-- code-first step. Deploy the previous ADMIN build (or leave the admin gate off) first so no admin request hits a missing function.
-- It DESTROYS error_triage (resolved/ignored decisions and notes). 012 and 013 stay applied.
-- Revert or remove the 014 file from the deployed commit first, or the next `db:migrate` re-applies it (it removes the schema_migrations row).
BEGIN;
SET LOCAL lock_timeout = '5s';

-- 015 (billing) is newer: it must be rolled back first (db/rollback/015_down.sql)
DO $$
BEGIN
  IF to_regclass('public.subscription_payments') IS NOT NULL OR to_regprocedure('admin_billing_overview()') IS NOT NULL THEN
    RAISE EXCEPTION 'migration 015 is still applied: run db/rollback/015_down.sql first (newest first)' USING ERRCODE = 'P0001';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.error_triage') IS NOT NULL AND EXISTS (SELECT 1 FROM error_triage) AND coalesce(current_setting('bipone.discard_error_triage', true), '') <> 'yes' THEN
    RAISE EXCEPTION 'error_triage holds data: export it, then SET bipone.discard_error_triage = ''yes'' and re-run (docs/RUNBOOK.md)'
      USING ERRCODE = 'P0001';
  END IF;
END $$;

-- only the functions 014 itself created, by name
DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT oid::regprocedure AS sig FROM pg_proc
            WHERE pronamespace = 'public'::regnamespace AND proname = ANY (ARRAY[
              'admin_health_sync', 'admin_health_errors', 'admin_error_triage_set', 'admin_health_negative_stock', 'admin_dashboard']) LOOP
    EXECUTE format('DROP FUNCTION %s', f.sig);
  END LOOP;
END $$;

DROP TABLE IF EXISTS error_triage;

DELETE FROM schema_migrations WHERE name = '014_admin_health.sql';
COMMIT;
