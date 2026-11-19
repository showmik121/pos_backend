import { randomUUID } from "node:crypto"
import type postgres from "postgres"
import { DomainError } from "../domain/errors.js"
import { signedAmount } from "../domain/dues.js"
import type { Payment } from "../domain/cart.js"
import { planSale, planVoid, type BatchInfo, type ProductInfo, type SaleLineRec, type SaleRecord } from "../domain/sales.js"
import type { SalesRepo } from "./sales.js"

type Tx = postgres.TransactionSql
type WithStore = <T>(storeId: string, fn: (tx: Tx) => Promise<T>) => Promise<T>

interface SaleRow {
  id: string
  bill_no: number
  bill_prefix: string | null
  sold_at: Date
  cashier: string | null
  subtotal_poisha: string | number
  line_discount_poisha: string | number
  bill_discount_poisha: string | number
  total_poisha: string | number
  change_poisha: string | number
  due_poisha: string | number
  customer_id: string | null
  customer_name: string | null
  oversold: boolean
  voided: boolean
  voided_at: Date | null
  voided_by_name: string | null
  void_reason: string | null
  request_hash: string
}

interface ItemRow {
  id: string
  sale_id: string
  product_id: string
  product_name: string
  qty: number
  unit_price_poisha: string | number
  discount_poisha: string | number
}

interface AllocRow {
  sale_item_id: string
  batch_id: string
  batch_no: string
  qty: number
  oversold_qty: number
  cost_poisha: string | number
}

interface PaymentRow {
  sale_id: string
  method: Payment["method"]
  amount_poisha: string | number
}

const UNIQUE_VIOLATION = "23505"

const SALE_SELECT = (tx: Tx) => tx`
  SELECT s.id, s.bill_no, s.bill_prefix, s.sold_at, coalesce(cu.name, s.cashier_name) AS cashier,
         s.subtotal_poisha, s.line_discount_poisha, s.bill_discount_poisha, s.total_poisha, s.change_poisha, s.due_poisha,
         s.customer_id, c.name AS customer_name, s.oversold, s.voided, s.voided_at, coalesce(vu.name, s.voided_by_name) AS voided_by_name, s.void_reason, s.request_hash
  FROM sales s
  LEFT JOIN users cu ON cu.store_id = s.store_id AND cu.id = s.created_by
  LEFT JOIN users vu ON vu.store_id = s.store_id AND vu.id = s.voided_by
  LEFT JOIN customers c ON c.store_id = s.store_id AND c.id = s.customer_id`

/** সারিগুলো থেকে পুরো বিল (লাইন, ব্যাচ-ভাগ, পেমেন্টসহ) জোড়া লাগায়; ক্রম rows-এর ক্রমেই থাকে */
async function assemble(tx: Tx, storeId: string, rows: SaleRow[]): Promise<SaleRecord[]> {
  if (rows.length === 0) return []
  const ids = rows.map((r: SaleRow) => r.id)
  const items = await tx<ItemRow[]>`
    SELECT id, sale_id, product_id, product_name, qty, unit_price_poisha, discount_poisha
    FROM sale_items WHERE store_id = ${storeId} AND sale_id IN ${tx(ids)} ORDER BY sale_id, line_no`
  const allocs = items.length
    ? await tx<AllocRow[]>`
        SELECT a.sale_item_id, a.batch_id, b.batch_no, a.qty, a.oversold_qty, a.cost_poisha
        FROM sale_allocations a JOIN stock_batches b ON b.store_id = a.store_id AND b.id = a.batch_id
        WHERE a.store_id = ${storeId} AND a.sale_item_id IN ${tx(items.map((i: ItemRow) => i.id))} ORDER BY a.sale_item_id, a.seq`
    : []
  const pays = await tx<PaymentRow[]>`
    SELECT sale_id, method, amount_poisha FROM payments WHERE store_id = ${storeId} AND sale_id IN ${tx(ids)} ORDER BY sale_id, seq`

  return rows.map((r): SaleRecord => {
    const lines: SaleLineRec[] = items
      .filter((i: ItemRow) => i.sale_id === r.id)
      .map((i: ItemRow) => ({
        productId: i.product_id,
        name: i.product_name,
        qty: Number(i.qty),
        unitPrice: Number(i.unit_price_poisha),
        discount: Number(i.discount_poisha),
        allocations: allocs
          .filter((a: AllocRow) => a.sale_item_id === i.id)
          .map((a: AllocRow) => ({ batchId: a.batch_id, batchNo: a.batch_no, qty: Number(a.qty), oversoldQty: Number(a.oversold_qty), costPoisha: Number(a.cost_poisha) })),
      }))
    const sale: SaleRecord = {
      id: r.id,
      no: r.bill_no,
      prefix: r.bill_prefix,
      at: r.sold_at.toISOString(),
      cashier: r.cashier ?? "অজানা",
      lines,
      subtotal: Number(r.subtotal_poisha),
      lineDiscount: Number(r.line_discount_poisha),
      billDiscount: Number(r.bill_discount_poisha),
      total: Number(r.total_poisha),
      payments: pays.filter((p: PaymentRow) => p.sale_id === r.id).map((p: PaymentRow) => ({ method: p.method, amount: Number(p.amount_poisha) })),
      change: Number(r.change_poisha),
      due: Number(r.due_poisha),
      customerId: r.customer_id,
      customerName: r.customer_name,
      oversold: r.oversold,
    }
    if (r.voided && r.voided_at) sale.voided = { at: r.voided_at.toISOString(), by: r.voided_by_name ?? "অজানা", reason: r.void_reason ?? "" }
    return sale
  })
}

async function readSale(tx: Tx, storeId: string, id: string): Promise<{ sale: SaleRecord; hash: string } | null> {
  const rows = await tx<SaleRow[]>`${SALE_SELECT(tx)} WHERE s.store_id = ${storeId} AND s.id = ${id}`
  const row = rows[0]
  if (!row) return null
  const [sale] = await assemble(tx, storeId, rows)
  return { sale: sale!, hash: row.request_hash }
}

const lockKey = (tx: Tx, key: string) => tx`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`
/** পণ্যের স্টক-বদল ক্রমে চলে (pg-stock.ts এর stockIn-এর একই কী) */
export async function lockProducts(tx: Tx, storeId: string, productIds: readonly string[]) {
  for (const id of [...productIds].sort()) await lockKey(tx, `stock:${storeId}:${id}`)
}

export function createPgSales(withStore: WithStore): SalesRepo {
  return {
    createSale: (storeId, userId, cmd, opts) =>
      withStore(storeId, async (tx) => {
        // লক-ক্রম (void-এর সাথে এক): বিল → পণ্য (id ক্রমে) → ব্যাচ-সারি (পণ্য, id ক্রমে) → কাস্টমার-সারি
        await lockKey(tx, `sale:${storeId}:${cmd.id}`)
        const prior = await readSale(tx, storeId, cmd.id)
        if (prior) {
          if (prior.hash !== opts.hash) throw new DomainError("id_conflict", "এই id দিয়ে ভিন্ন তথ্যের বিল আগেই আছে")
          return { sale: prior.sale, created: false }
        }
        const clash = await tx`
          SELECT 1 FROM sales WHERE store_id = ${storeId} AND coalesce(bill_prefix, '') = ${cmd.prefix ?? ""} AND bill_no = ${cmd.no}`
        if (clash.length) throw new DomainError("duplicate_bill_no", "এই বিল নম্বরে আরেকটি বিল আছে")

        const productIds = cmd.lines.map((l) => l.productId)
        await lockProducts(tx, storeId, productIds)
        const productRows = await tx<{ id: string; name: string; price: string | number; cost: string | number | null }[]>`
          SELECT id, name, sell_price_poisha AS price, cost_price_poisha AS cost
          FROM products WHERE store_id = ${storeId} AND id IN ${tx(productIds)}`
        const products = new Map<string, ProductInfo>(
          productRows.map((p: { id: string; name: string; price: string | number; cost: string | number | null }) => [p.id, { id: p.id, name: p.name, pricePoisha: Number(p.price), costPoisha: Number(p.cost ?? 0) }]),
        )
        const batchRows = await tx<
          { id: string; product_id: string; batch_no: string; expiry_date: string | null; qty_remaining: number; cost: string | number | null; received_at: Date }[]
        >`
          SELECT id, product_id, batch_no, to_char(expiry_date, 'YYYY-MM-DD') AS expiry_date, qty_remaining,
                 cost_price_poisha AS cost, received_at
          FROM stock_batches
          WHERE store_id = ${storeId} AND product_id IN ${tx(productIds)} AND removed_at IS NULL
          ORDER BY product_id, id FOR UPDATE`
        const batches = new Map<string, BatchInfo[]>()
        for (const b of batchRows) {
          const list = batches.get(b.product_id) ?? []
          list.push({ id: b.id, batchNo: b.batch_no, expiryDate: b.expiry_date, qtyRemaining: Number(b.qty_remaining), costPoisha: Number(b.cost ?? 0), receivedAt: b.received_at.toISOString() })
          batches.set(b.product_id, list)
        }

        let customer: { id: string; name: string } | undefined
        if (cmd.customerId) {
          const rows = await tx<{ id: string; name: string }[]>`
            SELECT id, name FROM customers WHERE store_id = ${storeId} AND id = ${cmd.customerId} FOR UPDATE`
          customer = rows[0]
          if (!customer) throw new DomainError("not_found", "কাস্টমার পাওয়া যায়নি")
        }
        const plan = planSale(cmd, products, batches, customer !== undefined, opts.today, randomUUID)

        try {
          await tx`
            INSERT INTO sales (id, store_id, bill_no, bill_prefix, customer_id, subtotal_poisha, discount_poisha, line_discount_poisha,
                               bill_discount_poisha, total_poisha, paid_poisha, due_poisha, change_poisha, sold_at, oversold, request_hash, created_by)
            VALUES (${cmd.id}, ${storeId}, ${cmd.no}, ${cmd.prefix}, ${customer?.id ?? null}, ${plan.subtotal}, ${plan.lineDiscount + plan.billDiscount},
                    ${plan.lineDiscount}, ${plan.billDiscount}, ${plan.total}, ${plan.total - plan.due}, ${plan.due}, ${plan.change},
                    ${cmd.offline && cmd.at ? cmd.at : tx`date_trunc('milliseconds', now())`}, ${plan.oversold}, ${opts.hash}, ${userId})`
        } catch (err) {
          const e = err as { code?: string; constraint_name?: string } | null
          if (e?.code === UNIQUE_VIOLATION) throw new DomainError("duplicate_bill_no", "এই বিল নম্বরে আরেকটি বিল আছে")
          throw err
        }

        for (const [i, line] of plan.lines.entries()) {
          const item = await tx<{ id: string }[]>`
            INSERT INTO sale_items (store_id, sale_id, product_id, line_no, product_name, qty, unit_price_poisha, discount_poisha, line_total_poisha)
            VALUES (${storeId}, ${cmd.id}, ${line.productId}, ${i + 1}, ${line.name}, ${line.qty}, ${line.unitPrice}, ${line.discount}, ${line.unitPrice * line.qty - line.discount})
            RETURNING id`
          const itemId = item[0]!.id
          for (const [j, a] of line.allocations.entries()) {
            if (a.createBatch) {
              await tx`
                INSERT INTO stock_batches (id, store_id, product_id, batch_no, expiry_date, qty_remaining, cost_price_poisha)
                VALUES (${a.batchId}, ${storeId}, ${line.productId}, '', NULL, 0, ${a.costPoisha})`
            }
            await tx`UPDATE stock_batches SET qty_remaining = qty_remaining - ${a.qty} WHERE store_id = ${storeId} AND id = ${a.batchId}`
            await tx`
              INSERT INTO sale_allocations (store_id, sale_item_id, seq, batch_id, qty, oversold_qty, cost_poisha)
              VALUES (${storeId}, ${itemId}, ${j + 1}, ${a.batchId}, ${a.qty}, ${a.oversoldQty}, ${a.costPoisha})`
            await tx`
              INSERT INTO stock_movements (id, store_id, product_id, batch_id, kind, qty_delta, ref_id, created_by)
              VALUES (${randomUUID()}, ${storeId}, ${line.productId}, ${a.batchId}, 'sale', ${-a.qty}, ${cmd.id}, ${userId})`
          }
        }
        for (const [i, p] of plan.payments.entries()) {
          await tx`INSERT INTO payments (store_id, sale_id, seq, method, amount_poisha) VALUES (${storeId}, ${cmd.id}, ${i + 1}, ${p.method}, ${p.amount})`
        }
        if (plan.due > 0 && customer) {
          await tx`
            INSERT INTO due_ledger (store_id, customer_id, kind, amount_poisha, sale_id, created_by)
            VALUES (${storeId}, ${customer.id}, 'sale', ${signedAmount("sale", plan.due)}, ${cmd.id}, ${userId})`
        }
        return { sale: (await readSale(tx, storeId, cmd.id))!.sale, created: true }
      }),

    getSale: (storeId, id) => withStore(storeId, async (tx) => (await readSale(tx, storeId, id))?.sale ?? null),

    listSales: (storeId, q) =>
      withStore(storeId, async (tx) => {
        const from = q.from ? tx`AND s.sold_at >= ${q.from}::timestamptz` : tx``
        const to = q.to ? tx`AND s.sold_at <= ${q.to}::timestamptz` : tx``
        const who = q.customerId ? tx`AND s.customer_id = ${q.customerId}` : tx``
        const after = q.after ? tx`AND (s.sold_at, s.id) < (${q.after.at}::timestamptz, ${q.after.id}::uuid)` : tx``
        const rows = await tx<SaleRow[]>`
          ${SALE_SELECT(tx)}
          WHERE s.store_id = ${storeId} ${from} ${to} ${who} ${after}
          ORDER BY s.sold_at DESC, s.id DESC LIMIT ${q.limit + 1}`
        const items = await assemble(tx, storeId, rows.slice(0, q.limit))
        return { items, hasMore: rows.length > q.limit }
      }),

    voidSale: (storeId, userId, saleId, reason) =>
      withStore(storeId, async (tx) => {
        const head = await tx<{ voided: boolean }[]>`SELECT voided FROM sales WHERE store_id = ${storeId} AND id = ${saleId} FOR UPDATE`
        if (!head[0]) return null
        if (head[0].voided) throw new DomainError("already_voided", "এই বিল আগেই বাতিল হয়েছে")
        const sale = (await readSale(tx, storeId, saleId))!.sale

        const productIds = [...new Set(sale.lines.map((l) => l.productId))]
        await lockProducts(tx, storeId, productIds)
        const batchIds = [...new Set(sale.lines.flatMap((l) => l.allocations.map((a) => a.batchId)))]
        const state = await tx<{ id: string; product_id: string; removed_at: Date | null }[]>`
          SELECT id, product_id, removed_at FROM stock_batches
          WHERE store_id = ${storeId} AND id IN ${tx(batchIds)} ORDER BY product_id, id FOR UPDATE`
        const live = new Set<string>(state.filter((b: { removed_at: Date | null }) => b.removed_at === null).map((b: { id: string }) => b.id))
        const productOf = new Map(sale.lines.flatMap((l) => l.allocations.map((a) => [a.batchId, l.productId] as const)))

        let balance = 0
        if (sale.customerId) {
          await tx`SELECT 1 FROM customers WHERE store_id = ${storeId} AND id = ${sale.customerId} FOR UPDATE`
          const rows = await tx<{ bal: string | number }[]>`
            SELECT coalesce(sum(amount_poisha), 0) AS bal FROM due_ledger WHERE store_id = ${storeId} AND customer_id = ${sale.customerId}`
          balance = Number(rows[0]?.bal ?? 0)
        }
        const plan = planVoid(sale, live, balance)

        await tx`
          UPDATE sales SET voided = true, voided_at = date_trunc('milliseconds', now()), voided_by = ${userId}, void_reason = ${reason}
          WHERE store_id = ${storeId} AND id = ${saleId}`
        for (const r of plan.restores) {
          await tx`UPDATE stock_batches SET qty_remaining = qty_remaining + ${r.qty} WHERE store_id = ${storeId} AND id = ${r.batchId}`
          await tx`
            INSERT INTO stock_movements (id, store_id, product_id, batch_id, kind, qty_delta, ref_id, created_by)
            VALUES (${randomUUID()}, ${storeId}, ${productOf.get(r.batchId)!}, ${r.batchId}, 'sale_return', ${r.qty}, ${saleId}, ${userId})`
        }
        if (plan.dueReversed > 0 && sale.customerId) {
          await tx`
            INSERT INTO due_ledger (store_id, customer_id, kind, amount_poisha, sale_id, created_by)
            VALUES (${storeId}, ${sale.customerId}, 'void', ${signedAmount("void", plan.dueReversed)}, ${saleId}, ${userId})`
        }
        const fresh = (await readSale(tx, storeId, saleId))!.sale
        return { sale: fresh, restoredQty: plan.restoredQty, lostQty: plan.lostQty, refundPoisha: plan.refundPoisha }
      }),
  }
}
