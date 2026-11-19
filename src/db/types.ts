import type { Role } from "../auth/token.js"
import type { CatalogRepo } from "./catalog.js"
import type { StockRepo } from "./stock.js"

export type StoreKind = "pharmacy" | "cosmetics" | "other"

export interface PublicUser {
  id: string
  storeId: string
  name: string
  phone: string
  role: Role
  active: boolean
}

export interface UserWithHash extends PublicUser {
  passwordHash: string
}

export interface Store {
  id: string
  name: string
  kind: StoreKind
}

export interface NewSyncEvent {
  id: string
  kind: string
  /** ক্লায়েন্টের ঘড়ির সময় (ISO); কনফ্লিক্টে "শেষ বদল জেতে" ঠিক করতে ব্যবহার হয় */
  at: string
  payload: Record<string, unknown>
}

export interface SyncEvent extends NewSyncEvent {
  /** সার্ভারের ক্রমিক নম্বর; pull-এর কার্সর */
  seq: number
  deviceCode: string
  userId: string
}

// অ্যাপ শুধু এই ইন্টারফেস চেনে। দুটি বাস্তবায়ন আছে: pg.ts (আসল PostgreSQL/Supabase) ও memory.ts (টেস্ট)।
export interface ClientErrorReport {
  storeId: string | null
  kind: "render" | "window" | "rejection"
  message: string
  stack: string | null
  path: string | null
  appVersion: string | null
  userAgent: string | null
}

export interface Repo extends CatalogRepo, StockRepo {
  /** ডেটাবেসে পৌঁছানো যায় কি না (স্বাস্থ্য-পরীক্ষার জন্য); না গেলে ছোঁড়ে */
  ping(): Promise<void>

  registerStore(input: {
    storeName: string
    storeKind: StoreKind
    ownerName: string
    phone: string
    passwordHash: string
  }): Promise<{ storeId: string; userId: string }>

  /** লগইনের জন্য: দোকান জানার আগে ফোন দিয়ে ইউজার খোঁজা (পাসওয়ার্ড হ্যাশসহ)। */
  findUserByPhone(phone: string): Promise<UserWithHash | null>

  getUser(storeId: string, userId: string): Promise<PublicUser | null>
  getStore(storeId: string): Promise<Store | null>
  /** দোকানের নাম বদলায় (শুধু name); দোকান না পেলে null */
  renameStore(storeId: string, name: string): Promise<Store | null>
  createStaff(storeId: string, input: { name: string; phone: string; passwordHash: string }): Promise<PublicUser>
  listStaff(storeId: string): Promise<PublicUser[]>
  setUserActive(storeId: string, userId: string, active: boolean): Promise<PublicUser | null>
  /** ডিভাইসকে দোকান-ভিত্তিক কোড (A, B, C…) দেয়; একই ডিভাইস আবার চাইলে একই কোড। ২৬টির বেশি নয়। */
  registerDevice(storeId: string, deviceId: string): Promise<string>
  /** ইভেন্ট যোগ করে (একই id আগে থাকলে বাদ, ইডেমপোটেন্ট); অনিবন্ধিত ডিভাইসে device_unregistered। সব id ফেরত দেয়। */
  pushEvents(storeId: string, userId: string, deviceId: string, events: NewSyncEvent[]): Promise<string[]>
  /** seq > after ইভেন্ট ক্রমে; limit-এর বেশি থাকলে hasMore। */
  pullEvents(storeId: string, after: number, limit: number): Promise<{ events: SyncEvent[]; lastSeq: number; hasMore: boolean }>
  /** ফ্রন্টএন্ডের ক্র্যাশ রিপোর্ট রাখে (একই ত্রুটি আবার এলে গোনা বাড়ে); দোকানের ডেটার সঙ্গে সম্পর্ক নেই */
  recordClientError(report: ClientErrorReport): Promise<void>
  /**
   * হার-সীমা: bucket-এ একটি চেষ্টা নথিভুক্ত করে। সীমা (windowSeconds-এর মধ্যে max বার) পেরোলে false।
   * আটকে থাকা অবস্থায় নতুন চেষ্টা গোনা হয় না। দোকানের ডেটার সঙ্গে সম্পর্ক নেই।
   */
  throttle(bucket: string, max: number, windowSeconds: number): Promise<boolean>
  /** bucket-এর গোনা শূন্য করে (সফল লগইনে)। */
  throttleReset(bucket: string): Promise<void>
  close(): Promise<void>
}
