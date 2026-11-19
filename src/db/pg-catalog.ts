import type postgres from "postgres"
import { DomainError } from "../domain/errors.js"
import { escapeLike, sameProductFields, type NewProduct, type Product, type ProductBarcode, type ProductPatch } from "../domain/product.js"
import type { CatalogRepo } from "./catalog.js"

// PostgreSQL বাস্তবায়ন। প্রতিটি কাজ withStore ট্রানজ্যাকশনে (RLS-এর store_id বসানো), তবু ক্যোয়ারিতে
// store_id স্পষ্ট দেওয়া হয়েছে (PK ইনডেক্স ব্যবহারের জন্য ও দ্বিতীয় প্রতিরক্ষা হিসেবে)।
type Tx = postgres.TransactionSql
type WithStore = <T>(storeId: string, fn: (tx: Tx) => Promise<T>) => Promise<T>

interface Row {
  id: string
  name: string
  unit: Product["unit"]
  pack_size: number
  cost_price_poisha: string | number
  sell_price_poisha: string | number
  low_stock_threshold: number
  category: string
  is_open: boolean
  created_at: Date
  updated_at: Date
  stock_qty: string | number
}

const UNIQUE_VIOLATION = "23505"
const dupBarcode = (code?: string) =>
  new DomainError("duplicate_barcode", "এই বারকোড আরেকটি পণ্যে আছে", code ? { code } : undefined)

const SELECT = (tx: Tx) => tx`
  p.id, p.name, p.unit, p.pack_size, p.cost_price_poisha, p.sell_price_poisha, p.low_stock_threshold,
  coalesce(p.category, '') AS category, p.is_open, p.created_at, p.updated_at, s.qty AS stock_qty`
const STOCK_JOIN = (tx: Tx) => tx`
  LEFT JOIN LATERAL (
    SELECT coalesce(sum(b.qty_remaining), 0) AS qty FROM stock_batches b
    WHERE b.store_id = p.store_id AND b.product_id = p.id AND b.removed_at IS NULL
  ) s ON true`

function toProduct(r: Row, barcodes: ProductBarcode[]): Product {
  return {
    id: r.id,
    name: r.name,
    unit: r.unit,
    cartonSize: r.pack_size,
    costPoisha: Number(r.cost_price_poisha ?? 0),
    pricePoisha: Number(r.sell_price_poisha),
    minStock: r.low_stock_threshold,
    category: r.category,
    open: r.is_open,
    barcodes,
    stockQty: Number(r.stock_qty),
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  }
}

async function barcodesOf(tx: Tx, storeId: string, ids: string[]): Promise<Map<string, ProductBarcode[]>> {
  const map = new Map<string, ProductBarcode[]>(ids.map((id) => [id, []]))
  if (ids.length === 0) return map
  const rows = await tx<{ product_id: string; code: string; pack_size: number }[]>`
    SELECT product_id, code, pack_size FROM product_barcodes
    WHERE store_id = ${storeId} AND product_id IN ${tx(ids)} ORDER BY code`
  for (const r of rows) map.get(r.product_id)?.push({ code: r.code, packSize: r.pack_size })
  return map
}

async function readOne(tx: Tx, storeId: string, id: string, lock = false): Promise<Product | null> {
  if (lock) {
    const held = await tx`SELECT 1 FROM products WHERE store_id = ${storeId} AND id = ${id} FOR UPDATE`
    if (held.length === 0) return null
  }
  const rows = await tx<Row[]>`
    SELECT ${SELECT(tx)} FROM products p ${STOCK_JOIN(tx)} WHERE p.store_id = ${storeId} AND p.id = ${id}`
  const row = rows[0]
  if (!row) return null
  return toProduct(row, (await barcodesOf(tx, storeId, [id])).get(id) ?? [])
}

/** এই কোডগুলোর মধ্যে অন্য পণ্যে থাকা কোনোটি থাকলে duplicate_barcode */
async function assertBarcodesFree(tx: Tx, storeId: string, productId: string, list: readonly ProductBarcode[]) {
  if (list.length === 0) return
  const hit = await tx<{ code: string }[]>`
    SELECT code FROM product_barcodes
    WHERE store_id = ${storeId} AND code IN ${tx(list.map((b) => b.code))} AND product_id <> ${productId} LIMIT 1`
  if (hit[0]) throw dupBarcode(hit[0].code)
}

async function insertBarcodes(tx: Tx, storeId: string, productId: string, list: readonly ProductBarcode[]) {
  for (const b of list) {
    await tx`INSERT INTO product_barcodes (store_id, code, product_id, pack_size) VALUES (${storeId}, ${b.code}, ${productId}, ${b.packSize})`
  }
}

/** সমান্তরাল অনুরোধে আগে-পরে-যাচাই এড়িয়ে গেলে ডাটাবেসের unique ধরে ফেলে */
function mapUnique(err: unknown): unknown {
  const e = err as { code?: string; constraint_name?: string } | null
  if (e?.code === UNIQUE_VIOLATION && e.constraint_name === "product_barcodes_pkey") return dupBarcode()
  return err
}

const COLUMN: Record<string, string> = {
  name: "name",
  unit: "unit",
  cartonSize: "pack_size",
  costPoisha: "cost_price_poisha",
  pricePoisha: "sell_price_poisha",
  minStock: "low_stock_threshold",
  category: "category",
  open: "is_open",
}

export function createPgCatalog(withStore: WithStore): CatalogRepo {
  return {
    createProduct: (storeId, input: NewProduct) =>
      withStore(storeId, async (tx) => {
        // একই id-র দুটি সমান্তরাল তৈরি ক্রমে চলে (দ্বিতীয়টি আগেরটা দেখে ইডেমপোটেন্ট উত্তর পায়)
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`product:${storeId}:${input.id}`}, 0))`
        const existing = await readOne(tx, storeId, input.id)
        if (existing) {
          const { id: _id, ...fields } = input
          if (!sameProductFields(existing, fields)) throw new DomainError("id_conflict", "এই id দিয়ে ভিন্ন তথ্যের পণ্য আগেই আছে")
          return { product: existing, created: false }
        }
        try {
          await assertBarcodesFree(tx, storeId, input.id, input.barcodes)
          await tx`
            INSERT INTO products (id, store_id, name, unit, pack_size, cost_price_poisha, sell_price_poisha,
                                  low_stock_threshold, category, is_open, updated_at)
            VALUES (${input.id}, ${storeId}, ${input.name}, ${input.unit}, ${input.cartonSize}, ${input.costPoisha},
                    ${input.pricePoisha}, ${input.minStock}, ${input.category}, ${input.open},
                    date_trunc('milliseconds', now()))`
          await insertBarcodes(tx, storeId, input.id, input.barcodes)
        } catch (err) {
          throw mapUnique(err)
        }
        return { product: (await readOne(tx, storeId, input.id))!, created: true }
      }),

    getProduct: (storeId, id) => withStore(storeId, (tx) => readOne(tx, storeId, id)),

    listProducts: (storeId, q) =>
      withStore(storeId, async (tx) => {
        const hasCode = (code: string) =>
          tx`EXISTS (SELECT 1 FROM product_barcodes pb WHERE pb.store_id = p.store_id AND pb.product_id = p.id AND pb.code = ${code})`
        const rows = await tx<Row[]>`
          SELECT ${SELECT(tx)} FROM products p ${STOCK_JOIN(tx)}
          WHERE p.store_id = ${storeId}
          ${q.category !== undefined ? tx`AND coalesce(p.category, '') = ${q.category}` : tx``}
          ${q.q !== undefined ? tx`AND (p.name ILIKE ${`%${escapeLike(q.q)}%`} OR ${hasCode(q.q)})` : tx``}
          ${q.barcode !== undefined ? tx`AND ${hasCode(q.barcode)}` : tx``}
          ${q.lowStock ? tx`AND s.qty <= p.low_stock_threshold` : tx``}
          ${q.after ? tx`AND (p.name, p.id) > (${q.after.name}, ${q.after.id}::uuid)` : tx``}
          ORDER BY p.name, p.id
          LIMIT ${q.limit + 1}`
        const page = rows.slice(0, q.limit)
        const codes = await barcodesOf(tx, storeId, page.map((r: Row) => r.id))
        return { items: page.map((r: Row) => toProduct(r, codes.get(r.id) ?? [])), hasMore: rows.length > q.limit }
      }),

    updateProduct: (storeId, id, patch: ProductPatch) =>
      withStore(storeId, async (tx) => {
        const current = await readOne(tx, storeId, id, true)
        if (!current) return null
        if (patch.expectedUpdatedAt !== undefined && Date.parse(patch.expectedUpdatedAt) !== Date.parse(current.updatedAt)) {
          throw new DomainError("stale", "পণ্যটি অন্য জায়গা থেকে বদলেছে, আবার খুলে দেখুন", { updatedAt: current.updatedAt })
        }
        try {
          if (patch.barcodes) await assertBarcodesFree(tx, storeId, id, patch.barcodes)
          const set: Record<string, unknown> = {}
          for (const [key, col] of Object.entries(COLUMN)) {
            const v = (patch as Record<string, unknown>)[key]
            if (v !== undefined) set[col] = v
          }
          if (Object.keys(set).length > 0) {
            await tx`UPDATE products SET ${tx(set)}, updated_at = date_trunc('milliseconds', now()) WHERE store_id = ${storeId} AND id = ${id}`
          } else {
            await tx`UPDATE products SET updated_at = date_trunc('milliseconds', now()) WHERE store_id = ${storeId} AND id = ${id}`
          }
          if (patch.barcodes) {
            await tx`DELETE FROM product_barcodes WHERE store_id = ${storeId} AND product_id = ${id}`
            await insertBarcodes(tx, storeId, id, patch.barcodes)
          }
        } catch (err) {
          throw mapUnique(err)
        }
        return readOne(tx, storeId, id)
      }),

    addBarcode: (storeId, productId, barcode) =>
      withStore(storeId, async (tx) => {
        const current = await readOne(tx, storeId, productId, true)
        if (!current) return null
        const hit = await tx<{ product_id: string; pack_size: number }[]>`
          SELECT product_id, pack_size FROM product_barcodes WHERE store_id = ${storeId} AND code = ${barcode.code}`
        if (hit[0]) {
          if (hit[0].product_id === productId && hit[0].pack_size === barcode.packSize) return { product: current, created: false }
          throw dupBarcode(barcode.code)
        }
        try {
          await insertBarcodes(tx, storeId, productId, [barcode])
        } catch (err) {
          throw mapUnique(err)
        }
        await tx`UPDATE products SET updated_at = date_trunc('milliseconds', now()) WHERE store_id = ${storeId} AND id = ${productId}`
        return { product: (await readOne(tx, storeId, productId))!, created: true }
      }),
  }
}
