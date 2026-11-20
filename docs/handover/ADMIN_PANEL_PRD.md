# Bipone Platform Admin Panel — PRD v1

Status: Draft for approval · Date: 2026-11-20 · Owner: Product/Engineering
Extends [PRD.md](PRD.md) §6.9 (Platform admin) and §8 (Billing). Based on the code in `pos_backend` @ `main` (migrations 001–011) and `pos_fontend` @ `main`.
Gap context: [GAP_ANALYSIS.md](GAP_ANALYSIS.md) steps 10–11.

---

## 1. Summary

Bipone has no operator tooling. Today the only way to see a shop, suspend it, check why its sync is stuck, or record a payment is the Supabase SQL editor. That does not scale past a handful of pilot shops, and it is unsafe (a typo in SQL touches every shop).

The **Platform Admin Panel** is an internal web app, used only by the Bipone team, to run the business: onboard and manage shops (tenants), watch their health, handle subscriptions and payments, support them safely, and keep an audit trail of everything an operator does.

**Not** in scope: the shop owner's own screens (settings, staff, reports). Those already exist in `pos_fontend`.

## 2. Goals and non-goals

### Goals
1. Every operator action on a shop is done through the panel, is authorised by role, and is logged.
2. Operators can answer "is this shop healthy, paying, and syncing?" in under 30 seconds.
3. Support can help a shop without ever seeing more of its data than needed.
4. Billing state (trial, active, grace, suspended) is stored in one place and **enforced by the API**, not just displayed.
5. A compromised admin account must not equal a data breach of every shop (least privilege, 2FA, audit).

### Non-goals (v1)
- Automatic card/mobile-wallet charging (payments are recorded manually first; gateway is Phase A6).
- Editing a shop's business data (products, bills, stock). Admins never mutate tenant business data.
- A public status page, marketing site, or customer-facing billing portal.
- Multi-region hosting, white-labelling, reseller accounts.

## 3. Users and roles

| Role | Who | Can do |
|---|---|---|
| **Super admin** | Founder/CTO (1–2 people) | Everything, incl. manage admins, change plans, delete a tenant, approve impersonation of write mode |
| **Support** | Support agent | View tenants, sync health, errors; time-boxed read-only impersonation; add notes; send announcements. No billing edits, no suspension |
| **Finance** | Accounts | Record/void payments, issue invoices, extend trial, apply credits. No impersonation, no suspension |
| **Viewer** | Investor/advisor/junior | Read-only dashboards and tenant list; no personal data columns (phone masked) |

Permissions are checked on the **server** for every request. Hiding a button is never the control.

## 4. What exists today (facts the design builds on)

| Fact | Where | Consequence for the admin panel |
|---|---|---|
| `stores(id, name, kind, address, phone, created_at)`; `users(store_id, role owner/staff, active)`; global unique phone | `001_init.sql` | Tenant = a store. Owner phone is the contact. No status/plan/trial columns exist |
| Row-level security keyed on `app.store_id`; app DB role `pos_app` is `NOBYPASSRLS` | `001_init.sql`, `002_hardening.sql` | Admin must **not** use `pos_app`. Cross-tenant access needs its own role and narrow SECURITY DEFINER functions |
| Sync is an append-only event log `sync_events(store_id, seq, payload…)` + `sync_devices` (A–Z) | `004_sync.sql` | Gives last-sync time, backlog and device count per shop. **Payloads contain business data (e.g. cost price) and must not be shown to admins by default** |
| Server projection tables exist (`projection_events`, `sales`…) | `009_projection.sql` | Usage numbers (bills/day, products) can come from the projection |
| Rate limiting via `auth_throttle()`; `client_errors` crash log (fingerprinted) | `002`, `005` | Reuse for admin login throttle; surface `client_errors` in the panel instead of the SQL editor |
| JWT HS256, 12 h TTL, claims `sub, sid, role`; **no revocation list** | `src/auth/token.ts` | Suspension needs a per-request status check; admin tokens need a separate audience and short TTL |
| Backend `main` auto-deploys to Supabase Edge Function; DB migrations run by hand | backend RUNBOOK | Every admin migration needs a documented, rehearsed rollout order |
| Shops are offline-first; data lives on the phone and syncs when online | frontend CLAUDE.md | A suspension cannot instantly stop an offline phone. Policy in §8.3 |

## 5. Product requirements

Priority: **P0** must ship in the first release, **P1** next, **P2** later.

### 5.1 Admin identity and security (P0)
- **A-1** Separate admin accounts (`platform_admins`), separate login endpoint, separate JWT (own secret and `aud: "admin"`). A shop token must never be accepted by admin routes and vice versa.
- **A-2** Mandatory **TOTP 2FA** for every admin; 10 single-use recovery codes. Login without 2FA is impossible, including for super admins.
- **A-3** Short sessions: 30 min idle timeout, 8 h absolute. Re-enter password + 2FA for sensitive actions (suspend, delete, change plan, impersonate, manage admins) — "step-up auth".
- **A-4** Login throttling with the existing DB-backed limiter (per account and per IP); lockout alert to super admins.
- **A-5** Optional IP allow-list per admin (P1). Admin site on its own origin (e.g. `admin.<domain>`), own CORS list, strict CSP **without** `unsafe-inline`.
- **A-6** Super admin can create, deactivate, and change role of admins; deactivation kills sessions immediately. Last active super admin cannot be removed.
- **A-7** No shared accounts. Passwords scrypt-hashed like shop users; common-password list reused.

### 5.2 Audit log (P0)
- **A-8** Every admin action writes an immutable record: who, when, what, target shop/user, reason, before/after summary, IP, user agent. Reads of sensitive screens (impersonation start, data export) are logged too.
- **A-9** Append-only: the admin DB role has `INSERT` and `SELECT` only on the audit table, no `UPDATE`/`DELETE`. Rows carry a hash of the previous row (tamper-evidence, P1).
- **A-10** Searchable by admin, shop, action, date; export to CSV (super admin). Retention ≥ 2 years.
- **A-11** Anything an admin does that affects a shop's data or access is also visible **to that shop's owner** in a "Support activity" list (transparency; required for impersonation, see §5.6).

### 5.3 Tenant management (P0)
- **T-1 Tenant list:** columns — name, kind (pharmacy/cosmetics/other), owner name, masked phone, created, plan, status, trial end, last sync, devices, staff count, bills last 7 days, open alerts. Search by name/phone/id; filters by status/plan/kind/"not synced for N days"; sort; server-side pagination (default 50). Handles ≥ 10,000 tenants.
- **T-2 Tenant detail:** profile, owner and staff list (name, role, active, last login — **never** password hashes), devices (code, first/last seen), plan and billing timeline, usage charts (bills/day, products, active devices), sync health, recent client errors, notes, audit trail for this tenant.
- **T-3 Suspend / reactivate:** requires a reason, step-up auth, optional message shown to the owner. Takes effect per §8. Reversible. Logged and visible to owner.
- **T-4 Read-only mode:** tenant can view and export but cannot create bills or stock (used by dunning and abuse cases).
- **T-5 Staff/owner account actions (P1):** deactivate a user, force logout, trigger password-reset code. Admin can **never** see or set a plain password.
- **T-6 Notes (P0):** internal timestamped notes and tags per tenant (e.g. "wants Bangla invoice", "pilot"). Visible to Support and above.
- **T-7 Create tenant manually (P1):** onboarding on behalf of a shop (sales-assisted), sends owner the credentials flow.
- **T-8 Merge/transfer (P2):** change owner phone with verification and audit.

### 5.4 Plans, subscriptions, payments (P0 manual, P1 automated)
Plans from PRD §8: Starter 499, Business 1,199, Pro 2,499 BDT/month; 14-day trial, no card.
- **B-1 Plan catalogue:** plans are data, not code: name, price, limits (outlets, users, products), features. Editable by super admin; price changes apply to **new** billing periods only.
- **B-2 Subscription state machine** per tenant, stored server-side:
  `trial → active → grace (7 d) → read_only → suspended (day 30) → pending_deletion (90 d) → deleted`, plus `cancelled`. Every transition has a timestamp, actor (system or admin) and reason.
- **B-3 Record payment (P0):** amount, method (bKash, Nagad, Rocket, bank, cash), transaction id, date, period covered, attachment (screenshot, P1). Applying a payment moves the tenant to `active` and sets the next due date. Payment can be voided with reason (never deleted).
- **B-4 Invoices (P1):** auto-numbered, downloadable PDF with Bangla/English, BIN of Bipone if VAT-registered (open question Q3).
- **B-5 Trial and credit controls (P0):** extend trial (≤ 14 days, reason required, Finance/Super), grant free months/credit; both logged and capped per tenant per quarter.
- **B-6 Dunning (P1):** scheduled job runs the state machine daily; SMS/in-app notices before each transition; idempotent and safe to re-run. Dry-run mode.
- **B-7 Revenue view (P0):** MRR, active/trial/grace/suspended counts, trial→paid conversion, churn, overdue list, collections this month. Numbers must reconcile to the payment records.
- **B-8 Gateway integration (P2/Phase A6):** SSLCommerz / bKash tokenised payments with webhook verification; until then, manual recording.

### 5.5 Platform health and monitoring (P0/P1)
- **H-1 Sync health (P0):** per tenant — last successful push/pull, outbox backlog age (derived from device reports if added, else last event age), devices not seen in N days, number of dropped/rejected events. Tenants "stuck" > 24 h are listed on the dashboard.
- **H-2 Reconciliation alerts (P1):** negative stock (`qtyRemaining < 0`) detected by the projection — gap B7 in GAP_ANALYSIS — shown per tenant and on the dashboard; tenant owner sees the same alert in the shop app.
- **H-3 Client error viewer (P0):** replaces SQL editor access to `client_errors`: grouped by fingerprint, count, first/last seen, app version, affected tenants, path. Mark as resolved/ignored.
- **H-4 Version distribution (P1):** share of tenants per `app_version`; flag tenants on old versions.
- **H-5 API health (P1):** error rate, p95 latency, rate-limit hits, failed logins; link to Supabase logs. Alert (email/SMS/Telegram) on thresholds.
- **H-6 Storage/usage (P1):** DB size, event-log growth per tenant (covers the missing `sync_events` quota, security review M-4); flag top consumers.

### 5.6 Support tools (P0/P1)
- **S-1 Impersonation ("view as shop") (P1, design in v1):**
  - Support/Super only; requires reason and ticket reference; step-up auth.
  - **Read-only by default**, time-boxed (30 min, auto-expire), one tenant at a time, persistent banner "Support session".
  - The shop owner sees a live "Support is viewing your shop" notice and a log entry afterwards (A-11). Owner can end the session.
  - Write mode is Super admin only, shorter (10 min), with a second approver (P2).
  - **Excluded by default:** prescriptions and patient/customer personal data (PRD §10 health data), cost prices, password material, backup files. Admin sees the shop's *structure and numbers*, not its customers.
  - Impersonation never reuses the owner's token; it issues a distinct `support` token with claims `sub=admin`, `act_as=store`, `exp`, `mode=ro`.
- **S-2 Announcements (P1):** in-app banner to all tenants or a segment (plan, kind, version); scheduled start/end; Bangla text. Shown by the shop app on next sync.
- **S-3 Data requests (P1):** export a tenant's data (JSON/CSV) on owner request; delete a tenant after the retention period with typed confirmation + step-up; both logged. Deletion is a soft-delete first (30-day undo), then hard-delete job.
- **S-4 Support tickets (P2):** simple inbox linked to tenants, or integrate an external tool. Out of v1 unless Q6 says otherwise.
- **S-5 Backup status (P1):** shows last successful DB backup/PITR status and links to the restore runbook. (The restore drill itself remains a manual runbook step.)

### 5.7 Feature flags and limits (P1)
- **F-1** Per-tenant and per-plan flags (e.g. enable Mushak module, expiry dashboard v2, early-access features). Server evaluates and returns flags with the login/sync response; the shop app caches them for offline use.
- **F-2** Plan limits (outlets, staff, devices, products) are enforced by the API using the plan catalogue; admin can override per tenant with a reason and expiry.
- **F-3** Kill-switch flags to disable a broken feature across all tenants within minutes without a deploy.

### 5.8 Reporting (P1)
- Growth: signups per week by kind, activation (first bill within 7 days), retention by cohort.
- Product usage: bills per tenant per day, feature adoption.
- Finance: MRR, ARPU, collections, overdue ageing, CSV export (super/finance).
- Aggregate and de-identified by default; tenant drill-down follows the same data-minimisation rules.

## 6. Data-minimisation rules (non-negotiable)

1. Admin SQL role sees **metadata and aggregates**, not event payloads. It has no `SELECT` on `sync_events.payload`, `customers`, `sales`, `sale_items`, `due_ledger`, prescription data, or cost prices. Aggregates come from SECURITY DEFINER functions that return only counts and dates.
2. Phone numbers are masked (`017****030`) except for Support/Super on a tenant detail page, and revealing is itself audit-logged.
3. Passwords, hashes, JWT secrets, DB URLs, Supabase tokens never appear in any admin API response or log.
4. Exports are logged with row counts and require step-up auth.
5. No admin action may bypass the audit log, including "internal" scripts: migrations that act on tenants write audit rows.

## 7. Architecture

**Style:** keep the modular monolith (PRD §11). Add an `admin` module in `pos_backend`, and a **separate** static admin front-end.

| Piece | Decision | Why |
|---|---|---|
| Admin UI | New repo `pos_admin` (Next.js static export, same stack/lint/test conventions as `pos_fontend`), deployed to its own host/origin | Own CSP, own blast radius; shop app bundle never contains admin code; can restrict by IP/SSO at the edge |
| Admin API | `/v1/admin/*` routes in `pos_backend/server/routes/admin/*`, mounted in the same Edge Function **behind a feature gate**, separate JWT secret `ADMIN_JWT_SECRET` | One deployable; independent auth; can be split to its own function later if needed |
| DB access | New role `admin_app` (`NOBYPASSRLS`), **no direct table grants** on tenant business tables; access only through SECURITY DEFINER functions (`admin_list_tenants`, `admin_tenant_summary`, …) with fixed `search_path` | Same hardening pattern already used for `auth_throttle` and `record_client_error` |
| Enforcement | New `stores.status`, `stores.plan_id`, `stores.trial_ends_at`, `stores.read_only_since` (migration 012). Login, sync push/pull and write routes check status; cache per request | Suspension must be real, not cosmetic |
| Scheduled jobs | Supabase `pg_cron` or scheduled Edge Function for dunning, trial expiry, retention, alert checks. Jobs are idempotent and log to the audit table as `actor=system` | Safe re-runs; no cron on the web tier |
| Secrets | Admin secrets only in Supabase secrets/CI secrets, never in chat or repo | Existing rule |

### 7.1 Data model (new, sketch)

| Table | Key fields |
|---|---|
| `platform_admins` | id, email, name, role (`super`,`support`,`finance`,`viewer`), password_hash, totp_secret (encrypted), recovery_codes_hash[], active, last_login_at, allowed_ips[] |
| `admin_sessions` | id, admin_id, issued_at, last_seen_at, ip, user_agent, revoked_at |
| `admin_audit_log` | id, at, admin_id, action, target_type, target_id, store_id, reason, before jsonb, after jsonb, ip, ua, prev_hash |
| `plans` | id, code, name, price_poisha, currency, limits jsonb, features jsonb, active |
| `store_subscriptions` | store_id, plan_id, status, trial_ends_at, current_period_start/end, grace_until, cancelled_at, history via `subscription_events` |
| `subscription_events` | id, store_id, from_status, to_status, at, actor, reason |
| `payments` | id, store_id, amount_poisha, method, txn_ref, paid_at, period_start/end, recorded_by, voided_at, void_reason, attachment_url |
| `invoices` | id, number, store_id, period, amount_poisha, status, issued_at |
| `tenant_notes` | id, store_id, admin_id, body, tags[], created_at |
| `feature_flags` | key, description, default_value, rules jsonb (plan/store/segment) |
| `announcements` | id, title_bn, body_bn, segment jsonb, starts_at, ends_at, created_by |
| `support_sessions` | id, admin_id, store_id, reason, ticket_ref, mode, started_at, expires_at, ended_at, ended_by |
| `error_triage` | fingerprint, status (`open`,`resolved`,`ignored`), note, by, at |

Money is **integer poisha** everywhere, same as the shop app. All timestamps `timestamptz`, shown in Asia/Dhaka.

### 7.2 API surface (v1, all under `/v1/admin`, all JSON, all authenticated, all rate-limited)

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/login`, `/auth/2fa`, `/auth/step-up`, `/auth/logout`, `GET /me` |
| Admins | `GET/POST /admins`, `PATCH /admins/:id` (role, active), `POST /admins/:id/reset-2fa` |
| Tenants | `GET /tenants` (filters, cursor pagination), `GET /tenants/:id`, `POST /tenants/:id/suspend`, `/reactivate`, `/read-only`, `GET/POST /tenants/:id/notes` |
| Billing | `GET /plans`, `PATCH /plans/:id`, `POST /tenants/:id/payments`, `POST /payments/:id/void`, `POST /tenants/:id/trial/extend`, `GET /billing/overview` |
| Health | `GET /health/sync`, `GET /health/errors`, `PATCH /health/errors/:fingerprint`, `GET /health/versions` |
| Support | `POST /support/sessions`, `DELETE /support/sessions/:id`, `GET/POST /announcements`, `POST /tenants/:id/export` |
| Flags | `GET/PUT /flags`, `PUT /tenants/:id/flags` |
| Audit | `GET /audit` (filters), `GET /audit/export` |

Conventions: error envelope identical to the shop API (`{error:{code,message,details}}`), zod-validated input, idempotency keys on payment recording and any mutation that triggers a notification.

### 7.3 Changes needed in the existing apps
- **Backend (shop API):** read `stores.status` on login/sync/write; return a structured `tenant_suspended` / `tenant_read_only` error; return `flags`, `announcements`, and `plan limits` in the login/sync response; reject over-limit actions with a clear Bangla message; add optional device `last_seen` update on sync.
- **Shop app (`pos_fontend`):** show suspension/read-only/grace banners in Bangla; disable "new sale / stock-in" in read-only mode but keep export and backup; show support-session notice and the owner-visible support activity list; render announcements; never lose local data because of a status change.

## 8. Behaviour rules that need care

### 8.1 Enforcement points
Status is checked on: login, token refresh/pull/push, and every write route. Reads of one's own data stay allowed in `read_only`; `suspended` allows only login, backup/export download and a contact message.

### 8.2 Billing state machine (summary)
`trial(14d)` → payment → `active` → missed due date → `grace(7d, full access + banner)` → `read_only` → day 30 `suspended` → +90 d `pending_deletion` (owner notified) → `deleted`. Payment at any point before deletion returns the tenant to `active` and records the transition. Admin overrides are allowed but reasoned and capped.

### 8.3 Offline reality
A phone offline keeps selling; the server cannot stop it. Therefore: (1) enforcement applies at the next sync; (2) pending local events are **never discarded** — they are accepted into a quarantine/queue and applied after reactivation, so a late payment loses no sales; (3) read-only is a *server-side* and UI rule, plus the shop app disables creating new bills after it has seen the status once; (4) the owner is told in Bangla what to do. No remote wipe of phone data, ever.

### 8.4 Concurrency and safety
All state changes use a transaction with the previous status as a precondition (`UPDATE … WHERE status = $prev`). Two admins acting on the same tenant get a clear conflict message, never a silent overwrite.

## 9. UX requirements

- Desktop-first responsive web (tablet usable), light/dark, keyboard navigable, WCAG 2.2 AA.
- Language: **English UI by default**, with Bangla for any text shown to shop owners (announcements, notices) and a Bangla/English toggle (P2). *(Decision Q5.)*
- Navigation: Dashboard · Tenants · Billing · Health · Support · Flags · Audit · Admins · Settings.
- **Dashboard (P0):** tenants by status, MRR, trials ending ≤ 7 days, overdue payments, stuck sync, new client errors, today's signups. Each tile links to a pre-filtered list.
- Dangerous actions (suspend, delete, impersonate, extend trial) use a confirmation dialog stating the exact effect on the tenant, require a reason, and show who else was affected.
- Never show raw JSON or stack traces to the operator for expected errors; show a plain message with a request id for support.
- Large tables are server-paginated; filters are bookmarkable via URL.

## 10. Non-functional requirements

| Area | Requirement |
|---|---|
| Performance | Tenant list p95 < 500 ms at 10k tenants; dashboard p95 < 1 s (pre-aggregated/materialised, refreshed ≤ 5 min) |
| Availability | Admin panel downtime must not affect shops. Shop API must keep working if admin tables are unavailable (fail-open for *reads of status* with cached last-known status ≤ 15 min, fail-closed for admin routes) |
| Security | OWASP ASVS L2 for the admin app; all items in §5.1/§6; dependency audit in CI; strict CSP; no secrets in front-end |
| Auditability | 100 % of mutating admin routes produce an audit row (enforced by a test that fails if a mutating route lacks one) |
| Privacy | Compliance with PRD §10 (health data excluded from admin and impersonation by default); data-subject export/delete flows |
| Observability | Structured logs with request id; no PII/secret in logs; alerts for admin login failures, mass suspensions (> 5/hour), and any admin role change |
| Reproducibility | Lockfile + `npm ci`, CI like the other repos; golden tests for billing state machine and dunning |
| Backup/restore | Admin tables included in backups; restore runbook updated |

## 11. Success metrics

| Metric | Target |
|---|---|
| Time to answer "is this shop healthy?" | < 30 s |
| Support requests resolved without SQL editor | 100 % |
| Admin actions with an audit record | 100 % |
| Payments recorded within 24 h of receipt | ≥ 95 % |
| Overdue tenants handled on schedule by dunning | ≥ 99 % |
| Security incidents from admin access | 0 |

## 12. Testing and acceptance

**Test layers:** unit (permission matrix, billing state machine, dunning, plan limits), integration against real Postgres (admin role cannot read tenant payloads; suspended tenant cannot push; audit row written), contract tests for every `/v1/admin` route, E2E (Playwright) for the main operator flows, security tests (token confusion shop↔admin, IDOR on tenant ids, role escalation, brute-force lockout).

**Acceptance criteria (P0, Given/When/Then):**
1. *Given* a Support admin, *when* they request `POST /tenants/:id/suspend`, *then* 403 and an audit row for the denied attempt.
2. *Given* a Super admin with valid step-up, *when* they suspend a tenant with a reason, *then* the tenant's next login/sync returns `tenant_suspended`, an audit row exists, the owner's app shows the Bangla notice, and local phone data is untouched.
3. *Given* a shop JWT, *when* it is sent to any `/v1/admin/*` route, *then* 401; and an admin JWT sent to a shop route also 401.
4. *Given* the admin DB role, *when* it runs `SELECT payload FROM sync_events`, *then* permission denied (integration test).
5. *Given* a tenant in `grace`, *when* Finance records a full payment, *then* status becomes `active`, next due date advances one period, a `subscription_events` row and an audit row exist, and a repeated request with the same idempotency key does not double-apply.
6. *Given* an admin without 2FA enrolled, *when* they log in, *then* they must enrol before any data is returned.
7. *Given* a tenant list of 10,000 rows, *when* filtering by "no sync for 3 days", *then* results return in under 500 ms (p95) with correct counts.
8. *Given* an impersonation session, *when* 30 minutes pass, *then* the support token stops working, the owner's notice disappears, and the session is logged with start/end.
9. *Given* any mutating admin route, *when* the CI route-audit test runs, *then* it fails if the route does not write an audit row.
10. *Given* a mistake in a deployed admin release, *when* the admin app is rolled back, *then* shops are unaffected (separate deploy).

## 13. Delivery plan

| Phase | Scope | Exit criteria |
|---|---|---|
| **A0 — Foundations** | Migration 012 (status/plan/trial columns, `platform_admins`, audit log, `admin_app` role + SECURITY DEFINER functions); admin auth with TOTP + step-up; enforcement of `stores.status` in shop API; CI for new repo | Acceptance 3, 4, 6, 9 pass; staging restore rehearsed |
| **A1 — Tenant ops** | Tenant list/detail, notes, suspend/reactivate/read-only, owner-facing notice in shop app, audit viewer | Acceptance 1, 2, 7 |
| **A2 — Health** | Sync health, client-error viewer/triage, dashboard tiles, version distribution | Operators stop using SQL editor for errors |
| **A3 — Billing (manual)** | Plans, subscription state machine, record/void payment, trial extend, revenue overview | Acceptance 5; numbers reconcile with payments |
| **A4 — Support** | Impersonation (read-only), announcements, data export/delete workflow | Acceptance 8 |
| **A5 — Flags and limits** | Flags, plan limits enforced in API, kill-switches | Flag change reaches shops within one sync |
| **A6 — Automation** | Dunning jobs + SMS, invoices PDF, payment gateway, alerts | Dunning dry-run clean for 2 weeks, then live |

Rough sizing for one senior engineer with Claude: A0 ≈ 1.5 weeks, A1 ≈ 1 week, A2 ≈ 1 week, A3 ≈ 1.5 weeks, A4 ≈ 1.5 weeks, A5 ≈ 1 week, A6 ≈ 2 weeks. Ship A0–A3 before charging real money.

Each phase = its own branch and PR per repo, backend first, CI green, migration rollout steps written in the backend RUNBOOK. Backend `main` auto-deploys, so no admin migration or route is merged without a rehearsed rollout.

## 14. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Admin account compromised → all shops exposed | Critical | 2FA, step-up, no payload access by design, IP allow-list, audit alerts, separate origin/secret |
| Suspension bug locks out a paying shop | High | State-machine tests, dry-run dunning, "reactivate" always available, grace period, 15 min cache only |
| Cross-tenant data leak through admin functions | Critical | SECURITY DEFINER functions return aggregates only; integration tests prove admin role cannot read payloads |
| Offline phones keep selling after suspension | Medium | Documented policy §8.3; queue-and-apply; never wipe local data |
| Billing numbers diverge from payments | High | Revenue computed from payment rows only; reconciliation test |
| Over-collecting personal data in the panel | Legal | §6 rules; masked phones; excluded health data; retention |
| Scope creep (support desk, CRM) | Delay | Non-goals in §2; keep P2 items out of v1 |
| Migration touches live DB wrongly | Critical | Rehearsal on staging, RUNBOOK steps, backups verified (blocker B4/B5 from readiness report must be closed first) |

## 15. Open questions (need a decision before A0)

| # | Question | Recommendation |
|---|---|---|
| Q1 | Who are the admin users and how many (founder only, or support + finance staff)? | Start with 1–2 super admins; add roles as staff join |
| Q2 | Are the PRD plan prices (499 / 1,199 / 2,499 BDT) final, and does the trial give Business features? | Keep them as data in `plans`; confirm before A3 |
| Q3 | Is Bipone VAT/BIN-registered (invoice format)? | Confirm with accountant; build generic invoices first |
| Q4 | Which payment channels will be accepted first (bKash personal/merchant, Nagad, bank)? | Manual recording of all, gateway later; merchant account application takes time, start early |
| Q5 | Admin UI language: English, Bangla, or both? | English default, Bangla toggle later |
| Q6 | Support tickets in-app, or an external tool (WhatsApp/Messenger/helpdesk)? | External for v1; link tenant id in the panel |
| Q7 | Data residency and retention promises to clients (delete after 90 days?) | Follow PRD §10 and get legal review before A4 |
| Q8 | Is "staff cannot see cost price" a contract promise (readiness blocker B3)? It affects what admin may show | Decide; admin never shows cost price either way |
| Q9 | Hosting for the admin site (Netlify with IP restriction, or behind SSO/Cloudflare Access)? | Cloudflare Access or Netlify password + IP allow-list for v1 |

## 16. Out of scope / future

Multi-outlet management UI, reseller/partner portal, in-app chat, automated refunds, AI insights, public status page, native mobile admin app.
