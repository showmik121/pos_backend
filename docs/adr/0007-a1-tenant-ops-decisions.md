# ADR 0007: A1 tenant-ops decisions (list paging, last-sync source, owner-visible activity, reactivate target, admin SPA)

Status: accepted (A1) · Date: 2026-11-21 · Spec: ADMIN_PANEL_PRD §5.3, §8, §12 items 1, 2, 7 · Migration 013 · Extends ADR 0003

## 1. Tenant list uses an offset-paged cursor, one SQL statement
- The cursor is `base64url("o:<offset>")`, capped. One `admin_tenant_list` call returns the page plus `total` (`count(*) OVER ()`), sorted by a whitelisted key plus `id` as the tiebreak.
- Why not keyset: the list sorts by `lastSync`, `status` and `name`; a stable keyset cursor over every sort would need a composite index per sort. At the target scale (10,000 tenants, measured p95 about 10 ms on real Postgres) offset is simpler and fast.
- Trade-off, accepted: while an operator pages, tenants created or syncing between pages can shift rows (a duplicate or a skip). `total` is `0` for an offset past the end. The cursor is not bound to the filter that produced it. Revisit with keyset if the list passes about 100k rows.

## 2. "Last sync" is `stores.last_sync_at`, not `sync_devices.last_seen_at`
- `sync_touch_store()` (SECURITY DEFINER, `pos_app` only) updates `stores.last_sync_at` at most once per 5 minutes, inside the shop's existing push/pull transaction. A per-store column makes "no sync for N days" a plain filter instead of an aggregate over devices.
- Cost: shop push and pull now call a function that exists only after migration 013. **013 must be applied before the API that calls it is deployed** (RUNBOOK 3খ).

## 3. The owner sees what the operator did, never why
- `tenant_status_events` stores `reason` (internal) and an optional Bangla `message`. `pos_app` gets a **column** grant on `(id, store_id, at, to_status, message)` only, plus RLS; `reason` and `admin_id` are unreadable to the shop by construction.
- `GET /v1/account-activity` (shop auth, allowed while suspended) returns `{at, status, message}`. The shop app lists it in Settings. Staff can read it too (it is the same banner they already see).
- The operator's message is plain text in React (escaped). It is limited to 500 characters.

## 4. Reactivate goes to `trial` if the trial has not ended, else `active`
- The function row-locks the store (`FOR NO KEY UPDATE`, `lock_timeout 3s`, so it never queues behind shop inserts that hold FK key-share locks), checks the transition (mirrors `nextStatus` in `src/domain/tenant-admin.ts`) and writes the event row in the same transaction.
- Known gap: a store suspended from `grace` returns to `active`, not `grace`. Revisit in A3 with billing.

## 5. Phone search is exact-match only
- The list returns masked phones. A substring search would let a caller recover the hidden digits by probing (`017` + guess). So search matches a full number exactly; name and id keep substring matching. Full numbers come only from the audited `revealPhone` route.

## 6. Admin SPA: in-memory token, hash-based strict CSP
- The admin token lives in a module variable only (a reload signs out). `pos_admin` is a static export; `scripts/csp-headers.mjs` hashes the inline scripts into `out/_headers` and fails the build on any inline style. The CSP only applies if the host honours `_headers` (Cloudflare Pages/Netlify); hosting is open question Q9.
- `pos_admin` holds byte-identical copies of `src/contract/admin-api.ts` and `src/domain/admin-permissions.ts`, pinned by `contract.lock` (sha256, CRLF-normalised). Its unit test fails on drift.

## 7. Audit write after commit
- The handler commits, then the audit row is written. A failed audit write is retried once; if it still fails the request returns 500 and logs `admin action APPLIED but audit write failed` with the request id, and no false `error` row is written. Making status change and audit row one transaction is the proper fix and is deferred (it needs the audit append inside each `admin_*` mutation function). Until then this is a known gap in "every mutation is audited".
