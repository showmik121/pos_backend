# Gap Analysis — Bipone (pos_fontend + pos_backend) vs PRD v2

Date: 2026-11-20 · Compares `showmik121/pos_fontend` @ `1b1965b` and `showmik121/pos_backend` @ `015029a` against [PRD.md](PRD.md).
How to use it with Claude + ECC: [ECC_GUIDE.md](ECC_GUIDE.md).

## 1. What already exists (and is good)

The codebase is better engineered than most MVPs. Keep these decisions:

| Area | Current state | Verdict |
|---|---|---|
| Money & stock | Integer poisha, stock in pieces, no floats | ✅ Matches PRD |
| Batch / expiry | FIFO by batch, expired batches excluded, expiry classes (expired / ≤30 / ≤90) | ✅ Core of the pharmacy module done |
| Domain parity | Same golden JSON fixtures + `fixtures.lock` in both repos | ✅ Excellent — keep for every new rule |
| Offline sync | Client UUID event log, idempotent push, cursor pull, device codes (A, B…), bill prefix `A-1001` | ✅ Matches PRD §11.2–11.3 design |
| Multi-tenancy | Postgres RLS, `pos_app` NOBYPASSRLS role, `app.store_id` per transaction | ✅ Matches PRD |
| Auth | scrypt, HS256-only JWT, DB-backed rate limiting, weak-password list | ✅ |
| Quality | TypeScript strict, Vitest, Playwright E2E (mock + real backend), CI, CSP headers, crash reporting | ✅ |
| Bangla | Full Bangla UI, Bangla digits, Bangla error messages | ✅ |
| Dues (baki) | Customer ledger, due collection, required customer on credit sale | ✅ |
| Removal log | Batch removal with reason/who/when/loss | ✅ |

## 2. Handover blockers (fix before anything else)

These would cause problems for a client on day one, regardless of features.

| # | Repo | Problem | Evidence | Fix |
|---|---|---|---|---|
| B1 | backend | **`node_modules` is committed as a symlink** to `/home/claude/gh/pos_backend/node_modules` | `git ls-files node_modules` → tracked; content is a Linux path | `git rm --cached node_modules`, make sure `.gitignore` covers it. Fresh clone + `npm install` on Windows/CI must work |
| B2 | both | **No lockfiles** (`npm install`, not `npm ci`) | CLAUDE.md in both repos | Commit `package-lock.json`; switch CI to `npm ci`. Builds are not reproducible and `npm audit` results change daily |
| B3 | frontend | **All business data lives in `localStorage`** (~5 MB cap, whole DB re-serialised on every change) | `src/lib/store/db.ts` | A busy pharmacy hits the quota in weeks → saves fail. Migrate to IndexedDB (Dexie) behind the same `DbProvider` API; keep localStorage reader as a one-time migration |
| B4 | backend | **Server keeps only the event log**; relational tables (`products`, `sales`, `due_ledger`…) are unused for synced data | backend CLAUDE.md "রিলেশনাল টেবিল … এখনো ব্যবহার হয় না" | Without a projection there are no server-side reports, no owner view from another phone, no recovery except full replay. Build an idempotent projector `sync_events → tables` |
| B5 | backend | **Restore drill never performed** | backend CLAUDE.md "restore-মহড়া এখনো হয়নি" | Run and document one backup → restore on a staging Supabase project |
| B6 | frontend | **Never tested on a real phone** | frontend CLAUDE.md | Manual test pass on 2 low-end Android phones + 1 printer before handover |
| B7 | both | Over-sell across two offline devices can make `qtyRemaining` negative silently | frontend CLAUDE.md "জানা সীমা" | Raise a reconciliation alert from the server projection (PRD §11.2), show it on owner dashboard |
| B8 | frontend | Staff, backup-restore and offline flows have no E2E coverage; no component tests | frontend CLAUDE.md | Add Playwright: offline sale → reconnect → sync; backup → restore; staff permissions |

## 3. Feature gaps vs PRD

`✅ done` · `🟡 partial` · `❌ missing` · `❓ verify`

### Core
| PRD item | Status | Notes |
|---|---|---|
| Signup, store, staff | ✅ | Owner/staff roles only |
| Product CSV import | ✅ | 1 MB / 5,000 rows |
| Barcode scan | 🟡 | `BarcodeDetector` only (not on all browsers); verify USB/Bluetooth HID scanners as keyboard input |
| Cart, % / amount discount | ✅ | |
| Payments cash + mobile (bKash/Nagad/Rocket) | 🟡 | No card, no Upay; verify split tender |
| Hold / resume bills | ❓ | `Draft` type exists — verify multiple concurrent carts |
| **Partial returns / refunds** | ❌ | Only full-bill **void** exists. PRD P0: return lines against original invoice, restock to original batch |
| **MRP field + block above MRP** | ❌ | No MRP anywhere. P0 legal requirement |
| Batch-wise price | 🟡 | Batch gets price on stock-in; confirm sale uses batch price |
| **Pack hierarchy box → strip → piece** | 🟡 | FE `UnitLabel` has piece/strip/box; backend only piece/carton. Align both + golden fixtures |
| **Supplier & purchase (supplier due, bonus qty)** | ❌ | Stock-in has no supplier, no supplier ledger |
| Stock count / adjustment with reason | 🟡 | Removal exists; no stock-count / variance flow |
| Low-stock alerts / expiry dashboard | ✅ | `/stock/low`, `/stock/expiry` |
| **Cash register session (open/close, denomination count)** | ❌ | P0 for theft control |
| **General audit log** | 🟡 | Removal/void record who/why; price edits, discounts etc. not logged |
| Configurable permission matrix | 🟡 | Cost hidden from staff; no discount limit, no matrix |
| **Thermal ESC/POS printing + Bangla bitmap** | ❌ | Only `window.print` + share. Most shops use a 58 mm Bluetooth printer |
| Reports | 🟡 | Local reports + top items; nothing server-side (depends on B4) |
| Owner dashboard from another phone | ❌ | Depends on B4 |

### Pharmacy module
| PRD item | Status | Notes |
|---|---|---|
| FEFO + expired block | ✅ | |
| Clock-skew guard for expiry | ❌ | Rolling the phone clock back unlocks expired batches |
| **Generic-name ↔ brand search** | ❌ | No `generic` field |
| Rx-required / controlled flags + prescription capture | ❌ | Health data → encrypt, restrict (PRD §10) |
| Expiry return / claim to supplier | ❌ | P1 |
| Drug master | ❌ | P1, licensing open |

### Retail module (cosmetics already counts as retail)
| PRD item | Status | Notes |
|---|---|---|
| Variants (size/colour/shade) | ❌ | Needed for cosmetic shades, clothing |
| Barcode generation + label printing | ❌ | |
| Loose items by weight + scale barcodes | ❌ | Grocery only — lower priority for current market |
| Exchange flow | ❌ | Depends on partial returns |

### Bangladesh / compliance
| PRD item | Status |
|---|---|
| Mushak 6.3 invoice (BIN, VAT/SD per line), VAT rates, turnover-tax mode | ❌ |
| Mushak 6.1 / 6.2 registers, 9.1 export | ❌ |
| Phonetic search (napa → নাপা) | ❓ verify `store/search.ts` |
| Amount in words (টাকা কথায়) | ❓ |
| SMS due reminders | ❌ |

### SaaS / platform
| PRD item | Status |
|---|---|
| Plans, trial, subscription billing, dunning | ❌ |
| Platform admin (tenants, suspend, impersonate, flags) | ❌ |
| Multi-outlet | ❌ (store = one outlet today) |

## 4. Recommended order

Do **not** build everything at once. Each step = one branch + one PR, run through the ECC loop in [ECC_GUIDE.md](ECC_GUIDE.md).

| Step | Work | Why this order |
|---|---|---|
| 1 | B1, B2 (repo hygiene, lockfiles, `npm ci`) | Hours of work; unblocks reproducible CI |
| 2 | B3 IndexedDB migration | Data-loss risk grows every day the app is used |
| 3 | B4 server projection + B7 reconciliation | Unlocks reports, owner remote view, recovery |
| 4 | Partial returns, MRP, supplier purchases, pack hierarchy alignment | Daily-use P0 gaps |
| 5 | Cash sessions, audit log, permission matrix | Theft control — main selling point |
| 6 | ESC/POS Bluetooth printing with Bangla bitmap | Real-shop requirement |
| 7 | Pharmacy: generic search, Rx flags, clock-skew guard | Pharmacy value prop |
| 8 | Retail: variants, label printing | Cosmetics / clothing |
| 9 | VAT / Mushak (after consultant sign-off, PRD §15) | Compliance |
| 10 | Subscription billing + platform admin | Needed before charging money |
| 11 | B5, B6, B8 + production audit → handover | Final gate |
