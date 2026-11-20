# Bipone POS - Release Readiness Report

Date: 2026-11-20 · Tested: `pos_fontend` `chore/handover` @ `fc0bfad`, `pos_backend` `chore/handover` @ `43e68a1` (fresh local clones; working trees had uncommitted changes, listed in section 0) · Node 24.18.0, npm 11.16.0, Windows 11.
This was a TEST run. No source was edited, nothing pushed/deployed/migrated; the live system received only read-only GET/HEAD requests (`/health`, front-end headers, GitHub public API).

## 1. Verdict

**NOT READY for a "zero-problem" client handover.** A *supervised pilot* (owner's own or a friendly shop, daily manual backup, no promise that staff cannot see cost price) is defensible only after Blockers 1 and 2 are fixed.

**Production audit score: 58 / 100** (previous: 55 / 100, +3).
Honest note on the method: `HANDOVER_CHECKLIST.md` gives the caps (<=69 while restore is undrilled and the live version is unconfirmed; <=84 without CI on the change) but no per-category weights. So this is the previous 55 adjusted with itemised deltas, not a fresh weighted score:
+3 real-Postgres integration run 18/18 and migrations idempotent · +2 E2E stable x3 with 0 flaky · +2 full owner/staff/second-device walk-through on the REAL backend with correct money · +1 tenant isolation proven at runtime · +1 backend CI green on the branch · -2 `chore/handover` is behind `main` (new) · -3 silent data-loss paths found (new) · -1 expired stock not surfaced, hold/resume absent (new). Net +3 (rounded). Both caps still apply, so 58 is far from "ready".

## 0. What was tested

| Area | Result | Evidence |
|---|---|---|
| Fresh-clone build, typecheck, lint, unit tests + coverage, build (both repos) | all exit 0; backend 131/131 tests; coverage below 80% (backend 57%, frontend whole-src far lower, `lib/domain` 95.5%) | `phase1-pos_backend.txt`, `phase1-pos_fontend.txt` |
| `fixtures.lock` + golden tests | clone vs working tree identical; backend golden 48/48; frontend golden pass. `git status` shows the lock "modified" in both working trees (cause not investigated) | `phase1-*.txt`, `phase1-pos_backend-golden.txt` |
| Backend integration vs real Postgres | **18/18 pass**, migrations 001-006 fresh + re-run no-op; local PG 18.7 UTF-8 (CI uses 16). First attempt failed only because my throwaway DB had a non-UTF-8 encoding | `phase2-integration.txt`, `phase2-integration-attempt1-encoding-WIN1252.txt` |
| Frontend E2E x3 | each run: **12 passed, 1 skipped (needs real backend), exit 0, no flaky tests**. The two `test.fail` known-defect tests fail as designed. (My first 3 runs are invalid: Git-Bash rewrote `/api` to a Windows path at build time; kept as `phase2-e2e-INVALID-*`.) | `phase2-e2e-run1..3.txt` |
| Real-browser walk-through, owner + staff (two isolated contexts), real backend + local DB, 375px and 1280px | journeys work; defects in section 3 | `phase3-browser-qa.txt`, `screens/` |
| Lighthouse (mobile) on /sell | Accessibility 100, Best Practices 100, SEO 100 | `screens/lighthouse-sell-mobile/` |
| Security (static review + runtime probes) | no CRITICAL; 2 HIGH; tenant isolation holds; staff cost-price leak confirmed | `phase4-security-review.txt`, `phase4-runtime-isolation-proof.txt` |
| Silent-failure review | 7 HIGH, 8 MEDIUM, 7 LOW | `phase4-silent-failures.txt` |
| `npm audit --omit=dev` | 0 vulnerabilities, both repos | `phase4-npm-audit.txt` |
| `/ecc:security-scan` (Claude config of both repos) | A 100/100, 0 findings (config only, not app code) | `phase4-agentshield-claude-config.txt` |
| Live health, CI status, branch vs `main` | live API is an old build; `main` has moved on | `phase5-live-health.txt`, `phase5-ci-status.txt` |

Uncommitted state tested as-is: frontend `next-env.d.ts`, `fixtures.lock` modified, `.claude/rules/ecc/react/` untracked; backend `fixtures.lock`, `vitest.config.ts` (adds `testTimeout: 15000`) modified, some `docs/handover/*` untracked. All builds/tests used fresh clones of the *committed* branch, so these local edits are not in the numbers above.

## 2. Blockers (must fix before handover)

| # | Severity | Blocker | Where / evidence |
|---|---|---|---|
| B1 | BLOCKER | **The handover branch is not based on current `main`.** Backend `main` is 5 commits ahead (migrations 007-011, sales API, PATCH /v1/store); frontend `main` is 12 ahead (expenses, credit limit, continuous scan, Excel export, new store types...). The client receives `main`; none of that code was tested here, and the security/robustness fixes are not in `main`. Merge conflicts likely. | `phase5-ci-status.txt` |
| B2 | BLOCKER | **Silent data-loss paths on the sale/save/restore path** (a bill can print but never sync; a corrupt local DB is replaced by an empty one and then overwritten; a failed local save still shows a successful receipt; restore claims success without checking the write and can re-issue bill numbers). Mitigated only by the owner taking backups. | `pos_fontend/src/components/db-provider.tsx:111-120`, `pos_fontend/src/lib/store/db.ts:42-54`, `components/backup-section.tsx:46-51`; `phase4-silent-failures.txt` #1-#7 |
| B3 | BLOCKER *if* "staff cannot see cost price" is a promise to the client (your decision) | **Staff can read cost price**: via `GET /v1/sync/pull` (events contain `costPoisha`) and on the staff product screen. REST hides it, sync does not. | `pos_backend/server/app.ts:251-259`, `src/db/pg.ts:149-165`; `phase4-runtime-isolation-proof.txt`; `screens/p3-375-staff-sees-cost-price.png` |
| B4 | BLOCKER | **Restore drill never performed and no down-migrations.** If the database is damaged nobody has proven recovery works; Supabase plan/PITR status unknown. | backend `docs/RUNBOOK.md` sec. 3, 9; checklist E2 |
| B5 | BLOCKER | **Deployed API is not the current code**: live `/health` = `{"status":"ok"}`, current code = `{"status":"ok","db":"ok"}` (confirmed locally). Auto-deploy only runs on `main` and silently skips when `SUPABASE_ACCESS_TOKEN` is missing, so you cannot currently tell what clients would hit. | `phase5-live-health.txt`, `.github/workflows/ci.yml` (deploy job) |

## 3. High / Medium / Low issues

**High**
- H-1 Server never validates sync event bodies; staff can push arbitrary sale/stock/due events with back-dated `at` that every owner device replays (`server/app.ts:53-67`; `phase4-security-review.txt` H2).
- H-2 Pulled events can be dropped silently (cursor advances), deferred events can wait forever, corrupt sync state resets the outbox/cursor (`lib/sync/engine.ts:325-332`, `replay.ts:117-196`, `state.ts:110-135`).
- H-3 Phone-clock rollback makes expired batches sellable (known B2; E2E `test.fail`). PRD P-2 says "never, online or offline".
- H-4 No real-device testing at all (Android/iOS, printer) and no monitoring/alerts/incident owner (RUNBOOK contact table empty).
- H-5 All business data lives in `localStorage` (~5 MB quota, full re-serialise on each change) - will hit the quota on a busy shop; B2 data-loss paths make that worse.

**Medium**
- M-1 Expired stock on hand is not shown on the home "attention" panel or the stock expiry count (home says "all fine" with 5 expired pieces): `lib/store/selectors.ts:84-86`.
- M-2 Hold/resume bills not built (single draft cart).
- M-3 Registration has no OTP (phone pre-registration takeover, number enumeration); 50-attempt lockout can be used against a victim; `x-forwarded-for` spoofing on plain Node (`server/app.ts:97-102,190-222`).
- M-4 No quota/cleanup on `sync_events` (one account can fill the DB disk); `ON CONFLICT DO NOTHING` acks a replayed id with different content (`src/db/pg.ts:144-147`).
- M-5 CSP allows `'unsafe-inline'` and `*.supabase.co` (`public/_headers:3`); JWT in localStorage, not revoked at logout, no password change/reset.
- M-6 Customer data and backup files are plaintext; no audit trail beyond the event log; no erase path.
- M-7 Frontend CI does not run on branch pushes (PRs and `main` only); `e2e-real` checks out backend `main`, not the branch.
- M-8 Device-id regeneration if storage blocks (burns the 26-device cap); unhandled promise rejection in the sync runner (`lib/store/device.ts:64-83`, `sync-runner.tsx:30-40`).

**Low**
- L-1 ASCII digits inside the Bangla UI ("1টি", "স্টকে মাত্র 10 পিস আছে").
- L-2 Staff bottom nav still lists "রিপোর্ট" (page then says owner-only).
- L-3 Cart accepts quantity above sellable stock (blocked at payment); stock-in accepts an already-expired date without warning.
- L-4 Boot-error text returned in an API response (`supabase/functions/api/index.ts:19-22`); scrypt N=16384 (low end), no pepper; GitHub Actions not SHA-pinned.
- L-5 ONBOARDING does not say the Postgres must be UTF-8 (non-UTF-8 fails migrations with `22P05`) and the backend has no lint script.
- L-6 Line numbers in `KNOWN_LIMITATIONS.md` B3-B5/B9 are ~2 lines stale.

### PRD P0 status (from PRD sec. 5 against what was observed / GAP_ANALYSIS)

| P0 item | Status |
|---|---|
| Sign-up with mobile + OTP | partial (phone + password, no OTP) |
| Setup wizard / VAT mode / receipt designer | missing |
| Product import (Excel/CSV) | partial (CSV only; Excel export exists on `main`, untested) |
| Opening stock with batch/expiry | built |
| Add by scan / search / generic search | partial (name search + camera scan; no generic-name search) |
| Edit qty/unit/line discount/price | partial (qty, discounts; no permission-gated price edit) |
| Cart/bill discount, VAT, rounding | partial (discounts correct; no VAT) |
| Payments: cash, mobile money, split, partial -> due | built (no card, no Upay) |
| Hold / resume bills | **missing** |
| Thermal 58/80 mm printing, SMS receipt | missing (`window.print` + share only) |
| Returns/refunds against invoice | partial (full-bill void only) |
| MRP enforcement | missing |
| Offline checkout + sync without duplicates | built (proven live: offline sale reached server exactly once) |
| Products/units/variants, per-product flags | partial (no variants, no flags) |
| Batch records, stock per batch, FEFO, expired-sale block | built (clock-skew guard missing) |
| Expiry alerts, low-stock alerts | partial (expiry page works; home/filter ignore expired stock) |
| Stock adjustment with reason, stock count | partial (batch removal with reason; no stock count) |
| Suppliers + purchase entry + Mushak registers | missing |
| Customer profile, baki khata, limits | built (SMS reminders unverified; credit limit only on `main`) |
| Roles/permission matrix, PIN login, audit log | partial (owner/staff only) |
| Cash register sessions | missing |
| Owner dashboard / reports / exports | partial (local only; owner-from-another-phone needs server projection, absent on this branch) |
| Multi-outlet, hardware (scanner/drawer), label printing | missing / unverified |
| Platform super-admin, plans, drug master | missing |

## 4. What could NOT be tested (you must do by hand)

1. **Real phones**: at least two cheap Android phones and one iPhone (Safari): install PWA, camera barcode scan, offline day, low-memory behaviour, sync over mobile data.
2. **Bluetooth/thermal printer and USB/Bluetooth barcode scanner** (only `window.print` exists; scanner as keyboard input unverified).
3. **Restore drill on a staging Supabase project** (needs staging project, `pg_dump`/`pg_restore`, the unpooled DB URL kept out of chat) - RUNBOOK sec. 9 has the template.
4. **Live checks needing credentials**: which migrations are applied on live; Supabase plan/backups/PITR; whether `SUPABASE_ACCESS_TOKEN` is set in GitHub Actions and why the deploy job did not update the function; GitHub branch protection.
5. **Frontend CI on Linux** (open a PR so it runs) and the full suite on Node 22 (CI/Netlify) - I used Node 24.18.
6. **Backup -> wipe -> restore by hand on a phone** and a manual "click every button" pass on every screen (I covered the main journeys; qa-375 E2E sweeps 32 screens automatically).
7. Firefox/Safari, load/stress, real-password scrypt timing on the live function, security testing beyond code reading and the runtime probes listed.
8. **Decisions only you / the client can make**: is hiding cost price from staff a contract term (decides B3)? Is a supervised pilot acceptable before `main` is merged? Which of `main`'s 17 newer commits are in scope for the handover? Who is the named incident owner? Is VAT/Mushak/returns/MRP in scope for v1 (they are PRD P0 and absent)? Are the CI workflow literals (DB/JWT secrets in `ci.yml` history) truly test-only?

Local test artefacts (throwaway Postgres, clones, servers) are in the scratchpad only and the servers are stopped; nothing was left running.

## 5. Ready-to-paste fix prompts (one branch each, priority order)

> Each prompt assumes the repos' own `CLAUDE.md` rules. Run tests first (red), then code. Do not merge or push to `main`.

### Fix 1 - branch `chore/rebase-handover-on-main` (both repos)
```
In pos_backend and pos_fontend, create branch chore/rebase-handover-on-main from origin/main and bring in everything from chore/handover
(lockfiles + npm ci, SYNC_STAFF_KINDS allow-list, malformed sync-event fix, self-hosted Bengali font, .gitattributes, E2E + qa-375 specs,
RUNBOOK/ONBOARDING/docs/handover). Resolve conflicts in favour of main's feature code while keeping the handover fixes; do not drop any main
migration (007-011). Then run, in a fresh clone: npm ci, typecheck, lint (frontend), unit tests, build, backend test:integration against a throwaway
UTF-8 Postgres, and npm run test:e2e three times. Make the frontend CI also run on branch pushes (ci.yml `on.push.branches: ["**"]`) and pin the
e2e-real backend checkout to a commit SHA. Save outputs under docs/handover-evidence/ and report any golden/fixtures.lock mismatch between the repos.
Open a PR per repo (backend first). Do not merge.
```

### Fix 2 - branch `fix/silent-data-loss` (pos_fontend)
```
TDD. Fix the silent data-loss paths from docs/handover-evidence/phase4-silent-failures.txt items 1-7:
(1) components/db-provider.tsx commit(): if eventsFromChange/writeSync throws, do not swallow - keep the change in a retry queue (or recompute on next load),
    report via reportCrash and show a visible banner; add a test that forces the throw and proves the sale still gets an outbox event later.
(2) when saveDb returns false, block navigation to the receipt (or show a blocking "not saved - back up now" dialog) and never clear the saveFailed flag
    until a successful save of the SAME state.
(3) lib/store/db.ts loadDb(): on JSON.parse/getItem failure copy the raw string to the .corrupt key BEFORE returning emptyDb(), refuse to overwrite while the
    .corrupt copy exists unless the user confirms, and surface a recovery screen. (4) lib/sync/state.ts: validate outbox/deferred elements, keep a .corrupt copy.
(5) lib/sync/engine.ts/replay.ts: count and surface ignored/dropped pulled events (kind, id) in SyncStatus; never advance the cursor past a failed apply silently;
    give deferred events an age limit that raises a visible alert.
(6) components/backup-section.tsx restore: check saveFailed, reset/reconcile cursor, outbox and billCounter (billCounter >= max(sale.no)), generate void/removal events or
    warn that sales absent from the backup remain on the server.
Add unit tests for each; keep money integer poisha. Run typecheck, lint, test, build and the full Playwright suite x3.
```

### Fix 3 - branch `fix/staff-cost-privacy` (both repos)
```
Decide with the owner first: staff must not see costPoisha. Backend: in pullEvents (src/db/pg.ts) and the pull route (server/app.ts) strip costPoisha
(and any equivalent cost fields inside sale allocations) from payloads for role=staff, or split owner-only cost into separate events; make staff stock_in
not overwrite the owner's cost price. Add integration tests: staff pull contains no costPoisha, owner pull does, staff stock-in does not change cost,
store B still sees nothing of store A. Frontend: hide cost in products/detail, products/edit and stock/in for staff; handle the cost-less payloads in replay.ts and
schemas.ts; remove the test.fail markers in e2e/critical-flows.e2e.ts for the cost test and make it pass with E2E_EXPECT_FIXED=1.
Deploy order: frontend first, then backend (see RUNBOOK 2). Update KNOWN_LIMITATIONS B1/F7.
```

### Fix 4 - branch `ops/restore-drill-and-rollback` (docs + CI, owner runs the drill)
```
Do not touch the live database. Prepare: (a) a script docs/ops/restore-drill.sh (pg_dump/pg_restore to a STAGING Supabase project taken from env vars, never printed) that
restores a backup, runs `npm run db:migrate` (must be a no-op) and `npm run test:integration` against it, and writes an evidence file;
(b) a CI job (manual workflow_dispatch) that runs the same drill against a throwaway Postgres 16 service container as a smoke test;
(c) down/forward-fix guidance per migration 001-011 in RUNBOOK 3, with a tested "restore from backup" path;
(d) fill RUNBOOK 0 owners/contacts template and add an UptimeRobot/Supabase alert checklist for /health.
The owner then runs the drill on staging and pastes the evidence into docs/handover-evidence/restore-drill.txt.
```

### Fix 5 - branch `ops/live-version-and-deploy` (pos_backend)
```
Make the deployed version observable and the deploy loud: add `version` (git sha injected at build in edge/build.mjs) to the /health body ({"status":"ok","db":"ok","version":"<sha>"});
change the deploy job in .github/workflows/ci.yml so a missing SUPABASE_ACCESS_TOKEN FAILS the job on main (not a silent skip), and have the post-deploy check compare the live
/health version to the deployed sha. Add a test for the health shape. Document in RUNBOOK 1/3 how to confirm the live migration state (the SQL already in RUNBOOK 3)
and add a "deploy history" line to the evidence checklist. Do not deploy.
```

### Optional next branches (High items)
- `fix/sync-event-validation` (H-1/M-4): zod schemas per event kind on the server, cap `at` skew vs server time, per-store event quota, reject same-id-different-payload with 409.
- `fix/expiry-visibility-and-hold-bills` (M-1/M-2/L-1..L-3): count expired stock on home and stock filter, hold/resume multiple carts, Bangla digits everywhere, warn on past expiry at stock-in, hide "রিপোর্ট" nav for staff.
- `fix/clock-skew-guard` (H-3): use server time from the last sync as the expiry reference and warn when the phone clock goes backwards.
