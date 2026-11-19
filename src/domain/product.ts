import { DomainError } from "./errors.js"

// পণ্যের নিয়ম: ফ্রন্টএন্ডের Product (src/lib/store/types.ts) এর সাথে মেলে। টাকা পূর্ণসংখ্যা পয়সায়, স্টক পিসে।

export const UNITS = ["piece", "strip", "box"] as const
export type ProductUnit = (typeof UNITS)[number]

export interface ProductBarcode {
  code: string
  /** এই বারকোডে কত পিস (১ = একটি পিস, ১০ = কার্টন) */
  packSize: number
}

export interface ProductFields {
  name: string
  unit: ProductUnit
  /** ১ কার্টনে কত পিস; ১ মানে কার্টন সাইজ ঠিক করা নেই */
  cartonSize: number
  costPoisha: number
  pricePoisha: number
  minStock: number
  category: string
  /** বারকোড ছাড়া "খোলা" পণ্য */
  open: boolean
  barcodes: ProductBarcode[]
}

export interface NewProduct extends ProductFields {
  id: string
}

export interface Product extends ProductFields {
  id: string
  /** ক্রয়মূল্য দেখার অনুমতি না থাকলে null */
  stockQty: number
  createdAt: string
  updatedAt: string
}

export interface ProductPatch extends Partial<ProductFields> {
  /** দিলে সার্ভারের updatedAt-এর সাথে না মিললে stale */
  expectedUpdatedAt?: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/
const MAX_BARCODES = 20
const MAX_INT = 9_000_000_000_000 // Number.MAX_SAFE_INTEGER-এর নিচে; পয়সা/পিসের যৌক্তিক ঊর্ধ্বসীমা

const bad = (msg: string) => new DomainError("invalid_input", msg)

export function parseUuid(v: unknown, name: string): string {
  if (typeof v !== "string" || !UUID_RE.test(v)) throw bad(`${name} সঠিক নয়`)
  return v
}

function parseInt0(v: unknown, name: string, min: number): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > MAX_INT) {
    throw bad(`${name} ${min === 0 ? "০ বা তার বেশি" : "১ বা তার বেশি"} পূর্ণসংখ্যা হতে হবে`)
  }
  return v
}

function parseName(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : ""
  if (!s) throw bad("পণ্যের নাম দিন")
  if (s.length > 200) throw bad("পণ্যের নাম খুব বড়")
  return s
}

function parseUnit(v: unknown): ProductUnit {
  const u = UNITS.find((x) => x === v)
  if (!u) throw bad("ইউনিট piece, strip বা box হতে হবে")
  return u
}

function parseCategory(v: unknown): string {
  if (typeof v !== "string") throw bad("ক্যাটাগরি লেখা হতে হবে")
  const s = v.trim()
  if (s.length > 60) throw bad("ক্যাটাগরি খুব বড়")
  return s
}

export function parseBarcode(v: unknown): ProductBarcode {
  const b = (v ?? {}) as Record<string, unknown>
  const code = typeof b.code === "string" ? b.code.trim() : ""
  if (!code || code.length > 64) throw bad("বারকোড ১–৬৪ অক্ষরের হতে হবে")
  return { code, packSize: parseInt0(b.packSize, "বারকোডের packSize", 1) }
}

export function parseBarcodes(v: unknown): ProductBarcode[] {
  if (!Array.isArray(v) || v.length > MAX_BARCODES) throw bad(`বারকোড তালিকা সর্বোচ্চ ${MAX_BARCODES}টি`)
  const list = v.map(parseBarcode)
  if (new Set(list.map((b) => b.code)).size !== list.length) throw bad("একই বারকোড একাধিকবার দেওয়া যায় না")
  return list
}

export function parseNewProduct(body: Record<string, unknown>): NewProduct {
  if (typeof body.open !== "undefined" && typeof body.open !== "boolean") throw bad("open true/false হতে হবে")
  return {
    id: parseUuid(body.id, "id"),
    name: parseName(body.name),
    unit: parseUnit(body.unit ?? "piece"),
    cartonSize: parseInt0(body.cartonSize ?? 1, "কার্টন সাইজ", 1),
    costPoisha: parseInt0(body.costPoisha ?? 0, "ক্রয়মূল্য", 0),
    pricePoisha: parseInt0(body.pricePoisha, "বিক্রয়মূল্য", 0),
    minStock: parseInt0(body.minStock ?? 0, "ন্যূনতম স্টক", 0),
    category: parseCategory(body.category ?? ""),
    open: body.open === true,
    barcodes: parseBarcodes(body.barcodes ?? []),
  }
}

const PATCHABLE = ["name", "unit", "cartonSize", "costPoisha", "pricePoisha", "minStock", "category", "open", "barcodes"] as const

export function parseProductPatch(body: Record<string, unknown>): ProductPatch {
  const patch: ProductPatch = {}
  if ("name" in body) patch.name = parseName(body.name)
  if ("unit" in body) patch.unit = parseUnit(body.unit)
  if ("cartonSize" in body) patch.cartonSize = parseInt0(body.cartonSize, "কার্টন সাইজ", 1)
  if ("costPoisha" in body) patch.costPoisha = parseInt0(body.costPoisha, "ক্রয়মূল্য", 0)
  if ("pricePoisha" in body) patch.pricePoisha = parseInt0(body.pricePoisha, "বিক্রয়মূল্য", 0)
  if ("minStock" in body) patch.minStock = parseInt0(body.minStock, "ন্যূনতম স্টক", 0)
  if ("category" in body) patch.category = parseCategory(body.category)
  if ("open" in body) {
    if (typeof body.open !== "boolean") throw bad("open true/false হতে হবে")
    patch.open = body.open
  }
  if ("barcodes" in body) patch.barcodes = parseBarcodes(body.barcodes)
  if ("expectedUpdatedAt" in body) {
    const t = body.expectedUpdatedAt
    if (typeof t !== "string" || !ISO_RE.test(t) || Number.isNaN(Date.parse(t))) throw bad("expectedUpdatedAt সঠিক সময় নয়")
    patch.expectedUpdatedAt = t
  }
  if (!PATCHABLE.some((k) => k in patch)) throw bad("বদলানোর মতো কোনো ক্ষেত্র দেওয়া হয়নি")
  return patch
}

const sortedBarcodes = (b: readonly ProductBarcode[]) => [...b].sort((x, y) => (x.code < y.code ? -1 : 1))

/** একই id-তে আবার তৈরির অনুরোধ আগেরটার হুবহু একই কি না (ইডেমপোটেন্সি) */
export function sameProductFields(existing: ProductFields, incoming: ProductFields): boolean {
  return (
    existing.name === incoming.name &&
    existing.unit === incoming.unit &&
    existing.cartonSize === incoming.cartonSize &&
    existing.costPoisha === incoming.costPoisha &&
    existing.pricePoisha === incoming.pricePoisha &&
    existing.minStock === incoming.minStock &&
    existing.category === incoming.category &&
    existing.open === incoming.open &&
    JSON.stringify(sortedBarcodes(existing.barcodes)) === JSON.stringify(sortedBarcodes(incoming.barcodes))
  )
}

/** কর্মচারী ক্রয়মূল্য দেখে না */
export function presentProduct(p: Product, role: "owner" | "staff"): Omit<Product, "costPoisha"> & { costPoisha: number | null } {
  return { ...p, costPoisha: role === "owner" ? p.costPoisha : null }
}

export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
}
