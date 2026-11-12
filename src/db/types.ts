import type { Role } from "../auth/token.js"

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

// অ্যাপ শুধু এই ইন্টারফেস চেনে। দুটি বাস্তবায়ন আছে: pg.ts (আসল PostgreSQL/Supabase) ও memory.ts (টেস্ট)।
export interface Repo {
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
  createStaff(storeId: string, input: { name: string; phone: string; passwordHash: string }): Promise<PublicUser>
  listStaff(storeId: string): Promise<PublicUser[]>
  setUserActive(storeId: string, userId: string, active: boolean): Promise<PublicUser | null>
  close(): Promise<void>
}
