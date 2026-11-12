# pos_backend

ফার্মেসি ও কসমেটিক্স দোকানের POS — ব্যাকএন্ড API (Node.js + PostgreSQL)। ফ্রন্টএন্ড: `pos_fontend` (Next.js PWA)।
প্রোডাক্টের সিদ্ধান্ত ও রিকোয়ারমেন্টের মূল উৎস হলো PRD ডক।

## চালানো

```bash
npm install
cp .env.example .env        # JWT_SECRET ও ডাটাবেস ইউজার বসান
npm run migrate             # db/migrations/*.sql চালায়
npm start
npm test                    # ডাটাবেস ছাড়াই চলে (node --test)
```

ডাটাবেসে দুটি রোল রাখুন: `pos_owner` (টেবিলের মালিক, শুধু মাইগ্রেশনে) আর `pos_app` (অ্যাপ চলে এটা দিয়ে)।
RLS শুধু মালিক নয় এমন রোলের ওপর কাজ করে, তাই অ্যাপ কখনো `pos_owner` দিয়ে চালাবেন না।

```sql
CREATE ROLE pos_owner LOGIN PASSWORD '...';
CREATE ROLE pos_app   LOGIN PASSWORD '...';
CREATE DATABASE pos OWNER pos_owner;
```

## কাঠামো

| পথ | কাজ |
|---|---|
| `db/migrations/001_init.sql` | স্কিমা + RLS + append-only ট্রিগার |
| `src/domain/` | খাঁটি ব্যবসায়িক নিয়ম, ডাটাবেস ছাড়া: টাকা (পয়সা), কার্টন→পিস, মেয়াদ, FIFO, বিলের হিসাব, ফোন |
| `src/auth/` | scrypt পাসওয়ার্ড, HS256 টোকেন (বাইরের লাইব্রেরি ছাড়া) |
| `src/http/app.js` | রাউট: দোকান খোলা, লগইন, /me, স্টাফ |
| `src/repo/memory.js` | টেস্টের ইন-মেমরি রিপোজিটরি |
| `src/repo/pg.js` | PostgreSQL রিপোজিটরি (প্রতি রিকোয়েস্টে `app.store_id` সেট করে) |

## API (এখন পর্যন্ত)

- `POST /v1/auth/register-store` `{ storeName, storeKind, ownerName, phone, password }` → `201 { token, user }`
- `POST /v1/auth/login` `{ phone, password }` → `{ token, user }` (৫ বার ভুলে ১৫ মিনিট আটকায়)
- `GET /v1/me` → `{ user, store }`
- `GET /v1/staff`, `POST /v1/staff`, `PATCH /v1/staff/:id { active }` — শুধু মালিক

ত্রুটির আকার: `{ "error": { "code", "message", "details" } }`, বার্তা বাংলায়।

## নিয়ম (ভাঙবেন না)

- টাকা কোডে সবসময় পয়সা (পূর্ণসংখ্যা); ডাটাবেসে `numeric(12,2)`।
- স্টক সবসময় পিসে; `stock_movements` ও `due_ledger` শুধু যোগ হয়।
- প্রতিটি দোকান-সংক্রান্ত কোয়েরি `withStore()` এর ভেতরে চলবে।
- বিক্রি/মুভমেন্টের `id` ক্লায়েন্ট বানায় (UUID) — অফলাইন সিংক ইডেমপোটেন্ট রাখতে।

## অবস্থা

- ✅ `npm test` পাস (ডোমেইন, অথ, HTTP — ইন-মেমরি রিপোজিটরিতে)।
- ⚠️ `001_init.sql` ও `src/repo/pg.js` আসল PostgreSQL এ এখনো চালানো হয়নি। প্রথমবার চালিয়ে দেখুন।
- ⏭️ পরের ধাপ: পণ্য ও স্টক এন্ট্রি API, বিক্রি (`/v1/sales` সিংক), বাকির খাতা।
