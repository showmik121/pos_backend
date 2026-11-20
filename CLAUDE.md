# pos_backend — CLAUDE.md

ফার্মেসি ও কসমেটিক্স দোকানের POS-এর ব্যাকএন্ড API। **TypeScript**, ডাটাবেস **Supabase PostgreSQL**, API চলে **Supabase Edge Function** হিসেবে (লোকালে সাধারণ Node সার্ভার)। ফ্রন্টএন্ড আলাদা রিপো: `showmik121/pos_fontend`।

> এই রিপোর `main` ব্রাঞ্চই একমাত্র সত্য-উৎস। `main`-এ পুশ করলে CI পাস হওয়ার পর API নিজে থেকে Supabase-এ ডিপ্লয় হয়।

## কমান্ড
```bash
npm install
npm run dev          # http://localhost:3001/api/health (tsx watch)
npm run typecheck
npm test             # vitest run tests/unit (ডাটাবেস লাগে না)
npm run test:integration  # আসল Postgres + pos_app লাগে (INTEGRATION_DATABASE_URL); CI-র `postgres` জবে চলে
npm run build:edge   # esbuild বান্ডেল -> supabase/functions/api/app.bundle.js
npm run db:migrate   # db/migrations/*.sql চালায়
```
Node >= 20.12। `package-lock.json` কমিট করা আছে এবং CI `npm ci` চালায়; নতুন প্যাকেজ যোগ করলে `npm install <pkg>` চালিয়ে লকফাইলসহ কমিট করুন (`node_modules` কখনো কমিট নয়)। কমিটের আগে typecheck + test পাস করান।

## ফোল্ডার
| পথ | কাজ |
|---|---|
| `server/app.ts` | পুরো API; Web-standard `Request -> Response`, Node ও Deno দুটোতেই একই কোড |
| `server/index.ts`, `server/config.ts` | লোকাল Node সার্ভার; env থেকে app বানায় |
| `src/domain/` | বিশুদ্ধ ফাংশন: money (পয়সা), units, expiry, fifo, sale, phone, digits, errors |
| `src/auth/` | scrypt পাসওয়ার্ড (প্যারামিটারসহ সংরক্ষিত), HS256 JWT, দুর্বল-পাসওয়ার্ড বাতিল (`common-passwords.ts`) |
| `src/db/` | `types.ts` (ইন্টারফেস), `pg.ts` (postgres.js), `memory.ts` (টেস্টের জন্য) |
| `db/migrations/` | SQL স্কিমা, RLS, `pos_app` রোল |
| `edge/` | `build.mjs` (বান্ডেল), `entry.ts`, `smoke-test.mjs` (Deno) |
| `supabase/` | `config.toml`, `functions/api/index.ts` (Edge এন্ট্রি) |
| `tests/unit/` | api, auth, domain, sync, throttle টেস্ট (ইন-মেমরি) |
| `tests/integration/` | আসল Postgres-এ মাইগ্রেশন-পরবর্তী RLS, সিংক, থ্রটল, অনুমতি |

## API (প্রিফিক্স `/api`)
`GET /health`, `POST /v1/auth/register-store`, `POST /v1/auth/login`, `GET /v1/me`, `PATCH /v1/store` (মালিক, শুধু নাম), `GET|POST /v1/staff`, `PATCH /v1/staff/:id`, সিংক: `POST /v1/sync/register-device`, `POST /v1/sync/push`, `GET /v1/sync/pull?after=&limit=`; ক্র্যাশ রিপোর্ট: `POST /v1/client-errors` (লগইন ছাড়াও; IP প্রতি ঘণ্টায় ১০, মোট ১০০; বডি ≤১৬ KB; `record_client_error` ফাংশন দিয়ে `client_errors` টেবিলে, একই ত্রুটিতে গোনা বাড়ে, ৩০ দিন পর সাফ)।

### সিংক (ইভেন্ট-লগ)
ক্লায়েন্ট প্রতিটি কাজকে অপরিবর্তনীয় ইভেন্ট (`id` uuid ক্লায়েন্ট-জেনারেটেড, `kind`, `at`, `payload`) হিসেবে push করে; একই `id` দুবার এলে একবারই থাকে। সার্ভার `seq` দেয়, pull সেই কার্সরে। ডিভাইস নিবন্ধনে দোকান-ভিত্তিক কোড (A, B…) মেলে, যা বিল নম্বরের উপসর্গ ("A-1001")। কনফ্লিক্টে "শেষ বদল জেতে" ক্লায়েন্ট রিপ্লে করার সময় `at` দেখে ঠিক করে; সার্ভার শুধু লগ রাখে। কর্মচারী শুধু `product_upserted`, `stock_in`, `customer_upserted`, `sale_completed`, `due_received` পাঠাতে পারে (`server/app.ts` `SYNC_STAFF_KINDS`, সাদা-তালিকা); বাকি সব ধরন (বাতিল, সেটিংস, ব্যাচ সরানো, অচেনা নতুন ধরন) মালিক-মাত্র, উত্তর ৪০৩ `forbidden`। নতুন ধরন যোগ করলে সচেতনভাবে এখানে খুলতে হবে। জানা সীমা: pull সব ভূমিকাকে কাঁচা পেলোড দেয়, তাই কর্মচারী ইভেন্টে ক্রয়মূল্য (`costPoisha`) দেখতে পায় (REST লুকায়); সমাধানে ফ্রন্টএন্ডও বদলাতে হবে (নইলে কর্মচারীর সম্পাদনা মালিকের মূল্য ঘষে দেবে)। `sync_events`-এ UPDATE/DELETE-এর অনুমতি নেই। `001`-এর রিলেশনাল টেবিল (products, sales…) এখনো ব্যবহার হয় না; রিপোর্টের জন্য পরে লগ থেকে প্রজেক্ট করা হবে।
- লাইভ: `https://<PROJECT_REF>.supabase.co/functions/v1/api/...`
- টোকেন `Authorization: Bearer <token>` হেডারে (কুকি নয়)।
- ত্রুটির আকার: `{ "error": { "code", "message", "details" } }`, বার্তা বাংলায়।

**এখনো নেই:** পণ্য, স্টক/ব্যাচ, বিক্রি, বাকি, সিংক-এর endpoint। স্কিমায় এসবের টেবিল আছে (`products`, `stock_batches`, `stock_movements`, `customers`, `sales`, `sale_items`, `payments`, `store_counters`) কিন্তু `server/app.ts`-এ রুট নেই। ফ্রন্টএন্ড এখন এসব ডেটা শুধু ফোনের `localStorage`-এ রাখে। নতুন endpoint বানালে ফ্রন্টএন্ডের `src/lib/domain` ও `src/lib/store` যুক্তির সাথে এখানের `src/domain` মিলিয়ে রাখুন।

## ডোমেইন নিয়ম (ভাঙা যাবে না)
- টাকা **পূর্ণসংখ্যা পয়সায়**, স্টক **পিসে**। কখনো float নয়।
- লগইন/নিবন্ধনের রেট লিমিট ডাটাবেসে (`auth_attempts` টেবিল, `auth_throttle()` SECURITY DEFINER ফাংশন): ফোন+IP, ফোন, IP আলাদা বাকেট। IP আসে `cf-connecting-ip` → `x-real-ip` → `x-forwarded-for`। `pos_app` রোলের শুধু প্রয়োজনীয় GRANT আছে (DELETE নেই); নতুন টেবিলে স্পষ্ট GRANT লাগবে। মাইগ্রেশন ০০২ লাইভে আগে প্রয়োগ করে তারপর কোড পুশ করতে হবে।
- বিক্রি **FIFO ব্যাচ** অনুযায়ী, মেয়াদোত্তীর্ণ ব্যাচ বাদ।
- মোবাইল নম্বর ইংরেজি অঙ্কে স্বাভাবিক করা হয় (`src/domain/phone.ts`, `digits.ts`)।
- ভুলের বার্তা বাংলায়, `DomainError` দিয়ে।

## নিরাপত্তা-স্থাপত্য (পরিবর্তনের আগে ভালো করে বুঝুন)
- **মাল্টি-টেন্যান্ট আলাদা রাখে Row Level Security।** API সবসময় `pos_app` রোল (NOBYPASSRLS) দিয়ে ডাটাবেসে যায়; Supabase-এর `postgres` রোল RLS এড়িয়ে যায়, তাই কখনো সেটি দিয়ে অ্যাপ সংযোগ করবেন না।
- প্রতিটি অনুরোধ একটি ট্রানজ্যাকশনে `set_config('app.store_id', …, true)` বসায় (Transaction pooler-এ নিরাপদ)। নতুন টেবিলে `store_id` ও RLS পলিসি বাধ্যতামূলক।
- মাইগ্রেশন `anon`/`authenticated` রোলের অনুমতি তুলে নেয়; আমরা Supabase Data API ব্যবহার করি না।
- JWT: শুধু HS256 (header-এর `alg` বিশ্বাস করা হয় না), `JWT_SECRET` কমপক্ষে ৩২ অক্ষর, মেয়াদ ১২ ঘণ্টা।
- পাসওয়ার্ড: scrypt, `scrypt$N$r$p$salt$hash` ফরম্যাট (প্যারামিটার বাড়ানো যায়)।
- CORS: `ALLOWED_ORIGINS` secret। নতুন ফ্রন্টএন্ড ঠিকানা এখানে যোগ না করলে ব্রাউজার আটকাবে।
- সব SQL parameterized (postgres.js)। স্ট্রিং জুড়ে SQL বানানো নিষেধ।

## পরিবেশ-চলক (শুধু নাম; মান কখনো কমিট নয়)
`DATABASE_URL` (Transaction pooler, ইউজার `pos_app.<ref>`), `DATABASE_URL_UNPOOLED` (মাইগ্রেশনের জন্য, ইউজার `postgres.<ref>`), `POS_APP_PASSWORD`, `JWT_SECRET`, `ALLOWED_ORIGINS`, `API_PORT`, `NODE_ENV`। উদাহরণ `.env.example`-এ।
গোপন তথ্য (পাসওয়ার্ড, `JWT_SECRET`, access token) GitHub বা চ্যাটে দেওয়া নিষেধ।

## ডিপ্লয় ও CI
`.github/workflows/ci.yml`: typecheck + unit test → Postgres 16 সার্ভিসে মাইগ্রেশন (দুইবার) + ইন্টিগ্রেশন টেস্ট → Deno-তে Edge বিল্ড → `main`-এ পুশ হলে Supabase ডিপ্লয় ও `/health` যাচাই (`SUPABASE_ACCESS_TOKEN` GitHub secret লাগে)। শুধু ডক বদলালে কমিট মেসেজে `[skip ci]` দিলে ডিপ্লয় এড়ানো যায়। হাতে ডিপ্লয়: `deploy-supabase.bat`, মাইগ্রেশন: `db-migrate.bat`।

## কনভেনশন
- ফাইল kebab-case; `src/domain` শুধু বিশুদ্ধ ফাংশন (I/O নয়)।
- ডাটাবেস প্রবেশ `src/db/types.ts` ইন্টারফেসের আড়ালে; টেস্টে `memory.ts`।
- নতুন ফিচার: আগে ব্যর্থ টেস্ট, তারপর কোড (`tests/unit/`)।
- কমিট: `type: বর্ণনা` (feat, fix, chore, docs, test, refactor)।

## জানা সীমাবদ্ধতা
- ডিপ্লয় করা লাইভ API-তে লোড বা আসল পাসওয়ার্ডে scrypt সময় আমাদের পরীক্ষা করা নেই।
- ব্যাকআপ/restore/rollback পদ্ধতি `docs/RUNBOOK.md`-এ লেখা, কিন্তু restore-মহড়া এখনো হয়নি।

## গোল্ডেন ফিক্সচার (ফ্রন্টএন্ডের সাথে আচরণ এক)
- `tests/fixtures/domain/*.json` ফ্রন্টএন্ড (`pos_fontend/tests/fixtures/domain`) থেকে হুবহু কপি; `tests/unit/golden.test.ts` চালায় ও `fixtures.lock` (SHA-256) মেলায়।
- `src/domain/{cart,fifo,expiry,units}.ts` ফ্রন্টএন্ডের `src/lib/domain`-এর সমতুল্য। সত্য-উৎস ফ্রন্টএন্ড: আগে সেখানে বদলান, তারপর JSON ও `fixtures.lock` এখানে কপি করে কোড মেলান।

## REST: পণ্য (`/v1/products`)
- রুট `server/routes/products.ts`; যাচাই `src/domain/product.ts`; রিপো `src/db/catalog.ts` (ইন্টারফেস), `pg-catalog.ts`, `memory-catalog.ts`। নতুন রুট-ফাইল `server/app.ts`-এর `route()` শেষে জোড়া হয়, `RouteCtx` (`server/http.ts`) দিয়ে।
- তৈরি = `POST` + ক্লায়েন্টের `id` (UUID): প্রথমবার ২০১, একই বডি আবার ২০০, ভিন্ন বডি ৪০৯ `id_conflict`। বারকোড দোকানের মধ্যে ইউনিক (৪০৯ `duplicate_barcode`)। তালিকা keyset (`limit` ১–২০০, `cursor` অস্বচ্ছ)।
- কর্মচারীর উত্তরে `costPoisha` সবসময় `null` (ক্রয়মূল্য মালিক-মাত্র); লেখায় কর্মচারী দিতে পারে।
- **মাইগ্রেশন ০০৬ লাইভে প্রয়োগ না হলে এই রুটগুলো লাইভে ব্যর্থ হবে**: আগে `pg_dump`, তারপর ০০৬ হাতে চালান, তারপর কোড মার্জ।

## REST: স্টক (জমা, ব্যাচ, সরানো)
- `POST /v1/products/{id}/stock-ins` (মালিক/স্টাফ): body `{id(রসিদ, ইডেমপোটেন্সি কী), qty, unit(piece|carton), batchNo, expiryDate, costPoisha, pricePoisha?, batchId?}`। ফার্মেসিতে ব্যাচ ও মেয়াদ বাধ্যতামূলক (৪২২ `batch_required`/`expiry_required`); কার্টন সাইজ ১ হলে ৪২২ `no_carton`। একই পণ্য+ব্যাচ নম্বর+মেয়াদ একই ব্যাচে মেশে, ফাঁকা নম্বরে প্রতিবার নতুন ব্যাচ। প্রথমবার ২০১, একই রসিদ আবার ২০০, ভিন্ন বডিতে ৪০৯ `id_conflict`। পণ্যের ক্রয়মূল্য (ও দিলে বিক্রয়মূল্য) বদলায়।
- `GET /v1/batches?productId&status=active|expired|expiring&expiringWithinDays&limit&cursor`: মেয়াদের ক্রমে (মেয়াদহীন শেষে), keyset কার্সর; `expiryClass`/`daysLeft` ঢাকার আজকের তারিখে; স্টাফের কাছে `costPoisha` null।
- `POST /v1/batches/{id}/removals` ও `GET /v1/batch-removals` শুধু মালিক; কারণ বাধ্যতামূলক (৪২২ `reason_required`); সরানো ব্যাচে স্টক শূন্য ও তালিকা-বহির্ভূত; ক্ষতি = পরিমাণ × ক্রয়মূল্য।
- একই (দোকান, পণ্য)-র স্টক-বদল `pg_advisory_xact_lock` দিয়ে এক এক করে চলে (FIFO বিক্রির সময়ও একই লক)।

## REST: কাস্টমার ও বাকির খাতা
- `POST /v1/customers` `{id, name, phone?}` (ফোন বাংলা/ইংরেজি অঙ্কে, `01XXXXXXXXX` আকারে সংরক্ষিত; ফোন না থাকলে `""`): ২০১ / একই বডি ২০০ / ভিন্ন বডিতে ৪০৯ `id_conflict` / একই ফোনে অন্য কাস্টমার ৪০৯ `duplicate_phone`। `GET /v1/customers?q&limit&cursor` (নামের ক্রমে), `GET /v1/customers/{id}`; সবখানে `balancePoisha`।
- `POST /v1/customers/{id}/payments` `{id, amount, method?}` (cash|bkash|nagad|rocket, ডিফল্ট cash; স্টাফও পারে): বাকির চেয়ে বেশি হলে ৪০৯ `overpay`; একই id আবার ২০০। কাস্টমার-সারি `FOR UPDATE` লক করে ব্যালান্স পড়া হয়, তাই সমান্তরাল আদায়ে ব্যালান্স ঋণাত্মক হয় না।
- `POST /v1/customers/{id}/opening-balances` `{id, amount}` শুধু মালিক।
- `GET /v1/customers/{id}/ledger` (নতুন আগে, কার্সর) ও `GET /v1/dues` (বাকি > ০, বেশি বাকি আগে, `totalDuePoisha` পুরো দোকানের)।
- খাতা `due_ledger`-এ চিহ্নযুক্ত পরিমাণ (বাকি বাড়লে +, কমলে −), kind: sale/opening/payment/void; API-তে `amountPoisha` সবসময় ধনাত্মক। বিলপ্রতি একটিই sale ও একটিই void এন্ট্রি (ইউনিক ইনডেক্স)। মাইগ্রেশন ০০৭ হাতে প্রয়োগের আগে `pg_dump`।

## REST: বিক্রি (sales)
- `POST /v1/sales` `{id, no, prefix?, customerId?, lines:[{productId, qty, discount?}], billDiscount?:{type:amount|percent, value}, payments:[{method, amount}], offline?, at?}` (স্টাফও পারে): ২০১ / একই বডি ২০০ / ভিন্ন বডিতে ৪০৯ `id_conflict` (বডির sha256 `request_hash`)। একই (উপসর্গ, নম্বর) অন্য id-তে ৪০৯ `duplicate_bill_no`। উত্তরের আকার FE-র `Sale`-এর মতো; ক্রয়মূল্য (`costPoisha`) স্টাফের কাছে `null`।
- হিসাব `domain/cart.ts` + `domain/fifo.ts` (গোল্ডেন ফিক্সচারে বাঁধা) ও `domain/sales.ts` (`planSale`/`planVoid`, বিশুদ্ধ)। অনলাইন বিলে স্টক কম হলে সবটা ফেরত, ৪০৯ `insufficient_stock`; বাকি রাখতে কাস্টমার বাধ্যতামূলক (`customer_required`)।
- `offline: true` (ফোনে অফলাইনে হওয়া বিল সার্ভারে আসছে): ক্লায়েন্টের `unitPrice` ও `at` (ভবিষ্যতে ৫ মিনিটের বেশি হলে ৪০০) মানা হয়; স্টকের বেশি হলেও নেওয়া হয় — ঘাটতি এক ব্যাচে চাপে (ব্যাচ ঋণাত্মক), বিল `oversold`, অ্যালোকেশনে `oversoldQty`; পণ্যের কোনো ব্যাচ না থাকলে খালি-নম্বরের নতুন ব্যাচ।
- `POST /v1/sales/{id}/void` `{reason}` শুধু মালিক: স্টক ফেরে (সরানো ব্যাচের অংশ ফেরে না → `lostQty`), বাকির খাতায় `void` এন্ট্রি (কাস্টমার পরে শোধ করে থাকলে শুধু বাকি-থাকা অংশ), উত্তরে `refundPoisha`; আবার বাতিলে ৪০৯ `already_voided`।
- `GET /v1/sales?from&to&customerId&limit&cursor` (বিক্রির সময়ে নতুন আগে; বাতিল বিলও থাকে), `GET /v1/sales/{id}`।
- লাইন `sale_items`, ব্যাচ-ভাগ `sale_allocations` (অপরিবর্তনীয়), পেমেন্ট `payments(seq)`; `sales`-এ শুধু `voided*` কলাম বদলানো যায়। লক-ক্রম (create ও void একই): বিল → পণ্য (id ক্রমে) → ব্যাচ-সারি (পণ্য, id ক্রমে) → কাস্টমার-সারি। মাইগ্রেশন ০০৮ হাতে প্রয়োগের আগে `pg_dump` (ডেটা থাকলে guard থামায়)।

## প্রজেক্টর (ইভেন্ট → টেবিল)
- `src/domain/projection.ts` (বিশুদ্ধ `toCommand`) ইভেন্টকে যাচাই করে কমান্ডে বদলায়; `src/db/pg-projection.ts` কমান্ড টেবিলে বসায়। `project(storeId, events)` একটি লেনদেনে চলে, advisory lock `proj:<store>`।
- অবস্থা `projection_events` (applied/deferred/ignored/failed); শেষ-বদল-জেতে ঘড়ি `projection_clocks`। নির্ভরতা না এলে `deferred` থাকে, পরের কলে `sync_events` থেকে আবার পড়া হয়।
- প্রতি ইভেন্ট সেভপয়েন্টে: একটি ব্যর্থ হলে `failed` লেখা হয়, বাকিরা আটকায় না। একই ইভেন্ট দুবার দিলে `duplicate`।
- ইভেন্টে শুধু নাম আছে, user id নেই, তাই `cashier_name`/`voided_by_name`/`by_name`/`removed_by_name` কলাম (মাইগ্রেশন ০০৯); পড়ার সময় `coalesce(users.name, ...)`।
- এখনো কোনো রাউট প্রজেক্টর ডাকে না (S8 `data_mode`-এ জোড়া হবে); লাইভে ০০৭–০০৯ বসানো বাকি।
