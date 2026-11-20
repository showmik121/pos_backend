# রানবুক: ব্যাকএন্ড ও ডেটাবেস (Supabase)

কিছু ভাঙলে এই পাতা দেখুন। ফ্রন্টএন্ড ও ফোনের ডেটার জন্য `pos_fontend/docs/RUNBOOK.md`। পুরো সিস্টেমের সীমাবদ্ধতা `docs/handover/KNOWN_LIMITATIONS.md`-তে (শেয়ার্ড `docs/handover/`)।

**চিহ্ন:** ✅ = প্রমাণসহ যাচাই হয়েছে · ⚠ = লেখা আছে কিন্তু কেউ চালিয়ে দেখেননি · ❌ = নেই/ভাঙা। এই পাতার প্রতিটি ধাপে যেটি ⚠, সেটি আসল বিপদের আগে একবার চালিয়ে ✅ করুন।

## ০. দায়িত্ব ও যোগাযোগ (হস্তান্তরের সময় বসান)
| ভূমিকা | নাম | ফোন/ইমেইল |
|---|---|---|
| ঘটনার প্রথম দায়িত্ব (on-call) | ________ | ________ |
| Supabase প্রজেক্টের মালিক | ________ | ________ |
| GitHub রিপো অ্যাডমিন | ________ | ________ |
| Netlify সাইটের মালিক | ________ | ________ |

## ১. কোথায় কী চলছে
- API: Supabase Edge Function `api`, `https://gaxzkbcomeexlnzquvzf.supabase.co/functions/v1/api/`। স্বাস্থ্য-পরীক্ষা: `/health`।
- ডেটাবেস: ওই প্রজেক্টের PostgreSQL। অ্যাপ `pos_app` রোলে ঢোকে (RLS প্রযোজ্য); মাইগ্রেশন `postgres` রোলে।
- ডিপ্লয়: `main`-এ পুশ → CI (`test`, `postgres`, `supabase-edge`) পাস → `deploy` জব → `/health` যাচাই। `deploy` শুধু GitHub secret `SUPABASE_ACCESS_TOKEN` থাকলে চলে; না থাকলে ধাপটি চুপচাপ বাদ যায় (লগে "অটো-ডিপ্লয় বাদ গেল")।
- **লাইভ ডেটাবেসের মাইগ্রেশন CI-তে চলে না।** CI শুধু তাজা Postgres-এ মাইগ্রেশন দুইবার চালিয়ে যাচাই করে; লাইভে হাতে চালাতে হয় (৩ নম্বর)।
- `[skip ci]` কমিট বার্তায় থাকলে ডিপ্লয় হয় না (শুধু ডক বদলে ব্যবহার করুন)।

**কোন সংস্করণ লাইভ আছে, যাচাই করুন:** `curl -s https://gaxzkbcomeexlnzquvzf.supabase.co/functions/v1/api/health`
- আশা: `{"status":"ok","db":"ok"}`।
- ⚠ **২০২৬-১১-২০-এ লাইভ থেকে এল শুধু `{"status":"ok"}`** (HTTP ২০০, ০.৭ সেকেন্ড): অর্থাৎ লাইভ ফাংশন বর্তমান `main`-এর চেয়ে পুরনো (বর্তমান কোড `db` ফিল্ডও দেয়)। কারণ এখনো খোঁজা হয়নি: GitHub Actions → `deploy` জবের শেষ রান দেখুন; `SUPABASE_ACCESS_TOKEN` আছে কি না; Supabase Dashboard → Edge Functions → `api` → শেষ ডিপ্লয়ের সময়। এর উত্তর না পাওয়া পর্যন্ত "লাইভে কোন কোড চলছে" নিশ্চিত নয়।

## ২. খারাপ কোড লাইভ হলে (API rollback) — কোড, ডেটা নয়
1. `git log` দেখে খারাপ কমিট চিহ্নিত করুন।
2. `git revert <কমিট>` করে `main`-এ পুশ করুন। CI পাস করলে পুরনো আচরণ নিয়ে নিজে ডিপ্লয় হবে, শেষে `/health` যাচাই।
3. CI ধীর বা ভাঙা হলে হাতে: `.env` ঠিক রেখে `deploy-supabase.bat` চালান (সবকিছু বিল্ড করে ডিপ্লয় করে)।
4. ডিপ্লয়ের পর `/health` খুলুন। `{"status":"ok","db":"ok"}` = ফাংশন চালু ও ডেটাবেসে পৌঁছানো যাচ্ছে। `503` ও `{"status":"degraded","db":"down"}` = ফাংশন চালু কিন্তু ডেটাবেস নাগালে নেই (৮ নম্বর দেখুন)। উত্তর ৫ সেকেন্ড পর্যন্ত ক্যাশ হয়। এরপর একটি লগইন চেষ্টা করুন; `/health` শুধু `SELECT 1` পরীক্ষা করে।
5. **ডিপ্লয়ের ক্রম (সিংকের নিয়ম বদলালে):** আগে **ফ্রন্টএন্ড** (Netlify), তারপর ব্যাকএন্ড। কারণ: ব্যাকএন্ড কর্মচারীর জন্য সিংক-ইভেন্টের ধরন সাদা-তালিকায় (`server/app.ts` `SYNC_STAFF_KINDS`) সীমিত করেছে। পুরনো ফ্রন্টএন্ড (ফোনে ক্যাশ করা কপি) এমন ইভেন্ট পাঠালে ৪০৩ পায়, আর পুরনো কোড ৪০৩-কে "লগইন সমস্যা" ধরে ওই ফোনের পুরো সিংক থামিয়ে দেয়।
6. ডেটাবেস বদল (মাইগ্রেশন) কোড-rollback দিয়ে ফেরে না: ৩ ও ৫-৬ নম্বর।

## ৩. মাইগ্রেশন লাইভে প্রয়োগ
**মাইগ্রেশনের `down` (পিছনে ফেরা) নেই।** সামনের দিকে ঠিক করা (নতুন মাইগ্রেশন) পছন্দের পথ; না হলে ব্যাকআপ থেকে ফেরানো (৫-৬)।

**বর্তমান ফাইল (`main`):** `001_init` … `006_catalog_stock`। অন্য রিপো-শাখায় (মার্জ হয়নি, তাই লাইভে প্রয়োগ নয়) আরও আছে: `007_customers_dues` (`feat/dues-api`), `008_sales`, `009_projection` (`feat/projector`)। এগুলো `main`-এ মার্জ না হওয়া পর্যন্ত লাইভে চালাবেন না।

**প্রতিবার এই ক্রমে:**
1. **ব্যাকআপ নিন** (৪ নম্বর) এবং ফাইল খোলে কি না দেখুন।
2. **লাইভ অবস্থা দেখুন** (SQL এডিটরে, কিছু বদলায় না):
   ```sql
   SELECT name FROM schema_migrations ORDER BY name;
   SELECT 'products' t, count(*) FROM products UNION ALL SELECT 'stock_batches', count(*) FROM stock_batches
   UNION ALL SELECT 'stock_movements', count(*) FROM stock_movements UNION ALL SELECT 'sync_events', count(*) FROM sync_events;
   ```
3. **ফাইলের শুরুর শর্ত পড়ুন।** যেমন `006` শুরুতেই থেমে যায় যদি `products`/`stock_batches`/`stock_movements` খালি না থাকে (ডেটা-ব্যাকফিল আলাদা কাজ)। থামলে জোর করবেন না; কারণ বুঝে সিদ্ধান্ত নিন।
4. **চালান:** `.env`-এ `DATABASE_URL_UNPOOLED` (Session pooler, `postgres` ইউজার) ও `POS_APP_PASSWORD` বসিয়ে `npm run db:migrate` (বা `db-migrate.bat`)। প্রতিটি ফাইল `BEGIN … COMMIT`-এ; মাঝপথে ফেল করলে ওই ফাইলের সব বদল ফিরে যায় ও নাম `schema_migrations`-এ লেখা হয় না।
5. **যদি SQL এডিটর/MCP দিয়ে চালান:** পরে `INSERT INTO schema_migrations (name) VALUES ('<ফাইলের নাম>');` হাতে করুন, নইলে রানার ওটি আবার চালাবে।
6. **যাচাই:** ক) `schema_migrations`-এ নতুন নাম আছে; খ) `/health` `db: ok`; গ) একটি লগইন; ঘ) `pos_app` রোলে RLS চালু আছে:
   ```sql
   SELECT relname, relrowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY 1;  -- সব tenant টেবিলে true
   SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname='pos_app';                                      -- দুটিই false
   ```
7. **তারপর** কোড মার্জ/ডিপ্লয় (মাইগ্রেশন আগে, কোড পরে; নতুন কোড পুরনো স্কিমায় ভাঙে)।
8. তারিখ, কে করল, কোন ফাইল, ব্যাকআপের নাম — একটি লাইনে এই ডকের শেষের "মাইগ্রেশন-খাতা"-য় লিখুন।
- ⚠ লাইভে `main`-এর কতটা প্রয়োগ হয়েছে, এই কাজে কেউ এখনো সরাসরি যাচাই করেননি (ধাপ ২-এর প্রশ্ন চালিয়ে দেখুন)।

## ৩ক. Admin panel (A0): rollout, rollback, secrets (English)
Design: `docs/adr/0001`–`0006`. Spec: `docs/ADMIN_PANEL_PRD.md` §13, §17. Backend `main` auto-deploys and new code needs migration 012,
so the order below is **mandatory**. Do not merge before step 5 is done. Nothing in A0 changes what a shop owner sees.

**Rollout order**
1. Backup (section ৪) and confirm the file opens. Confirm the restore drill (section ৯) status; it is still a go-live blocker.
2. Read live state (section ৩, step 2): `011_store_rename.sql` applied, `012_admin_foundations.sql` not yet.
3. In your **local `.env`** set `DATABASE_URL_UNPOOLED`, `POS_APP_PASSWORD` and the new `ADMIN_APP_PASSWORD` (>= 16 chars, your own). Run `npm run db:migrate`.
   It applies 012 in one transaction and sets the `admin_app` password. Existing stores become `active` + `grandfathered`; new signups become `trial` (14 days).
4. Verify in the SQL editor:
   ```sql
   SELECT status, grandfathered, count(*) FROM stores GROUP BY 1, 2;                     -- every existing store: active / true
   SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname IN ('pos_app','admin_app'); -- all false
   SELECT count(*) FROM information_schema.table_privileges WHERE grantee = 'admin_app';  -- 0 (admin_app has no table grants)
   SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('platform_admins','admin_sessions','admin_audit_log'); -- all true
   ```
5. Set the Supabase Edge **secrets** (names only here; you choose and store the values, never in chat or git):
   `ADMIN_JWT_SECRET` (>= 32 random chars, different from `JWT_SECRET`), `ADMIN_TOTP_ENC_KEY` (32 random bytes, base64),
   `ADMIN_DATABASE_URL` (Transaction pooler, user `admin_app.<PROJECT_REF>`, port 6543). Optional: `ADMIN_TOTP_ISSUER`.
   All three or none: with any missing/invalid the admin surface is simply not mounted and the log says which name is wrong; shops are unaffected.
6. Merge the backend branch to `main` (CI -> auto-deploy). Check `/health`, then a shop login and a new test signup (expect `trial` in `GET /v1/me`).
   Check the admin gate: `GET /api/v1/admin/me` must answer **401** (route exists, no token); 404 means the secrets are not all set.
7. Create the first super admin on your machine (never over HTTP): `npm run create-admin -- --email you@example.com --name "Your Name"`.
   It needs `DATABASE_URL_UNPOOLED` and the **same** `ADMIN_TOTP_ENC_KEY` value in your local `.env`. Store the printed password and 2FA secret in a password manager.
   Locked out later? `npm run create-admin -- --email you@example.com --reset`.
8. `ALLOWED_ORIGINS` (operational step, PRD §17.5): when the admin site gets its own origin (phase A1) add that exact origin to the `ALLOWED_ORIGINS` secret
   and redeploy; otherwise browsers block it. The admin site's CSP `connect-src` must name only the API origin. Idempotency keys travel in the JSON body, so no new CORS header is needed.

**Rollback**
- Code first (section ২). Old shop code runs fine on the new schema (the migration is additive), so the schema rollback is optional.
- Schema: `db/rollback/012_down.sql`, run by hand with the `postgres` role after a backup. It **destroys** `platform_admins`, `admin_sessions` and `admin_audit_log`
  and the per-store status/trial data. Use it only before the panel is in real use. It is not run by `db:migrate`.
- The rollback **refuses** (error `P0001`) while `admin_audit_log` holds operator activity (any row not written by the CLI). Export the audit log first,
  then re-run the file in the same session after `SET bipone.discard_admin_audit = 'yes';`. It also has a 5 s `lock_timeout` (it fails instead of queueing shop requests)
  and drops only the 19 functions that 012 created, so a later phase's `admin_*` functions are never removed by name pattern.
- Holding `ADMIN_DATABASE_URL` (the `admin_app` login) equals full admin-panel power (for example it can create a super admin) but exposes no shop data.
  Keep it in Supabase secrets only, rotate it like `JWT_SECRET`, and never put it in a laptop `.env` that is shared or synced (ADR 0001).
- Rehearse both directions on a **staging** project before the live run (restore into staging, apply 012, run the verification SQL, run the rollback, re-apply). Record the result in `docs/handover-evidence/`.

**Operational notes**
- A suspended or read-only shop gets HTTP 403 `tenant_suspended` / `tenant_read_only` on data routes; login and `GET /v1/me` still work. Offline phones keep their queue and deliver it after reactivation.
- Until phase A1, status can only be changed by SQL (as `postgres`): `UPDATE stores SET status = 'suspended', status_message = '...' WHERE id = '...'`, and it is **not audited**. Treat that as an emergency path only.
- Rotating `ADMIN_JWT_SECRET` signs every admin out. Rotating `ADMIN_TOTP_ENC_KEY` invalidates all stored 2FA secrets: every admin must be reset with `--reset` and re-enrol.
- Admin audit rows cannot be edited or deleted by any role; keep >= 2 years (PRD A-10).

## ৪. ব্যাকআপ নেওয়া
**প্রথমে আপনার Supabase প্ল্যান দেখুন (Dashboard → Database → Backups):**
- Pro, Team ও Enterprise-এ প্রতিদিন স্বয়ংক্রিয় ব্যাকআপ; Pro-তে শেষ ৭ দিন ([Supabase: Database Backups](https://supabase.com/docs/guides/database/backups))।
- ফ্রি প্ল্যানে স্বয়ংক্রিয় ব্যাকআপ নেই; হাতে নেওয়া ব্যাকআপই একমাত্র কপি।
- **PITR** (যেকোনো মুহূর্তে ফেরা) অতিরিক্ত পয়সায় অ্যাড-অন।
- দিনের একটি ব্যাকআপ মানে সর্বোচ্চ প্রায় ২৪ ঘণ্টার সার্ভার-ডেটা হারানোর ঝুঁকি।
- ❗ **মনে রাখুন:** সার্ভারে এখন লগইন, দোকান, কর্মচারী ও সিংক-ইভেন্টের লগ আছে। পণ্য/বিল/বাকির আসল কপি ফোনে (ফ্রন্টএন্ড রানবুক ৪)।

**হাতে ব্যাকআপ (সব প্ল্যানে):** `pg_dump` ইনস্টল থাকতে হবে (এই কাজের কম্পিউটারে ২০২৬-১১-২০ পর্যন্ত ছিল না):
```bash
# .env থেকে DATABASE_URL_UNPOOLED (Session pooler, postgres ইউজার) নিন
pg_dump "$DATABASE_URL_UNPOOLED" --format=custom --schema=public --no-owner --no-privileges \
  --file=pos-backup-$(date +%F).dump
```
- ফাইলে দোকান, কর্মচারীর পাসওয়ার্ড-হ্যাশ ও ব্যবসার তথ্য আছে। **গোপন রাখুন:** পাসওয়ার্ড-ম্যানেজারসহ সুরক্ষিত জায়গায়; GitHub বা সাধারণ শেয়ারে নয়।
- কমপক্ষে সপ্তাহে একবার, আর প্রতিটি বড় মাইগ্রেশনের আগে। দুটি আলাদা জায়গায় রাখুন।

## ৫. ডেটাবেস ফেরানো, Pro প্ল্যানে (Dashboard)
1. Dashboard → Database → Backups থেকে তারিখ বাছুন, restore চালান। **restore চলার সময় প্রজেক্ট অনুপলব্ধ থাকে।**
2. শেষে `/health` ও একটি লগইন দেখুন।
3. ওই ব্যাকআপের পরের সব সার্ভার-ডেটা হারায়। ফোনের ডেটা (বিল ইত্যাদি) ফোনেই থাকে; ফোন আবার সিংক করলে ইভেন্ট ফের উঠবে।

## ৬. ডেটাবেস ফেরানো, হাতে নেওয়া `.dump` থেকে
সবচেয়ে নিরাপদ: **নতুন একটি Supabase প্রজেক্টে** ফেরানো, পুরনোটি অক্ষত রেখে:
1. নতুন প্রজেক্ট খুলে `.env`-এ তার `DATABASE_URL_UNPOOLED` ও `POS_APP_PASSWORD` বসান।
2. `npm run db:migrate`: স্কিমা, `pos_app` রোল, RLS ও অনুমতি তৈরি হবে (ডেটা ফাঁকা)।
3. ডেটা ঢোকান: `pg_restore --data-only --schema=public --dbname="$DATABASE_URL_UNPOOLED" pos-backup-তারিখ.dump`
4. সারি গুনে মেলান (`stores`, `users`, `sync_events`, এবং যা যা আছে); `schema_migrations`-এর তালিকা মেলান।
5. `DATABASE_URL` (Transaction pooler, `pos_app.<ref>`) নতুন প্রজেক্টে বদলান, Edge secrets হালনাগাদ, ফাংশন আবার ডিপ্লয় (`supabase-project-id.txt`-ও নতুন ref-এ)।
6. ফ্রন্টএন্ডের `NEXT_PUBLIC_API_URL` ও CSP-র `connect-src` (`public/_headers`) নতুন ঠিকানায় বদলান; Netlify-তে আবার ডিপ্লয়; ব্যাকএন্ড `ALLOWED_ORIGINS` ঠিক আছে কি না দেখুন।
- ⚠ `--data-only` কলাম/FK-ক্রমে আটকাতে পারে; মহড়া ছাড়া নিশ্চিত নয় (৯ নম্বর)।

## ৭. গোপন তথ্য বদলানো (rotate)
সব গোপন তথ্য Supabase Edge secrets-এ (`supabase secrets set`) এবং আপনার `.env`-এ; কখনো গিটে বা চ্যাটে নয়।
| কী | বদলালে কী হবে | কীভাবে |
|---|---|---|
| `JWT_SECRET` | **সবাই লগআউট হবে** | ≥৩২ অক্ষরের নতুন মান বানিয়ে secret সেট, ফাংশন আবার ডিপ্লয় |
| `pos_app` পাসওয়ার্ড | ফাংশন ডেটাবেসে ঢুকতে পারবে না যতক্ষণ `DATABASE_URL` না বদলাও | `.env`-এ `POS_APP_PASSWORD` বদলে `npm run db:migrate`, তারপর `DATABASE_URL` secret বদলান |
| `postgres` পাসওয়ার্ড | শুধু মাইগ্রেশন/ব্যাকআপ ব্যাহত | Dashboard-এ রিসেট, `.env` হালনাগাদ |
| `SUPABASE_ACCESS_TOKEN` (CI) | অটো-ডিপ্লয় থামবে | নতুন টোকেন বানিয়ে GitHub Actions secret বদলান |
কোনো গোপন তথ্য ফাঁস হলে প্রথমে বাতিল/বদল, তারপর খোঁজ।

## ৮. ঘটনা ঘটলে প্রথম ১০ মিনিট
1. `/health` ও একটি লগইন: কোনটি ভাঙছে?
2. Supabase Dashboard → Edge Functions → `api` → লগ (৫০০-তে `internal` এখানে লেখা হয়)।
3. সাম্প্রতিক ডিপ্লয় সন্দেহজনক হলে ২ নম্বর (revert)।
4. ডেটাবেস সংযোগ ত্রুটি: `DATABASE_URL` (পোর্ট ৬৫৪৩, ইউজার `pos_app.<ref>`) ঠিক কি না, পাসওয়ার্ড বদল হয়েছে কি না।
5. লগইনে ঘন ঘন ৪২৯: রেট লিমিট (`auth_attempts` টেবিল); ১৫ মিনিট পর খোলে। কেউ জেনেবুঝে অন্যের নম্বরে চেষ্টা করে লক করে দিতে পারে (জানা সীমাবদ্ধতা)।
6. ডেটা নষ্ট বা হারানোর সন্দেহ: **আর কোনো লেখার আগে ৪ নম্বর ব্যাকআপ নিন**, তারপর ৫/৬।

| লক্ষণ | সম্ভাব্য কারণ | প্রথম কাজ |
|---|---|---|
| সব ফোনে "সার্ভারে পৌঁছানো যাচ্ছে না", `/health` ঠিক | CORS (`ALLOWED_ORIGINS`-এ ফ্রন্টএন্ডের ঠিকানা নেই) | secret দেখুন |
| এক কর্মচারীর ফোনে "সিংক থেমে আছে" | টোকেনের মেয়াদ/ভূমিকা-সীমা (৪০৩/৪০১) | লগআউট-লগইন; মালিকের কিউ-করা ইভেন্ট কর্মচারী পাঠাতে পারে না (ফ্রন্টএন্ড রানবুক) |
| `/health` ৫০৩ `db: down` | `DATABASE_URL`/পাসওয়ার্ড/Supabase সমস্যা | ৪ নম্বর ধাপ |
| নতুন কোড ডিপ্লয়ের পর ৫০০ | স্কিমা পুরনো (মাইগ্রেশন চলেনি) | ৩ নম্বর যাচাই-ধাপ |

## ৮ক. ফ্রন্টএন্ড ক্র্যাশ রিপোর্ট দেখা
অ্যাপ ভাঙলে ফোন থেকে `client_errors` টেবিলে রিপোর্ট জমে (বাইরের কোনো সেবায় যায় না)। SQL এডিটরে (মালিকের ভূমিকায়):
```sql
SELECT last_at, count, kind, message, path, app_version, left(stack, 300) FROM client_errors ORDER BY last_at DESC LIMIT 50;
```
একই ত্রুটি আবার এলে `count` বাড়ে। বিল/পণ্যের তথ্য রিপোর্টে যায় না; পথ থেকে `?`/`#` কাটা। ৩০ দিন পর সারি নিজে সাফ হয় (সব ইনসার্টে নয়, কিছু ইনসার্টে সম্ভাবনা-ভিত্তিক)।

## ৯. মহড়া (restore drill): ❌ এখনো একবারও হয়নি
**এটি হস্তান্তরের আগের বাধ্যতামূলক কাজ।** যা লাগবে: একটি আলাদা (খালি) Supabase প্রজেক্ট, `pg_dump`/`pg_restore` ইনস্টল করা কম্পিউটার, আর লাইভ প্রজেক্টের `DATABASE_URL_UNPOOLED` (শুধু আপনার `.env`-এ, চ্যাটে নয়)।
- [ ] ৪ নম্বরের `pg_dump` চালিয়ে ফাইল তৈরি; `pg_restore --list` দিয়ে খুলে দেখা।
- [ ] ৬ নম্বরের ধাপ ১-৪ স্টেজিং প্রজেক্টে; সারি-গণনা মেলানো।
- [ ] স্টেজিং-এ `/health` ও একটি লগইন (একটি পরীক্ষামূলক দোকান দিয়ে), RLS যাচাই (৩-এর ধাপ ৬)।
- [ ] Dashboard → Database → Backups-এ আপনার প্ল্যানের নাম ও মেয়াদ লিখুন: ________

**প্রমাণ-ছক (চালানোর পর পূরণ করুন; পাসওয়ার্ড/URL লিখবেন না):**
| তারিখ | কে | সোর্স প্রজেক্ট (ref-এর শেষ ৪ অক্ষর) | স্টেজিং (শেষ ৪ অক্ষর) | dump-এর আকার | restore-এর সময় | টেবিল-সারি মিলেছে? | `/health` | লগইন | সমস্যা/টীকা |
|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | |

## ১০. রুটিন রক্ষণাবেক্ষণ
| কত ঘন ঘন | কাজ |
|---|---|
| প্রতিদিন | `/health` একবার (আদর্শে একটি আপটাইম-মনিটর বসান: ⚠ এখন নেই) |
| সপ্তাহে | হাতে `pg_dump` (৪), দুই জায়গায় রাখা; `client_errors` দেখা (৮ক) |
| মাসে | `npm audit --omit=dev` (CI-তে প্রতি রানে আছে); Supabase ব্যবহার/ডিস্ক দেখা (`sync_events` বাড়তে থাকে, মেয়াদ/সাফাইয়ের নিয়ম নেই — জানা সীমাবদ্ধতা) |
| প্রতি বড় মাইগ্রেশনের আগে | ব্যাকআপ + ৩ নম্বরের ধাপ |
| ত্রৈমাসিক | গোপন তথ্য বদল (৭), restore-মহড়া আবার |

## ১১. যা এখনো যাচাই হয়নি
- ❌ restore-মহড়া (৯); `pg_dump` এই কাজের কম্পিউটারে ইনস্টলই ছিল না।
- ⚠ লাইভে কোন মাইগ্রেশন/কোড চলছে (১ ও ৩); `/health` পুরনো আকারে উত্তর দিচ্ছে।
- ⚠ লাইভ API-তে লোড ও আসল পাসওয়ার্ডে scrypt-এর সময়।
- ⚠ Supabase-এর নিজস্ব পরিবেশে (pooler, লাইভ রোল) ইন্টিগ্রেশন টেস্ট; CI-র টেস্ট সাধারণ Postgres 16-এ।
- ⚠ Supabase edge সবসময় `cf-connecting-ip` সেট করে কি না (রেট-লিমিট এর ওপর নির্ভর করে)।

## মাইগ্রেশন-খাতা (লাইভে প্রয়োগের ইতিহাস; প্রতিবার এক লাইন যোগ করুন)
| তারিখ | ফাইল | কে | ব্যাকআপ ফাইল | ফল |
|---|---|---|---|---|
| (এখনো কিছু লেখা হয়নি; লাইভের বর্তমান অবস্থা ৩-এর ধাপ ২-এর প্রশ্ন দিয়ে দেখে প্রথম লাইন বসান) | | | | |
