-- ০০৪: সিংক ইভেন্ট-লগ
--   sync_devices: প্রতি দোকানে ডিভাইসের সংক্ষিপ্ত কোড (A, B, C…) — বিল নম্বরের উপসর্গ ("A-1001")
--   sync_events : শুধু-যোগ লগ। ক্লায়েন্ট-জেনারেটেড id → একই ইভেন্ট দুবার এলে একবারই থাকে।
--                 seq দোকানের ইভেন্টের ক্রম (pull-এর কার্সর)।
-- নোট: 001-এর রিলেশনাল টেবিল (products, sales…) এখনো ব্যবহার হয় না; রিপোর্টের জন্য পরে এই লগ থেকে প্রজেক্ট করা হবে।

BEGIN;

CREATE TABLE sync_devices (
  store_id   uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  device_id  uuid NOT NULL,
  code       char(1) NOT NULL CHECK (code BETWEEN 'A' AND 'Z'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, device_id),
  UNIQUE (store_id, code)
);

CREATE TABLE sync_events (
  seq         bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  store_id    uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  id          uuid NOT NULL,
  device_code char(1) NOT NULL,
  user_id     uuid NOT NULL,
  kind        text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]{1,39}$'),
  client_at   timestamptz NOT NULL,
  payload     jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND pg_column_size(payload) < 40000),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, id),
  FOREIGN KEY (store_id, device_code) REFERENCES sync_devices (store_id, code),
  FOREIGN KEY (store_id, user_id) REFERENCES users (store_id, id)
);
CREATE INDEX sync_events_store_seq_idx ON sync_events (store_id, seq);

ALTER TABLE sync_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sync_devices USING (store_id = app_store_id()) WITH CHECK (store_id = app_store_id());
CREATE POLICY tenant_isolation ON sync_events USING (store_id = app_store_id()) WITH CHECK (store_id = app_store_id());

-- লগ অপরিবর্তনীয়: শুধু পড়া ও যোগ (UPDATE/DELETE-এর অনুমতি নেই)
GRANT SELECT, INSERT ON sync_devices, sync_events TO pos_app;

COMMIT;
