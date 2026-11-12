import { describe, expect, it } from "vitest"
import { createApp } from "../../server/app.js"
import { createMemoryRepo } from "../../src/db/memory.js"

const SECRET = "k".repeat(40)

function start() {
  const app = createApp({ repo: createMemoryRepo(), jwtSecret: SECRET, corsOrigins: ["http://app.test"] })
  async function call(
    method: string,
    path: string,
    opts: { body?: unknown; token?: string; headers?: Record<string, string> } = {},
  ) {
    const { body, token, headers } = opts
    const res = await app.fetch(
      new Request(`https://edge.test/api${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      }),
    )
    const text = await res.text()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, headers: res.headers, json: (text ? JSON.parse(text) : null) as any }
  }
  return { call }
}

const owner = {
  storeName: "রহমান ফার্মেসি",
  storeKind: "pharmacy",
  ownerName: "আব্দুর রহমান",
  phone: "০১৭১২৩৪৫৬৭৮",
  password: "password123",
}

describe("API", () => {
  it("health", async () => {
    const { call } = start()
    const r = await call("GET", "/health")
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ status: "ok" })
  })

  it("দোকান খোলা → লগইন → /me", async () => {
    const { call } = start()
    const reg = await call("POST", "/v1/auth/register-store", { body: owner })
    expect(reg.status).toBe(201)
    expect(reg.json.user.role).toBe("owner")
    expect(reg.json.user.phone).toBe("01712345678") // বাংলা অঙ্ক স্বাভাবিক হয়েছে
    expect(reg.json.user.passwordHash).toBeUndefined()

    const login = await call("POST", "/v1/auth/login", { body: { phone: "+8801712345678", password: "password123" } })
    expect(login.status).toBe(200)
    expect(login.json.user.passwordHash).toBeUndefined()

    const me = await call("GET", "/v1/me", { token: login.json.token })
    expect(me.status).toBe(200)
    expect(me.json.store.name).toBe("রহমান ফার্মেসি")
    expect(me.json.user.id).toBe(reg.json.user.id)
  })

  it("একই নম্বরে দ্বিতীয় দোকান নয়; ভুল ইনপুট ৪০০", async () => {
    const { call } = start()
    expect((await call("POST", "/v1/auth/register-store", { body: owner })).status).toBe(201)
    expect((await call("POST", "/v1/auth/register-store", { body: owner })).json.error.code).toBe("phone_taken")
    const bad = await call("POST", "/v1/auth/register-store", { body: { ...owner, phone: "123" } })
    expect(bad.status).toBe(400)
    const weak = await call("POST", "/v1/auth/register-store", { body: { ...owner, phone: "01811111111", password: "short" } })
    expect(weak.json.error.code).toBe("weak_password")
    expect((await call("POST", "/v1/auth/register-store", { body: "{oops" })).json.error.code).toBe("invalid_json")
  })

  it("ভুল পাসওয়ার্ড একই বার্তা; ৫ বারের পর আটকে যায়", async () => {
    const { call } = start()
    await call("POST", "/v1/auth/register-store", { body: owner })
    const wrong = await call("POST", "/v1/auth/login", { body: { phone: owner.phone, password: "nope-nope" } })
    const unknown = await call("POST", "/v1/auth/login", { body: { phone: "01999999999", password: "nope-nope" } })
    expect(wrong.status).toBe(401)
    expect(wrong.json.error.message).toBe(unknown.json.error.message) // নম্বর আছে কিনা বোঝা যায় না
    for (let i = 0; i < 4; i++) await call("POST", "/v1/auth/login", { body: { phone: owner.phone, password: "nope-nope" } })
    const blocked = await call("POST", "/v1/auth/login", { body: { phone: owner.phone, password: "password123" } })
    expect(blocked.status).toBe(429) // সঠিক পাসওয়ার্ড দিলেও এই মুহূর্তে আটকানো
  })

  it("অটেনটিকেশন ছাড়া ৪০১, ভুয়া টোকেনে ৪০১, অজানা পথে ৪০৪", async () => {
    const { call } = start()
    expect((await call("GET", "/v1/me")).status).toBe(401)
    expect((await call("GET", "/v1/me", { token: "a.b.c" })).status).toBe(401)
    expect((await call("GET", "/nope")).status).toBe(404)
    const outside = await createApp({ repo: createMemoryRepo(), jwtSecret: SECRET }).fetch(
      new Request("https://edge.test/health"),
    )
    expect(outside.status).toBe(404) // /api প্রিফিক্স ছাড়া কিছু নয়
  })

  it("স্টাফ: মালিক বানায়, স্টাফ পারে না, বন্ধ করলে টোকেনও অচল, দোকান আলাদা", async () => {
    const { call } = start()
    const o = (await call("POST", "/v1/auth/register-store", { body: owner })).json
    const created = await call("POST", "/v1/staff", {
      token: o.token,
      body: { name: "করিম", phone: "01811111111", password: "staffpass1" },
    })
    expect(created.status).toBe(201)
    expect(created.json.user.role).toBe("staff")

    const s = (await call("POST", "/v1/auth/login", { body: { phone: "01811111111", password: "staffpass1" } })).json
    expect(s.user.storeId).toBe(o.user.storeId)
    expect((await call("GET", "/v1/staff", { token: s.token })).status).toBe(403)
    const staffCreate = await call("POST", "/v1/staff", {
      token: s.token,
      body: { name: "x", phone: "01911111111", password: "staffpass2" },
    })
    expect(staffCreate.status).toBe(403)

    expect((await call("GET", "/v1/staff", { token: o.token })).json.staff).toHaveLength(2)

    // অন্য দোকানের মালিক এই স্টাফকে দেখতে/বন্ধ করতে পারে না
    const other = (
      await call("POST", "/v1/auth/register-store", { body: { ...owner, phone: "01611111111", storeName: "অন্য দোকান" } })
    ).json
    expect((await call("GET", "/v1/staff", { token: other.token })).json.staff).toHaveLength(1)
    const cross = await call("PATCH", `/v1/staff/${created.json.user.id}`, { token: other.token, body: { active: false } })
    expect(cross.status).toBe(404)

    // নিজেকে বন্ধ করা যায় না
    const self = await call("PATCH", `/v1/staff/${o.user.id}`, { token: o.token, body: { active: false } })
    expect(self.status).toBe(400)

    // বন্ধ করলে পুরনো টোকেন ও লগইন দুটোই অচল
    const off = await call("PATCH", `/v1/staff/${created.json.user.id}`, { token: o.token, body: { active: false } })
    expect(off.status).toBe(200)
    expect((await call("GET", "/v1/me", { token: s.token })).status).toBe(401)
    expect((await call("POST", "/v1/auth/login", { body: { phone: "01811111111", password: "staffpass1" } })).status).toBe(401)
  })

  it("CORS: শুধু অনুমোদিত origin", async () => {
    const { call } = start()
    const ok = await call("OPTIONS", "/v1/me", { headers: { origin: "http://app.test" } })
    expect(ok.status).toBe(204)
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://app.test")
    const bad = await call("GET", "/health", { headers: { origin: "http://evil.test" } })
    expect(bad.headers.get("access-control-allow-origin")).toBeNull()
  })

  it("বড় বডি ৪১৩", async () => {
    const { call } = start()
    const big = await call("POST", "/v1/auth/login", { body: { phone: "01712345678", password: "x".repeat(200_000) } })
    expect(big.status).toBe(413)
  })
})
