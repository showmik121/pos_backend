import { randomUUID } from "node:crypto"
import { DomainError } from "../domain/errors.js"
import { createMemoryCatalog } from "./memory-catalog.js"
import { createMemoryStock } from "./memory-stock.js"
import type { ClientErrorReport, NewSyncEvent, PublicUser, Repo, Store, SyncEvent, UserWithHash } from "./types.js"

// টেস্ট ও লোকাল ডেমোর জন্য ইন-মেমরি রিপোজিটরি। pg.ts এর সঙ্গে একই ইন্টারফেস।
export function createMemoryRepo(opts: { now?: () => number } = {}): Repo & { peekClientErrors(): Array<ClientErrorReport & { count: number }> } {
  const now = opts.now ?? (() => Date.now())
  const catalog = createMemoryCatalog(now)
  const attempts = new Map<string, number[]>()
  const clientErrors = new Map<string, ClientErrorReport & { count: number }>()
  const stores = new Map<string, Store>()
  const users = new Map<string, UserWithHash>()
  const devices = new Map<string, string[]>() // storeId -> [deviceId...] (সূচক = কোডের ক্রম)
  const events: Array<SyncEvent & { storeId: string }> = []
  let seq = 0

  const publicUser = (u: UserWithHash): PublicUser => ({
    id: u.id,
    storeId: u.storeId,
    name: u.name,
    phone: u.phone,
    role: u.role,
    active: u.active,
  })
  const stock = createMemoryStock({ now, catalog, userName: (_s, id) => users.get(id)?.name ?? "অজানা" })
  const phoneTaken = (phone: string) => [...users.values()].some((u) => u.phone === phone)
  const taken = () => new DomainError("phone_taken", "এই নম্বরে আগেই অ্যাকাউন্ট আছে")

  return {
    ...catalog,
    ...stock,

    async registerStore({ storeName, storeKind, ownerName, phone, passwordHash }) {
      if (phoneTaken(phone)) throw taken()
      const storeId = randomUUID()
      const userId = randomUUID()
      stores.set(storeId, { id: storeId, name: storeName, kind: storeKind })
      users.set(userId, { id: userId, storeId, name: ownerName, phone, passwordHash, role: "owner", active: true })
      return { storeId, userId }
    },

    async registerDevice(storeId, deviceId) {
      const list = devices.get(storeId) ?? []
      let i = list.indexOf(deviceId)
      if (i < 0) {
        if (list.length >= 26) throw new DomainError("device_limit", "একটি দোকানে সর্বোচ্চ ২৬টি ডিভাইস যুক্ত করা যায়")
        list.push(deviceId)
        devices.set(storeId, list)
        i = list.length - 1
      }
      return String.fromCharCode(65 + i)
    },

    async pushEvents(storeId, userId, deviceId, batch: NewSyncEvent[]) {
      const i = (devices.get(storeId) ?? []).indexOf(deviceId)
      if (i < 0) throw new DomainError("device_unregistered", "এই ডিভাইস নিবন্ধিত নয়")
      const deviceCode = String.fromCharCode(65 + i)
      for (const e of batch) {
        if (events.some((x) => x.storeId === storeId && x.id === e.id)) continue
        events.push({ storeId, seq: ++seq, id: e.id, kind: e.kind, at: e.at, payload: e.payload, deviceCode, userId })
      }
      return batch.map((e) => e.id)
    },

    async pullEvents(storeId, after, limit) {
      const mine = events.filter((e) => e.storeId === storeId && e.seq > after).sort((a, b) => a.seq - b.seq)
      const page = mine.slice(0, limit).map(({ storeId: _s, ...rest }) => rest)
      return { events: page, lastSeq: page.length ? page[page.length - 1]!.seq : after, hasMore: mine.length > limit }
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

    async throttle(bucket, max, windowSeconds) {
      const cutoff = now() - windowSeconds * 1000
      const recent = (attempts.get(bucket) ?? []).filter((t) => t > cutoff)
      if (recent.length >= max) {
        attempts.set(bucket, recent)
        return false // আটকে থাকা অবস্থায় নতুন চেষ্টা গোনা হয় না (pg.ts এর মতো)
      }
      attempts.set(bucket, [...recent, now()])
      return true
    },

    async throttleReset(bucket) {
      attempts.delete(bucket)
    },

    async recordClientError(r) {
      const key = `${r.kind}|${r.message}|${(r.stack ?? "").slice(0, 300)}`
      const hit = clientErrors.get(key)
      if (hit) hit.count += 1
      else clientErrors.set(key, { ...r, count: 1 })
    },

    /** শুধু টেস্টের জন্য */
    peekClientErrors: () => [...clientErrors.values()],

    async ping() {},

    async close() {},
  }
}
