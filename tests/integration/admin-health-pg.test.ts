// Migration 014 (A2 health) on a REAL throwaway Postgres (npm run test:pg). Never point these URLs at a live database.
//   parity: the memory repo (unit tests) and the SQL functions return the same answers
//   privilege boundary: admin_app still has no table grants; pos_app cannot call admin_*; error_triage is invisible to the shop role
//   data minimisation: negative stock returns counts only
//   rollback: db/rollback/014_down.sql refuses to drop triage data silently
import { randomBytes, randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createMemoryAdmin } from "../../src/db/memory-admin.js"
import { createPgAdmin } from "../../src/db/pg-admin.js"

const SUPER = process.env.INTEGRATION_SUPERUSER_URL
const APP = process.env.INTEGRATION_DATABASE_URL
const ADMIN = process.env.INTEGRATION_ADMIN_DATABASE_URL
const MIGRATIONS = path.join(process.cwd(), "db", "migrations")
const ROLLBACK = path.join(process.cwd(), "db", "rollback", "014_down.sql")
const ENABLED = Boolean(SUPER && APP && ADMIN)
const HOUR = 3_600_000
const DAY = 24 * HOUR

const withDb = (url: string, db: string) => {
  const u = new URL(url)
  u.pathname = `/${db}`
  return u.toString()
}
const open = (url: string, max = 1) => postgres(url, { max, prepare: false, onnotice: () => {} })
async function sqlCode(p: PromiseLike<unknown>): Promise<string> {
  try {
    await p
    return "ok"
  } catch (e) {
    return (e as { code?: string }).code ?? "error"
  }
}

describe.skipIf(!ENABLED)("014: health functions, parity with the memory repo, privileges, rollback", () => {
  const name = `health_${randomBytes(4).toString("hex")}`
  let superSql: postgres.Sql
  let sup: postgres.Sql
  let asApp: postgres.Sql
  let asAdmin: postgres.Sql
  let pg: ReturnType<typeof createPgAdmin>
  const memory = createMemoryAdmin()
  const ids: Record<string, string> = {}
  const FP1 = "a".repeat(32)
  const FP2 = "b".repeat(32)

  async function seedStore(key: string, o: { status: string; createdAt: Date; lastSyncAt: Date | null }) {
    const id = randomUUID()
    const phone = `0171100${String(Object.keys(ids).length).padStart(4, "0")}`
    await sup`INSERT INTO stores (id, name, kind, status, grandfathered, trial_ends_at, created_at, last_sync_at, phone)
              VALUES (${id}, ${key}, 'pharmacy', ${o.status}, false, ${o.status === "trial" ? new Date(Date.now() + 5 * DAY) : null}, ${o.createdAt}, ${o.lastSyncAt}, ${phone})`
    await sup`INSERT INTO users (store_id, name, phone, password_hash, role, created_at) VALUES (${id}, 'Owner', ${phone}, 'scrypt$x', 'owner', ${o.createdAt})`
    memory.seedTenant({ id, name: key, status: o.status as never, createdAt: o.createdAt.toISOString(), lastSyncAt: o.lastSyncAt?.toISOString() ?? null, ownerPhone: phone, trialEndsAt: o.status === "trial" ? new Date(Date.now() + 5 * DAY).toISOString() : null })
    ids[key] = id
    return id
  }
  async function negativeBatch(storeId: string, qty: number, removed = false) {
    const pid = randomUUID()
    await sup`INSERT INTO products (id, store_id, name, sell_price_poisha) VALUES (${pid}, ${storeId}, 'গোপন পণ্যের নাম', 500)`
    await sup`INSERT INTO stock_batches (id, store_id, product_id, batch_no, expiry_date, qty_remaining, removed_at, removed_by_name, removed_reason)
              VALUES (${randomUUID()}, ${storeId}, ${pid}, 'B1', '2027-01-31', ${qty}, ${removed ? new Date() : null}, ${removed ? "x" : null}, ${removed ? "damaged" : null})`
  }

  beforeAll(async () => {
    superSql = open(SUPER ?? "")
    await superSql.unsafe(`CREATE DATABASE ${name}`)
    const mig = open(withDb(SUPER ?? "", name), 1)
    await mig`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`
    for (const f of (await readdir(MIGRATIONS)).filter((x) => x.endsWith(".sql")).sort()) await mig.unsafe(await readFile(path.join(MIGRATIONS, f), "utf8"))
    await mig.end({ timeout: 5 })
    sup = open(withDb(SUPER ?? "", name), 2)
    asApp = open(withDb(APP ?? "", name))
    asAdmin = open(withDb(ADMIN ?? "", name))
    pg = createPgAdmin({ connectionString: withDb(ADMIN ?? "", name), max: 4 })

    const now = Date.now()
    await seedStore("fresh", { status: "active", createdAt: new Date(now - 10 * DAY), lastSyncAt: new Date(now - HOUR) })
    await seedStore("stale", { status: "active", createdAt: new Date(now - 10 * DAY), lastSyncAt: new Date(now - 50 * HOUR) })
    await seedStore("never", { status: "trial", createdAt: new Date(now - 3 * DAY), lastSyncAt: null })
    await seedStore("gone", { status: "deleted", createdAt: new Date(now - 90 * DAY), lastSyncAt: null })
    // Dhaka's calendar day starts at 00:00 +06:00. Exactly at the boundary is today, one millisecond earlier is yesterday.
    const dhakaMidnight = Math.floor((now + 6 * HOUR) / DAY) * DAY - 6 * HOUR
    await seedStore("today", { status: "trial", createdAt: new Date(dhakaMidnight), lastSyncAt: new Date(now) })
    await seedStore("yesterday", { status: "trial", createdAt: new Date(dhakaMidnight - 1), lastSyncAt: new Date(now) })
    await seedStore("suspended", { status: "suspended", createdAt: new Date(now - 30 * DAY), lastSyncAt: new Date(now - 20 * DAY) })
    // client errors: the row the shop would have written via record_client_error (005)
    const err = (fp: string, last: Date, count: number, store: string | null, version: string | null) =>
      sup`INSERT INTO client_errors (fingerprint, first_at, last_at, count, store_id, kind, message, path, app_version)
          VALUES (${fp}, ${new Date(last.getTime() - DAY)}, ${last}, ${count}, ${store}, 'render', 'boom', '/sell/', ${version})`
    await err(FP1, new Date(now - HOUR), 7, ids.stale!, "abc1234")
    await err(FP2, new Date(now - 8 * DAY), 1, null, null)
    memory.seedClientError({ fingerprint: FP1, kind: "render", message: "boom", path: "/sell/", appVersion: "abc1234", count: 7, firstAt: new Date(now - HOUR - DAY).toISOString(), lastAt: new Date(now - HOUR).toISOString(), storeId: ids.stale! })
    memory.seedClientError({ fingerprint: FP2, kind: "render", message: "boom", path: "/sell/", appVersion: null, count: 1, firstAt: new Date(now - 9 * DAY).toISOString(), lastAt: new Date(now - 8 * DAY).toISOString(), storeId: null })
    // negative stock: fresh has 2 live negative batches (3 + 2 short) and one removed one that must not count; stale has a positive batch only
    await negativeBatch(ids.fresh!, -3)
    await negativeBatch(ids.fresh!, -2)
    await negativeBatch(ids.fresh!, -9, true)
    await negativeBatch(ids.stale!, 4)
    memory.seedNegativeStock(ids.fresh!, { batches: 2, unitsShort: 5 })
  }, 120_000)

  afterAll(async () => {
    await pg?.close()
    await asApp?.end({ timeout: 5 })
    await asAdmin?.end({ timeout: 5 })
    await sup?.end({ timeout: 5 })
    await superSql?.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    await superSql?.end({ timeout: 5 })
  })

  it("healthSync: SQL equals memory, oldest first, deleted left out, never-synced measured from creation", async () => {
    for (const q of [{ stuckHours: 24, limit: 100 }, { stuckHours: 60, limit: 100 }, { stuckHours: 24, limit: 1 }]) {
      const a = await pg.healthSync(q)
      const b = await memory.healthSync(q)
      // hoursSinceSync is floor((now - ref) / 1h); the two clocks differ by milliseconds, so compare it with a 1 h tolerance
      expect(a.total).toBe(b.total)
      expect(a.tenants.map((t) => t.id)).toEqual(b.tenants.map((t) => t.id))
      a.tenants.forEach((t, i) => expect(Math.abs(t.hoursSinceSync - b.tenants[i]!.hoursSinceSync)).toBeLessThanOrEqual(1))
    }
    expect((await pg.healthSync({ stuckHours: 24, limit: 100 })).tenants.map((t) => t.id)).toEqual([ids.never, ids.stale])
  })

  it("listClientErrors and triage: SQL equals memory; a triaged error leaves the open list; unknown fingerprint is null", async () => {
    for (const status of ["open", "resolved", "all"] as const) {
      expect(await pg.listClientErrors({ status, limit: 50 })).toEqual(await memory.listClientErrors({ status, limit: 50 }))
    }
    const admin = randomUUID()
    await sup`INSERT INTO platform_admins (id, email, name, role, password_hash) VALUES (${admin}, 'h@bipone.test', 'H', 'support', 'x')`
    const r = await pg.setErrorTriage({ fingerprint: FP1, status: "resolved", note: "fixed", adminId: admin })
    expect(r).toMatchObject({ fingerprint: FP1, status: "resolved", note: "fixed" })
    expect((await pg.listClientErrors({ status: "open", limit: 50 })).map((e) => e.fingerprint)).toEqual([FP2])
    expect((await pg.listClientErrors({ status: "resolved", limit: 50 }))[0]).toMatchObject({ fingerprint: FP1, note: "fixed", status: "resolved" })
    expect(await pg.setErrorTriage({ fingerprint: "c".repeat(32), status: "ignored", note: null, adminId: admin })).toBeNull()
    // reopen, to leave the table as the dashboard test expects
    await pg.setErrorTriage({ fingerprint: FP1, status: "open", note: null, adminId: admin })
    await memory.setErrorTriage({ fingerprint: FP1, status: "open", note: null, adminId: admin })
  })

  it("negativeStock: counts only, removed batches ignored, equals memory; no product name anywhere in the payload", async () => {
    const a = await pg.negativeStock({ limit: 100 })
    expect(a).toEqual(await memory.negativeStock({ limit: 100 }))
    expect(a.tenants).toEqual([{ id: ids.fresh, name: "fresh", status: "active", batches: 2, unitsShort: 5 }])
    expect(JSON.stringify(a)).not.toContain("গোপন")
  })

  it("a resolved error that recurs is open again in SQL and in memory; an ignored one stays ignored", async () => {
    const admin = (await sup<Array<{ id: string }>>`SELECT id FROM platform_admins LIMIT 1`)[0]!.id
    const later = new Date(Date.now() + 5_000)
    await pg.setErrorTriage({ fingerprint: FP1, status: "resolved", note: null, adminId: admin })
    await pg.setErrorTriage({ fingerprint: FP2, status: "ignored", note: null, adminId: admin })
    await memory.setErrorTriage({ fingerprint: FP1, status: "resolved", note: null, adminId: admin })
    await memory.setErrorTriage({ fingerprint: FP2, status: "ignored", note: null, adminId: admin })
    expect((await pg.listClientErrors({ status: "open", limit: 50 })).map((e) => e.fingerprint)).toEqual([])
    await sup`UPDATE client_errors SET last_at = ${later}, count = count + 1 WHERE fingerprint IN (${FP1}, ${FP2})`
    for (const fp of [FP1, FP2]) memory.seedClientError({ fingerprint: fp, kind: "render", message: "boom", path: "/sell/", appVersion: null, count: 9, firstAt: new Date().toISOString(), lastAt: later.toISOString(), storeId: null })
    const a = await pg.listClientErrors({ status: "open", limit: 50 })
    expect(a.map((e) => e.fingerprint)).toEqual([FP1])
    expect(a.map((e) => e.fingerprint)).toEqual((await memory.listClientErrors({ status: "open", limit: 50 })).map((e) => e.fingerprint))
    // put the table back for the tests below: a fresh decision after the recurrence, and the original last_at
    await sup`DELETE FROM error_triage`
    await sup`UPDATE client_errors SET last_at = CASE fingerprint WHEN ${FP1} THEN now() - interval '1 hour' ELSE now() - interval '8 days' END`
    memory.seedClientError({ fingerprint: FP1, kind: "render", message: "boom", path: "/sell/", appVersion: "abc1234", count: 7, firstAt: new Date(Date.now() - 25 * HOUR).toISOString(), lastAt: new Date(Date.now() - HOUR).toISOString(), storeId: ids.stale! })
    memory.seedClientError({ fingerprint: FP2, kind: "render", message: "boom", path: "/sell/", appVersion: null, count: 1, firstAt: new Date(Date.now() - 9 * DAY).toISOString(), lastAt: new Date(Date.now() - 8 * DAY).toISOString(), storeId: null })
    await memory.setErrorTriage({ fingerprint: FP1, status: "open", note: null, adminId: admin })
    await memory.setErrorTriage({ fingerprint: FP2, status: "open", note: null, adminId: admin })
  })

  it("the 30-day purge of client_errors takes its triage row with it (no orphans)", async () => {
    const admin = (await sup<Array<{ id: string }>>`SELECT id FROM platform_admins LIMIT 1`)[0]!.id
    const fp = "9".repeat(32)
    await sup`INSERT INTO client_errors (fingerprint, kind, message) VALUES (${fp}, 'window', 'tmp')`
    await pg.setErrorTriage({ fingerprint: fp, status: "ignored", note: null, adminId: admin })
    expect((await sup`SELECT count(*)::int AS n FROM error_triage WHERE fingerprint = ${fp}`)[0]!.n).toBe(1)
    await sup`DELETE FROM client_errors WHERE fingerprint = ${fp}`
    expect((await sup`SELECT count(*)::int AS n FROM error_triage WHERE fingerprint = ${fp}`)[0]!.n).toBe(0)
  })

  it("dashboard: SQL equals memory", async () => {
    expect(await pg.dashboard(24)).toEqual(await memory.dashboard(24))
    expect(await pg.dashboard(24)).toMatchObject({ stuckSync: 2, newErrors: 1, negativeStockTenants: 1, signupsToday: 1 }) // suspended and deleted are not stuck
  })

  it("privileges: admin_app still has NO table grants; pos_app cannot call the admin_* functions or read error_triage", async () => {
    const [{ n }] = await sup<Array<{ n: string }>>`SELECT count(*) AS n FROM information_schema.table_privileges WHERE grantee = 'admin_app'`
    expect(Number(n)).toBe(0)
    expect(await sqlCode(asAdmin`SELECT * FROM error_triage`)).toBe("42501")
    expect(await sqlCode(asAdmin`SELECT * FROM stock_batches`)).toBe("42501")
    expect(await sqlCode(asApp`SELECT * FROM error_triage`)).toBe("42501")
    for (const call of [asApp`SELECT * FROM admin_health_sync(24, 10)`, asApp`SELECT * FROM admin_dashboard(24)`, asApp`SELECT * FROM admin_health_negative_stock(10)`]) {
      expect(await sqlCode(call)).toBe("42501")
    }
    expect(await sqlCode(asAdmin`SELECT * FROM admin_dashboard(24)`)).toBe("ok")
  })

  it("input guards: out-of-range page sizes and statuses are refused by the functions themselves", async () => {
    expect(await sqlCode(asAdmin`SELECT * FROM admin_health_sync(0, 10)`)).toBe("P0001")
    expect(await sqlCode(asAdmin`SELECT * FROM admin_health_errors('bogus', 10)`)).toBe("P0001")
    expect(await sqlCode(asAdmin`SELECT * FROM admin_health_negative_stock(1000)`)).toBe("P0001")
    // NULL arguments cannot slip past the range checks (STRICT returns no rows; triage refuses NULL admin / bad status / empty note)
    expect(await asAdmin`SELECT * FROM admin_health_sync(NULL, NULL)`).toHaveLength(0)
    expect(await asAdmin`SELECT * FROM admin_health_errors(NULL, 10)`).toHaveLength(0)
    expect(await sqlCode(asAdmin`SELECT * FROM admin_error_triage_set(${FP1}, 'open', NULL, NULL)`)).toBe("P0001")
    expect(await sqlCode(asAdmin`SELECT * FROM admin_error_triage_set(${FP1}, 'bogus', NULL, ${randomUUID()})`)).toBe("P0001")
    expect(await sqlCode(sup`INSERT INTO error_triage (fingerprint, status) VALUES ('nothex', 'open')`)).toBe("23514")
  })

  it("dashboard and stuck-sync stay fast with 10,000 tenants (PRD: dashboard p95 < 1 s)", async () => {
    await sup`INSERT INTO stores (name, kind, status, grandfathered, created_at, last_sync_at, phone)
              SELECT 'bulk ' || g, 'pharmacy', 'active', false, now() - (g % 60) * interval '1 day', CASE WHEN g % 3 = 0 THEN NULL ELSE now() - (g % 100) * interval '1 hour' END,
                     '0199' || lpad(g::text, 7, '0')
              FROM generate_series(1, 10000) g`
    await sup`ANALYZE stores`
    const timed: number[] = []
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now()
      const d = await pg.dashboard(24)
      await pg.healthSync({ stuckHours: 24, limit: 100 })
      timed.push(performance.now() - t0)
      if (i === 0) expect(d.tenantsByStatus.active).toBeGreaterThanOrEqual(10_000)
    }
    timed.sort((a, b) => a - b)
    const p95 = timed[Math.ceil(timed.length * 0.95) - 1]!
    console.log(`A2: dashboard + stuck-sync with 10,000 tenants: p95=${p95.toFixed(1)} ms`)
    expect(p95).toBeLessThan(1000)
    await sup`DELETE FROM stores WHERE name LIKE 'bulk %'`
  }, 60_000)

  it("rollback 014: refuses while error_triage holds rows, then drops table and functions and clears its schema_migrations row", async () => {
    const sqlText = await readFile(ROLLBACK, "utf8")
    // a failed BEGIN...COMMIT script leaves its connection in an aborted transaction, so every script gets a fresh connection
    const run = async (text: string) => {
      const c = open(withDb(SUPER ?? "", name), 1)
      try {
        return await sqlCode(c.unsafe(text))
      } finally {
        await c.end({ timeout: 5 })
      }
    }
    {
      const admin = (await sup<Array<{ id: string }>>`SELECT id FROM platform_admins LIMIT 1`)[0]!.id
      await pg.setErrorTriage({ fingerprint: FP1, status: "ignored", note: "keep me", adminId: admin })
      expect((await sup`SELECT count(*)::int AS n FROM error_triage`)[0]!.n).toBeGreaterThan(0)
      expect(await run(sqlText)).toBe("P0001")
      expect((await sup`SELECT to_regclass('error_triage') AS t`)[0]!.t).not.toBeNull()
      expect(await run(`SET bipone.discard_error_triage = 'yes'; ${sqlText}`)).toBe("ok")
      expect((await sup`SELECT to_regclass('error_triage') AS t`)[0]!.t).toBeNull()
      expect((await sup`SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('admin_health_sync','admin_dashboard','admin_health_errors','admin_error_triage_set','admin_health_negative_stock')`)[0]!.n).toBe(0)
      expect((await sup`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '014_admin_health.sql'`)[0]!.n).toBe(0)
      // 012 and 013 are untouched
      expect((await sup`SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'admin_tenant_list'`)[0]!.n).toBe(1)
      // and 014 re-applies cleanly
      expect(await run(await readFile(path.join(MIGRATIONS, "014_admin_health.sql"), "utf8"))).toBe("ok")
      expect((await sup`SELECT to_regclass('error_triage') AS t`)[0]!.t).not.toBeNull()
    }
  })
})
