-- ০০৯: সিংক প্রজেক্টরের জন্য
--   ১) ইভেন্টে কে করেছে তার শুধু নাম থাকে (user id নয়): বিলের ক্যাশিয়ার, বাতিলকারী, খাতার এন্ট্রি, ব্যাচ সরানোর নাম আলাদা কলামে
--   ২) অন্য ডিভাইস থেকে আসা একই পণ্য+ব্যাচ নম্বর+মেয়াদ আলাদা ব্যাচ-id নিয়ে আসতে পারে (ফোনে দুটিই আলাদা ব্যাচ);
--      তাই stock_batches_merge_uq ইউনিক নয়, সাধারণ ইনডেক্স (REST জমা এখনো পণ্য-লকের ভেতরে খুঁজে মেশায়)
--   ৩) projection_events: কোন ইভেন্ট কী অবস্থায় (applied/deferred/ignored/failed); projection_clocks: শেষ-বদল-জেতে ঘড়ি
-- সব বদল যোগাত্মক; পুরনো ডেটা অক্ষত।

BEGIN;

ALTER TABLE sales
  ADD COLUMN cashier_name    text CHECK (cashier_name IS NULL OR length(btrim(cashier_name)) BETWEEN 1 AND 120),
  ADD COLUMN voided_by_name  text CHECK (voided_by_name IS NULL OR length(btrim(voided_by_name)) BETWEEN 1 AND 120);
ALTER TABLE sales DROP CONSTRAINT sales_void_chk;
ALTER TABLE sales ADD CONSTRAINT sales_void_chk CHECK (
  (voided AND voided_at IS NOT NULL AND (voided_by IS NOT NULL OR voided_by_name IS NOT NULL) AND length(btrim(void_reason)) > 0)
  OR (NOT voided AND voided_at IS NULL AND voided_by IS NULL AND voided_by_name IS NULL AND void_reason IS NULL)
);
GRANT UPDATE (voided_by_name) ON sales TO pos_app;

ALTER TABLE due_ledger
  ADD COLUMN by_name text CHECK (by_name IS NULL OR length(btrim(by_name)) BETWEEN 1 AND 120);

ALTER TABLE stock_batches
  ADD COLUMN removed_by_name text CHECK (removed_by_name IS NULL OR length(btrim(removed_by_name)) BETWEEN 1 AND 120);
ALTER TABLE stock_batches DROP CONSTRAINT stock_batches_removed_chk;
ALTER TABLE stock_batches ADD CONSTRAINT stock_batches_removed_chk CHECK (
  (removed_at IS NULL AND removed_by IS NULL AND removed_by_name IS NULL AND removed_reason IS NULL)
  OR (removed_at IS NOT NULL AND (removed_by IS NOT NULL OR removed_by_name IS NOT NULL) AND length(btrim(removed_reason)) > 0)
);
GRANT UPDATE (removed_by_name) ON stock_batches TO pos_app;

DROP INDEX stock_batches_merge_uq;
CREATE INDEX stock_batches_merge_idx ON stock_batches (store_id, product_id, batch_no, (coalesce(expiry_date, '9999-12-31'::date)))
  WHERE batch_no <> '' AND removed_at IS NULL;

CREATE TABLE projection_events (
  store_id   uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  event_id   uuid NOT NULL,
  status     text NOT NULL CHECK (status IN ('applied', 'deferred', 'ignored', 'failed')),
  detail     text,
  updated_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  PRIMARY KEY (store_id, event_id)
);
CREATE INDEX projection_events_open_idx ON projection_events (store_id) WHERE status = 'deferred';

CREATE TABLE projection_clocks (
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  key      text NOT NULL,
  stamp    text NOT NULL,
  PRIMARY KEY (store_id, key)
);

ALTER TABLE projection_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE projection_clocks ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON projection_events USING (store_id = app_store_id()) WITH CHECK (store_id = app_store_id());
CREATE POLICY tenant_isolation ON projection_clocks USING (store_id = app_store_id()) WITH CHECK (store_id = app_store_id());
GRANT SELECT, INSERT, UPDATE ON projection_events, projection_clocks TO pos_app;

-- প্রজেক্টর পণ্য/কাস্টমার বদলায় (REST-এ কাস্টমারের শুধু name/phone/address বদলানো যায়; পণ্যের গ্রান্ট 006-এ আছে)
COMMIT;
