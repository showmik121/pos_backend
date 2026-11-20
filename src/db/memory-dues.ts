import { DomainError } from "../domain/errors.js"
import { assertNotOverpay, balanceOf, sameCustomerFields, sameLedgerInput, type Customer, type CustomerWithBalance, type LedgerEntry } from "../domain/dues.js"
import { toAsciiDigits } from "../domain/digits.js"
import type { DueRow, DuesRepo } from "./dues.js"

// pg-dues.ts এর সমতুল্য ইন-মেমরি বাস্তবায়ন (টেস্টের জন্য); প্রতি দোকানের ডেটা আলাদা।
export interface MemoryDues extends DuesRepo {
  /** বিক্রি-স্তর (sales) একই খাতা ও কাস্টমার ব্যবহার করে */
  internals: {
    customers(storeId: string): Map<string, Customer>
    ledger(storeId: string): LedgerEntry[]
    balance(storeId: string, customerId: string): number
  }
}

export function createMemoryDues(deps: { now: () => number; userName: (storeId: string, userId: string) => string }): MemoryDues {
  const customers = new Map<string, Map<string, Customer>>()
  const ledgers = new Map<string, LedgerEntry[]>()
  const shopCustomers = (s: string) => customers.get(s) ?? customers.set(s, new Map()).get(s)!
  const shopLedger = (s: string) => ledgers.get(s) ?? ledgers.set(s, []).get(s)!
  const iso = () => new Date(deps.now()).toISOString()
  const balance = (s: string, id: string) => balanceOf(shopLedger(s).filter((e) => e.customerId === id))
  const withBalance = (s: string, c: Customer): CustomerWithBalance => ({ ...c, balancePoisha: balance(s, c.id) })
  const newestFirst = (a: LedgerEntry, b: LedgerEntry) => (a.at === b.at ? (a.id < b.id ? 1 : -1) : a.at < b.at ? 1 : -1)

  return {
    internals: { customers: shopCustomers, ledger: shopLedger, balance },

    async createCustomer(storeId, input) {
      const book = shopCustomers(storeId)
      const existing = book.get(input.id)
      if (existing) {
        if (!sameCustomerFields(existing, input)) throw new DomainError("id_conflict", "এই id দিয়ে ভিন্ন তথ্যের কাস্টমার আগেই আছে")
        return { customer: withBalance(storeId, existing), created: false }
      }
      if (input.phone && [...book.values()].some((c) => c.phone === input.phone)) {
        throw new DomainError("duplicate_phone", "এই নম্বরে কাস্টমার আগে থেকেই আছে")
      }
      const customer: Customer = { id: input.id, name: input.name, phone: input.phone, createdAt: iso() }
      book.set(customer.id, customer)
      return { customer: withBalance(storeId, customer), created: true }
    },

    async getCustomer(storeId, id) {
      const c = shopCustomers(storeId).get(id)
      return c ? withBalance(storeId, c) : null
    },

    async listCustomers(storeId, q) {
      const needle = q.q?.toLowerCase()
      const digits = q.q ? toAsciiDigits(q.q) : ""
      let list = [...shopCustomers(storeId).values()].filter(
        (c) => needle === undefined || c.name.toLowerCase().includes(needle) || (digits !== "" && c.phone.startsWith(digits)),
      )
      list.sort((a, b) => (a.name === b.name ? (a.id < b.id ? -1 : 1) : a.name < b.name ? -1 : 1))
      const after = q.after
      if (after) list = list.filter((c) => c.name > after.name || (c.name === after.name && c.id > after.id))
      return { items: list.slice(0, q.limit).map((c) => withBalance(storeId, c)), hasMore: list.length > q.limit }
    },

    async addLedger(storeId, userId, customerId, input) {
      if (!shopCustomers(storeId).has(customerId)) return null
      const prior = shopLedger(storeId).find((e) => e.id === input.id)
      if (prior) {
        if (!sameLedgerInput(prior, customerId, input)) throw new DomainError("id_conflict", "এই id দিয়ে ভিন্ন তথ্যের এন্ট্রি আগেই আছে")
        return { entry: prior, balancePoisha: balance(storeId, customerId), created: false }
      }
      if (input.kind === "payment") assertNotOverpay(balance(storeId, customerId), input.amountPoisha)
      const entry: LedgerEntry = {
        id: input.id,
        customerId,
        kind: input.kind,
        amountPoisha: input.amountPoisha,
        saleId: null,
        method: input.method,
        at: iso(),
        by: deps.userName(storeId, userId),
      }
      shopLedger(storeId).push(entry)
      return { entry, balancePoisha: balance(storeId, customerId), created: true }
    },

    async listLedger(storeId, customerId, q) {
      if (!shopCustomers(storeId).has(customerId)) return null
      let list = shopLedger(storeId).filter((e) => e.customerId === customerId).sort(newestFirst)
      const after = q.after
      if (after) list = list.filter((e) => e.at < after.at || (e.at === after.at && e.id < after.id))
      return { items: list.slice(0, q.limit), hasMore: list.length > q.limit }
    },

    async listDues(storeId, q) {
      const rows: DueRow[] = []
      for (const c of shopCustomers(storeId).values()) {
        const bal = balance(storeId, c.id)
        if (bal <= 0) continue
        const last = shopLedger(storeId).filter((e) => e.customerId === c.id).reduce((m, e) => (e.at > m ? e.at : m), c.createdAt)
        rows.push({ customer: c, balancePoisha: bal, lastAt: last })
      }
      rows.sort((a, b) => (a.balancePoisha === b.balancePoisha ? (a.customer.id < b.customer.id ? -1 : 1) : b.balancePoisha - a.balancePoisha))
      const total = rows.reduce((s, r) => s + r.balancePoisha, 0)
      const after = q.after
      const page = after ? rows.filter((r) => r.balancePoisha < after.balancePoisha || (r.balancePoisha === after.balancePoisha && r.customer.id > after.id)) : rows
      return { items: page.slice(0, q.limit), hasMore: page.length > q.limit, totalDuePoisha: total }
    },
  }
}
