// Migration 012 + admin privilege boundary, against a REAL throwaway Postgres (npm run test:pg).
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
async function sqlCode(p: Promise<unknown>): Promise<string> {
  try {
    await p
    return "ok"
  } catch (e) {
    return (e as { code?: string }).code ?? "error"
  }
}

describe.skipIf(!SUPER || !APP || !ADMIN)("migration 012: status columns", () => {
  const superSql = open(SUPER ?? "postgres://x@localhost/x")
  const dbName = `bk_${randomBytes(4).toString("hex")}`
  afterAll(async () => {
    await superSql.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
    await superSql.end({ timeout: 5 })
  })

  it("existing stores become active + grandfathered; new stores start a 14-day trial", async () => {
    const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort()
    const before = files.filter((f) => f < "012")
    const after = files.filter((f) => f >= "012")
    expect(after.length).toBeGreaterThan(0)

    await superSql.unsafe(`CREATE DATABASE ${dbName}`)
    const db = open(withDb(SUPER ?? "", dbName))
    try {
      await db`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`
      for (const f of before) await db.unsafe(await readFile(path.join(MIGRATIONS, f), "utf8"))
      const [old] = await db`INSERT INTO stores (name) VALUES ('পুরনো দোকান') RETURNING id`
      for (const f of after) await db.unsafe(await readFile(path.join(MIGRATIONS, f), "utf8"))

      const [row] = await db`SELECT status, grandfathered, trial_ends_at FROM stores WHERE id = ${old!.id}`
      expect(row).toMatchObject({ status: "active", grandfathered: true, trial_ends_at: null })

      const [made] = await db`SELECT store_id FROM auth_register_store('নতুন', 'pharmacy', 'মালিক', '01711111111', 'hash')`
      const [fresh] = await db`
        SELECT status, grandfathered, extract(epoch FROM (trial_ends_at - now()))::float8 AS left_secs
        FROM stores WHERE id = ${made!.store_id}`
      expect(fresh).toMatchObject({ status: "trial", grandfathered: false })
      const days = Number(fresh!.left_secs) / 86400
      expect(days).toBeGreaterThan(13.9)
      expect(days).toBeLessThanOrEqual(14)
    } finally {
      await db.end({ timeout: 5 })
    }
  })

  it("status values outside the state machine are rejected", async () => {
    const phone = `018${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`
    const [made] = await superSql`SELECT store_id FROM auth_register_store('চেক', 'pharmacy', 'মালিক', ${phone}, 'hash')`
    expect(await sqlCode(superSql`UPDATE stores SET status = 'bogus' WHERE id = ${made!.store_id}`)).toBe("23514")
    expect(await sqlCode(superSql`UPDATE stores SET status = 'suspended' WHERE id = ${made!.store_id}`)).toBe("ok")
  })

  it("rollback restores the pre-012 schema, keeps shop data, and 012 can be applied again", async () => {
    const rbName = `rb_${randomBytes(4).toString("hex")}`
    const read = (...p: string[]) => readFile(path.join(process.cwd(), ...p), "utf8")
    const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort()
    await superSql.unsafe(`CREATE DATABASE ${rbName}`)
    const db = open(withDb(SUPER ?? "", rbName))
    try {
      await db`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`
      for (const f of files) {
        await db.unsafe(await read("db", "migrations", f))
        await db`INSERT INTO schema_migrations (name) VALUES (${f}) ON CONFLICT (name) DO NOTHING` // 012 records itself
      }
      const [s] = await db`SELECT store_id FROM auth_register_store('রোলব্যাক', 'pharmacy', 'মালিক', '01822222222', 'hash')`

      // Roles are cluster-wide and other tests share this cluster, so DROP ROLE is excluded here
      // (it is exercised in the staging rehearsal). Everything database-local is rolled back for real.
      const down = (await read("db", "rollback", "012_down.sql")).replace(/^DROP ROLE IF EXISTS admin_app;$/m, "")
      expect(down).not.toContain("DROP ROLE IF EXISTS admin_app;")
      await db.unsafe(await read("db", "rollback", "013_down.sql")) // newest first: 013 depends on 012 (docs/RUNBOOK.md)
      await db.unsafe(down)

      const cols = await db`SELECT column_name FROM information_schema.columns WHERE table_name = 'stores' AND column_name IN ('status','grandfathered','trial_ends_at')`
      expect(cols).toEqual([])
      const gone = await db`SELECT relname FROM pg_class WHERE relname IN ('platform_admins','admin_sessions','admin_audit_log')`
      expect(gone).toEqual([])
      const fns = await db`SELECT proname FROM pg_proc WHERE proname LIKE 'admin\_%'`
      expect(fns).toEqual([])
      const [kept] = await db`SELECT name FROM stores WHERE id = ${s!.store_id}`
      expect(kept!.name).toBe("রোলব্যাক")
      await db`SELECT store_id FROM auth_register_store('পুরনো-সাইনআপ', 'pharmacy', 'মালিক', '01833333333', 'hash')` // 001 function works again
      const [mig] = await db`SELECT count(*)::int AS c FROM schema_migrations WHERE name = '012_admin_foundations.sql'`
      expect(mig!.c).toBe(0)

      await db.unsafe(await read("db", "migrations", "012_admin_foundations.sql")) // re-apply
      const [again] = await db`SELECT status, grandfathered FROM stores WHERE id = ${s!.store_id}`
      expect(again).toMatchObject({ status: "active", grandfathered: true })
    } finally {
      await db.end({ timeout: 5 })
      await superSql.unsafe(`DROP DATABASE IF EXISTS ${rbName} WITH (FORCE)`)
    }
  })
})

describe.skipIf(!SUPER || !APP || !ADMIN)("admin_app privilege boundary (acceptance 4)", () => {
  const superSql = open(SUPER ?? "postgres://x@localhost/x")
  const adminSql = open(ADMIN ?? "postgres://x@localhost/x")
  const appSql = open(APP ?? "postgres://x@localhost/x")
  afterAll(async () => {
    await Promise.all([superSql.end({ timeout: 5 }), adminSql.end({ timeout: 5 }), appSql.end({ timeout: 5 })])
  })

  it("admin_app cannot read sync_events.payload, stores, users, or any shop table", async () => {
    expect(await sqlCode(adminSql`SELECT payload FROM sync_events LIMIT 1`)).toBe("42501")
    expect(await sqlCode(adminSql`SELECT * FROM sync_events LIMIT 1`)).toBe("42501")
    expect(await sqlCode(adminSql`SELECT * FROM stores LIMIT 1`)).toBe("42501")
    expect(await sqlCode(adminSql`SELECT * FROM users LIMIT 1`)).toBe("42501")
    expect(await sqlCode(adminSql`SELECT * FROM sales LIMIT 1`)).toBe("42501")
    expect(await sqlCode(adminSql`SELECT * FROM customers LIMIT 1`)).toBe("42501")
  })

  it("admin_app holds no table or column privilege at all", async () => {
    const tables = await superSql`
      SELECT c.relname FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p','v','m')
        AND (has_table_privilege('admin_app', c.oid, 'SELECT') OR has_table_privilege('admin_app', c.oid, 'INSERT')
          OR has_table_privilege('admin_app', c.oid, 'UPDATE') OR has_table_privilege('admin_app', c.oid, 'DELETE'))`
    expect(tables).toEqual([])
    const cols = await superSql`SELECT table_name, column_name FROM information_schema.column_privileges WHERE grantee = 'admin_app'`
    expect(cols).toEqual([])
  })

  it("admin_app is not a superuser and does not bypass RLS", async () => {
    const [r] = await superSql`SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = 'admin_app'`
    expect(r).toEqual({ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false })
  })

  it("admin_app can execute only admin_* functions", async () => {
    const leaks = await superSql`
      SELECT proname FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace AND has_function_privilege('admin_app', oid, 'EXECUTE')
        AND proname NOT LIKE 'admin\_%'`
    expect(leaks).toEqual([])
    const granted = await superSql`
      SELECT count(*)::int AS c FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'admin\_%' AND has_function_privilege('admin_app', oid, 'EXECUTE')`
    expect(granted[0]!.c).toBeGreaterThan(0)
  })

  it("every admin_* function is SECURITY DEFINER with a fixed search_path and no PUBLIC/pos_app execute", async () => {
    const fns = await superSql`
      SELECT proname, prosecdef, proconfig, has_function_privilege('pos_app', oid, 'EXECUTE') AS app_exec
      FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'admin\_%'`
    expect(fns.length).toBeGreaterThan(0)
    for (const f of fns) {
      expect(f.prosecdef, f.proname).toBe(true)
      expect((f.proconfig ?? []).join(","), f.proname).toContain("search_path=public, pg_temp")
      expect(f.app_exec, f.proname).toBe(false)
    }
    const publicExec = await superSql`
      SELECT p.proname FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'admin\_%' AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'`
    expect(publicExec).toEqual([])
  })

  it("pos_app (the shop API role) cannot touch the admin tables or call admin functions", async () => {
    expect(await sqlCode(appSql`SELECT * FROM platform_admins LIMIT 1`)).toBe("42501")
    expect(await sqlCode(appSql`SELECT * FROM admin_sessions LIMIT 1`)).toBe("42501")
    expect(await sqlCode(appSql`SELECT * FROM admin_audit_log LIMIT 1`)).toBe("42501")
    expect(await sqlCode(appSql`SELECT * FROM admin_find_by_email('x@example.com')`)).toBe("42501")
  })

  it("admin tables have RLS enabled", async () => {
    const rows = await superSql`
      SELECT relname, relrowsecurity FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relname IN ('platform_admins','admin_sessions','admin_audit_log')`
    expect(rows.length).toBe(3)
    for (const r of rows) expect(r.relrowsecurity, r.relname).toBe(true)
  })

  it("the audit log is append-only even for the table owner", async () => {
    const [id] = await superSql`
      SELECT admin_audit_append(NULL, 'cli', 'test.append', 'test', 't1', NULL, NULL, NULL, NULL, NULL, NULL, 'ok', NULL) AS id`
    expect(id!.id).toBeTruthy()
    expect(await sqlCode(superSql`UPDATE admin_audit_log SET action = 'tampered' WHERE id = ${id!.id}`)).not.toBe("ok")
    expect(await sqlCode(superSql`DELETE FROM admin_audit_log WHERE id = ${id!.id}`)).not.toBe("ok")
  })
})
