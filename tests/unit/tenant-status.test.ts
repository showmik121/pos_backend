import { describe, expect, it } from "vitest"
import { start, NOW, uid } from "./helpers.js"

// Enforcement of stores.status in the SHOP API (PRD §8.1, §17.3, §17.4).
// suspended / pending_deletion / deleted -> 403 tenant_suspended on everything except login and GET /v1/me
// read_only                              -> 403 tenant_read_only on every non-GET (reads and pull stay open)
// Both are 403 (NOT 400/413) so the shop sync engine keeps its queue instead of dropping events (§17.4).
const DEV = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const event = () => ({ id: uid(), kind: "product_upserted", at: new Date(NOW).toISOString(), payload: { id: uid(), name: "x" } })

async function shopWithStatus() {
  const h = start()
  const phone = "01711000001"
  const s = await h.shop(phone)
  const me = await h.call("GET", "/v1/me", { token: s.owner })
  const storeId = me.json.store.id as string
  return { ...h, ...s, storeId, phone }
}

describe("a new store starts a 14-day trial; existing behaviour is unchanged while trial/active/grace", () => {
  it("signup -> trial with trialEndsAt = now + 14 days, visible in /v1/me", async () => {
    const t = await shopWithStatus()
    const me = await t.call("GET", "/v1/me", { token: t.owner })
    expect(me.json.store.status).toBe("trial")
    expect(me.json.store.trialEndsAt).toBe(new Date(NOW + 14 * 86_400_000).toISOString())
  })

  it.each(["trial", "active", "grace", "cancelled"] as const)("%s: sync and REST work as before", async (status) => {
    const t = await shopWithStatus()
    t.repo.setStoreStatus(t.storeId, status)
    expect((await t.call("POST", "/v1/sync/register-device", { token: t.owner, body: { deviceId: DEV } })).status).toBe(200)
    expect((await t.call("POST", "/v1/sync/push", { token: t.owner, body: { deviceId: DEV, events: [event()] } })).status).toBe(200)
    expect((await t.call("GET", "/v1/sync/pull?after=0", { token: t.owner })).status).toBe(200)
    expect((await t.call("GET", "/v1/products", { token: t.owner })).status).toBe(200)
  })
})

describe("suspended (and pending_deletion / deleted)", () => {
  it.each(["suspended", "pending_deletion", "deleted"] as const)("%s: data routes return 403 tenant_suspended, for owner and staff", async (status) => {
    const t = await shopWithStatus()
    t.repo.setStoreStatus(t.storeId, status, "বকেয়া")
    for (const token of [t.owner, t.staff]) {
      for (const [m, p, body] of [
        ["POST", "/v1/sync/register-device", { deviceId: DEV }],
        ["POST", "/v1/sync/push", { deviceId: DEV, events: [event()] }],
        ["GET", "/v1/sync/pull?after=0", undefined],
        ["GET", "/v1/products", undefined],
        ["GET", "/v1/staff", undefined],
      ] as const) {
        const r = await t.call(m, p, { token, body })
        expect(r.status, `${m} ${p}`).toBe(403)
        expect(r.json.error.code, `${m} ${p}`).toBe("tenant_suspended")
        expect(r.json.error.details).toMatchObject({ status, message: "বকেয়া" })
        expect(r.json.error.message).toMatch(/[ঀ-৿]/) // Bangla
      }
    }
  })

  it("login still succeeds and reports tenantStatus (Q10), and /v1/me still works so the app can show the notice", async () => {
    const t = await shopWithStatus()
    t.repo.setStoreStatus(t.storeId, "suspended", "বকেয়া")
    const login = await t.call("POST", "/v1/auth/login", { body: { phone: t.phone, password: "Sobuj#Ghar2026" } })
    expect(login.status).toBe(200)
    expect(login.json).toMatchObject({ tenantStatus: "suspended", statusMessage: "বকেয়া" })
    expect(login.json.token).toBeTruthy()
    const me = await t.call("GET", "/v1/me", { token: login.json.token })
    expect(me.status).toBe(200)
    expect(me.json.store).toMatchObject({ status: "suspended", statusMessage: "বকেয়া" })
  })

  it("takes effect immediately for a token issued BEFORE the suspension, and reactivation restores access", async () => {
    const t = await shopWithStatus()
    expect((await t.call("GET", "/v1/products", { token: t.owner })).status).toBe(200)
    t.repo.setStoreStatus(t.storeId, "suspended")
    expect((await t.call("GET", "/v1/products", { token: t.owner })).status).toBe(403)
    t.repo.setStoreStatus(t.storeId, "active")
    expect((await t.call("GET", "/v1/products", { token: t.owner })).status).toBe(200)
  })

  it("crash reports from a suspended shop are still accepted", async () => {
    const t = await shopWithStatus()
    t.repo.setStoreStatus(t.storeId, "suspended")
    const r = await t.call("POST", "/v1/client-errors", {
      token: t.owner,
      body: { kind: "window", message: "boom", stack: null, path: "/", appVersion: "x" },
    })
    expect(r.status).toBe(200)
  })

  it("another shop is unaffected", async () => {
    const a = start()
    const s1 = await a.shop("01711000002")
    const s2 = await a.shop("01711000003")
    const me1 = await a.call("GET", "/v1/me", { token: s1.owner })
    a.repo.setStoreStatus(me1.json.store.id, "suspended")
    expect((await a.call("GET", "/v1/products", { token: s1.owner })).status).toBe(403)
    expect((await a.call("GET", "/v1/products", { token: s2.owner })).status).toBe(200)
  })
})

describe("read_only: reads and pull stay open, writes are refused with 403 tenant_read_only", () => {
  it("blocks non-GET data routes but allows GET, pull, device registration and crash reports", async () => {
    const t = await shopWithStatus()
    expect((await t.call("POST", "/v1/sync/register-device", { token: t.owner, body: { deviceId: DEV } })).status).toBe(200)
    t.repo.setStoreStatus(t.storeId, "read_only", "বকেয়া")

    expect((await t.call("GET", "/v1/products", { token: t.owner })).status).toBe(200)
    expect((await t.call("GET", "/v1/sync/pull?after=0", { token: t.owner })).status).toBe(200)
    expect((await t.call("POST", "/v1/sync/register-device", { token: t.owner, body: { deviceId: DEV } })).status).toBe(200)

    for (const [m, p, body] of [
      ["POST", "/v1/sync/push", { deviceId: DEV, events: [event()] }],
      ["POST", "/v1/products", { id: uid(), name: "নতুন", unit: "piece", pricePoisha: 100 }],
      ["POST", "/v1/staff", { name: "আরেকজন", phone: "01911000009", password: "staffpass2" }],
      ["PATCH", "/v1/store", { name: "নতুন নাম" }],
    ] as const) {
      const r = await t.call(m, p, { token: t.owner, body })
      expect(r.status, `${m} ${p}`).toBe(403)
      expect(r.json.error.code, `${m} ${p}`).toBe("tenant_read_only")
      expect(r.json.error.details).toMatchObject({ status: "read_only", message: "বকেয়া" })
    }
  })

  it("the refused push stores nothing (no event reaches the log)", async () => {
    const t = await shopWithStatus()
    await t.call("POST", "/v1/sync/register-device", { token: t.owner, body: { deviceId: DEV } })
    t.repo.setStoreStatus(t.storeId, "read_only")
    await t.call("POST", "/v1/sync/push", { token: t.owner, body: { deviceId: DEV, events: [event()] } })
    t.repo.setStoreStatus(t.storeId, "active")
    const pull = await t.call("GET", "/v1/sync/pull?after=0", { token: t.owner })
    expect(pull.json.events).toHaveLength(0)
  })
})
