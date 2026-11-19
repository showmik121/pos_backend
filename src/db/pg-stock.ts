import type postgres from "postgres"
import { DomainError } from "../domain/errors.js"
import { planStockIn, type Batch } from "../domain/stock.js"
import { readOne } from "./pg-catalog.js"
import { NO_EXPIRY_KEY, type RemovalEntry, type StockRepo } from "./stock.js"

type Tx = postgres.TransactionSql
type WithStore = <T>(storeId: string, fn: (tx: Tx) => Promise<T>) => Promise<T>

interface BatchRow {
  id: string
  product_id: string
  batch_no: string
  expiry_date: string | null
  qty_remaining: number
  cost_price_poisha: string | number | null
  received_at: Date
}

interface RemovalRow {
  id: string
  product_id: string
  product_name: string | null
  batch_no: string
  expiry_date: string | null
  cost_price_poisha: string | number | null
  removed_reason: string
  removed_at: Date
  by_name: string | null
  qty: string | number | null
}

const UNIQUE_VIOLATION = "23505"
const BATCH_COLS = (tx: Tx) => tx`
  b.id, b.product_id, b.batch_no, to_char(b.expiry_date, 'YYYY-MM-DD') AS expiry_date,
  b.qty_remaining, b.cost_price_poisha, b.received_at`

const toBatch = (r: BatchRow): Batch => ({
  id: r.id,
  productId: r.product_id,
  batchNo: r.batch_no,
  expiryDate: r.expiry_date,
  qtyRemaining: Number(r.qty_remaining),
  costPoisha: Number(r.cost_price_poisha ?? 0),
  receivedAt: r.received_at.toISOString(),
})

const toRemoval = (r: RemovalRow): RemovalEntry => ({
  id: r.id,
  batchId: r.id,
  productId: r.product_id,
  productName: r.product_name ?? "মুছে ফেলা পণ্য",
  batchNo: r.batch_no,
  expiryDate: r.expiry_date,
  qty: Number(r.qty ?? 0),
  costPoisha: Number(r.cost_price_poisha ?? 0),
  reason: r.removed_reason,
  at: r.removed_at.toISOString(),
  by: r.by_name ?? "অজানা",
})

/** একই দোকানের একই পণ্যের স্টক-বদল এক এক করে চলে (ট্রানজ্যাকশন শেষে ছাড়ে) */
const lockProduct = (tx: Tx, storeId: string, productId: string) =>
  tx`SELECT pg_advisory_xact_lock(hashtextextended(${`stock:${storeId}:${productId}`}, 0))`

const conflict = (err: unknown): unknown =>
  (err as { code?: string } | null)?.code === UNIQUE_VIOLATION
    ? new DomainError("id_conflict", "এই id আগেই অন্য কাজে ব্যবহার হয়েছে")
    : err

async function readBatch(tx: Tx, storeId: string, id: string): Promise<Batch | null> {
  const rows = await tx<BatchRow[]>`SELECT ${BATCH_COLS(tx)} FROM stock_batches b WHERE b.store_id = ${storeId} AND b.id = ${id}`
  return rows[0] ? toBatch(rows[0]) : null
}

async function readRemoval(tx: Tx, storeId: string, batchId: string): Promise<RemovalEntry> {
  const rows = await tx<RemovalRow[]>`
    SELECT b.id, b.product_id, p.name AS product_name, b.batch_no, to_char(b.expiry_date, 'YYYY-MM-DD') AS expiry_date,
           b.cost_price_poisha, b.removed_reason, b.removed_at, u.name AS by_name, -m.qty_delta AS qty
    FROM stock_batches b
    LEFT JOIN products p ON p.store_id = b.store_id AND p.id = b.product_id
    LEFT JOIN users u ON u.store_id = b.store_id AND u.id = b.removed_by
    LEFT JOIN stock_movements m ON m.store_id = b.store_id AND m.batch_id = b.id AND m.kind = 'removal'
    WHERE b.store_id = ${storeId} AND b.id = ${batchId}`
  return toRemoval(rows[0]!)
}

export function createPgStock(withStore: WithStore): StockRepo {
  return {
    async stockIn(storeId, userId, cmd) {
      return withStore(storeId, async (tx) => {
        await lockProduct(tx, storeId, cmd.productId)
        const product = await readOne(tx, storeId, cmd.productId)
        if (!product) return null
        const plan = planStockIn(product, cmd)

        const prior = await tx<{ product_id: string; batch_id: string | null; qty_delta: number; kind: string }[]>`
          SELECT product_id, batch_id, qty_delta, kind FROM stock_movements WHERE store_id = ${storeId} AND id = ${cmd.receiptId}`
        const seen = prior[0]
        if (seen) {
          if (seen.product_id !== cmd.productId || seen.kind !== "purchase" || seen.qty_delta !== plan.pieces || !seen.batch_id) {
            throw new DomainError("id_conflict", "এই রসিদ id দিয়ে ভিন্ন তথ্যের জমা আগেই আছে")
          }
          const batch = await readBatch(tx, storeId, seen.batch_id)
          return { batch: batch!, product, created: false }
        }

        let batchId: string | null = null
        if (plan.batchNo !== "") {
          const found = await tx<{ id: string }[]>`
            SELECT id FROM stock_batches
            WHERE store_id = ${storeId} AND product_id = ${cmd.productId} AND batch_no = ${plan.batchNo}
              AND coalesce(expiry_date, ${NO_EXPIRY_KEY}::date) = coalesce(${cmd.expiryDate}::date, ${NO_EXPIRY_KEY}::date)
              AND removed_at IS NULL
            FOR UPDATE`
          batchId = found[0]?.id ?? null
        }
        try {
          if (batchId) {
            await tx`
              UPDATE stock_batches SET qty_remaining = qty_remaining + ${plan.pieces}, cost_price_poisha = ${plan.costPerPiece}
              WHERE store_id = ${storeId} AND id = ${batchId}`
          } else {
            batchId = cmd.batchId
            await tx`
              INSERT INTO stock_batches (id, store_id, product_id, batch_no, expiry_date, qty_remaining, cost_price_poisha)
              VALUES (${batchId}, ${storeId}, ${cmd.productId}, ${plan.batchNo}, ${cmd.expiryDate}::date, ${plan.pieces}, ${plan.costPerPiece})`
          }
          await tx`
            INSERT INTO stock_movements (id, store_id, product_id, batch_id, kind, qty_delta, created_by)
            VALUES (${cmd.receiptId}, ${storeId}, ${cmd.productId}, ${batchId}, 'purchase', ${plan.pieces}, ${userId})`
        } catch (err) {
          throw conflict(err)
        }
        await tx`
          UPDATE products
          SET cost_price_poisha = ${plan.costPerPiece}, sell_price_poisha = ${plan.pricePoisha},
              updated_at = date_trunc('milliseconds', now())
          WHERE store_id = ${storeId} AND id = ${cmd.productId}`
        const fresh = await readOne(tx, storeId, cmd.productId)
        const batch = await readBatch(tx, storeId, batchId)
        return { batch: batch!, product: fresh!, created: true }
      })
    },

    async listBatches(storeId, q) {
      return withStore(storeId, async (tx) => {
        const byProduct = q.productId ? tx`AND b.product_id = ${q.productId}` : tx``
        const upTo = new Date(Date.parse(`${q.today}T00:00:00Z`) + q.expiringWithinDays * 86_400_000).toISOString().slice(0, 10)
        const byStatus =
          q.status === "expired"
            ? tx`AND b.expiry_date IS NOT NULL AND b.expiry_date <= ${q.today}::date`
            : q.status === "active"
              ? tx`AND b.qty_remaining > 0 AND (b.expiry_date IS NULL OR b.expiry_date > ${q.today}::date)`
              : q.status === "expiring"
                ? tx`AND b.expiry_date IS NOT NULL AND b.expiry_date > ${q.today}::date AND b.expiry_date <= ${upTo}::date`
                : tx``
        const after = q.after
          ? tx`AND (coalesce(b.expiry_date, ${NO_EXPIRY_KEY}::date), b.id) > (${q.after.key}::date, ${q.after.id}::uuid)`
          : tx``
        const rows = await tx<BatchRow[]>`
          SELECT ${BATCH_COLS(tx)} FROM stock_batches b
          WHERE b.store_id = ${storeId} AND b.removed_at IS NULL ${byProduct} ${byStatus} ${after}
          ORDER BY coalesce(b.expiry_date, ${NO_EXPIRY_KEY}::date), b.id
          LIMIT ${q.limit + 1}`
        return { items: rows.slice(0, q.limit).map(toBatch), hasMore: rows.length > q.limit }
      })
    },

    async removeBatch(storeId, userId, batchId, input) {
      return withStore(storeId, async (tx) => {
        const peek = await tx<{ product_id: string }[]>`SELECT product_id FROM stock_batches WHERE store_id = ${storeId} AND id = ${batchId}`
        if (!peek[0]) return null
        await lockProduct(tx, storeId, peek[0].product_id)
        const rows = await tx<{ product_id: string; qty_remaining: number; removed_at: Date | null }[]>`
          SELECT product_id, qty_remaining, removed_at FROM stock_batches WHERE store_id = ${storeId} AND id = ${batchId} FOR UPDATE`
        const b = rows[0]!
        if (b.removed_at) return { removal: await readRemoval(tx, storeId, batchId), created: false }
        try {
          await tx`
            UPDATE stock_batches SET qty_remaining = 0, removed_at = now(), removed_by = ${userId}, removed_reason = ${input.reason}
            WHERE store_id = ${storeId} AND id = ${batchId}`
          if (b.qty_remaining !== 0) {
            await tx`
              INSERT INTO stock_movements (id, store_id, product_id, batch_id, kind, qty_delta, note, created_by)
              VALUES (${input.id}, ${storeId}, ${b.product_id}, ${batchId}, 'removal', ${-b.qty_remaining}, ${input.reason}, ${userId})`
          }
        } catch (err) {
          throw conflict(err)
        }
        return { removal: await readRemoval(tx, storeId, batchId), created: true }
      })
    },

    async listRemovals(storeId, range) {
      return withStore(storeId, async (tx) => {
        const from = range.from ? tx`AND b.removed_at >= ${range.from}::timestamptz` : tx``
        const to = range.to ? tx`AND b.removed_at <= ${range.to}::timestamptz` : tx``
        const rows = await tx<RemovalRow[]>`
          SELECT b.id, b.product_id, p.name AS product_name, b.batch_no, to_char(b.expiry_date, 'YYYY-MM-DD') AS expiry_date,
                 b.cost_price_poisha, b.removed_reason, b.removed_at, u.name AS by_name, -m.qty_delta AS qty
          FROM stock_batches b
          LEFT JOIN products p ON p.store_id = b.store_id AND p.id = b.product_id
          LEFT JOIN users u ON u.store_id = b.store_id AND u.id = b.removed_by
          LEFT JOIN stock_movements m ON m.store_id = b.store_id AND m.batch_id = b.id AND m.kind = 'removal'
          WHERE b.store_id = ${storeId} AND b.removed_at IS NOT NULL ${from} ${to}
          ORDER BY b.removed_at DESC, b.id
          LIMIT 500`
        const total = await tx<{ loss: string | number }[]>`
          SELECT coalesce(sum(coalesce(-m.qty_delta, 0) * coalesce(b.cost_price_poisha, 0)), 0) AS loss
          FROM stock_batches b
          LEFT JOIN stock_movements m ON m.store_id = b.store_id AND m.batch_id = b.id AND m.kind = 'removal'
          WHERE b.store_id = ${storeId} AND b.removed_at IS NOT NULL ${from} ${to}`
        return { items: rows.map(toRemoval), totalLossPoisha: Number(total[0]?.loss ?? 0) }
      })
    },
  }
}
