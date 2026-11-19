import { createHash } from "node:crypto"
import { DomainError } from "./errors.js"
import { daysUntil } from "./expiry.js"
import { normalizePhone } from "./phone.js"
import { parseNewProduct, type ProductFields } from "./product.js"

// প্রজেক্টর: সিংক ইভেন্ট-লগের ইভেন্ট (ফ্রন্টএন্ডের গঠন) থেকে সার্ভারের টেবিলে বসানোর কমান্ড বানায়।
// এখানে শুধু যাচাই ও রূপান্তর (বিশুদ্ধ); বসানো pg-projection.ts / memory-projection.ts-এ।
// ইভেন্টের ধরন ও পেলোড: pos_fontend/src/lib/sync/events.ts।

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/
const MAX = 9_000_000_000_000
const METHODS = ["cash", "bkash", "nagad", "rocket"] as const

/** ফোনের কিছু id UUID নয় (পুরনো ব্রাউজারে বা `void:<id>`); সেগুলো থেকে স্থির UUID বানাই, UUID হলে ছোট হাতের একই */
export function normalizeId(id: string): string {
  if (UUID_RE.test(id)) return id.toLowerCase()
  const b = createHash("sha256").update(`pos:id:${id}`).digest()
  b[6] = (b[6]! & 0x0f) | 0x40
  b[8] = (b[8]! & 0x3f) | 0x80
  const h = b.subarray(0, 16).toString("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

export interface ProjectedLedger {
  id: string
  customerId: string
  kind: "sale" | "opening" | "payment" | "void"
  amountPoisha: number
  saleId: string | null
  at: string
  by: string
}

export interface ProjectedSale {
  id: string
  no: number
  prefix: string | null
  at: string
  cashier: string
  lines: { productId: string; name: string; qty: number; unitPrice: number; discount: number; allocations: { batchId: string; batchNo: string; qty: number; costPoisha: number }[] }[]
  subtotal: number
  lineDiscount: number
  billDiscount: number
  total: number
  payments: { method: (typeof METHODS)[number]; amount: number }[]
  change: number
  due: number
  customerId: string | null
  customerName: string | null
}

export interface ProjectedRemoval {
  id: string
  at: string
  by: string
  batchId: string | null
  productId: string
  productName: string
  batchNo: string
  expiryDate: string | null
  qty: number
  costPoisha: number
  reason: string
}

interface Base {
  /** `<at>|<ইভেন্ট id>`: শেষ-বদল-জেতে তুলনার ঘড়ি */
  stamp: string
  eventId: string
}

export type ProjectionCommand = Base &
  (
    | { kind: "product"; id: string; fields: ProductFields; createdAt: string }
    | { kind: "stock_in"; batchId: string; productId: string; batchNo: string; expiryDate: string | null; qty: number; costPoisha: number; receivedAt: string }
    | { kind: "customer"; id: string; name: string; phone: string; createdAt: string }
    | { kind: "sale"; sale: ProjectedSale; ledger: ProjectedLedger | null }
    | { kind: "void"; saleId: string; voided: { at: string; by: string; reason: string }; ledger: ProjectedLedger | null }
    | { kind: "due"; entry: ProjectedLedger }
    | { kind: "batch_removed"; removed: ProjectedRemoval }
  )

export type Mapped = ProjectionCommand | { ignore: string }

const bad = (msg: string) => new DomainError("invalid_input", msg)
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x)

function int(v: unknown, name: string, min = 0): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > MAX) throw bad(`${name} সঠিক নয়`)
  return v
}
function str(v: unknown, name: string, max: number, allowEmpty = false): string {
  if (typeof v !== "string") throw bad(`${name} লেখা হতে হবে`)
  const s = v.trim()
  if ((!allowEmpty && s === "") || s.length > max) throw bad(`${name} সঠিক নয়`)
  return s
}
function iso(v: unknown, name: string): string {
  if (typeof v !== "string" || !ISO_RE.test(v) || Number.isNaN(Date.parse(v))) throw bad(`${name} সঠিক সময় নয়`)
  return v
}
function idOf(v: unknown, name: string): string {
  if (typeof v !== "string" || v === "" || v.length > 100) throw bad(`${name} সঠিক নয়`)
  return normalizeId(v)
}
function dateOrNull(v: unknown, name: string): string | null {
  if (v === null || v === undefined) return null
  if (typeof v !== "string") throw bad(`${name} সঠিক নয়`)
  daysUntil(v, "2000-01-01") // ভুল তারিখে ছোঁড়ে
  return v
}

function mapLedger(raw: unknown, saleId: string | null, expected: ProjectedLedger["kind"][], fallbackCustomer?: string): ProjectedLedger {
  if (!isObj(raw)) throw bad("খাতার এন্ট্রি সঠিক নয়")
  const kind = raw.kind
  if (!expected.includes(kind as ProjectedLedger["kind"])) throw bad("খাতার ধরন সঠিক নয়")
  return {
    id: idOf(raw.id, "খাতার id"),
    customerId: raw.customerId === undefined && fallbackCustomer ? fallbackCustomer : idOf(raw.customerId, "customerId"),
    kind: kind as ProjectedLedger["kind"],
    amountPoisha: int(raw.amount, "পরিমাণ", 1),
    saleId,
    at: iso(raw.at, "at"),
    by: str(raw.by, "by", 120),
  }
}

function mapProduct(p: unknown): { id: string; fields: ProductFields; createdAt: string } {
  if (!isObj(p)) throw bad("পণ্য সঠিক নয়")
  const id = idOf(p.id, "id")
  const { id: _i, ...fields } = parseNewProduct({ ...p, id })
  return { id, fields, createdAt: iso(p.createdAt, "createdAt") }
}

function mapSale(raw: unknown, ledgerRaw: unknown): { sale: ProjectedSale; ledger: ProjectedLedger | null } {
  if (!isObj(raw)) throw bad("বিল সঠিক নয়")
  const id = idOf(raw.id, "id")
  const prefix = raw.prefix === undefined || raw.prefix === null ? null : raw.prefix
  if (prefix !== null && (typeof prefix !== "string" || !/^[A-Z]$/.test(prefix))) throw bad("উপসর্গ সঠিক নয়")
  if (!Array.isArray(raw.lines) || raw.lines.length < 1 || raw.lines.length > 100) throw bad("লাইন সঠিক নয়")
  const lines = raw.lines.map((l: unknown) => {
    if (!isObj(l) || !Array.isArray(l.allocations)) throw bad("লাইন সঠিক নয়")
    const qty = int(l.qty, "পরিমাণ", 1)
    const allocations = l.allocations.map((a: unknown) => {
      if (!isObj(a)) throw bad("ব্যাচ-ভাগ সঠিক নয়")
      return { batchId: idOf(a.batchId, "batchId"), batchNo: str(a.batchNo ?? "", "batchNo", 60, true), qty: int(a.qty, "ভাগের পরিমাণ", 1), costPoisha: int(a.costPoisha, "ক্রয়মূল্য") }
    })
    if (allocations.reduce((n: number, a: { qty: number }) => n + a.qty, 0) !== qty) throw bad("ব্যাচ-ভাগের যোগফল পরিমাণের সমান নয়")
    return { productId: idOf(l.productId, "productId"), name: str(l.name, "name", 200), qty, unitPrice: int(l.unitPrice, "দাম"), discount: int(l.discount ?? 0, "ছাড়"), allocations }
  })
  const subtotal = int(raw.subtotal, "subtotal")
  const lineDiscount = int(raw.lineDiscount, "lineDiscount")
  const billDiscount = int(raw.billDiscount, "billDiscount")
  const total = int(raw.total, "total")
  const change = int(raw.change, "change")
  const due = int(raw.due, "due")
  const gross = lines.reduce((n: number, l: { unitPrice: number; qty: number }) => n + l.unitPrice * l.qty, 0)
  if (subtotal !== gross || lineDiscount !== lines.reduce((n: number, l: { discount: number }) => n + l.discount, 0) || total !== subtotal - lineDiscount - billDiscount) {
    throw bad("বিলের হিসাব মেলে না")
  }
  if (!Array.isArray(raw.payments) || raw.payments.length > 10) throw bad("পেমেন্ট সঠিক নয়")
  const payments = raw.payments.map((p: unknown) => {
    if (!isObj(p) || !(METHODS as readonly unknown[]).includes(p.method)) throw bad("পেমেন্ট সঠিক নয়")
    return { method: p.method as (typeof METHODS)[number], amount: int(p.amount, "পেমেন্টের পরিমাণ", 1) }
  })
  if (payments.reduce((n: number, p: { amount: number }) => n + p.amount, 0) - change !== total - due) throw bad("পেমেন্টের হিসাব মেলে না")
  const customerId = raw.customerId === null || raw.customerId === undefined ? null : idOf(raw.customerId, "customerId")
  if (due > 0 && customerId === null) throw bad("বাকির বিলে কাস্টমার লাগে")
  const at = iso(raw.at, "at")
  const cashier = str(raw.cashier, "cashier", 120)
  const sale: ProjectedSale = {
    id, no: int(raw.no, "বিল নম্বর", 1), prefix, at, cashier, lines, subtotal, lineDiscount, billDiscount, total, payments, change, due,
    customerId, customerName: typeof raw.customerName === "string" ? raw.customerName.slice(0, 120) : null,
  }
  if (due === 0) return { sale, ledger: null }
  const ledger = isObj(ledgerRaw)
    ? { ...mapLedger(ledgerRaw, id, ["sale"], customerId ?? undefined), customerId: customerId! }
    : { id: normalizeId(`sale:${id}`), customerId: customerId!, kind: "sale" as const, amountPoisha: due, saleId: id, at, by: cashier }
  if (ledger.amountPoisha !== due) throw bad("খাতার পরিমাণ বাকির সমান নয়")
  return { sale, ledger }
}

type Body<T> = T extends unknown ? Omit<T, "stamp" | "eventId"> : never

function map(kind: string, p: Record<string, unknown>): Body<ProjectionCommand> {
  switch (kind) {
    case "product_upserted":
      return { kind: "product", ...mapProduct(p.product) }
    case "stock_in":
      return {
        kind: "stock_in",
        batchId: idOf(p.batchId, "batchId"),
        productId: idOf(p.productId, "productId"),
        batchNo: str(p.batchNo ?? "", "batchNo", 60, true),
        expiryDate: dateOrNull(p.expiryDate, "মেয়াদ"),
        qty: int(p.qty, "পরিমাণ", 1),
        costPoisha: int(p.costPoisha, "ক্রয়মূল্য"),
        receivedAt: iso(p.receivedAt, "receivedAt"),
      }
    case "customer_upserted": {
      const c = p.customer
      if (!isObj(c)) throw bad("কাস্টমার সঠিক নয়")
      const phone = typeof c.phone === "string" && c.phone.trim() !== "" ? normalizePhone(c.phone) : ""
      return { kind: "customer", id: idOf(c.id, "id"), name: str(c.name, "নাম", 120), phone, createdAt: iso(c.createdAt, "createdAt") }
    }
    case "sale_completed":
      return { kind: "sale", ...mapSale(p.sale, p.ledger) }
    case "sale_voided": {
      const v = p.voided
      if (!isObj(v)) throw bad("বাতিলের তথ্য সঠিক নয়")
      const saleId = idOf(p.saleId, "saleId")
      const ledger = isObj(p.ledger) ? mapLedger(p.ledger, saleId, ["void"]) : null
      return { kind: "void", saleId, voided: { at: iso(v.at, "at"), by: str(v.by, "by", 120), reason: str(v.reason, "কারণ", 200) }, ledger }
    }
    case "due_received":
      return { kind: "due", entry: mapLedger(p.entry, null, ["payment", "opening"]) }
    case "batch_removed": {
      const r = p.removed
      if (!isObj(r)) throw bad("সরানোর তথ্য সঠিক নয়")
      return {
        kind: "batch_removed",
        removed: {
          id: idOf(r.id, "id"),
          at: iso(r.at, "at"),
          by: str(r.by, "by", 120),
          batchId: r.batchId === undefined || r.batchId === null ? null : idOf(r.batchId, "batchId"),
          productId: idOf(r.productId, "productId"),
          productName: str(r.productName ?? "", "productName", 200, true),
          batchNo: str(r.batchNo ?? "", "batchNo", 60, true),
          expiryDate: dateOrNull(r.expiryDate, "মেয়াদ"),
          qty: int(r.qty, "পরিমাণ", 0),
          costPoisha: int(r.costPoisha, "ক্রয়মূল্য"),
          reason: str(r.reason, "কারণ", 200),
        },
      }
    }
    default:
      throw new DomainError("ignored_kind", `ধরন ${kind} সার্ভারে প্রজেক্ট হয় না`)
  }
}

/** ইভেন্ট → কমান্ড; যাচাইয়ে না টিকলে `{ ignore: কারণ }` (লগে ইভেন্ট থাকে, টেবিলে বসে না) */
export function toCommand(e: { id: string; kind: string; at: string; payload: Record<string, unknown> }): Mapped {
  try {
    const eventId = normalizeId(e.id)
    return { ...map(e.kind, e.payload), eventId, stamp: `${e.at}|${eventId}` } as ProjectionCommand
  } catch (err) {
    if (err instanceof DomainError) return { ignore: err.message }
    throw err
  }
}
