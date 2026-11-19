-- ০০৫: ফ্রন্টএন্ডের ক্র্যাশ রিপোর্ট (নিজের সার্ভারে; বাইরের সেবায় কিছু যায় না)
--   একই ত্রুটি বারবার এলে নতুন সারি নয়, গোনা (count) বাড়ে, তাই টেবিল ছোট থাকে।
--   pos_app-এর টেবিলে সরাসরি অনুমতি নেই; শুধু নিচের SECURITY DEFINER ফাংশন দিয়ে লেখা যায় (auth_throttle-এর মতো)।
--   পড়া: ডেটাবেস ড্যাশবোর্ড/SQL এডিটর (মালিক)। ৩০ দিনের পুরনো সারি মাঝে মাঝে সাফ হয়।

BEGIN;

CREATE TABLE client_errors (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fingerprint text NOT NULL UNIQUE,
  first_at    timestamptz NOT NULL DEFAULT now(),
  last_at     timestamptz NOT NULL DEFAULT now(),
  count       integer NOT NULL DEFAULT 1,
  store_id    uuid,
  kind        text NOT NULL CHECK (kind IN ('render', 'window', 'rejection')),
  message     text NOT NULL CHECK (length(message) <= 500),
  stack       text CHECK (length(stack) <= 4000),
  path        text CHECK (length(path) <= 200),
  app_version text CHECK (length(app_version) <= 40),
  user_agent  text CHECK (length(user_agent) <= 200)
);
CREATE INDEX client_errors_last_at_idx ON client_errors (last_at);
ALTER TABLE client_errors ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION record_client_error(
  p_store uuid, p_kind text, p_message text, p_stack text, p_path text, p_version text, p_ua text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO client_errors (fingerprint, store_id, kind, message, stack, path, app_version, user_agent)
  VALUES (md5(p_kind || '|' || p_message || '|' || left(coalesce(p_stack, ''), 300)), p_store, p_kind,
          left(p_message, 500), left(p_stack, 4000), left(p_path, 200), left(p_version, 40), left(p_ua, 200))
  ON CONFLICT (fingerprint) DO UPDATE SET count = client_errors.count + 1, last_at = now();
  IF random() < 0.02 THEN
    DELETE FROM client_errors WHERE last_at < now() - interval '30 days';
  END IF;
END $$;

REVOKE ALL ON FUNCTION record_client_error(uuid, text, text, text, text, text, text) FROM PUBLIC;
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON client_errors FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION record_client_error(uuid, text, text, text, text, text, text) FROM %I', r);
    END IF;
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION record_client_error(uuid, text, text, text, text, text, text) TO pos_app;

COMMIT;
