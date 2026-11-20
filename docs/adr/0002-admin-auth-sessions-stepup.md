# ADR 0002: Admin authentication = password + TOTP, DB-backed sessions, step-up in the session row

Status: accepted (A0) · Date: 2026-11-20 · Spec: ADMIN_PANEL_PRD A-1..A-4, §17.2, §17.8

## Decision
- **Own secret and audience.** `ADMIN_JWT_SECRET` (must differ from `JWT_SECRET`, enforced at startup), tokens carry `aud` = `admin` or `admin-pending`.
  The shop verifier now rejects *any* token that has an `aud`, so token confusion is closed even if the two secrets were ever equal.
- **Role is never in the token.** It is read from `platform_admins` on every request, so demotion/deactivation is immediate.
- **Sessions are rows** (`admin_sessions`): idle 30 min and absolute 8 h are checked in one SQL statement per request
  (`admin_session_touch`); logout, deactivation, password change and 2FA reset revoke rows. No JWT revocation list is needed.
- **Two-stage login.** `login` (password) creates a *pending* session (5 min) that can only reach the 2FA/enrolment routes.
  A full session exists only after a valid TOTP (or a single-use recovery code). An admin who is not enrolled therefore
  cannot receive any data (acceptance 6).
- **Step-up** (`POST /auth/step-up`: password + a fresh TOTP) sets `stepup_until = now + 5 min` on the session; sensitive actions require it.
  The permission matrix marks which actions need it (`requiresStepUp`).
- **TOTP** is implemented with `node:crypto` (RFC 6238, SHA-1, 6 digits, ±1 step, replay guard via `totp_last_step`, atomic in SQL).
  Secrets are AES-256-GCM encrypted with `ADMIN_TOTP_ENC_KEY`; recovery codes are stored as keyed HMACs and consumed atomically.
- **Throttle buckets** use the `admin:` prefix (`admin_throttle`), so shop login attempts can never lock admins out and vice versa.

## Consequences
- One DB round trip per admin request (acceptable at admin volumes).
- Losing `ADMIN_TOTP_ENC_KEY` means every admin must re-enrol; the CLI `--reset` is the break-glass path (ADR 0004).
- IP is taken from the same header chain as the shop limiter (`cf-connecting-ip` first). The known spoofing caveat (KNOWN_LIMITATIONS B5) applies to the per-IP login bucket; the per-account bucket does not depend on it. The per-pair and per-IP buckets do (a missing address shares one "?" bucket, as in the shop login). Login checks pair, then IP, then email, so a single address can never fill the shared email bucket past its own limits (santa review, round 1). Bucket names carry a hash of the email, never the email: the database caps a bucket at 200 characters. IPv6 addresses count as their /64 (`ipGroup`), so one host cannot mint endless "different" addresses.
  **Residual, accepted trade-off:** ~10 genuinely different IPv4 addresses (a botnet), each sending 5 wrong logins, can still fill the 50-slot per-email ceiling and block that admin's login for the 15-minute window. Letting a correct password bypass the ceiling would remove the only per-account brute-force cap, so it is not done. Mitigations: the admin site sits behind Cloudflare Access / an IP allow-list (decision Q9), the break-glass `create-admin --reset` clears the bucket, and TOTP is still required after the password. Revisit if the panel is ever exposed without an allow-list in front.

## Rejected
Stateless admin JWTs with a revocation list (more moving parts); WebAuthn (good later, not required by the PRD); an external TOTP library (one more dependency for ~40 lines, and the Deno runtime must run it).
