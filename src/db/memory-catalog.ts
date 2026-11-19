import { DomainError } from "../domain/errors.js"
import { sameProductFields, type NewProduct, type Product, type ProductBarcode } from "../domain/product.js"
import type { CatalogRepo } from "./catalog.js"

// pg-catalog.ts এর সমতুল্য ইন-মেমরি বাস্তবায়ন (টেস্টের জন্য); প্রতি দোকানের ডেটা আলাদা মানচিত্রে।
type Rec = Omit<Product, "stockQty" | "barcodes">

export interface MemoryCatalog extends CatalogRepo {
  /** ব্যাচ-স্তর (stock) যোগ হলে স্টকের যোগফল জানানোর হুক */
  setStockProvider(fn: (storeId: string, productId: string) => number): void
}

export function createMemoryCatalog(now: () => number): MemoryCatalog {
  const products = new Map<string, Map<string, Rec>>() // storeId -> id -> রেকর্ড
  const barcodes = new Map<string, Map<string, { productId: string; packSize: number }>>() // storeId -> code -> তথ্য
  let stockOf: (storeId: string, productId: string) => number = () => 0

  const shopProducts = (s: string) => products.get(s) ?? products.set(s, new Map()).get(s)!
  const shopBarcodes = (s: string) => barcodes.get(s) ?? barcodes.set(s, new Map()).get(s)!
  const iso = () => new Date(now()).toISOString()

  const view = (storeId: string, r: Rec): Product => ({
    ...r,
    barcodes: [...shopBarcodes(storeId)].filter(([, v]) => v.productId === r.id).map(([code, v]) => ({ code, packSize: v.packSize })),
    stockQty: stockOf(storeId, r.id),
  })
  const dupBarcode = (code: string) => new DomainError("duplicate_barcode", "এই বারকোড আরেকটি পণ্যে আছে", { code })

  // কোডগুলো অন্য পণ্যে আছে কি না যাচাই (নিজের পণ্য বাদে)
  function assertFree(storeId: string, productId: string, list: readonly ProductBarcode[]) {
    const book = shopBarcodes(storeId)
    for (const b of list) {
      const hit = book.get(b.code)
      if (hit && hit.productId !== productId) throw dupBarcode(b.code)
    }
  }

  return {
    setStockProvider(fn) {
      stockOf = fn
    },

    async createProduct(storeId, input: NewProduct) {
      const existing = shopProducts(storeId).get(input.id)
      if (existing) {
        const { id: _id, ...fields } = input
        const current = view(storeId, existing)
        if (!sameProductFields(current, fields)) throw new DomainError("id_conflict", "এই id দিয়ে ভিন্ন তথ্যের পণ্য আগেই আছে")
        return { product: current, created: false }
      }
      assertFree(storeId, input.id, input.barcodes)
      const t = iso()
      const { barcodes: list, ...rest } = input
      const rec: Rec = { ...rest, createdAt: t, updatedAt: t }
      shopProducts(storeId).set(input.id, rec)
      for (const b of list) shopBarcodes(storeId).set(b.code, { productId: input.id, packSize: b.packSize })
      return { product: view(storeId, rec), created: true }
    },

    async getProduct(storeId, id) {
      const r = shopProducts(storeId).get(id)
      return r ? view(storeId, r) : null
    },

    async listProducts(storeId, q) {
      const q0 = q.q?.toLowerCase()
      let list = [...shopProducts(storeId).values()].map((r) => view(storeId, r))
      if (q0) list = list.filter((p) => p.name.toLowerCase().includes(q0) || p.barcodes.some((b) => b.code === q.q))
      if (q.category !== undefined) list = list.filter((p) => p.category === q.category)
      if (q.barcode !== undefined) list = list.filter((p) => p.barcodes.some((b) => b.code === q.barcode))
      if (q.lowStock) list = list.filter((p) => p.stockQty <= p.minStock)
      list.sort((a, b) => (a.name === b.name ? (a.id < b.id ? -1 : 1) : a.name < b.name ? -1 : 1))
      const after = q.after
      if (after) list = list.filter((p) => p.name > after.name || (p.name === after.name && p.id > after.id))
      return { items: list.slice(0, q.limit), hasMore: list.length > q.limit }
    },

    async updateProduct(storeId, id, patch) {
      const rec = shopProducts(storeId).get(id)
      if (!rec) return null
      if (patch.expectedUpdatedAt !== undefined && Date.parse(patch.expectedUpdatedAt) !== Date.parse(rec.updatedAt)) {
        throw new DomainError("stale", "পণ্যটি অন্য জায়গা থেকে বদলেছে, আবার খুলে দেখুন", { updatedAt: rec.updatedAt })
      }
      if (patch.barcodes) assertFree(storeId, id, patch.barcodes)
      const { barcodes: newCodes, expectedUpdatedAt: _e, ...fields } = patch
      const next: Rec = { ...rec, ...fields, updatedAt: iso() }
      shopProducts(storeId).set(id, next)
      if (newCodes) {
        const book = shopBarcodes(storeId)
        for (const [code, v] of [...book]) if (v.productId === id) book.delete(code)
        for (const b of newCodes) book.set(b.code, { productId: id, packSize: b.packSize })
      }
      return view(storeId, next)
    },

    async addBarcode(storeId, productId, barcode) {
      const rec = shopProducts(storeId).get(productId)
      if (!rec) return null
      const hit = shopBarcodes(storeId).get(barcode.code)
      if (hit) {
        if (hit.productId === productId && hit.packSize === barcode.packSize) return { product: view(storeId, rec), created: false }
        throw dupBarcode(barcode.code)
      }
      shopBarcodes(storeId).set(barcode.code, { productId, packSize: barcode.packSize })
      const next: Rec = { ...rec, updatedAt: iso() }
      shopProducts(storeId).set(productId, next)
      return { product: view(storeId, next), created: true }
    },
  }
}
