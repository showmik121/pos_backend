# PRD — Retail & Pharmacy Subscription POS (Bangladesh)

| | |
|---|---|
| **Working name** | ShopOS |
| **Version** | Draft v2 — scoped to Retail + Pharmacy |
| **Date** | 2026-11-20 |
| **Supersedes** | "PRD — Multi-Business Subscription POS" Draft v1 (2026-11-19) |
| **Status** | Draft — open items in §15 must be closed before build kick-off |

### What changed from v1

v1 tried to serve every business type (retail, restaurant, pharmacy, salon, wholesale). v2 commits to **two verticals only: Retail and Pharmacy**. This is a deliberate engineering decision, not just a scope cut:

- **Retail and pharmacy share ~85% of their domain.** Both are counter-sale, SKU/barcode-driven, stock-heavy businesses. Pharmacy is essentially "retail + batch/expiry + regulatory rules". One product model and one sell-screen family serve both.
- **Restaurant was the odd one out.** Tables, KOT, kitchen displays, modifiers and split bills are a separate product. Removing it deletes the floor-plan UI, kitchen routing, order lifecycle states and EFD-for-restaurant work from the critical path.
- **Batch & expiry become a core P0 capability**, not a P1 add-on. Doing this in the core from day one is far cheaper than retrofitting batch-level stock into a live ledger later — and grocery retail (dairy, packaged food, cosmetics) benefits from it too.
- Removed: restaurant, salon/services, wholesale modules; Foodpanda / Pathao Food sync; tables, KOT, appointments, commission.

---

## 1. Overview

A cloud-based, multi-tenant, **offline-first** POS that small and mid-sized Bangladeshi **retail shops and pharmacies** rent monthly. One shared core (sales, inventory with batch/expiry, purchases, customers & dues, VAT, reports) plus two vertical modules — **Retail** and **Pharmacy** — selected at signup.

**Vision:** a shop owner or pharmacist signs up, imports their products, and is selling within 15 minutes on hardware they already own — through load-shedding and internet outages — and can check sales, stock and expiries from their phone.

### Assumptions (confirmed unless marked)

- Market: Bangladesh. BDT pricing, Bangla + English UI, cash / card / bKash / Nagad / Rocket / Upay, NBR VAT (Mushak) on receipts.
- Customers: 1–5 outlets, 1–20 staff. (Narrowed from v1's 1–10 / 1–30 — typical for these two verticals.)
- SaaS only. Hardware (thermal printer, scanner, cash drawer, label printer, weighing scale) is customer-sourced from a certified list.
- Team: 3–6 engineers. MVP scope must stay tight.
- **[To confirm]** Pharmacy target is retail model pharmacies and independent medicine shops, not hospital pharmacies or drug wholesalers/distributors.

---

## 2. Problem & target users

Shops run on paper khata, Excel, or pirated desktop POS with no cloud backup. Pharmacies additionally lose money to **expired stock nobody noticed**, can't find a medicine by generic name fast, and keep regulatory registers on paper. Both need something cheap, fast, Bangla-friendly, and resilient to power and internet cuts.

### Target segments

| Segment | Examples | Must-have needs |
|---|---|---|
| **Retail — grocery / super shop** | Mudi dokan, mini-mart, super shop | Barcode-first fast checkout, loose items by weight, MRP enforcement, baki ledger, stock alerts |
| **Retail — fashion / general** | Clothing, footwear, cosmetics, electronics, stationery | Variants (size/colour), label printing, exchange/returns, serial/IMEI (electronics) |
| **Pharmacy** | Model pharmacy, independent medicine shop, pharmacy chain (≤5 outlets) | Batch & expiry with FEFO, near-expiry alerts, generic-name search, strip/box/piece units, prescription capture, regulatory registers |

### Personas

| Persona | Primary goal | Key pain |
|---|---|---|
| **Owner** | See sales, profit, stock, dues, expiries from a phone | Theft, cash leakage, expired stock write-offs |
| **Manager / Pharmacist-in-charge** | Products, purchases, stock counts, staff, expiry returns | Manual reconciliation, supplier claims |
| **Cashier / Salesperson** | Sell fast with minimal taps | Low tech literacy, prefers Bangla, queues at peak |
| **Accountant** | Mushak registers, VAT return data, dues | Re-typing sales into Excel every month |
| **Platform admin (us)** | Tenants, plans, billing, support, feature flags | — |

---

## 3. Goals & success metrics

Targets for the first 12 months after paid launch (proposed — confirm with business):

| Goal | Metric | Target |
|---|---|---|
| Fast onboarding | Signup → first sale | < 15 min median |
| Adoption | Paying tenants | 300 by month 12 (split target: ~200 retail, ~100 pharmacy) |
| Daily use | Tenants with sales on ≥ 20 days/month | ≥ 70% |
| Retention | Monthly logo churn | < 4% |
| Conversion | Trial → paid | ≥ 25% |
| Reliability | Checkout availability (incl. offline) | 99.9% |
| Speed | Scan item → receipt printed | < 2 s |
| Data integrity | Duplicate invoices / negative-stock bugs from sync | 0 (P1 incident if any) |
| Pharmacy value | Expired-stock write-off reduction (self-reported, pilot) | ≥ 50% vs. baseline |
| Support load | Tickets per tenant per month | < 0.5 |

**Non-goals (v1):** full double-entry accounting, payroll, e-commerce storefront, public API, clinical decision support (drug–drug interaction checking, dosage advice), wholesale/distribution, restaurant/F&B.

---

## 4. Scope

| Area | MVP (v1) | Phase 2 | Phase 3 |
|---|---|---|---|
| Sales & checkout | ✅ | Customer display | Self-checkout |
| Products & inventory | ✅ incl. **batch/expiry, FEFO** | Multi-warehouse transfers | Central catalog for chains |
| Customers & baki ledger | ✅ | Loyalty points, SMS campaigns | — |
| Purchases & suppliers | ✅ purchase entry, supplier dues | Purchase orders, purchase returns, reorder suggestions | Supplier portal |
| Expiry returns / claims | Pharmacy: ✅ basic | Supplier claim tracking | — |
| Staff & roles | ✅ | Shifts, attendance | Sales commission |
| Reports | Core reports + Mushak registers | Scheduled summaries | Custom report builder |
| Vertical modules | **Retail, Pharmacy** | — | Evaluate next vertical on paying demand |
| Platforms | Web POS (PWA), owner mobile view (PWA) | Android POS app (Capacitor) | Windows wrapper if demanded |
| Multi-outlet | Up to 3 outlets | Up to 10, stock transfers | Franchise / chain mode |
| Integrations | bKash/Nagad manual txn ref, SMS gateway | bKash/Nagad merchant APIs + dynamic QR, accounting export | Courier (Pathao/Steadfast/RedX), Facebook order intake |
| Subscription billing | ✅ | bKash tokenized auto-renew | Reseller/agent portal |

---

## 5. Product architecture: core + two modules

The business type chosen at signup enables a module and applies a **preset** (default categories, units, receipt layout, sell-screen mode, alert thresholds). A tenant may enable both (e.g., a super shop with a pharmacy counter) — this is an add-on, not a fork.

### Design rules

1. **One codebase, one schema.** Modules add screens, rules and a few tables; they never fork core logic.
2. **Feature flags per tenant** gate modules, screens and plan limits. The same flag service enforces billing limits.
3. **Batch is a core concept.** Every stock movement references a `batch_id` (nullable for non-batch-tracked products). Retail products default to untracked; pharmacy products default to tracked.
4. **Stock is a ledger, never a counter.** Stock on hand = sum of movements. This is what makes offline multi-device sales merge safely.
5. **Sell-screen modes:** *barcode-first list* (retail default), *search-first with generic lookup* (pharmacy default), *tile grid* (optional for small catalogs).
6. **Presets, not hard-coding.** Retail and pharmacy differences live in configuration where possible (units, rules, alerts), code only where behaviour genuinely differs (FEFO picking, prescription rules).

### What each module adds

| Module | Adds on top of core |
|---|---|
| **Retail** | Variant matrix (size/colour), barcode generation & label printing, weighing-scale barcodes and loose items, price lists / promotional pricing (BOGO, % off, bundle), exchange flow, optional serial/IMEI tracking |
| **Pharmacy** | FEFO batch auto-selection, expired-batch sale block, near-expiry dashboard (30/60/90 days), generic-name ↔ brand search via drug master, pack hierarchy (box → strip → tablet) with loose-unit sale, prescription capture (photo + doctor name), Rx-required and controlled-drug flags with sale rules, controlled-drug register, expiry return to supplier/company |

---

## 6. Functional requirements — Core

Priority: **P0** = MVP must-ship, **P1** = within 3 months of launch, **P2** = later.
Each P0 includes acceptance criteria (AC) the QA plan is built from.

### 6.1 Onboarding & tenant setup

- **P0** — Sign up with mobile number + OTP; create business, choose type (Retail / Pharmacy / Both), create first outlet.
  - AC: new tenant reaches a working sell screen in ≤ 5 screens.
- **P0** — Setup wizard: logo, address, BIN, VAT mode (standard / truncated / turnover tax), receipt footer, language.
- **P0** — Product import from Excel/CSV template (separate templates for retail and pharmacy; pharmacy template includes generic, strength, form, batch, expiry, pack size).
  - AC: 5,000-row import completes in < 60 s with a row-level error report; no partial import on fatal error.
- **P0** — Opening stock entry (with batch/expiry for tracked products).
- **P1** — Pharmacy: pick products from the shared **drug master** instead of typing (see §7.2).
- **P1** — Demo/sandbox data to practise before going live.

### 6.2 Sales / checkout

- **P0** — Add item by barcode scan, search (name, SKU, phonetic Bangla, generic for pharmacy), or tile.
- **P0** — Edit quantity, unit (e.g., strip vs. piece), line discount, price (permission-gated).
- **P0** — Cart discount (amount / %), VAT calculation (inclusive/exclusive, per-item rate), rounding to nearest taka (configurable).
- **P0** — Payments: cash with change, card (record last 4 + approval code), bKash/Nagad/Rocket/Upay (record txn ID), split tender, partial payment → customer due.
- **P0** — Hold / resume bills (multiple concurrent carts per device).
- **P0** — Print 58 mm / 80 mm thermal receipt (Bangla rendered as bitmap — see §8); digital receipt by SMS link.
- **P0** — Returns & refunds against original invoice, with reason and permission check; restocks to the original batch.
  - AC: a return can never exceed the originally sold quantity for that line; refund method and amount are audit-logged.
- **P0** — **MRP enforcement:** warn or block (tenant setting) when selling above MRP.
- **P0** — **Offline mode:** full checkout with no internet; automatic sync later without duplicates (§11).
  - AC: device offline for 7 days with 2,000 sales syncs with zero duplicates and correct stock.
- **P1** — Customer-facing display; quick-keys for top items.

### 6.3 Products & inventory

- **P0** — Products, categories, brands, units with conversions (pcs, kg/g, litre/ml, box/strip/piece), variants, cost and sell price, MRP, barcode/SKU, VAT rate.
- **P0** — Per-product flags: `track_batch`, `track_expiry`, `track_serial`, `sell_loose`, `allow_negative_stock` (default off).
- **P0** — Batch records: batch no., expiry date, cost, MRP (MRP can differ per batch — common in pharmacy after price changes).
- **P0** — Stock per outlet per batch, updated on every sale, return, purchase, adjustment.
- **P0** — **Expiry alerts** (configurable windows, default 90/60/30 days) on dashboard and daily owner summary — available to retail too.
- **P0** — Low-stock alerts per product per outlet (reorder level).
- **P0** — Stock adjustment (damage, loss, expiry write-off, theft) with mandatory reason; stock count (full or by category) with variance report.
- **P1** — Stock transfer between outlets (batch-aware).
- **P1** — Reorder suggestions from sales velocity.

### 6.4 Purchases & suppliers

- **P0** — Suppliers (company / distributor / local supplier) with due balance.
- **P0** — Purchase entry (stock in) with batch, expiry, cost, MRP, free/bonus quantity, trade discount; supplier payment and due.
  - AC: bonus quantity increases stock at zero cost and lowers the effective unit cost in valuation.
- **P0** — Mushak 6.1 purchase register auto-built from purchase entries.
- **P1** — Purchase orders, purchase returns (incl. expiry returns — see §7.2), supplier ledger statement.

### 6.5 Customers & dues (baki)

- **P0** — Customer profile by phone; purchase history.
- **P0** — Baki khata: sell on credit with per-customer limit, collect payments, SMS reminders in Bangla.
- **P1** — Loyalty points, customer groups, Hal Khata (Pohela Boishakh) bulk due-settlement campaign.

### 6.6 Staff, roles & security

- **P0** — Roles: Owner, Manager, Pharmacist (pharmacy only), Cashier; permission matrix (discount limit, refund, price edit, view cost/profit, stock adjust, sell Rx/controlled items).
- **P0** — PIN login on shared devices; full audit log of sensitive actions.
- **P0** — Cash register sessions: opening float, cash in/out, closing count by BDT denomination (1000…1), shortage/excess report.
- **P1** — Custom roles, shifts, attendance.

### 6.7 Reports & dashboard

- **P0** — Owner dashboard (mobile-friendly web): today's sales, gross profit, top items, payment mix, dues, low stock, **near-expiry value**.
- **P0** — Reports: sales (day/item/category/staff/outlet), profit, stock value (at cost, FIFO), expiry report, VAT, dues, cash register, stock movement.
- **P0** — Fiscal year July–June default; export to Excel/PDF; date and outlet filters.
- **P1** — Scheduled daily summary by SMS/WhatsApp/email.
- **P2** — Festival analytics (Eid, Ramadan, Pohela Boishakh vs normal days).

### 6.8 Settings, outlets & hardware

- **P0** — Multiple outlets (plan-limited) with outlet-level stock and price overrides.
- **P0** — Receipt designer (logo, header, footer, language, Mushak fields).
- **P0** — Hardware: ESC/POS thermal printer (USB / Bluetooth / network), barcode scanner (HID keyboard mode), cash-drawer kick.
- **P0** (Retail) — Barcode label printing (Zebra/TSC-class label printers, and A4 sheet fallback).
- **P1** — Weighing-scale integration beyond barcode (direct serial read).

### 6.9 Platform admin (internal)

- **P0** — Tenant list with plan, status, usage, sync health; suspend/reactivate; impersonate for support (time-boxed, audit-logged, tenant-visible).
- **P0** — Plans, feature flags, coupons, manual payment recording.
- **P0** — Drug master management (import/update the shared pharmacy catalogue — §7.2).
- **P1** — MRR/churn/ARPU dashboard, announcements, in-app support chat, reseller/agent commission tracking.

---

## 7. Functional requirements — Vertical modules

### 7.1 Retail module

| ID | Requirement | Priority | Acceptance criteria |
|---|---|---|---|
| R-1 | Variant matrix: define attributes (size, colour), auto-generate SKUs and barcodes | P0 | Creating a 5×4 matrix yields 20 sellable variants with unique barcodes |
| R-2 | Barcode generation (EAN-13 / Code128, internal prefix) and label printing with price, MRP, name | P0 | Prints a 50-label run on a supported label printer and on A4 sheet |
| R-3 | Loose items by weight; weighing-scale barcodes (prefix 2x, embedded weight or price) | P0 | Scanning a scale barcode adds correct item and weight to cart |
| R-4 | Exchange flow: return + new sale in one transaction, settle difference | P0 | Net settlement shown; both legs appear correctly in reports |
| R-5 | Promotions: % / amount off, BOGO, bundle price, date-bounded | P1 | Best applicable promo applied automatically; never stacks unless configured |
| R-6 | Price lists (e.g., member price) | P1 | — |
| R-7 | Serial / IMEI capture on sale and purchase (electronics) | P1 | Serial cannot be sold twice; warranty lookup by serial |
| R-8 | Batch/expiry optional for groceries, dairy, cosmetics (uses core) | P0 | Same behaviour as pharmacy FEFO when enabled |

### 7.2 Pharmacy module

| ID | Requirement | Priority | Acceptance criteria |
|---|---|---|---|
| P-1 | **FEFO auto-selection:** sale picks the earliest-expiring non-expired batch; pharmacist can override (logged) | P0 | With batches expiring Jan and Mar, sale draws Jan first |
| P-2 | **Expired batch sale block** — hard block, not a warning; no override | P0 | Expired batch is never selectable, online or offline (device clock-skew guard — §11) |
| P-3 | Near-expiry dashboard & report (30/60/90 days) with value at cost, grouped by supplier | P0 | Report matches ledger to the taka |
| P-4 | Pack hierarchy: box → strip → piece with conversion; sell any level; price per level | P0 | Selling 3 tablets from a 10-tab strip deducts 0.3 strip; stock shown as "4 box 7 strip 3 pcs" |
| P-5 | **Generic ↔ brand search:** type generic (e.g., "paracetamol") → list all brands in stock with strength, form, price, stock | P0 | < 200 ms on 20k products, works offline |
| P-6 | Shared **drug master** (brand, generic, strength, dosage form, manufacturer, pack size, DGDA-listed MRP where available) maintained by platform; tenants link products to it | P1 (seed data P0) | Tenant can create product from master in 2 taps; tenant overrides never alter the master |
| P-7 | Product flags: `rx_required`, `controlled` (narcotic/psychotropic schedule) | P0 | Flags drive P-8 and P-9 |
| P-8 | Rx-required items: prompt to record prescription (doctor name, optional photo, patient name/phone optional); configurable as warn or block | P0 | Setting "block" prevents completing sale without Rx data |
| P-9 | Controlled-drug register: every in/out of controlled items logged with patient, prescriber, Rx ref; printable register | P1 | Register reconciles with stock ledger |
| P-10 | Expiry return / claim to company or supplier: select near-expiry/expired batches → return document → track credit received | P1 | Returned qty leaves stock; claim status tracked to closure |
| P-11 | Substitute suggestion: when a brand is out of stock, show same generic + strength + form in stock | P1 | Never suggests a different strength or form |
| P-12 | Batch-wise MRP: sale price follows the selected batch's MRP | P0 | Two batches with different MRP charge correctly |

**Explicitly out of scope (clinical safety):** drug–drug interaction checks, dosage recommendations, any clinical advice. Showing incorrect clinical info is a liability we do not take on in v1.

---

## 8. Bangladesh-specific requirements

| Area | Feature | Priority | Notes |
|---|---|---|---|
| VAT | Mushak 6.3 tax invoice: seller/buyer BIN, VAT & SD per line, totals in BDT, unbroken serial numbering | P0 | Offline serial numbering design in §11.3 — **needs NBR/consultant confirmation** |
| VAT | Per-item VAT rate, SD, exempt / reduced / truncated rates, turnover-tax mode for small shops | P0 | Many medicines and small pharmacies fall under special treatment — confirm (§15) |
| VAT | Mushak 6.1 (purchase) and 6.2 (sales) registers; Mushak 9.1 return summary export | P0 | |
| VAT | EFD / SDC integration readiness | P1 | Large retail / super shops may fall under EFD rules — confirm which of our target customers do |
| Payments | bKash, Nagad, Rocket, Upay with txn ID entry | P0 | |
| Payments | Dynamic merchant QR + automatic verification via merchant APIs | P1 | Kills fake-screenshot fraud |
| Payments | Cash count by BDT denomination at shift close | P0 | |
| Dues | Baki khata with limits and Bangla SMS reminders | P0 | |
| Language | Full Bangla UI; Bangla/bilingual receipts; amount in words (টাকা কথায়) | P0 | |
| Language | Bangla receipts printed as bitmap on ESC/POS | P0 | Cheap printers have no Bangla font |
| Language | Phonetic search ("chal" → চাল, "napa" → নাপা) | P0 | |
| Pricing | MRP field with warn/block above MRP | P0 | Consumer rights law |
| Pricing | Loose items by weight + scale barcodes | P0 | Retail |
| Pharmacy | DGDA-aligned drug master; controlled-drug register | P1 | Licensing of drug data source is open (§15) |
| Reports | Fiscal year July–June | P0 | |
| Messaging | Masked-sender SMS via local gateway; WhatsApp receipts and owner summary | P0 / P1 | |
| Devices | Runs on low-cost Android tablets/phones (2–3 GB RAM) fully offline during load-shedding | P0 | |
| Support | Bangla video tutorials, WhatsApp/phone support, on-site setup for paid plans | P0 | |

---

## 9. Subscription & billing

Prices are placeholders — validate with 20–30 interviews (split ~15 retail, ~15 pharmacy) before launch.

| Plan | BDT / month (proposed) | Outlets | Users | Products | Includes |
|---|---|---|---|---|---|
| **Starter** | 499 | 1 | 2 | 2,000 | Core POS, 1 module (Retail *or* Pharmacy), basic reports, offline |
| **Business** | 1,199 | 1 | 5 | Unlimited | All reports, Mushak registers, dues SMS, roles, purchases, expiry dashboard |
| **Pro** | 2,499 | Up to 3 | 15 | Unlimited | Multi-outlet, transfers, loyalty, drug master sync, priority support |
| **Enterprise** | Custom | Unlimited | Unlimited | Unlimited | Chains, custom integrations, dedicated support |

**Add-ons:** extra outlet, extra user, SMS bundles, second module (Retail + Pharmacy on one tenant).

### Billing rules

- 14-day free trial, no card; Business-plan features during trial.
- Monthly or yearly (yearly = 2 months free).
- Pay via bKash/Nagad (tokenized auto-debit where supported — P1), card via local gateway (e.g., SSLCommerz), or bank transfer recorded by admin.
- Auto-generated VAT invoices; reminders 7, 3 and 1 day before renewal.
- **Dunning:** missed payment → 7-day grace (full access + banner) → read-only (view/export, no new sales) → suspended at day 30 → data retained 90 days → deleted after notice.
- Upgrades immediate and prorated; downgrades at next cycle and must fit new limits.
- **Never block an in-progress sale for billing reasons.** Lock state is evaluated at day-start / app launch only, and offline devices honour the last known entitlement for up to 7 days.

---

## 10. Non-functional requirements

| Area | Requirement |
|---|---|
| Offline-first | Full POS (sell, return, cash session, stock lookup, generic search) works offline ≥ 7 days; local DB on device |
| Performance | Sell screen interactive < 2 s on a 3 GB RAM Android tablet; product search < 200 ms on 20,000 items locally; API p95 < 300 ms; sync of 500 queued sales < 30 s on 3G |
| Availability | Cloud API 99.9% monthly; **checkout never depends on cloud** |
| Multi-tenancy | Every row scoped by `tenant_id`; enforced in application layer **and** PostgreSQL RLS; automated cross-tenant access tests in CI |
| Security | TLS everywhere; Argon2id password/PIN hashing; device-bound refresh tokens with revocation; encrypted backups; least-privilege roles; audit log for price edits, discounts above limit, refunds, voids, stock adjustments, batch overrides |
| Health data | Prescription photos and patient details are sensitive: encrypted at rest, access restricted to Pharmacist/Owner roles, excluded from impersonation views by default, retention configurable |
| Data protection | Daily backups, PITR, 30-day retention, quarterly restore drill; tenant self-service full export (CSV/Excel) |
| Scalability | 5,000 tenants / 2M invoices per month on v1 architecture without redesign |
| Localization | Bangla & English, optional Bangla numerals, BDT formatting, Asia/Dhaka timezone |
| Usability | Cashier productive within 10 min of training; touch targets ≥ 44 px; 7–15" screens; full keyboard operation on desktop |
| Compatibility | Chrome/Edge (last 2 versions) on Windows & Android; Android 9+; certified ESC/POS printers and label printers |
| Compliance | VAT-ready invoices; financial record retention per NBR rules (confirm duration) |
| Observability | Structured logs, error tracking, uptime alerts, per-tenant / per-device sync lag and failure metrics |

---

## 11. Architecture & technical decisions

**Style:** modular monolith backend + offline-first PWA clients. One deployable, clearly bounded modules (`identity`, `catalog`, `inventory`, `sales`, `purchasing`, `customers`, `vat`, `billing`, `pharmacy`, `retail`, `admin`). Extract services only when a measured scaling need appears.

### 11.1 Stack (recommended)

| Layer | Choice | Rationale |
|---|---|---|
| POS client | React + TypeScript PWA, Vite | One codebase for desktop browser and Android tablets |
| Local DB | IndexedDB via **Dexie** (or RxDB if we want built-in replication) | Mature, fast, works on low-end Android Chrome |
| Local search | In-memory index (e.g., MiniSearch/FlexSearch) built from local DB, with Bangla phonetic normalisation | Meets < 200 ms on 20k items offline |
| Android app (Phase 2) | Capacitor wrapping the PWA | Reuses 100% of UI; native Bluetooth printing |
| Backend | **Node.js + NestJS (TypeScript)** | Shared types/validation (zod) between client and server cut a whole class of sync bugs. Choose Laravel only if the team is materially stronger in PHP. |
| Database | PostgreSQL 16 with RLS on `tenant_id` | Relational integrity for ledgers; strong isolation |
| Cache / queues | Redis + BullMQ | SMS, report generation, sync post-processing, billing jobs |
| Object storage | S3-compatible | Product images, prescription photos (encrypted), exports, backups |
| Printing | ESC/POS via WebUSB / Web Bluetooth / Web Serial; fallback tiny local print bridge for Windows | Bangla rendered to bitmap client-side |
| Hosting | Managed cloud in Mumbai/Singapore region, Docker | Low latency to BD — **data residency to confirm** |
| Monitoring | Sentry, Prometheus/Grafana, uptime alerts | |
| CI/CD | GitHub Actions; staging + production; DB migrations gated | |

### 11.2 Sync design

- Clients write to the local DB first and append to an **outbox** of domain events (`SaleCompleted`, `ReturnCreated`, `StockAdjusted`, `CashSessionClosed`, …).
- `POST /sync/push` is **idempotent**: each event carries a client-generated UUIDv7; the server dedupes on it.
- `GET /sync/pull?since=<checkpoint>` returns changes per tenant/outlet (catalog, prices, customers, stock snapshots) since the last checkpoint.
- **Stock = sum of `stock_movements`**, keyed by (variant, outlet, batch). Concurrent offline sales on two devices merge as two movements — no overwrite conflicts.
- Master data (product, price) conflicts: last-writer-wins per field with server timestamp, and every change audit-logged.
- Completed sales are **immutable**; corrections are new documents (return, void with reason).
- **Negative stock offline:** allowed only if `allow_negative_stock` is on; otherwise blocked locally. If two devices oversell the same last unit offline, the server records the negative and raises a reconciliation alert (it does not reject a completed sale).
- **Clock-skew guard:** devices record both local time and a monotonic sync-anchored offset; expiry checks (P-2) use the later of device time and last-known server time, so rolling the clock back cannot unlock expired batches.

### 11.3 Invoice numbering offline (key risk)

Mushak 6.3 expects unbroken serial numbers, but offline devices can't ask the server for the next number. Proposal:

- Each registered device gets its own serial series: `{outlet_code}-{device_code}-{sequence}` (e.g., `D01-T02-000123`), sequence strictly monotonic per device and never reused.
- Series are unbroken **per device**; voids consume a number and are kept as void records.
- **Must be validated with a VAT consultant / NBR** before build (§15). If per-device series are not acceptable, fallback is pre-allocated number blocks per device, refilled on each sync.

### 11.4 Core data model

All business tables carry `tenant_id` and, where relevant, `outlet_id`. IDs are client-generated UUIDv7.

| Entity | Key fields | Notes |
|---|---|---|
| Tenant | name, business_types[], plan_id, status, trial_ends_at, vat_mode | |
| Outlet | tenant_id, code, name, address, BIN, settings | |
| Device | outlet_id, code, invoice_series, last_sync_at | Registered POS terminal |
| User | phone, role_id, pin_hash, outlet_access[] | |
| Role / Permission | name, permissions[] | |
| Product | name, name_bn, category, brand, base_unit, vat_rate, flags (track_batch, track_expiry, track_serial, rx_required, controlled), drug_master_id?, attributes JSONB | |
| ProductVariant | product_id, sku, barcode, attributes | Size/colour (retail) |
| UnitConversion | product_id, unit, factor_to_base, barcode?, price? | Box/strip/piece, kg/g |
| Batch | variant_id, batch_no, expiry_date, cost, mrp | One per received lot |
| StockMovement | variant_id, outlet_id, batch_id?, qty ±, reason, ref_type, ref_id, created_by | **Source of truth for stock** |
| StockLevel | variant_id, outlet_id, batch_id?, qty | Derived projection for fast reads |
| Sale / SaleLine | invoice_no, device_id, cashier, customer?, totals, vat, sd, status; line: variant, batch, unit, qty, price, mrp, discount | Immutable once completed |
| Prescription | sale_id, doctor_name, patient_name?, patient_phone?, image_key?, notes | Sensitive — encrypted |
| ControlledDrugEntry | movement_id, patient, prescriber, rx_ref | Pharmacy register |
| Payment | sale_id or due_collection_id, method, amount, txn_ref | Split tender |
| Customer / DueLedger | phone, name, credit_limit, balance; ledger entries | Baki |
| Supplier / Purchase / PurchaseLine | supplier, batch, expiry, cost, mrp, bonus_qty, paid, due | |
| SupplierReturn | supplier, lines(batch, qty), reason (expiry/damage), claim_status | Pharmacy expiry claims |
| CashSession | outlet, device, user, opening, cash_in/out, denominations, expected, counted, difference | |
| DrugMaster (global, not tenant-scoped) | brand, generic, strength, form, manufacturer, pack, dgda_mrp?, version | Platform-maintained |
| Plan / Subscription / BillingInvoice | limits, features JSONB, period, status, amount | SaaS billing |
| AuditLog | user, device, action, entity, before/after, at | Append-only |

### 11.5 API conventions

- REST + JSON, versioned (`/api/v1`), consistent envelope `{ success, data, error, meta }`.
- Schema validation at every boundary (zod/class-validator); same schemas shared with the client.
- Rate limiting per tenant and per device; idempotency keys on all mutating endpoints.

---

## 12. Quality & testing strategy

- **Unit tests** for pricing, VAT/SD calculation, rounding, FEFO selection, unit conversion, dunning state machine — target ≥ 90% coverage on these domain modules, ≥ 80% overall.
- **Property-based tests** for the stock ledger and sync merge (random interleavings of offline sales across devices must always reconcile).
- **Integration tests** for every API endpoint against a real PostgreSQL with RLS enabled, including cross-tenant access attempts that must fail.
- **E2E tests** (Playwright) for critical flows: onboarding → first sale; offline sale → reconnect → sync; return; cash session close; pharmacy Rx-required sale; expired-batch block.
- **Device lab:** at least 3 low-end Android tablets and 3 certified printers in CI-adjacent manual regression before each release.
- **Pilot data audit:** during pilot, nightly job compares ledger-derived stock with projections and alerts on any drift.

---

## 13. Roadmap & milestones

Assumes ~5 people (1 PO, 2 full-stack, 1 frontend, 1 QA, part-time designer). A 3-person team stretches build to 8–9 months.

| Phase | Months | Deliverables | Exit gate |
|---|---|---|---|
| **0. Discovery** | 0–1 | 30 interviews (15 retail, 15 pharmacy), VAT consultant sign-off on Mushak 6.3 & offline numbering, drug-data licensing decision, hardware certification list | Open items §15 #1–#4 closed |
| **1. Foundation** | 1–3 | Auth, tenancy + RLS, catalog with units & batches, stock ledger, offline sync engine, sell screen (retail mode), thermal printing incl. Bangla bitmap | Offline 7-day soak test passes with zero duplicates |
| **2. MVP features** | 3–5 | Purchases, dues, cash sessions, returns, reports, Mushak registers, Retail module P0, Pharmacy module P0, owner dashboard, subscription billing | All P0 ACs pass; security review done |
| **3. Pilot** | 6–7 | 10 retail + 10 pharmacy shops, free, on-site onboarding; weekly releases | ≥ 15 of 20 using daily; zero data-integrity incidents for 3 weeks |
| **4. Paid launch** | 8 | Pricing live, support playbook, Bangla tutorials | ≥ 25% pilot → paid conversion |
| **5. Phase 2** | 9–14 | Android app, merchant QR/API payments, drug master sync, expiry claims, POs, transfers, loyalty | Driven by paying-customer demand |

---

## 14. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Offline sync bugs (duplicates, wrong stock) | Loss of trust, data errors | Ledger model, client UUIDs, idempotent sync, property-based tests, nightly drift audit in pilot |
| Mushak 6.3 numbering incompatible with offline | Compliance blocker | Consultant sign-off in Phase 0; block-allocation fallback (§11.3) |
| Drug master data licensing / accuracy | Pharmacy value prop weakens; liability if wrong | License a reputable source or build from DGDA public list; tenants can override locally; never show clinical advice |
| Pharmacy regulatory changes (DGDA rules on Rx / controlled drugs) | Rework | Rules configurable per tenant (warn/block), register feature isolated in module |
| Health data exposure (prescriptions) | Legal & reputational | Encryption, role restriction, excluded from support impersonation, retention controls |
| Low willingness to pay monthly | Weak revenue | Cheap Starter, trial, show ROI (expiry savings, theft control, due collection) |
| Competition from pirated desktop POS | Slow sales | Cloud backup, owner mobile view, Bangla, expiry alerts, on-site onboarding |
| Printer/hardware variety | Support overload | Certified list, partner hardware sellers, print-bridge fallback |
| Two verticals still too much for MVP | Delayed launch | Retail mode ships first internally (Phase 1); pharmacy P0 builds on the same batch core; pharmacy P1 items are strictly deferrable |

---

## 15. Open questions (must close in Phase 0)

1. **VAT:** Is per-device invoice serial numbering acceptable for Mushak 6.3? Does a POS vendor need NBR approval to issue 6.3 electronically or connect to SDC? Which of our target shops fall under EFD/SDC rules?
2. **VAT for pharmacies:** Typical VAT/turnover-tax treatment for retail pharmacies and medicines — what defaults should the pharmacy preset ship with?
3. **Drug master source:** License a commercial dataset, build from the DGDA registered-drug list, or crowd-source from tenants with platform review?
4. **Rx / controlled drugs:** Exact DGDA record-keeping requirements for model vs. non-model pharmacies; required retention period.
5. **Pricing:** Validate plans and whether pharmacy deserves its own price point.
6. **Data residency:** Is hosting outside Bangladesh acceptable, especially with prescription data?
7. **Desktop:** Is a PWA enough for Windows counters, or do we need a Windows wrapper for printer reliability?
8. **Go-to-market:** Direct, reseller/agent network, pharma-distributor partnerships, or hardware shops?

---

*Next documents after this PRD is approved: architecture/system design doc, sync protocol spec, VAT/Mushak spec, and phased task list.*
