import type { SaleCommand, SaleRecord } from "../domain/sales.js"

// বিক্রি রিপোজিটরি অংশ। pg-sales.ts (আসল) ও memory-sales.ts (টেস্ট) একই আচরণ দেয়।
export interface SaleListQuery {
  /** বিক্রির সময় এর পর (ISO) */
  from?: string
  to?: string
  customerId?: string
  limit: number
  after?: { at: string; id: string }
}

export interface VoidOutcome {
  sale: SaleRecord
  restoredQty: number
  lostQty: number
  refundPoisha: number
}

export interface SalesRepo {
  /**
   * একই id ও একই অনুরোধ (hash) আগে থাকলে created=false; ভিন্ন হলে id_conflict; একই বিল নম্বরে অন্য বিল duplicate_bill_no।
   * পণ্য/কাস্টমার না পেলে not_found; অনলাইনে স্টক কম হলে insufficient_stock। সব-অথবা-কিছুই-না।
   */
  createSale(storeId: string, userId: string, cmd: SaleCommand, opts: { hash: string; today: string }): Promise<{ sale: SaleRecord; created: boolean }>
  getSale(storeId: string, id: string): Promise<SaleRecord | null>
  /** বিক্রির সময়ের নতুন আগে; বাতিল বিলও থাকে (voided চিহ্নসহ) */
  listSales(storeId: string, query: SaleListQuery): Promise<{ items: SaleRecord[]; hasMore: boolean }>
  /** বিল না পেলে null; আগেই বাতিল হলে already_voided */
  voidSale(storeId: string, userId: string, saleId: string, reason: string): Promise<VoidOutcome | null>
}
