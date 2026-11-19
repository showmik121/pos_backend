import { DomainError } from "./errors.js"
import { normalizePhone } from "./phone.js"
import { parseUuid } from "./product.js"

// কাস্টমার ও বাকির খাতার নিয়ম: ফ্রন্টএন্ডের addCustomer / receiveDue / customerBalance (src/lib/store) এর সমতুল্য।

export const LEDGER_KINDS = ["sale", "opening", "payment", "void"] as const
export type LedgerKind = (typeof LEDGER_KINDS)[number]
export const PAYMENT_METHODS = ["cash", "bkash", "nagad", "rocket"] as const
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]
const MAX_POISHA = 9_000_000_000_000

export interface Customer {
  id: string
  name: string
  /** ফোন না থাকলে "" */
  phone: string
  createdAt: string
}

export interface CustomerWithBalance extends Customer {
  balancePoisha: number
}

export interface NewCustomer {
  id: string
  name: string
  phone: string
}

/** খাতার এন্ট্রি; amountPoisha সবসময় ধনাত্মক (kind থেকে বোঝা যায় বাকি বাড়ল না কমল) */
export interface LedgerEntry {
  id: string
  customerId: string
  kind: LedgerKind
  amountPoisha: number
  saleId: string | null
  method: PaymentMethod | null
  at: string
  by: string
}

export interface LedgerInput {
  id: string
  kind: "opening" | "payment"
  amountPoisha: number
  method: PaymentMethod | null
}

const bad = (msg: string) => new DomainError("invalid_input", msg)

/** sale/opening = বাকি বাড়ে (+), payment/void = কমে (−) */
export function signedAmount(kind: LedgerKind, amountPoisha: number): number {
  return kind === "payment" || kind === "void" ? -amountPoisha : amountPoisha
}

export function balanceOf(entries: ReadonlyArray<{ kind: LedgerKind; amountPoisha: number }>): number {
  return entries.reduce((sum, e) => sum + signedAmount(e.kind, e.amountPoisha), 0)
}

export function parseNewCustomer(body: Record<string, unknown>): NewCustomer {
  const name = typeof body.name === "string" ? body.name.trim() : ""
  if (!name) throw bad("কাস্টমারের নাম দিন")
  if (name.length > 120) throw bad("কাস্টমারের নাম খুব বড়")
  const raw = body.phone
  if (raw !== undefined && raw !== null && typeof raw !== "string") throw bad("ফোন লেখা হতে হবে")
  const phone = typeof raw === "string" && raw.trim() !== "" ? normalizePhone(raw) : ""
  return { id: parseUuid(body.id, "id"), name, phone }
}

export const sameCustomerFields = (a: { name: string; phone: string }, b: { name: string; phone: string }) =>
  a.name === b.name && a.phone === b.phone

function parseAmount(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0 || v > MAX_POISHA) throw bad("পরিমাণ ধনাত্মক পূর্ণসংখ্যা (পয়সায়) হতে হবে")
  return v
}

export function parsePayment(body: Record<string, unknown>): LedgerInput {
  const method = body.method === undefined ? "cash" : body.method
  if (!(PAYMENT_METHODS as readonly unknown[]).includes(method)) throw bad("মাধ্যম cash, bkash, nagad বা rocket হতে হবে")
  return { id: parseUuid(body.id, "id"), kind: "payment", amountPoisha: parseAmount(body.amount), method: method as PaymentMethod }
}

export function parseOpening(body: Record<string, unknown>): LedgerInput {
  return { id: parseUuid(body.id, "id"), kind: "opening", amountPoisha: parseAmount(body.amount), method: null }
}

/** বাকির চেয়ে বেশি আদায় নয় */
export function assertNotOverpay(balancePoisha: number, amountPoisha: number): void {
  if (amountPoisha > balancePoisha) throw new DomainError("overpay", "বাকির চেয়ে বেশি জমা নেওয়া যায় না", { balancePoisha })
}

/** একই id-তে আগের এন্ট্রি থাকলে সেটি আজকের অনুরোধের সমান কি না */
export function sameLedgerInput(existing: LedgerEntry, customerId: string, input: LedgerInput): boolean {
  return existing.customerId === customerId && existing.kind === input.kind && existing.amountPoisha === input.amountPoisha && existing.method === input.method
}
