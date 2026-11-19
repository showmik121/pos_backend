-- ০০৬: পণ্য ও স্টক-ব্যাচ REST API-র জন্য স্কিমা (ফ্রন্টএন্ডের Product/Batch মডেলের সাথে মেলানো)
--   ১) PK = (store_id, id): id ক্লায়েন্ট বানায়, তাই দুই দোকানে একই UUID এলে সংঘাত বা অস্তিত্ব-ফাঁস হয় না
--   ২) পণ্য: unit, is_open, updated_at, lww_clock; বারকোড আলাদা টেবিলে (একাধিক বারকোড, প্রতিটির pack_size)
--   ৩) ব্যাচ: batch_no NOT NULL, সরানোর তথ্য (removed_*), ঋণাত্মক স্টক অনুমোদিত (অফলাইন-বিক্রি পরে সার্ভারে এলে)
--   ৪) stock_movements.kind-এ 'removal'
-- নোট: পুরনো products.barcode / carton_barcode কলাম এখনো আছে, ০১০ (contract) মাইগ্রেশনে বাদ যাবে।
-- নোট: এই টেবিলগুলো এখনো কোনো API ব্যবহার করেনি; খালি না হলে নিচের guard থামিয়ে দেয় (ডেটা ব্যাকফিল আলাদা কাজ)।

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM products) OR EXISTS (SELECT 1 FROM stock_batches) OR EXISTS (SELECT 1 FROM stock_movements) THEN
    RAISE EXCEPTION '006: products/stock_batches/stock_movements খালি নয়; আগে ডেটা সরান বা ব্যাকফিল স্ক্রিপ্ট লিখুন';
  END IF;
END $$;

-- ---------------------------------------------------------------- ১) PK (store_id, id)
-- (store_id, id) UNIQUE আগে থেকেই আছে এবং FK-গুলো সেটিকে ধরে; তাই সেটি রেখে শুধু PK বদলানো হয়।
ALTER TABLE products DROP CONSTRAINT products_pkey, ADD PRIMARY KEY (store_id, id);
ALTER TABLE stock_batches DROP CONSTRAINT stock_batches_pkey, ADD PRIMARY KEY (store_id, id);
ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_pkey, ADD PRIMARY KEY (store_id, id);

-- ---------------------------------------------------------------- ২) পণ্য
ALTER TABLE products
  ADD COLUMN unit       text        NOT NULL DEFAULT 'piece' CHECK (unit IN ('piece', 'strip', 'box')),
  ADD COLUMN is_open    boolean     NOT NULL DEFAULT false,   -- বারকোড ছাড়া "খোলা" পণ্য
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN lww_clock  text;                                  -- শেষ-বদল-জেতে ঘড়ি "<at>|<eventId>" (সিংক প্রজেক্টরের জন্য)

CREATE TABLE product_barcodes (
  store_id   uuid    NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  code       text    NOT NULL CHECK (length(btrim(code)) BETWEEN 1 AND 64),
  product_id uuid    NOT NULL,
  pack_size  integer NOT NULL CHECK (pack_size > 0),           -- ১ = একটি পিস, ১০ = কার্টন
  PRIMARY KEY (store_id, code),
  FOREIGN KEY (store_id, product_id) REFERENCES products (store_id, id) ON DELETE CASCADE
);
CREATE INDEX product_barcodes_product_idx ON product_barcodes (store_id, product_id);

ALTER TABLE product_barcodes ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON product_barcodes
  USING (store_id = app_store_id()) WITH CHECK (store_id = app_store_id());
GRANT SELECT, INSERT, DELETE ON product_barcodes TO pos_app;   -- পণ্য সম্পাদনায় বারকোড বদলাতে DELETE লাগে

-- ---------------------------------------------------------------- ৩) ব্যাচ
ALTER TABLE stock_batches
  ALTER COLUMN batch_no SET DEFAULT '',
  ADD COLUMN removed_at     timestamptz,
  ADD COLUMN removed_by     uuid,
  ADD COLUMN removed_reason text,
  ADD CONSTRAINT stock_batches_removed_by_fk FOREIGN KEY (store_id, removed_by) REFERENCES users (store_id, id),
  ADD CONSTRAINT stock_batches_removed_chk CHECK (
    (removed_at IS NULL AND removed_by IS NULL AND removed_reason IS NULL)
    OR (removed_at IS NOT NULL AND removed_by IS NOT NULL AND length(btrim(removed_reason)) > 0)
  );
UPDATE stock_batches SET batch_no = '' WHERE batch_no IS NULL;
ALTER TABLE stock_batches ALTER COLUMN batch_no SET NOT NULL;

-- ফ্রন্টএন্ড ইচ্ছাকৃতভাবে ঋণাত্মক স্টক মেনে নেয় (দুই ফোনে একই ব্যাচ থেকে বিক্রি); অনলাইন API কঠোর থাকে অ্যাপ-কোডে।
ALTER TABLE stock_batches DROP CONSTRAINT stock_batches_qty_remaining_check;

-- একই পণ্য + ব্যাচ নম্বর + মেয়াদে স্টক-জমা একই ব্যাচে মেশে (ফ্রন্টএন্ডের stockIn নিয়ম); সরানো ব্যাচ বাদ
CREATE UNIQUE INDEX stock_batches_merge_uq ON stock_batches
  (store_id, product_id, batch_no, (coalesce(expiry_date, '9999-12-31'::date)))
  WHERE batch_no <> '' AND removed_at IS NULL;

DROP INDEX stock_batches_fifo_idx;
CREATE INDEX stock_batches_fifo_idx ON stock_batches
  (store_id, product_id, expiry_date NULLS LAST, received_at, id)
  WHERE qty_remaining > 0 AND removed_at IS NULL;
-- ঋণাত্মক ব্যাচ নজরদারি (oversold মেলাতে)
CREATE INDEX stock_batches_negative_idx ON stock_batches (store_id, product_id) WHERE qty_remaining < 0;

-- ব্যাচের শুধু স্টক, ক্রয়মূল্য ও সরানোর তথ্য বদলায়; বাকি কলাম অপরিবর্তনীয়
REVOKE UPDATE ON stock_batches FROM pos_app;
GRANT UPDATE (qty_remaining, cost_price_poisha, removed_at, removed_by, removed_reason) ON stock_batches TO pos_app;

-- ---------------------------------------------------------------- ৪) movements
ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_kind_check;
ALTER TABLE stock_movements
  ADD CONSTRAINT stock_movements_kind_check
  CHECK (kind IN ('purchase', 'sale', 'sale_return', 'adjustment', 'expired', 'removal'));

COMMIT;
