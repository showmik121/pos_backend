-- ০০৩: অখণ্ডতা ও ইনডেক্স
--   ১) created_by / sale_id এখন (store_id, id) যৌথ FK: অন্য দোকানের ব্যবহারকারী বা বিল ভুল করেও জোড়া লাগানো যায় না
--   ২) বিক্রি ও FK-সংলগ্ন কলামে ইনডেক্স (রিপোর্ট, বাকির তালিকা, ডিলিট/জয়েন ধীর হওয়া ঠেকাতে)
-- নোট: টেবিল এখনো প্রায় খালি, তাই সাধারণ (non-concurrent) ইনডেক্স নিরাপদ; ভরা টেবিলে ভবিষ্যতে CONCURRENTLY লাগবে।

BEGIN;

-- ---------------------------------------------------------------- ১) যৌথ FK
ALTER TABLE users ADD CONSTRAINT users_store_id_id_uq UNIQUE (store_id, id);

ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_created_by_fkey;
ALTER TABLE stock_movements
  ADD CONSTRAINT stock_movements_created_by_fk FOREIGN KEY (store_id, created_by) REFERENCES users (store_id, id);

ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_created_by_fkey;
ALTER TABLE sales
  ADD CONSTRAINT sales_created_by_fk FOREIGN KEY (store_id, created_by) REFERENCES users (store_id, id);

ALTER TABLE due_ledger DROP CONSTRAINT IF EXISTS due_ledger_created_by_fkey;
ALTER TABLE due_ledger
  ADD CONSTRAINT due_ledger_created_by_fk FOREIGN KEY (store_id, created_by) REFERENCES users (store_id, id);

-- বাকির খাতায় বিল থাকলে সেটি একই দোকানের হতেই হবে (sale_id খালি হলে যাচাই হয় না)
ALTER TABLE due_ledger
  ADD CONSTRAINT due_ledger_sale_fk FOREIGN KEY (store_id, sale_id) REFERENCES sales (store_id, id);

-- ---------------------------------------------------------------- ২) ইনডেক্স
-- সাম্প্রতিক বিল / তারিখ-ভিত্তিক রিপোর্ট
CREATE INDEX sales_created_idx ON sales (store_id, created_at DESC);
-- কাস্টমারের বিলের তালিকা
CREATE INDEX sales_customer_idx ON sales (store_id, customer_id, created_at DESC) WHERE customer_id IS NOT NULL;
-- বাকি আছে এমন বিল
CREATE INDEX sales_open_due_idx ON sales (store_id, created_at DESC) WHERE due_poisha > 0 AND NOT voided;

CREATE INDEX stock_movements_batch_idx ON stock_movements (store_id, batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX stock_movements_ref_idx ON stock_movements (store_id, ref_id) WHERE ref_id IS NOT NULL;
CREATE INDEX sale_items_product_idx ON sale_items (store_id, product_id);
CREATE INDEX sale_items_batch_idx ON sale_items (store_id, batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX due_ledger_sale_idx ON due_ledger (store_id, sale_id) WHERE sale_id IS NOT NULL;

COMMIT;
