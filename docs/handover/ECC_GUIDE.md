# Using ECC Skills on Bipone — Step-by-Step Guide + Prompts

For: building `pos_fontend` + `pos_backend` with Claude Code in the terminal (Antigravity as the editor).
Read with: [PRD.md](PRD.md) (what to build) and [GAP_ANALYSIS.md](GAP_ANALYSIS.md) (what is missing, in what order).

---

## Part 1 — Setup (one time, ~15 minutes)

### Step 1. Confirm ECC is installed once, not twice

You already have the ECC plugin (`ecc@ecc`) enabled in `~/.claude/settings.json` — the GateGuard "Fact-Forcing Gate" messages you see are ECC hooks. **Do not run `install.sh` / `npx ecc-universal install` for Claude on top of it** — ECC's README warns that stacking installs duplicates skills and hooks.

In a terminal:

```powershell
claude
```

Then inside Claude:

```
/plugin list
```

You should see `ecc@ecc` enabled. To update later: `npx ecc-universal@2.2.3 setup` (re-runs the same plugin install; safe).

### Step 2. Fix duplicate rules (saves context on every message)

Rules are loaded into every message. Right now `common` + `typescript` rules load **twice**:

- globally from `C:\Users\<you>\.claude\rules\ecc\` (common, python, typescript)
- and per project from `pos_fontend\.claude\rules\ecc\` and `pos_backend\.claude\rules\ecc\`

Recommendation: **keep the project copies** (they are committed, so the client and any future developer get the same standards) and remove the global `common` + `typescript` copies. Keep global `python` only if you use it elsewhere.

```powershell
Remove-Item -Recurse -Force "$env:USERPROFILE\.claude\rules\ecc\common", "$env:USERPROFILE\.claude\rules\ecc\typescript"
```

(Skip this if other projects of yours rely on the global rules — duplication costs tokens but does not break anything.)

### Step 3. Add the React rule pack to the frontend

The frontend has `common`, `typescript`, `web` but not `react`. From the ECC repo (clone once anywhere, e.g. `C:\dev\ECC`):

```powershell
git clone https://github.com/affaan-m/ECC C:\dev\ECC
```

```powershell
Copy-Item -Recurse C:\dev\ECC\rules\react "C:\Users\Md Zahidul Islam\Documents\POS_SYSTEM\pos_fontend\.claude\rules\ecc\react"
```

Commit it in the frontend repo.

### Step 4. Antigravity

Claude Code in the terminal reads `.claude/` — that is all you need. Run ECC's Antigravity installer (`--target antigravity`, writes `.agents/`) **only if you also use Antigravity's own built-in agent**. Otherwise skip it; two agents with two rule sets on the same repo cause conflicting edits.

### Step 5. How to start Claude for each kind of task

| Task touches | Start Claude from | Command |
|---|---|---|
| Frontend only | `pos_fontend` | `cd pos_fontend` then `claude` |
| Backend only | `pos_backend` | `cd pos_backend` then `claude` |
| Both (API contract, golden fixtures, sync) | `pos_backend` + frontend added | `claude --add-dir ..\pos_fontend --add-dir ..\docs` |

Starting inside the repo makes Claude load that repo's `CLAUDE.md` (your domain rules in Bangla) automatically.

### Step 6. Hook strictness

GateGuard makes Claude state facts before the first edit/command — good discipline, slight slowdown. If it ever blocks legitimate work, tune it instead of removing ECC:

```powershell
$env:ECC_HOOK_PROFILE = "standard"
```

---

## Part 2 — The skills to use (shortlist from 327)

Only these matter for this project. Invoke a skill by naming it in your prompt ("use the `ecc:tdd-workflow` skill") or as a slash command where one exists (`/ecc:plan`).

### Plan
| Skill / command | When |
|---|---|
| `/ecc:plan` | Before every feature. Restates requirements, risks, steps, waits for your OK |
| `ecc:search-first` | Before writing utility code (e.g., ESC/POS encoder, Dexie migration) — finds existing libraries |
| `ecc:architecture-decision-records` | Record big decisions (IndexedDB, projection design, invoice numbering) as ADRs |

### Build
| Skill | When |
|---|---|
| `ecc:tdd-workflow` | Every feature and bug fix — failing test first |
| `ecc:nextjs-turbopack`, `ecc:react-patterns`, `ecc:frontend-patterns` | Frontend work |
| `ecc:typescript-patterns` | Both repos |
| `ecc:api-design`, `ecc:backend-patterns`, `ecc:error-handling` | New REST endpoints |
| `ecc:postgres-patterns`, `ecc:database-migrations` | Every migration and projection query |
| `ecc:bengali-nlp` | Phonetic search (napa → নাপা), Bangla number/word formatting |
| `ecc:healthcare-phi-compliance` | Prescription / patient data (pharmacy Rx feature) |
| `ecc:frontend-a11y` / `ecc:accessibility` | Sell screen, forms, low-literacy cashiers |

### Review (agents)
| Agent | When |
|---|---|
| `ecc:typescript-reviewer` | After any TS change (both repos) |
| `ecc:react-reviewer` | After any `.tsx` change |
| `ecc:database-reviewer` | After any SQL / migration / RLS change |
| `ecc:security-reviewer` | Auth, sync, payments, RLS, prescription data |
| `ecc:bengali-reviewer` | Any code that stores, searches, or prints Bangla text |
| `ecc:healthcare-reviewer` | Prescription / controlled-drug features |

### Verify & ship
| Skill / command | When |
|---|---|
| `ecc:verification-loop` | Before every PR: build, types, lint, tests, security grep, diff review |
| `ecc:e2e-testing` + `ecc:e2e-runner` agent | Playwright flows |
| `ecc:browser-qa`, `ecc:click-path-audit` | Click through the real UI after a feature |
| `/ecc:test-coverage` | Check 80% target |
| `/ecc:security-scan` | AgentShield scan of `.claude/`, hooks, secrets |
| `ecc:production-audit` | Before handover |
| `ecc:deployment-patterns`, `ecc:canary-watch` | Deploy + watch after release |
| `/ecc:update-docs`, `ecc:codebase-onboarding` | Keep `CLAUDE.md`, `RUNBOOK.md`, `ONBOARDING.md` true — this is your handover pack |
| `/ecc:save-session`, `/ecc:resume-session` | End / start of each working day |

---

## Part 3 — The working loop (repeat for every GAP_ANALYSIS step)

```
1. git checkout -b feat/<name>
2. /ecc:plan            → you read & approve the plan
3. tdd-workflow         → red → green → refactor
4. reviewer agents      → fix CRITICAL + HIGH
5. verification-loop    → all green
6. update-docs          → CLAUDE.md / RUNBOOK updated
7. commit, push, open PR, CI green → merge
```

One feature per branch. Never let Claude merge to `main` on the backend without CI — `main` auto-deploys to Supabase.

---

## Part 4 — Copy-paste prompts

Replace `<...>` parts. Each prompt is self-contained: paste into a fresh `claude` session started as shown in Step 5.

### Prompt 0 — Session kickoff (every new session)

```
Read CLAUDE.md, docs/RUNBOOK.md and ../docs/GAP_ANALYSIS.md (and ../docs/PRD.md for requirements).
Summarise in 5 bullets: current state, which GAP_ANALYSIS step we are on, and what is not done.
Do not change any files yet.
```

### Prompt 1 — Handover blockers B1 + B2 (start in pos_backend, add frontend)

```
Work on GAP_ANALYSIS step 1 (B1, B2) across both repos.
- pos_backend: node_modules is committed as a symlink to a Linux path. Remove it from git
  (git rm --cached), make sure .gitignore covers it.
- Both repos: generate and commit package-lock.json, switch CI from `npm install` to `npm ci`,
  update CLAUDE.md sections that say "no lockfile".
Use /ecc:plan first and wait for my approval. Then run ecc:verification-loop in each repo.
Create one branch per repo (chore/lockfile-hygiene). Do not push or merge — show me the diff summary.
```

### Prompt 2 — IndexedDB migration B3 (start in pos_fontend)

```
GAP_ANALYSIS step 2 (B3): move business data from localStorage to IndexedDB.
Constraints:
- Keep the DbProvider API ({db, ready, saveFailed, update, run}) unchanged so pages don't change.
- Keep all domain/store functions pure and immutable (see CLAUDE.md).
- One-time migration: on first load, read pos.db.v1.<storeId> from localStorage, write to IndexedDB,
  keep the old key as a backup until the migration is verified, never lose data on failure.
- Sync state, backup/restore, wipe, rescue, multi-tab (storage event replacement via BroadcastChannel) must keep working.
Use ecc:search-first to choose between Dexie and idb, then write an ADR with ecc:architecture-decision-records.
Use /ecc:plan, wait for approval, then ecc:tdd-workflow. Tests must cover: migration success, migration
failure rollback, quota error, two tabs open. Review with ecc:react-reviewer and ecc:typescript-reviewer.
Finish with ecc:verification-loop and update CLAUDE.md.
```

### Prompt 3 — Server projection B4 + B7 (start in pos_backend, add frontend)

```
GAP_ANALYSIS step 3 (B4, B7): project sync_events into the relational tables
(products, stock_batches, stock_movements, customers, sales, sale_items, payments, due_ledger).
Requirements:
- Idempotent and order-independent, same semantics as the frontend's src/lib/sync/replay.ts.
  Add golden fixtures for replay so both repos stay identical (follow the golden-lock process in CLAUDE.md).
- Runs inside the push transaction or as a follow-up job — propose both in /ecc:plan with trade-offs.
- RLS on every table, explicit GRANTs for pos_app, new migration 007, safe to run twice.
- When a batch goes negative from concurrent offline sales, write a reconciliation alert row.
- Add GET endpoints for owner reports (daily sales, dues, stock value, expiry) with keyset pagination.
Use ecc:postgres-patterns, ecc:database-migrations, ecc:api-design. TDD with unit + integration tests.
Review with ecc:database-reviewer and ecc:security-reviewer. Write the live-migration steps into RUNBOOK.md.
Do not merge to main (main auto-deploys).
```

### Prompt 4 — Feature template (use for steps 4–10)

```
Implement "<feature name from GAP_ANALYSIS, e.g. Partial returns against original invoice>".
Requirement source: ../docs/PRD.md section <x.y> and its acceptance criteria.
Rules:
- Domain logic in src/domain (backend) and src/lib/domain (frontend), pure functions, integer poisha.
- If the rule exists in both repos, change the golden fixtures FIRST (red), then code, then re-lock and copy.
- New sync event kinds must be backward compatible (unknown kinds are ignored).
- All UI text in Bangla, error messages tell the user what to do.
Steps: /ecc:plan (wait for my OK) → ecc:tdd-workflow → reviewers (<pick: react, typescript, database,
security, bengali, healthcare>) → ecc:verification-loop → /ecc:update-docs → commit on branch feat/<name>.
At the end tell me what is NOT done or not verified.
```

### Prompt 5 — Security audit (before any release)

```
Run a full security review of this repo before release.
1. /ecc:security-scan
2. ecc:security-reviewer agent on: auth, JWT, rate limiting, RLS policies, sync push/pull,
   CORS/ALLOWED_ORIGINS, CSP in public/_headers, anything storing patient/prescription data.
3. Check: no secrets committed (including history), every new table has store_id + RLS + GRANT,
   every SQL is parameterized, error responses don't leak internals.
Report findings as CRITICAL / HIGH / MEDIUM / LOW with file:line. Fix CRITICAL and HIGH on a
branch fix/security-<date>; list the rest for me.
```

### Prompt 6 — E2E and real-browser QA (pos_fontend)

```
Close GAP_ANALYSIS B8. Using ecc:e2e-testing and the ecc:e2e-runner agent, add Playwright tests for:
offline sale → reconnect → sync (both mock and E2E_REAL jobs), backup download → wipe → restore,
staff login cannot see cost price or void bills, expired batch can never be sold.
Then use ecc:browser-qa and ecc:click-path-audit on a 375px mobile viewport and list every broken or
confusing screen. Keep tests stable (no fixed sleeps). Run /ecc:test-coverage and report the numbers.
```

### Prompt 7 — Production readiness & client handover

```
Prepare this repo for client handover. Use ecc:production-audit and ecc:verification-loop, then:
- Fresh clone test: clone into a temp folder, npm ci, typecheck, lint, test, build — must pass with no manual steps.
- RUNBOOK.md: deploy, rollback, backup, restore (B5 — perform the restore drill on a staging project and record the result),
  rotating JWT_SECRET and DB password, adding a frontend origin to ALLOWED_ORIGINS.
- ONBOARDING.md: a new developer can run everything in under 30 minutes (use ecc:codebase-onboarding).
- README: what the product does, environments, env var names (never values), support contacts placeholder.
- List every known limitation honestly (from CLAUDE.md "জানা সীমাবদ্ধতা").
Output a HANDOVER_CHECKLIST.md with each item marked done / not done with evidence.
```

### Prompt 8 — End of day

```
/ecc:save-session
Summarise: what changed today, which branch/PR, what is not finished, and the exact next prompt I should paste tomorrow.
```

---

## Part 5 — Rules of thumb so the handover has "0 problems"

1. **Plan before code, always.** Never accept code from a prompt that skipped `/ecc:plan`.
2. **One feature = one branch = one PR.** Small PRs get real review.
3. **CI is the judge.** Don't merge red CI, especially in `pos_backend` (auto-deploys).
4. **Golden fixtures for every shared rule.** It's what keeps the phone and server agreeing.
5. **Migrations: `pg_dump` first, apply on staging, then live, then merge code** (already in your RUNBOOK — keep doing it).
6. **Ask Claude "what is not done or not verified?"** at the end of every task.
7. **Test on a real cheap Android phone and a real printer** before calling anything done.
8. **Never paste secrets into the chat** (JWT_SECRET, DB passwords, Supabase tokens).
