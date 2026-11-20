-- ROLLBACK of 013_admin_tenant_ops.sql. NEVER run by scripts/db-migrate.ts (it scans db/migrations only).
-- Run by hand with the `postgres` role, after a fresh backup. Order for a rollback in production (docs/RUNBOOK.md):
--   1) deploy the previous API build FIRST (the A1 build calls sync_touch_store(); without this migration that call fails every sync)
--   2) run this file   3) verify /health and a shop login + sync.
-- It DESTROYS tenant_notes and tenant_status_events (the suspend / read-only history shown to shop owners). 012 stays applied.
BEGIN;
SET LOCAL lock_timeout = '5s';   -- DROP COLUMN on stores takes ACCESS EXCLUSIVE: fail fast instead of queueing every shop request

-- Notes and the status history are records of operator decisions. Refuse to drop them silently: export them first, then re-run this
-- file after   SET bipone.discard_tenant_ops = 'yes';
DO $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_notes) OR EXISTS (SELECT 1 FROM tenant_status_events))
     AND coalesce(current_setting('bipone.discard_tenant_ops', true), '') <> 'yes' THEN
    RAISE EXCEPTION 'tenant_notes / tenant_status_events hold data: export it, then SET bipone.discard_tenant_ops = ''yes'' and re-run (docs/RUNBOOK.md)'
      USING ERRCODE = 'P0001';
  END IF;
END $$;

-- only the functions 013 itself created, by name (a later phase's admin_* functions are never swept away)
DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT oid::regprocedure AS sig FROM pg_proc
            WHERE pronamespace = 'public'::regnamespace AND proname = ANY (ARRAY[
              'admin_mask_phone', 'admin_tenant_list', 'admin_tenant_get', 'admin_tenant_staff', 'admin_tenant_devices',
              'admin_tenant_status_history', 'admin_tenant_errors', 'admin_tenant_phones', 'admin_tenant_set_status',
              'admin_tenant_notes', 'admin_tenant_note_add', 'admin_audit_list', 'sync_touch_store']) LOOP
    EXECUTE format('DROP FUNCTION %s', f.sig);
  END LOOP;
END $$;

DROP TABLE tenant_status_events;
DROP TABLE tenant_notes;
DROP INDEX IF EXISTS client_errors_store_idx;
DROP INDEX IF EXISTS users_store_role_idx;
ALTER TABLE stores DROP COLUMN last_sync_at;

DELETE FROM schema_migrations WHERE name = '013_admin_tenant_ops.sql';

COMMIT;
