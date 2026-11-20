import type postgres from "postgres"
import { signedAmount } from "../domain/dues.js"
import { normalizeId, toCommand, type ProjectedLedger, type ProjectionCommand } from "../domain/projection.js"
import { lockProducts } from "./pg-sales.js"
import type { IncomingEvent, ProjectionRepo, ProjectionSummary } from "./projection.js"

type Tx = postgres.TransactionSql
type WithStore = <T>(storeId: string, fn: (tx: Tx) => Promise<T>) => Promise<T>

/** applied = বসেছে (বা ঘড়ি পুরনো বলে কিছু বদলায়নি); deferred = নির্ভরতা আসেনি; ignored = বসানো যায় না */
type Outcome = { status: "applied" } | { status: "deferred" } | { status: "ignored"; detail: string }
const APPLIED: Outcome = { status: "applied" }
const DEFERRED: Outcome = { status: "deferred" }
const ignored = (detail: string): Outcome => ({ status: "ignored", detail })

const derive = (eventId: string, tag: string) => normalizeId(`${eventId}:${tag}`)

async function clockOf(tx: Tx, storeId: string, key: string): Promise<string | null> {
  const rows = await tx<{ stamp: string }[]>`SELECT stamp FROM projection_clocks WHERE store_id = ${storeId} AND key = ${key}`
  return rows[0]?.stamp ?? null
}
const setClock = (tx: Tx, storeId: string, key: string, stamp: string) =>
  tx`INSERT INTO projection_clocks (store_id, key, stamp) VALUES (${storeId}, ${key}, ${stamp})
     ON CONFLICT (store_id, key) DO UPDATE SET stamp = EXCLUDED.stamp`

async function exists(tx: Tx, table: "products" | "customers" | "sales", storeId: string, id: string): Promise<boolean> {
  const rows = await tx`SELECT 1 FROM ${tx(table)} WHERE store_id = ${storeId} AND id = ${id}`
  return rows.length > 0
}

async function insertLedger(tx: Tx, storeId: string, l: ProjectedLedger) {
  await tx`
    INSERT INTO due_ledger (id, store_id, customer_id, kind, amount_poisha, sale_id, by_name, created_at)
    VALUES (${l.id}, ${storeId}, ${l.customerId}, ${l.kind}, ${signedAmount(l.kind, l.amountPoisha)}, ${l.saleId}, ${l.by}, ${l.at}::timestamptz)
    ON CONFLICT DO NOTHING`
}

// ---------------------------------------------------------------- প্রতিটি কমান্ড

async function applyProduct(tx: Tx, storeId: string, c: Extract<ProjectionCommand, { kind: "product" }>): Promise<Outcome> {
  const key = `product:${c.id}`
  const cur = await clockOf(tx, storeId, key)
  if (cur !== null && cur >= c.stamp) return APPLIED
  const f = c.fields
  await tx`
    INSERT INTO products (id, store_id, name, unit, pack_size, cost_price_poisha, sell_price_poisha, low_stock_threshold, category, is_open, created_at, updated_at)
    VALUES (${c.id}, ${storeId}, ${f.name}, ${f.unit}, ${f.cartonSize}, ${f.costPoisha}, ${f.pricePoisha}, ${f.minStock}, ${f.category}, ${f.open},
            ${c.createdAt}::timestamptz, date_trunc('milliseconds', now()))
    ON CONFLICT (store_id, id) DO UPDATE SET
      name = EXCLUDED.name, unit = EXCLUDED.unit, pack_size = EXCLUDED.pack_size, cost_price_poisha = EXCLUDED.cost_price_poisha,
      sell_price_poisha = EXCLUDED.sell_price_poisha, low_stock_threshold = EXCLUDED.low_stock_threshold, category = EXCLUDED.category,
      is_open = EXCLUDED.is_open, updated_at = EXCLUDED.updated_at`
  await tx`DELETE FROM product_barcodes WHERE store_id = ${storeId} AND product_id = ${c.id}`
  for (const b of f.barcodes) {
    // অন্য পণ্যে থাকা কোড বাদ পড়ে (সার্ভারে বারকোড দোকানে একটিই); বাকিগুলো বসে
    await tx`INSERT INTO product_barcodes (store_id, code, product_id, pack_size) VALUES (${storeId}, ${b.code}, ${c.id}, ${b.packSize}) ON CONFLICT DO NOTHING`
  }
  await setClock(tx, storeId, key, c.stamp)
  return APPLIED
}

async function applyCustomer(tx: Tx, storeId: string, c: Extract<ProjectionCommand, { kind: "customer" }>): Promise<Outcome> {
  const key = `customer:${c.id}`
  const cur = await clockOf(tx, storeId, key)
  if (cur !== null && cur >= c.stamp) return APPLIED
  let phone: string | null = c.phone === "" ? null : c.phone
  if (phone) {
    const taken = await tx`SELECT 1 FROM customers WHERE store_id = ${storeId} AND phone = ${phone} AND id <> ${c.id}`
    if (taken.length > 0) phone = null // সার্ভারে ফোন ইউনিক; ফোনের ডেটায় দুটি একই নম্বর থাকলে পরেরটির নম্বর বাদ
  }
  await tx`
    INSERT INTO customers (id, store_id, name, phone, created_at) VALUES (${c.id}, ${storeId}, ${c.name}, ${phone}, ${c.createdAt}::timestamptz)
    ON CONFLICT (store_id, id) DO UPDATE SET name = EXCLUDED.name, phone = EXCLUDED.phone`
  await setClock(tx, storeId, key, c.stamp)
  return APPLIED
}

async function applyStockIn(tx: Tx, storeId: string, c: Extract<ProjectionCommand, { kind: "stock_in" }>): Promise<Outcome> {
  if (!(await exists(tx, "products", storeId, c.productId))) return DEFERRED
  await lockProducts(tx, storeId, [c.productId])
  const rows = await tx<{ product_id: string; removed_at: Date | null }[]>`
    SELECT product_id, removed_at FROM stock_batches WHERE store_id = ${storeId} AND id = ${c.batchId} FOR UPDATE`
  const row = rows[0]
  if (row && row.product_id !== c.productId) return ignored("ব্যাচ অন্য পণ্যের")
  if (row?.removed_at) return APPLIED // সরানো ব্যাচ পরে আসা জমায় ফেরে না
  const key = `batch:${c.batchId}`
  if (!row) {
    await tx`
      INSERT INTO stock_batches (id, store_id, product_id, batch_no, expiry_date, qty_remaining, cost_price_poisha, received_at)
      VALUES (${c.batchId}, ${storeId}, ${c.productId}, ${c.batchNo}, ${c.expiryDate}::date, ${c.qty}, ${c.costPoisha}, ${c.receivedAt}::timestamptz)`
    await setClock(tx, storeId, key, c.stamp)
  } else {
    const cur = await clockOf(tx, storeId, key)
    const newer = cur === null || c.stamp > cur
    await tx`
      UPDATE stock_batches SET qty_remaining = qty_remaining + ${c.qty}${newer ? tx`, cost_price_poisha = ${c.costPoisha}` : tx``}
      WHERE store_id = ${storeId} AND id = ${c.batchId}`
    if (newer) await setClock(tx, storeId, key, c.stamp)
  }
  await tx`
    INSERT INTO stock_movements (id, store_id, product_id, batch_id, kind, qty_delta)
    VALUES (${c.eventId}, ${storeId}, ${c.productId}, ${c.batchId}, 'purchase', ${c.qty}) ON CONFLICT DO NOTHING`
  return APPLIED
}

async function applySale(tx: Tx, storeId: string, c: Extract<ProjectionCommand, { kind: "sale" }>): Promise<Outcome> {
  const s = c.sale
  if (await exists(tx, "sales", storeId, s.id)) return APPLIED
  const productIds = [...new Set(s.lines.map((l) => l.productId))]
  const batchIds = [...new Set(s.lines.flatMap((l) => l.allocations.map((a) => a.batchId)))]
  const prods = await tx<{ id: string }[]>`SELECT id FROM products WHERE store_id = ${storeId} AND id IN ${tx(productIds)}`
  if (prods.length < productIds.length) return DEFERRED
  if (s.customerId && !(await exists(tx, "customers", storeId, s.customerId))) return DEFERRED
  await lockProducts(tx, storeId, productIds)
  const batches = await tx<{ id: string; product_id: string; qty_remaining: number; removed_at: Date | null }[]>`
    SELECT id, product_id, qty_remaining, removed_at FROM stock_batches
    WHERE store_id = ${storeId} AND id IN ${tx(batchIds)} ORDER BY product_id, id FOR UPDATE`
  if (batches.length < batchIds.length) return DEFERRED
  type BatchRow = { id: string; product_id: string; qty_remaining: number; removed_at: Date | null }
  const info = new Map<string, BatchRow>()
  for (const b of batches as BatchRow[]) info.set(b.id, b)
  for (const l of s.lines) for (const a of l.allocations) if (info.get(a.batchId)!.product_id !== l.productId) return ignored("ব্যাচ অন্য পণ্যের")

  // কোন ব্যাচ কত কমবে (সরানো ব্যাচে কমে না); কোনো ব্যাচ ঋণাত্মক হলে বিল oversold
  const take = new Map<string, number>()
  for (const l of s.lines) for (const a of l.allocations) take.set(a.batchId, (take.get(a.batchId) ?? 0) + a.qty)
  const oversold = [...take].some(([id, q]) => !info.get(id)!.removed_at && Number(info.get(id)!.qty_remaining) - q < 0)

  const inserted = await tx<{ id: string }[]>`
    INSERT INTO sales (id, store_id, bill_no, bill_prefix, customer_id, subtotal_poisha, discount_poisha, line_discount_poisha, bill_discount_poisha,
                       total_poisha, paid_poisha, due_poisha, change_poisha, sold_at, oversold, request_hash, cashier_name)
    VALUES (${s.id}, ${storeId}, ${s.no}, ${s.prefix}, ${s.customerId}, ${s.subtotal}, ${s.lineDiscount + s.billDiscount}, ${s.lineDiscount}, ${s.billDiscount},
            ${s.total}, ${s.total - s.due}, ${s.due}, ${s.change}, ${s.at}::timestamptz, ${oversold}, ${`proj:${c.eventId}`}, ${s.cashier})
    ON CONFLICT DO NOTHING RETURNING id`
  if (inserted.length === 0) return ignored("এই বিল নম্বরে আরেকটি বিল আছে")

  let n = 0
  for (const [i, l] of s.lines.entries()) {
    const item = await tx<{ id: string }[]>`
      INSERT INTO sale_items (store_id, sale_id, product_id, line_no, product_name, qty, unit_price_poisha, discount_poisha, line_total_poisha)
      VALUES (${storeId}, ${s.id}, ${l.productId}, ${i + 1}, ${l.name}, ${l.qty}, ${l.unitPrice}, ${l.discount}, ${l.unitPrice * l.qty - l.discount}) RETURNING id`
    for (const [j, a] of l.allocations.entries()) {
      await tx`
        INSERT INTO sale_allocations (store_id, sale_item_id, seq, batch_id, qty, oversold_qty, cost_poisha)
        VALUES (${storeId}, ${item[0]!.id}, ${j + 1}, ${a.batchId}, ${a.qty}, 0, ${a.costPoisha})`
      if (!info.get(a.batchId)!.removed_at) {
        await tx`UPDATE stock_batches SET qty_remaining = qty_remaining - ${a.qty} WHERE store_id = ${storeId} AND id = ${a.batchId}`
        await tx`
          INSERT INTO stock_movements (id, store_id, product_id, batch_id, kind, qty_delta, ref_id)
          VALUES (${derive(c.eventId, `sale:${n}`)}, ${storeId}, ${l.productId}, ${a.batchId}, 'sale', ${-a.qty}, ${s.id})`
      }
      n += 1
    }
  }
  for (const [i, p] of s.payments.entries()) {
    await tx`INSERT INTO payments (store_id, sale_id, seq, method, amount_poisha) VALUES (${storeId}, ${s.id}, ${i + 1}, ${p.method}, ${p.amount})`
  }
  if (c.ledger) {
    await tx`SELECT 1 FROM customers WHERE store_id = ${storeId} AND id = ${c.ledger.customerId} FOR UPDATE`
    await insertLedger(tx, storeId, c.ledger)
  }
  return APPLIED
}

async function applyVoid(tx: Tx, storeId: string, c: Extract<ProjectionCommand, { kind: "void" }>): Promise<Outcome> {
  const head = await tx<{ voided: boolean; customer_id: string | null }[]>`
    SELECT voided, customer_id FROM sales WHERE store_id = ${storeId} AND id = ${c.saleId} FOR UPDATE`
  if (!head[0]) return DEFERRED
  if (head[0].voided) return APPLIED // স্টক আগেই ফিরেছে
  const allocs = await tx<{ batch_id: string; product_id: string; qty: number }[]>`
    SELECT a.batch_id, i.product_id, a.qty FROM sale_allocations a
    JOIN sale_items i ON i.store_id = a.store_id AND i.id = a.sale_item_id
    WHERE a.store_id = ${storeId} AND i.sale_id = ${c.saleId}`
  await lockProducts(tx, storeId, [...new Set<string>(allocs.map((a: { product_id: string }) => a.product_id))])
  const batchIds = [...new Set<string>(allocs.map((a: { batch_id: string }) => a.batch_id))]
  const state = batchIds.length
    ? await tx<{ id: string; removed_at: Date | null }[]>`
        SELECT id, removed_at FROM stock_batches WHERE store_id = ${storeId} AND id IN ${tx(batchIds)} ORDER BY product_id, id FOR UPDATE`
    : []
  const live = new Set<string>(state.filter((b: { removed_at: Date | null }) => b.removed_at === null).map((b: { id: string }) => b.id))
  for (const [i, a] of allocs.entries()) {
    if (!live.has(a.batch_id)) continue
    await tx`UPDATE stock_batches SET qty_remaining = qty_remaining + ${a.qty} WHERE store_id = ${storeId} AND id = ${a.batch_id}`
    await tx`
      INSERT INTO stock_movements (id, store_id, product_id, batch_id, kind, qty_delta, ref_id)
      VALUES (${derive(c.eventId, `return:${i}`)}, ${storeId}, ${a.product_id}, ${a.batch_id}, 'sale_return', ${a.qty}, ${c.saleId})`
  }
  await tx`
    UPDATE sales SET voided = true, voided_at = ${c.voided.at}::timestamptz, voided_by_name = ${c.voided.by}, void_reason = ${c.voided.reason}
    WHERE store_id = ${storeId} AND id = ${c.saleId}`
  if (c.ledger) {
    await tx`SELECT 1 FROM customers WHERE store_id = ${storeId} AND id = ${c.ledger.customerId} FOR UPDATE`
    await insertLedger(tx, storeId, c.ledger)
  }
  return APPLIED
}

async function applyDue(tx: Tx, storeId: string, c: Extract<ProjectionCommand, { kind: "due" }>): Promise<Outcome> {
  if (!(await exists(tx, "customers", storeId, c.entry.customerId))) return DEFERRED
  await tx`SELECT 1 FROM customers WHERE store_id = ${storeId} AND id = ${c.entry.customerId} FOR UPDATE`
  await insertLedger(tx, storeId, c.entry)
  return APPLIED
}

async function applyRemoval(tx: Tx, storeId: string, c: Extract<ProjectionCommand, { kind: "batch_removed" }>): Promise<Outcome> {
  const r = c.removed
  if (!r.batchId) return ignored("পুরনো ডেটা: ব্যাচ id নেই")
  const peek = await tx<{ product_id: string }[]>`SELECT product_id FROM stock_batches WHERE store_id = ${storeId} AND id = ${r.batchId}`
  if (!peek[0]) return DEFERRED
  await lockProducts(tx, storeId, [peek[0].product_id])
  const rows = await tx<{ removed_at: Date | null }[]>`
    SELECT removed_at FROM stock_batches WHERE store_id = ${storeId} AND id = ${r.batchId} FOR UPDATE`
  if (rows[0]!.removed_at) return APPLIED
  await tx`
    UPDATE stock_batches SET qty_remaining = 0, removed_at = ${r.at}::timestamptz, removed_by_name = ${r.by}, removed_reason = ${r.reason}
    WHERE store_id = ${storeId} AND id = ${r.batchId}`
  if (r.qty > 0) {
    await tx`
      INSERT INTO stock_movements (id, store_id, product_id, batch_id, kind, qty_delta, note)
      VALUES (${r.id}, ${storeId}, ${peek[0].product_id}, ${r.batchId}, 'removal', ${-r.qty}, ${r.reason}) ON CONFLICT DO NOTHING`
  }
  return APPLIED
}

function apply(tx: Tx, storeId: string, c: ProjectionCommand): Promise<Outcome> {
  switch (c.kind) {
    case "product": return applyProduct(tx, storeId, c)
    case "customer": return applyCustomer(tx, storeId, c)
    case "stock_in": return applyStockIn(tx, storeId, c)
    case "sale": return applySale(tx, storeId, c)
    case "void": return applyVoid(tx, storeId, c)
    case "due": return applyDue(tx, storeId, c)
    case "batch_removed": return applyRemoval(tx, storeId, c)
  }
}

// ---------------------------------------------------------------- চালক

async function setStatus(tx: Tx, storeId: string, eventId: string, status: string, detail: string | null) {
  await tx`
    INSERT INTO projection_events (store_id, event_id, status, detail) VALUES (${storeId}, ${eventId}, ${status}, ${detail})
    ON CONFLICT (store_id, event_id) DO UPDATE SET status = EXCLUDED.status, detail = EXCLUDED.detail, updated_at = date_trunc('milliseconds', now())`
}

const byStamp = (a: ProjectionCommand, b: ProjectionCommand) => (a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : 0)

export function createPgProjection(withStore: WithStore): ProjectionRepo {
  return {
    project: (storeId, events) =>
      withStore(storeId, async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`proj:${storeId}`}, 0))`
        const summary: ProjectionSummary = { applied: 0, deferred: 0, ignored: 0, duplicate: 0, failed: 0 }

        // নতুন ইভেন্ট + আগের অপেক্ষারত ইভেন্ট (লগ থেকে আবার পড়া)
        const waiting = await tx<{ id: string; kind: string; client_at: Date; payload: Record<string, unknown> }[]>`
          SELECT e.id, e.kind, e.client_at, e.payload FROM projection_events p
          JOIN sync_events e ON e.store_id = p.store_id AND e.id = p.event_id
          WHERE p.store_id = ${storeId} AND p.status = 'deferred'`
        const all = new Map<string, { id: string; kind: string; at: string; payload: Record<string, unknown> }>()
        for (const w of waiting) all.set(normalizeId(w.id), { id: w.id, kind: w.kind, at: w.client_at.toISOString(), payload: w.payload })
        for (const e of events) all.set(normalizeId(e.id), e)

        const ids = [...all.keys()]
        const seen = ids.length
          ? await tx<{ event_id: string; status: string }[]>`SELECT event_id, status FROM projection_events WHERE store_id = ${storeId} AND event_id IN ${tx(ids)}`
          : []
        const done = new Set<string>(seen.filter((r: { status: string }) => r.status !== "deferred").map((r: { event_id: string }) => r.event_id))

        let queue: ProjectionCommand[] = []
        for (const [id, e] of all) {
          if (done.has(id)) {
            summary.duplicate += 1
            continue
          }
          const mapped = toCommand(e)
          if ("ignore" in mapped) {
            await setStatus(tx, storeId, id, "ignored", mapped.ignore)
            summary.ignored += 1
          } else queue.push(mapped)
        }
        queue.sort(byStamp)

        for (;;) {
          const left: ProjectionCommand[] = []
          let progressed = false
          for (const c of queue) {
            try {
              const out: Outcome = await tx.savepoint((sp: Tx) => apply(sp, storeId, c))
              if (out.status === "deferred") left.push(c)
              else {
                await setStatus(tx, storeId, c.eventId, out.status, out.status === "ignored" ? out.detail : null)
                summary[out.status === "applied" ? "applied" : "ignored"] += 1
                progressed = true
              }
            } catch (err) {
              await setStatus(tx, storeId, c.eventId, "failed", String((err as Error)?.message ?? err).slice(0, 300))
              summary.failed += 1
              progressed = true
            }
          }
          queue = left
          if (!progressed || left.length === 0) break
        }
        for (const c of queue) {
          await setStatus(tx, storeId, c.eventId, "deferred", null)
          summary.deferred += 1
        }
        return summary
      }),
  }
}
