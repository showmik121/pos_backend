# Handover folder (shared by both repos)

This folder lives in `pos_backend` because the two repos (`pos_fontend`, `pos_backend`) share these documents. The frontend docs link here as `pos_backend/docs/handover/`.

| File | What it is |
|---|---|
| `HANDOVER_CHECKLIST.md` | Every handover item with status (✅ ⚠ ❌ 🔎), evidence, and the production-audit score (re-scored 58/100 after the QA re-test on 2026-11-20; was 55/100). Verdict: NOT READY for zero-problem handover |
| `KNOWN_LIMITATIONS.md` | Honest list of what is missing or risky, with file:line evidence |
| `PRD.md`, `GAP_ANALYSIS.md` | Product requirements and the gap between them and the built product |
| `handover-evidence/` | Command outputs the checklist cites (fresh-clone test before/after, live checks, test and coverage numbers, git state) |
| `handover-evidence/READINESS_REPORT.md` | QA re-test report: verdict, blockers, High/Medium/Low issues, what to test by hand, ready-to-paste fix prompts (one branch each) |
| `ECC_GUIDE.md`, `READINESS_TEST_PROMPT.md` | How the ECC skills/agents were used and the prompt behind the re-test |
| `PR_DESCRIPTIONS.md` | Ready-to-paste descriptions for the two `chore/handover` pull requests |

Notes
- These files are a snapshot taken on 2026-11-20. The evidence files are outputs of one run on one Windows machine; re-run the commands before trusting them later.
- Everything is written in Bangla except this README, the evidence files and the PR descriptions.
- `docs/RUNBOOK.md` and `docs/ONBOARDING.md` (in each repo) are the operating documents; this folder is the handover record.
- QA re-test evidence is split by repo: backend/shared files are in `handover-evidence/` here; frontend files (E2E runs x3, browser QA, silent-failure review, screenshots) are in `pos_fontend/docs/handover/handover-evidence/`.
