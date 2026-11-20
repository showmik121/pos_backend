# ADR 0004: The admin API is feature-gated by env; the first admin is created only by a local CLI

Status: accepted (A0) · Date: 2026-11-20 · Spec: ADMIN_PANEL_PRD §17.1, §17.2, §17.6

## Decision
- `/v1/admin/*` is mounted only when **all three** of `ADMIN_JWT_SECRET`, `ADMIN_DATABASE_URL`, `ADMIN_TOTP_ENC_KEY` are present and valid.
  Otherwise it answers a plain 404 and the shop API is unaffected. A partial or invalid configuration logs the variable *names* and disables the admin
  surface; it never crashes the shop API. (Main auto-deploys, so merging before secrets exist must be harmless.)
- `scripts/create-admin.ts` (`npm run create-admin`) is the only way to create the first super admin and the break-glass for a locked-out last super admin
  (`--reset`: new password, new 2FA secret, sessions ended, reactivates). It runs locally with `DATABASE_URL_UNPOOLED`, writes an audit row with `actor = cli`,
  prints credentials to the operator's terminal only, and is never reachable over HTTP.
- Admin routes are in both runtimes: they live in `server/app.ts`, so the Node server and the Edge bundle contain them. `edge/build.mjs` fails the build
  if the bundle lacks the admin/enforcement markers, and `edge/smoke-test.mjs` (Deno, CI) proves the routes answer 401/400 rather than 404.

## Consequences
- The CI `supabase-edge` job sets placeholder `ADMIN_*` values to open the gate; they are not credentials.
- An operator mistake (one of three variables missing) silently means "no admin panel"; the log line names which variable.
