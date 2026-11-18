# অনবোর্ডিং গাইড: POS (ব্যাকএন্ড)

## ১. এক নজরে
ফার্মেসি ও কসমেটিক্স দোকানের POS-এর API। TypeScript, **একই কোড** Node (লোকাল) ও Supabase Edge Function (Deno, লাইভ) দুই জায়গায় চলে। ডাটাবেস Supabase PostgreSQL। ফ্রন্টএন্ড: `showmik121/pos_fontend`।

## ২. আর্কিটেকচার

```
ব্রাউজার ──HTTPS, Bearer JWT──►  Supabase Edge  supabase/functions/api/index.ts
                                      └─ app.bundle.js (esbuild, edge/build.mjs)
                                           └─ edge/entry.ts ─► server/config.ts (env পড়ে)
                                                                  └─ server/app.ts  createApp()
                                                                       ├─ src/auth (scrypt, JWT, পাসওয়ার্ড-শক্তি, common-passwords)
                                                                       ├─ src/domain (বিশুদ্ধ নিয়ম)
                                                                       └─ src/db/pg.ts ──► PostgreSQL (RLS, pos_app রোল)
লোকাল: server/index.ts (Node) ─► একই server/app.ts
টেস্ট:  src/db/memory.ts (ডাটাবেস ছাড়া)
```

## ৩. এন্ট্রি পয়েন্ট

| কী খুঁজছেন | কোথায় |
|---|---|
| সব রুট ও অনুরোধ-প্রবাহ | `server/app.ts` (`createApp`, `route`) |
| env থেকে অ্যাপ বানানো (`DATABASE_URL`, `JWT_SECRET`, `ALLOWED_ORIGINS`, `TOKEN_TTL_SECONDS`, `DB_POOL_MAX`) | `server/config.ts` |
| লাইভ এন্ট্রি (Deno) | `supabase/functions/api/index.ts` → `edge/entry.ts` |
| লোকাল সার্ভার | `server/index.ts` |
| ডাটাবেস ইন্টারফেস | `src/db/types.ts` (`Repo`) |
| আসল SQL | `src/db/pg.ts` |
| স্কিমা, RLS, রোল, অনুমতি | `db/migrations/001_init.sql` |
| পাসওয়ার্ড / টোকেন / লগইন সীমা | `src/auth/password.ts`, `token.ts`, `common-passwords.ts`; লগইন/নিবন্ধন সীমা `server/app.ts` + DB ফাংশন `auth_throttle` |
| টাকা, ইউনিট, মেয়াদ, FIFO, বিল | `src/domain/*` |
| Deno-তে scrypt/JWT যাচাই | `edge/smoke-test.mjs` |
| CI ও অটো-ডিপ্লয় | `.github/workflows/ci.yml` |

## ৪. একটি অনুরোধের জীবন (যেমন `GET /api/v1/me`)
1. Edge ফাংশন `/api/...` পাথসহ অনুরোধ পায়; `server/app.ts` প্রিফিক্স `/api` কেটে `route()`-এ দেয়।
2. CORS: `ALLOWED_ORIGINS`-এর তালিকায় না থাকলে ব্রাউজার আটকায়।
3. `authenticate()`: `Authorization: Bearer` থেকে JWT যাচাই (শুধু HS256); ব্যর্থ হলে `unauthorized`।
4. ইনপুট যাচাই (`cleanText`, `normalizePhone` ইত্যাদি); ভুল হলে `DomainError` (বাংলা বার্তা)।
5. `repo.*` ডাকে: প্রতি অনুরোধ একটি ট্রানজ্যাকশনে `set_config('app.store_id', …, true)` বসায়; **RLS** তাই শুধু ওই দোকানের সারি দেখায়।
6. উত্তর `{status, body}`; ভুলে `{ error: { code, message, details } }`।

## ৫. নিরাপত্তা-স্থাপত্য
- অ্যাপ সবসময় `pos_app` (NOBYPASSRLS) রোল দিয়ে যায়; `postgres` রোলে RLS কাজ করে না, তাই সেটি দিয়ে অ্যাপ সংযোগ নয়।
- প্রতিটি টেবিলে `store_id` ও RLS পলিসি; নতুন টেবিলেও বাধ্যতামূলক।
- `anon`/`authenticated` রোলের অনুমতি তুলে নেওয়া; Supabase Data API ব্যবহার হয় না।
- লগইন ব্যর্থতায় নম্বরভিত্তিক সীমা; ব্যবহারকারী না থাকলেও dummy hash যাচাই হয় (সময় দেখে ব্যবহারকারী চেনা কঠিন করতে)।

## ৬. ডোমেইন নিয়ম
টাকা পূর্ণসংখ্যা পয়সায়; স্টক পিসে; বিক্রি FIFO ব্যাচে, মেয়াদোত্তীর্ণ বাদ; মেয়াদ মাসের শেষ তারিখ; মোবাইল নম্বর ইংরেজি অঙ্কে স্বাভাবিক। টাকার কলাম DB-তে `bigint` পয়সা (`*_poisha`, মাইগ্রেশন ০০২)। স্কিমায় `products`, `stock_batches`, `stock_movements`, `customers`, `sales`, `sale_items`, `payments`, `store_counters` আছে, **কিন্তু এসবের জন্য আলাদা CRUD রুট নেই; ডেটা সিংক হয় ইভেন্ট-লগ (`sync_events`, মাইগ্রেশন ০০৪) দিয়ে**: `POST /v1/sync/register-device|push`, `GET /v1/sync/pull`।

## ৭. কনভেনশন
- `src/domain` বিশুদ্ধ (I/O নয়); ডাটাবেস প্রবেশ `Repo` ইন্টারফেসের আড়ালে।
- সব SQL parameterized; স্ট্রিং জুড়ে SQL নিষেধ।
- ভুলের বার্তা বাংলায়, `DomainError` দিয়ে।
- নতুন ফিচারে আগে ব্যর্থ টেস্ট (`tests/unit/`), তারপর কোড। কমিটের আগে `npm run typecheck && npm test`।
- কমিট: `type: বর্ণনা`। শুধু ডক বদলালে মেসেজে `[skip ci]` (নইলে অটো-ডিপ্লয় চলে)।

## ৮. প্রথম দিন
```bash
git clone https://github.com/showmik121/pos_backend && cd pos_backend
npm install
npm test
cp .env.example .env     # মান বসান (গোপন, কমিট নয়)
npm run dev              # http://localhost:3001/api/health
```
Supabase সেটআপ ও ডিপ্লয়ের ধাপ `README.md`-তে।

## ৯. জানা সীমাবদ্ধতা ও পরের কাজ
- পণ্য, স্টক, বিক্রি, বাকি ও সিংকের API বানানো বাকি; ফ্রন্টএন্ডের `src/lib/domain` ও `src/lib/store` যুক্তির সাথে মেলাতে হবে।
- লাইভে লোড ও scrypt সময় পরীক্ষা হয়নি; ব্যাকআপ/restore পদ্ধতি `docs/RUNBOOK.md`-এ আছে, কিন্তু restore-মহড়া হয়নি।
- ইন্টিগ্রেশন টেস্ট (আসল PostgreSQL ও RLS বিরুদ্ধে) নেই; শুধু ইউনিট টেস্ট।
