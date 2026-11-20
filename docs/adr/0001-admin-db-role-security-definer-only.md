# ADR 0001: The admin DB role has no table access, only SECURITY DEFINER functions

Status: accepted (A0) · Date: 2026-11-20 · Spec: ADMIN_PANEL_PRD §6.1, §7, acceptance 4

## Context
Operators need cross-tenant visibility, but `sync_events.payload` holds business data (cost prices) and the PRD requires
that an admin account compromise must not equal a data breach of every shop. The shop role `pos_app` is NOBYPASSRLS and relies
on `app.store_id`; admins have no store.

## Decision
- New role `admin_app` (LOGIN, NOBYPASSRLS, no superuser/createrole/createdb), connected through its own pool (`ADMIN_DATABASE_URL`).
- It has **zero grants on any table or column**. Every operation is an `admin_*` `SECURITY DEFINER` function with
  `SET search_path = public, pg_temp`, `REVOKE ... FROM PUBLIC`, `EXECUTE` granted to `admin_app` only (same pattern as `auth_throttle`, `record_client_error`).
- The admin tables (`platform_admins`, `admin_sessions`, `admin_audit_log`) have RLS on, no policy, and no grant to `pos_app`.
- A function never returns payloads, customers, sales or cost prices; later phases add aggregate-only functions.
- `admin_audit_log` also has the `forbid_update_delete` trigger, so it is append-only even for the table owner.

## Consequences
- Acceptance 4 is provable by a privilege test (`admin-schema.test.ts`), not by reviewing queries.
- Each new admin capability is a migration (new function). That is intended friction.
- `admin_find_by_email`/`admin_get` return the password hash and encrypted TOTP secret to `admin_app` (needed for login); only the server process holds that role.
- Supabase's `service_role` is unaffected by these revokes. The project must keep that key out of every runtime.

## Trust boundary (accepted at the A0 review, 2026-11-20)
The `admin_*` functions do **not** re-authorize their caller: the app layer (admin token, DB-backed session, role matrix, step-up, audit) is the control.
So holding the `admin_app` credential (`ADMIN_DATABASE_URL`) equals full admin-panel power: it can create a super admin, mint sessions, reset 2FA, and write
audit rows. It still cannot read any shop data (acceptance 4). Likewise `admin_get` / `admin_find_by_email` return the whole admin row (password hash and
encrypted TOTP secret) because login needs both.
- **Decision:** accept this for A0 and protect the credential like the JWT secrets (Supabase secrets only, rotated, never in a shared `.env`).
- **Why not fix now:** authorizing inside SQL means passing the session into every privileged function, enforcing role and step-up there, and writing the audit
  row in the same transaction. That is a redesign of most of 012 and every repo method, and nothing handles money before A3.
- **Revisit before A3** (real payments): move authorization and the audit write into the functions, and split the login read (needs the hash and secret) from
  the profile read (needs neither). That also closes the "action committed but audit write failed" window noted in the review.

## Rejected
Row-level policies for an admin role on shop tables (one wrong policy exposes every shop); a view layer (views owned by postgres still need careful grants and leak columns when altered).
