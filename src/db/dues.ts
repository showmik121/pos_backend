import type { Customer, CustomerWithBalance, LedgerEntry, LedgerInput, NewCustomer } from "../domain/dues.js"

// কাস্টমার ও বাকির খাতা রিপোজিটরি অংশ। pg-dues.ts (আসল) ও memory-dues.ts (টেস্ট) একই আচরণ দেয়।
export interface CustomerListQuery {
  q?: string
  limit: number
  after?: { name: string; id: string }
}

export interface LedgerListQuery {
  limit: number
  after?: { at: string; id: string }
}

export interface DuesQuery {
  limit: number
  after?: { balancePoisha: number; id: string }
}

export interface DueRow {
  customer: Customer
  balancePoisha: number
  lastAt: string
}

export interface DuesRepo {
  /** একই id ও একই তথ্য = created=false; ভিন্ন তথ্যে id_conflict; একই ফোনে অন্য কাস্টমার থাকলে duplicate_phone */
  createCustomer(storeId: string, input: NewCustomer): Promise<{ customer: CustomerWithBalance; created: boolean }>
  getCustomer(storeId: string, id: string): Promise<CustomerWithBalance | null>
  listCustomers(storeId: string, query: CustomerListQuery): Promise<{ items: CustomerWithBalance[]; hasMore: boolean }>
  /** কাস্টমার না পেলে null; payment-এ বাকির বেশি হলে overpay; আগের একই এন্ট্রি হলে created=false, ভিন্ন হলে id_conflict */
  addLedger(storeId: string, userId: string, customerId: string, input: LedgerInput): Promise<{ entry: LedgerEntry; balancePoisha: number; created: boolean } | null>
  /** নতুন আগে; কাস্টমার না পেলে null */
  listLedger(storeId: string, customerId: string, query: LedgerListQuery): Promise<{ items: LedgerEntry[]; hasMore: boolean } | null>
  /** বাকি > ০ কাস্টমার, বেশি বাকি আগে; totalDuePoisha পুরো দোকানের (পেজ নির্বিশেষে) */
  listDues(storeId: string, query: DuesQuery): Promise<{ items: DueRow[]; hasMore: boolean; totalDuePoisha: number }>
}
