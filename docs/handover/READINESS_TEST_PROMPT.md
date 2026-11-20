# Readiness test prompt (paste into Claude in the Antigravity terminal)

Start Claude from the POS_SYSTEM folder so it can see both repos and docs:

```powershell
cd "C:\Users\Md Zahidul Islam\Documents\POS_SYSTEM"
```
```powershell
claude
```

Then paste everything inside the block below.

```
You are the release QA lead for Bipone, a Bangla offline-first POS (pharmacy + retail) for Bangladesh.
Folders: pos_fontend/ (Next.js 15 PWA), pos_backend/ (TypeScript API on Supabase Postgres), docs/.
Read first: pos_fontend/CLAUDE.md, pos_backend/CLAUDE.md, both docs/RUNBOOK.md, docs/PRD.md,
docs/GAP_ANALYSIS.md, docs/HANDOVER_CHECKLIST.md, docs/KNOWN_LIMITATIONS.md, docs/handover-evidence/.

GOAL: Test the whole project and give me an honest verdict: is it ready to hand to a client with zero problems?
This is a TEST run, not a fix run.

HARD RULES
- Do NOT edit source code, push, merge, deploy, or run migrations against the live database.
- You may only write: new files under docs/handover-evidence/ and updates to docs/HANDOVER_CHECKLIST.md
  and docs/KNOWN_LIMITATIONS.md.
- Test the chore/handover branch in both repos. Do not switch branches; if a repo has uncommitted
  changes, list them and test as-is.
- Never print or save secrets (JWT_SECRET, DB URLs/passwords, SUPABASE_ACCESS_TOKEN). If a step needs one, skip it and mark it 🔎.
- Every claim needs evidence: the exact command + its output saved to docs/handover-evidence/<name>.txt.
  No evidence = not passed. Never mark something ✅ because "it should work".
- Run long commands (builds, Playwright) in the background and wait for them; do not guess results.

STEP 0 – Plan
Use /ecc:plan to list the phases below with what you will run in each. Show it to me and WAIT for "go".

PHASE 1 – Reproducible build (ecc:verification-loop), each repo separately
- Fresh clone into a temp folder from the LOCAL repo (git clone <local path> -b chore/handover),
  then: npm ci, typecheck, lint, unit tests with coverage, build (frontend: next build; backend: build:edge).
- Golden fixtures: confirm fixtures.lock matches in both repos and golden tests pass on both sides.
- Save as evidence/phase1-<repo>.txt. Record Node and npm versions.

PHASE 2 – Integration and E2E (ecc:e2e-testing, ecc:e2e-runner agent)
- Backend: test:integration against a LOCAL/throwaway Postgres only (if none available, mark 🔎 and say what is needed).
- Frontend: npm run test:e2e (all specs, incl. critical-flows and qa-375). Run the whole suite 3 times;
  any test that fails even once is flaky -> report it.
- Report pass/fail counts per run.

PHASE 3 – Real-user click testing (ecc:browser-qa + ecc:click-path-audit)
- Start the frontend locally and drive it in the browser at 375px (phone) and 1280px.
- Walk these journeys as owner AND as staff: signup/login, add product with batch + expiry, scan/search,
  sell (cash, bKash, split, credit/baki), discount, hold/resume, void, due collection, low-stock and expiry
  pages, backup -> wipe -> restore, go offline -> sell -> back online -> sync, second device sync.
- Click every button. Report console errors, broken layouts, English text left in the Bangla UI,
  wrong totals (money must be integer poisha), and any expired batch that can be sold.
- Run a Lighthouse/axe pass on the sale screen. Screenshots into evidence/screens/.

PHASE 4 – Security (ecc:security-review skill + ecc:security-reviewer agent + ecc:silent-failure-hunter agent)
- Review auth, JWT, password hashing, rate limiting, RLS + pos_app role, store isolation in sync push/pull,
  staff permissions (cost price hidden, cannot void), CORS, CSP, input validation, error leaks.
- Prove tenant isolation with the integration tests: store A must never read or write store B data.
- npm audit --omit=dev in both repos. Search full git history of both repos for secrets.
- Patient/prescription data handling per ecc:healthcare-phi-compliance (note what is missing).
- Note: /ecc:security-scan only audits Claude/agent config, not app code — run it once for the .claude folders, separately.

PHASE 5 – Production readiness (ecc:production-audit + ecc:deployment-patterns)
- Backend live check: GET the live /health and compare with the code (is the deployed version current?).
- Check CI workflows, deploy job, env var documentation, migrations order and rollback, backups,
  restore drill status, monitoring/alerts, RUNBOOK and ONBOARDING accuracy (try following ONBOARDING
  literally on the fresh clone).
- Check PRD P0 items against what is built: list each P0 as built / partial / missing.

PHASE 6 – Verdict
- Re-score the production audit 0-100 with the same rubric used in HANDOVER_CHECKLIST.md and show the
  change from the previous 55/100.
- Update docs/HANDOVER_CHECKLIST.md (every item ✅ / ⚠ / ❌ / 🔎 with evidence path) and KNOWN_LIMITATIONS.md.
- Write docs/handover-evidence/READINESS_REPORT.md in English with:
  1. Verdict: READY / READY FOR PILOT ONLY / NOT READY, in one line.
  2. Blockers (must fix before handover) - each with file:line or evidence file, and severity.
  3. High / Medium / Low issues.
  4. What could NOT be tested and what I must do by hand (real Android phones, Bluetooth printer,
     restore drill on staging Supabase, decisions only I/the client can make).
  5. A ready-to-paste fix prompt for each blocker, in priority order, each one = one branch.
- Finish by telling me in chat: the verdict, the score, the top 5 blockers, and anything you skipped.
```

## After the test

1. Read `docs/handover-evidence/READINESS_REPORT.md`.
2. Paste the fix prompts from the report one at a time, using the build loop in [ECC_GUIDE.md](ECC_GUIDE.md).
3. Run this test prompt again. Hand over when the verdict is READY and every ❌ in the checklist is closed or accepted in writing by the client.
