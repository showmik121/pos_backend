-- 013: Platform Admin Panel, phase A1 "tenant ops" (docs/ADMIN_PANEL_PRD.md T-1..T-6, §6; acceptance 1, 2, 7).
-- ADDITIVE. Old shop code keeps working on this schema; NEW shop code (device touch, account activity) needs this migration first:
-- apply 012 -> apply 013 -> deploy the API -> set admin secrets (docs/RUNBOOK.md). Rollback: db/rollback/013_down.sql (never run by db-migrate).
--
-- What it adds
--   * stores.last_sync_at            "last sync" for the tenant list (touched by the shop API at most once per 5 minutes per store)
--   * tenant_notes                   internal notes + tags (T-6), admin-only
--   * tenant_status_events           every suspend / read-only / reactivate. `message` is shown to the shop owner; `reason` is INTERNAL
--                                    and pos_app has no column grant on it
--   * admin_tenant_* / admin_audit_list   SECURITY DEFINER functions: the only way admin_app reads tenants
--   * sync_touch_store()             SECURITY DEFINER; the shop API's only write to stores.last_sync_at (bound to app.store_id)
--
-- Data minimisation (PRD §6, tested in tests/integration/admin-tenants-pg.test.ts): no function returns sync_events.payload,
-- customers, sales, cost prices or password hashes. Phones come back masked except admin_tenant_phones (the audited reveal).
-- Same TRUST BOUNDARY as 012 / ADR 0001: the functions do not re-authorize their caller; the app layer is the control.
BEGIN;

SET LOCAL lock_timeout = '5s';   -- ALTER TABLE stores takes ACCESS EXCLUSIVE; fail fast rather than queue every shop request

-- ---------------------------------------------------------------- 1) columns and indexes
ALTER TABLE stores ADD COLUMN last_sync_at timestamptz;   -- nullable, no default: metadata-only, no table rewrite
-- per-row staff/owner lookups of the tenant list (and the shop's own RLS-filtered user reads) are by store
CREATE INDEX users_store_role_idx ON users (store_id, role, created_at);
CREATE INDEX client_errors_store_idx ON client_errors (store_id, last_at DESC) WHERE store_id IS NOT NULL;

-- ---------------------------------------------------------------- 2) tables
CREATE TABLE tenant_notes (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id   uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  admin_id   uuid REFERENCES platform_admins(id),
  body       text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 2000),
  tags       text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 10),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tenant_notes_store_idx ON tenant_notes (store_id, id DESC);

CREATE TABLE tenant_status_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id    uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  at          timestamptz NOT NULL DEFAULT now(),
  from_status text NOT NULL,
  to_status   text NOT NULL,
  admin_id    uuid,
  reason      text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),   -- INTERNAL (pos_app cannot read this column)
  message     text CHECK (message IS NULL OR length(message) <= 500)             -- shown to the shop owner
);
CREATE INDEX tenant_status_events_store_idx ON tenant_status_events (store_id, id DESC);

-- the shop API reads ITS OWN rows (account activity list): RLS like every tenant table, and a COLUMN grant that leaves out `reason`
ALTER TABLE tenant_status_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_status_events USING (store_id = app_store_id()) WITH CHECK (store_id = app_store_id());
ALTER TABLE tenant_notes ENABLE ROW LEVEL SECURITY;   -- no policy, no grant: invisible to pos_app

-- ---------------------------------------------------------------- 3) functions
-- 3a) masking helper (mirrors src/domain/tenant-admin.ts maskPhone)
CREATE FUNCTION admin_mask_phone(p_phone text) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN length(p_phone) >= 7 THEN left(p_phone, 3) || '****' || right(p_phone, 3) ELSE '****' END
$$;

-- 3b) tenant list: filters + search + sort + page + total in ONE statement. Paged by offset (ordering is the chosen sort, then id).
CREATE FUNCTION admin_tenant_list(
  p_q text, p_status text, p_kind text, p_no_sync_days integer, p_sort text, p_dir text, p_limit integer, p_offset integer
) RETURNS TABLE (
  id uuid, name text, kind text, owner_name text, owner_phone_masked text, created_at timestamptz, status text, grandfathered boolean,
  trial_ends_at timestamptz, last_sync_at timestamptz, device_count integer, staff_count integer, total bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_pat text;
BEGIN
  IF p_sort NOT IN ('created', 'name', 'lastSync', 'status') OR p_dir NOT IN ('asc', 'desc') THEN
    RAISE EXCEPTION 'invalid_sort' USING ERRCODE = 'P0001';
  END IF;
  IF p_limit < 1 OR p_limit > 100 OR p_offset < 0 THEN RAISE EXCEPTION 'invalid_page' USING ERRCODE = 'P0001'; END IF;
  -- Phone search is EXACT only: a partial match would let a caller recover the digits admin_mask_phone hides (probe 017+digits).
  -- LIKE metacharacters in the search text are literals
  v_pat := CASE WHEN p_q IS NULL THEN NULL
                ELSE '%' || replace(replace(replace(p_q, '\', '\\'), '%', '\%'), '_', '\_') || '%' END;
  RETURN QUERY
  WITH base AS (
    SELECT s.id AS sid, s.name AS sname, s.kind AS skind, s.created_at AS screated, s.status AS sstatus, s.grandfathered AS sgrand,
           s.trial_ends_at AS strial, s.last_sync_at AS ssync,
           count(*) OVER () AS total_rows,
           row_number() OVER (ORDER BY
             CASE WHEN p_sort = 'created'  AND p_dir = 'asc'  THEN s.created_at END ASC,
             CASE WHEN p_sort = 'created'  AND p_dir = 'desc' THEN s.created_at END DESC,
             CASE WHEN p_sort = 'name'     AND p_dir = 'asc'  THEN lower(s.name) END COLLATE "C" ASC,
             CASE WHEN p_sort = 'name'     AND p_dir = 'desc' THEN lower(s.name) END COLLATE "C" DESC,
             CASE WHEN p_sort = 'lastSync' AND p_dir = 'asc'  THEN coalesce(s.last_sync_at, 'epoch'::timestamptz) END ASC,
             CASE WHEN p_sort = 'lastSync' AND p_dir = 'desc' THEN coalesce(s.last_sync_at, 'epoch'::timestamptz) END DESC,
             CASE WHEN p_sort = 'status'   AND p_dir = 'asc'  THEN s.status END COLLATE "C" ASC,
             CASE WHEN p_sort = 'status'   AND p_dir = 'desc' THEN s.status END COLLATE "C" DESC,
             s.id ASC) AS ord
    FROM stores s
    WHERE (p_status IS NULL OR s.status = p_status)
      AND (p_kind IS NULL OR s.kind = p_kind)
      AND (p_no_sync_days IS NULL OR s.last_sync_at IS NULL OR s.last_sync_at < now() - make_interval(days => p_no_sync_days))
      AND (v_pat IS NULL OR s.name ILIKE v_pat OR s.id::text ILIKE v_pat
           OR EXISTS (SELECT 1 FROM users u WHERE u.store_id = s.id AND u.phone = btrim(p_q)))
  ), page AS (
    SELECT * FROM base WHERE base.ord > p_offset AND base.ord <= p_offset + p_limit
  )
  SELECT pg.sid, pg.sname, pg.skind,
         o.name, CASE WHEN o.phone IS NULL THEN NULL ELSE admin_mask_phone(o.phone) END,
         pg.screated, pg.sstatus, pg.sgrand, pg.strial, pg.ssync,
         (SELECT count(*)::integer FROM sync_devices d WHERE d.store_id = pg.sid),
         (SELECT count(*)::integer FROM users u WHERE u.store_id = pg.sid AND u.role = 'staff'),
         pg.total_rows
  FROM page pg
  LEFT JOIN LATERAL (SELECT u.name, u.phone FROM users u WHERE u.store_id = pg.sid AND u.role = 'owner' ORDER BY u.created_at, u.id LIMIT 1) o ON true
  ORDER BY pg.ord;
END $$;

-- 3c) tenant detail pieces (each small and typed; the API assembles them)
CREATE FUNCTION admin_tenant_get(p_store uuid) RETURNS TABLE (
  id uuid, name text, kind text, address text, created_at timestamptz, status text, grandfathered boolean, trial_ends_at timestamptz,
  read_only_since timestamptz, status_message text, status_changed_at timestamptz, last_sync_at timestamptz,
  owner_name text, owner_phone_masked text, device_count integer, staff_count integer, last_event_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.id, s.name, s.kind, s.address, s.created_at, s.status, s.grandfathered, s.trial_ends_at, s.read_only_since, s.status_message,
         s.status_changed_at, s.last_sync_at,
         o.name, CASE WHEN o.phone IS NULL THEN NULL ELSE admin_mask_phone(o.phone) END,
         (SELECT count(*)::integer FROM sync_devices d WHERE d.store_id = s.id),
         (SELECT count(*)::integer FROM users u WHERE u.store_id = s.id AND u.role = 'staff'),
         (SELECT e.created_at FROM sync_events e WHERE e.store_id = s.id ORDER BY e.seq DESC LIMIT 1)   -- timestamp only, never the payload
  FROM stores s
  LEFT JOIN LATERAL (SELECT u.name, u.phone FROM users u WHERE u.store_id = s.id AND u.role = 'owner' ORDER BY u.created_at, u.id LIMIT 1) o ON true
  WHERE s.id = p_store
$$;

CREATE FUNCTION admin_tenant_staff(p_store uuid) RETURNS TABLE (name text, phone_masked text, role text, active boolean, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.name, admin_mask_phone(u.phone), u.role, u.active, u.created_at   -- NOT password_hash, NOT the full phone
  FROM users u WHERE u.store_id = p_store ORDER BY u.role, u.created_at, u.id
$$;

CREATE FUNCTION admin_tenant_devices(p_store uuid) RETURNS TABLE (code text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT d.code::text, d.created_at FROM sync_devices d WHERE d.store_id = p_store ORDER BY d.code   -- NOT device_id
$$;

CREATE FUNCTION admin_tenant_status_history(p_store uuid) RETURNS TABLE (
  at timestamptz, from_status text, to_status text, admin_name text, reason text, message text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT e.at, e.from_status, e.to_status, a.name, e.reason, e.message
  FROM tenant_status_events e LEFT JOIN platform_admins a ON a.id = e.admin_id
  WHERE e.store_id = p_store ORDER BY e.id DESC LIMIT 50
$$;

-- recent client errors of this tenant: fingerprint, kind, message (<= 500 chars), count, time, version. NOT the stack, path or user agent.
CREATE FUNCTION admin_tenant_errors(p_store uuid) RETURNS TABLE (
  fingerprint text, kind text, message text, count integer, last_at timestamptz, app_version text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.fingerprint, c.kind, c.message, c.count, c.last_at, c.app_version
  FROM client_errors c WHERE c.store_id = p_store ORDER BY c.last_at DESC LIMIT 20
$$;

-- the audited reveal (the route writes the audit row). Raises tenant_not_found for an unknown store.
CREATE FUNCTION admin_tenant_phones(p_store uuid) RETURNS TABLE (name text, role text, phone text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM stores s WHERE s.id = p_store) THEN RAISE EXCEPTION 'tenant_not_found' USING ERRCODE = 'P0001'; END IF;
  RETURN QUERY SELECT u.name, u.role, u.phone FROM users u WHERE u.store_id = p_store ORDER BY u.role, u.created_at, u.id;
END $$;

-- 3d) status change. ONE transaction: row lock -> transition check -> update -> owner-visible event. The audit row is written by the
-- API right after (same trade-off as A0, ADR 0005: the action and its audit row are two statements until the A3 redesign).
-- Transitions mirror src/domain/tenant-admin.ts nextStatus (a parity test runs both).
CREATE FUNCTION admin_tenant_set_status(p_store uuid, p_action text, p_admin uuid, p_reason text, p_message text)
RETURNS TABLE (from_status text, to_status text, changed_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET lock_timeout = '3s' AS $$
DECLARE v_from text; v_trial timestamptz; v_to text; v_msg text;
BEGIN
  SELECT s.status, s.trial_ends_at INTO v_from, v_trial FROM stores s WHERE s.id = p_store FOR NO KEY UPDATE; -- not FOR UPDATE: shop inserts hold FOR KEY SHARE (FK to stores) and must not queue behind an admin action
  IF NOT FOUND THEN RAISE EXCEPTION 'tenant_not_found' USING ERRCODE = 'P0001'; END IF;
  v_to := CASE p_action
    WHEN 'suspend'    THEN CASE WHEN v_from IN ('trial', 'active', 'grace', 'read_only', 'cancelled') THEN 'suspended' END
    WHEN 'read_only'  THEN CASE WHEN v_from IN ('trial', 'active', 'grace') THEN 'read_only' END
    WHEN 'reactivate' THEN CASE WHEN v_from IN ('suspended', 'read_only')
                                THEN CASE WHEN v_trial IS NOT NULL AND v_trial > now() THEN 'trial' ELSE 'active' END END
    ELSE NULL END;
  IF v_to IS NULL THEN RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'P0001'; END IF;
  v_msg := CASE WHEN p_action = 'reactivate' THEN NULL ELSE p_message END;
  UPDATE stores SET status = v_to, status_message = v_msg, status_changed_at = now(),
                    read_only_since = CASE WHEN v_to = 'read_only' THEN now() ELSE NULL END
   WHERE id = p_store;
  INSERT INTO tenant_status_events (store_id, from_status, to_status, admin_id, reason, message)
    VALUES (p_store, v_from, v_to, p_admin, p_reason, v_msg);
  RETURN QUERY SELECT v_from, v_to, now();
END $$;

-- 3e) notes
CREATE FUNCTION admin_tenant_notes(p_store uuid) RETURNS TABLE (id bigint, at timestamptz, admin_name text, body text, tags text[])
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM stores s WHERE s.id = p_store) THEN RAISE EXCEPTION 'tenant_not_found' USING ERRCODE = 'P0001'; END IF;
  RETURN QUERY SELECT n.id, n.created_at, a.name, n.body, n.tags
               FROM tenant_notes n LEFT JOIN platform_admins a ON a.id = n.admin_id
               WHERE n.store_id = p_store ORDER BY n.id DESC LIMIT 200;
END $$;

CREATE FUNCTION admin_tenant_note_add(p_store uuid, p_admin uuid, p_body text, p_tags text[])
RETURNS TABLE (id bigint, at timestamptz, admin_name text, body text, tags text[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM stores s WHERE s.id = p_store) THEN RAISE EXCEPTION 'tenant_not_found' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO tenant_notes (store_id, admin_id, body, tags) VALUES (p_store, p_admin, p_body, coalesce(p_tags, '{}')) RETURNING tenant_notes.id INTO v_id;
  RETURN QUERY SELECT n.id, n.created_at, a.name, n.body, n.tags
               FROM tenant_notes n LEFT JOIN platform_admins a ON a.id = n.admin_id WHERE n.id = v_id;
END $$;

-- 3f) audit viewer: newest first, keyset by id. The caller asks for limit + 1 rows to learn whether another page exists.
-- `ua` is not returned (it is only evidence for incident response, not for browsing).
CREATE FUNCTION admin_audit_list(
  p_action text, p_outcome text, p_admin uuid, p_store uuid, p_from timestamptz, p_to timestamptz, p_before bigint, p_limit integer
) RETURNS TABLE (
  id bigint, at timestamptz, admin_id uuid, admin_name text, actor text, action text, outcome text, target_type text, target_id text,
  store_id uuid, reason text, before jsonb, after jsonb, ip text, request_id text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_limit < 1 OR p_limit > 201 THEN RAISE EXCEPTION 'invalid_page' USING ERRCODE = 'P0001'; END IF;
  RETURN QUERY
  SELECT l.id, l.at, l.admin_id, a.name, l.actor, l.action, l.outcome, l.target_type, l.target_id, l.store_id, l.reason, l.before, l.after, l.ip, l.request_id
  FROM admin_audit_log l LEFT JOIN platform_admins a ON a.id = l.admin_id
  WHERE (p_action IS NULL OR l.action = p_action)
    AND (p_outcome IS NULL OR l.outcome = p_outcome)
    AND (p_admin IS NULL OR l.admin_id = p_admin)
    AND (p_store IS NULL OR l.store_id = p_store)
    AND (p_from IS NULL OR l.at >= p_from)
    AND (p_to IS NULL OR l.at < p_to)
    AND (p_before IS NULL OR l.id < p_before)
  ORDER BY l.id DESC LIMIT p_limit;
END $$;

-- 3g) the shop API's only write for "last sync": bound to the caller's own store (app.store_id), at most once per 5 minutes
CREATE FUNCTION sync_touch_store() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE stores SET last_sync_at = now()
   WHERE id = app_store_id() AND (last_sync_at IS NULL OR last_sync_at < now() - interval '5 minutes')
$$;

-- ---------------------------------------------------------------- 4) grants
DO $$
DECLARE r text; f record;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON tenant_notes, tenant_status_events FROM %I', r);
    END IF;
  END LOOP;
  REVOKE ALL ON tenant_notes, tenant_status_events FROM pos_app;
  -- the shop's account-activity list: its own rows (RLS), and NOT the internal `reason` / admin id columns
  GRANT SELECT (id, store_id, at, to_status, message) ON tenant_status_events TO pos_app;

  -- admin functions: PUBLIC and every other role out, admin_app in (same loop as 012; idempotent for the 012 functions)
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

  -- the shop-side touch: pos_app only
  REVOKE ALL ON FUNCTION sync_touch_store() FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'admin_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION sync_touch_store() FROM %I', r);
    END IF;
  END LOOP;
  GRANT EXECUTE ON FUNCTION sync_touch_store() TO pos_app;
END $$;

-- self-record (same reason as 012)
INSERT INTO schema_migrations (name) VALUES ('013_admin_tenant_ops.sql') ON CONFLICT DO NOTHING;

COMMIT;
