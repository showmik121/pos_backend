import { describe, expect, it } from "vitest"
import { normalizeId, toCommand } from "../../src/domain/projection.js"

const U = (n: number) => `70000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const AT = "2026-11-12T06:00:00.000Z"
const ev = (kind: string, payload: Record<string, unknown>, id = U(900), at = AT) => ({ id, kind, at, payload })

const product = (over: Record<string, unknown> = {}) => ({
  id: U(1), name: "প্যারা", barcodes: [{ code: "8941", packSize: 1 }], unit: "strip", cartonSize: 10,
  costPoisha: 300, pricePoisha: 500, minStock: 5, category: "ওষুধ", open: false, createdAt: AT, ...over,
})
const sale = (over: Record<string, unknown> = {}) => ({
  id: U(50), no: 1001, prefix: "A", at: AT, cashier: "রুবেল",
  lines: [{ productId: U(1), name: "প্যারা", qty: 2, unitPrice: 500, discount: 0, allocations: [{ batchId: U(10), batchNo: "B1", qty: 2, costPoisha: 300 }] }],
  subtotal: 1000, lineDiscount: 0, billDiscount: 0, total: 1000, payments: [{ method: "cash", amount: 1000 }], change: 0, due: 0,
  customerId: null, customerName: null, ...over,
})

describe("normalizeId", () => {
  it("UUID থাকলে ছোট হাতের একই UUID", () => {
    expect(normalizeId(U(1).toUpperCase())).toBe(U(1))
  })
  it("UUID নয় এমন id থেকে সবসময় একই UUID, আলাদা লেখা থেকে আলাদা", () => {
    const a = normalizeId("void:abc")
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(normalizeId("void:abc")).toBe(a)
    expect(normalizeId("void:abd")).not.toBe(a)
  })
})

describe("toCommand: ইভেন্ট → সার্ভারের কমান্ড", () => {
  it("পণ্য: ক্ষেত্র যাচাই হয়ে স্ট্যাম্পসহ আসে; ভুল ইউনিট বাদ", () => {
    const c = toCommand(ev("product_upserted", { product: product() }))
    expect(c).toMatchObject({ kind: "product", id: U(1), stamp: `${AT}|${U(900)}`, createdAt: AT })
    expect((c as { fields: { unit: string } }).fields).toMatchObject({ unit: "strip", cartonSize: 10, pricePoisha: 500 })
    expect(toCommand(ev("product_upserted", { product: product({ unit: "kg" }) }))).toEqual({ ignore: expect.any(String) })
  })

  it("অ-UUID পণ্য id স্থির UUID হয়", () => {
    const a = toCommand(ev("product_upserted", { product: product({ id: "k1x-abc" }) })) as { id: string }
    expect(a.id).toBe(normalizeId("k1x-abc"))
  })

  it("স্টক-জমা: ইভেন্ট id রসিদ-আইডি হয়; পরিমাণ ≤ ০ বা ভুল ধরন বাদ", () => {
    const p = { batchId: U(10), productId: U(1), batchNo: "B1", expiryDate: "2027-06-30", qty: 12, costPoisha: 300, receivedAt: AT }
    expect(toCommand(ev("stock_in", p))).toMatchObject({ kind: "stock_in", eventId: U(900), batchId: U(10), productId: U(1), qty: 12, expiryDate: "2027-06-30" })
    expect(toCommand(ev("stock_in", { ...p, qty: 0 }))).toEqual({ ignore: expect.any(String) })
    expect(toCommand(ev("stock_in", { ...p, expiryDate: "bogus" }))).toEqual({ ignore: expect.any(String) })
  })

  it("কাস্টমার: ফোন বাংলা অঙ্কে হলেও স্বাভাবিক; খালি ফোন ঠিক; ভুল ফোন বাদ", () => {
    const base = { id: U(2), name: "করিম", createdAt: AT }
    expect(toCommand(ev("customer_upserted", { customer: { ...base, phone: "০১৭১২৩৪৫৬৭৮" } }))).toMatchObject({ kind: "customer", phone: "01712345678" })
    expect(toCommand(ev("customer_upserted", { customer: { ...base, phone: "" } }))).toMatchObject({ phone: "" })
    expect(toCommand(ev("customer_upserted", { customer: { ...base, phone: "123" } }))).toEqual({ ignore: expect.any(String) })
  })

  it("বিল: বাকির এন্ট্রিতে saleId বসে; ব্যাচ ও কাস্টমার id স্বাভাবিক হয়; বাকি থাকলে কাস্টমার লাগে", () => {
    const withDue = sale({ customerId: "cust-1", customerName: "করিম", total: 1000, due: 400, payments: [{ method: "cash", amount: 600 }] })
    const ledger = { id: "led-1", customerId: "cust-1", at: AT, kind: "sale", amount: 400, saleNo: 1001, salePrefix: "A", by: "রুবেল" }
    const c = toCommand(ev("sale_completed", { sale: withDue, ledger })) as { kind: string; sale: { customerId: string }; ledger: { id: string; saleId: string; amountPoisha: number } }
    expect(c.kind).toBe("sale")
    expect(c.sale.customerId).toBe(normalizeId("cust-1"))
    expect(c.ledger).toMatchObject({ id: normalizeId("led-1"), saleId: U(50), amountPoisha: 400 })
    expect(toCommand(ev("sale_completed", { sale: sale({ due: 400, total: 1000, payments: [{ method: "cash", amount: 600 }] }), ledger: null }))).toEqual({ ignore: expect.any(String) })
  })

  it("বিল: যোগফল না মিললে বা উপসর্গ ভুল হলে বাদ", () => {
    expect(toCommand(ev("sale_completed", { sale: sale({ total: 999 }), ledger: null }))).toEqual({ ignore: expect.any(String) })
    expect(toCommand(ev("sale_completed", { sale: sale({ prefix: "ab" }), ledger: null }))).toEqual({ ignore: expect.any(String) })
  })

  it("বাতিল: ledger-এর id `void:<saleId>` থেকে স্থির UUID; বাকি-ফেরানো এন্ট্রি saleId পায়", () => {
    const voided = { at: AT, by: "মালিক", reason: "ভুল" }
    const ledger = { id: "x", customerId: U(2), at: AT, kind: "void", amount: 400, saleNo: 1001, by: "মালিক" }
    const c = toCommand(ev("sale_voided", { saleId: U(50), voided, ledger: { ...ledger, id: `void:${U(50)}` } })) as { saleId: string; ledger: { id: string; saleId: string } }
    expect(c.saleId).toBe(U(50))
    expect(c.ledger).toMatchObject({ id: normalizeId(`void:${U(50)}`), saleId: U(50) })
    expect(toCommand(ev("sale_voided", { saleId: U(50), voided: { at: AT, by: "মালিক", reason: "  " }, ledger: null }))).toEqual({ ignore: expect.any(String) })
  })

  it("বাকি আদায় ও ব্যাচ-সরানো: ঠিক গঠনে কমান্ড; অচেনা ধরন ও settings বাদ", () => {
    const entry = { id: U(60), customerId: U(2), at: AT, kind: "payment", amount: 300, saleNo: null, by: "মালিক" }
    expect(toCommand(ev("due_received", { entry }))).toMatchObject({ kind: "due", entry: { id: U(60), kind: "payment", amountPoisha: 300, saleId: null } })
    expect(toCommand(ev("due_received", { entry: { ...entry, kind: "sale" } }))).toEqual({ ignore: expect.any(String) })
    const removed = { id: U(70), at: AT, by: "মালিক", batchId: U(10), productId: U(1), productName: "প্যারা", batchNo: "B1", expiryDate: "2026-10-31", qty: 4, costPoisha: 300, reason: "মেয়াদ শেষ" }
    expect(toCommand(ev("batch_removed", { removed }))).toMatchObject({ kind: "batch_removed", removed: { batchId: U(10), qty: 4, reason: "মেয়াদ শেষ" } })
    expect(toCommand(ev("settings_updated", { settings: {} }))).toEqual({ ignore: expect.any(String) })
    expect(toCommand(ev("future_kind", {}))).toEqual({ ignore: expect.any(String) })
  })
})
