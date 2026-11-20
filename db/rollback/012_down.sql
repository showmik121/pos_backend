-- ROLLBACK of 012_admin_foundations.sql. NEVER run by scripts/db-migrate.ts (it scans db/migrations only).
-- Run by hand with the `postgres` role, after a fresh backup, and ONLY before the admin panel is in real use:
-- it DESTROYS platform_admins, admin_sessions and admin_audit_log (the audit trail!) and the per-store status/trial data.
-- Order for a rollback in production (docs/RUNBOOK.md): 1) deploy the previous API build (or revert the merge)
-- 2) run this file 3) verify /health and a shop login. Old shop code runs fine on the schema this restores.
BEGIN;
SET LOCAL lock_timeout = '5s';   -- DROP COLUMN on stores takes ACCESS EXCLUSIVE: fail fast instead of queueing every shop request

-- Operator activity in the audit log is evidence. Refuse to destroy it silently: export it first, then re-run this file after
--   SET bipone.discard_admin_audit = 'yes';
-- (rows written by the CLI alone, i.e. the bootstrap of the first admin, do not block a rollback).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM admin_audit_log WHERE actor <> 'cli')
     AND coalesce(current_setting('bipone.discard_admin_audit', true), '') <> 'yes' THEN
    RAISE EXCEPTION 'admin_audit_log holds operator activity: export it, then SET bipone.discard_admin_audit = ''yes'' and re-run (docs/RUNBOOK.md)'
      USING ERRCODE = 'P0001';
  END IF;
END $$;

-- functions first: several return the platform_admins row type. Only the functions 012 itself created are dropped (by name),
-- so a later phase's admin_* functions are never swept away by a rollback of 012 alone (the DROP TABLE below then fails loudly).
DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT oid::regprocedure AS sig FROM pg_proc
            WHERE pronamespace = 'public'::regnamespace AND proname = ANY (ARRAY[
              'admin_find_by_email', 'admin_get', 'admin_list_admins', 'admin_create', 'admin_set_role_active', 'admin_set_password',
              'admin_totp_begin', 'admin_totp_confirm', 'admin_totp_use_step', 'admin_consume_recovery', 'admin_reset_2fa',
              'admin_record_login', 'admin_session_create', 'admin_session_touch', 'admin_session_revoke', 'admin_session_stepup',
              'admin_audit_append', 'admin_throttle', 'admin_throttle_reset']) LOOP
    EXECUTE format('DROP FUNCTION %s', f.sig);
  END LOOP;
END $$;

DROP TABLE admin_sessions;
DROP TABLE admin_audit_log;   -- the trigger goes with the table
DROP TABLE platform_admins;

REVOKE USAGE ON SCHEMA public FROM admin_app;
DROP ROLE IF EXISTS admin_app;

-- restore the 001 definition (no status / trial)
CREATE OR REPLACE FUNCTION auth_register_store(
  p_store_name text, p_store_kind text, p_owner_name text, p_phone text, p_password_hash text
) RETURNS TABLE (store_id uuid, user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_store uuid; v_user uuid;
BEGIN
  INSERT INTO stores (name, kind, phone) VALUES (p_store_name, p_store_kind, p_phone) RETURNING id INTO v_store;
  INSERT INTO users (store_id, name, phone, password_hash, role)
    VALUES (v_store, p_owner_name, p_phone, p_password_hash, 'owner') RETURNING id INTO v_user;
  INSERT INTO store_counters (store_id) VALUES (v_store);
  RETURN QUERY SELECT v_store, v_user;
END $$;

DROP INDEX IF EXISTS stores_status_idx;
ALTER TABLE stores
  DROP COLUMN status, DROP COLUMN grandfathered, DROP COLUMN plan_id, DROP COLUMN trial_ends_at,
  DROP COLUMN read_only_since, DROP COLUMN status_message, DROP COLUMN status_changed_at;

DELETE FROM schema_migrations WHERE name = '012_admin_foundations.sql';

COMMIT;
