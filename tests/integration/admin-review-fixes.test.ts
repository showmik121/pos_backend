// Fixes from the A0 database review, against a REAL throwaway Postgres (npm run test:pg). Each case gets its own database.
// Skipped unless the harness env is present. Never point these URLs at a live database.
import { randomBytes } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import postgres from "postgres"
import { afterAll, describe, expect, it } from "vitest"

const SUPER = process.env.INTEGRATION_SUPERUSER_URL
const APP = process.env.INTEGRATION_DATABASE_URL
const ADMIN = process.env.INTEGRATION_ADMIN_DATABASE_URL
const MIGRATIONS = path.join(process.cwd(), "db", "migrations")

const open = (url: string) => postgres(url, { max: 1, prepare: false, onnotice: () => {} })
const withDb = (url: string, db: string) => {
  const u = new URL(url)
  u.pathname = `/${db}`
  return u.toString()
}
const read = (...p: string[]) => readFile(path.join(process.cwd(), ...p), "utf8")
async function sqlCode(p: Promise<unknown>): Promise<string> {
  try {
    await p
    return "ok"
  } catch (e) {
    return (e as { code?: string }).code ?? "error"
  }
}

describe.skipIf(!SUPER || !APP || !ADMIN)("migration 012 review fixes", () => {
  const superSql = open(SUPER ?? "postgres://x@localhost/x")
  const created: string[] = []
  afterAll(async () => {
    for (const name of created) await superSql.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    await superSql.end({ timeout: 5 })
  })

  async function freshDb() {
    const name = `rv_${randomBytes(4).toString("hex")}`
    created.push(name)
    await superSql.unsafe(`CREATE DATABASE ${name}`)
    const db = open(withDb(SUPER ?? "", name))
    await db`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`
    for (const f of (await readdir(MIGRATIONS)).filter((x) => x.endsWith(".sql")).sort()) {
      await db.unsafe(await read("db", "migrations", f))
      await db`INSERT INTO schema_migrations (name) VALUES (${f}) ON CONFLICT (name) DO NOTHING`
    }
    return db
  }

  it("a store can never be 'trial' without a trial end date, whatever path inserted it", async () => {
    const db = await freshDb()
    try {
      expect(await sqlCode(db`INSERT INTO stores (name, status) VALUES ('no-end', 'trial')`)).toBe("23514")
      expect(await sqlCode(db`INSERT INTO stores (name, status, trial_ends_at) VALUES ('with-end', 'trial', now() + interval '14 days')`)).toBe("ok")
    } finally {
      await db.end({ timeout: 5 })
    }
  })

  it("rollback refuses to destroy operator audit rows unless explicitly told to, and drops only 012's own functions", async () => {
    const db = await freshDb()
    try {
      await db`SELECT admin_audit_append(NULL, 'admin', 'admins.create', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'ok', NULL)`
      // a function from a later phase must survive a rollback of 012 alone
      await db.unsafe(`CREATE FUNCTION admin_future_phase() RETURNS int LANGUAGE sql AS 'SELECT 1'`)
      const down = (await read("db", "rollback", "012_down.sql")).replace(/^DROP ROLE IF EXISTS admin_app;$/m, "")
      await db.unsafe(await read("db", "rollback", "013_down.sql")) // newest first: 013 depends on 012, and must keep admin_future_phase

      expect(await sqlCode(db.unsafe(down))).toBe("P0001")
      await db.unsafe("ROLLBACK").catch(() => undefined)
      const [still] = await db`SELECT count(*)::int AS c FROM pg_class WHERE relname = 'admin_audit_log'`
      expect(still!.c).toBe(1)

      // with the explicit override the rollback runs; the unrelated later-phase function is NOT dropped by name pattern
      await db.unsafe(`SET bipone.discard_admin_audit = 'yes';\n${down}`)
      const [gone] = await db`SELECT count(*)::int AS c FROM pg_class WHERE relname = 'admin_audit_log'`
      expect(gone!.c).toBe(0)
      const [kept] = await db`SELECT count(*)::int AS c FROM pg_proc WHERE proname = 'admin_future_phase'`
      expect(kept!.c).toBe(1)
    } finally {
      await db.end({ timeout: 5 })
    }
  })

  it("the last-super rule counts only ENROLLED super admins (an un-enrolled super cannot log in, so it is not a spare)", async () => {
    const db = await freshDb()
    try {
      const [a] = await db`SELECT admin_create('a@bipone.test', 'A', 'super', 'hash', 'enc-a', NULL) AS id`
      await db`SELECT admin_totp_confirm(${a!.id}, '{}'::text[], 1, 'enc-a')`
      await db`SELECT admin_create('b@bipone.test', 'B', 'super', 'hash', NULL, NULL)` // second super, never enrolled
      expect(await sqlCode(db`SELECT admin_set_role_active(${a!.id}, 'viewer', true)`)).toBe("P0001")
      const [still] = await db`SELECT role FROM platform_admins WHERE id = ${a!.id}`
      expect(still!.role).toBe("super")
    } finally {
      await db.end({ timeout: 5 })
    }
  })
})
