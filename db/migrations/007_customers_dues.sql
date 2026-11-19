-- ০০৭: কাস্টমার ও বাকির খাতা API-র জন্য স্কিমা (ফ্রন্টএন্ডের Customer/LedgerEntry মডেলের সাথে মেলানো)
--   ১) PK = (store_id, id): id ক্লায়েন্ট বানায়, তাই দুই দোকানে একই UUID এলে সংঘাত বা অস্তিত্ব-ফাঁস হয় না
--   ২) ফোন সংরক্ষণ হয় 01XXXXXXXXX আকারে (বা NULL)
--   ৩) খাতা: kind (sale/opening/payment/void), চিহ্নের নিয়ম (বাকি বাড়লে +, কমলে −), বিলপ্রতি একটি sale ও একটি void
-- নোট: এই টেবিলগুলো এখনো কোনো API ব্যবহার করেনি; খালি না হলে নিচের guard থামিয়ে দেয়।

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM customers) OR EXISTS (SELECT 1 FROM due_ledger) OR EXISTS (SELECT 1 FROM sales) THEN
    RAISE EXCEPTION '007: customers/due_ledger/sales খালি নয়; আগে ডেটা সরান বা ব্যাকফিল স্ক্রিপ্ট লিখুন';
  END IF;
END $$;

-- ---------------------------------------------------------------- ১) কাস্টমার
-- (store_id, id) UNIQUE আগে থেকেই আছে এবং FK-গুলো সেটিকে ধরে; তাই সেটি রেখে শুধু PK বদলানো হয়।
ALTER TABLE customers DROP CONSTRAINT customers_pkey, ADD PRIMARY KEY (store_id, id);
ALTER TABLE customers ADD CONSTRAINT customers_phone_fmt CHECK (phone IS NULL OR phone ~ '^01[3-9][0-9]{8}$');
ALTER TABLE customers ALTER COLUMN created_at SET DEFAULT date_trunc('milliseconds', now());
-- নাম ও ফোন ছাড়া বাকি কলাম অপরিবর্তনীয়
REVOKE UPDATE ON customers FROM pos_app;
GRANT UPDATE (name, phone, address) ON customers TO pos_app;

-- ---------------------------------------------------------------- ২) বাকির খাতা
ALTER TABLE due_ledger DROP CONSTRAINT due_ledger_pkey, ADD PRIMARY KEY (store_id, id);
ALTER TABLE due_ledger ALTER COLUMN created_at SET DEFAULT date_trunc('milliseconds', now());
ALTER TABLE due_ledger
  ADD COLUMN kind text NOT NULL,
  ADD CONSTRAINT due_ledger_kind_chk CHECK (kind IN ('sale', 'opening', 'payment', 'void')),
  ADD CONSTRAINT due_ledger_sign_chk CHECK (
    (kind IN ('sale', 'opening') AND amount_poisha > 0) OR (kind IN ('payment', 'void') AND amount_poisha < 0)
  ),
  ADD CONSTRAINT due_ledger_sale_ref_chk CHECK ((kind IN ('sale', 'void')) = (sale_id IS NOT NULL)),
  ADD CONSTRAINT due_ledger_method_chk CHECK (method IS NULL OR kind = 'payment');
-- একই বিলে একটিই বাকি-এন্ট্রি ও একটিই বাতিল-এন্ট্রি (দুই ডিভাইসে বাতিল হলেও একবারই কমে)
CREATE UNIQUE INDEX due_ledger_sale_once_uq ON due_ledger (store_id, sale_id, kind) WHERE kind IN ('sale', 'void');
-- ব্যালান্স ও "বাকির তালিকা" দ্রুত করতে (due_ledger_customer_idx সময়ের ক্রমে)
CREATE INDEX due_ledger_customer_recent_idx ON due_ledger (store_id, customer_id, created_at DESC, id DESC);

COMMIT;
