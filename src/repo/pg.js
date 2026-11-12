import pg from 'pg';
import { DomainError } from '../domain/errors.js';

// PostgreSQL রিপোজিটরি। প্রতিটি দোকান-সংক্রান্ত কাজ একটি ট্রানজ্যাকশনে চলে এবং শুরুতে
// set_config('app.store_id', …) বসায়, ফলে RLS নীতি অন্য দোকানের সারি আটকে দেয়।
// দ্রষ্টব্য: এই ফাইল এখনও আসল PostgreSQL এর বিরুদ্ধে চালিয়ে পরীক্ষা করা হয়নি।

const UNIQUE_VIOLATION = '23505';

const userCols = 'id, store_id AS "storeId", name, phone, role, active';

export function createPgRepo({ connectionString, max = 10 }) {
  const pool = new pg.Pool({ connectionString, max });

  async function withStore(storeId, fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.store_id', $1, true)", [storeId]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  const mapUnique = (err) => {
    if (err?.code === UNIQUE_VIOLATION) return new DomainError('phone_taken', 'এই নম্বরে আগেই অ্যাকাউন্ট আছে');
    return err;
  };

  return {
    async registerStore({ storeName, storeKind, ownerName, phone, passwordHash }) {
      try {
        const { rows } = await pool.query(
          'SELECT store_id AS "storeId", user_id AS "userId" FROM auth_register_store($1, $2, $3, $4, $5)',
          [storeName, storeKind, ownerName, phone, passwordHash],
        );
        return rows[0];
      } catch (err) {
        throw mapUnique(err);
      }
    },

    async findUserByPhone(phone) {
      const { rows } = await pool.query(
        'SELECT id, store_id AS "storeId", name, phone, role, active, password_hash AS "passwordHash" FROM auth_find_user($1)',
        [phone],
      );
      return rows[0] ?? null;
    },

    getUser: (storeId, userId) =>
      withStore(storeId, async (c) => {
        const { rows } = await c.query(`SELECT ${userCols} FROM users WHERE id = $1`, [userId]);
        return rows[0] ?? null;
      }),

    getStore: (storeId) =>
      withStore(storeId, async (c) => {
        const { rows } = await c.query('SELECT id, name, kind FROM stores WHERE id = $1', [storeId]);
        return rows[0] ?? null;
      }),

    createStaff: (storeId, { name, phone, passwordHash }) =>
      withStore(storeId, async (c) => {
        try {
          const { rows } = await c.query(
            `INSERT INTO users (store_id, name, phone, password_hash, role)
             VALUES ($1, $2, $3, $4, 'staff') RETURNING ${userCols}`,
            [storeId, name, phone, passwordHash],
          );
          return rows[0];
        } catch (err) {
          throw mapUnique(err);
        }
      }),

    listStaff: (storeId) =>
      withStore(storeId, async (c) => {
        const { rows } = await c.query(`SELECT ${userCols} FROM users ORDER BY created_at`);
        return rows;
      }),

    setUserActive: (storeId, userId, active) =>
      withStore(storeId, async (c) => {
        const { rows } = await c.query(
          `UPDATE users SET active = $2 WHERE id = $1 RETURNING ${userCols}`,
          [userId, active],
        );
        return rows[0] ?? null;
      }),

    close: () => pool.end(),
  };
}
