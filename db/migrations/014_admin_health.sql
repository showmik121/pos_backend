-- 014: Platform Admin Panel, phase A2 "health" (docs/handover/ADMIN_PANEL_PRD.md H-1, H-2, H-3, dashboard tiles).
-- ADDITIVE and SELF-CONTAINED: the shop API does NOT call anything created here, so old and new shop code both work on this schema
-- (unlike 013, there is no rollout-order hazard). Only the admin API needs it. Rollback: db/rollback/014_down.sql (never run by db-migrate).
--
-- What it adds
--   * error_triage                 status (open / resolved / ignored) + note per client_errors fingerprint, admin-only. FK to client_errors with
--                                  ON DELETE CASCADE, so the 30-day purge (005) removes triage rows with the error (no orphans)
--                                  A RESOLVED error that happens again counts as open again (regression); an IGNORED one stays ignored
--   * admin_health_sync            tenants with no sync for N hours (never-synced counts from creation)
--   * admin_health_errors          client_errors joined with triage, filter by status
--   * admin_error_triage_set       upsert a triage row (not_found if the fingerprint is not in client_errors)
--   * admin_health_negative_stock  tenants with live batches below zero: COUNTS only
--   * admin_dashboard              one row of tile counts
--
-- Data minimisation (tested in tests/integration/admin-health-pg.test.ts): negative stock returns batch and unit COUNTS, never product
-- names, prices or cost. client_errors text is attacker-writable (POST /v1/client-errors needs no token), so the admin API scrubs it on the way out (src/domain/scrub.ts) and the UI must render it as plain text. Same TRUST BOUNDARY as 012/013 (ADR 0001): the functions do not
-- re-authorize their caller; the app layer is the control.
BEGIN;

SET LOCAL lock_timeout = '5s';   -- CREATE TABLE ... REFERENCES takes a brief lock on platform_admins and client_errors: fail fast, never queue

-- ---------------------------------------------------------------- 1) table
CREATE TABLE error_triage (
  fingerprint text PRIMARY KEY REFERENCES client_errors(fingerprint) ON DELETE CASCADE CHECK (fingerprint ~ '^[0-9a-f]{32}$'),
  status      text NOT NULL CHECK (status IN ('open', 'resolved', 'ignored')),
  note        text CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 500),
  admin_id    uuid REFERENCES platform_admins(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE error_triage ENABLE ROW LEVEL SECURITY;   -- no policy, no grant: invisible to pos_app

-- ---------------------------------------------------------------- 2) functions (SECURITY DEFINER, fixed search_path)
-- 2a) stuck sync. "Last sync" is stores.last_sync_at (013); a store that never synced is measured from its creation.
--     Deleted, cancelled, pending-deletion and SUSPENDED stores are left out: they cannot (or need not) sync, so listing them is noise.
--     STRICT: a NULL argument returns no rows instead of slipping past the range checks.
CREATE FUNCTION admin_health_sync(p_hours integer, p_limit integer)
RETURNS TABLE (id uuid, name text, status text, last_sync_at timestamptz, created_at timestamptz, hours_since integer, total bigint)
LANGUAGE plpgsql STABLE STRICT SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_hours < 1 OR p_hours > 8760 OR p_limit < 1 OR p_limit > 200 THEN RAISE EXCEPTION 'invalid_page' USING ERRCODE = 'P0001'; END IF;
  RETURN QUERY
  WITH s AS (
    SELECT st.id, st.name, st.status, st.last_sync_at, st.created_at, coalesce(st.last_sync_at, st.created_at) AS ref
    FROM stores st
    WHERE st.status NOT IN ('deleted', 'cancelled', 'pending_deletion', 'suspended')
      AND coalesce(st.last_sync_at, st.created_at) < now() - make_interval(hours => p_hours)
  )
  SELECT s.id, s.name, s.status, s.last_sync_at, s.created_at, floor(extract(epoch FROM (now() - s.ref)) / 3600)::integer, count(*) OVER ()
  FROM s ORDER BY s.ref ASC, s.id LIMIT p_limit;
END $$;

-- 2b) error viewer: one row per fingerprint (005), newest first. No triage row = open. A resolved error seen AGAIN after it was resolved
--     (client_errors.last_at moved past the triage time) is open again: a fix that did not hold must not stay hidden.
CREATE FUNCTION admin_health_errors(p_status text, p_limit integer)
RETURNS TABLE (fingerprint text, kind text, message text, path text, app_version text, count integer, first_at timestamptz, last_at timestamptz,
               store_id uuid, status text, note text)
LANGUAGE plpgsql STABLE STRICT SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_limit < 1 OR p_limit > 100 OR p_status NOT IN ('open', 'resolved', 'ignored', 'all') THEN RAISE EXCEPTION 'invalid_page' USING ERRCODE = 'P0001'; END IF;
  RETURN QUERY
  SELECT c.fingerprint, c.kind, c.message, c.path, c.app_version, c.count, c.first_at, c.last_at, c.store_id,
         CASE WHEN t.status = 'resolved' AND c.last_at > t.updated_at THEN 'open' ELSE coalesce(t.status, 'open') END AS eff, t.note
  FROM client_errors c LEFT JOIN error_triage t ON t.fingerprint = c.fingerprint
  WHERE p_status = 'all' OR (CASE WHEN t.status = 'resolved' AND c.last_at > t.updated_at THEN 'open' ELSE coalesce(t.status, 'open') END) = p_status
  ORDER BY c.last_at DESC, c.fingerprint LIMIT p_limit;
END $$;

-- 2c) triage upsert. A fingerprint that left client_errors (30-day purge) cannot be triaged.
CREATE FUNCTION admin_error_triage_set(p_fingerprint text, p_status text, p_note text, p_admin uuid)
RETURNS TABLE (fingerprint text, status text, note text, updated_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_fingerprint IS NULL OR p_status IS NULL OR p_admin IS NULL OR p_status NOT IN ('open', 'resolved', 'ignored')
     OR (p_note IS NOT NULL AND length(btrim(p_note)) NOT BETWEEN 1 AND 500) THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM client_errors c WHERE c.fingerprint = p_fingerprint) THEN RAISE EXCEPTION 'error_not_found' USING ERRCODE = 'P0001'; END IF;
  RETURN QUERY
  INSERT INTO error_triage AS t (fingerprint, status, note, admin_id, updated_at) VALUES (p_fingerprint, p_status, p_note, p_admin, now())
  ON CONFLICT ON CONSTRAINT error_triage_pkey DO UPDATE SET status = EXCLUDED.status, note = EXCLUDED.note, admin_id = EXCLUDED.admin_id, updated_at = now()
  RETURNING t.fingerprint, t.status, t.note, t.updated_at;
END $$;

-- 2d) negative stock (PRD H-2): live batches below zero, grouped per store. Uses stock_batches_negative_idx (006). COUNTS only.
CREATE FUNCTION admin_health_negative_stock(p_limit integer)
RETURNS TABLE (id uuid, name text, status text, batches bigint, units_short bigint, total bigint)
LANGUAGE plpgsql STABLE STRICT SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_limit < 1 OR p_limit > 200 THEN RAISE EXCEPTION 'invalid_page' USING ERRCODE = 'P0001'; END IF;
  RETURN QUERY
  WITH n AS (
    SELECT b.store_id, count(*) AS batches, -sum(b.qty_remaining)::bigint AS units_short
    FROM stock_batches b WHERE b.qty_remaining < 0 AND b.removed_at IS NULL GROUP BY b.store_id
  )
  SELECT s.id, s.name, s.status, n.batches, n.units_short, count(*) OVER ()
  FROM n JOIN stores s ON s.id = n.store_id ORDER BY n.units_short DESC, s.id LIMIT p_limit;
END $$;

-- 2e) dashboard tiles in one round trip. "Today" is the Asia/Dhaka calendar day (PRD: timestamps shown Asia/Dhaka).
CREATE FUNCTION admin_dashboard(p_stuck_hours integer)
RETURNS TABLE (by_status jsonb, stuck_sync bigint, new_errors bigint, negative_tenants bigint, signups_today bigint)
LANGUAGE plpgsql STABLE STRICT SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_stuck_hours < 1 OR p_stuck_hours > 8760 THEN RAISE EXCEPTION 'invalid_page' USING ERRCODE = 'P0001'; END IF;
  RETURN QUERY SELECT
    coalesce((SELECT jsonb_object_agg(g.status, g.n) FROM (SELECT st.status, count(*) AS n FROM stores st GROUP BY st.status) g), '{}'::jsonb),
    (SELECT count(*) FROM stores st WHERE st.status NOT IN ('deleted', 'cancelled', 'pending_deletion', 'suspended')
        AND coalesce(st.last_sync_at, st.created_at) < now() - make_interval(hours => p_stuck_hours)),
    (SELECT count(*) FROM client_errors c LEFT JOIN error_triage t ON t.fingerprint = c.fingerprint
        WHERE (CASE WHEN t.status = 'resolved' AND c.last_at > t.updated_at THEN 'open' ELSE coalesce(t.status, 'open') END) = 'open'
          AND c.last_at >= now() - interval '24 hours'),
    (SELECT count(DISTINCT b.store_id) FROM stock_batches b WHERE b.qty_remaining < 0 AND b.removed_at IS NULL),
    (SELECT count(*) FROM stores st WHERE (st.created_at AT TIME ZONE 'Asia/Dhaka')::date = (now() AT TIME ZONE 'Asia/Dhaka')::date);
END $$;

-- ---------------------------------------------------------------- 3) grants (same loop as 013, idempotent for earlier admin_* functions)
DO $$
DECLARE r text; f record;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON error_triage FROM %I', r);
    END IF;
  END LOOP;
  REVOKE ALL ON error_triage FROM PUBLIC;
  REVOKE ALL ON error_triage FROM pos_app;

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

-- self-record (same reason as 012 and 013)
INSERT INTO schema_migrations (name) VALUES ('014_admin_health.sql') ON CONFLICT DO NOTHING;

COMMIT;
