-- 015: Platform Admin Panel, phase A3 "manual billing" (docs/ADMIN_PANEL_PRD.md §8, §14; acceptance 5).
-- ADDITIVE. The shop API does not call anything here, so there is no rollout-order hazard for shops (like 014). Needs 012, 013, 014 first.
-- Rollback: db/rollback/015_down.sql (never run by db-migrate).
--
-- What it adds
--   * plans                    three placeholder plans (BDT 499 / 1,199 / 2,499; PRD Q2 is still open). A price change applies to NEW periods only.
--   * stores.current_period_end  end of the paid period that is running (or ran last); NULL = never paid. Recomputed on void.
--   * stores.plan_id FK        (the column exists since 012)
--   * subscription_payments                 one payment = one 30-day period. Never deleted: a mistake is VOIDED (voided_at / void_reason), so the record stays.
--   * subscription_events      payment / void / trial-extension history shown in the tenant billing panel
--   * admin_billing_* / admin_plan_* / admin_payment_* / admin_trial_extend   SECURITY DEFINER functions: the only way admin_app touches billing
--
-- Money is integer poisha (bigint). Revenue numbers (MRR, collected, voided) are computed from the payment rows only, so they reconcile with them.
-- Same TRUST BOUNDARY as 012 / ADR 0001: the functions do not re-authorize their caller; the app layer is the control.
-- Admin code never mutates shop business data: the only stores columns written here are status, status_message, status_changed_at,
-- read_only_since, grandfathered, plan_id, current_period_end, trial_ends_at (account/billing state, not sales/stock/customers).
BEGIN;

SET LOCAL lock_timeout = '5s';   -- ALTER TABLE stores takes ACCESS EXCLUSIVE: fail fast rather than queue every shop request

-- ---------------------------------------------------------------- 1) tables
CREATE TABLE plans (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE CHECK (code ~ '^[a-z_]{1,30}$'),
  name          text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  price_poisha  bigint NOT NULL CHECK (price_poisha BETWEEN 0 AND 100000000),
  limits        jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(limits) = 'object'),
  features      jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(features) = 'object'),
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
-- fixed ids: the in-memory repo (src/db/memory-admin.ts) seeds the same rows
INSERT INTO plans (id, code, name, price_poisha, limits, features) VALUES
  ('00000000-0000-4000-8000-000000000a01', 'starter',  'Starter',  49900,  '{"devices":1,"staff":1}',  '{"reports":false,"multi_device":false}'),
  ('00000000-0000-4000-8000-000000000a02', 'growth',   'Growth',   119900, '{"devices":2,"staff":3}',  '{"reports":true,"multi_device":false}'),
  ('00000000-0000-4000-8000-000000000a03', 'business', 'Business', 249900, '{"devices":5,"staff":10}', '{"reports":true,"multi_device":true}');

ALTER TABLE stores ADD COLUMN current_period_end timestamptz;   -- nullable, no default: metadata-only
ALTER TABLE stores ADD CONSTRAINT stores_plan_fk FOREIGN KEY (plan_id) REFERENCES plans(id) NOT VALID;   -- NOT VALID + VALIDATE: the scan runs under a lock that does not block shop writes
ALTER TABLE stores VALIDATE CONSTRAINT stores_plan_fk;
CREATE INDEX stores_plan_idx ON stores (plan_id) WHERE plan_id IS NOT NULL;

CREATE TABLE subscription_payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id        uuid NOT NULL REFERENCES stores(id),            -- no cascade: a financial record never disappears with a shop
  plan_id         uuid REFERENCES plans(id),
  amount_poisha   bigint NOT NULL CHECK (amount_poisha > 0 AND amount_poisha <= 100000000),
  method          text NOT NULL CHECK (method IN ('bkash', 'nagad', 'rocket', 'bank', 'cash')),
  txn_ref         text CHECK (txn_ref IS NULL OR length(btrim(txn_ref)) BETWEEN 1 AND 60),
  paid_at         timestamptz NOT NULL,
  period_start    timestamptz NOT NULL,
  period_end      timestamptz NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  recorded_by     uuid REFERENCES platform_admins(id),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{8,64}$'),
  request_sig     text NOT NULL,
  voided_at       timestamptz,
  voided_by       uuid REFERENCES platform_admins(id),
  void_reason     text CHECK (void_reason IS NULL OR length(btrim(void_reason)) BETWEEN 1 AND 1000),
  CONSTRAINT subpay_period_ok CHECK (period_end > period_start),
  CONSTRAINT subpay_txn_required CHECK (method = 'cash' OR txn_ref IS NOT NULL),
  CONSTRAINT subpay_void_pair CHECK ((voided_at IS NULL) = (void_reason IS NULL)),
  CONSTRAINT subpay_idem_unique UNIQUE (store_id, idempotency_key)
);
-- the same bKash/Nagad/Rocket/bank reference cannot be recorded twice while the first is not voided (also closes the race across shops)
CREATE UNIQUE INDEX subpay_txn_unique ON subscription_payments (method, txn_ref) WHERE voided_at IS NULL AND txn_ref IS NOT NULL;
CREATE INDEX subpay_store_idx ON subscription_payments (store_id, recorded_at DESC, id DESC);
CREATE INDEX subpay_paid_idx ON subscription_payments (paid_at) WHERE voided_at IS NULL;
CREATE INDEX subpay_voided_idx ON subscription_payments (voided_at) WHERE voided_at IS NOT NULL;
CREATE INDEX subpay_plan_idx ON subscription_payments (plan_id);

CREATE TABLE subscription_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id    uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  at          timestamptz NOT NULL DEFAULT now(),
  from_status text,
  to_status   text NOT NULL,
  actor       text NOT NULL DEFAULT 'admin' CHECK (actor IN ('admin', 'system')),
  admin_id    uuid REFERENCES platform_admins(id),
  reason      text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1100)
);
CREATE INDEX subscription_events_store_idx ON subscription_events (store_id, id DESC);

-- no policy and no grant: invisible to pos_app (the shop never reads billing rows in A3)
ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_events ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------- 2) functions
-- Error codes are RAISEd as the message with ERRCODE P0001; src/db/pg-admin.ts maps them to DomainError codes.

CREATE FUNCTION admin_plans_list() RETURNS TABLE (id uuid, code text, name text, price_poisha bigint, limits jsonb, features jsonb, active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p.id, p.code, p.name, p.price_poisha, p.limits, p.features, p.active FROM plans p ORDER BY p.price_poisha, p.id
$$;

-- before/after as camelCase json (the shape of the API's Plan); limits and features are MERGED key by key
CREATE FUNCTION admin_plan_update(p_id uuid, p_name text, p_price bigint, p_active boolean, p_limits jsonb, p_features jsonb)
RETURNS TABLE (before jsonb, after jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET lock_timeout = '3s' AS $$
DECLARE b plans%ROWTYPE; a plans%ROWTYPE;
BEGIN
  SELECT * INTO b FROM plans WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'plan_not_found' USING ERRCODE = 'P0001'; END IF;
  UPDATE plans SET name = coalesce(p_name, name), price_poisha = coalesce(p_price, price_poisha), active = coalesce(p_active, active),
                   limits = limits || coalesce(p_limits, '{}'::jsonb), features = features || coalesce(p_features, '{}'::jsonb), updated_at = now()
   WHERE id = p_id RETURNING * INTO a;
  RETURN QUERY SELECT
    jsonb_build_object('id', b.id, 'code', b.code, 'name', b.name, 'pricePoisha', b.price_poisha, 'limits', b.limits, 'features', b.features, 'active', b.active),
    jsonb_build_object('id', a.id, 'code', a.code, 'name', a.name, 'pricePoisha', a.price_poisha, 'limits', a.limits, 'features', a.features, 'active', a.active);
END $$;

CREATE FUNCTION admin_billing_header(p_store uuid)
RETURNS TABLE (status text, grandfathered boolean, trial_ends_at timestamptz, current_period_end timestamptz, plan jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN QUERY
  SELECT s.status, s.grandfathered, s.trial_ends_at, s.current_period_end,
         CASE WHEN p.id IS NULL THEN NULL ELSE jsonb_build_object('id', p.id, 'code', p.code, 'name', p.name, 'pricePoisha', p.price_poisha,
                                                                  'limits', p.limits, 'features', p.features, 'active', p.active) END
  FROM stores s LEFT JOIN plans p ON p.id = s.plan_id WHERE s.id = p_store;
  IF NOT FOUND THEN RAISE EXCEPTION 'tenant_not_found' USING ERRCODE = 'P0001'; END IF;
END $$;

CREATE FUNCTION admin_billing_payments(p_store uuid)
RETURNS TABLE (id uuid, store_id uuid, plan_id uuid, amount_poisha bigint, method text, txn_ref text, paid_at timestamptz, period_start timestamptz,
               period_end timestamptz, recorded_at timestamptz, recorded_by_name text, voided_at timestamptz, void_reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p.id, p.store_id, p.plan_id, p.amount_poisha, p.method, p.txn_ref, p.paid_at, p.period_start, p.period_end, p.recorded_at, a.name, p.voided_at, p.void_reason
  FROM subscription_payments p LEFT JOIN platform_admins a ON a.id = p.recorded_by
  WHERE p.store_id = p_store ORDER BY p.recorded_at DESC, p.id DESC LIMIT 200
$$;

CREATE FUNCTION admin_payment_get(p_payment uuid)
RETURNS TABLE (id uuid, store_id uuid, plan_id uuid, amount_poisha bigint, method text, txn_ref text, paid_at timestamptz, period_start timestamptz,
               period_end timestamptz, recorded_at timestamptz, recorded_by_name text, voided_at timestamptz, void_reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN QUERY
  SELECT p.id, p.store_id, p.plan_id, p.amount_poisha, p.method, p.txn_ref, p.paid_at, p.period_start, p.period_end, p.recorded_at, a.name, p.voided_at, p.void_reason
  FROM subscription_payments p LEFT JOIN platform_admins a ON a.id = p.recorded_by WHERE p.id = p_payment;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment_not_found' USING ERRCODE = 'P0001'; END IF;
END $$;

CREATE FUNCTION admin_billing_events(p_store uuid)
RETURNS TABLE (at timestamptz, from_status text, to_status text, actor text, admin_name text, reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT e.at, e.from_status, e.to_status, e.actor, a.name, e.reason
  FROM subscription_events e LEFT JOIN platform_admins a ON a.id = e.admin_id
  WHERE e.store_id = p_store ORDER BY e.id DESC LIMIT 200
$$;

-- Record one payment. One payment = one 30-day period, starting when the running period ends (early payers lose no days) or at paid_at.
-- trial / grace / active / cancelled become `active`; suspended / read_only / pending_deletion keep their status (an admin reactivates them separately); deleted is refused. Everything below runs under the shop's row lock, so two operators cannot interleave.
-- Order of checks mirrors src/db/memory-admin.ts.
CREATE FUNCTION admin_payment_record(
  p_store uuid, p_key text, p_amount bigint, p_method text, p_txn text, p_paid_at timestamptz, p_plan uuid, p_admin uuid
) RETURNS TABLE (payment_id uuid, replayed boolean, from_status text, to_status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET lock_timeout = '3s' AS $$
DECLARE
  v_status text; v_plan_of_store uuid; v_cpe timestamptz;
  v_sig text; v_prior_id uuid; v_prior_sig text;
  v_plan uuid; v_price bigint; v_active boolean;
  v_paid timestamptz; v_start timestamptz; v_end timestamptz; v_id uuid; v_txn text; v_to text;
BEGIN
  SELECT s.status, s.plan_id, s.current_period_end INTO v_status, v_plan_of_store, v_cpe FROM stores s WHERE s.id = p_store FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tenant_not_found' USING ERRCODE = 'P0001'; END IF;
  -- malformed input is a clean 400, never a raw CHECK/NOT NULL violation
  IF p_admin IS NULL OR NOT EXISTS (SELECT 1 FROM platform_admins a WHERE a.id = p_admin AND a.active)
     OR p_key IS NULL OR p_key !~ '^[A-Za-z0-9_-]{8,64}$' OR p_method IS NULL OR p_method NOT IN ('bkash', 'nagad', 'rocket', 'bank', 'cash')
     OR length(coalesce(p_txn, '')) > 60 THEN
    RAISE EXCEPTION 'invalid_input' USING ERRCODE = 'P0001';
  END IF;
  v_txn := nullif(upper(btrim(p_txn)), '');   -- one spelling per transaction reference

  -- stable across session settings: the instant as epoch, the fields as a JSON array (no delimiter ambiguity)
  v_sig := encode(sha256(convert_to(jsonb_build_array(p_amount, p_method, v_txn, extract(epoch FROM p_paid_at), p_plan)::text, 'UTF8')), 'hex');
  SELECT p.id, p.request_sig INTO v_prior_id, v_prior_sig FROM subscription_payments p WHERE p.store_id = p_store AND p.idempotency_key = p_key;
  IF FOUND THEN
    IF v_prior_sig <> v_sig THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = 'P0001'; END IF;
    RETURN QUERY SELECT v_prior_id, true, v_status, v_status;
    RETURN;
  END IF;

  v_plan := coalesce(p_plan, v_plan_of_store, '00000000-0000-4000-8000-000000000a03'::uuid);
  SELECT pl.price_poisha, pl.active INTO v_price, v_active FROM plans pl WHERE pl.id = v_plan;
  IF NOT FOUND THEN RAISE EXCEPTION 'plan_not_found' USING ERRCODE = 'P0001'; END IF;
  IF NOT v_active THEN RAISE EXCEPTION 'plan_inactive' USING ERRCODE = 'P0001'; END IF;
  IF p_method <> 'cash' AND v_txn IS NULL THEN RAISE EXCEPTION 'txn_ref_required' USING ERRCODE = 'P0001'; END IF;
  v_paid := coalesce(p_paid_at, now());
  IF v_paid > now() THEN RAISE EXCEPTION 'paid_in_future' USING ERRCODE = 'P0001'; END IF;
  IF v_paid < now() - interval '720 hours' THEN RAISE EXCEPTION 'paid_too_old' USING ERRCODE = 'P0001'; END IF;   -- at most one period back
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount > 100000000 THEN RAISE EXCEPTION 'invalid_amount' USING ERRCODE = 'P0001'; END IF;
  IF p_amount < v_price THEN RAISE EXCEPTION 'amount_below_price' USING ERRCODE = 'P0001'; END IF;
  IF v_txn IS NOT NULL AND EXISTS (SELECT 1 FROM subscription_payments p WHERE p.method = p_method AND p.txn_ref = v_txn AND p.voided_at IS NULL) THEN
    RAISE EXCEPTION 'duplicate_txn' USING ERRCODE = 'P0001';
  END IF;
  IF v_status NOT IN ('trial', 'active', 'grace', 'read_only', 'suspended', 'pending_deletion', 'cancelled') THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'P0001';
  END IF;

  -- a payment records the money; it lifts trial / grace / active / cancelled to active but NEVER an admin-held status (an admin reactivates those separately)
  v_to := CASE WHEN v_status IN ('read_only', 'suspended', 'pending_deletion') THEN v_status ELSE 'active' END;
  v_start := CASE WHEN v_cpe IS NOT NULL AND v_cpe > v_paid THEN v_cpe ELSE v_paid END;
  v_end := v_start + interval '720 hours';   -- 30 x 24h exactly, whatever the session time zone
  INSERT INTO subscription_payments (store_id, plan_id, amount_poisha, method, txn_ref, paid_at, period_start, period_end, recorded_by, idempotency_key, request_sig)
    VALUES (p_store, v_plan, p_amount, p_method, v_txn, v_paid, v_start, v_end, p_admin, p_key, v_sig) RETURNING id INTO v_id;
  UPDATE stores SET status = v_to, grandfathered = false, plan_id = v_plan, current_period_end = v_end,
                    status_message = CASE WHEN v_status <> v_to THEN NULL ELSE status_message END,
                    read_only_since = CASE WHEN v_status <> v_to THEN NULL ELSE read_only_since END,
                    status_changed_at = CASE WHEN v_status <> v_to THEN now() ELSE status_changed_at END
   WHERE id = p_store;
  IF v_status <> v_to THEN
    INSERT INTO tenant_status_events (store_id, from_status, to_status, admin_id, reason, message) VALUES (p_store, v_status, v_to, p_admin, 'Payment recorded', NULL);
  END IF;
  INSERT INTO subscription_events (store_id, from_status, to_status, admin_id, reason) VALUES (p_store, v_status, v_to, p_admin, 'Payment recorded');
  RETURN QUERY SELECT v_id, false, v_status, v_to;
END $$;

-- Void never deletes. It does NOT change the shop's status; it only recomputes the paid-until date from the subscription_payments that remain.
CREATE FUNCTION admin_payment_void(p_payment uuid, p_reason text, p_admin uuid) RETURNS TABLE (store_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET lock_timeout = '3s' AS $$
DECLARE v_store uuid; v_status text; v_voided timestamptz; v_paid_at timestamptz; v_end timestamptz; r record;
BEGIN
  SELECT p.store_id INTO v_store FROM subscription_payments p WHERE p.id = p_payment;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment_not_found' USING ERRCODE = 'P0001'; END IF;
  IF p_admin IS NULL OR NOT EXISTS (SELECT 1 FROM platform_admins a WHERE a.id = p_admin AND a.active)
     OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 1000 THEN
    RAISE EXCEPTION 'invalid_input' USING ERRCODE = 'P0001';
  END IF;
  SELECT s.status INTO v_status FROM stores s WHERE s.id = v_store FOR NO KEY UPDATE;   -- same lock order as admin_payment_record
  SELECT p.voided_at, p.paid_at INTO v_voided, v_paid_at FROM subscription_payments p WHERE p.id = p_payment FOR UPDATE;
  IF v_voided IS NOT NULL THEN RAISE EXCEPTION 'payment_already_voided' USING ERRCODE = 'P0001'; END IF;
  UPDATE subscription_payments SET voided_at = now(), voided_by = p_admin, void_reason = p_reason WHERE id = p_payment;
  -- replay the chain of the remaining payments in recorded order (mirrors src/domain/billing.ts paidUntilAfterVoid): no free gap when an earlier one is voided;
  -- with none left the voided payment's own paid_at is used, so the shop is overdue from then instead of undated
  v_end := NULL;
  FOR r IN SELECT p.paid_at FROM subscription_payments p WHERE p.store_id = v_store AND p.voided_at IS NULL ORDER BY p.recorded_at, p.id LOOP
    v_end := (CASE WHEN v_end IS NOT NULL AND v_end > r.paid_at THEN v_end ELSE r.paid_at END) + interval '720 hours';
  END LOOP;
  UPDATE stores SET current_period_end = coalesce(v_end, v_paid_at) WHERE id = v_store;
  INSERT INTO subscription_events (store_id, from_status, to_status, admin_id, reason) VALUES (v_store, v_status, v_status, p_admin, 'Payment voided: ' || p_reason);
  RETURN QUERY SELECT v_store;
END $$;

-- Only a shop in `trial`; 1..30 days; never later than now + 60 days.
CREATE FUNCTION admin_trial_extend(p_store uuid, p_days integer, p_reason text, p_admin uuid) RETURNS TABLE (trial_ends_at timestamptz, status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET lock_timeout = '3s' AS $$
DECLARE v_status text; v_trial timestamptz; v_next timestamptz;
BEGIN
  SELECT s.status, s.trial_ends_at INTO v_status, v_trial FROM stores s WHERE s.id = p_store FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tenant_not_found' USING ERRCODE = 'P0001'; END IF;
  IF p_days IS NULL OR p_days < 1 OR p_days > 30 OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 1000
     OR p_admin IS NULL OR NOT EXISTS (SELECT 1 FROM platform_admins a WHERE a.id = p_admin AND a.active) THEN
    RAISE EXCEPTION 'invalid_input' USING ERRCODE = 'P0001';
  END IF;
  IF v_status <> 'trial' THEN RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'P0001'; END IF;
  v_next := CASE WHEN v_trial IS NOT NULL AND v_trial > now() THEN v_trial ELSE now() END + p_days * interval '24 hours';
  IF v_next > now() + interval '1440 hours' THEN RAISE EXCEPTION 'trial_cap' USING ERRCODE = 'P0001'; END IF;
  UPDATE stores SET trial_ends_at = v_next WHERE id = p_store;
  INSERT INTO subscription_events (store_id, from_status, to_status, admin_id, reason)
    VALUES (p_store, v_status, v_status, p_admin, 'Trial extended by ' || p_days || ' days: ' || p_reason);
  RETURN QUERY SELECT v_next, v_status;
END $$;

-- Revenue overview, computed from payment rows and shop statuses only. "This month" is the Asia/Dhaka calendar month.
-- Overdue: not grandfathered, not deleted/cancelled, past its due date by at least one whole day (due = trial end for a trial, else period end).
CREATE FUNCTION admin_billing_overview() RETURNS TABLE (
  mrr_poisha bigint, collected_poisha bigint, payments_month integer, voided_poisha bigint, grandfathered integer,
  by_status jsonb, trials jsonb, overdue jsonb, overdue_total integer
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE m_start timestamptz; m_end timestamptz;
BEGIN
  m_start := date_trunc('month', now() AT TIME ZONE 'Asia/Dhaka') AT TIME ZONE 'Asia/Dhaka';
  m_end := (date_trunc('month', now() AT TIME ZONE 'Asia/Dhaka') + interval '1 month') AT TIME ZONE 'Asia/Dhaka';
  RETURN QUERY
  WITH live AS (SELECT * FROM subscription_payments WHERE voided_at IS NULL),
  due AS (
    SELECT s.id, s.name, s.status,
           CASE WHEN s.status = 'trial' THEN s.trial_ends_at ELSE s.current_period_end END AS due_at
    FROM stores s WHERE NOT s.grandfathered AND s.status NOT IN ('deleted', 'cancelled')
  ),
  late AS (
    SELECT d.id, d.name, d.status, d.due_at, floor(extract(epoch FROM now() - d.due_at) / 86400)::integer AS days
    FROM due d WHERE d.due_at IS NOT NULL AND now() - d.due_at >= interval '24 hours'
  )
  SELECT
    coalesce((SELECT sum(l.amount_poisha) FROM live l WHERE l.period_start <= now() AND now() < l.period_end), 0)::bigint,
    coalesce((SELECT sum(l.amount_poisha) FROM live l WHERE l.paid_at >= m_start AND l.paid_at < m_end), 0)::bigint,
    (SELECT count(*) FROM live l WHERE l.paid_at >= m_start AND l.paid_at < m_end)::integer,
    coalesce((SELECT sum(p.amount_poisha) FROM subscription_payments p WHERE p.voided_at >= m_start AND p.voided_at < m_end), 0)::bigint,
    (SELECT count(*) FROM stores s WHERE s.grandfathered)::integer,
    coalesce((SELECT jsonb_object_agg(x.status, x.n) FROM (SELECT s.status, count(*) AS n FROM stores s GROUP BY s.status) x), '{}'::jsonb),
    coalesce((SELECT jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'trialEndsAt', t.trial_ends_at) ORDER BY t.trial_ends_at, t.id)
              FROM (SELECT s.id, s.name, s.trial_ends_at FROM stores s
                     WHERE s.status = 'trial' AND s.trial_ends_at >= now() AND s.trial_ends_at < now() + interval '168 hours'
                     ORDER BY s.trial_ends_at, s.id LIMIT 50) t), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'status', o.status, 'dueAt', o.due_at, 'daysOverdue', o.days) ORDER BY o.days DESC, o.id)
              FROM (SELECT * FROM late ORDER BY days DESC, id LIMIT 50) o), '[]'::jsonb),
    (SELECT count(*) FROM late)::integer;
END $$;

-- ---------------------------------------------------------------- 3) grants (same loop as 013 / 014, idempotent for earlier admin_* functions)
DO $$
DECLARE r text; f record;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON plans, subscription_payments, subscription_events FROM %I', r);
    END IF;
  END LOOP;
  REVOKE ALL ON plans, subscription_payments, subscription_events FROM PUBLIC;
  REVOKE ALL ON plans, subscription_payments, subscription_events FROM pos_app;

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

-- self-record (same reason as 012 / 013 / 014)
INSERT INTO schema_migrations (name) VALUES ('015_admin_billing.sql') ON CONFLICT DO NOTHING;

COMMIT;
