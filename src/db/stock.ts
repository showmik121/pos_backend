import type { Product } from "../domain/product.js"
import type { Batch, BatchStatus, StockInCommand } from "../domain/stock.js"

// স্টক (ব্যাচ) রিপোজিটরি অংশ। pg-stock.ts (আসল) ও memory-stock.ts (টেস্ট) একই আচরণ দেয়।
export interface BatchListQuery {
  productId?: string
  status?: BatchStatus
  expiringWithinDays: number
  /** ঢাকার আজকের তারিখ */
  today: string
  limit: number
  /** (মেয়াদের সাজানো-কী, id)-এর পরের পাতা; মেয়াদহীন = "9999-12-31" */
  after?: { key: string; id: string }
}

export interface RemovalEntry {
  id: string
  batchId: string
  productId: string
  productName: string
  batchNo: string
  expiryDate: string | null
  qty: number
  costPoisha: number
  reason: string
  at: string
  by: string
}

export const NO_EXPIRY_KEY = "9999-12-31"

export interface StockRepo {
  /** পণ্য না পেলে null; একই রসিদ আগে থাকলে created=false (ইডেমপোটেন্ট); ভিন্ন হলে id_conflict */
  stockIn(storeId: string, userId: string, cmd: StockInCommand): Promise<{ batch: Batch; product: Product; created: boolean } | null>
  listBatches(storeId: string, query: BatchListQuery): Promise<{ items: Batch[]; hasMore: boolean }>
  /** ব্যাচ না পেলে null; আগেই সরানো থাকলে created=false; কারণ ফাঁকা হলে (route-এ যাচাই হয়) */
  removeBatch(storeId: string, userId: string, batchId: string, input: { id: string; reason: string }): Promise<{ removal: RemovalEntry; created: boolean } | null>
  listRemovals(storeId: string, range: { from?: string; to?: string }): Promise<{ items: RemovalEntry[]; totalLossPoisha: number }>
}
