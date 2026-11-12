import { describe, expect, it } from "vitest"
import { takaToPoisha, poishaToTaka, percentToBp } from "../../src/domain/money.js"
import { toBaseUnits, splitCartons } from "../../src/domain/units.js"
import { classifyExpiry, daysUntil } from "../../src/domain/expiry.js"
import { allocateFifo } from "../../src/domain/fifo.js"
import { computeSale, settlePayments } from "../../src/domain/sale.js"
import { normalizePhone } from "../../src/domain/phone.js"
import { DomainError } from "../../src/domain/errors.js"

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (e) {
    if (e instanceof DomainError) return e.code
    throw e
  }
  return undefined
}

describe("টাকা ও ইউনিট", () => {
  it("টাকা ↔ পয়সা, বাংলা অঙ্কসহ", () => {
    expect(takaToPoisha("240.50")).toBe(24050)
    expect(takaToPoisha("২৪০")).toBe(24000)
    expect(takaToPoisha("১,২৫০.৫")).toBe(125050)
    expect(poishaToTaka(24050)).toBe("240.50")
    expect(poishaToTaka(5)).toBe("0.05")
    expect(codeOf(() => takaToPoisha("12.345"))).toBe("invalid_amount")
    expect(codeOf(() => takaToPoisha("abc"))).toBe("invalid_amount")
    expect(percentToBp("7.5")).toBe(750)
    expect(codeOf(() => percentToBp("120"))).toBe("invalid_percent")
  })

  it("কার্টন → পিস", () => {
    expect(toBaseUnits({ qty: 3, unit: "carton", packSize: 10 })).toBe(30)
    expect(toBaseUnits({ qty: 4, unit: "piece", packSize: 10 })).toBe(4)
    expect(codeOf(() => toBaseUnits({ qty: 1, unit: "carton", packSize: 1 }))).toBe("no_carton")
    expect(codeOf(() => toBaseUnits({ qty: 0, unit: "piece", packSize: 1 }))).toBe("invalid_number")
    expect(codeOf(() => toBaseUnits({ qty: 1, unit: "box", packSize: 1 }))).toBe("invalid_unit")
    expect(splitCartons(25, 10)).toEqual({ cartons: 2, pieces: 5 })
  })
})

describe("মেয়াদ ও FIFO", () => {
  const today = "2026-11-12"

  it("মেয়াদের শ্রেণি", () => {
    expect(daysUntil("2026-11-22", today)).toBe(10)
    expect(classifyExpiry(null, today)).toBe("none")
    expect(classifyExpiry("2026-11-11", today)).toBe("expired")
    expect(classifyExpiry("2026-11-12", today)).toBe("expired") // আজকের তারিখে শেষ = বিক্রি নয়
    expect(classifyExpiry("2026-12-12", today)).toBe("critical") // ৩০ দিন
    expect(classifyExpiry("2027-01-10", today)).toBe("soon") // ৫৯ দিন
    expect(classifyExpiry("2027-06-01", today)).toBe("ok")
    expect(codeOf(() => classifyExpiry("2026-02-30", today))).toBe("invalid_date")
  })

  const batches = [
    { id: "late", expiryDate: "2027-09-01", qtyRemaining: 10 },
    { id: "none", expiryDate: null, qtyRemaining: 10 },
    { id: "soon", expiryDate: "2027-01-15", qtyRemaining: 4 },
    { id: "dead", expiryDate: "2026-10-01", qtyRemaining: 50 },
    { id: "empty", expiryDate: "2026-12-01", qtyRemaining: 0 },
  ]

  it("আগে মেয়াদ শেষ হওয়া ব্যাচ আগে, মেয়াদোত্তীর্ণ বাদ", () => {
    expect(allocateFifo(batches, 6, today)).toEqual([
      { batchId: "soon", qty: 4 },
      { batchId: "late", qty: 2 },
    ])
    expect(allocateFifo(batches, 24, today).map((a) => a.batchId)).toEqual(["soon", "late", "none"])
  })

  it("স্টক কম হলে ত্রুটি, মেয়াদোত্তীর্ণ গোনা হয় না", () => {
    let err: unknown
    try {
      allocateFifo(batches, 25, today)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(DomainError)
    expect((err as DomainError).code).toBe("insufficient_stock")
    expect((err as DomainError).details?.available).toBe(24)
  })
})

describe("বিল ও পেমেন্ট", () => {
  it("নমুনা বিল #১০৪৩ = ৪৫৫ − ২৫ = ৪৩০", () => {
    const s = computeSale(
      [
        { unitPrice: 15000, qty: 2 },
        { unitPrice: 8500, qty: 1 },
        { unitPrice: 2000, qty: 3 },
        { unitPrice: 1000, qty: 1 },
      ],
      { type: "amount", value: 2500 },
    )
    expect(s.subtotal).toBe(45500)
    expect(s.discount).toBe(2500)
    expect(s.total).toBe(43000)
  })

  it("শতাংশ ছাড় ও সীমা", () => {
    const s = computeSale([{ unitPrice: 10050, qty: 1 }], { type: "percentBp", value: 1000 })
    expect(s.discount).toBe(1005)
    expect(s.total).toBe(9045)
    expect(codeOf(() => computeSale([{ unitPrice: 100, qty: 1 }], { type: "amount", value: 101 }))).toBe(
      "discount_too_large",
    )
    expect(codeOf(() => computeSale([]))).toBe("empty_cart")
  })

  it("পেমেন্ট ভাগ: ২৫০ নগদ + ১০০ বিকাশ + ৮০ বাকি", () => {
    const r = settlePayments({
      total: 43000,
      payments: [
        { method: "cash", amount: 25000 },
        { method: "bkash", amount: 10000 },
      ],
      hasCustomer: true,
    })
    expect(r).toEqual({ paid: 35000, due: 8000, change: 0 })
    expect(
      codeOf(() =>
        settlePayments({ total: 43000, payments: [{ method: "cash", amount: 1000 }], hasCustomer: false }),
      ),
    ).toBe("customer_required")
  })

  it("বেশি নগদ দিলে ফেরত; বেশি বিকাশ নয়", () => {
    expect(
      settlePayments({ total: 43000, payments: [{ method: "cash", amount: 50000 }], hasCustomer: false }),
    ).toEqual({ paid: 43000, due: 0, change: 7000 })
    expect(
      codeOf(() =>
        settlePayments({ total: 43000, payments: [{ method: "bkash", amount: 50000 }], hasCustomer: false }),
      ),
    ).toBe("overpaid_digital")
    expect(
      codeOf(() => settlePayments({ total: 43000, payments: [{ method: "nope", amount: 1 }], hasCustomer: true })),
    ).toBe("invalid_method")
  })
})

describe("ফোন", () => {
  it("মোবাইল নম্বর স্বাভাবিকীকরণ", () => {
    expect(normalizePhone("01712345678")).toBe("01712345678")
    expect(normalizePhone("+8801712345678")).toBe("01712345678")
    expect(normalizePhone("৮৮০১৭১২-৩৪৫৬৭৮")).toBe("01712345678")
    expect(normalizePhone("০১৭১২ ৩৪৫৬৭৮")).toBe("01712345678")
    expect(codeOf(() => normalizePhone("01212345678"))).toBe("invalid_phone")
    expect(codeOf(() => normalizePhone("1712345678"))).toBe("invalid_phone")
  })
})
