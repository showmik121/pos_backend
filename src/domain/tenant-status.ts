import type { StoreStatus } from "../db/types.js"

// Which requests a store's status allows (PRD §8.1, §17.4). Pure; the HTTP layer calls it from authenticate().
//   suspended / pending_deletion / deleted : nothing except login, GET /v1/me, and crash reports (those bypass this check)
//   read_only                              : reads and sync pull stay open; every other write is refused
//   trial / active / grace / cancelled     : unchanged behaviour
// Both blocks are HTTP 403 (not 400/413) on purpose: the shop sync engine KEEPS its queue on 403 but DROPS events on 400/413,
// so a suspended or read-only shop never loses offline work (§8.3, §17.4).

export type TenantBlockCode = "tenant_suspended" | "tenant_read_only"

export interface TenantBlock {
  code: TenantBlockCode
  message: string
}

// EXHAUSTIVE on purpose (a new StoreStatus is a compile error here) and fail-closed at runtime: a status this code does not know
// (a future migration, a malformed row, undefined) is treated as suspended, never as "active".
const POLICY: Record<StoreStatus, "open" | "read_only" | "blocked"> = {
  trial: "open", active: "open", grace: "open", cancelled: "open",
  read_only: "read_only",
  suspended: "blocked", pending_deletion: "blocked", deleted: "blocked",
}

// Writes that stay possible in read_only: registering the phone as a device changes no business data.
const READ_ONLY_WRITE_EXEMPT: ReadonlySet<string> = new Set(["POST /v1/sync/register-device"])

export const SUSPENDED_MESSAGE =
  "আপনার অ্যাকাউন্ট সাময়িকভাবে বন্ধ আছে। আপনার ফোনের ডেটা সুরক্ষিত আছে। সাহায্যের জন্য আমাদের সাথে যোগাযোগ করুন।"
export const READ_ONLY_MESSAGE =
  "আপনার অ্যাকাউন্ট এখন শুধু দেখার মোডে আছে। নতুন বিক্রি বা স্টক এন্ট্রি আপাতত বন্ধ; ফোনে জমা থাকা কাজ নিরাপদে আছে। সাহায্যের জন্য আমাদের সাথে যোগাযোগ করুন।"

/** path = the route path without the /api prefix, e.g. "/v1/sync/push" */
export function tenantBlockFor(status: StoreStatus, method: string, path: string): TenantBlock | null {
  const policy = Object.hasOwn(POLICY, status) ? POLICY[status] : "blocked" // own keys only: "toString" must not read as open
  if (policy === "blocked") return { code: "tenant_suspended", message: SUSPENDED_MESSAGE }
  if (policy === "read_only" && method !== "GET" && !READ_ONLY_WRITE_EXEMPT.has(`${method} ${path}`)) {
    return { code: "tenant_read_only", message: READ_ONLY_MESSAGE }
  }
  return null
}
