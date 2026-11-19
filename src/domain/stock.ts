import { DomainError, requireNonNegativeInt } from "./errors.js"
import { classifyExpiry, daysUntil, type ExpiryClass } from "./expiry.js"
import { parseUuid } from "./product.js"
import { toBaseUnits, type Unit } from "./units.js"

// স্টক-জমার নিয়ম: ফ্রন্টএন্ডের stockIn (src/lib/store/actions.ts) এর সমতুল্য।

export interface Batch {
  id: string
  productId: string
  /** ফাঁকা = ব্যাচ নম্বর নেই (প্রতিবার নতুন ব্যাচ) */
  batchNo: string
  /** YYYY-MM-DD; null = মেয়াদ নেই */
  expiryDate: string | null
  /** ঋণাত্মক হতে পারে (অফলাইন-বিক্রি পরে সার্ভারে এলে) */
  qtyRemaining: number
  costPoisha: number
  receivedAt: string
}

export interface StockInCommand {
  /** রসিদ id = ইডেমপোটেন্সি কী (stock_movements.id) */
  receiptId: string
  /** নতুন ব্যাচ হলে এই id; না দিলে সার্ভার বানায় */
  batchId: string
  productId: string
  qty: number
  unit: Unit
  batchNo: string
  expiryDate: string | null
  /** unit অনুযায়ী প্রতি কার্টন বা প্রতি পিসের ক্রয়মূল্য */
  costPoisha: number
  pricePoisha: number | null
  /** ফার্মেসিতে ব্যাচ ও মেয়াদ বাধ্যতামূলক */
  requireBatchAndExpiry: boolean
}

export interface StockInPlan {
  pieces: number
  costPerPiece: number
  batchNo: string
  pricePoisha: number
}

export function planStockIn(product: { cartonSize: number; pricePoisha: number }, cmd: StockInCommand): StockInPlan {
  const pieces = toBaseUnits({ qty: cmd.qty, unit: cmd.unit, packSize: product.cartonSize })
  requireNonNegativeInt(cmd.costPoisha, "ক্রয়মূল্য")
  const batchNo = cmd.batchNo.trim()
  if (cmd.requireBatchAndExpiry) {
    if (!batchNo) throw new DomainError("batch_required", "ব্যাচ নম্বর দিন")
    if (!cmd.expiryDate) throw new DomainError("expiry_required", "মেয়াদ দিন (মাস/বছর)")
  }
  const costPerPiece = cmd.unit === "carton" ? Math.round(cmd.costPoisha / product.cartonSize) : cmd.costPoisha
  const pricePoisha = cmd.pricePoisha != null && cmd.pricePoisha > 0 ? cmd.pricePoisha : product.pricePoisha
  return { pieces, costPerPiece, batchNo, pricePoisha }
}

const bad = (msg: string) => new DomainError("invalid_input", msg)

function parseDateOrNull(v: unknown, name: string): string | null {
  if (v === null || v === undefined) return null
  if (typeof v !== "string") throw bad(`${name} YYYY-MM-DD আকারে হতে হবে`)
  daysUntil(v, "2000-01-01") // তারিখ সঠিক না হলে invalid_date ছোঁড়ে
  return v
}

export function parseStockIn(body: Record<string, unknown>, productId: string, requireBatchAndExpiry: boolean): StockInCommand {
  if (typeof body.qty !== "number") throw bad("পরিমাণ সংখ্যা হতে হবে")
  if (typeof body.costPoisha !== "number") throw bad("ক্রয়মূল্য সংখ্যা হতে হবে")
  if (body.pricePoisha != null && typeof body.pricePoisha !== "number") throw bad("বিক্রয়মূল্য সংখ্যা হতে হবে")
  if (body.unit !== "piece" && body.unit !== "carton") throw bad("unit piece বা carton হতে হবে")
  if (body.batchNo != null && typeof body.batchNo !== "string") throw bad("ব্যাচ নম্বর লেখা হতে হবে")
  const batchNo = typeof body.batchNo === "string" ? body.batchNo : ""
  if (batchNo.length > 60) throw bad("ব্যাচ নম্বর খুব বড়")
  return {
    receiptId: parseUuid(body.id, "id"),
    batchId: body.batchId === undefined ? crypto.randomUUID() : parseUuid(body.batchId, "batchId"),
    productId,
    qty: body.qty,
    unit: body.unit,
    batchNo,
    expiryDate: parseDateOrNull(body.expiryDate, "মেয়াদ"),
    costPoisha: body.costPoisha,
    pricePoisha: typeof body.pricePoisha === "number" ? body.pricePoisha : null,
    requireBatchAndExpiry,
  }
}

export function parseRemoval(body: Record<string, unknown>): { id: string; reason: string } {
  const reason = typeof body.reason === "string" ? body.reason.trim() : ""
  if (!reason) throw new DomainError("reason_required", "সরানোর কারণ বাছুন")
  if (reason.length > 200) throw bad("কারণ খুব বড়")
  return { id: parseUuid(body.id, "id"), reason }
}

export const BATCH_STATUSES = ["active", "expired", "expiring"] as const
export type BatchStatus = (typeof BATCH_STATUSES)[number]
export const EXPIRING_DEFAULT_DAYS = 90
export const EXPIRING_MAX_DAYS = 3650

/** ঢাকার আজকের তারিখ (UTC+৬, DST নেই) */
export function dhakaToday(nowMs: number): string {
  return new Date(nowMs + 6 * 3_600_000).toISOString().slice(0, 10)
}

export function addDaysIso(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

export interface BatchView extends Omit<Batch, "costPoisha"> {
  costPoisha: number | null
  expiryClass: ExpiryClass
  daysLeft: number | null
}

/** ক্রয়মূল্য কর্মচারীর কাছে গোপন; মেয়াদের শ্রেণি আজকের তারিখে */
export function presentBatch(b: Batch, role: "owner" | "staff", today: string): BatchView {
  return {
    ...b,
    costPoisha: role === "owner" ? b.costPoisha : null,
    expiryClass: classifyExpiry(b.expiryDate, today),
    daysLeft: b.expiryDate ? daysUntil(b.expiryDate, today) : null,
  }
}

/** তালিকা-ফিল্টারের সাধারণ শর্ত: repo-গুলো একই অর্থে প্রয়োগ করে */
export function matchesBatchStatus(b: Batch, status: BatchStatus | undefined, today: string, withinDays: number): boolean {
  if (status === undefined) return true
  const cls = classifyExpiry(b.expiryDate, today)
  if (status === "expired") return cls === "expired"
  if (status === "active") return b.qtyRemaining > 0 && cls !== "expired"
  return b.expiryDate !== null && cls !== "expired" && b.expiryDate <= addDaysIso(today, withinDays)
}
