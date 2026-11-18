-- ০০২: নিরাপত্তা-শক্তিশালীকরণ
--   ১) টাকা numeric(12,2) টাকা  ->  bigint পয়সা (অ্যাপের পূর্ণসংখ্যা-পয়সা মডেলের সঙ্গে মেলে; কলামের নামে _poisha)
--   ২) pos_app এর অনুমতি ছাঁটা: DELETE নেই, শুধু প্রয়োজনীয় টেবিল/কলাম, password_hash পড়া যায় না
--   ৩) লগইন/নিবন্ধনের হার-সীমা ডাটাবেসে (সব Edge instance মিলে এক হিসাব; একসাথে অনেক অনুরোধেও নিরাপদ)
-- নোট: এখনো কোনো API এই টাকার কলাম ছোঁয় না, তাই নাম বদলে অ্যাপ ভাঙে না।

BEGIN;

-- ---------------------------------------------------------------- ১) টাকা = পূর্ণসংখ্যা পয়সা
ALTER TABLE products
  ALTER COLUMN sell_price TYPE bigint USING round(sell_price * 100)::bigint,
  ALTER COLUMN cost_price TYPE bigint USING round(cost_price * 100)::bigint;
ALTER TABLE products RENAME COLUMN sell_price TO sell_price_poisha;
ALTER TABLE products RENAME COLUMN cost_price TO cost_price_poisha;

ALTER TABLE stock_batches
  ALTER COLUMN cost_price TYPE bigint USING round(cost_price * 100)::bigint;
ALTER TABLE stock_batches RENAME COLUMN cost_price TO cost_price_poisha;

ALTER TABLE sales
  ALTER COLUMN subtotal TYPE bigint USING round(subtotal * 100)::bigint,
  ALTER COLUMN discount TYPE bigint USING round(discount * 100)::bigint,
  ALTER COLUMN total    TYPE bigint USING round(total * 100)::bigint,
  ALTER COLUMN paid     TYPE bigint USING round(paid * 100)::bigint,
  ALTER COLUMN due      TYPE bigint USING round(due * 100)::bigint;
ALTER TABLE sales RENAME COLUMN subtotal TO subtotal_poisha;
ALTER TABLE sales RENAME COLUMN discount TO discount_poisha;
ALTER TABLE sales RENAME COLUMN total    TO total_poisha;
ALTER TABLE sales RENAME COLUMN paid     TO paid_poisha;
ALTER TABLE sales RENAME COLUMN due      TO due_poisha;

ALTER TABLE sale_items
  ALTER COLUMN unit_price TYPE bigint USING round(unit_price * 100)::bigint,
  ALTER COLUMN line_total TYPE bigint USING round(line_total * 100)::bigint;
ALTER TABLE sale_items RENAME COLUMN unit_price TO unit_price_poisha;
ALTER TABLE sale_items RENAME COLUMN line_total TO line_total_poisha;

ALTER TABLE payments
  ALTER COLUMN amount TYPE bigint USING round(amount * 100)::bigint;
ALTER TABLE payments RENAME COLUMN amount TO amount_poisha;

ALTER TABLE due_ledger
  ALTER COLUMN amount TYPE bigint USING round(amount * 100)::bigint;
ALTER TABLE due_ledger RENAME COLUMN amount TO amount_poisha;

-- ---------------------------------------------------------------- ২) pos_app এর অনুমতি ছাঁটা
-- আগে ছিল: সব টেবিলে SELECT/INSERT/UPDATE/DELETE। এখন শূন্য থেকে স্পষ্ট করে দেওয়া হচ্ছে।
-- নতুন টেবিল যোগ করলে পরের মাইগ্রেশনে তার GRANT নিজে লিখতে হবে (ডিফল্টে কিছু পাবে না)।
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM pos_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM pos_app;

-- দোকান: শুধু পড়া (দোকান খোলা হয় auth_register_store ফাংশনে)
GRANT SELECT ON stores TO pos_app;

-- ব্যবহারকারী: password_hash পড়া যায় না (লগইনের হ্যাশ শুধু auth_find_user ফাংশন দেয়)
GRANT SELECT (id, store_id, name, phone, role, active, created_at) ON users TO pos_app;
GRANT INSERT ON users TO pos_app;
GRANT UPDATE (active, name) ON users TO pos_app;

-- ক্যাটালগ ও গ্রাহক: যোগ ও বদল, মোছা নয় (ভুল পণ্য থাকলে বন্ধ করা হবে, মুছে নয়)
GRANT SELECT, INSERT, UPDATE ON products, stock_batches, customers TO pos_app;

-- খাতা: শুধু যোগ
GRANT SELECT, INSERT ON stock_movements, due_ledger TO pos_app;

-- বিক্রি: যোগ হয়; পরে শুধু বাতিল (voided) করা যায়; আইটেম ও পেমেন্ট অপরিবর্তনীয়
GRANT SELECT, INSERT ON sales, sale_items, payments TO pos_app;
GRANT UPDATE (voided) ON sales TO pos_app;

-- বিল নম্বরের কাউন্টার
GRANT SELECT, INSERT, UPDATE ON store_counters TO pos_app;

-- ---------------------------------------------------------------- ৩) হার-সীমা (ডাটাবেসে)
-- bucket: যেমন 'login:p:01712345678|1.2.3.4'। কোনো RLS নীতি নেই এবং pos_app এর সরাসরি অনুমতিও নেই,
-- তাই শুধু নিচের SECURITY DEFINER ফাংশন দিয়ে ছোঁয়া যায়।
CREATE TABLE auth_attempts (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bucket     text NOT NULL CHECK (length(bucket) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_attempts_bucket_idx ON auth_attempts (bucket, created_at);
CREATE INDEX auth_attempts_created_idx ON auth_attempts (created_at);
ALTER TABLE auth_attempts ENABLE ROW LEVEL SECURITY;

-- একটি চেষ্টা নথিভুক্ত করে। সীমা পেরোলে false (এবং আরও একটি সারি যোগ হয় না, তাই আটকে থাকলে মেয়াদ বাড়ে না)।
-- bucket প্রতি advisory lock থাকায় একসাথে অনেক অনুরোধ এলেও গোনা ঠিক থাকে (পরীক্ষা-তারপর-যোগ রেস নেই)।
CREATE FUNCTION auth_throttle(p_bucket text, p_max integer, p_window_seconds integer)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_count integer;
BEGIN
  IF p_max < 1 OR p_window_seconds < 1 OR p_window_seconds > 86400 THEN
    RAISE EXCEPTION 'auth_throttle: অবৈধ প্যারামিটার';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_bucket, 0));
  SELECT count(*) INTO v_count FROM auth_attempts
    WHERE bucket = p_bucket AND created_at > now() - make_interval(secs => p_window_seconds);
  IF v_count >= p_max THEN
    RETURN false;
  END IF;
  INSERT INTO auth_attempts (bucket) VALUES (p_bucket);
  -- পুরনো সারি মাঝে মাঝে সাফ (সবচেয়ে বড় উইন্ডো ১ দিনের কম)
  IF random() < 0.02 THEN
    DELETE FROM auth_attempts WHERE created_at < now() - interval '1 day';
  END IF;
  RETURN true;
END $$;

-- সফল লগইনে ওই bucket এর গোনা শূন্য করে।
CREATE FUNCTION auth_throttle_reset(p_bucket text)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DELETE FROM auth_attempts WHERE bucket = p_bucket
$$;

REVOKE ALL ON FUNCTION auth_throttle(text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_throttle_reset(text) FROM PUBLIC;
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON auth_attempts FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION auth_throttle(text, integer, integer) FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION auth_throttle_reset(text) FROM %I', r);
    END IF;
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION auth_throttle(text, integer, integer), auth_throttle_reset(text) TO pos_app;

COMMIT;
