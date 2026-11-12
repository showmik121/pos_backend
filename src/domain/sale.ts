import { DomainError, requireNonNegativeInt, requirePositiveInt } from "./errors.js"

export const PAYMENT_METHODS = ["cash", "bkash", "nagad", "rocket", "card", "other"] as const
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]

export interface CartItem {
  unitPrice: number // পয়সা
  qty: number // পিস
}

export type Discount = { type: "amount"; value: number } | { type: "percentBp"; value: number } // percentBp = শতাংশ × ১০০

export interface SaleTotals<T extends CartItem = CartItem> {
  lines: Array<T & { lineTotal: number }>
  subtotal: number
  discount: number
  total: number
}

// সব হিসাব পয়সায় (পূর্ণসংখ্যা)।
export function computeSale<T extends CartItem>(
  items: T[],
  discount: Discount = { type: "amount", value: 0 },
): SaleTotals<T> {
  if (!Array.isArray(items) || items.length === 0) {
    throw new DomainError("empty_cart", "বিলে কমপক্ষে একটি পণ্য লাগবে")
  }
  let subtotal = 0
  const lines = items.map((it) => {
    requireNonNegativeInt(it.unitPrice, "দাম")
    requirePositiveInt(it.qty, "পরিমাণ")
    const lineTotal = it.unitPrice * it.qty
    subtotal += lineTotal
    return { ...it, lineTotal }
  })

  let discountAmount: number
  if (discount.type === "amount") {
    discountAmount = requireNonNegativeInt(discount.value, "ছাড়")
  } else if (discount.type === "percentBp") {
    requireNonNegativeInt(discount.value, "ছাড়ের শতাংশ")
    if (discount.value > 10_000) throw new DomainError("invalid_percent", "ছাড় ১০০% এর বেশি হতে পারে না")
    discountAmount = Math.round((subtotal * discount.value) / 10_000)
  } else {
    throw new DomainError("invalid_discount", "ছাড়ের ধরন সঠিক নয়")
  }
  if (discountAmount > subtotal) {
    throw new DomainError("discount_too_large", "ছাড় বিলের মোটের চেয়ে বেশি হতে পারে না")
  }
  return { lines, subtotal, discount: discountAmount, total: subtotal - discountAmount }
}

export interface PaymentInput {
  method: string
  amount: number // পয়সা
}

// কম দিলে বাকি (due) হবে — তখন কাস্টমার বাধ্যতামূলক।
// বেশি দিলে অতিরিক্তটা নগদ হতে হবে (ফেরত দেওয়া হবে); অনলাইন পেমেন্ট মোটের বেশি হতে পারে না।
export function settlePayments(input: {
  total: number
  payments: PaymentInput[]
  hasCustomer: boolean
}): { paid: number; due: number; change: number } {
  const { total, payments, hasCustomer } = input
  requireNonNegativeInt(total, "মোট")
  let cash = 0
  let other = 0
  for (const p of payments ?? []) {
    if (!(PAYMENT_METHODS as readonly string[]).includes(p.method)) {
      throw new DomainError("invalid_method", "পেমেন্টের মাধ্যম সঠিক নয়")
    }
    requirePositiveInt(p.amount, "পেমেন্টের পরিমাণ")
    if (p.method === "cash") cash += p.amount
    else other += p.amount
  }
  if (other > total) {
    throw new DomainError("overpaid_digital", "বিকাশ/কার্ড ইত্যাদির পরিমাণ মোটের বেশি হতে পারে না")
  }
  const received = cash + other
  const change = Math.max(0, received - total)
  if (change > cash) {
    throw new DomainError("overpaid", "ফেরত দেওয়ার মতো নগদ নেই")
  }
  const paid = received - change
  const due = total - paid
  if (due > 0 && !hasCustomer) {
    throw new DomainError("customer_required", "বাকি রাখতে কাস্টমার বেছে নিন")
  }
  return { paid, due, change }
}
