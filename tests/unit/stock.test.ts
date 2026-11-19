import { describe, expect, it } from "vitest"
import { createApp } from "../../server/app.js"
import { createMemoryRepo } from "../../src/db/memory.js"

const SECRET = "k".repeat(40)
const PASS = "Sobuj#Ghar2026"
const NOW = Date.parse("2026-11-12T06:00:00.000Z") // ঢাকায় ২০২৬-১১-১২

function start() {
  const app = createApp({ repo: createMemoryRepo({ now: () => NOW }), jwtSecret: SECRET, now: () => NOW })
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
  async function shop(phone: string, storeKind = "pharmacy") {
    const r = await call("POST", "/v1/auth/register-store", { body: { storeName: "দোকান", ownerName: "মালিক", phone, storeKind, password: PASS } })
    const staff = await call("POST", "/v1/staff", { token: r.json.token, body: { name: "রুবেল", phone: `0181${phone.slice(4)}`, password: "staffpass1" } })
    const login = await call("POST", "/v1/auth/login", { body: { phone: staff.json.user.phone, password: "staffpass1" } })
    return { owner: r.json.token as string, staff: login.json.token as string }
  }
  return { call, shop }
}

let n = 0
const uid = () => `20000000-0000-4000-8000-${String(++n).padStart(12, "0")}`
const prod = (over: Record<string, unknown> = {}) => ({
  id: uid(), name: "প্যারাসিটামল", unit: "strip", cartonSize: 10, costPoisha: 0, pricePoisha: 500, minStock: 5, category: "ওষুধ", open: false, barcodes: [], ...over,
})
const receipt = (over: Record<string, unknown> = {}) => ({
  id: uid(), qty: 10, unit: "piece", batchNo: "B1", expiryDate: "2027-06-30", costPoisha: 300, ...over,
})

async function withProduct(kind = "pharmacy", over: Record<string, unknown> = {}) {
  const t = start()
  const s = await t.shop("01711111111", kind)
  const p = prod(over)
  expect((await t.call("POST", "/v1/products", { token: s.owner, body: p })).status).toBe(201)
  return { ...t, ...s, p }
}

describe("স্টক-জমা", () => {
  it("পিসে জমা: ব্যাচ তৈরি, পণ্যের স্টক ও ক্রয়মূল্য বদলায়, দাম দিলে বিক্রয়মূল্যও", async () => {
    const { call, owner, p } = await withProduct()
    const r = await call("POST", `/v1/products/${p.id}/stock-ins`, { token: owner, body: receipt({ qty: 12, costPoisha: 320, pricePoisha: 550 }) })
    expect(r.status).toBe(201)
    expect(r.json.batch).toMatchObject({ productId: p.id, batchNo: "B1", expiryDate: "2027-06-30", qtyRemaining: 12, costPoisha: 320 })
    const got = (await call("GET", `/v1/products/${p.id}`, { token: owner })).json.product
    expect(got).toMatchObject({ stockQty: 12, costPoisha: 320, pricePoisha: 550 })
  })

  it("দাম না দিলে আগের বিক্রয়মূল্য থাকে", async () => {
    const { call, owner, p } = await withProduct()
    await call("POST", `/v1/products/${p.id}/stock-ins`, { token: owner, body: receipt() })
    expect((await call("GET", `/v1/products/${p.id}`, { token: owner })).json.product.pricePoisha).toBe(500)
  })

  it("কার্টনে জমা: পরিমাণ × কার্টন সাইজ পিস; ক্রয়মূল্য প্রতি কার্টন থেকে প্রতি পিস (গোল হয়)", async () => {
    const { call, owner, p } = await withProduct("pharmacy", { cartonSize: 3 })
    const r = await call("POST", `/v1/products/${p.id}/stock-ins`, { token: owner, body: receipt({ qty: 2, unit: "carton", costPoisha: 1000 }) })
    expect(r.status).toBe(201)
    expect(r.json.batch).toMatchObject({ qtyRemaining: 6, costPoisha: 333 })
  })

  it("কার্টন সাইজ ঠিক না থাকলে কার্টনে জমা ৪২২ no_carton", async () => {
    const { call, owner, p } = await withProduct("pharmacy", { cartonSize: 1 })
    const r = await call("POST", `/v1/products/${p.id}/stock-ins`, { token: owner, body: receipt({ unit: "carton" }) })
    expect(r.status).toBe(422)
    expect(r.json.error.code).toBe("no_carton")
  })

  it("ফার্মেসিতে ব্যাচ ও মেয়াদ বাধ্যতামূলক (৪২২); কসমেটিক্সে নয়", async () => {
    const ph = await withProduct("pharmacy")
    const noBatch = await ph.call("POST", `/v1/products/${ph.p.id}/stock-ins`, { token: ph.owner, body: receipt({ batchNo: "  " }) })
    expect([noBatch.status, noBatch.json.error.code]).toEqual([422, "batch_required"])
    const noExpiry = await ph.call("POST", `/v1/products/${ph.p.id}/stock-ins`, { token: ph.owner, body: receipt({ expiryDate: null }) })
    expect([noExpiry.status, noExpiry.json.error.code]).toEqual([422, "expiry_required"])
    const cos = await withProduct("cosmetics")
    const ok = await cos.call("POST", `/v1/products/${cos.p.id}/stock-ins`, { token: cos.owner, body: receipt({ batchNo: "", expiryDate: null }) })
    expect(ok.status).toBe(201)
    expect(ok.json.batch).toMatchObject({ batchNo: "", expiryDate: null })
  })

  it("একই ব্যাচ নম্বর ও মেয়াদে জমা একই ব্যাচে মেশে; ফাঁকা নম্বর হলে প্রতিবার নতুন ব্যাচ", async () => {
    const { call, owner, p } = await withProduct("cosmetics")
    const a = await call("POST", `/v1/products/${p.id}/stock-ins`, { token: owner, body: receipt({ qty: 5, costPoisha: 300 }) })
    const b = await call("POST", `/v1/products/${p.id}/stock-ins`, { token: owner, body: receipt({ qty: 7, costPoisha: 310 }) })
    expect(b.json.batch.id).toBe(a.json.batch.id)
    expect(b.json.batch).toMatchObject({ qtyRemaining: 12, costPoisha: 310 })
    const x = await call("POST", `/v1/products/${p.id}/stock-ins`, { token: owner, body: receipt({ batchNo: "", expiryDate: null }) })
    const y = await call("POST", `/v1/products/${p.id}/stock-ins`, { token: owner, body: receipt({ batchNo: "", expiryDate: null }) })
    expect(x.json.batch.id).not.toBe(y.json.batch.id)
    expect((await call("GET", `/v1/products/${p.id}`, { token: owner })).json.product.stockQty).toBe(12 + 10 + 10)
  })

  it("একই রসিদ id আবার = ২০০, স্টক দ্বিগুণ হয় না; ভিন্ন বডিতে ৪০৯", async () => {
    const { call, owner, p } = await withProduct()
    const body = receipt({ qty: 8 })
    expect((await call("POST", `/v1/products/${p.id}/stock-ins`, { token: owner, body })).status).toBe(201)
    const again = await call("POST", `/v1/products/${p.id}/stock-ins`, { token: owner, body })
    expect(again.status).toBe(200)
    expect(again.json.batch.qtyRemaining).toBe(8)
    expect((await call("GET", `/v1/products/${p.id}`, { token: owner })).json.product.stockQty).toBe(8)
    const diff = await call("POST", `/v1/products/${p.id}/stock-ins`, { token: owner, body: { ...body, qty: 9 } })
    expect([diff.status, diff.json.error.code]).toEqual([409, "id_conflict"])
  })

  it("ভুল ইনপুট ও অনুপস্থিত পণ্য; অন্য দোকানের পণ্যে জমা ৪০৪", async () => {
    const { call, owner, p, shop } = await withProduct()
    expect((await call("POST", `/v1/products/${p.id}/stock-ins`, { token: owner, body: receipt({ qty: 0 }) })).status).toBe(400)
    expect((await call("POST", `/v1/products/${p.id}/stock-ins`, { token: owner, body: receipt({ qty: 1.5 }) })).status).toBe(400)
    expect((await call("POST", `/v1/products/${p.id}/stock-ins`, { token: owner, body: receipt({ costPoisha: -1 }) })).status).toBe(400)
    expect((await call("POST", `/v1/products/${p.id}/stock-ins`, { token: owner, body: receipt({ expiryDate: "2027-13-45" }) })).status).toBe(400)
    expect((await call("POST", `/v1/products/${p.id}/stock-ins`, { token: owner, body: receipt({ id: "x" }) })).status).toBe(400)
    expect((await call("POST", `/v1/products/${uid()}/stock-ins`, { token: owner, body: receipt() })).status).toBe(404)
    const other = await shop("01722222222")
    expect((await call("POST", `/v1/products/${p.id}/stock-ins`, { token: other.owner, body: receipt() })).status).toBe(404)
  })

  it("কর্মচারী জমা দিতে পারে কিন্তু ব্যাচের ক্রয়মূল্য দেখে না", async () => {
    const { call, owner, staff, p } = await withProduct()
    const r = await call("POST", `/v1/products/${p.id}/stock-ins`, { token: staff, body: receipt() })
    expect(r.status).toBe(201)
    expect(r.json.batch.costPoisha).toBeNull()
    expect((await call("GET", `/v1/batches?productId=${p.id}`, { token: staff })).json.items[0].costPoisha).toBeNull()
    expect((await call("GET", `/v1/batches?productId=${p.id}`, { token: owner })).json.items[0].costPoisha).toBe(300)
  })
})

describe("ব্যাচ তালিকা", () => {
  async function seeded() {
    const t = await withProduct()
    const add = (over: Record<string, unknown>) => t.call("POST", `/v1/products/${t.p.id}/stock-ins`, { token: t.owner, body: receipt(over) })
    await add({ batchNo: "FAR", expiryDate: "2028-01-31", qty: 4 })
    await add({ batchNo: "NEAR", expiryDate: "2027-01-31", qty: 6 }) // ~৮০ দিন
    await add({ batchNo: "OLD", expiryDate: "2026-11-12", qty: 3 }) // আজই শেষ
    return t
  }

  it("মেয়াদের ক্রমে (আগে শেষ হওয়াটা আগে), প্রতিটিতে expiryClass ও daysLeft", async () => {
    const { call, owner, p } = await seeded()
    const r = await call("GET", `/v1/batches?productId=${p.id}`, { token: owner })
    expect(r.status).toBe(200)
    expect(r.json.items.map((b: { batchNo: string }) => b.batchNo)).toEqual(["OLD", "NEAR", "FAR"])
    expect(r.json.items.map((b: { expiryClass: string }) => b.expiryClass)).toEqual(["expired", "soon", "ok"])
    expect(r.json.items[1].daysLeft).toBe(80)
  })

  it("status ফিল্টার: active (বিক্রয়যোগ্য), expired, expiring", async () => {
    const { call, owner, p } = await seeded()
    const names = async (q: string) => (await call("GET", `/v1/batches?productId=${p.id}&${q}`, { token: owner })).json.items.map((b: { batchNo: string }) => b.batchNo)
    expect(await names("status=active")).toEqual(["NEAR", "FAR"])
    expect(await names("status=expired")).toEqual(["OLD"])
    expect(await names("status=expiring&expiringWithinDays=90")).toEqual(["NEAR"])
    expect(await names("status=expiring&expiringWithinDays=30")).toEqual([])
    expect((await call("GET", `/v1/batches?productId=${p.id}&status=bogus`, { token: owner })).status).toBe(400)
  })
})

describe("ব্যাচ সরানো", () => {
  async function withBatch() {
    const t = await withProduct()
    const r = await t.call("POST", `/v1/products/${t.p.id}/stock-ins`, { token: t.owner, body: receipt({ qty: 10, costPoisha: 300 }) })
    return { ...t, batch: r.json.batch as { id: string } }
  }

  it("শুধু মালিক; কারণ বাধ্যতামূলক (৪২২)", async () => {
    const { call, owner, staff, batch } = await withBatch()
    expect((await call("POST", `/v1/batches/${batch.id}/removals`, { token: staff, body: { id: uid(), reason: "মেয়াদ শেষ" } })).status).toBe(403)
    const noReason = await call("POST", `/v1/batches/${batch.id}/removals`, { token: owner, body: { id: uid(), reason: "  " } })
    expect([noReason.status, noReason.json.error.code]).toEqual([422, "reason_required"])
  })

  it("সরালে স্টক শূন্য, ব্যাচ তালিকায় নেই, পণ্যের stockQty কমে; একই id আবার = ২০০; অজানা ব্যাচ ৪০৪", async () => {
    const { call, owner, batch, p } = await withBatch()
    const body = { id: uid(), reason: "মেয়াদ শেষ" }
    const r = await call("POST", `/v1/batches/${batch.id}/removals`, { token: owner, body })
    expect(r.status).toBe(201)
    expect(r.json.removal).toMatchObject({ batchId: batch.id, qty: 10, costPoisha: 300, reason: "মেয়াদ শেষ" })
    expect((await call("GET", `/v1/batches?productId=${p.id}`, { token: owner })).json.items).toHaveLength(0)
    expect((await call("GET", `/v1/products/${p.id}`, { token: owner })).json.product.stockQty).toBe(0)
    expect((await call("POST", `/v1/batches/${batch.id}/removals`, { token: owner, body })).status).toBe(200)
    expect((await call("POST", `/v1/batches/${uid()}/removals`, { token: owner, body: { id: uid(), reason: "x" } })).status).toBe(404)
  })

  it("সরানো ব্যাচ নম্বরে আবার জমা নতুন ব্যাচ বানায়; ক্ষতির খাতা (শুধু মালিক) মোট ক্ষতি দেখায়", async () => {
    const { call, owner, staff, batch, p } = await withBatch()
    await call("POST", `/v1/batches/${batch.id}/removals`, { token: owner, body: { id: uid(), reason: "নষ্ট" } })
    const again = await call("POST", `/v1/products/${p.id}/stock-ins`, { token: owner, body: receipt({ qty: 4 }) })
    expect(again.json.batch.id).not.toBe(batch.id)
    expect(again.json.batch.qtyRemaining).toBe(4)
    expect((await call("GET", "/v1/batch-removals", { token: staff })).status).toBe(403)
    const log = await call("GET", "/v1/batch-removals", { token: owner })
    expect(log.status).toBe(200)
    expect(log.json.items).toHaveLength(1)
    expect(log.json.items[0]).toMatchObject({ productName: p.name, batchNo: "B1", qty: 10, reason: "নষ্ট" })
    expect(log.json.totalLossPoisha).toBe(3000)
  })
})
