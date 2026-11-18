import postgres from "postgres"
import { DomainError } from "../domain/errors.js"
import type { NewSyncEvent, PublicUser, Repo, Store, SyncEvent, UserWithHash } from "./types.js"

// PostgreSQL (Supabase) রিপোজিটরি।
// - Supabase এর Transaction pooler (পোর্ট 6543) এর জন্য prepare:false লাগে।
// - প্রতিটি দোকান-সংক্রান্ত কাজ একটি ট্রানজ্যাকশনে চলে এবং শুরুতে set_config('app.store_id', …, true) বসায়,
//   ফলে RLS নীতি অন্য দোকানের সারি আটকে দেয়। ট্রানজ্যাকশন-লোকাল বলে pooler এ নিরাপদ।
// - অবশ্যই `pos_app` রোল দিয়ে সংযোগ করতে হবে (Supabase এর `postgres` রোল RLS এড়িয়ে যায়)।
// দ্রষ্টব্য: এই ফাইল এখনও আসল PostgreSQL এর বিরুদ্ধে চালিয়ে পরীক্ষা করা হয়নি।

const UNIQUE_VIOLATION = "23505"

type Tx = postgres.TransactionSql

function mapError(err: unknown): unknown {
  if ((err as { code?: string } | null)?.code === UNIQUE_VIOLATION) {
    return new DomainError("phone_taken", "এই নম্বরে আগেই অ্যাকাউন্ট আছে")
  }
  return err
}

export function createPgRepo(opts: { connectionString: string; max?: number }): Repo {
  const sql = postgres(opts.connectionString, {
    prepare: false,
    max: opts.max ?? 5,
    idle_timeout: 20,
    connect_timeout: 10,
  })

  async function withStore<T>(storeId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const result = await sql.begin(async (tx: Tx) => {
      await tx`SELECT set_config('app.store_id', ${storeId}, true)`
      return fn(tx)
    })
    return result as T
  }

  return {
    async registerStore({ storeName, storeKind, ownerName, phone, passwordHash }) {
      try {
        const rows = await sql<{ storeId: string; userId: string }[]>`
          SELECT store_id AS "storeId", user_id AS "userId"
          FROM auth_register_store(${storeName}, ${storeKind}, ${ownerName}, ${phone}, ${passwordHash})`
        return rows[0]
      } catch (err) {
        throw mapError(err)
      }
    },

    async findUserByPhone(phone) {
      const rows = await sql<UserWithHash[]>`
        SELECT id, store_id AS "storeId", name, phone, role, active, password_hash AS "passwordHash"
        FROM auth_find_user(${phone})`
      return rows[0] ?? null
    },

    getUser: (storeId, userId) =>
      withStore(storeId, async (tx) => {
        const rows = await tx<PublicUser[]>`
          SELECT id, store_id AS "storeId", name, phone, role, active FROM users WHERE id = ${userId}`
        return rows[0] ?? null
      }),

    getStore: (storeId) =>
      withStore(storeId, async (tx) => {
        const rows = await tx<Store[]>`SELECT id, name, kind FROM stores WHERE id = ${storeId}`
        return rows[0] ?? null
      }),

    createStaff: (storeId, { name, phone, passwordHash }) =>
      withStore(storeId, async (tx) => {
        try {
          const rows = await tx<PublicUser[]>`
            INSERT INTO users (store_id, name, phone, password_hash, role)
            VALUES (${storeId}, ${name}, ${phone}, ${passwordHash}, 'staff')
            RETURNING id, store_id AS "storeId", name, phone, role, active`
          return rows[0]
        } catch (err) {
          throw mapError(err)
        }
      }),

    listStaff: (storeId) =>
      withStore(storeId, async (tx) => {
        const rows = await tx<PublicUser[]>`
          SELECT id, store_id AS "storeId", name, phone, role, active FROM users ORDER BY created_at`
        return [...rows]
      }),

    setUserActive: (storeId, userId, active) =>
      withStore(storeId, async (tx) => {
        const rows = await tx<PublicUser[]>`
          UPDATE users SET active = ${active} WHERE id = ${userId}
          RETURNING id, store_id AS "storeId", name, phone, role, active`
        return rows[0] ?? null
      }),

    async throttle(bucket, max, windowSeconds) {
      const rows = await sql<{ ok: boolean }[]>`SELECT auth_throttle(${bucket}, ${max}, ${windowSeconds}) AS ok`
      return rows[0]?.ok === true
    },

    async ping() {
      await sql`SELECT 1`
    },

    async throttleReset(bucket) {
      await sql`SELECT auth_throttle_reset(${bucket})`
    },

    registerDevice: (storeId, deviceId) =>
      withStore(storeId, async (tx) => {
        // একসাথে দুই ডিভাইস নিবন্ধনে একই কোড না পড়ার জন্য দোকান-ভিত্তিক তালা
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`dev:${storeId}`}, 0))`
        const found = await tx<{ code: string }[]>`SELECT code FROM sync_devices WHERE device_id = ${deviceId}`
        if (found[0]) return found[0].code
        const used = await tx<{ code: string }[]>`SELECT code FROM sync_devices ORDER BY code`
        const free = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)).find((c) => !used.some((u: { code: string }) => u.code === c))
        if (!free) throw new DomainError("device_limit", "একটি দোকানে সর্বোচ্চ ২৬টি ডিভাইস যুক্ত করা যায়")
        await tx`INSERT INTO sync_devices (store_id, device_id, code) VALUES (${storeId}, ${deviceId}, ${free})`
        return free
      }),

    pushEvents: (storeId, userId, deviceId, events: NewSyncEvent[]) =>
      withStore(storeId, async (tx) => {
        // দোকানের push গুলো এক এক করে চলে, তাই seq-এর ক্রম আর commit-এর ক্রম মেলে (pull-এ কোনো ইভেন্ট বাদ পড়ে না)
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`push:${storeId}`}, 0))`
        const dev = await tx<{ code: string }[]>`SELECT code FROM sync_devices WHERE device_id = ${deviceId}`
        if (!dev[0]) throw new DomainError("device_unregistered", "এই ডিভাইস নিবন্ধিত নয়")
        for (const e of events) {
          await tx`
            INSERT INTO sync_events (store_id, id, device_code, user_id, kind, client_at, payload)
            VALUES (${storeId}, ${e.id}, ${dev[0].code}, ${userId}, ${e.kind}, ${e.at}, ${tx.json(e.payload as Parameters<typeof tx.json>[0])})
            ON CONFLICT (store_id, id) DO NOTHING`
        }
        return events.map((e) => e.id)
      }),

    pullEvents: (storeId, after, limit) =>
      withStore(storeId, async (tx) => {
        const rows = await tx<{ seq: string; id: string; kind: string; client_at: Date; device_code: string; user_id: string; payload: Record<string, unknown> }[]>`
          SELECT seq, id, kind, client_at, device_code, user_id, payload
          FROM sync_events WHERE seq > ${after} ORDER BY seq LIMIT ${limit + 1}`
        const page = rows.slice(0, limit)
        const events: SyncEvent[] = page.map((r: { seq: string; id: string; kind: string; client_at: Date; device_code: string; user_id: string; payload: Record<string, unknown> }) => ({
          seq: Number(r.seq),
          id: r.id,
          kind: r.kind,
          at: r.client_at.toISOString(),
          deviceCode: r.device_code,
          userId: r.user_id,
          payload: r.payload,
        }))
        return { events, lastSeq: events.length ? events[events.length - 1]!.seq : after, hasMore: rows.length > limit }
      }),

    close: () => sql.end({ timeout: 5 }),
  }
}
