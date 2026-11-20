import { describe, expect, it } from "vitest"
import { start, uid } from "./helpers.js"

// আজ = ২০২৬-১১-১২ (ঢাকা)। মেয়াদ ২০২৬-১১-১২ বা আগের হলে expired।
async function setup(kind = "pharmacy") {
  const t = start()
  const s = await t.shop("01711111111", kind)
  async function product(over: Record<string, unknown> = {}) {
    const p = { id: uid(), name: "প্যারাসিটামল", unit: "strip", cartonSize: 10, costPoisha: 0, pricePoisha: 500, minStock: 5, category: "ওষুধ", open: false, barcodes: [], ...over }
    expect((await t.call("POST", "/v1/products", { token: s.owner, body: p })).status).toBe(201)
    return p
  }
  async function stock(productId: string, over: Record<string, unknown> = {}) {
    const r = await t.call("POST", `/v1/products/${productId}/stock-ins`, {
      token: s.owner,
      body: { id: uid(), qty: 10, unit: "piece", batchNo: "B1", expiryDate: "2027-06-30", costPoisha: 300, ...over },
    })
    expect(r.status).toBe(201)
    return r.json.batch as { id: string }
  }
  async function customer(phone = "01712345678") {
    const c = { id: uid(), name: "করিম", phone }
    expect((await t.call("POST", "/v1/customers", { token: s.owner, body: c })).status).toBe(201)
    return c
  }
  let bill = 1000
  const sale = (over: Record<string, unknown> = {}) => ({
    id: uid(), no: ++bill, prefix: "A", lines: [], payments: [], ...over,
  })
  const line = (productId: string, qty: number, over: Record<string, unknown> = {}) => ({ productId, qty, discount: 0, ...over })
  const post = (token: string, body: unknown) => t.call("POST", "/v1/sales", { token, body })
  const qty = async (pid: string) => (await t.call("GET", `/v1/products/${pid}`, { token: s.owner })).json.product.stockQty as number
  return { ...t, ...s, product, stock, customer, sale, line, post, qty }
}

describe("অনলাইন বিক্রি", () => {
  it("নগদে বিক্রি: মোট, স্টক কমে, ফেরত, বিল নম্বর; সব FE-র হিসাবে", async () => {
    const { owner, product, stock, sale, line, post, qty, call } = await setup()
    const p = await product()
    const b = await stock(p.id)
    const r = await post(owner, sale({ lines: [line(p.id, 3)], payments: [{ method: "cash", amount: 2000 }] }))
    expect(r.status).toBe(201)
    expect(r.json.sale).toMatchObject({ no: 1001, prefix: "A", subtotal: 1500, lineDiscount: 0, billDiscount: 0, total: 1500, change: 500, due: 0, customerId: null, oversold: false, cashier: "মালিক" })
    expect(r.json.sale.payments).toEqual([{ method: "cash", amount: 2000 }])
    expect(r.json.sale.lines[0]).toMatchObject({ productId: p.id, name: p.name, qty: 3, unitPrice: 500, discount: 0 })
    expect(r.json.sale.lines[0].allocations).toEqual([{ batchId: b.id, batchNo: "B1", qty: 3, costPoisha: 300 }])
    expect(await qty(p.id)).toBe(7)
    expect((await call("GET", `/v1/sales/${r.json.sale.id}`, { token: owner })).json.sale.total).toBe(1500)
  })

  it("FIFO: আগে মেয়াদ-শেষ-হওয়া ব্যাচ; মেয়াদোত্তীর্ণ বাদ; মেয়াদহীন শেষে", async () => {
    const { owner, product, stock, sale, line, post } = await setup()
    const p = await product()
    const late = await stock(p.id, { batchNo: "LATE", expiryDate: "2027-12-31", qty: 10 })
    const early = await stock(p.id, { batchNo: "EARLY", expiryDate: "2027-01-31", qty: 4 })
    await stock(p.id, { batchNo: "OLD", expiryDate: "2026-11-12", qty: 100 })
    const r = await post(owner, sale({ lines: [line(p.id, 6)], payments: [{ method: "cash", amount: 3000 }] }))
    expect(r.status).toBe(201)
    expect(r.json.sale.lines[0].allocations.map((a: { batchId: string; qty: number }) => [a.batchId, a.qty])).toEqual([[early.id, 4], [late.id, 2]])
  })

  it("স্টক কম হলে ৪০৯ insufficient_stock, কিছুই বদলায় না (বহু-লাইনে আগের লাইনও নয়)", async () => {
    const { owner, product, stock, sale, line, post, qty, call } = await setup()
    const a = await product({ name: "ক" })
    const b = await product({ name: "খ" })
    await stock(a.id, { qty: 10 })
    await stock(b.id, { qty: 2 })
    const r = await post(owner, sale({ lines: [line(a.id, 5), line(b.id, 3)], payments: [{ method: "cash", amount: 99999 }] }))
    expect([r.status, r.json.error.code]).toEqual([409, "insufficient_stock"])
    expect(await qty(a.id)).toBe(10)
    expect(await qty(b.id)).toBe(2)
    expect((await call("GET", "/v1/sales", { token: owner })).json.items).toEqual([])
  })

  it("ছাড়: লাইন-ছাড় ও বিল-শতাংশ (৭.৫% = ৭৫০, গোল হয়); ছাড় বেশি হলে ৪০০", async () => {
    const { owner, product, stock, sale, line, post } = await setup()
    const p = await product({ pricePoisha: 1000 })
    await stock(p.id, { qty: 50 })
    const r = await post(owner, sale({ lines: [line(p.id, 3, { discount: 100 })], billDiscount: { type: "percent", value: 750 }, payments: [{ method: "cash", amount: 5000 }] }))
    // ৩০০০ − ১০০ = ২৯০০; ৭.৫% = ২১৭.৫ → ২১৮; মোট ২৬৮২
    expect(r.json.sale).toMatchObject({ subtotal: 3000, lineDiscount: 100, billDiscount: 218, total: 2682, change: 2318 })
    const big = await post(owner, sale({ lines: [line(p.id, 1, { discount: 1001 })], payments: [{ method: "cash", amount: 5000 }] }))
    expect([big.status, big.json.error.code]).toEqual([400, "discount_too_large"])
  })

  it("বাকি: কাস্টমার ছাড়া ৪০০ customer_required; কাস্টমারসহ আংশিক শোধে বাকি খাতায় ওঠে; মোবাইল পেমেন্ট আলাদা", async () => {
    const { owner, product, stock, sale, line, post, customer, call } = await setup()
    const p = await product({ pricePoisha: 1000 })
    await stock(p.id, { qty: 50 })
    const noCust = await post(owner, sale({ lines: [line(p.id, 2)], payments: [{ method: "cash", amount: 500 }] }))
    expect([noCust.status, noCust.json.error.code]).toEqual([400, "customer_required"])
    const c = await customer()
    const r = await post(owner, sale({ customerId: c.id, lines: [line(p.id, 2)], payments: [{ method: "cash", amount: 500 }, { method: "nagad", amount: 700 }] }))
    expect(r.status).toBe(201)
    expect(r.json.sale).toMatchObject({ total: 2000, due: 800, change: 0, customerId: c.id, customerName: "করিম" })
    expect(r.json.sale.payments).toEqual([{ method: "cash", amount: 500 }, { method: "nagad", amount: 700 }])
    expect((await call("GET", `/v1/customers/${c.id}`, { token: owner })).json.customer.balancePoisha).toBe(800)
    const ledger = (await call("GET", `/v1/customers/${c.id}/ledger`, { token: owner })).json.items
    expect(ledger[0]).toMatchObject({ kind: "sale", amountPoisha: 800, saleId: r.json.sale.id })
    expect((await post(owner, sale({ customerId: uid(), lines: [line(p.id, 1)], payments: [{ method: "cash", amount: 1000 }] }))).status).toBe(404)
  })

  it("ইডেমপোটেন্সি: একই বডি আবার ২০০ (স্টক একবারই কমে); ভিন্ন বডিতে ৪০৯ id_conflict; একই বিল নম্বরে অন্য বিল ৪০৯", async () => {
    const { owner, product, stock, sale, line, post, qty } = await setup()
    const p = await product()
    await stock(p.id)
    const body = sale({ lines: [line(p.id, 2)], payments: [{ method: "cash", amount: 1000 }] })
    expect((await post(owner, body)).status).toBe(201)
    const again = await post(owner, body)
    expect([again.status, again.json.sale.id]).toEqual([200, body.id])
    expect(await qty(p.id)).toBe(8)
    const diff = await post(owner, { ...body, lines: [line(p.id, 3)] })
    expect([diff.status, diff.json.error.code]).toEqual([409, "id_conflict"])
    const dup = await post(owner, sale({ no: body.no, lines: [line(p.id, 1)], payments: [{ method: "cash", amount: 500 }] }))
    expect([dup.status, dup.json.error.code]).toEqual([409, "duplicate_bill_no"])
    const otherPrefix = await post(owner, sale({ no: body.no, prefix: "B", lines: [line(p.id, 1)], payments: [{ method: "cash", amount: 500 }] }))
    expect(otherPrefix.status).toBe(201)
  })

  it("ভুল ইনপুট: খালি/ডুপ্লিকেট লাইন, qty ০, ভুল prefix, অজানা পণ্য (৪০৪), অনলাইনে unitPrice", async () => {
    const { owner, product, stock, sale, line, post } = await setup()
    const p = await product()
    await stock(p.id)
    const pay = [{ method: "cash", amount: 9999 }]
    expect((await post(owner, sale({ lines: [], payments: pay }))).status).toBe(400)
    expect((await post(owner, sale({ lines: [line(p.id, 1), line(p.id, 1)], payments: pay }))).status).toBe(400)
    expect((await post(owner, sale({ lines: [line(p.id, 0)], payments: pay }))).status).toBe(400)
    expect((await post(owner, sale({ prefix: "a1", lines: [line(p.id, 1)], payments: pay }))).status).toBe(400)
    expect((await post(owner, sale({ lines: [line(uid(), 1)], payments: pay }))).status).toBe(404)
    expect((await post(owner, sale({ lines: [line(p.id, 1, { unitPrice: 1 })], payments: pay }))).status).toBe(400)
    expect((await post(owner, sale({ lines: [line(p.id, 1)], payments: [{ method: "card", amount: 500 }] }))).status).toBe(400)
  })

  it("কর্মচারী বিক্রি করতে পারে কিন্তু ক্রয়মূল্য দেখে না; অন্য দোকানে ৪০৪", async () => {
    const { owner, staff, product, stock, sale, line, post, call } = await setup()
    const p = await product()
    await stock(p.id)
    const r = await post(staff, sale({ lines: [line(p.id, 1)], payments: [{ method: "cash", amount: 500 }] }))
    expect(r.status).toBe(201)
    expect(r.json.sale.cashier).toBe("রুবেল")
    expect(r.json.sale.lines[0].allocations[0].costPoisha).toBeNull()
    const got = await call("GET", `/v1/sales/${r.json.sale.id}`, { token: owner })
    expect(got.json.sale.lines[0].allocations[0].costPoisha).toBe(300)
    const other = (await call("POST", "/v1/auth/register-store", { body: { storeName: "অন্য", ownerName: "অন্য", phone: "01744444444", storeKind: "pharmacy", password: "Sobuj#Ghar2026" } })).json.token
    expect((await call("GET", `/v1/sales/${r.json.sale.id}`, { token: other })).status).toBe(404)
  })
})

describe("অফলাইন বিল সার্ভারে আসা", () => {
  it("স্টকের বেশি বিক্রি চলে: oversold চিহ্ন, ব্যাচ ঋণাত্মক; ক্লায়েন্টের দাম ও সময় থাকে", async () => {
    const { owner, product, stock, sale, line, post, qty, call } = await setup()
    const p = await product({ pricePoisha: 500 })
    await stock(p.id, { qty: 2 })
    const r = await post(owner, sale({ offline: true, at: "2026-11-11T10:00:00.000Z", lines: [line(p.id, 5, { unitPrice: 450 })], payments: [{ method: "cash", amount: 2250 }] }))
    expect(r.status).toBe(201)
    expect(r.json.sale).toMatchObject({ oversold: true, total: 2250, at: "2026-11-11T10:00:00.000Z" })
    expect(r.json.sale.lines[0]).toMatchObject({ unitPrice: 450, qty: 5 })
    expect(await qty(p.id)).toBe(-3)
    const batches = (await call("GET", `/v1/batches?productId=${p.id}`, { token: owner })).json.items
    expect(batches.map((b: { qtyRemaining: number }) => b.qtyRemaining)).toEqual([-3])
  })

  it("কখনো স্টক না-থাকা পণ্যেও আসে (নতুন ব্যাচে ঋণাত্মক); ভবিষ্যতের সময় ৪০০", async () => {
    const { owner, product, sale, line, post, qty } = await setup()
    const p = await product()
    const r = await post(owner, sale({ offline: true, lines: [line(p.id, 2)], payments: [{ method: "cash", amount: 1000 }] }))
    expect(r.status).toBe(201)
    expect(r.json.sale.oversold).toBe(true)
    expect(await qty(p.id)).toBe(-2)
    const future = await post(owner, sale({ offline: true, at: "2027-01-01T00:00:00.000Z", lines: [line(p.id, 1)], payments: [{ method: "cash", amount: 500 }] }))
    expect(future.status).toBe(400)
  })
})

describe("বিল বাতিল", () => {
  async function withDueSale() {
    const ctx = await setup()
    const p = await ctx.product({ pricePoisha: 1000 })
    const batch = await ctx.stock(p.id, { qty: 20 })
    const c = await ctx.customer()
    const r = await ctx.post(ctx.owner, ctx.sale({ customerId: c.id, lines: [ctx.line(p.id, 4)], payments: [{ method: "cash", amount: 1000 }] }))
    expect(r.json.sale).toMatchObject({ total: 4000, due: 3000 })
    return { ...ctx, p, c, batch, saleId: r.json.sale.id as string }
  }
  const voidIt = (call: ReturnType<typeof start>["call"], token: string, id: string, reason = "ভুল বিল") => call("POST", `/v1/sales/${id}/void`, { token, body: { reason } })

  it("শুধু মালিক; কারণ বাধ্যতামূলক; স্টক ফেরে; বাকি ফেরে; ফেরতযোগ্য টাকা হিসাব; দ্বিতীয়বার ৪০৯", async () => {
    const { call, owner, staff, saleId, p, c, qty } = await withDueSale()
    expect(await qty(p.id)).toBe(16)
    expect((await voidIt(call, staff, saleId)).status).toBe(403)
    const noReason = await voidIt(call, owner, saleId, "  ")
    expect([noReason.status, noReason.json.error.code]).toEqual([422, "reason_required"])
    const r = await voidIt(call, owner, saleId)
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ restoredQty: 4, lostQty: 0, refundPoisha: 1000 })
    expect(r.json.sale.voided).toMatchObject({ by: "মালিক", reason: "ভুল বিল" })
    expect(await qty(p.id)).toBe(20)
    expect((await call("GET", `/v1/customers/${c.id}`, { token: owner })).json.customer.balancePoisha).toBe(0)
    const again = await voidIt(call, owner, saleId)
    expect([again.status, again.json.error.code]).toEqual([409, "already_voided"])
    expect((await voidIt(call, owner, uid())).status).toBe(404)
  })

  it("কাস্টমার আংশিক শোধ করে থাকলে শুধু বাকি-থাকা অংশ ফেরে, বাকিটা ফেরতের হিসাবে", async () => {
    const { call, owner, saleId, c } = await withDueSale()
    await call("POST", `/v1/customers/${c.id}/payments`, { token: owner, body: { id: uid(), amount: 2000 } })
    const r = await voidIt(call, owner, saleId)
    // বাকি ছিল ৩০০০, শোধ ২০০০ → ব্যালান্স ১০০০; ফেরে ১০০০; ফেরত = (৪০০০−৩০০০) + (৩০০০−১০০০) = ৩০০০
    expect(r.json.refundPoisha).toBe(3000)
    expect((await call("GET", `/v1/customers/${c.id}`, { token: owner })).json.customer.balancePoisha).toBe(0)
  })

  it("সরানো ব্যাচের অংশ ফেরে না (lostQty); বাকি ব্যাচ ঠিক ফেরে", async () => {
    const { call, owner, saleId, batch, p, qty } = await withDueSale()
    await call("POST", `/v1/batches/${batch.id}/removals`, { token: owner, body: { id: uid(), reason: "নষ্ট" } })
    const r = await voidIt(call, owner, saleId)
    expect(r.json).toMatchObject({ restoredQty: 0, lostQty: 4 })
    expect(await qty(p.id)).toBe(0)
  })

  it("বাতিল বিলও তালিকায় voided চিহ্নসহ থাকে; তালিকা নতুন আগে, কাস্টমার-ফিল্টার ও কার্সর", async () => {
    const { call, owner, product, stock, sale, line, post, c, saleId } = await withDueSale()
    await voidIt(call, owner, saleId)
    const q = await product({ name: "অন্য" })
    await stock(q.id)
    for (let i = 0; i < 2; i++) await post(owner, sale({ lines: [line(q.id, 1)], payments: [{ method: "cash", amount: 500 }] }))
    const all = await call("GET", "/v1/sales", { token: owner })
    expect(all.json.items).toHaveLength(3)
    expect(all.json.items.find((s: { id: string }) => s.id === saleId).voided).toBeTruthy()
    const mine = await call("GET", `/v1/sales?customerId=${c.id}`, { token: owner })
    expect(mine.json.items.map((s: { id: string }) => s.id)).toEqual([saleId])
    const seen: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 4; page++) {
      const r = await call("GET", `/v1/sales?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { token: owner })
      seen.push(...r.json.items.map((s: { id: string }) => s.id))
      cursor = r.json.nextCursor
      if (!cursor) break
    }
    expect(new Set(seen).size).toBe(3)
    expect((await call("GET", "/v1/sales?from=bogus", { token: owner })).status).toBe(400)
  })
})
