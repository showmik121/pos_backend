import type postgres from "postgres"
import { DomainError } from "../domain/errors.js"
import { assertNotOverpay, sameCustomerFields, sameLedgerInput, signedAmount, type CustomerWithBalance, type LedgerEntry, type LedgerKind, type PaymentMethod } from "../domain/dues.js"
import { toAsciiDigits } from "../domain/digits.js"
import { escapeLike } from "../domain/product.js"
import type { DuesRepo } from "./dues.js"

type Tx = postgres.TransactionSql
type WithStore = <T>(storeId: string, fn: (tx: Tx) => Promise<T>) => Promise<T>

interface CustomerRow {
  id: string
  name: string
  phone: string
  created_at: Date
  bal: string | number
}

interface LedgerRow {
  id: string
  customer_id: string
  kind: LedgerKind
  amount: string | number
  sale_id: string | null
  method: PaymentMethod | null
  created_at: Date
  by_name: string | null
}

const UNIQUE_VIOLATION = "23505"

const toCustomer = (r: CustomerRow): CustomerWithBalance => ({
  id: r.id,
  name: r.name,
  phone: r.phone,
  createdAt: r.created_at.toISOString(),
  balancePoisha: Number(r.bal),
})

const toEntry = (r: LedgerRow): LedgerEntry => ({
  id: r.id,
  customerId: r.customer_id,
  kind: r.kind,
  amountPoisha: Number(r.amount),
  saleId: r.sale_id,
  method: r.method,
  at: r.created_at.toISOString(),
  by: r.by_name ?? "অজানা",
})

const CUSTOMER_COLS = (tx: Tx) => tx`c.id, c.name, coalesce(c.phone, '') AS phone, c.created_at, coalesce(b.bal, 0) AS bal`
const BALANCE_JOIN = (tx: Tx) => tx`
  LEFT JOIN LATERAL (
    SELECT sum(l.amount_poisha) AS bal FROM due_ledger l WHERE l.store_id = c.store_id AND l.customer_id = c.id
  ) b ON true`
const LEDGER_SELECT = (tx: Tx) => tx`
  SELECT l.id, l.customer_id, l.kind, abs(l.amount_poisha) AS amount, l.sale_id, l.method, l.created_at, u.name AS by_name
  FROM due_ledger l LEFT JOIN users u ON u.store_id = l.store_id AND u.id = l.created_by`

async function readCustomer(tx: Tx, storeId: string, id: string): Promise<CustomerWithBalance | null> {
  const rows = await tx<CustomerRow[]>`
    SELECT ${CUSTOMER_COLS(tx)} FROM customers c ${BALANCE_JOIN(tx)} WHERE c.store_id = ${storeId} AND c.id = ${id}`
  return rows[0] ? toCustomer(rows[0]) : null
}

async function readEntry(tx: Tx, storeId: string, id: string): Promise<LedgerEntry | null> {
  const rows = await tx<LedgerRow[]>`${LEDGER_SELECT(tx)} WHERE l.store_id = ${storeId} AND l.id = ${id}`
  return rows[0] ? toEntry(rows[0]) : null
}

async function balanceOfCustomer(tx: Tx, storeId: string, customerId: string): Promise<number> {
  const rows = await tx<{ bal: string | number }[]>`
    SELECT coalesce(sum(amount_poisha), 0) AS bal FROM due_ledger WHERE store_id = ${storeId} AND customer_id = ${customerId}`
  return Number(rows[0]?.bal ?? 0)
}

export function createPgDues(withStore: WithStore): DuesRepo {
  return {
    createCustomer: (storeId, input) =>
      withStore(storeId, async (tx) => {
        // একই id-র সমান্তরাল দুটি তৈরি ক্রমে চলে (দ্বিতীয়টি আগেরটা দেখে ইডেমপোটেন্ট উত্তর পায়)
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`customer:${storeId}:${input.id}`}, 0))`
        const existing = await readCustomer(tx, storeId, input.id)
        if (existing) {
          if (!sameCustomerFields(existing, input)) throw new DomainError("id_conflict", "এই id দিয়ে ভিন্ন তথ্যের কাস্টমার আগেই আছে")
          return { customer: existing, created: false }
        }
        try {
          await tx`INSERT INTO customers (id, store_id, name, phone) VALUES (${input.id}, ${storeId}, ${input.name}, ${input.phone || null})`
        } catch (err) {
          const e = err as { code?: string; constraint_name?: string } | null
          if (e?.code === UNIQUE_VIOLATION && e.constraint_name === "customers_phone_uq") {
            throw new DomainError("duplicate_phone", "এই নম্বরে কাস্টমার আগে থেকেই আছে")
          }
          throw err
        }
        return { customer: (await readCustomer(tx, storeId, input.id))!, created: true }
      }),

    getCustomer: (storeId, id) => withStore(storeId, (tx) => readCustomer(tx, storeId, id)),

    listCustomers: (storeId, q) =>
      withStore(storeId, async (tx) => {
        const search =
          q.q !== undefined
            ? tx`AND (c.name ILIKE ${`%${escapeLike(q.q)}%`} OR c.phone LIKE ${`${escapeLike(toAsciiDigits(q.q))}%`})`
            : tx``
        const after = q.after ? tx`AND (c.name, c.id) > (${q.after.name}, ${q.after.id}::uuid)` : tx``
        const rows = await tx<CustomerRow[]>`
          SELECT ${CUSTOMER_COLS(tx)} FROM customers c ${BALANCE_JOIN(tx)}
          WHERE c.store_id = ${storeId} ${search} ${after}
          ORDER BY c.name, c.id LIMIT ${q.limit + 1}`
        return { items: rows.slice(0, q.limit).map(toCustomer), hasMore: rows.length > q.limit }
      }),

    addLedger: (storeId, userId, customerId, input) =>
      withStore(storeId, async (tx) => {
        // বিলের মতো একই ক্রম: কাস্টমার-সারি লক করে ব্যালান্স পড়া/লেখা (একই কাস্টমারের সমান্তরাল আদায়ে বেশি কাটা যায় না)
        const held = await tx`SELECT 1 FROM customers WHERE store_id = ${storeId} AND id = ${customerId} FOR UPDATE`
        if (held.length === 0) return null
        const prior = await readEntry(tx, storeId, input.id)
        if (prior) {
          if (!sameLedgerInput(prior, customerId, input)) throw new DomainError("id_conflict", "এই id দিয়ে ভিন্ন তথ্যের এন্ট্রি আগেই আছে")
          return { entry: prior, balancePoisha: await balanceOfCustomer(tx, storeId, customerId), created: false }
        }
        const balance = await balanceOfCustomer(tx, storeId, customerId)
        if (input.kind === "payment") assertNotOverpay(balance, input.amountPoisha)
        try {
          await tx`
            INSERT INTO due_ledger (id, store_id, customer_id, kind, amount_poisha, method, created_by)
            VALUES (${input.id}, ${storeId}, ${customerId}, ${input.kind}, ${signedAmount(input.kind, input.amountPoisha)}, ${input.method}, ${userId})`
        } catch (err) {
          if ((err as { code?: string } | null)?.code === UNIQUE_VIOLATION) throw new DomainError("id_conflict", "এই id আগেই অন্য কাজে ব্যবহার হয়েছে")
          throw err
        }
        const entry = (await readEntry(tx, storeId, input.id))!
        return { entry, balancePoisha: await balanceOfCustomer(tx, storeId, customerId), created: true }
      }),

    listLedger: (storeId, customerId, q) =>
      withStore(storeId, async (tx) => {
        const known = await tx`SELECT 1 FROM customers WHERE store_id = ${storeId} AND id = ${customerId}`
        if (known.length === 0) return null
        const after = q.after ? tx`AND (l.created_at, l.id) < (${q.after.at}::timestamptz, ${q.after.id}::uuid)` : tx``
        const rows = await tx<LedgerRow[]>`
          ${LEDGER_SELECT(tx)}
          WHERE l.store_id = ${storeId} AND l.customer_id = ${customerId} ${after}
          ORDER BY l.created_at DESC, l.id DESC LIMIT ${q.limit + 1}`
        return { items: rows.slice(0, q.limit).map(toEntry), hasMore: rows.length > q.limit }
      }),

    listDues: (storeId, q) =>
      withStore(storeId, async (tx) => {
        const owing = () => tx`
          FROM customers c
          JOIN LATERAL (
            SELECT sum(l.amount_poisha) AS bal, max(l.created_at) AS last_at
            FROM due_ledger l WHERE l.store_id = c.store_id AND l.customer_id = c.id
          ) b ON b.bal > 0
          WHERE c.store_id = ${storeId}`
        const after = q.after ? tx`AND (b.bal < ${q.after.balancePoisha} OR (b.bal = ${q.after.balancePoisha} AND c.id > ${q.after.id}::uuid))` : tx``
        const rows = await tx<(CustomerRow & { last_at: Date | null })[]>`
          SELECT c.id, c.name, coalesce(c.phone, '') AS phone, c.created_at, b.bal, b.last_at ${owing()} ${after}
          ORDER BY b.bal DESC, c.id LIMIT ${q.limit + 1}`
        const total = await tx<{ total: string | number }[]>`SELECT coalesce(sum(b.bal), 0) AS total ${owing()}`
        return {
          items: rows.slice(0, q.limit).map((r: CustomerRow & { last_at: Date | null }) => ({
            customer: { id: r.id, name: r.name, phone: r.phone, createdAt: r.created_at.toISOString() },
            balancePoisha: Number(r.bal),
            lastAt: (r.last_at ?? r.created_at).toISOString(),
          })),
          hasMore: rows.length > q.limit,
          totalDuePoisha: Number(total[0]?.total ?? 0),
        }
      }),
  }
}
