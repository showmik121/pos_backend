import { describe, expect, it } from "vitest"
import { createApp } from "../../server/app.js"
import { createMemoryRepo } from "../../src/db/memory.js"

const SECRET = "k".repeat(40)
const PASS = "Sobuj#Ghar2026"

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
const uid = () => `10000000-0000-4000-8000-${String(++n).padStart(12, "0")}`
const prod = (over: Record<string, unknown> = {}) => ({
  id: uid(),
  name: "প্যারাসিটামল ৫০০",
  unit: "strip",
  cartonSize: 10,
  costPoisha: 300,
  pricePoisha: 500,
  minStock: 5,
  category: "ওষুধ",
  open: false,
  barcodes: [{ code: "8901234567890", packSize: 1 }],
  ...over,
})

describe("পণ্য: তৈরি ও পড়া", () => {
  it("টোকেন ছাড়া ৪০১", async () => {
    const { call } = start()
    expect((await call("POST", "/v1/products", { body: prod() })).status).toBe(401)
    expect((await call("GET", "/v1/products")).status).toBe(401)
  })

  it("তৈরি → ২০১; GET দিয়ে একই পণ্য, বারকোডসহ, স্টক ০", async () => {
    const { call, shop } = start()
    const { owner } = await shop("01711111111")
    const p = prod()
    const r = await call("POST", "/v1/products", { token: owner, body: p })
    expect(r.status).toBe(201)
    expect(r.json.product).toMatchObject({ id: p.id, name: p.name, unit: "strip", cartonSize: 10, costPoisha: 300, pricePoisha: 500, minStock: 5, category: "ওষুধ", open: false, stockQty: 0 })
    expect(r.json.product.barcodes).toEqual([{ code: "8901234567890", packSize: 1 }])
    const g = await call("GET", `/v1/products/${p.id}`, { token: owner })
    expect(g.status).toBe(200)
    expect(g.json.product.id).toBe(p.id)
  })

  it("একই id একই বডি আবার = ২০০ (ইডেমপোটেন্ট); ভিন্ন বডি = ৪০৯ id_conflict", async () => {
    const { call, shop } = start()
    const { owner } = await shop("01711111111")
    const p = prod()
    expect((await call("POST", "/v1/products", { token: owner, body: p })).status).toBe(201)
    const again = await call("POST", "/v1/products", { token: owner, body: p })
    expect(again.status).toBe(200)
    expect(again.json.product.id).toBe(p.id)
    const diff = await call("POST", "/v1/products", { token: owner, body: { ...p, pricePoisha: 999 } })
    expect(diff.status).toBe(409)
    expect(diff.json.error.code).toBe("id_conflict")
  })

  it("ভুল ইনপুট ৪০০: নাম নেই, ঋণাত্মক/দশমিক দাম, অচেনা ইউনিট, কার্টন সাইজ ০, বারকোড packSize ০, id UUID নয়", async () => {
    const { call, shop } = start()
    const { owner } = await shop("01711111111")
    const bad = [
      { name: "  " },
      { pricePoisha: -1 },
      { pricePoisha: 10.5 },
      { costPoisha: "৩০০" },
      { unit: "kg" },
      { cartonSize: 0 },
      { minStock: -1 },
      { barcodes: [{ code: "123", packSize: 0 }] },
      { barcodes: [{ code: "123", packSize: 1 }, { code: "123", packSize: 10 }] },
      { id: "not-a-uuid" },
    ]
    for (const over of bad) {
      const r = await call("POST", "/v1/products", { token: owner, body: prod(over) })
      expect(r.status, JSON.stringify(over)).toBe(400)
      expect(r.json.error.code).toBe("invalid_input")
    }
  })

  it("একই দোকানে একই বারকোড অন্য পণ্যে ৪০৯ duplicate_barcode; অন্য দোকানে চলে", async () => {
    const { call, shop } = start()
    const a = await shop("01711111111")
    const b = await shop("01722222222")
    expect((await call("POST", "/v1/products", { token: a.owner, body: prod() })).status).toBe(201)
    const dup = await call("POST", "/v1/products", { token: a.owner, body: prod({ name: "আরেক" }) })
    expect(dup.status).toBe(409)
    expect(dup.json.error.code).toBe("duplicate_barcode")
    expect((await call("POST", "/v1/products", { token: b.owner, body: prod({ name: "আরেক" }) })).status).toBe(201)
  })

  it("প্রতি দোকানের ডেটা আলাদা: একই id দুই দোকানে স্বাধীন, অন্য দোকানের পণ্য ৪০৪ ও তালিকায় নেই", async () => {
    const { call, shop } = start()
    const a = await shop("01711111111")
    const b = await shop("01722222222")
    const id = uid()
    expect((await call("POST", "/v1/products", { token: a.owner, body: prod({ id, name: "এ-পণ্য", barcodes: [] }) })).status).toBe(201)
    expect((await call("GET", `/v1/products/${id}`, { token: b.owner })).status).toBe(404)
    expect((await call("PATCH", `/v1/products/${id}`, { token: b.owner, body: { name: "হাইজ্যাক" } })).status).toBe(404)
    expect((await call("GET", "/v1/products", { token: b.owner })).json.items).toHaveLength(0)
    expect((await call("POST", "/v1/products", { token: b.owner, body: prod({ id, name: "বি-পণ্য", barcodes: [] }) })).status).toBe(201)
    expect((await call("GET", `/v1/products/${id}`, { token: a.owner })).json.product.name).toBe("এ-পণ্য")
    expect((await call("GET", `/v1/products/${id}`, { token: b.owner })).json.product.name).toBe("বি-পণ্য")
  })

  it("কর্মচারী ক্রয়মূল্য দেখে না (null), মালিক দেখে; কর্মচারী পণ্য তৈরি করতে পারে", async () => {
    const { call, shop } = start()
    const { owner, staff } = await shop("01711111111")
    const p = prod()
    const made = await call("POST", "/v1/products", { token: staff, body: p })
    expect(made.status).toBe(201)
    expect(made.json.product.costPoisha).toBeNull()
    expect((await call("GET", `/v1/products/${p.id}`, { token: staff })).json.product.costPoisha).toBeNull()
    expect((await call("GET", `/v1/products/${p.id}`, { token: owner })).json.product.costPoisha).toBe(300)
    expect((await call("GET", "/v1/products", { token: staff })).json.items[0].costPoisha).toBeNull()
  })

  it("অবৈধ পথ-id ৪০৪", async () => {
    const { call, shop } = start()
    const { owner } = await shop("01711111111")
    expect((await call("GET", "/v1/products/xyz", { token: owner })).status).toBe(404)
  })
})

describe("পণ্য: তালিকা", () => {
  async function seeded() {
    const t = start()
    const { owner } = await t.shop("01711111111")
    const names = ["আলফা ক্রিম", "বিটা সিরাপ", "গামা ক্রিম", "ডেল্টা ট্যাবলেট", "ইপসিলন সিরাপ"]
    for (const [i, name] of names.entries()) {
      await t.call("POST", "/v1/products", {
        token: owner,
        body: prod({ name, category: name.includes("ক্রিম") ? "কসমেটিক্স" : "ওষুধ", barcodes: [{ code: `BC${i}`, packSize: 1 }] }),
      })
    }
    return { ...t, owner }
  }

  it("নাম অনুযায়ী সাজানো; q দিয়ে নামের অংশ খোঁজা; category ও barcode ফিল্টার", async () => {
    const { call, owner } = await seeded()
    const all = await call("GET", "/v1/products", { token: owner })
    expect(all.json.items.map((p: { name: string }) => p.name)).toEqual([...all.json.items.map((p: { name: string }) => p.name)].sort())
    expect(all.json.items).toHaveLength(5)
    expect(all.json.nextCursor).toBeNull()
    const q = await call("GET", `/v1/products?q=${encodeURIComponent("ক্রিম")}`, { token: owner })
    expect(q.json.items).toHaveLength(2)
    const cat = await call("GET", `/v1/products?category=${encodeURIComponent("ওষুধ")}`, { token: owner })
    expect(cat.json.items).toHaveLength(3)
    const bc = await call("GET", "/v1/products?barcode=BC3", { token: owner })
    expect(bc.json.items).toHaveLength(1)
    expect(bc.json.items[0].name).toBe("ডেল্টা ট্যাবলেট")
  })

  it("keyset পেজিনেশন: limit=2 → তিন পাতায় সব পণ্য একবারই; ভুল cursor ৪০০; limit সীমা", async () => {
    const { call, owner } = await seeded()
    const seen: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 5; page++) {
      const r = await call("GET", `/v1/products?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { token: owner })
      expect(r.status).toBe(200)
      seen.push(...r.json.items.map((p: { id: string }) => p.id))
      cursor = r.json.nextCursor
      if (!cursor) break
    }
    expect(seen).toHaveLength(5)
    expect(new Set(seen).size).toBe(5)
    expect((await call("GET", "/v1/products?cursor=%%%", { token: owner })).status).toBe(400)
    expect((await call("GET", "/v1/products?limit=0", { token: owner })).status).toBe(400)
    expect((await call("GET", "/v1/products?limit=201", { token: owner })).status).toBe(400)
  })
})

describe("পণ্য: বদল ও বারকোড", () => {
  it("PATCH আংশিক বদল; বারকোড তালিকা বদলে যায়; অন্য ক্ষেত্র অপরিবর্তিত; updatedAt এগোয়", async () => {
    const { call, shop } = start()
    const { owner } = await shop("01711111111")
    const p = prod()
    const made = await call("POST", "/v1/products", { token: owner, body: p })
    const r = await call("PATCH", `/v1/products/${p.id}`, {
      token: owner,
      body: { pricePoisha: 650, barcodes: [{ code: "NEW1", packSize: 1 }, { code: "CARTON1", packSize: 10 }] },
    })
    expect(r.status).toBe(200)
    expect(r.json.product).toMatchObject({ pricePoisha: 650, name: p.name, costPoisha: 300 })
    expect(r.json.product.barcodes).toEqual(expect.arrayContaining([{ code: "NEW1", packSize: 1 }, { code: "CARTON1", packSize: 10 }]))
    expect(r.json.product.barcodes).toHaveLength(2)
    expect(Date.parse(r.json.product.updatedAt)).toBeGreaterThanOrEqual(Date.parse(made.json.product.updatedAt))
  })

  it("expectedUpdatedAt না মিললে ৪০৯ stale; মিললে চলে", async () => {
    const { call, shop } = start()
    const { owner } = await shop("01711111111")
    const p = prod()
    const made = await call("POST", "/v1/products", { token: owner, body: p })
    const stale = await call("PATCH", `/v1/products/${p.id}`, { token: owner, body: { name: "নতুন", expectedUpdatedAt: "2000-01-01T00:00:00.000Z" } })
    expect(stale.status).toBe(409)
    expect(stale.json.error.code).toBe("stale")
    const ok = await call("PATCH", `/v1/products/${p.id}`, { token: owner, body: { name: "নতুন", expectedUpdatedAt: made.json.product.updatedAt } })
    expect(ok.status).toBe(200)
    expect(ok.json.product.name).toBe("নতুন")
  })

  it("PATCH-এ ভুল মান ৪০০, খালি বডি ৪০০, অন্য পণ্যের বারকোড ৪০৯", async () => {
    const { call, shop } = start()
    const { owner } = await shop("01711111111")
    const p1 = prod()
    const p2 = prod({ name: "দ্বিতীয়", barcodes: [{ code: "OTHER", packSize: 1 }] })
    await call("POST", "/v1/products", { token: owner, body: p1 })
    await call("POST", "/v1/products", { token: owner, body: p2 })
    expect((await call("PATCH", `/v1/products/${p1.id}`, { token: owner, body: { pricePoisha: -5 } })).status).toBe(400)
    expect((await call("PATCH", `/v1/products/${p1.id}`, { token: owner, body: {} })).status).toBe(400)
    const dup = await call("PATCH", `/v1/products/${p1.id}`, { token: owner, body: { barcodes: [{ code: "OTHER", packSize: 1 }] } })
    expect(dup.status).toBe(409)
    expect(dup.json.error.code).toBe("duplicate_barcode")
    expect((await call("GET", `/v1/products/${p1.id}`, { token: owner })).json.product.barcodes).toEqual([{ code: "8901234567890", packSize: 1 }])
  })

  it("POST /barcodes: নতুন ২০১; একই কোড একই পণ্যে একই packSize ২০০; অন্য পণ্যে ৪০৯; পণ্য নেই ৪০৪", async () => {
    const { call, shop } = start()
    const { owner } = await shop("01711111111")
    const p1 = prod()
    const p2 = prod({ name: "দ্বিতীয়", barcodes: [] })
    await call("POST", "/v1/products", { token: owner, body: p1 })
    await call("POST", "/v1/products", { token: owner, body: p2 })
    expect((await call("POST", `/v1/products/${p2.id}/barcodes`, { token: owner, body: { code: "X1", packSize: 10 } })).status).toBe(201)
    expect((await call("POST", `/v1/products/${p2.id}/barcodes`, { token: owner, body: { code: "X1", packSize: 10 } })).status).toBe(200)
    expect((await call("POST", `/v1/products/${p2.id}/barcodes`, { token: owner, body: { code: "X1", packSize: 5 } })).status).toBe(409)
    expect((await call("POST", `/v1/products/${p1.id}/barcodes`, { token: owner, body: { code: "X1", packSize: 10 } })).status).toBe(409)
    expect((await call("POST", `/v1/products/${uid()}/barcodes`, { token: owner, body: { code: "Y", packSize: 1 } })).status).toBe(404)
  })
})
