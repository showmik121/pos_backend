# Admin panel — build prompts (paste into Claude in the Antigravity terminal)

Spec: [ADMIN_PANEL_PRD.md](ADMIN_PANEL_PRD.md). Work in the order below, **one phase per session and one branch per repo per phase**. Do not skip the plan step.

Start Claude from the POS_SYSTEM folder so it sees both repos and the docs:

```powershell
cd "C:\Users\Md Zahidul Islam\Documents\POS_SYSTEM"
```
```powershell
claude
```

## 0. Master prompt (paste first in every session)

```
You are the senior engineer building the Bipone Platform Admin Panel.
Repos in this folder: pos_backend (TypeScript API on Supabase Postgres + Edge Function), pos_fontend (shop PWA, Next.js 15 static export),
docs/. A third repo pos_admin will be created by us (admin UI).
Read first: docs/ADMIN_PANEL_PRD.md (the spec), docs/PRD.md section 6.9, docs/KNOWN_LIMITATIONS.md,
pos_backend/CLAUDE.md, pos_backend/docs/RUNBOOK.md, pos_fontend/CLAUDE.md.

PROJECT FACTS YOU MUST RESPECT (verified in the code)
- Backend pattern: Repo interface in src/db/*.ts, TWO implementations (memory-*.ts for unit tests, pg-*.ts for Postgres),
  routes are regex maps in server/routes/*.ts wired in server/app.ts; input parsing in src/domain/*.ts; errors are DomainError with
  Bangla messages; money = integer poisha. Follow this exact pattern for admin code.
- DB: migrations in db/migrations/NNN_*.sql run by scripts/db-migrate.ts with the postgres role (DATABASE_URL_UNPOOLED).
  Existing: 001-009 and 011 (there is no 010; the next file is 012). Shops use role pos_app (NOBYPASSRLS) with app.store_id RLS.
  Hardening pattern to copy: tables with RLS enabled and no grants, touched only through SECURITY DEFINER functions with fixed search_path
  (see auth_throttle in 002 and record_client_error in 005).
- Auth: HS256 JWT in src/auth/token.ts, scrypt passwords, DB-backed rate limit. Admin needs its OWN secret, audience and routes.
- sync_events payloads contain business data (including cost price). The admin DB role must NEVER be able to read them.
- Backend main auto-deploys to Supabase. DB migrations are run by hand. Restore drill is still not done (readiness blocker B4).
- Golden fixtures + fixtures.lock must stay in sync across both repos if shared domain rules change.

HARD RULES
- Never push or merge to main, run migrations on the live database, deploy, or create GitHub repos/secrets without my explicit OK
  in this chat. Work on branches (feat/admin-<phase>). Commit locally only when I ask.
- Never print, store or commit secrets (JWT secrets, ADMIN_JWT_SECRET, DB URLs/passwords, Supabase tokens, TOTP seeds).
  If a secret is needed, tell me the variable name and where to set it; I will set it.
- Admin code may never mutate shop business data and may never expose password hashes.
- Every mutating admin route writes an audit row. A test must fail if one does not.

HOW YOU WORK (every task)
1. /ecc:plan first. Use ecc:search-first and read the code before designing. Show the plan and WAIT for my "go".
2. ecc:tdd-workflow: failing test first. Unit tests use the memory repo; add pg integration tests (tests/integration) for anything touching
   RLS, grants, SECURITY DEFINER functions or migrations, run against a LOCAL throwaway Postgres (UTF-8 database), never live.
3. After coding run the matching reviewers and fix every CRITICAL/HIGH: ecc:typescript-reviewer always, ecc:database-reviewer for SQL,
   ecc:security-reviewer for auth/admin/impersonation, ecc:silent-failure-hunter for the enforcement and dunning paths,
   ecc:react-reviewer for UI.
4. ecc:verification-loop (typecheck, lint, unit, integration, build). Nothing is done until it passes; show me the real output.
5. Update CLAUDE.md, RUNBOOK.md and docs/ADMIN_PANEL_PRD.md acceptance status. Write an ADR (ecc:architecture-decision-records) for each
   non-obvious decision.
6. End every task by listing what is NOT done or NOT verified.

Now: summarise in 8 bullets what the PRD asks for and how it maps onto the existing code (files and tables), list the PRD open
questions Q1-Q9 with your recommended default for each, and propose the order of work. Do not change any file yet.
```

## 1. Phase A0 — foundations (backend first)

```
Phase A0 from docs/ADMIN_PANEL_PRD.md section 13. Backend only (pos_backend), branch feat/admin-a0.

Scope: migration 012 (stores.status/plan_id/trial_ends_at/read_only_since with safe defaults so every existing store stays active;
platform_admins, admin_sessions, admin_audit_log append-only with no UPDATE/DELETE grant; role admin_app NOBYPASSRLS with NO direct grants on
tenant business tables; SECURITY DEFINER admin_* functions returning metadata and aggregates only); admin auth: login, TOTP 2FA with
recovery codes, step-up, 30-min idle/8-h absolute sessions, separate ADMIN_JWT_SECRET and aud=admin, reuse auth_throttle; admin role
permission matrix; enforcement of stores.status in the SHOP API (login, sync push/pull, write routes) returning tenant_suspended /
tenant_read_only with Bangla messages, queueing instead of discarding offline events (PRD 8.3); route-audit test (acceptance 9).

Must prove with tests: acceptance 3 (shop JWT rejected on admin routes and the reverse), 4 (admin role cannot read sync_events.payload,
customers, sales), 6 (no data before 2FA enrolment), 9. Existing 178 unit tests and golden tests must still pass.
Give me a rollout plan for migration 012 on the live database (order: migration, then deploy; rollback steps; what happens to the existing
deployed version) in pos_backend/docs/RUNBOOK.md, but do not run it.
Plan first, wait for my go.
```

## 2. Phase A1 — tenant operations (backend + new pos_admin + small shop-app change)

```
Phase A1 from docs/ADMIN_PANEL_PRD.md. Branches feat/admin-a1 in pos_backend and pos_fontend; create the new local folder pos_admin
(git init only, do NOT create the GitHub repo or push).
Backend: tenant list (cursor pagination, filters, search, masked phone), tenant detail, suspend/reactivate/read-only with reason and
step-up, notes, audit viewer endpoints.
pos_admin: Next.js static export with the same stack, lint, tsconfig, Vitest and Playwright conventions as pos_fontend; login + 2FA screens,
dashboard shell, tenants list/detail, audit page. Strict CSP without unsafe-inline, its own _headers, API URL env var. Use
ecc:design-system, ecc:frontend-design-direction, ecc:dashboard-builder, ecc:frontend-a11y and ecc:nextjs-turbopack. English UI.
pos_fontend: Bangla banners for suspended/read-only, disable new bill and stock-in in read-only but keep backup/export, never lose local data,
owner-visible support activity list. Add the E2E cases to e2e/ (mock API) and keep the existing 12 E2E tests green.
Acceptance 1, 2 and 7 must pass. Plan first, wait for my go.
```

## 3. Later phases (same pattern)

```
A2 Health: sync health per tenant, client_errors viewer with triage (error_triage table), dashboard tiles, version distribution. Also the
server-side negative-stock reconciliation alert (GAP_ANALYSIS B7). Plan first.
```
```
A3 Billing (manual): plans as data, subscription state machine with a dunning-state test suite, record/void payment with idempotency
key, trial extend, revenue overview that reconciles to payment rows. Money in integer poisha. Plan first.
```
```
A4 Support: read-only impersonation with distinct support token, 30-min expiry, owner-visible notice, excluded data (customers, cost price,
health data), announcements, tenant export and soft-delete workflow. Run ecc:security-reviewer twice and ecc:santa-method on the
impersonation design. Plan first.
```
```
A5 Flags and limits: per-tenant/per-plan flags and kill switches delivered with the login/sync response and cached offline by the shop app;
plan limits enforced by the API. Plan first.
```
```
A6 Automation: scheduled dunning (dry-run first), SMS notices, invoices PDF, payment gateway (SSLCommerz/bKash) with webhook signature
verification and idempotency, alerts. Plan first.
```

## 4. Before going live with the admin panel

```
Run ecc:production-audit and ecc:security-review on the admin surface: token confusion shop<->admin, IDOR on tenant ids, role escalation,
2FA bypass, brute force, audit completeness, admin role privileges, CSP of pos_admin, secrets handling, git history for secrets.
Verify with a staging Supabase project: restore drill, migration 012 rollout and rollback, suspension and reactivation end to end with a
real phone. Then update docs/ADMIN_PANEL_PRD.md acceptance table and give me a go/no-go with evidence files in docs/handover-evidence/.
```

## What you must do yourself

- Answer the PRD open questions (Q1, Q2, Q4, Q8 first).
- Set `ADMIN_JWT_SECRET` in Supabase secrets and CI (a random 48+ character value; never paste it in chat).
- Create the `pos_admin` GitHub repo and the admin hosting site when Claude tells you A1 is ready.
- Provide a staging Supabase project for rehearsals.
- Do the real-phone and printer tests; Claude cannot.
