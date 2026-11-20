import { computeCart, NO_BILL_DISCOUNT, settlePayments, splitPayments, type BillDiscount, type Payment } from "./cart.js"
import { DomainError } from "./errors.js"
import { allocateFifo, sellableBatches } from "./fifo.js"
import { parseUuid } from "./product.js"

// বিক্রির নিয়ম: ফ্রন্টএন্ডের completeSale / voidSale (src/lib/store/actions.ts) এর সমতুল্য।
// হিসাব (ছাড়, পেমেন্ট, FIFO) cart.ts ও fifo.ts-এ — সেগুলো গোল্ডেন ফিক্সচারে বাঁধা।

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/
const MAX_LINES = 100
const MAX_QTY = 1_000_000
const MAX_POISHA = 9_000_000_000_000
const MAX_BILL_NO = 999_999_999
const bad = (msg: string) => new DomainError("invalid_input", msg)

export interface SaleLineInput {
  productId: string
  /** পিসে */
  qty: number
  /** এই লাইনের মোট ছাড়, পয়সা */
  discount: number
  /** শুধু অফলাইন বিলে: বিক্রির সময়ের দাম; অনলাইনে সার্ভারের দাম চলে */
  unitPrice: number | null
}

export interface SaleCommand {
  id: string
  no: number
  prefix: string | null
  customerId: string | null
  lines: SaleLineInput[]
  billDiscount: BillDiscount
  payments: { method: string; amount: number }[]
  /** ফোনে অফলাইনে করা বিল সার্ভারে আসছে: স্টকের বেশি হলেও নেওয়া হয় (oversold) */
  offline: boolean
  /** অফলাইন বিলের আসল সময় */
  at: string | null
}

function parseInt0(v: unknown, name: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) throw bad(`${name} সঠিক নয়`)
  return v
}

function parseBillDiscount(v: unknown): BillDiscount {
  if (v === undefined || v === null) return NO_BILL_DISCOUNT
  const o = v as { type?: unknown; value?: unknown }
  if (typeof v !== "object" || (o.type !== "amount" && o.type !== "percent")) throw bad("বিল-ছাড়ের ধরন amount বা percent হতে হবে")
  return { type: o.type, value: parseInt0(o.value, "ছাড়", 0, MAX_POISHA) }
}

export function parseSaleCommand(body: Record<string, unknown>): SaleCommand {
  const offline = body.offline === undefined ? false : body.offline
  if (typeof offline !== "boolean") throw bad("offline true/false হতে হবে")
  if (!Array.isArray(body.lines) || body.lines.length < 1 || body.lines.length > MAX_LINES) throw bad(`বিলে ১ থেকে ${MAX_LINES}টি লাইন লাগবে`)
  const seen = new Set<string>()
  const lines = body.lines.map((raw: unknown): SaleLineInput => {
    const l = (raw ?? {}) as Record<string, unknown>
    const productId = parseUuid(l.productId, "productId")
    if (seen.has(productId)) throw bad("একই পণ্য একাধিক লাইনে দেওয়া যায় না")
    seen.add(productId)
    if (l.unitPrice !== undefined && l.unitPrice !== null && !offline) throw bad("unitPrice শুধু অফলাইন বিলে দেওয়া যায়")
    return {
      productId,
      qty: parseInt0(l.qty, "পরিমাণ", 1, MAX_QTY),
      discount: l.discount === undefined ? 0 : parseInt0(l.discount, "ছাড়", 0, MAX_POISHA),
      unitPrice: l.unitPrice === undefined || l.unitPrice === null ? null : parseInt0(l.unitPrice, "দাম", 0, MAX_POISHA),
    }
  })
  const rawPrefix = body.prefix
  if (rawPrefix !== undefined && rawPrefix !== null && typeof rawPrefix !== "string") throw bad("prefix সঠিক নয়")
  if (typeof rawPrefix === "string" && rawPrefix !== "" && !/^[A-Z]$/.test(rawPrefix)) throw bad("prefix একটি ইংরেজি বড় হাতের অক্ষর হতে হবে")
  const rawPayments = body.payments === undefined ? [] : body.payments
  if (!Array.isArray(rawPayments) || rawPayments.length > 10) throw bad("payments তালিকা সঠিক নয়")
  const payments = rawPayments.map((p: unknown) => {
    const o = (p ?? {}) as { method?: unknown; amount?: unknown }
    if (typeof o.method !== "string") throw bad("পেমেন্টের মাধ্যম লাগবে")
    return { method: o.method, amount: parseInt0(o.amount, "পেমেন্টের পরিমাণ", 1, MAX_POISHA) }
  })
  let at: string | null = null
  if (body.at !== undefined && body.at !== null) {
    if (!offline) throw bad("at শুধু অফলাইন বিলে দেওয়া যায়")
    if (typeof body.at !== "string" || !ISO_RE.test(body.at) || Number.isNaN(Date.parse(body.at))) throw bad("at সঠিক সময় নয়")
    at = new Date(body.at).toISOString()
  }
  const cid = body.customerId
  return {
    id: parseUuid(body.id, "id"),
    no: parseInt0(body.no, "বিল নম্বর", 1, MAX_BILL_NO),
    prefix: typeof rawPrefix === "string" && rawPrefix !== "" ? rawPrefix : null,
    customerId: cid === undefined || cid === null ? null : parseUuid(cid, "customerId"),
    lines,
    billDiscount: parseBillDiscount(body.billDiscount),
    payments,
    offline,
    at,
  }
}

/** একই id-তে আবার এলে আগেরটার সাথে মেলানোর আঙুলছাপ (id বাদে অনুরোধের সবকিছু) */
export async function saleFingerprint(cmd: SaleCommand): Promise<string> {
  const text = JSON.stringify([
    cmd.no, cmd.prefix, cmd.customerId,
    cmd.lines.map((l) => [l.productId, l.qty, l.discount, l.unitPrice]),
    cmd.billDiscount.type, cmd.billDiscount.value,
    cmd.payments.map((p) => [p.method, p.amount]),
    cmd.offline, cmd.at,
  ])
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

export function parseVoid(body: Record<string, unknown>): { reason: string } {
  const reason = typeof body.reason === "string" ? body.reason.trim() : ""
  if (!reason) throw new DomainError("reason_required", "বাতিলের কারণ লিখুন")
  if (reason.length > 200) throw bad("কারণ খুব বড়")
  return { reason }
}

// ---------------------------------------------------------------- রেকর্ড

export interface SaleAllocationRec {
  batchId: string
  batchNo: string
  qty: number
  /** অফলাইন বিলে স্টকের চেয়ে যত পিস বেশি বিক্রি হয়েছিল */
  oversoldQty: number
  costPoisha: number
}

export interface SaleLineRec {
  productId: string
  name: string
  qty: number
  unitPrice: number
  discount: number
  allocations: SaleAllocationRec[]
}

export interface SaleRecord {
  id: string
  no: number
  prefix: string | null
  at: string
  cashier: string
  lines: SaleLineRec[]
  subtotal: number
  lineDiscount: number
  billDiscount: number
  total: number
  payments: Payment[]
  change: number
  due: number
  customerId: string | null
  customerName: string | null
  oversold: boolean
  voided?: { at: string; by: string; reason: string }
}

/** ক্রয়মূল্য কর্মচারীর কাছে গোপন */
export function presentSale(sale: SaleRecord, role: "owner" | "staff") {
  return {
    ...sale,
    lines: sale.lines.map((l) => ({
      ...l,
      allocations: l.allocations.map(({ oversoldQty, costPoisha, ...a }) => ({
        ...a,
        costPoisha: role === "owner" ? costPoisha : null,
        ...(oversoldQty > 0 ? { oversoldQty } : {}),
      })),
    })),
  }
}

// ---------------------------------------------------------------- বিক্রির পরিকল্পনা (বিশুদ্ধ)

export interface ProductInfo {
  id: string
  name: string
  pricePoisha: number
  costPoisha: number
}

export interface BatchInfo {
  id: string
  batchNo: string
  expiryDate: string | null
  qtyRemaining: number
  costPoisha: number
  receivedAt: string
}

export interface PlannedAllocation extends SaleAllocationRec {
  /** true হলে এই ব্যাচটি এখনো নেই (পণ্যের কোনো ব্যাচ ছিল না) — বানাতে হবে */
  createBatch: boolean
}

export interface PlannedLine extends Omit<SaleLineRec, "allocations"> {
  allocations: PlannedAllocation[]
}

export interface SalePlan {
  lines: PlannedLine[]
  subtotal: number
  lineDiscount: number
  billDiscount: number
  total: number
  payments: Payment[]
  change: number
  due: number
  oversold: boolean
}

function allocateLine(
  product: ProductInfo,
  all: readonly BatchInfo[],
  qty: number,
  cmd: SaleCommand,
  today: string,
  newBatchId: () => string,
): PlannedAllocation[] {
  const usable = sellableBatches(all, today)
  const available = usable.reduce((s, b) => s + b.qtyRemaining, 0)
  const info = new Map(all.map((b) => [b.id, b]))
  const make = (batchId: string, q: number, oversoldQty: number): PlannedAllocation => {
    const b = info.get(batchId)
    return { batchId, batchNo: b?.batchNo ?? "", qty: q, oversoldQty, costPoisha: b?.costPoisha ?? product.costPoisha, createBatch: false }
  }
  if (available >= qty || !cmd.offline) {
    return allocateFifo(all, qty, today).map((a) => make(a.batchId, a.qty, 0)) // কম হলে এখানেই insufficient_stock
  }
  // অফলাইন বিল: যা আছে সব নিই, বাকিটা (shortfall) এক ব্যাচে চাপাই — সেই ব্যাচ ঋণাত্মক হয়
  const shortfall = qty - available
  const out = usable.map((b) => make(b.id, b.qtyRemaining, 0))
  const newest = [...all].sort((a, b) => (a.receivedAt === b.receivedAt ? (a.id < b.id ? 1 : -1) : a.receivedAt < b.receivedAt ? 1 : -1))[0]
  const target = usable[0] ?? newest
  if (target) {
    const hit = out.find((a) => a.batchId === target.id)
    if (hit) {
      hit.qty += shortfall
      hit.oversoldQty = shortfall
    } else out.push(make(target.id, shortfall, shortfall))
  } else {
    out.push({ batchId: newBatchId(), batchNo: "", qty: shortfall, oversoldQty: shortfall, costPoisha: product.costPoisha, createBatch: true })
  }
  return out
}

export function planSale(
  cmd: SaleCommand,
  products: ReadonlyMap<string, ProductInfo>,
  batches: ReadonlyMap<string, readonly BatchInfo[]>,
  hasCustomer: boolean,
  today: string,
  newBatchId: () => string,
): SalePlan {
  const priced = cmd.lines.map((l) => {
    const product = products.get(l.productId)
    if (!product) throw new DomainError("not_found", "বিলের একটি পণ্য পাওয়া যায়নি")
    const unitPrice = cmd.offline && l.unitPrice !== null ? l.unitPrice : product.pricePoisha
    return { line: l, product, unitPrice }
  })
  const totals = computeCart(priced.map((p) => ({ unitPrice: p.unitPrice, qty: p.line.qty, discount: p.line.discount })), cmd.billDiscount)
  const split = splitPayments(cmd.payments)
  const settled = settlePayments({ total: totals.total, cash: split.cash, mobile: split.mobile, mobileMethod: split.mobileMethod, hasCustomer })
  const lines: PlannedLine[] = priced.map(({ line, product, unitPrice }) => ({
    productId: product.id,
    name: product.name,
    qty: line.qty,
    unitPrice,
    discount: line.discount,
    allocations: allocateLine(product, batches.get(product.id) ?? [], line.qty, cmd, today, newBatchId),
  }))
  return {
    lines,
    ...totals,
    payments: settled.payments,
    change: settled.change,
    due: settled.due,
    oversold: lines.some((l) => l.allocations.some((a) => a.oversoldQty > 0)),
  }
}

// ---------------------------------------------------------------- বাতিলের পরিকল্পনা (বিশুদ্ধ)

export interface VoidPlan {
  restores: { batchId: string; qty: number }[]
  restoredQty: number
  lostQty: number
  /** খাতায় বাকি কমবে এত পয়সা */
  dueReversed: number
  /** কাস্টমারকে ফেরত দিতে হবে এত পয়সা (বিলের সময় নেওয়া টাকা + পরে শোধ করা বাকি) */
  refundPoisha: number
}

export function planVoid(sale: SaleRecord, liveBatchIds: ReadonlySet<string>, customerBalance: number): VoidPlan {
  const restores: VoidPlan["restores"] = []
  let restoredQty = 0
  let lostQty = 0
  for (const line of sale.lines) {
    for (const a of line.allocations) {
      if (liveBatchIds.has(a.batchId)) {
        restores.push({ batchId: a.batchId, qty: a.qty })
        restoredQty += a.qty
      } else lostQty += a.qty // ব্যাচ আগেই সরানো: মেয়াদ অজানা, তাই নতুন ব্যাচ বানানো হয় না
    }
  }
  // কাস্টমার পরে কিছু বাকি শোধ করে থাকলে সেটুকু ঋণাত্মক বাকি না বানিয়ে ফেরতের হিসাবে যায়
  const dueReversed = sale.due > 0 && sale.customerId ? Math.min(sale.due, Math.max(0, customerBalance)) : 0
  const refundPoisha = sale.total - sale.due + (sale.due - dueReversed)
  return { restores, restoredQty, lostQty, dueReversed, refundPoisha }
}
