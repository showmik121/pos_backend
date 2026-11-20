import { describe, expect, it } from "vitest"
import { adminHarness } from "./admin-harness.js"

// D3: the owner can see what an operator did to the account, in the app (Bangla message), without the internal reason.
const REASON = "internal: owner is abusive on the phone"
const OWNER_MESSAGE = "আপনার অ্যাকাউন্ট সাময়িক বন্ধ আছে"

describe("GET /v1/account-activity", () => {
  it("lists the owner-visible message, newest first, never the internal reason, and still works while suspended", async () => {
    const h = adminHarness()
    const shop = await h.shop()
    const a = await h.actor("super", "root@bipone.test", true)
    expect((await h.call("GET", "/v1/account-activity", { token: shop.ownerToken })).json.activity).toEqual([])

    await h.call("POST", `/v1/admin/tenants/${shop.storeId}/suspend`, { token: a.token, body: { reason: REASON, message: OWNER_MESSAGE } })
    // the data routes are blocked, but the owner must still be able to read WHY
    expect((await h.call("GET", "/v1/products", { token: shop.ownerToken })).status).toBe(403)
    const r = await h.call("GET", "/v1/account-activity", { token: shop.ownerToken })
    expect(r.status, r.raw).toBe(200)
    expect(r.json.activity).toEqual([{ at: expect.any(String), status: "suspended", message: OWNER_MESSAGE }])
    expect(r.raw).not.toContain("abusive")

    h.tick(60)
    await h.call("POST", `/v1/admin/tenants/${shop.storeId}/reactivate`, { token: a.token, body: { reason: "paid" } })
    const after = await h.call("GET", "/v1/account-activity", { token: shop.ownerToken })
    expect(after.json.activity.map((e: { status: string }) => e.status)).toEqual(["trial", "suspended"]) // newest first
  })

  it("needs a shop login: no token or an admin token is 401", async () => {
    const h = adminHarness()
    const a = await h.actor("super", "root@bipone.test")
    expect((await h.call("GET", "/v1/account-activity")).status).toBe(401)
    expect((await h.call("GET", "/v1/account-activity", { token: a.token })).status).toBe(401)
  })

  it("staff of the store can read it too (the banner is for everyone using the app)", async () => {
    const h = adminHarness()
    const shop = await h.shop()
    await h.call("POST", "/v1/staff", { token: shop.ownerToken, body: { name: "রুবেল", phone: "01811000031", password: "staffpass1" } })
    const login = await h.call("POST", "/v1/auth/login", { body: { phone: "01811000031", password: "staffpass1" } })
    expect((await h.call("GET", "/v1/account-activity", { token: login.json.token })).status).toBe(200)
  })
})
