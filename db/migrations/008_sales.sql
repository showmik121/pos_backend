-- ০০৮: বিক্রি API-র জন্য স্কিমা (ফ্রন্টএন্ডের Sale/SaleLine/SaleAllocation মডেলের সাথে মেলানো)
--   ১) sales: PK (store_id, id); বিল নম্বর = (উপসর্গ, নম্বর) দোকান-ভিত্তিক ইউনিক (ডিভাইসভেদে A-১০০১, B-১০০১);
--      লাইন-ছাড়/বিল-ছাড় আলাদা, ফেরত (change), বিক্রির সময়, oversold চিহ্ন, অনুরোধের হ্যাশ (ইডেমপোটেন্সি), বাতিলের তথ্য
--   ২) sale_items = লাইন (পণ্য, নাম, ছাড়); কোন ব্যাচ থেকে কত পিস তা নতুন sale_allocations-এ
--   ৩) payments-এ ক্রম (seq)
-- নোট: এই টেবিলগুলো এখনো কোনো API ব্যবহার করেনি; খালি না হলে নিচের guard থামিয়ে দেয়। ০০৭ আগে লাগে।

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM sales) OR EXISTS (SELECT 1 FROM sale_items) OR EXISTS (SELECT 1 FROM payments)
     OR EXISTS (SELECT 1 FROM stock_movements WHERE kind IN ('sale', 'sale_return')) THEN
    RAISE EXCEPTION '008: sales/sale_items/payments খালি নয়; আগে ডেটা সরান বা ব্যাকফিল স্ক্রিপ্ট লিখুন';
  END IF;
END $$;

-- ---------------------------------------------------------------- ১) sales
ALTER TABLE sales DROP CONSTRAINT sales_pkey, ADD PRIMARY KEY (store_id, id);
ALTER TABLE sales DROP CONSTRAINT sales_store_id_bill_no_key;
ALTER TABLE sales
  ADD COLUMN bill_prefix           text   CHECK (bill_prefix IS NULL OR bill_prefix ~ '^[A-Z]$'),
  ADD COLUMN line_discount_poisha  bigint NOT NULL CHECK (line_discount_poisha >= 0),
  ADD COLUMN bill_discount_poisha  bigint NOT NULL CHECK (bill_discount_poisha >= 0),
  ADD COLUMN change_poisha         bigint NOT NULL DEFAULT 0 CHECK (change_poisha >= 0),
  ADD COLUMN sold_at               timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  ADD COLUMN oversold              boolean NOT NULL DEFAULT false,
  ADD COLUMN request_hash          text   NOT NULL,
  ADD COLUMN voided_at             timestamptz,
  ADD COLUMN voided_by             uuid,
  ADD COLUMN void_reason           text,
  ADD CONSTRAINT sales_discount_split_chk CHECK (discount_poisha = line_discount_poisha + bill_discount_poisha),
  ADD CONSTRAINT sales_void_chk CHECK (
    (voided AND voided_at IS NOT NULL AND voided_by IS NOT NULL AND length(btrim(void_reason)) > 0)
    OR (NOT voided AND voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL)
  ),
  ADD CONSTRAINT sales_voided_by_fk FOREIGN KEY (store_id, voided_by) REFERENCES users (store_id, id);
ALTER TABLE sales ALTER COLUMN created_at SET DEFAULT date_trunc('milliseconds', now());
CREATE UNIQUE INDEX sales_bill_no_uq ON sales (store_id, (coalesce(bill_prefix, '')), bill_no);
CREATE INDEX sales_sold_idx ON sales (store_id, sold_at DESC, id DESC);
CREATE INDEX sales_customer_sold_idx ON sales (store_id, customer_id, sold_at DESC, id DESC) WHERE customer_id IS NOT NULL;
-- বাতিলে শুধু এই কলামগুলো বদলায়
REVOKE UPDATE ON sales FROM pos_app;
GRANT UPDATE (voided, voided_at, voided_by, void_reason) ON sales TO pos_app;

-- ---------------------------------------------------------------- ২) sale_items ও sale_allocations
ALTER TABLE sale_items DROP COLUMN batch_id;   -- খালি টেবিল; ব্যাচ-ভিত্তিক ভাগ এখন sale_allocations-এ
ALTER TABLE sale_items DROP CONSTRAINT sale_items_pkey, ADD PRIMARY KEY (store_id, id);
ALTER TABLE sale_items
  ADD COLUMN line_no         smallint NOT NULL CHECK (line_no >= 1),
  ADD COLUMN product_name    text     NOT NULL,
  ADD COLUMN discount_poisha bigint   NOT NULL DEFAULT 0 CHECK (discount_poisha >= 0),
  ADD CONSTRAINT sale_items_total_chk CHECK (line_total_poisha = unit_price_poisha * qty - discount_poisha);
CREATE UNIQUE INDEX sale_items_line_uq ON sale_items (store_id, sale_id, line_no);

CREATE TABLE sale_allocations (
  store_id     uuid     NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  sale_item_id uuid     NOT NULL,
  seq          smallint NOT NULL CHECK (seq >= 1),          -- FIFO-র ক্রম
  batch_id     uuid     NOT NULL,
  qty          integer  NOT NULL CHECK (qty > 0),           -- পিসে
  oversold_qty integer  NOT NULL DEFAULT 0 CHECK (oversold_qty >= 0 AND oversold_qty <= qty),
  cost_poisha  bigint   NOT NULL CHECK (cost_poisha >= 0),  -- বিক্রির সময়ের প্রতি-পিস ক্রয়মূল্য
  PRIMARY KEY (store_id, sale_item_id, seq),
  FOREIGN KEY (store_id, sale_item_id) REFERENCES sale_items (store_id, id) ON DELETE CASCADE,
  FOREIGN KEY (store_id, batch_id) REFERENCES stock_batches (store_id, id)
);
CREATE INDEX sale_allocations_batch_idx ON sale_allocations (store_id, batch_id);
ALTER TABLE sale_allocations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sale_allocations
  USING (store_id = app_store_id()) WITH CHECK (store_id = app_store_id());
GRANT SELECT, INSERT ON sale_allocations TO pos_app;       -- অপরিবর্তনীয়

-- ---------------------------------------------------------------- ৩) payments
ALTER TABLE payments
  ADD COLUMN seq smallint NOT NULL CHECK (seq >= 1);
CREATE UNIQUE INDEX payments_sale_seq_uq ON payments (store_id, sale_id, seq);

COMMIT;
