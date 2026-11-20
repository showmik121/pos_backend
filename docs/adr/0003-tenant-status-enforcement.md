# ADR 0003: Tenant status is enforced inside the shop API's `authenticate()`, always as HTTP 403

Status: accepted (A0) · Date: 2026-11-20 · Spec: ADMIN_PANEL_PRD §8, §17.3, §17.4, Q10

## Decision
- `stores.status` (migration 012) is read together with the user in the existing per-request `getUser` query (a join; no extra round trip, no cache, so a suspension applies on the very next request).
- One central gate in `authenticate()` calls the pure `tenantBlockFor(status, method, path)`:
  - `suspended`, `pending_deletion`, `deleted`: every authenticated route returns **403 `tenant_suspended`**, except `GET /v1/me` (and crash reports).
  - `read_only`: every non-GET returns **403 `tenant_read_only`**; reads and sync pull stay open; `POST /v1/sync/register-device` stays allowed (no business data).
  - `trial`, `active`, `grace`, `cancelled`: unchanged.
- **Login still succeeds** for a suspended shop and returns `tenantStatus` + `statusMessage` (decision Q10), so the owner can read the notice. The data routes are what 403, including sync pull: there is NO server-side export for a suspended shop (PRD §8.1 lists backup/export as allowed; that is not built in A0 and needs a decision before A3). The phone's own local data stays intact and its queue is kept (403, never 400/413). Unknown or future statuses fail closed (treated as suspended).
- Errors are **403, not 400/413**: the shop sync engine keeps its outbox on 403 and drops events on 400/413 (a pinning test lives in `pos_fontend/tests/sync-engine.test.ts`). Offline work is never lost to a status change (§8.3).
- Existing stores are backfilled `active` + `grandfathered`; signup creates `trial` (14 days) inside `auth_register_store`.
- `pos_app` cannot UPDATE `stores.status` (only `name`): a shop can never reactivate itself. Status changes arrive in A1 as `SECURITY DEFINER` admin functions.

## Consequences
- An unknown/NULL status can never occur (CHECK constraint). A store row missing at all makes `getUser` return null, so the request is unauthorised (fails closed).
- Old shop frontends treat any unrecognised 403 as an auth-type stop (queue kept, sync paused); the new Bangla banners arrive in A1.
- Status is not cached; if admin tables are unavailable the shop API is unaffected because status lives on `stores`.
