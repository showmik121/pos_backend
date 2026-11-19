# অনবোর্ডিং গাইড: POS (ব্যাকএন্ড)

## ১. এক নজরে
ফার্মেসি ও কসমেটিক্স দোকানের POS-এর API। TypeScript, **একই কোড** Node (লোকাল) ও Supabase Edge Function (Deno, লাইভ) দুই জায়গায় চলে। ডাটাবেস Supabase PostgreSQL। ফ্রন্টএন্ড: `showmik121/pos_fontend`। রানবুক: `docs/RUNBOOK.md`; সীমাবদ্ধতা: `POS_SYSTEM/docs/KNOWN_LIMITATIONS.md`।

## ২. আর্কিটেকচার

```
ব্রাউজার ──HTTPS, Bearer JWT──►  Supabase Edge  supabase/functions/api/index.ts
                                      └─ app.bundle.js (esbuild, edge/build.mjs)
                                           └─ edge/entry.ts ─► server/config.ts (env পড়ে)
                                                                  └─ server/app.ts  createApp()
                                                                       ├─ server/routes/* (products, stock; অন্য শাখায় আরও)
                                                                       ├─ src/auth (scrypt, JWT, পাসওয়ার্ড-শক্তি, common-passwords)
                                                                       ├─ src/domain (বিশুদ্ধ নিয়ম)
                                                                       └─ src/db/pg*.ts ──► PostgreSQL (RLS, pos_app রোল)
লোকাল: server/index.ts (Node) ─► একই server/app.ts
টেস্ট:  src/db/memory*.ts (ডাটাবেস ছাড়া)
```

## ৩. এন্ট্রি পয়েন্ট

| কী খুঁজছেন | কোথায় |
|---|---|
| সব রুট ও অনুরোধ-প্রবাহ | `server/app.ts` (`createApp`, `route`); পণ্য/স্টক `server/routes/` |
| env থেকে অ্যাপ বানানো | `server/config.ts` (`DATABASE_URL`, `JWT_SECRET`, `ALLOWED_ORIGINS`, `TOKEN_TTL_SECONDS`, `DB_POOL_MAX`) |
| লাইভ এন্ট্রি (Deno) | `supabase/functions/api/index.ts` → `edge/entry.ts` |
| ডাটাবেস ইন্টারফেস | `src/db/types.ts` (`Repo`) ও `catalog.ts`, `stock.ts` |
| আসল SQL | `src/db/pg.ts`, `pg-catalog.ts`, `pg-stock.ts` |
| স্কিমা, RLS, রোল, অনুমতি | `db/migrations/001…006_*.sql` |
| সিংক (ইভেন্ট-লগ) | `server/app.ts` (`/v1/sync/*`, `SYNC_STAFF_KINDS`), `db/migrations/004_sync.sql` |
| পাসওয়ার্ড / টোকেন / লগইন সীমা | `src/auth/*`; সীমা `server/app.ts` + DB ফাংশন `auth_throttle` |
| টাকা, ইউনিট, মেয়াদ, FIFO, কার্ট | `src/domain/*` |
| গোল্ডেন ফিক্সচার (ফ্রন্টএন্ডের সাথে আচরণ এক) | `tests/fixtures/domain/*.json`, `fixtures.lock` |
| Deno-তে scrypt/JWT যাচাই | `edge/smoke-test.mjs` |
| CI ও অটো-ডিপ্লয় | `.github/workflows/ci.yml` |

## ৪. একটি অনুরোধের জীবন (যেমন `GET /api/v1/me`)
1. Edge ফাংশন `/api/...` পাথসহ অনুরোধ পায়; `server/app.ts` প্রিফিক্স `/api` কেটে `route()`-এ দেয়।
2. CORS: `ALLOWED_ORIGINS`-এর তালিকায় না থাকলে ব্রাউজার আটকায়।
3. `authenticate()`: `Authorization: Bearer` থেকে JWT যাচাই (শুধু HS256), তারপর **ডাটাবেস থেকে ব্যবহারকারী ও ভূমিকা আবার পড়া হয়** (টোকেনের দাবি বিশ্বাস করা হয় না; বন্ধ করা ব্যবহারকারীর টোকেন সঙ্গে সঙ্গে অচল)।
4. ইনপুট যাচাই (`cleanText`, `normalizePhone`…); ভুল হলে `DomainError` (বাংলা বার্তা)।
5. `repo.*` ডাকে: প্রতি অনুরোধ একটি ট্রানজ্যাকশনে `set_config('app.store_id', …, true)` বসায়; **RLS** তাই শুধু ওই দোকানের সারি দেখায়।
6. উত্তর `{status, body}`; ভুলে `{ error: { code, message, details } }`।

## ৫. নিরাপত্তা-স্থাপত্য
- অ্যাপ সবসময় `pos_app` (NOBYPASSRLS) রোল দিয়ে যায়; `postgres` রোলে RLS কাজ করে না, তাই সেটি দিয়ে অ্যাপ সংযোগ নয়।
- প্রতিটি টেবিলে `store_id` ও RLS পলিসি; নতুন টেবিলে স্পষ্ট `GRANT`ও (ডিফল্টে `pos_app` কিছু পায় না)।
- `anon`/`authenticated` রোলের অনুমতি তুলে নেওয়া; Supabase Data API ব্যবহার হয় না।
- লগইন ব্যর্থতায় নম্বর/IP-ভিত্তিক সীমা (ডাটাবেসে); ব্যবহারকারী না থাকলেও dummy hash যাচাই হয়।
- **সিংকে ভূমিকা-নিয়ম:** কর্মচারী শুধু `product_upserted`, `stock_in`, `customer_upserted`, `sale_completed`, `due_received` পাঠাতে পারে; বাকি সব (এবং অচেনা নতুন ধরন) মালিক-মাত্র। নতুন ইভেন্ট-ধরন যোগ করলে `SYNC_STAFF_KINDS` সচেতনভাবে বদলান এবং ফ্রন্টএন্ডে আগে ডিপ্লয় করুন (`docs/RUNBOOK.md` ২)।
- জানা ফাঁক (বিস্তারিত KNOWN_LIMITATIONS): pull সব ভূমিকাকে কাঁচা পেলোড দেয়, তাই কর্মচারী ইভেন্ট থেকে ক্রয়মূল্য পড়তে পারে।
- সাম্প্রতিক নিরাপত্তা-পর্যালোচনায় (২০২৬-১১-২০) CRITICAL পাওয়া যায়নি; HIGH একটি (সিংকের ভূমিকা-ফাঁক) আংশিক ঠিক হয়েছে; MEDIUM/LOW তালিকা `KNOWN_LIMITATIONS.md`-তে।

## ৬. ডোমেইন নিয়ম
টাকা পূর্ণসংখ্যা পয়সায় (`bigint`, কলাম `*_poisha`); স্টক পিসে; বিক্রি FIFO ব্যাচে, মেয়াদোত্তীর্ণ বাদ; মেয়াদ মাসের শেষ তারিখ; মোবাইল নম্বর ইংরেজি অঙ্কে স্বাভাবিক।

**ডেটা দুই পথে আসে:** (ক) REST: `POST/GET /v1/products`, `/v1/products/{id}/stock-ins`, `/v1/batches`, `/v1/batch-removals` (`server/routes/`); (খ) সিংক-ইভেন্ট: ফ্রন্টএন্ড সব বদল ইভেন্ট হিসেবে `POST /v1/sync/push` করে; সার্ভার শুধু `sync_events` লগে রাখে। **লগ থেকে `products`/`sales`/`due_ledger` টেবিলে প্রজেক্ট করার কাজ `main`-এ নেই** (আলাদা শাখায় আধা-তৈরি, মার্জ হয়নি; ফলে সার্ভার-সাইড রিপোর্ট ও মালিকের অন্য-ফোন থেকে দেখা এখনো নেই)।

## ৭. কনভেনশন
- `src/domain` বিশুদ্ধ (I/O নয়); ডাটাবেস প্রবেশ `Repo` ইন্টারফেসের আড়ালে।
- সব SQL parameterized; স্ট্রিং জুড়ে SQL নিষেধ।
- ভুলের বার্তা বাংলায়, `DomainError` দিয়ে।
- নতুন ফিচারে আগে ব্যর্থ টেস্ট (`tests/unit/`), তারপর কোড। কমিটের আগে `npm run typecheck && npm test`।
- দুই রিপোতে থাকা নিয়ম বদলালে: আগে ফিক্সচার (ফ্রন্টএন্ডে), `node scripts/golden-lock.mjs`, তারপর এখানে কপি।
- কমিট: `type: বর্ণনা`। শুধু ডক বদলালে মেসেজে `[skip ci]` (নইলে অটো-ডিপ্লয় চলে)।
- `.gitattributes` ফিক্সচার LF রাখে (গোল্ডেন-হ্যাশের জন্য); ফাইল-শেষ বদলাবেন না।

## ৮. প্রথম দিন
```bash
git clone https://github.com/showmik121/pos_backend && cd pos_backend
npm ci                   # লকফাইল কমিট করা আছে; npm install নয়
npm run typecheck
npm test                 # ১৩১টি ইউনিট-টেস্ট, ডাটাবেস ছাড়া
npm run build:edge       # Edge বান্ডল
cp .env.example .env     # মান বসান (গোপন, কমিট নয়)
npm run dev              # http://localhost:3001/api/health
```
- ✅ পরিষ্কার ক্লোনে এই ধাপগুলো এক চেষ্টায় পাস (২০২৬-১১-২০; প্রমাণ `POS_SYSTEM/docs/handover-evidence/`)। `npm test` চালানোর সময় `password authentication failed for user pos_app` লাইনটি দেখাবে: এটি ইচ্ছাকৃত টেস্ট (`tests/unit/api.test.ts`), ডাটাবেস-ডাউন নকল করে।
- ইন্টিগ্রেশন টেস্ট (`npm run test:integration`) আসল Postgres 16 ও `pos_app` লাগে (`INTEGRATION_DATABASE_URL`); CI-র `postgres` জবে চলে। ⚠ Supabase-এর নিজস্ব পরিবেশে চালানো হয়নি।
- Supabase সেটআপ ও ডিপ্লয়ের ধাপ `README.md`-তে।

## ৯. জানা সীমাবদ্ধতা ও পরের কাজ
সম্পূর্ণ তালিকা: `POS_SYSTEM/docs/KNOWN_LIMITATIONS.md`। এখানে শুধু ডেভেলপারের জন্য শীর্ষ কয়টি:
- সিংক-প্রজেক্টর (লগ → রিলেশনাল টেবিল, রিপোর্ট, নেগেটিভ-স্টক সতর্কতা) বাকি; মাইগ্রেশন ০০৭-০০৯ অন্য শাখায় আছে কিন্তু মার্জ/পর্যালোচনা হয়নি।
- restore-মহড়া একবারও হয়নি; লাইভে কোন মাইগ্রেশন প্রয়োগ হয়েছে যাচাই হয়নি; লাইভ `/health` পুরনো আকারে উত্তর দিচ্ছে।
- কর্মচারীর কাছে ক্রয়মূল্য ফাঁস (সিংক-pull), ফোন-নম্বর দখল/গণনা, লগইন-লক ইচ্ছাকৃতভাবে ঘটানো যায়, `sync_events`-এর কোটা/মেয়াদ নেই (সব `KNOWN_LIMITATIONS.md`-তে ফাইল:লাইনসহ)।
