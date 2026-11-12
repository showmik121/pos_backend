import { randomUUID } from "node:crypto"
import { DomainError } from "../domain/errors.js"
import type { PublicUser, Repo, Store, UserWithHash } from "./types.js"

// টেস্ট ও লোকাল ডেমোর জন্য ইন-মেমরি রিপোজিটরি। pg.ts এর সঙ্গে একই ইন্টারফেস।
export function createMemoryRepo(): Repo {
  const stores = new Map<string, Store>()
  const users = new Map<string, UserWithHash>()

  const publicUser = (u: UserWithHash): PublicUser => ({
    id: u.id,
    storeId: u.storeId,
    name: u.name,
    phone: u.phone,
    role: u.role,
    active: u.active,
  })
  const phoneTaken = (phone: string) => [...users.values()].some((u) => u.phone === phone)
  const taken = () => new DomainError("phone_taken", "এই নম্বরে আগেই অ্যাকাউন্ট আছে")

  return {
    async registerStore({ storeName, storeKind, ownerName, phone, passwordHash }) {
      if (phoneTaken(phone)) throw taken()
      const storeId = randomUUID()
      const userId = randomUUID()
      stores.set(storeId, { id: storeId, name: storeName, kind: storeKind })
      users.set(userId, { id: userId, storeId, name: ownerName, phone, passwordHash, role: "owner", active: true })
      return { storeId, userId }
    },

    async findUserByPhone(phone) {
      return [...users.values()].find((u) => u.phone === phone) ?? null
    },

    async getUser(storeId, userId) {
      const u = users.get(userId)
      return u && u.storeId === storeId ? publicUser(u) : null
    },

    async getStore(storeId) {
      return stores.get(storeId) ?? null
    },

    async createStaff(storeId, { name, phone, passwordHash }) {
      if (phoneTaken(phone)) throw taken()
      const u: UserWithHash = { id: randomUUID(), storeId, name, phone, passwordHash, role: "staff", active: true }
      users.set(u.id, u)
      return publicUser(u)
    },

    async listStaff(storeId) {
      return [...users.values()].filter((u) => u.storeId === storeId).map(publicUser)
    },

    async setUserActive(storeId, userId, active) {
      const u = users.get(userId)
      if (!u || u.storeId !== storeId) return null
      u.active = active
      return publicUser(u)
    },

    async close() {},
  }
}
