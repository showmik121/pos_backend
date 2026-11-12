-- POS ব্যাকএন্ড: প্রাথমিক স্কিমা (PostgreSQL 14+)
-- নিয়ম: প্রতিটি টেবিলে store_id থাকে; Row Level Security দিয়ে এক দোকানের ডেটা অন্য দোকান দেখতে পায় না।
-- অ্যাপ প্রতিটি রিকোয়েস্টে ট্রানজ্যাকশনের ভেতর set_config('app.store_id', <uuid>, true) চালায়।
-- টাকা: numeric(12,2)। স্টক: বেস ইউনিটে (পিস) পূর্ণসংখ্যা।

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

-- ---------------------------------------------------------------- দোকান ও ব্যবহারকারী
CREATE TABLE stores (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  kind       text NOT NULL DEFAULT 'pharmacy' CHECK (kind IN ('pharmacy', 'cosmetics', 'other')),
  address    text,
  phone      text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id      uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name          text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  phone         text NOT NULL,                       -- 01XXXXXXXXX (স্বাভাবিকীকৃত)
  password_hash text NOT NULL,
  role          text NOT NULL CHECK (role IN ('owner', 'staff')),
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (phone)                                     -- লগইন ফোন দিয়ে, তাই গ্লোবালি ইউনিক
);
CREATE INDEX users_store_idx ON users (store_id);

-- ---------------------------------------------------------------- পণ্য ও স্টক
CREATE TABLE products (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id            uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name                text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  barcode             text,                           -- পিসের বারকোড (না থাকলে NULL → নিজস্ব লেবেল)
  carton_barcode      text,                           -- কার্টন/বান্ডলের বারকোড
  category            text,
  pack_size           integer NOT NULL DEFAULT 1 CHECK (pack_size > 0), -- ১ কার্টনে কত পিস
  sell_price          numeric(12,2) NOT NULL CHECK (sell_price >= 0),   -- প্রতি পিস
  cost_price          numeric(12,2) CHECK (cost_price >= 0),
  low_stock_threshold integer NOT NULL DEFAULT 0 CHECK (low_stock_threshold >= 0),
  track_expiry        boolean NOT NULL DEFAULT false,
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, id)
);
CREATE UNIQUE INDEX products_barcode_uq ON products (store_id, barcode) WHERE barcode IS NOT NULL;
CREATE UNIQUE INDEX products_carton_barcode_uq ON products (store_id, carton_barcode) WHERE carton_barcode IS NOT NULL;
CREATE INDEX products_name_idx ON products (store_id, lower(name));

-- ব্যাচ: মেয়াদ ও FIFO এর জন্য। মেয়াদ ট্র্যাক না করা পণ্যের একটি ব্যাচ (expiry NULL) থাকে।
CREATE TABLE stock_batches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id      uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id    uuid NOT NULL,
  batch_no      text,
  expiry_date   date,
  qty_remaining integer NOT NULL CHECK (qty_remaining >= 0),
  cost_price    numeric(12,2) CHECK (cost_price >= 0),
  received_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (store_id, product_id) REFERENCES products (store_id, id) ON DELETE CASCADE,
  UNIQUE (store_id, id)
);
CREATE INDEX stock_batches_fifo_idx ON stock_batches (store_id, product_id, expiry_date NULLS LAST)
  WHERE qty_remaining > 0;

-- শুধু যোগ হয়, বদলানো/মোছা যায় না (নিচে ট্রিগার)। id ক্লায়েন্ট বানায় → অফলাইন সিংকে ডুপ্লিকেট হয় না।
CREATE TABLE stock_movements (
  id          uuid PRIMARY KEY,
  store_id    uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id  uuid NOT NULL,
  batch_id    uuid,
  kind        text NOT NULL CHECK (kind IN ('purchase', 'sale', 'sale_return', 'adjustment', 'expired')),
  qty_delta   integer NOT NULL CHECK (qty_delta <> 0),  -- + এলে বাড়ে, − হলে কমে (পিসে)
  ref_id      uuid,                                      -- বিল/ক্রয়ের আইডি
  note        text,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (store_id, product_id) REFERENCES products (store_id, id),
  FOREIGN KEY (store_id, batch_id) REFERENCES stock_batches (store_id, id)
);
CREATE INDEX stock_movements_product_idx ON stock_movements (store_id, product_id, created_at);

-- ---------------------------------------------------------------- কাস্টমার, বিক্রি, পেমেন্ট
CREATE TABLE customers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id   uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name       text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  phone      text,
  address    text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, id)
);
CREATE UNIQUE INDEX customers_phone_uq ON customers (store_id, phone) WHERE phone IS NOT NULL;

CREATE TABLE store_counters (
  store_id     uuid PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  last_bill_no integer NOT NULL DEFAULT 0
);

CREATE TABLE sales (
  id          uuid PRIMARY KEY,                          -- ক্লায়েন্ট-জেনারেটেড (ইডেমপোটেন্ট সিংক)
  store_id    uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  bill_no     integer NOT NULL,
  customer_id uuid,
  subtotal    numeric(12,2) NOT NULL CHECK (subtotal >= 0),
  discount    numeric(12,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  total       numeric(12,2) NOT NULL CHECK (total >= 0),
  paid        numeric(12,2) NOT NULL CHECK (paid >= 0),  -- নগদ ফেরত বাদে
  due         numeric(12,2) NOT NULL DEFAULT 0 CHECK (due >= 0),
  voided      boolean NOT NULL DEFAULT false,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (total = subtotal - discount),
  CHECK (paid + due = total),
  CHECK (due = 0 OR customer_id IS NOT NULL),            -- বাকি দিতে কাস্টমার লাগবে
  UNIQUE (store_id, bill_no),
  UNIQUE (store_id, id),
  FOREIGN KEY (store_id, customer_id) REFERENCES customers (store_id, id)
);

CREATE TABLE sale_items (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id   uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  sale_id    uuid NOT NULL,
  product_id uuid NOT NULL,
  batch_id   uuid,
  qty        integer NOT NULL CHECK (qty > 0),           -- পিসে
  unit_price numeric(12,2) NOT NULL CHECK (unit_price >= 0),
  line_total numeric(12,2) NOT NULL CHECK (line_total >= 0),
  FOREIGN KEY (store_id, sale_id) REFERENCES sales (store_id, id) ON DELETE CASCADE,
  FOREIGN KEY (store_id, product_id) REFERENCES products (store_id, id),
  FOREIGN KEY (store_id, batch_id) REFERENCES stock_batches (store_id, id)
);
CREATE INDEX sale_items_sale_idx ON sale_items (store_id, sale_id);

CREATE TABLE payments (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id  uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  sale_id   uuid NOT NULL,
  method    text NOT NULL CHECK (method IN ('cash', 'bkash', 'nagad', 'rocket', 'card', 'other')),
  amount    numeric(12,2) NOT NULL CHECK (amount > 0),
  reference text,                                        -- TrxID ইত্যাদি
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (store_id, sale_id) REFERENCES sales (store_id, id) ON DELETE CASCADE
);
CREATE INDEX payments_sale_idx ON payments (store_id, sale_id);

-- বাকির খাতা: শুধু যোগ হয়। amount > 0 = বাকি বেড়েছে, < 0 = কাস্টমার শোধ করেছে।
CREATE TABLE due_ledger (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  sale_id     uuid,
  amount      numeric(12,2) NOT NULL CHECK (amount <> 0),
  method      text CHECK (method IN ('cash', 'bkash', 'nagad', 'rocket', 'card', 'other')),
  note        text,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (store_id, customer_id) REFERENCES customers (store_id, id)
);
CREATE INDEX due_ledger_customer_idx ON due_ledger (store_id, customer_id, created_at);

-- ---------------------------------------------------------------- append-only সুরক্ষা
CREATE FUNCTION forbid_update_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% টেবিলে শুধু নতুন সারি যোগ করা যায়', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END $$;

CREATE TRIGGER stock_movements_append_only BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER due_ledger_append_only BEFORE UPDATE OR DELETE ON due_ledger
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();

-- ---------------------------------------------------------------- Row Level Security
-- অ্যাপ রোল (pos_app) টেবিলের মালিক নয়, তাই RLS তার ওপর প্রযোজ্য।
CREATE FUNCTION app_store_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.store_id', true), '')::uuid
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'products', 'stock_batches', 'stock_movements', 'customers',
    'store_counters', 'sales', 'sale_items', 'payments', 'due_ledger'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (store_id = app_store_id()) WITH CHECK (store_id = app_store_id())', t);
  END LOOP;
END $$;

ALTER TABLE stores ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stores USING (id = app_store_id()) WITH CHECK (id = app_store_id());

-- লগইনের সময় দোকান জানা থাকে না, আর দোকান খোলার সময় দোকানই থাকে না।
-- তাই এই দুটি কাজ SECURITY DEFINER ফাংশনে সীমিত রাখা হয়েছে (RLS এড়িয়ে চলে, কিন্তু শুধু এটুকুই করে)।
CREATE FUNCTION auth_find_user(p_phone text)
RETURNS TABLE (id uuid, store_id uuid, name text, phone text, password_hash text, role text, active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id, u.store_id, u.name, u.phone, u.password_hash, u.role, u.active
  FROM users u WHERE u.phone = p_phone
$$;

CREATE FUNCTION auth_register_store(
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

REVOKE ALL ON FUNCTION auth_find_user(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_register_store(text, text, text, text, text) FROM PUBLIC;

-- অ্যাপ রোল তৈরি (একবার, সুপারইউজার দিয়ে): CREATE ROLE pos_app LOGIN PASSWORD '...';
-- তারপর নিচের গ্র্যান্টগুলো pos_app রোল থাকলে চলবে।
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pos_app') THEN
    GRANT USAGE ON SCHEMA public TO pos_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pos_app;
    REVOKE UPDATE, DELETE ON stock_movements, due_ledger FROM pos_app;
    GRANT EXECUTE ON FUNCTION auth_find_user(text), auth_register_store(text, text, text, text, text),
      app_store_id() TO pos_app;
  END IF;
END $$;

COMMIT;
