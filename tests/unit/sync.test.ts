import { describe, expect, it } from "vitest"
import { createApp } from "../../server/app.js"
import { createMemoryRepo } from "../../src/db/memory.js"

const SECRET = "k".repeat(40)
const PASS = "Sobuj#Ghar2026"
const DEV_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const DEV_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

function start() {
  const app = createApp({ repo: createMemoryRepo(), jwtSecret: SECRET })
  async function call(method: string, path: string, opts: { body?: unknown; token?: string } = {}) {
    const res = await app.fetch(
      new Request(`https://edge.test/api${path}`, {
        method,
        headers: { "content-type": "application/json", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      }),
    )
    const text = await res.text()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, json: (text ? JSON.parse(text) : null) as any }
  }
  async function shop(phone: string) {
    const r = await call("POST", "/v1/auth/register-store", { body: { storeName: "দোকান", ownerName: "মালিক", phone, password: PASS } })
    const staff = await call("POST", "/v1/staff", { token: r.json.token, body: { name: "রুবেল", phone: `0181${phone.slice(4)}`, password: "staffpass1" } })
    const login = await call("POST", "/v1/auth/login", { body: { phone: staff.json.user.phone, password: "staffpass1" } })
    return { owner: r.json.token as string, staff: login.json.token as string }
  }
  return { call, shop }
}

let n = 0
const ev = (kind: string, payload: Record<string, unknown> = { x: 1 }, id = `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`) => ({
  id,
  kind,
  at: "2026-11-18T10:00:00.000Z",
  payload,
})

describe("সিংক: ডিভাইস নিবন্ধন", () => {
  it("প্রতি দোকানে ডিভাইস A, B… ক্রমে কোড পায়; একই ডিভাইস আবার চাইলে একই কোড", async () => {
    const { call, shop } = start()
    const { owner } = await shop("01711111111")
    const a = await call("POST", "/v1/sync/register-device", { token: owner, body: { deviceId: DEV_A } })
    const b = await call("POST", "/v1/sync/register-device", { token: owner, body: { deviceId: DEV_B } })
    const a2 = await call("POST", "/v1/sync/register-device", { token: owner, body: { deviceId: DEV_A } })
    expect(a.json.code).toBe("A")
    expect(b.json.code).toBe("B")
    expect(a2.json.code).toBe("A")
  })
  it("টোকেন ছাড়া ও ভুল deviceId আটকায়; অন্য দোকান আলাদা A পায়", async () => {
    const { call, shop } = start()
    const s1 = await shop("01711111111")
    const s2 = await shop("01722222222")
    expect((await call("POST", "/v1/sync/register-device", { body: { deviceId: DEV_A } })).status).toBe(401)
    expect((await call("POST", "/v1/sync/register-device", { token: s1.owner, body: { deviceId: "x" } })).status).toBe(400)
    await call("POST", "/v1/sync/register-device", { token: s1.owner, body: { deviceId: DEV_A } })
    expect((await call("POST", "/v1/sync/register-device", { token: s2.owner, body: { deviceId: DEV_A } })).json.code).toBe("A")
  })
})

describe("সিংক: push / pull", () => {
  async function ready() {
    const t = start()
    const s = await t.shop("01711111111")
    await t.call("POST", "/v1/sync/register-device", { token: s.owner, body: { deviceId: DEV_A } })
    await t.call("POST", "/v1/sync/register-device", { token: s.owner, body: { deviceId: DEV_B } })
    return { ...t, ...s }
  }

  it("push করা ইভেন্ট pull-এ ক্রমে আসে, ডিভাইস-কোডসহ", async () => {
    const { call, owner } = await ready()
    const e1 = ev("product_upserted")
    const e2 = ev("sale_created", { no: "A-1001" })
    const push = await call("POST", "/v1/sync/push", { token: owner, body: { deviceId: DEV_A, events: [e1, e2] } })
    expect(push.status).toBe(200)
    expect(push.json.accepted).toEqual([e1.id, e2.id])
    const pull = await call("GET", "/v1/sync/pull?after=0", { token: owner })
    expect(pull.json.events.map((e: { id: string }) => e.id)).toEqual([e1.id, e2.id])
    expect(pull.json.events[0].deviceCode).toBe("A")
    expect(pull.json.events[1].payload).toEqual({ no: "A-1001" })
    expect(pull.json.hasMore).toBe(false)
    expect(pull.json.lastSeq).toBeGreaterThan(0)
  })
  it("একই ইভেন্ট দুবার push করলে একবারই থাকে (ইডেমপোটেন্ট)", async () => {
    const { call, owner } = await ready()
    const e = ev("sale_created")
    await call("POST", "/v1/sync/push", { token: owner, body: { deviceId: DEV_A, events: [e] } })
    const again = await call("POST", "/v1/sync/push", { token: owner, body: { deviceId: DEV_A, events: [e] } })
    expect(again.json.accepted).toEqual([e.id])
    const pull = await call("GET", "/v1/sync/pull?after=0", { token: owner })
    expect(pull.json.events).toHaveLength(1)
  })
  it("after কার্সর দিয়ে শুধু নতুনগুলো আসে; limit মানলে hasMore true", async () => {
    const { call, owner } = await ready()
    const list = [ev("a_one"), ev("a_two"), ev("a_three")]
    await call("POST", "/v1/sync/push", { token: owner, body: { deviceId: DEV_A, events: list } })
    const first = await call("GET", "/v1/sync/pull?after=0&limit=2", { token: owner })
    expect(first.json.events).toHaveLength(2)
    expect(first.json.hasMore).toBe(true)
    const rest = await call("GET", `/v1/sync/pull?after=${first.json.lastSeq}&limit=2`, { token: owner })
    expect(rest.json.events.map((e: { id: string }) => e.id)).toEqual([list[2]!.id])
    expect(rest.json.hasMore).toBe(false)
  })
  it("দুই ডিভাইসের ইভেন্ট একই লগে মিশে যায়", async () => {
    const { call, owner, staff } = await ready()
    await call("POST", "/v1/sync/push", { token: owner, body: { deviceId: DEV_A, events: [ev("sale_created", { n: 1 })] } })
    await call("POST", "/v1/sync/push", { token: staff, body: { deviceId: DEV_B, events: [ev("sale_completed", { n: 2 })] } })
    const pull = await call("GET", "/v1/sync/pull?after=0", { token: owner })
    expect(pull.json.events.map((e: { deviceCode: string }) => e.deviceCode)).toEqual(["A", "B"])
  })
  it("এক দোকান অন্য দোকানের ইভেন্ট দেখে না", async () => {
    const t = start()
    const s1 = await t.shop("01711111111")
    const s2 = await t.shop("01722222222")
    for (const s of [s1, s2]) await t.call("POST", "/v1/sync/register-device", { token: s.owner, body: { deviceId: DEV_A } })
    await t.call("POST", "/v1/sync/push", { token: s1.owner, body: { deviceId: DEV_A, events: [ev("sale_created")] } })
    const pull = await t.call("GET", "/v1/sync/pull?after=0", { token: s2.owner })
    expect(pull.json.events).toHaveLength(0)
  })
  it("অনিবন্ধিত ডিভাইস, অচেনা ধরন, ভুল id/at/payload আটকায় এবং কিছুই সেভ হয় না", async () => {
    const { call, owner } = await ready()
    const good = ev("sale_created")
    const bad = (e: unknown) => call("POST", "/v1/sync/push", { token: owner, body: { deviceId: DEV_A, events: [good, e] } })
    expect((await call("POST", "/v1/sync/push", { token: owner, body: { deviceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", events: [good] } })).status).toBe(400)
    expect((await bad({ ...ev("DROP TABLE"), kind: "Bad Kind!" })).status).toBe(400)
    expect((await bad({ ...ev("x_y"), id: "nope" })).status).toBe(400)
    expect((await bad({ ...ev("x_y"), at: "yesterday" })).status).toBe(400)
    expect((await bad({ ...ev("x_y"), payload: [1] })).status).toBe(400)
    expect((await call("POST", "/v1/sync/push", { token: owner, body: { deviceId: DEV_A, events: [] } })).status).toBe(400)
    const pull = await call("GET", "/v1/sync/pull?after=0", { token: owner })
    expect(pull.json.events).toHaveLength(0)
  })
  it("বড় ব্যাচ (১০০-র বেশি) ও বড় payload আটকায়", async () => {
    const { call, owner } = await ready()
    const many = Array.from({ length: 101 }, () => ev("x_y"))
    expect((await call("POST", "/v1/sync/push", { token: owner, body: { deviceId: DEV_A, events: many } })).status).toBe(400)
    const huge = ev("x_y", { blob: "z".repeat(40_000) })
    expect((await call("POST", "/v1/sync/push", { token: owner, body: { deviceId: DEV_A, events: [huge] } })).status).toBe(400)
  })
  it("কর্মচারী বিল বাতিল (sale_voided) ইভেন্ট পাঠাতে পারে না; মালিক পারে", async () => {
    const { call, owner, staff } = await ready()
    const v = ev("sale_voided", { saleId: "s" })
    const denied = await call("POST", "/v1/sync/push", { token: staff, body: { deviceId: DEV_B, events: [v] } })
    expect(denied.status).toBe(403)
    expect((await call("POST", "/v1/sync/push", { token: owner, body: { deviceId: DEV_A, events: [v] } })).status).toBe(200)
  })
  it("কর্মচারী মালিক-মাত্র ধরন পাঠাতে পারে না: ব্যাচ সরানো, সেটিংস, বাতিল (REST-এর নিয়মের সাথে মিল)", async () => {
    const { call, owner, staff } = await ready()
    for (const kind of ["batch_removed", "settings_updated", "sale_voided"]) {
      const e = ev(kind, { x: 1 })
      expect((await call("POST", "/v1/sync/push", { token: staff, body: { deviceId: DEV_B, events: [e] } })).status).toBe(403)
      expect((await call("POST", "/v1/sync/push", { token: owner, body: { deviceId: DEV_A, events: [e] } })).status).toBe(200)
    }
  })
  it("কর্মচারী অচেনা ধরনের ইভেন্ট পাঠাতে পারে না (ডিফল্ট-নিষেধ); মালিক পারে (ভবিষ্যৎ সামঞ্জস্য)", async () => {
    const { call, owner, staff } = await ready()
    const e = ev("brand_new_kind", { x: 1 })
    expect((await call("POST", "/v1/sync/push", { token: staff, body: { deviceId: DEV_B, events: [e] } })).status).toBe(403)
    expect((await call("POST", "/v1/sync/push", { token: owner, body: { deviceId: DEV_A, events: [e] } })).status).toBe(200)
  })
  it("কর্মচারী দৈনন্দিন ধরনগুলো পাঠাতে পারে: পণ্য, স্টক-জমা, কাস্টমার, বিক্রি, বাকি আদায়", async () => {
    const { call, staff } = await ready()
    const kinds = ["product_upserted", "stock_in", "customer_upserted", "sale_completed", "due_received"]
    const res = await call("POST", "/v1/sync/push", { token: staff, body: { deviceId: DEV_B, events: kinds.map((k) => ev(k, { x: 1 })) } })
    expect(res.status).toBe(200)
    expect(res.json.accepted).toHaveLength(kinds.length)
  })
  it("টোকেন ছাড়া push/pull আটকায়; ভুল after বাতিল", async () => {
    const { call, owner } = await ready()
    expect((await call("GET", "/v1/sync/pull?after=0")).status).toBe(401)
    expect((await call("POST", "/v1/sync/push", { body: { deviceId: DEV_A, events: [ev("x_y")] } })).status).toBe(401)
    expect((await call("GET", "/v1/sync/pull?after=abc", { token: owner })).status).toBe(400)
  })
})
