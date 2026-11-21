-- ROLLBACK of 015_admin_billing.sql. NEVER run by scripts/db-migrate.ts (it scans db/migrations only).
-- ORDER: newest first. 015 is the newest, so it is rolled back before 014_down, 013_down and 012_down.
-- Run by hand with the `postgres` role, after a fresh backup. The shop API never calls 015, so there is no code-first step for shops;
-- deploy the previous ADMIN build (or leave the admin gate off) first so no admin request hits a missing function.
-- It DESTROYS subscription_payments, subscription_events and plans: these are FINANCIAL RECORDS. Export them first (docs/RUNBOOK.md), then re-run after
--   SET bipone.discard_billing = 'yes';
-- Revert or remove the 015 file from the deployed commit first, or the next `db:migrate` re-applies it (this file removes the schema_migrations row).
BEGIN;
SET LOCAL lock_timeout = '5s';   -- ALTER TABLE stores takes ACCESS EXCLUSIVE: fail fast instead of queueing every shop request

DO $$
BEGIN
  IF (EXISTS (SELECT 1 FROM subscription_payments) OR EXISTS (SELECT 1 FROM subscription_events))
     AND coalesce(current_setting('bipone.discard_billing', true), '') <> 'yes' THEN
    RAISE EXCEPTION 'subscription_payments / subscription_events hold data: export it, then SET bipone.discard_billing = ''yes'' and re-run (docs/RUNBOOK.md)'
      USING ERRCODE = 'P0001';
  END IF;
END $$;

-- only the functions 015 itself created, by name (a later phase's admin_* functions are never swept away)
DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT oid::regprocedure AS sig FROM pg_proc
            WHERE pronamespace = 'public'::regnamespace AND proname = ANY (ARRAY[
              'admin_plans_list', 'admin_plan_update', 'admin_billing_header', 'admin_billing_payments', 'admin_payment_get',
              'admin_billing_events', 'admin_payment_record', 'admin_payment_void', 'admin_trial_extend', 'admin_billing_overview']) LOOP
    EXECUTE format('DROP FUNCTION %s', f.sig);
  END LOOP;
END $$;

DROP TABLE subscription_events;
DROP TABLE subscription_payments;
DROP INDEX stores_plan_idx;
ALTER TABLE stores DROP CONSTRAINT stores_plan_fk;
ALTER TABLE stores DROP COLUMN current_period_end;
DROP TABLE plans;

DELETE FROM schema_migrations WHERE name = '015_admin_billing.sql';

COMMIT;
