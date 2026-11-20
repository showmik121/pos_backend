import { describe, expect, it } from "vitest"
import { ClientErrorRowSchema, DashboardSchema, ErrorTriageResultSchema, NegativeStockRowSchema, SyncHealthRowSchema } from "../../src/contract/admin-api.js"
import { adminHarness } from "./admin-harness.js"

const DAY = 86_400_000
const FP1 = "a".repeat(32)
const FP2 = "b".repeat(32)

async function seeded() {
  const h = adminHarness()
  const t0 = h.now()
  const fresh = h.adminRepo.seedTenant({ name: "ফ্রেশ", ownerPhone: "01711000001", status: "active", createdAt: new Date(t0 - 10 * DAY).toISOString(), lastSyncAt: new Date(t0 - 3_600_000).toISOString() })
  const stale = h.adminRepo.seedTenant({ name: "পুরনো সিংক", ownerPhone: "01711000002", status: "active", createdAt: new Date(t0 - 10 * DAY).toISOString(), lastSyncAt: new Date(t0 - 50 * 3_600_000).toISOString() })
  const never = h.adminRepo.seedTenant({ name: "কখনো সিংক নয়", ownerPhone: "01711000003", status: "trial", trialEndsAt: new Date(t0 + 5 * DAY).toISOString(), createdAt: new Date(t0 - 3 * DAY).toISOString(), lastSyncAt: null })
  const gone = h.adminRepo.seedTenant({ name: "মুছে ফেলা", ownerPhone: "01711000004", status: "deleted", createdAt: new Date(t0 - 90 * DAY).toISOString(), lastSyncAt: null })
  h.adminRepo.seedClientError({ fingerprint: FP1, kind: "render", message: "boom", path: "/sell/", appVersion: "abc1234", count: 7, firstAt: new Date(t0 - 2 * DAY).toISOString(), lastAt: new Date(t0 - 3_600_000).toISOString(), storeId: stale })
  h.adminRepo.seedClientError({ fingerprint: FP2, kind: "window", message: "old", path: null, appVersion: null, count: 1, firstAt: new Date(t0 - 9 * DAY).toISOString(), lastAt: new Date(t0 - 8 * DAY).toISOString(), storeId: null })
  h.adminRepo.seedNegativeStock(fresh, { batches: 2, unitsShort: 5 })
  return { h, ids: { fresh, stale, never, gone } }
}

describe("A2 health: sync health", () => {
  it("lists tenants with no sync for stuckHours (never-synced counts from creation); deleted tenants are left out; oldest first", async () => {
    const { h, ids } = await seeded()
    const a = await h.actor("viewer", "v@bipone.test")
    const r = await h.call("GET", "/v1/admin/health/sync", { token: a.token })
    expect(r.status, r.raw).toBe(200)
    expect(r.json.tenants.map((x: { id: string }) => x.id)).toEqual([ids.never, ids.stale])
    expect(r.json.total).toBe(2)
    for (const row of r.json.tenants) SyncHealthRowSchema.parse(row)
    expect(r.json.tenants[1].hoursSinceSync).toBe(50)
  })
  it("a larger window narrows the list; bad input is a 400", async () => {
    const { h, ids } = await seeded()
    const a = await h.actor("viewer", "v@bipone.test")
    const r = await h.call("GET", "/v1/admin/health/sync?stuckHours=60", { token: a.token })
    expect(r.json.tenants.map((x: { id: string }) => x.id)).toEqual([ids.never]) // 3 days since creation > 60 h
    expect((await h.call("GET", "/v1/admin/health/sync?stuckHours=0", { token: a.token })).status).toBe(400)
  })
})

describe("A2 health: client errors and triage", () => {
  it("defaults to open errors, newest first; all roles can read; rows match the contract", async () => {
    const { h } = await seeded()
    const a = await h.actor("viewer", "v@bipone.test")
    const r = await h.call("GET", "/v1/admin/health/errors", { token: a.token })
    expect(r.status, r.raw).toBe(200)
    expect(r.json.errors.map((e: { fingerprint: string }) => e.fingerprint)).toEqual([FP1, FP2])
    for (const e of r.json.errors) ClientErrorRowSchema.parse(e)
    expect(r.json.errors[0]).toMatchObject({ status: "open", count: 7, appVersion: "abc1234", note: null })
  })
  it("support can resolve an error with a note: it leaves the open list, shows under resolved, and one ok audit row is written (no note text)", async () => {
    const { h } = await seeded()
    const s = await h.actor("support", "s@bipone.test")
    const r = await h.call("POST", `/v1/admin/health/errors/${FP1}/triage`, { token: s.token, body: { status: "resolved", note: "fixed in next build" } })
    expect(r.status, r.raw).toBe(200)
    ErrorTriageResultSchema.parse(r.json)
    const open = await h.call("GET", "/v1/admin/health/errors", { token: s.token })
    expect(open.json.errors.map((e: { fingerprint: string }) => e.fingerprint)).toEqual([FP2])
    const done = await h.call("GET", "/v1/admin/health/errors?status=resolved", { token: s.token })
    expect(done.json.errors[0]).toMatchObject({ fingerprint: FP1, status: "resolved", note: "fixed in next build" })
    const all = await h.call("GET", "/v1/admin/health/errors?status=all", { token: s.token })
    expect(all.json.errors).toHaveLength(2)
    const rows = h.adminRepo.auditRows().filter((x) => x.action === "admin.health.error_triage")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ outcome: "ok", adminId: s.id, targetType: "client_error", targetId: FP1 })
    expect(JSON.stringify(rows[0])).not.toContain("fixed in next build")
  })
  it("can be reopened", async () => {
    const { h } = await seeded()
    const s = await h.actor("super", "r@bipone.test")
    await h.call("POST", `/v1/admin/health/errors/${FP1}/triage`, { token: s.token, body: { status: "ignored" } })
    await h.call("POST", `/v1/admin/health/errors/${FP1}/triage`, { token: s.token, body: { status: "open" } })
    const open = await h.call("GET", "/v1/admin/health/errors", { token: s.token })
    expect(open.json.errors.map((e: { fingerprint: string }) => e.fingerprint)).toContain(FP1)
  })
  it.each(["viewer", "finance"] as const)("%s cannot triage: 403 and a denied audit row", async (role) => {
    const { h } = await seeded()
    const a = await h.actor(role, `${role}@bipone.test`)
    const r = await h.call("POST", `/v1/admin/health/errors/${FP1}/triage`, { token: a.token, body: { status: "resolved" } })
    expect(r.status).toBe(403)
    const rows = h.adminRepo.auditRows().filter((x) => x.action === "admin.health.error_triage")
    expect(rows.map((x) => x.outcome)).toEqual(["denied"])
    expect(rows[0]).toMatchObject({ targetType: "client_error", targetId: FP1, adminId: a.id }) // a denied attempt still names the error it aimed at
    const open = await h.call("GET", "/v1/admin/health/errors", { token: a.token })
    expect(open.json.errors).toHaveLength(2)
  })
  it("an unknown fingerprint is 404 (audited with its target); a malformed one is no route; a bad status is 400", async () => {
    const { h } = await seeded()
    const s = await h.actor("support", "s@bipone.test")
    const unknown = "c".repeat(32)
    expect((await h.call("POST", `/v1/admin/health/errors/${unknown}/triage`, { token: s.token, body: { status: "resolved" } })).status).toBe(404)
    expect(h.adminRepo.auditRows().find((x) => x.action === "admin.health.error_triage")).toMatchObject({ outcome: "error", targetType: "client_error", targetId: unknown })
    expect((await h.call("POST", "/v1/admin/health/errors/nope/triage", { token: s.token, body: { status: "resolved" } })).status).toBe(404)
    expect((await h.call("POST", `/v1/admin/health/errors/${FP1}/triage`, { token: s.token, body: { status: "bogus" } })).status).toBe(400)
  })
  it("a resolved error that happens again is open again; an ignored one stays ignored", async () => {
    const { h } = await seeded()
    const s = await h.actor("support", "s@bipone.test")
    await h.call("POST", `/v1/admin/health/errors/${FP1}/triage`, { token: s.token, body: { status: "resolved" } })
    await h.call("POST", `/v1/admin/health/errors/${FP2}/triage`, { token: s.token, body: { status: "ignored" } })
    h.tick(60)
    const again = new Date(h.now()).toISOString()
    for (const fp of [FP1, FP2]) h.adminRepo.seedClientError({ fingerprint: fp, kind: "render", message: "boom", path: null, appVersion: null, count: 9, firstAt: again, lastAt: again, storeId: null })
    const open = await h.call("GET", "/v1/admin/health/errors", { token: s.token })
    expect(open.json.errors.map((e: { fingerprint: string }) => e.fingerprint)).toEqual([FP1])
    expect((await h.call("GET", "/v1/admin/dashboard", { token: s.token })).json.newErrors).toBe(1)
  })
  it("omitting the note on a later decision clears the earlier note", async () => {
    const { h } = await seeded()
    const s = await h.actor("support", "s@bipone.test")
    await h.call("POST", `/v1/admin/health/errors/${FP1}/triage`, { token: s.token, body: { status: "ignored", note: "noise" } })
    await h.call("POST", `/v1/admin/health/errors/${FP1}/triage`, { token: s.token, body: { status: "resolved" } })
    const r = await h.call("GET", "/v1/admin/health/errors?status=resolved", { token: s.token })
    expect(r.json.errors[0].note).toBeNull()
  })
  it("crash text from an unauthenticated endpoint is scrubbed on the way out: long numbers masked, bad version dropped", async () => {
    const { h } = await seeded()
    h.adminRepo.seedClientError({ fingerprint: "e".repeat(32), kind: "window", message: "fail for 01711000030 <script>", path: "/x/০১৭১১০০০০৩০", appVersion: "<img src=x onerror=1>", count: 1, firstAt: new Date(h.now()).toISOString(), lastAt: new Date(h.now() + 1).toISOString(), storeId: null })
    const a = await h.actor("viewer", "v@bipone.test")
    const e = (await h.call("GET", "/v1/admin/health/errors", { token: a.token })).json.errors[0]
    expect(e.message).toBe("fail for # <script>") // markup stays text: the UI renders it escaped
    expect(e.path).toBe("/x/#")
    expect(e.appVersion).toBeNull()
  })
  it("validates the query: bad status or limit is 400, and limit truncates while the sync total stays whole", async () => {
    const { h } = await seeded()
    const a = await h.actor("viewer", "v@bipone.test")
    expect((await h.call("GET", "/v1/admin/health/errors?status=bogus", { token: a.token })).status).toBe(400)
    expect((await h.call("GET", "/v1/admin/health/errors?limit=0", { token: a.token })).status).toBe(400)
    const one = await h.call("GET", "/v1/admin/health/sync?limit=1", { token: a.token })
    expect(one.json.tenants).toHaveLength(1)
    expect(one.json.total).toBe(2)
  })
})

describe("A2 health: negative stock and dashboard", () => {
  it("negative stock lists counts only (no product names, prices)", async () => {
    const { h, ids } = await seeded()
    const a = await h.actor("viewer", "v@bipone.test")
    const r = await h.call("GET", "/v1/admin/health/negative-stock", { token: a.token })
    expect(r.status, r.raw).toBe(200)
    expect(r.json.tenants).toHaveLength(1)
    expect(r.json.tenants[0]).toMatchObject({ id: ids.fresh, batches: 2, unitsShort: 5 })
    NegativeStockRowSchema.parse(r.json.tenants[0])
    expect(Object.keys(r.json.tenants[0]).sort()).toEqual(["batches", "id", "name", "status", "unitsShort"])
  })
  it("dashboard tiles: status counts, stuck sync, new open errors in 24 h, negative stock tenants, signups today (Asia/Dhaka)", async () => {
    const { h } = await seeded()
    // The harness clock is 2026-11-20T06:00Z = 12:00 on the 20th in Dhaka, so Dhaka's day began at 2026-11-19T18:00Z.
    // Exactly at the boundary counts as today; one millisecond earlier is yesterday (a UTC-day count would get both wrong).
    const dhakaMidnight = Date.parse("2026-11-19T18:00:00.000Z")
    h.adminRepo.seedTenant({ name: "ঢাকার আজ", ownerPhone: "01711000009", status: "trial", trialEndsAt: new Date(h.now() + DAY).toISOString(), createdAt: new Date(dhakaMidnight).toISOString(), lastSyncAt: new Date(h.now()).toISOString() })
    h.adminRepo.seedTenant({ name: "ঢাকার গতকাল", ownerPhone: "01711000010", status: "trial", trialEndsAt: new Date(h.now() + DAY).toISOString(), createdAt: new Date(dhakaMidnight - 1).toISOString(), lastSyncAt: new Date(h.now()).toISOString() })
    const a = await h.actor("viewer", "v@bipone.test")
    const r = await h.call("GET", "/v1/admin/dashboard", { token: a.token })
    expect(r.status, r.raw).toBe(200)
    DashboardSchema.parse(r.json)
    expect(r.json).toMatchObject({ stuckSync: 2, newErrors: 1, negativeStockTenants: 1, signupsToday: 1, stuckHours: 24 })
    expect(r.json.tenantsByStatus).toMatchObject({ active: 2, trial: 3, deleted: 1 })
  })
  it("a resolved error stops counting as new", async () => {
    const { h } = await seeded()
    const s = await h.actor("support", "s@bipone.test")
    await h.call("POST", `/v1/admin/health/errors/${FP1}/triage`, { token: s.token, body: { status: "resolved" } })
    expect((await h.call("GET", "/v1/admin/dashboard", { token: s.token })).json.newErrors).toBe(0)
  })
})
