# ADR 0009: A2 health decisions (stuck sync, error triage, negative stock, dashboard)

Status: accepted (A2 backend) · Date: 2026-11-21 · Spec: ADMIN_PANEL_PRD H-1, H-2, H-3, dashboard · Migration 014 · Extends ADR 0001, 0007

## 1. 014 is self-contained: no rollout-order hazard
The shop API calls nothing created in 014 (unlike 013's `sync_touch_store`). Old and new shop code both work on this schema. Only the admin API needs it. The deploy guard (ADR 0008) still blocks auto-deploy until `APPLIED_MIGRATION` reaches 14, which is the safe default.

## 2. "Stuck sync" = `coalesce(last_sync_at, created_at)` older than N hours
- Default 24 h (`DEFAULT_STUCK_HOURS`, shared by the list and the dashboard tile). A shop that never synced is measured from creation.
- Left out: `deleted`, `cancelled`, `pending_deletion` (gone) and `suspended` (it cannot sync, so listing it is noise). `read_only` and `grace` shops are included: they can still pull.
- Not available: "number of dropped/rejected events" and "outbox backlog age" from PRD H-1. The server has no such data (devices do not report). Needs device reports in a later phase.

## 3. Errors: triage is per fingerprint, the first reporter only
- `client_errors` keeps one row per fingerprint and the FIRST store, so "affected tenants" cannot be counted. The API exposes `firstStoreId` only.
- `error_triage` has an FK to `client_errors(fingerprint) ON DELETE CASCADE`: the 30-day purge removes triage rows with the error.
- A **resolved** error seen again after the resolution (`last_at > updated_at`) counts as open again (a fix that did not hold). An **ignored** error stays ignored. This is computed on read, in SQL and in the memory repo.
- A later decision without a note clears the earlier note (the note belongs to the latest decision).
- The fingerprint is in the URL path (`/health/errors/:fingerprint/triage`), so a denied or failed attempt is audited with `targetType client_error` and the fingerprint. The note text is never written to the audit row.

## 4. Crash text is untrusted
`POST /v1/client-errors` needs no token, so message, path and version are attacker-writable. The admin API scrubs on the way out (`src/domain/scrub.ts`: 6+ digit runs, ASCII and Bengali, become `#`; control characters removed; a version that is not a plain build id or version is dropped). The panel UI MUST still render these fields as text, never as HTML.

## 5. Negative stock is counts only
`admin_health_negative_stock` returns, per shop, the number of live batches below zero and the pieces short. No product names, prices or cost. Removed batches are ignored. The shop owner sees the same alert in the shop app (H-2): not built yet, A2b.

## 6. Dashboard
One SQL round trip (`admin_dashboard`): tenants by status, stuck sync, open errors seen in 24 h, shops with negative stock, signups since midnight **Asia/Dhaka**. MRR, trials ending and overdue payments are A3. Measured with 10,000 shops on real Postgres: dashboard + stuck-sync p95 about 33 ms (limit 1 s).

## 7. Not in this change (A2b)
Version distribution (H-4) needs the shop app to report its build (`NEXT_PUBLIC_APP_VERSION`), stored per shop. `client_errors.app_version` only covers shops that crashed, so it is not used as a stand-in.

## 8. Rollback order
014_down, then 013_down, then 012_down. 013_down now refuses while 014 is applied, because plpgsql bodies are not dependency-tracked and a half rollback would break the health functions only at run time.
