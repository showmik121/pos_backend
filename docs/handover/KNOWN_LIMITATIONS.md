# জানা সীমাবদ্ধতা (Known Limitations)

তারিখ: ২০২৬-১১-২০। এই তালিকা ইচ্ছাকৃতভাবে অপ্রিয় সত্য লেখে: ক্লায়েন্টকে হস্তান্তরের আগে ও পরে কী ঝুঁকি থেকে যাচ্ছে। প্রতিটি সারির পাশে প্রমাণ (ফাইল:লাইন বা টেস্ট) আছে; যেটির প্রমাণ নেই সেটি "অযাচাই" চিহ্নিত।

**মাত্রা:** 🔴 উচ্চ (ব্যবসা/ডেটা/টাকার ক্ষতি হতে পারে, হস্তান্তরের আগে সিদ্ধান্ত দরকার) · 🟠 মাঝারি · 🟡 নিম্ন।
**অবস্থা:** ❌ ঠিক হয়নি · ⚠ আংশিক · 🔎 অযাচাই (ঝুঁকি আছে কি না নিশ্চিত নই)।

## ক. ডেটা ও পুনরুদ্ধার

| # | মাত্রা | সীমাবদ্ধতা | ক্লায়েন্টের জন্য মানে | প্রমাণ | এখনকার উপায় | অবস্থা |
|---|---|---|---|---|---|---|
| A1 | 🔴 | **ব্যবসার আসল ডেটা (পণ্য, স্টক, বিল, বাকি) ফোনের ব্রাউজারে** (`localStorage`)। সার্ভারে যায় শুধু ইভেন্টের লগ হিসেবে; সার্ভার এ থেকে রিপোর্ট বা অন্য ফোনে "মালিকের দৃশ্য" বানায় না | ব্রাউজারের ডেটা মুছলে/ফোন হারালে/বদলালে ব্যাকআপ ছাড়া হিসাব যেতে পারে। মালিক অন্য ফোন থেকে বিক্রি দেখতে পারেন না | `src/lib/store/db.ts`; ব্যাকএন্ডে `sync_events` ছাড়া রিলেশনাল টেবিল ব্যবহার হয় না (ব্যাকএন্ড `CLAUDE.md`) | নিয়মিত "ব্যাকআপ ফাইল নামান" (অ্যাপ দিনে একবার মনে করায়) | ❌ |
| A2 | 🔴 | **`localStorage`-এর কোটা (~৫ MB) এবং প্রতি বদলে পুরো ডেটা আবার সেভ।** সিংক-কিউও একই কোটায় | ব্যস্ত দোকানে কয়েক সপ্তাহে সেভ ব্যর্থ হতে পারে (অ্যাপ সতর্ক করে, কিন্তু ব্যর্থ হলে নতুন বদল ফোনে সেভ হয় না) | `src/lib/store/backup.ts` (`STORAGE_LIMIT_CHARS`), GAP_ANALYSIS B3 | সেটিংসে সেভ-জায়গার সূচক দেখুন; ব্যাকআপ নিন। IndexedDB-তে সরানোর পরিকল্পনা লেখা, বাস্তবায়ন হয়নি | ❌ |
| A3 | 🔴 | **restore-মহড়া একবারও হয়নি** (ডাটাবেস) | ডাটাবেস নষ্ট হলে ফেরানোর ধাপ কাজ করবে কি না কেউ জানে না। এই কাজের কম্পিউটারে `pg_dump` ইনস্টলই ছিল না | ব্যাকএন্ড `docs/RUNBOOK.md` ৯ | RUNBOOK ৯-এর মহড়া চালান, প্রমাণ-ছক পূরণ করুন | ❌ |
| A4 | 🔴 | **লাইভে কোন কোড/মাইগ্রেশন চলছে নিশ্চিত নয়**; লাইভ `/health` `{"status":"ok"}` দেয়, কিন্তু বর্তমান কোড `{"status":"ok","db":"ok"}` দেয় | লাইভ API `main`-এর চেয়ে পুরনো বা অটো-ডিপ্লয় কাজ করছে না | `docs/handover/handover-evidence/live-checks.txt` | RUNBOOK ১ ও ৩-এর যাচাই-ধাপ | 🔎 |
| A5 | 🟠 | ব্যাকআপ ফাইল **এনক্রিপ্ট করা নয়** (গ্রাহকের নাম-ফোন, বিক্রি, বাকি সাদা লেখায়); `parseBackup` শুধু উপরের স্তর যাচাই করে | ফাইল হারালে/শেয়ার হলে গোপনীয়তা যায়; নষ্ট বা ভুয়া ফাইল ফেরালে অ্যাপ ভাঙতে পারে | `src/lib/store/backup.ts:44-55`, `db.ts:23-37` | ফাইল নিরাপদ জায়গায় রাখুন, অচেনা ফাইল ফেরাবেন না | ❌ |
| A6 | 🟠 | সার্ভারের `sync_events`-এর **কোটা/মেয়াদ/সাফাই নেই**; একটি অ্যাকাউন্ট দ্রুত অনেক ডেটা লিখে ডিস্ক ভরাতে পারে | সাপোর্ট/খরচ ও সব ক্লায়েন্টের সার্ভিস ঝুঁকি | `server/app.ts:40-41`, `src/db/pg.ts:134-147` | Supabase ডিস্ক-ব্যবহার মাসে দেখুন | ❌ |
| A7 | 🟠 | **দুই ফোনে একই ব্যাচ থেকে বেশি বিক্রি হলে স্টক ঋণাত্মক হয়, নীরবে**; কোনো সতর্কতা/রিপোর্ট নেই | স্টক-হিসাব ভুল, মালিক টের পান না | ফ্রন্টএন্ড `CLAUDE.md` "জানা সীমা"; GAP_ANALYSIS B7 | দুই ফোনে একই পণ্য একসাথে না বেচা; নিয়মিত স্টক গুনে মেলানো | ❌ |
| A8 | 🟠 | সার্ভার থেকে "নতুন ফোনে ডেটা পুনর্গঠন" শুরু-থেকে-শেষ **চালিয়ে দেখা হয়নি** (রিপ্লে-যুক্তি ইউনিট-টেস্টে আছে) | ফোন হারালে সার্ভার-লগের ওপর ভরসা করা যাবে কি না অনিশ্চিত | `tests/sync-replay.test.ts` (ইউনিট), E2E নেই | ব্যাকআপ ফাইলই ভরসা | 🔎 |
| A9 | 🟡 | ডেটা-মোছা "লগআউট" ডিফল্ট নয়: সাধারণ লগআউটে গ্রাহকের নাম-ফোন, বাকি, বিক্রির ইতিহাস ফোনে থেকে যায় | শেয়ার করা/বিক্রি করা ফোনে অন্যে দেখতে পারে | `src/app/settings/page.tsx:112-114` | ফোন হাতবদলে "লগআউট ও ডেটা মুছুন" | ⚠ |

## খ. নিরাপত্তা ও অনুমতি

পর্যালোচনা (২০২৬-১১-২০): দুই রিপোতে CRITICAL পাওয়া যায়নি; `npm audit --omit=dev` দুই রিপোতেই ০ ঝুঁকি; গিট-ইতিহাসে আসল গোপন তথ্য মেলেনি (প্যাটার্ন-ভিত্তিক; `gitleaks` ছিল না, তাই অস্বাভাবিক গঠনের গোপন তথ্য ধরা না-ও পড়তে পারে)। মাল্টি-টেন্যান্ট (RLS), পাসওয়ার্ড/JWT, SQL-injection, CORS ঠিক পাওয়া গেছে।

| # | মাত্রা | সীমাবদ্ধতা | প্রমাণ | অবস্থা |
|---|---|---|---|---|
| B1 | 🔴 | **কর্মচারী ক্রয়মূল্য দেখতে পায়**: পণ্যের বিবরণ, সম্পাদনা-ফর্ম, স্টক-জমার ফর্মে; এবং সিংক-pull-এর কাঁচা ইভেন্ট থেকেও। ব্যাকএন্ডের REST এটি লুকায়। (সমাধানে ডিজাইন লাগে: কর্মচারীর স্টক-জমা যেন মালিকের ক্রয়মূল্য ঘষে না দেয়) | `src/app/products/detail/page.tsx:86`, `src/app/stock/in/page.tsx:162`, `src/db/pg.ts:149-165`; `e2e/critical-flows.e2e.ts` ("কর্মচারী ক্রয়মূল্য দেখতে পায় না", `test.fail`) | ❌ |
| B2 | 🔴 | **ফোনের ঘড়ি পেছালে মেয়াদোত্তীর্ণ ওষুধ বিক্রি-যোগ্য হয়ে যায়** (৬০ দিন পেছানো দেখানো হয়েছে) | `e2e/critical-flows.e2e.ts` ("ফোনের ঘড়ি পেছানো…", `test.fail`); GAP_ANALYSIS "Clock-skew guard ❌" | ❌ |
| B3 | 🟠 | যে কেউ **অন্যের ফোন-নম্বরে আগে নিবন্ধন করে দখল** করতে পারে (OTP নেই); "নম্বর আগেই আছে" উত্তরে কোন নম্বর ব্যবহারকারী জানা যায় | `server/app.ts:188-201`, `db/migrations/001_init.sql:40` | ❌ |
| B4 | 🟠 | **যেকোনো নম্বরের লগইন ১৫ মিনিটের জন্য আটকে দেওয়া যায়** (৫০টি ভুল চেষ্টা) | `server/app.ts:108`, `:209-211` | ❌ |
| B5 | 🟠 | রেট-লিমিটের IP `x-forwarded-for` পর্যন্ত নামতে পারে (নকল করা যায়); Supabase সবসময় `cf-connecting-ip` সেট করে কি না যাচাই হয়নি | `server/app.ts:95-100`, `server/index.ts:18-22` | 🔎 |
| B6 | 🟠 | CSP-তে `script-src 'unsafe-inline'` এবং `connect-src https://*.supabase.co` (যেকোনো Supabase প্রজেক্ট); আজ কোনো XSS-পথ মেলেনি, কিন্তু সুরক্ষার স্তর পাতলা | `public/_headers:3` | ⚠ |
| B7 | 🟠 | সিংকে কর্মচারীর পাঠানো ইভেন্টের **ভেতরের বিষয়বস্তু সার্ভার যাচাই করে না** (শুধু খাম); ভূমিকা-সাদাতালিকা আছে | `server/app.ts` (`SYNC_STAFF_KINDS`); ক্লায়েন্ট-সাইড আকার-যাচাই `src/lib/sync/schemas.ts` | ⚠ |
| B8 | 🟡 | সেশন-টোকেন সাধারণ লেখায় `localStorage`-এ; লগআউটে সার্ভারে বাতিল হয় না; কোনো টোকেন `iss/aud` নেই | `src/components/auth-provider.tsx:27-30`, `src/auth/token.ts` | ❌ |
| B9 | 🟡 | কিছু ছোট ঝুঁকি: CSV-ফর্মুলা, ক্র্যাশ-রিপোর্টের লেখা ছাঁটা শুধু অঙ্ক-ভিত্তিক, CI-র GitHub Actions SHA-পিন করা নয়, বুট-ত্রুটির বার্তা ফেরত যায়, ডিভাইসের ২৬ জায়গা যেকোনো ভূমিকা ভরাতে পারে, বিশ্বব্যাপী রেট-বাকেটে সেবা-বিঘ্ন | `csv.ts`, `crash-report.ts:20`, `.github/workflows/ci.yml`, `supabase/functions/api/index.ts:19-22`, `server/app.ts:229-234`, `:111` | ❌ |

## গ. পণ্য-ফাঁক (PRD-র P0/P1 যা বানানো হয়নি)

বিস্তারিত: `GAP_ANALYSIS.md`। হস্তান্তরিত অ্যাপে **নেই**: আংশিক ফেরত/রিফান্ড (শুধু পুরো বিল বাতিল); MRP ও MRP-ওপরে-বিক্রি আটকানো; সরবরাহকারী ও ক্রয়-এন্ট্রি, সরবরাহকারীর বাকি; ক্যাশ-সেশন (খোলা/বন্ধ, গণনা); সম্পূর্ণ অডিট-লগ ও অনুমতি-ম্যাট্রিক্স (এখন শুধু মালিক/কর্মচারী); থার্মাল ESC/POS প্রিন্টিং (শুধু `window.print` ও শেয়ার); জেনেরিক-নামে খোঁজা, Rx/নিয়ন্ত্রিত-ওষুধ পতাকা; ভ্যারিয়েন্ট ও লেবেল-প্রিন্ট; VAT/Mushak ও মুসক রেজিস্টার; সাবস্ক্রিপশন বিলিং, প্ল্যাটফর্ম-অ্যাডমিন; একাধিক আউটলেট; SMS বাকি-স্মরণ; সার্ভার-সাইড রিপোর্ট ও মালিকের অন্য-ফোন থেকে দৃশ্য। ব্যাকএন্ডে এ কাজের একটি আধা-তৈরি ধারা (মাইগ্রেশন ০০৭-০০৯, প্রজেক্টর) অন্য শাখায় আছে: **মার্জ হয়নি, আমার পর্যালোচনায় আসেনি।**

## ঘ. যাচাইয়ের ফাঁক (কী পরীক্ষা হয়নি)

| # | মাত্রা | কী | অবস্থা |
|---|---|---|---|
| D1 | 🔴 | **আসল ফোনে (কম দামি Android, iOS Safari), আসল প্রিন্টারে কোনো ম্যানুয়াল পরীক্ষা হয়নি।** সব পরীক্ষা Windows-এর Chromium-এ ফোন-অনুকরণে | ❌ |
| D2 | 🟠 | E2E-র সব নতুন পরীক্ষা **নকল API**-তে; আসল ব্যাকএন্ড-জব (`E2E_REAL=1`) এই কাজে চালানো হয়নি | 🔎 |
| D3 | 🟠 | **হালনাগাদ (QA পুনঃপরীক্ষা ২০২৬-১১-২০):** ব্যাকএন্ড CI `chore/handover`-এ Linux-এ সবুজ (`7b15588`, `43e68a1`; `e4052fe` বাতিল)। ফ্রন্টএন্ড CI শাখা-পুশে চলেই না (শুধু PR ও `main`), তাই ফ্রন্টএন্ডের Linux-ফলাফল অজানা — `handover-evidence/phase5-ci-status.txt` | ⚠ |
| D4 | 🟠 | **হালনাগাদ:** ব্যাকএন্ড ইন্টিগ্রেশন ১৮/১৮ পাস, তবে স্থানীয় অস্থায়ী Postgres 18.7-এ (CI ও Supabase Postgres-এর সংস্করণের সাথে মেলে না) — `phase2-integration.txt`। Supabase-এর নিজস্ব পরিবেশে এখনো নয় | ⚠ |
| D5 | 🟠 | লাইভ API-তে লোড, আসল পাসওয়ার্ডে scrypt-সময় | 🔎 |
| D6 | 🟡 | কভারেজ: ফ্রন্টএন্ড লজিক ৭৬.৬% স্টেটমেন্ট (লক্ষ্য ৮০%), পুরো `src` ২৪.৬% (কম্পোনেন্ট শুধু E2E-তে), ব্যাকএন্ড ইউনিট ৫৩.৬-৬২.২% (Postgres-কোড ইউনিটে নয়) | ⚠ |
| D7 | 🟡 | অ্যাক্সেসিবিলিটি: axe-core ০ লঙ্ঘন ৩৭৫px-এ ৩২ পর্দায়, কিন্তু কিবোর্ড/স্ক্রিন-রিডার, ৭৬৮/১৪৪০px, ল্যান্ডস্কেপ, বড় ফন্ট, ছবির ওপর কনট্রাস্ট অযাচাই; স্ক্রিনশট-baseline নেই | ⚠ |
| D8 | 🟡 | ৩৭৫px-এ ছোট সমস্যা: কার্টে দীর্ঘ নামে `৳`/দাম ভেঙে দুই লাইন; সব পাতার `<title>` একই; লগইন↔সাইন-আপ লিঙ্ক ও ৪০৪-র লিঙ্ক ১৯-২৩px উঁচু; ডেটা-মোছার চেকবক্স ২০×২০px; ৪০৪ পাতায় `<h1>` নেই | ❌ |

## ঙ. ডেলিভারি ও পরিচালনা

| # | মাত্রা | কী | প্রমাণ | অবস্থা |
|---|---|---|---|---|
| E1 | 🔴 | **এই কাজ `main`-এ মার্জ হয়নি।** লকফাইল/`npm ci`, নিরাপত্তা-সংশোধন, নতুন E2E, ফন্ট-সংশোধন, `.gitattributes`, ডক-হালনাগাদ GitHub-এ আছে শুধু `chore/handover` শাখায় (পুশ হয়েছে ২০২৬-১১-২০); PR খোলা হয়নি, CI চলেনি | `docs/handover/handover-evidence/git-state.txt` | ⚠ |
| E2 | 🔴 | মনিটরিং/অ্যালার্ট নেই: সার্ভিস নামলে কেউ জানবে না যতক্ষণ ব্যবহারকারী জানায় | রানবুক ১০ | ❌ |
| E3 | 🟠 | ঘটনার দায়িত্বপ্রাপ্ত ব্যক্তি, Supabase/Netlify/GitHub মালিকের নাম রানবুকে ফাঁকা | ব্যাকএন্ড রানবুক ০ | ❌ |
| E4 | 🟠 | ডিপ্লয়ের ক্রম-নির্ভরতা: সিংকের নিয়ম বদলালে ফ্রন্টএন্ড আগে; ভুল ক্রমে স্টাফের ফোনের সিংক থামতে পারে | ব্যাকএন্ড রানবুক ২ | ⚠ (নথিভুক্ত) |
| E5 | 🟡 | লাইভ ডেটাবেসের মাইগ্রেশন হাতে চালাতে হয়, CI করে না; `down`-মাইগ্রেশন নেই | রানবুক ৩ | ⚠ (নথিভুক্ত) |
| E6 | 🟡 | ক্যামেরা-স্ক্যান ব্রাউজারের `BarcodeDetector`-এর ওপর নির্ভর করে (সব ব্রাউজারে নেই); USB/ব্লুটুথ স্ক্যানার কিবোর্ড-ইনপুট হিসেবে অযাচাই | ফ্রন্টএন্ড `CLAUDE.md` | 🔎 |

## চ. QA পুনঃপরীক্ষার নতুন ফলাফল (2026-11-20, English) — evidence in `docs/handover/handover-evidence/`

New or newly confirmed in this run. Severity: 🔴 high · 🟠 medium · 🟡 low.

| # | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| F1 | 🔴 | **`chore/handover` is not based on current `main`.** Backend `main` has 5 commits the branch lacks (migrations 007-011, sales API, PATCH /v1/store); frontend `main` has 12 (expenses, credit limit, continuous scan, Excel export...). Everything tested in this run is the branch, not what a client gets from `main`. Merge conflicts are likely (both sides touched sync/backend files). | `phase5-ci-status.txt` | ❌ |
| F2 | 🔴 | **Sale can be saved without a sync event.** `db-provider.tsx:111-120` wraps `eventsFromChange`+`writeSync` in `catch { out = next }`: no log, no flag. The bill prints normally but never reaches the server / other phones. | `phase4-silent-failures.txt` #1 (verified) | ❌ |
| F3 | 🔴 | **Corrupt local DB is replaced by an empty one and then overwritten.** `lib/store/db.ts:42-54`: JSON.parse failure returns `emptyDb()` with no `.corrupt` copy; next save destroys the raw data; bill counter restarts at 1000. | `phase4-silent-failures.txt` #3 (verified) | ❌ |
| F4 | 🔴 | **Local save failure only shows a banner**; `/sell/pay` still shows a successful receipt, the sale exists only in memory and is lost on reload; the banner flag clears after the next successful save. | `phase4-silent-failures.txt` #2 | ❌ |
| F5 | 🟠 | **Restore reports success without checking the write and does not reconcile cursor / outbox / bill counter**: older backup can re-issue bill numbers; sales missing from the backup are removed locally but stay on the server. | `phase4-silent-failures.txt` #7 | ❌ |
| F6 | 🟠 | **Pulled events can be dropped silently** (invalid/unknown/exception -> ignored, cursor advances, never counted); deferred events can wait forever; corrupt sync state resets cursor and loses the unsent outbox. | `phase4-silent-failures.txt` #4-#6 | ❌ |
| F7 | 🔴 | **B1 confirmed at runtime and in the UI:** staff `GET /v1/sync/pull` returns events containing `costPoisha`; staff product page shows "ক্রয়মূল্য ৳ ১০০.৫০". | `phase4-runtime-isolation-proof.txt`, `screens/p3-375-staff-sees-cost-price.png` | ❌ |
| F8 | 🟠 | **Expired stock on hand is not surfaced on the home "নজর দিন" panel or the stock-page expiry count** (home says "সব ঠিক আছে" with 5 expired pieces in stock). `selectors.ts:84-86` counts only the 30-day bucket. `/stock/expiry` does list it. | `phase3-browser-qa.txt` D-P3-2 | ❌ |
| F9 | 🟠 | **Hold/resume bills is not built** (single draft cart). PRD P0. | `phase3-browser-qa.txt` D-P3-4 | ❌ |
| F10 | 🟡 | ASCII digits in the Bangla UI ("1টি", "স্টকে মাত্র 10 পিস আছে"); staff nav shows "রিপোর্ট" which is owner-only; cart accepts qty above sellable stock (blocked only at payment); stock-in accepts an already-expired date silently. | `phase3-browser-qa.txt` D-P3-3,5,6,7 | ❌ |
| F11 | 🟠 | Live API is still the old build: live `/health` = `{"status":"ok"}`; current code returns `{"status":"ok","db":"ok"}` (local run confirmed). Deploy pipeline / token status unknown. | `phase5-live-health.txt`, `phase2-integration.txt` | ❌ |
| F12 | 🟠 | Server never validates sync event bodies (staff can push arbitrary sale/stock/due events with back-dated `at`), no per-store event quota, and `ON CONFLICT DO NOTHING` acknowledges a replayed id with different content. | `phase4-security-review.txt` H2, M7; `phase4-silent-failures.txt` #11 | ❌ |
| F13 | 🟡 | Healthcare: no prescription/patient capture exists (PRD P-8 not built). Before it is built: field-level encryption, read-audit log, retention/erase path and consent are all missing; today's PII (customer name+phone, dues) is plaintext in localStorage and in plaintext backup files. | `phase4-security-review.txt` PHI section | ❌ |
| F14 | 🟡 | Test-tooling traps (not product bugs): in Git-Bash `NEXT_PUBLIC_API_URL=/api npm run build` bakes `C:/Program Files/Git/api` into the bundle (documented in frontend CLAUDE.md); `-t golden` matches nothing in the backend (describe is named in Bangla; run `tests/unit/golden.test.ts`). | `phase2-e2e-INVALID-*`, `phase1-pos_backend-golden.txt` | ⚠ |
