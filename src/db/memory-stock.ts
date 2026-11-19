import { DomainError } from "../domain/errors.js"
import { matchesBatchStatus, planStockIn, type Batch, type StockInCommand } from "../domain/stock.js"
import type { Product } from "../domain/product.js"
import { NO_EXPIRY_KEY, type RemovalEntry, type StockRepo } from "./stock.js"
import type { CatalogRepo } from "./catalog.js"

// pg-stock.ts এর সমতুল্য ইন-মেমরি বাস্তবায়ন (টেস্টের জন্য)।
interface Move {
  id: string
  productId: string
  batchId: string
  qtyDelta: number
  kind: "purchase" | "removal"
}
interface Removed {
  at: string
  by: string
  reason: string
  qty: number
  movementId: string
}
type BatchRec = Batch & { removed?: Removed }

export interface MemoryStock extends StockRepo {
  qtyOf(storeId: string, productId: string): number
  /** বিক্রি-স্তর (sales) একই ব্যাচ ব্যবহার করে */
  internals: {
    /** সরানো হয়নি এমন ব্যাচ */
    liveBatches(storeId: string, productId: string): Batch[]
    isLive(storeId: string, batchId: string): boolean
    adjust(storeId: string, batchId: string, delta: number): void
    insert(storeId: string, batch: Batch): void
  }
}

export function createMemoryStock(deps: {
  now: () => number
  catalog: CatalogRepo & { setStockProvider(fn: (s: string, p: string) => number): void }
  userName: (storeId: string, userId: string) => string
}): MemoryStock {
  const batches = new Map<string, Map<string, BatchRec>>()
  const moves = new Map<string, Map<string, Move>>()
  const shop = <T>(m: Map<string, Map<string, T>>, s: string) => m.get(s) ?? m.set(s, new Map()).get(s)!
  const iso = () => new Date(deps.now()).toISOString()
  const live = (s: string) => [...shop(batches, s).values()].filter((b) => !b.removed)
  const strip = ({ removed: _r, ...b }: BatchRec): Batch => b
  const qtyOf = (s: string, p: string) => live(s).filter((b) => b.productId === p).reduce((n, b) => n + b.qtyRemaining, 0)
  deps.catalog.setStockProvider(qtyOf)

  async function removalOf(storeId: string, b: BatchRec): Promise<RemovalEntry> {
    const r = b.removed!
    const product = await deps.catalog.getProduct(storeId, b.productId)
    return {
      id: b.id,
      batchId: b.id,
      productId: b.productId,
      productName: product?.name ?? "মুছে ফেলা পণ্য",
      batchNo: b.batchNo,
      expiryDate: b.expiryDate,
      qty: r.qty,
      costPoisha: b.costPoisha,
      reason: r.reason,
      at: r.at,
      by: r.by,
    }
  }

  return {
    qtyOf,

    internals: {
      liveBatches: (s, p) => live(s).filter((b) => b.productId === p).map(strip),
      isLive: (s, id) => {
        const b = shop(batches, s).get(id)
        return b !== undefined && !b.removed
      },
      adjust(s, id, delta) {
        const b = shop(batches, s).get(id)
        if (b) shop(batches, s).set(id, { ...b, qtyRemaining: b.qtyRemaining + delta })
      },
      insert: (s, b) => void shop(batches, s).set(b.id, b),
    },

    async stockIn(storeId, userId, cmd: StockInCommand) {
      const product = await deps.catalog.getProduct(storeId, cmd.productId)
      if (!product) return null
      const plan = planStockIn(product, cmd)
      const prior = shop(moves, storeId).get(cmd.receiptId)
      if (prior) {
        if (prior.productId !== cmd.productId || prior.qtyDelta !== plan.pieces) {
          throw new DomainError("id_conflict", "এই রসিদ id দিয়ে ভিন্ন তথ্যের জমা আগেই আছে")
        }
        return { batch: strip(shop(batches, storeId).get(prior.batchId)!), product, created: false }
      }
      const book = shop(batches, storeId)
      const merge =
        plan.batchNo === ""
          ? undefined
          : live(storeId).find((b) => b.productId === product.id && b.batchNo === plan.batchNo && b.expiryDate === cmd.expiryDate)
      let batch: BatchRec
      if (merge) {
        batch = { ...merge, qtyRemaining: merge.qtyRemaining + plan.pieces, costPoisha: plan.costPerPiece }
      } else {
        batch = { id: cmd.batchId, productId: product.id, batchNo: plan.batchNo, expiryDate: cmd.expiryDate, qtyRemaining: plan.pieces, costPoisha: plan.costPerPiece, receivedAt: iso() }
      }
      book.set(batch.id, batch)
      shop(moves, storeId).set(cmd.receiptId, { id: cmd.receiptId, productId: product.id, batchId: batch.id, qtyDelta: plan.pieces, kind: "purchase" })
      await deps.catalog.updateProduct(storeId, product.id, { costPoisha: plan.costPerPiece, pricePoisha: plan.pricePoisha })
      const fresh = (await deps.catalog.getProduct(storeId, product.id)) as Product
      return { batch: strip(batch), product: fresh, created: true }
    },

    async listBatches(storeId, q) {
      let list = live(storeId).filter((b) => (q.productId === undefined || b.productId === q.productId) && matchesBatchStatus(b, q.status, q.today, q.expiringWithinDays))
      const key = (b: Batch) => b.expiryDate ?? NO_EXPIRY_KEY
      list.sort((a, b) => (key(a) === key(b) ? (a.id < b.id ? -1 : 1) : key(a) < key(b) ? -1 : 1))
      const after = q.after
      if (after) list = list.filter((b) => key(b) > after.key || (key(b) === after.key && b.id > after.id))
      return { items: list.slice(0, q.limit).map(strip), hasMore: list.length > q.limit }
    },

    async removeBatch(storeId, userId, batchId, input) {
      const b = shop(batches, storeId).get(batchId)
      if (!b) return null
      if (b.removed) return { removal: await removalOf(storeId, b), created: false }
      const qty = b.qtyRemaining
      const next: BatchRec = { ...b, qtyRemaining: 0, removed: { at: iso(), by: deps.userName(storeId, userId), reason: input.reason, qty, movementId: input.id } }
      shop(batches, storeId).set(b.id, next)
      if (qty !== 0) shop(moves, storeId).set(input.id, { id: input.id, productId: b.productId, batchId: b.id, qtyDelta: -qty, kind: "removal" })
      return { removal: await removalOf(storeId, next), created: true }
    },

    async listRemovals(storeId, range) {
      const gone = [...shop(batches, storeId).values()].filter((b) => b.removed && (!range.from || b.removed.at >= range.from) && (!range.to || b.removed.at <= range.to))
      gone.sort((a, b) => (a.removed!.at < b.removed!.at ? 1 : -1))
      const all = await Promise.all(gone.map((b) => removalOf(storeId, b)))
      return { items: all.slice(0, 500), totalLossPoisha: all.reduce((n, r) => n + r.qty * r.costPoisha, 0) }
    },
  }
}
