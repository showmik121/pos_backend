import type { StoreStatus } from "../db/types.js"
import { DomainError } from "./errors.js"

// Pure rules for the tenant-ops admin routes (A1). The in-memory repo uses these directly; db/migrations/013 mirrors them in SQL
// and tests/integration/admin-tenants-pg.test.ts proves the two agree.

export type TenantStatusAction = "suspend" | "read_only" | "reactivate"

/** "01711000030" -> "017****030". Anything too short to mask meaningfully is fully hidden. */
export function maskPhone(phone: string): string {
  return phone.length >= 7 ? `${phone.slice(0, 3)}****${phone.slice(-3)}` : "****"
}

const FROM: Record<Exclude<TenantStatusAction, "reactivate">, readonly StoreStatus[]> = {
  suspend: ["trial", "active", "grace", "read_only", "cancelled"],
  read_only: ["trial", "active", "grace"],
}
const REACTIVATABLE: readonly StoreStatus[] = ["suspended", "read_only"]

/**
 * The status a tenant moves to, or null when the current status does not allow the action.
 * Reactivating returns to `trial` while the trial has not ended, otherwise `active` (PRD A1 decision D1; billing arrives in A3).
 */
export function nextStatus(action: TenantStatusAction, current: StoreStatus, trialEndsAt: string | null, nowMs: number): StoreStatus | null {
  if (action === "reactivate") {
    if (!REACTIVATABLE.includes(current)) return null
    return trialEndsAt !== null && Date.parse(trialEndsAt) > nowMs ? "trial" : "active"
  }
  if (!FROM[action].includes(current)) return null
  return action === "suspend" ? "suspended" : "read_only"
}

// ---- cursors. Tenant lists page by offset (stable order: chosen sort, then id); the cursor is opaque to clients.
const OFFSET_MAX = 5_000_000
const badCursor = () => new DomainError("invalid_input", "Request is not valid.", { issues: [{ path: "cursor", message: "invalid cursor" }] })

export function encodeOffsetCursor(offset: number): string {
  return Buffer.from(`o:${offset}`).toString("base64url")
}
export function decodeOffsetCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0
  const m = /^o:(\d{1,7})$/.exec(Buffer.from(cursor, "base64url").toString("utf8"))
  const n = m ? Number(m[1]) : NaN
  if (!Number.isInteger(n) || n > OFFSET_MAX) throw badCursor()
  return n
}

/** audit cursor = the last id of the previous page (rows are newest first) */
export function decodeAuditCursor(cursor: string | undefined): number | null {
  if (cursor === undefined) return null
  if (!/^\d{1,18}$/.test(cursor)) throw badCursor()
  return Number(cursor)
}
