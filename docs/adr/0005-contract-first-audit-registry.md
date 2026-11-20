# ADR 0005: One contract file drives routes, validation, tests and the audit guarantee

Status: accepted (A0) · Date: 2026-11-20 · Spec: ADMIN_PANEL_PRD §10 (100 % audit), §17.9, acceptance 9

## Decision
- `src/contract/admin-api.ts` is the single source of truth for `/v1/admin`: path, method, auth level, permission action, whether it mutates, audit name, status, and zod request/response schemas.
- `server/routes/admin-handlers.ts` is typed from it (`Handlers = { [K in AdminRouteId]: ... }`), so a route cannot exist without a contract entry, and the dispatcher (`admin.ts`) is the only entry point.
- The dispatcher runs, in order: token (own secret, audience) -> live DB session -> per-admin rate limit -> permission matrix -> step-up -> contract validation -> handler -> **audit**.
  Every non-GET route is `mutating`; a mutating route writes its audit row on success, **and on denial or failure** (acceptance 1).
  A failed audit write fails the request (an unaudited admin action must not look successful) and never masks the original error on the failure path.
- Tests enforce it: every contract route has a handler and a unique `admin.*` audit name; one flow test drives every mutating route and fails if any lacks an `ok` audit row;
  every response is validated against its contract schema; no response or audit row may contain secrets or hashes.
- `pos_admin` (A1) copies the contract file and pins its hash (like `fixtures.lock`), so the two repos cannot drift.

## Known limit
Mutation and audit are two statements, not one transaction (A0 mutates only admin tables). From A1, tenant-affecting actions (suspend, etc.) must perform change + audit inside a single `SECURITY DEFINER` function.
