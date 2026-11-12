# pos_backend

ফার্মেসি ও কসমেটিক্স দোকানের POS এর ব্যাকএন্ড API। **TypeScript**, ডাটাবেস **Supabase PostgreSQL**, API চলে **Supabase Edge Function** হিসেবে (লোকালে সাধারণ Node সার্ভার হিসেবেও চলে)।

কাঠামো `Banglar_Biriyani_backend` এর মতো: `edge/` বান্ডেল, Deno স্মোক টেস্ট, GitHub Actions CI + অটো-ডিপ্লয়, `.bat` সহায়ক স্ক্রিপ্ট।

## ফোল্ডার

| পথ | কাজ |
|---|---|
| `server/app.ts` | পুরো API (Web-standard `Request → Response`; Node ও Deno দুটোতেই একই কোড) |
| `server/index.ts` | লোকাল Node সার্ভার (`npm run dev`) |
| `server/config.ts` | পরিবেশ-চলক থেকে app বানায় |
| `src/domain/` | টাকা (পয়সা), ইউনিট, মেয়াদ, FIFO, বিল/পেমেন্ট, ফোন — বিশুদ্ধ ফাংশন |
| `src/auth/` | scrypt পাসওয়ার্ড, HS256 JWT, লগইন-ব্যর্থতার সীমা |
| `src/db/` | `types.ts` (ইন্টারফেস), `pg.ts` (Supabase/postgres.js), `memory.ts` (টেস্ট) |
| `db/migrations/` | SQL স্কিমা (RLS, `pos_app` রোল, অনুমতি) |
| `edge/` | `build.mjs` (esbuild বান্ডেল), `entry.ts`, `smoke-test.mjs` (Deno) |
| `supabase/` | `config.toml`, `functions/api/index.ts` (Edge এন্ট্রি) |
| `tests/unit/` | vitest ইউনিট টেস্ট (ডাটাবেস লাগে না) |

## URL

- লোকাল: `http://localhost:3001/api/...`
- লাইভ: `https://<PROJECT_REF>.supabase.co/functions/v1/api/...`

রুট (প্রিফিক্স `/api`): `GET /health`, `POST /v1/auth/register-store`, `POST /v1/auth/login`, `GET /v1/me`, `GET|POST /v1/staff`, `PATCH /v1/staff/:id`।
লগইন টোকেন `Authorization: Bearer <token>` হেডারে যায় (কুকি নয় — অফলাইন PWA এর জন্য)।
ত্রুটির আকার: `{ "error": { "code", "message", "details" } }`, বার্তা বাংলায়।

## প্রথমবার সেটআপ (Supabase)

1. Supabase এ প্রজেক্ট বানান। **Project ID** (`Project Settings → General`) আর **Database password** হাতে রাখুন।
2. `.env.example` কপি করে `.env` বানান:
   - `DATABASE_URL_UNPOOLED` = *Connect → Session pooler* স্ট্রিং, ইউজার `postgres.<ref>`
   - `POS_APP_PASSWORD` = নিজের বানানো ১৬+ অক্ষরের পাসওয়ার্ড
   - `DATABASE_URL` = *Transaction pooler* (6543) স্ট্রিং, কিন্তু ইউজার **`pos_app.<ref>`** আর পাসওয়ার্ড `POS_APP_PASSWORD`
   - `JWT_SECRET` = `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
3. `db-migrate.bat` ডাবল-ক্লিক → টেবিল, RLS, `pos_app` রোল তৈরি।
4. `deploy-supabase.bat` ডাবল-ক্লিক → Edge secrets বসিয়ে `api` ফাংশন ডিপ্লয়। শেষে `/health` পরীক্ষা করে।
5. (অটো-ডিপ্লয়) GitHub repo → *Settings → Secrets and variables → Actions* এ `SUPABASE_ACCESS_TOKEN` যোগ করুন
   (Supabase → Account → Access Tokens)। এরপর `main` এ push করলেই টেস্ট → Deno বিল্ড → ডিপ্লয় → `/health` যাচাই চলবে।

> গোপন তথ্য (পাসওয়ার্ড, JWT_SECRET, access token) কখনো GitHub বা চ্যাটে দেবেন না। শুধু Project ID গোপন নয়।

## কেন `pos_app` রোল?

Supabase এর `postgres` রোল Row Level Security **এড়িয়ে যায়**। এক দোকানের ডেটা অন্য দোকান থেকে আলাদা রাখার মূল ব্যবস্থা RLS, তাই API সবসময় `pos_app` (NOBYPASSRLS) দিয়ে সংযোগ করে। প্রতিটি অনুরোধ একটি ট্রানজ্যাকশনে `set_config('app.store_id', …, true)` বসায়, ফলে Transaction pooler এও নিরাপদ। মাইগ্রেশন `anon`/`authenticated` রোলের সব অনুমতি তুলে নেয় (আমরা Supabase Data API ব্যবহার করি না)।

## লোকালে চালানো

```
npm install
npm run dev          # http://localhost:3001/api/health
npm test             # ইউনিট টেস্ট
npm run typecheck
node edge/build.mjs  # Edge বান্ডেল (supabase/functions/api/app.bundle.js)
```

`npm install` প্রথমবার `package-lock.json` বানাবে — সেটি commit করে দিলে ভালো।

## যা এখনও আসল পরিবেশে যাচাই হয়নি

- `src/db/pg.ts` ও SQL মাইগ্রেশন আসল Supabase/PostgreSQL এর বিরুদ্ধে চালানো হয়নি (টেস্ট ইন-মেমরি রিপোজিটরি দিয়ে)।
- Deno তে scrypt/বান্ডেল: CI এর `supabase-edge` জব `edge/smoke-test.mjs` দিয়ে এটি যাচাই করে। scrypt (N=16384) Edge এর CPU সীমায় ধীর হলে প্যারামিটার কমাতে হতে পারে।
- লগইন-সীমা মেমরিতে (প্রতি Edge instance এ আলাদা) — পরে ডাটাবেস টেবিলে সরানো হবে।
- Supabase ফ্রি প্ল্যানে ১ সপ্তাহ অব্যবহৃত থাকলে প্রজেক্ট pause হয় এবং ব্যাকআপ নেই — আসল দোকানের আগে Pro প্ল্যান ভাবুন।
