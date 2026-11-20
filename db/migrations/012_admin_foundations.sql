-- 012: Platform Admin Panel foundations (docs/ADMIN_PANEL_PRD.md, phase A0, with §17 addendum binding).
-- ADDITIVE: old shop code keeps working on this schema; NEW code needs this migration first
-- (apply -> set admin secrets -> merge; see docs/RUNBOOK.md). Rollback: db/rollback/012_down.sql (never run by db-migrate).
--
-- Hardening pattern copied from 002 (auth_throttle) / 005 (record_client_error):
--   * admin tables: RLS on, NO policy, NO grant to pos_app  -> shop API role cannot see them at all
--   * admin_app: its own NOBYPASSRLS role with ZERO table grants; it can only EXECUTE admin_* SECURITY DEFINER functions
--   * every function: fixed search_path, REVOKE FROM PUBLIC, EXECUTE granted to admin_app only
--   * admin functions never read sync_events payloads, customers, sales, cost prices (PRD §6.1)
--   * TRUST BOUNDARY (accepted for A0, see docs/adr/0001): the functions do NOT re-authorize their caller. The app layer (token,
--     DB session, role, step-up, audit) is the control. Whoever holds the admin_app credential (ADMIN_DATABASE_URL) therefore has
--     full admin-panel power (e.g. create a super admin) but still cannot read any shop data. Protect that URL like the JWT
--     secrets. admin_get / admin_find_by_email return the whole admin row (password hash, encrypted TOTP secret) for login.
--     Revisit before A3 (money): move authorization and the audit write into the functions.
BEGIN;

-- ALTER TABLE stores takes ACCESS EXCLUSIVE and every shop request reads stores: if something holds a lock on it, fail fast
-- (the whole file rolls back, nothing is half-applied) instead of queueing every shop request behind this migration.
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------- 1) tenant status (enforced by the shop API)
-- status is the billing/enforcement state (PRD §8.2). The CHECK lists the whole machine so later phases need no schema churn.
-- grandfathered: every store that exists TODAY is grandfathered (no billing until Finance changes it at A3 go-live). ADD COLUMN with a
-- constant default is metadata-only, so existing rows get `true` without a table rewrite or UPDATE; the default is then flipped
-- to `false` so only rows created from now on are not grandfathered.
ALTER TABLE stores
  ADD COLUMN status            text NOT NULL DEFAULT 'active'
    CHECK (status IN ('trial', 'active', 'grace', 'read_only', 'suspended', 'pending_deletion', 'deleted', 'cancelled')),
  ADD COLUMN grandfathered     boolean NOT NULL DEFAULT true,
  ADD COLUMN plan_id           uuid,                      -- FK to plans arrives with A3
  ADD COLUMN trial_ends_at     timestamptz,
  ADD COLUMN read_only_since   timestamptz,
  ADD COLUMN status_message    text CHECK (status_message IS NULL OR length(status_message) <= 500),
  ADD COLUMN status_changed_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE stores ALTER COLUMN grandfathered SET DEFAULT false;
-- A store can never be 'trial' without an end date, whichever code path inserted it (signup sets it; seeds, tests and manual SQL
-- must too). Every existing row is 'active', so the constraint validates instantly.
ALTER TABLE stores ADD CONSTRAINT stores_trial_has_end CHECK (status <> 'trial' OR trial_ends_at IS NOT NULL);
-- (no index on status: nearly every row is 'active'; add one with the A3 dunning sweeper if a query needs it)

-- Signup creates the store in 'trial' for 14 days, atomically with the owner and counter (same function as 001).
CREATE OR REPLACE FUNCTION auth_register_store(
  p_store_name text, p_store_kind text, p_owner_name text, p_phone text, p_password_hash text
) RETURNS TABLE (store_id uuid, user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_store uuid; v_user uuid;
BEGIN
  INSERT INTO stores (name, kind, phone, status, trial_ends_at)
    VALUES (p_store_name, p_store_kind, p_phone, 'trial', now() + interval '14 days') RETURNING id INTO v_store;
  INSERT INTO users (store_id, name, phone, password_hash, role)
    VALUES (v_store, p_owner_name, p_phone, p_password_hash, 'owner') RETURNING id INTO v_user;
  INSERT INTO store_counters (store_id) VALUES (v_store);
  RETURN QUERY SELECT v_store, v_user;
END $$;

-- ---------------------------------------------------------------- 2) admin role
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'admin_app') THEN
    CREATE ROLE admin_app LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
ALTER ROLE admin_app SET statement_timeout = '15s';   -- password is set by scripts/db-migrate.ts (ADMIN_APP_PASSWORD)
GRANT USAGE ON SCHEMA public TO admin_app;             -- needed to call functions; no table is granted

-- ---------------------------------------------------------------- 3) admin tables
CREATE TABLE platform_admins (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               text NOT NULL CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 254),
  name                text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  role                text NOT NULL CHECK (role IN ('super', 'support', 'finance', 'viewer')),
  password_hash       text NOT NULL,                      -- scrypt, same format as shop users
  totp_secret_enc     text,                               -- AES-256-GCM envelope (ADMIN_TOTP_ENC_KEY); NULL = none generated yet
  totp_confirmed_at   timestamptz,                        -- NULL = not enrolled: no data is returned until enrolled (acceptance 6)
  totp_last_step      bigint,                             -- last accepted 30s step: replay guard
  recovery_codes_hash text[] NOT NULL DEFAULT '{}',       -- hashed, single-use
  active              boolean NOT NULL DEFAULT true,
  must_reenroll       boolean NOT NULL DEFAULT false,     -- set by 2FA/password reset (§17.2)
  allowed_ips         text[] NOT NULL DEFAULT '{}',       -- optional allow-list (A-5, P1); empty = any
  last_login_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid REFERENCES platform_admins(id),-- NULL = created by the CLI
  UNIQUE (email)
);

CREATE TABLE admin_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id       uuid NOT NULL REFERENCES platform_admins(id),
  stage          text NOT NULL CHECK (stage IN ('pending', 'active')),  -- pending = password OK, 2FA not yet; carries no data access
  issued_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,                    -- absolute limit (8 h active, 5 min pending)
  stepup_until   timestamptz,                             -- sensitive actions require stepup_until > now()
  ip             text,
  user_agent     text,
  revoked_at     timestamptz,
  revoked_reason text
);
CREATE INDEX admin_sessions_admin_idx ON admin_sessions (admin_id) WHERE revoked_at IS NULL;

CREATE TABLE admin_audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  admin_id    uuid,                                       -- NULL for cli/system actors
  actor       text NOT NULL CHECK (actor IN ('admin', 'cli', 'system')),
  action      text NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  target_type text,
  target_id   text,
  store_id    uuid,
  reason      text CHECK (reason IS NULL OR length(reason) <= 1000),
  before      jsonb,
  after       jsonb,
  ip          text,
  ua          text,
  -- 'started' is RESERVED for A3: an intent row written BEFORE a sensitive (money) action, so that a commit whose final audit row
  -- cannot be written is still provable. Nothing writes it in A0 (ADR 0005: today the action and its audit row are two statements;
  -- the dispatcher logs "APPLIED but audit write failed" with the request id instead).
  outcome     text NOT NULL DEFAULT 'ok' CHECK (outcome IN ('ok', 'denied', 'error', 'started')),
  request_id  text
);
CREATE INDEX admin_audit_at_idx ON admin_audit_log (at DESC);
CREATE INDEX admin_audit_admin_idx ON admin_audit_log (admin_id, at DESC);
CREATE INDEX admin_audit_store_idx ON admin_audit_log (store_id, at DESC) WHERE store_id IS NOT NULL;
CREATE INDEX admin_audit_action_idx ON admin_audit_log (action, at DESC);
CREATE TRIGGER admin_audit_append_only BEFORE UPDATE OR DELETE ON admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();   -- from 001; holds even for the table owner
CREATE TRIGGER admin_audit_no_truncate BEFORE TRUNCATE ON admin_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_update_delete();   -- row triggers do not fire on TRUNCATE
-- (a superuser can still DISABLE TRIGGER; that is why the audit rows are also what alerting watches. A retention purge
--  therefore needs a new, reviewed migration, e.g. partition + detach, never DELETE.)

ALTER TABLE platform_admins  ENABLE ROW LEVEL SECURITY;   -- no policy + no grants: reachable only via the functions below
ALTER TABLE admin_sessions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_audit_log  ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------- 4) admin functions (SECURITY DEFINER, fixed search_path)
-- 4a) admins
CREATE FUNCTION admin_find_by_email(p_email text) RETURNS SETOF platform_admins
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT * FROM platform_admins WHERE email = lower(btrim(p_email))
$$;

CREATE FUNCTION admin_get(p_id uuid) RETURNS SETOF platform_admins
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT * FROM platform_admins WHERE id = p_id
$$;

-- listing never returns hashes or secrets
CREATE FUNCTION admin_list_admins()
RETURNS TABLE (id uuid, email text, name text, role text, active boolean, enrolled boolean, must_reenroll boolean,
               last_login_at timestamptz, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.id, a.email, a.name, a.role, a.active, a.totp_confirmed_at IS NOT NULL, a.must_reenroll, a.last_login_at, a.created_at
  FROM platform_admins a ORDER BY a.created_at
$$;

CREATE FUNCTION admin_create(p_email text, p_name text, p_role text, p_password_hash text, p_totp_secret_enc text, p_created_by uuid)
RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO platform_admins (email, name, role, password_hash, totp_secret_enc, created_by)
  VALUES (lower(btrim(p_email)), p_name, p_role, p_password_hash, p_totp_secret_enc, p_created_by)
  RETURNING id
$$;

-- Role/active change. The last active super admin can never be demoted or deactivated (A-6); serialised by an advisory lock.
-- Deactivation revokes every session at once.
CREATE FUNCTION admin_set_role_active(p_id uuid, p_role text, p_active boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_was_super boolean; v_supers integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('platform_admins:super', 0));
  -- Only an ENROLLED super counts: one that has not finished 2FA enrolment (or must re-enrol) cannot sign in, so it is not a spare.
  SELECT (role = 'super' AND active AND totp_confirmed_at IS NOT NULL AND NOT must_reenroll) INTO v_was_super
    FROM platform_admins WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE platform_admins SET role = p_role, active = p_active WHERE id = p_id;
  SELECT count(*) INTO v_supers FROM platform_admins
   WHERE role = 'super' AND active AND totp_confirmed_at IS NOT NULL AND NOT must_reenroll;
  IF v_was_super AND v_supers < 1 THEN
    RAISE EXCEPTION 'last_super_admin' USING ERRCODE = 'P0001';   -- rolls the UPDATE back
  END IF;
  IF NOT p_active THEN
    UPDATE admin_sessions SET revoked_at = now(), revoked_reason = 'deactivated' WHERE admin_id = p_id AND revoked_at IS NULL;
  END IF;
  RETURN true;
END $$;

-- A password reset (p_force_reenroll) ALSO clears 2FA in the same statement (§17.2: resets force re-enrolment): atomic, so a
-- half-applied reset (new password, old 2FA) cannot exist. Either way every session of that admin ends.
CREATE FUNCTION admin_set_password(p_id uuid, p_password_hash text, p_force_reenroll boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_force_reenroll THEN
    UPDATE platform_admins
       SET password_hash = p_password_hash, must_reenroll = true, totp_secret_enc = NULL, totp_confirmed_at = NULL,
           totp_last_step = NULL, recovery_codes_hash = '{}'
     WHERE id = p_id;
  ELSE
    UPDATE platform_admins SET password_hash = p_password_hash WHERE id = p_id;
  END IF;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE admin_sessions SET revoked_at = now(), revoked_reason = 'password_changed' WHERE admin_id = p_id AND revoked_at IS NULL;
  RETURN true;
END $$;

-- enrolment: begin (store the encrypted secret) -> confirm (first valid code, issue recovery-code hashes).
-- begin only fills an EMPTY slot: a secret the CLI provisioned, or one already issued, is never silently replaced.
CREATE FUNCTION admin_totp_begin(p_id uuid, p_secret_enc text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE platform_admins SET totp_secret_enc = p_secret_enc, totp_last_step = NULL
   WHERE id = p_id AND active AND totp_confirmed_at IS NULL AND totp_secret_enc IS NULL;
  RETURN FOUND;
END $$;

-- confirm is bound to the exact secret whose code was verified (p_secret_enc), so a concurrent re-begin cannot
-- confirm an admin on a secret nobody checked
CREATE FUNCTION admin_totp_confirm(p_id uuid, p_recovery_hashes text[], p_step bigint, p_secret_enc text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE platform_admins
     SET totp_confirmed_at = now(), totp_last_step = p_step, recovery_codes_hash = p_recovery_hashes, must_reenroll = false
   WHERE id = p_id AND active AND totp_confirmed_at IS NULL AND totp_secret_enc IS NOT NULL AND totp_secret_enc = p_secret_enc;
  RETURN FOUND;
END $$;

-- replay guard: a 30 s step can be accepted once; atomic
CREATE FUNCTION admin_totp_use_step(p_id uuid, p_step bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE platform_admins SET totp_last_step = p_step
   WHERE id = p_id AND active AND totp_confirmed_at IS NOT NULL AND (totp_last_step IS NULL OR totp_last_step < p_step);
  RETURN FOUND;
END $$;

-- single-use recovery code: removes the hash atomically (two racing requests cannot both succeed)
CREATE FUNCTION admin_consume_recovery(p_id uuid, p_code_hash text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE platform_admins SET recovery_codes_hash = array_remove(recovery_codes_hash, p_code_hash)
   WHERE id = p_id AND active AND p_code_hash = ANY (recovery_codes_hash);
  RETURN FOUND;
END $$;

-- §17.2: super admin resets another admin's 2FA; forces re-enrolment and ends all sessions
CREATE FUNCTION admin_reset_2fa(p_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE platform_admins
     SET totp_secret_enc = NULL, totp_confirmed_at = NULL, totp_last_step = NULL, recovery_codes_hash = '{}', must_reenroll = true
   WHERE id = p_id;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE admin_sessions SET revoked_at = now(), revoked_reason = '2fa_reset' WHERE admin_id = p_id AND revoked_at IS NULL;
  RETURN true;
END $$;

CREATE FUNCTION admin_record_login(p_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE platform_admins SET last_login_at = now() WHERE id = p_id
$$;

-- 4b) sessions
CREATE FUNCTION admin_session_create(p_admin uuid, p_stage text, p_expires_secs integer, p_ip text, p_ua text) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO admin_sessions (admin_id, stage, expires_at, ip, user_agent)
  VALUES (p_admin, p_stage, now() + make_interval(secs => p_expires_secs), left(p_ip, 64), left(p_ua, 300))
  RETURNING id
$$;

-- one atomic check + touch: session must be live, not idle-expired, not past its absolute limit, admin still active
CREATE FUNCTION admin_session_touch(p_id uuid, p_idle_secs integer)
RETURNS TABLE (session_id uuid, admin_id uuid, stage text, stepup_until timestamptz, email text, name text, role text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  UPDATE admin_sessions s SET last_seen_at = now()
    FROM platform_admins a
   WHERE s.id = p_id AND a.id = s.admin_id AND a.active
     AND s.revoked_at IS NULL AND s.expires_at > now()
     AND s.last_seen_at > now() - make_interval(secs => p_idle_secs)
  RETURNING s.id, s.admin_id, s.stage, s.stepup_until, a.email, a.name, a.role;
END $$;

CREATE FUNCTION admin_session_revoke(p_id uuid, p_reason text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE admin_sessions SET revoked_at = now(), revoked_reason = left(p_reason, 100) WHERE id = p_id AND revoked_at IS NULL
$$;

CREATE FUNCTION admin_session_stepup(p_id uuid, p_secs integer) RETURNS timestamptz
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE admin_sessions SET stepup_until = now() + make_interval(secs => p_secs)
   WHERE id = p_id AND stage = 'active' AND revoked_at IS NULL AND expires_at > now()
  RETURNING stepup_until
$$;

-- 4c) audit (append only; the table also has the trigger above)
CREATE FUNCTION admin_audit_append(
  p_admin uuid, p_actor text, p_action text, p_target_type text, p_target_id text, p_store uuid, p_reason text,
  p_before jsonb, p_after jsonb, p_ip text, p_ua text, p_outcome text, p_request_id text
) RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO admin_audit_log (admin_id, actor, action, target_type, target_id, store_id, reason, before, after, ip, ua, outcome, request_id)
  VALUES (p_admin, p_actor, p_action, p_target_type, p_target_id, p_store, p_reason, p_before, p_after,
          left(p_ip, 64), left(p_ua, 300), coalesce(p_outcome, 'ok'), left(p_request_id, 100))
  RETURNING id
$$;

-- 4d) throttle: own bucket namespace ('admin:' prefix, §17.8) so shop attempts can never lock admins out, and the reverse
CREATE FUNCTION admin_throttle(p_bucket text, p_max integer, p_window_seconds integer) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT auth_throttle('admin:' || p_bucket, p_max, p_window_seconds)
$$;

CREATE FUNCTION admin_throttle_reset(p_bucket text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT auth_throttle_reset('admin:' || p_bucket)
$$;

-- ---------------------------------------------------------------- 5) grants
-- anon/authenticated (Supabase Data API roles) get nothing on the new objects; pos_app has no grant on the tables.
DO $$
DECLARE r text; f record;
BEGIN
  -- service_role (Supabase, BYPASSRLS, gets ALL on postgres-created objects by default) is revoked too: nothing in this
  -- project uses it, so it must not be able to read credentials. Verify on staging; the Data API must not expose `public`.
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON platform_admins, admin_sessions, admin_audit_log FROM %I', r);
    END IF;
  END LOOP;
  REVOKE ALL ON platform_admins, admin_sessions, admin_audit_log FROM pos_app;

  FOR f IN SELECT oid::regprocedure AS sig FROM pg_proc
            WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'admin\_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'pos_app'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f.sig, r);
      END IF;
    END LOOP;
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO admin_app', f.sig);
  END LOOP;
END $$;

-- Self-record: a crash between COMMIT and the runner's own INSERT (or running this file by hand in the SQL editor) must not
-- leave the migration applied but unrecorded, because 012 is not re-runnable. The runner uses ON CONFLICT DO NOTHING too.
INSERT INTO schema_migrations (name) VALUES ('012_admin_foundations.sql') ON CONFLICT DO NOTHING;

COMMIT;
