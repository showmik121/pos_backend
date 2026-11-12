import postgres from "postgres"
import { DomainError } from "../domain/errors.js"
import type { PublicUser, Repo, Store, UserWithHash } from "./types.js"

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

    close: () => sql.end({ timeout: 5 }),
  }
}
