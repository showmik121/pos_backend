import { randomUUID } from "node:crypto"
import { DomainError } from "../domain/errors.js"
import type { LedgerEntry } from "../domain/dues.js"
import { planSale, planVoid, type BatchInfo, type ProductInfo, type SaleRecord } from "../domain/sales.js"
import type { CatalogRepo } from "./catalog.js"
import type { SalesRepo } from "./sales.js"
import type { MemoryDues } from "./memory-dues.js"
import type { MemoryStock } from "./memory-stock.js"

// pg-sales.ts এর সমতুল্য ইন-মেমরি বাস্তবায়ন (টেস্টের জন্য)।
interface Rec {
  sale: SaleRecord
  hash: string
}

export function createMemorySales(deps: {
  now: () => number
  catalog: CatalogRepo
  stock: MemoryStock
  dues: MemoryDues
  userName: (storeId: string, userId: string) => string
}): SalesRepo {
  const books = new Map<string, Map<string, Rec>>()
  const book = (s: string) => books.get(s) ?? books.set(s, new Map()).get(s)!
  const iso = () => new Date(deps.now()).toISOString()
  const { stock, dues } = deps

  const batchInfo = (b: { id: string; batchNo: string; expiryDate: string | null; qtyRemaining: number; costPoisha: number; receivedAt: string }): BatchInfo => b
  const newestFirst = (a: SaleRecord, b: SaleRecord) => (a.at === b.at ? (a.id < b.id ? 1 : -1) : a.at < b.at ? 1 : -1)

  return {
    async createSale(storeId, userId, cmd, opts) {
      const prior = book(storeId).get(cmd.id)
      if (prior) {
        if (prior.hash !== opts.hash) throw new DomainError("id_conflict", "এই id দিয়ে ভিন্ন তথ্যের বিল আগেই আছে")
        return { sale: prior.sale, created: false }
      }
      const clash = [...book(storeId).values()].some((r) => r.sale.no === cmd.no && (r.sale.prefix ?? "") === (cmd.prefix ?? ""))
      if (clash) throw new DomainError("duplicate_bill_no", "এই বিল নম্বরে আরেকটি বিল আছে")
      const customer = cmd.customerId ? dues.internals.customers(storeId).get(cmd.customerId) : undefined
      if (cmd.customerId && !customer) throw new DomainError("not_found", "কাস্টমার পাওয়া যায়নি")

      const products = new Map<string, ProductInfo>()
      const batches = new Map<string, BatchInfo[]>()
      for (const l of cmd.lines) {
        const p = await deps.catalog.getProduct(storeId, l.productId)
        if (!p) throw new DomainError("not_found", "বিলের একটি পণ্য পাওয়া যায়নি")
        products.set(p.id, { id: p.id, name: p.name, pricePoisha: p.pricePoisha, costPoisha: p.costPoisha })
        batches.set(p.id, stock.internals.liveBatches(storeId, p.id).map(batchInfo))
      }
      const plan = planSale(cmd, products, batches, customer !== undefined, opts.today, randomUUID)

      // পরিকল্পনা পাস: এবার স্টক বদল (এর মাঝে ব্যর্থ হওয়ার আর কিছু নেই)
      const batchNos = new Map<string, string>()
      for (const line of plan.lines) {
        for (const a of line.allocations) {
          if (a.createBatch) {
            const cost = products.get(line.productId)!.costPoisha
            stock.internals.insert(storeId, { id: a.batchId, productId: line.productId, batchNo: "", expiryDate: null, qtyRemaining: 0, costPoisha: cost, receivedAt: iso() })
          }
          stock.internals.adjust(storeId, a.batchId, -a.qty)
          batchNos.set(a.batchId, a.batchNo)
        }
      }
      const at = cmd.offline && cmd.at ? cmd.at : iso()
      const sale: SaleRecord = {
        id: cmd.id,
        no: cmd.no,
        prefix: cmd.prefix,
        at,
        cashier: deps.userName(storeId, userId),
        lines: plan.lines.map((l) => ({ ...l, allocations: l.allocations.map(({ createBatch: _c, ...a }) => a) })),
        subtotal: plan.subtotal,
        lineDiscount: plan.lineDiscount,
        billDiscount: plan.billDiscount,
        total: plan.total,
        payments: plan.payments,
        change: plan.change,
        due: plan.due,
        customerId: customer?.id ?? null,
        customerName: customer?.name ?? null,
        oversold: plan.oversold,
      }
      if (plan.due > 0 && customer) {
        const entry: LedgerEntry = { id: randomUUID(), customerId: customer.id, kind: "sale", amountPoisha: plan.due, saleId: sale.id, method: null, at: iso(), by: sale.cashier }
        dues.internals.ledger(storeId).push(entry)
      }
      book(storeId).set(sale.id, { sale, hash: opts.hash })
      return { sale, created: true }
    },

    async getSale(storeId, id) {
      return book(storeId).get(id)?.sale ?? null
    },

    async listSales(storeId, q) {
      let list = [...book(storeId).values()]
        .map((r) => r.sale)
        .filter((s) => (!q.from || s.at >= q.from) && (!q.to || s.at <= q.to) && (!q.customerId || s.customerId === q.customerId))
      list.sort(newestFirst)
      const after = q.after
      if (after) list = list.filter((s) => s.at < after.at || (s.at === after.at && s.id < after.id))
      return { items: list.slice(0, q.limit), hasMore: list.length > q.limit }
    },

    async voidSale(storeId, userId, saleId, reason) {
      const rec = book(storeId).get(saleId)
      if (!rec) return null
      if (rec.sale.voided) throw new DomainError("already_voided", "এই বিল আগেই বাতিল হয়েছে")
      const sale = rec.sale
      const balance = sale.customerId ? dues.internals.balance(storeId, sale.customerId) : 0
      const live = new Set<string>()
      for (const l of sale.lines) for (const a of l.allocations) if (stock.internals.isLive(storeId, a.batchId)) live.add(a.batchId)
      const plan = planVoid(sale, live, balance)
      for (const r of plan.restores) stock.internals.adjust(storeId, r.batchId, r.qty)
      const by = deps.userName(storeId, userId)
      if (plan.dueReversed > 0 && sale.customerId) {
        dues.internals.ledger(storeId).push({ id: randomUUID(), customerId: sale.customerId, kind: "void", amountPoisha: plan.dueReversed, saleId: sale.id, method: null, at: iso(), by })
      }
      const voided: SaleRecord = { ...sale, voided: { at: iso(), by, reason } }
      book(storeId).set(saleId, { ...rec, sale: voided })
      return { sale: voided, restoredQty: plan.restoredQty, lostQty: plan.lostQty, refundPoisha: plan.refundPoisha }
    },
  }
}
