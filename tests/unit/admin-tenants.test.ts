import { describe, expect, it } from "vitest"
import { ADMIN_ROUTE_IDS, adminContract, AuditRowSchema, TenantDetailSchema, TenantRowSchema } from "../../src/contract/admin-api.js"
import { adminHandlers } from "../../server/routes/admin-handlers.js"
import { adminHarness } from "./admin-harness.js"

const UUID0 = "00000000-0000-4000-8000-000000000000"
const REASON = "বকেয়া টাকা পরিশোধ হয়নি"

describe("contract registry (A1)", () => {
  it("every tenant/audit route has a handler and a unique audit name; tenant routes name their target", () => {
    expect(Object.keys(adminHandlers).sort()).toEqual([...ADMIN_ROUTE_IDS].sort())
    const names = ADMIN_ROUTE_IDS.filter((id) => id.startsWith("tenants.") || id === "audit.list")
    expect(names.length).toBeGreaterThanOrEqual(9)
    for (const id of names) {
      const c = adminContract[id] as { path: string; target?: string }
      if (c.path.includes(":id")) expect(c.target, id).toBe("tenant")
    }
  })
})

describe("acceptance 1: a Support admin cannot suspend, and the attempt is audited", () => {
  it.each(["support", "finance", "viewer"] as const)("%s POST /tenants/:id/suspend -> 403 + a denied audit row naming the tenant", async (role) => {
    const h = adminHarness()
    const shop = await h.shop()
    const a = await h.actor(role, `${role}@bipone.test`, true)
    const r = await h.call("POST", `/v1/admin/tenants/${shop.storeId}/suspend`, { token: a.token, body: { reason: REASON } })
    expect(r.status, r.raw).toBe(403)
    expect(r.json.error.code).toBe("forbidden")
    const rows = h.auditFor(shop.storeId).filter((x) => x.action === "admin.tenant.suspend")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ outcome: "denied", adminId: a.id, targetType: "tenant", targetId: shop.storeId, storeId: shop.storeId })
    // nothing changed, and the shop still works
    expect((await h.call("GET", "/v1/sync/pull?after=0", { token: shop.ownerToken })).status).toBe(200)
  })
})

describe("acceptance 2: a Super admin with step-up suspends a tenant", () => {
  it("without step-up: 403 step_up_required + denied audit, tenant untouched", async () => {
    const h = adminHarness()
    const shop = await h.shop()
    const a = await h.actor("super", "root@bipone.test", false)
    const r = await h.call("POST", `/v1/admin/tenants/${shop.storeId}/suspend`, { token: a.token, body: { reason: REASON } })
    expect(r.status).toBe(403)
    expect(r.json.error.code).toBe("step_up_required")
    expect(h.auditFor(shop.storeId).map((x) => x.outcome)).toEqual(["denied"])
    expect((await h.call("GET", "/v1/sync/pull?after=0", { token: shop.ownerToken })).status).toBe(200)
  })

  it("with step-up: the shop's next sync and login return tenant_suspended with the owner message; one ok audit row with before/after and the reason", async () => {
    const h = adminHarness()
    const shop = await h.shop()
    const a = await h.actor("super", "root@bipone.test", true)
    const r = await h.call("POST", `/v1/admin/tenants/${shop.storeId}/suspend`, { token: a.token, body: { reason: REASON, message: "আপনার অ্যাকাউন্ট বন্ধ আছে" } })
    expect(r.status, r.raw).toBe(200)
    expect(r.json).toMatchObject({ fromStatus: "trial", toStatus: "suspended" })

    const pull = await h.call("GET", "/v1/sync/pull?after=0", { token: shop.ownerToken })
    expect(pull.status).toBe(403)
    expect(pull.json.error.code).toBe("tenant_suspended")
    expect(pull.json.error.details).toMatchObject({ status: "suspended", message: "আপনার অ্যাকাউন্ট বন্ধ আছে" })
    const login = await h.call("POST", "/v1/auth/login", { body: { phone: shop.phone, password: "Sobuj#Ghar2026" } })
    expect(login.status).toBe(200)
    expect(login.json.tenantStatus).toBe("suspended")

    const rows = h.auditFor(shop.storeId).filter((x) => x.action === "admin.tenant.suspend" && x.outcome === "ok")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ reason: REASON, before: { status: "trial" }, after: { status: "suspended" }, adminId: a.id, storeId: shop.storeId })
  })

  it("requires a real reason (3+ characters) and rejects unknown fields' values", async () => {
    const h = adminHarness()
    const shop = await h.shop()
    const a = await h.actor("super", "root@bipone.test", true)
    for (const body of [{}, { reason: "" }, { reason: "ab" }, { reason: REASON, message: "" }]) {
      const r = await h.call("POST", `/v1/admin/tenants/${shop.storeId}/suspend`, { token: a.token, body })
      expect(r.status, JSON.stringify(body)).toBe(400)
    }
    expect((await h.call("GET", "/v1/sync/pull?after=0", { token: shop.ownerToken })).status).toBe(200)
  })

  it("unknown tenant -> 404; malformed id -> 404; the failed attempt is still audited", async () => {
    const h = adminHarness()
    const a = await h.actor("super", "root@bipone.test", true)
    const r = await h.call("POST", `/v1/admin/tenants/${UUID0}/suspend`, { token: a.token, body: { reason: REASON } })
    expect(r.status).toBe(404)
    expect((await h.call("POST", "/v1/admin/tenants/not-a-uuid/suspend", { token: a.token, body: { reason: REASON } })).status).toBe(404)
    expect(h.adminRepo.auditRows().some((x) => x.action === "admin.tenant.suspend" && x.outcome === "error" && x.storeId === UUID0)).toBe(true)
  })
})

describe("status transitions", () => {
  it("suspend -> reactivate returns to trial while the trial has not ended, and the shop works again", async () => {
    const h = adminHarness()
    const shop = await h.shop()
    const a = await h.actor("super", "root@bipone.test", true)
    await h.call("POST", `/v1/admin/tenants/${shop.storeId}/suspend`, { token: a.token, body: { reason: REASON } })
    const r = await h.call("POST", `/v1/admin/tenants/${shop.storeId}/reactivate`, { token: a.token, body: { reason: "পরিশোধ হয়েছে" } })
    expect(r.status, r.raw).toBe(200)
    expect(r.json).toMatchObject({ fromStatus: "suspended", toStatus: "trial" })
    expect((await h.call("GET", "/v1/sync/pull?after=0", { token: shop.ownerToken })).status).toBe(200)
  })

  it("reactivate after the trial ended returns to active", async () => {
    const h = adminHarness()
    const shop = await h.shop()
    const a = await h.actor("super", "root@bipone.test", true)
    await h.call("POST", `/v1/admin/tenants/${shop.storeId}/suspend`, { token: a.token, body: { reason: REASON } })
    h.tick(15 * 86_400) // the 30-minute idle limit ended the session, so sign in again
    const token = await h.signIn(a)
    await h.stepUp(a, token)
    const r = await h.call("POST", `/v1/admin/tenants/${shop.storeId}/reactivate`, { token, body: { reason: "পরিশোধ হয়েছে" } })
    expect(r.json).toMatchObject({ fromStatus: "suspended", toStatus: "active" })
  })

  it("read-only blocks shop writes (403 tenant_read_only) but not reads", async () => {
    const h = adminHarness()
    const shop = await h.shop()
    const a = await h.actor("super", "root@bipone.test", true)
    const r = await h.call("POST", `/v1/admin/tenants/${shop.storeId}/read-only`, { token: a.token, body: { reason: REASON } })
    expect(r.status, r.raw).toBe(200)
    expect(r.json.toStatus).toBe("read_only")
    expect((await h.call("GET", "/v1/sync/pull?after=0", { token: shop.ownerToken })).status).toBe(200)
    const write = await h.call("POST", "/v1/sync/push", { token: shop.ownerToken, body: { deviceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", events: [] } })
    expect(write.status).toBe(403)
    expect(write.json.error.code).toBe("tenant_read_only")
  })

  it("invalid transitions are 409 and change nothing: suspend twice, reactivate an active shop, read-only a suspended shop", async () => {
    const h = adminHarness()
    const shop = await h.shop()
    const a = await h.actor("super", "root@bipone.test", true)
    const url = (p: string) => `/v1/admin/tenants/${shop.storeId}/${p}`
    expect((await h.call("POST", url("reactivate"), { token: a.token, body: { reason: REASON } })).status).toBe(409) // trial: nothing to undo
    expect((await h.call("POST", url("suspend"), { token: a.token, body: { reason: REASON } })).status).toBe(200)
    const twice = await h.call("POST", url("suspend"), { token: a.token, body: { reason: REASON } })
    expect(twice.status).toBe(409)
    expect(twice.json.error.code).toBe("invalid_transition")
    expect((await h.call("POST", url("read-only"), { token: a.token, body: { reason: REASON } })).status).toBe(409)
  })
})

describe("tenant list and detail (data minimisation)", () => {
  it("any role can list; phones are masked; no secrets or full numbers in the raw response; shape matches the contract", async () => {
    const h = adminHarness()
    const shop = await h.shop()
    const v = await h.actor("viewer", "viewer@bipone.test")
    const r = await h.call("GET", "/v1/admin/tenants", { token: v.token })
    expect(r.status, r.raw).toBe(200)
    expect(r.json.total).toBe(1)
    expect(TenantRowSchema.parse(r.json.tenants[0])).toMatchObject({ id: shop.storeId, ownerPhoneMasked: "017****030", status: "trial" })
    expect(r.raw).not.toContain(OWNER_PHONE_FULL)
    expect(r.raw.toLowerCase()).not.toMatch(/password|hash|payload|cost/)
  })

  it("filters (status, kind, q, noSyncDays) and paginates with a cursor and a correct total", async () => {
    const h = adminHarness()
    const day = 86_400_000
    const base = Date.parse("2026-11-20T06:00:00.000Z")
    for (let i = 0; i < 7; i++) {
      h.adminRepo.seedTenant({
        name: `Shop ${i}`, kind: i % 2 ? "cosmetics" : "pharmacy", ownerName: `Owner ${i}`, ownerPhone: `0171100010${i}`,
        status: i < 3 ? "suspended" : "active", createdAt: new Date(base - i * day).toISOString(),
        lastSyncAt: i < 2 ? new Date(base - 5 * day).toISOString() : i < 5 ? new Date(base - 1 * day).toISOString() : null,
      })
    }
    const v = await h.actor("viewer", "viewer@bipone.test")
    const get = async (qs: string) => (await h.call("GET", `/v1/admin/tenants${qs}`, { token: v.token })).json
    expect((await get("")).total).toBe(7)
    expect((await get("?status=suspended")).total).toBe(3)
    expect((await get("?kind=cosmetics")).total).toBe(3)
    expect((await get("?q=Shop%203")).tenants.map((t: { name: string }) => t.name)).toEqual(["Shop 3"])
    expect((await get("?q=01711000104")).tenants.map((t: { name: string }) => t.name)).toEqual(["Shop 4"])
    // phone search is exact-match only: a partial number must not let an admin recover digits the mask hides
    expect((await get("?q=0171100")).total).toBe(0)
    expect((await get("?q=7110001")).total).toBe(0)
    // "not synced for 3 days": two stale + two that never synced (5, 6) + none of the recent ones
    expect((await get("?noSyncDays=3")).tenants.map((t: { name: string }) => t.name).sort()).toEqual(["Shop 0", "Shop 1", "Shop 5", "Shop 6"])
    const p1 = await get("?limit=3&sort=created&dir=asc")
    expect(p1.tenants).toHaveLength(3)
    expect(p1.total).toBe(7)
    expect(p1.nextCursor).toEqual(expect.any(String))
    const p2 = await get(`?limit=3&sort=created&dir=asc&cursor=${encodeURIComponent(p1.nextCursor)}`)
    const p3 = await get(`?limit=3&sort=created&dir=asc&cursor=${encodeURIComponent(p2.nextCursor)}`)
    const names = [...p1.tenants, ...p2.tenants, ...p3.tenants].map((t: { name: string }) => t.name)
    expect(names).toEqual(["Shop 6", "Shop 5", "Shop 4", "Shop 3", "Shop 2", "Shop 1", "Shop 0"])
    expect(p3.nextCursor).toBeNull()
  })

  it("rejects out-of-range or unknown query values with 400", async () => {
    const h = adminHarness()
    const v = await h.actor("viewer", "viewer@bipone.test")
    for (const qs of ["?limit=0", "?limit=500", "?status=bogus", "?sort=password", "?noSyncDays=0", "?cursor=" + "x".repeat(300)]) {
      expect((await h.call("GET", `/v1/admin/tenants${qs}`, { token: v.token })).status, qs).toBe(400)
    }
  })

  it("detail shows staff with masked phones and never a password hash; 404 for an unknown tenant", async () => {
    const h = adminHarness()
    const shop = await h.shop()
    await h.call("POST", "/v1/staff", { token: shop.ownerToken, body: { name: "রুবেল", phone: "01811000030", password: "staffpass1" } })
    h.adminRepo.seedStaff(shop.storeId, { name: "রুবেল", phone: "01811000030", role: "staff" })
    const v = await h.actor("viewer", "viewer@bipone.test")
    const r = await h.call("GET", `/v1/admin/tenants/${shop.storeId}`, { token: v.token })
    expect(r.status, r.raw).toBe(200)
    const d = TenantDetailSchema.parse(r.json)
    expect(d.tenant.id).toBe(shop.storeId)
    expect(d.staff.some((s) => s.phoneMasked === "018****030")).toBe(true)
    expect(r.raw).not.toContain("01811000030")
    expect(r.raw.toLowerCase()).not.toMatch(/passwordhash|password_hash|scrypt/)
    expect((await h.call("GET", `/v1/admin/tenants/${UUID0}`, { token: v.token })).status).toBe(404)
  })
})

describe("reveal phone is audited and role-limited", () => {
  it("support gets full numbers and exactly one audit row; viewer and finance are denied with a denied row", async () => {
    const h = adminHarness()
    const shop = await h.shop()
    const s = await h.actor("support", "support@bipone.test")
    const ok = await h.call("POST", `/v1/admin/tenants/${shop.storeId}/reveal-phone`, { token: s.token, body: { reason: "গ্রাহক ফোন করেছেন" } })
    expect(ok.status, ok.raw).toBe(200)
    expect(ok.json.phones).toEqual(expect.arrayContaining([expect.objectContaining({ role: "owner", phone: shop.phone })]))
    expect(h.auditFor(shop.storeId).filter((x) => x.action === "admin.tenant.reveal_phone" && x.outcome === "ok")).toHaveLength(1)

    const f = await h.actor("finance", "fin@bipone.test")
    const no = await h.call("POST", `/v1/admin/tenants/${shop.storeId}/reveal-phone`, { token: f.token, body: { reason: "গ্রাহক ফোন করেছেন" } })
    expect(no.status).toBe(403)
    expect(no.raw).not.toContain(shop.phone)
    expect(h.auditFor(shop.storeId).some((x) => x.action === "admin.tenant.reveal_phone" && x.outcome === "denied" && x.adminId === f.id)).toBe(true)
  })
})

describe("notes", () => {
  it("support adds a note (tags normalised), every role reads, viewer cannot write (denied row)", async () => {
    const h = adminHarness()
    const shop = await h.shop()
    const s = await h.actor("support", "support@bipone.test")
    const add = await h.call("POST", `/v1/admin/tenants/${shop.storeId}/notes`, { token: s.token, body: { body: "ফোনে কথা হয়েছে", tags: ["VIP", "billing"] } })
    expect(add.status, add.raw).toBe(201)
    expect(add.json.note).toMatchObject({ body: "ফোনে কথা হয়েছে", tags: ["vip", "billing"], adminName: "Name support" })

    const v = await h.actor("viewer", "viewer@bipone.test")
    const list = await h.call("GET", `/v1/admin/tenants/${shop.storeId}/notes`, { token: v.token })
    expect(list.status).toBe(200)
    expect(list.json.notes).toHaveLength(1)
    const deny = await h.call("POST", `/v1/admin/tenants/${shop.storeId}/notes`, { token: v.token, body: { body: "x" } })
    expect(deny.status).toBe(403)
    expect(h.auditFor(shop.storeId).some((x) => x.action === "admin.tenant.note_add" && x.outcome === "denied" && x.adminId === v.id)).toBe(true)
    expect((await h.call("POST", `/v1/admin/tenants/${shop.storeId}/notes`, { token: s.token, body: { body: "", tags: [] } })).status).toBe(400)
    expect((await h.call("POST", `/v1/admin/tenants/${UUID0}/notes`, { token: s.token, body: { body: "hi" } })).status).toBe(404)
  })
})

describe("audit viewer", () => {
  it("every role can read; filters by tenant/action/outcome; cursor paginates newest first; rows match the contract", async () => {
    const h = adminHarness()
    const shop = await h.shop()
    const a = await h.actor("super", "root@bipone.test", true)
    await h.call("POST", `/v1/admin/tenants/${shop.storeId}/suspend`, { token: a.token, body: { reason: REASON } })
    await h.call("POST", `/v1/admin/tenants/${shop.storeId}/reactivate`, { token: a.token, body: { reason: REASON } })
    const v = await h.actor("viewer", "viewer@bipone.test")
    const get = async (qs: string) => (await h.call("GET", `/v1/admin/audit${qs}`, { token: v.token })).json

    const byStore = await get(`?storeId=${shop.storeId}`)
    expect(byStore.rows.map((r: { action: string }) => r.action)).toEqual(["admin.tenant.reactivate", "admin.tenant.suspend"])
    for (const row of byStore.rows) AuditRowSchema.parse(row)
    expect((await get("?outcome=denied")).rows.every((r: { outcome: string }) => r.outcome === "denied")).toBe(true)
    expect((await get("?action=admin.tenant.suspend")).rows).toHaveLength(1)

    const p1 = await get("?limit=2")
    expect(p1.rows).toHaveLength(2)
    expect(p1.nextCursor).toEqual(expect.any(String))
    const p2 = await get(`?limit=2&cursor=${encodeURIComponent(p1.nextCursor)}`)
    expect(p2.rows[0].id).toBeLessThan(p1.rows[1].id)
    expect((await h.call("GET", "/v1/admin/audit?limit=1000", { token: v.token })).status).toBe(400)
    expect((await h.call("GET", "/v1/admin/audit")).status).toBe(401)
  })

  it("the audit response never carries secrets", async () => {
    const h = adminHarness()
    const a = await h.actor("super", "root@bipone.test")
    const r = await h.call("GET", "/v1/admin/audit?limit=200", { token: a.token })
    expect(r.raw.toLowerCase()).not.toMatch(/passwordhash|totp_secret|recovery_codes/)
  })
})

const OWNER_PHONE_FULL = "01711000030"
