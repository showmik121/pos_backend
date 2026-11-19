# Pull request descriptions (paste into GitHub)

Open: https://github.com/showmik121/pos_backend/pull/new/chore/handover and https://github.com/showmik121/pos_fontend/pull/new/chore/handover

**Neither PR was opened, no CI has run on these branches, and nothing was merged into `main`.** Merging `main` auto-deploys (Netlify for the frontend, Supabase for the backend if `SUPABASE_ACCESS_TOKEN` is set), so review and watch CI first.

## Merge / deploy order (there is a real conflict, decide consciously)
- The frontend CI job `e2e-real` checks out the backend `main` and runs `npm ci` there, so it **fails until the backend lockfile is on `main`**.
- But the backend now rejects owner-only sync events from staff (403). An **old cached frontend** treats 403 as an auth failure and stalls that phone's sync. So at runtime the **frontend must be published before the backend deploys**.
- Safest sequence: merge **frontend first** (accept or re-run the failing `e2e-real` check after step 2), publish, then merge **backend**, then re-run frontend CI to confirm `e2e-real` is green. If you prefer green CI at every step, merge the backend first but expect a short window where staff phones that queued a batch removal may stall until they reload.

---

## PR 1: `pos_backend` — `chore/handover` → `main` (4 commits)

**Title:** Handover: reproducible install, staff sync allow-list, handover docs

**What changed**
- `c403cc7` Untrack the committed `node_modules` symlink (it pointed at a Linux path), fix `.gitignore`, commit `package-lock.json`, CI uses `npm ci`.
- `c8d8397` **Security:** `/v1/sync/push` previously blocked staff from only two event kinds. Now staff may push only `product_upserted`, `stock_in`, `customer_upserted`, `sale_completed`, `due_received`; everything else (including `batch_removed` and unknown kinds) is owner-only (403 `forbidden`). 3 new tests.
- `c4d7aa3` `.gitattributes` so golden-fixture hashes survive a Windows checkout (the golden-lock test failed on every fresh Windows clone).
- `7b15588` Complete `docs/RUNBOOK.md` and `docs/ONBOARDING.md`; later commit adds `docs/handover/`.

**Evidence (2026-11-20, Windows, Node 24.18)** — see `docs/handover/handover-evidence/`
- Fresh clone: `npm ci`, typecheck, tests (131/131), `build:edge` all exit 0.
- `npm audit --omit=dev`: 0 vulnerabilities.
- Coverage (unit only): 53.6% statements `src`, 62.2% `src`+`server`.

**NOT verified:** CI on this branch; Postgres integration tests (not run in this work); behaviour on Supabase's own environment; the live API (its `/health` returned `{"status":"ok"}` without the `db` field, so the deployed function looks older than `main`).

**Known gap (not fixed here):** staff can still read `costPoisha` from `/v1/sync/pull`. Fixing it needs a matching frontend change, see `docs/handover/KNOWN_LIMITATIONS.md` B1.

**Deploy note:** deploy the frontend first (see order above).

---

## PR 2: `pos_fontend` — `chore/handover` → `main` (6 commits)

**Title:** Handover: lockfile, sync hardening, E2E + 375px QA, self-hosted font, docs

**What changed**
- `faa50ce` Commit `package-lock.json`; CI uses `npm ci`, caches on the lockfile, the audit job uses it.
- `f009ccb` **Security/robustness:** one malformed pulled sync event could throw in `applyEvents` and stop sync for every device in the store. Added zod shape guards (`src/lib/sync/schemas.ts`, accept/reject only, payload untouched), per-event `try/catch`, and a 403 `forbidden` push now keeps the event queued (not dropped). Batch removal button is owner-only on the expiry page. Tests: `sync-malformed`, `sync-roundtrip`, `sync-engine`.
- `6d16627` Playwright tests: offline sale then sync; backup then wipe then restore; staff vs owner; expired batch never sold; a crawler that walks 32 screens at 375px. Two **known bugs are documented with `test.fail`**: staff can see cost price in the UI; rolling the phone clock back makes expired batches sellable (`E2E_EXPECT_FIXED=1` runs them as normal tests).
- `302f7c3` `.gitattributes` for golden fixtures (Windows).
- `20ae5ae` Self-host Noto Sans Bengali (`@fontsource/noto-sans-bengali`) because `next/font/google` fetched from Google at build time and failed once in a fresh clone.
- `a72f3da` Complete `docs/RUNBOOK.md` and `docs/ONBOARDING.md`.

**Evidence (2026-11-20, Windows, Node 24.18)** — see `pos_backend/docs/handover/handover-evidence/`
- Fresh clone: `npm ci`, typecheck, lint, tests (235/235), build all exit 0.
- Playwright: 12 passed, 1 skipped (needs a real backend, `E2E_REAL=1`); 2 of the 12 are the expected-failure bug tests.
- 375px: 32 screens/states, 0 horizontal overflow, 0 console errors, axe-core 0 violations. Small issues are listed in `KNOWN_LIMITATIONS.md` D8.
- Coverage (unit only): 76.6% statements for `src/lib`; 24.6% for all of `src` (components are covered by E2E only).

**NOT verified:** CI on this branch; Linux; the real-backend E2E; real phones (Android/iOS) and printers; Firefox/Safari.

**Build note (Windows):** do not run `NEXT_PUBLIC_API_URL=/api npm run build` in Git Bash (MSYS rewrites `/api`); use PowerShell. See `docs/RUNBOOK.md`.
