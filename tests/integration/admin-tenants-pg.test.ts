// Migration 013 + tenant ops on a REAL throwaway Postgres (npm run test:pg). Each describe gets its own scratch database so counts and
// the "no other tenants" parity assertions are deterministic. Never point these URLs at a live database.
//   acceptance 1: a Support admin POSTing /tenants/:id/suspend gets 403 plus a denied audit row
//   acceptance 2: a Super admin with step-up suspends -> the shop's next sync/login says tenant_suspended, audit row, owner notice, data untouched
//   acceptance 7: 10,000 tenants filtered by "no sync for 3 days" in under 500 ms (p95) with correct counts
import { randomBytes, randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createApp } from "../../server/app.js"
import { encryptSecret } from "../../src/auth/admin-crypto.js"
import { hashPassword } from "../../src/auth/password.js"
import { generateTotpSecret, totpCode } from "../../src/auth/totp.js"
import type { TenantListQuery } from "../../src/contract/admin-api.js"
import type { AdminRepo } from "../../src/db/admin.js"
import { createMemoryAdmin } from "../../src/db/memory-admin.js"
import { createPgAdmin } from "../../src/db/pg-admin.js"
import { createPgRepo } from "../../src/db/pg.js"
import type { StoreStatus } from "../../src/db/types.js"
import { nextStatus, type TenantStatusAction } from "../../src/domain/tenant-admin.js"

const SUPER = process.env.INTEGRATION_SUPERUSER_URL
const APP = process.env.INTEGRATION_DATABASE_URL
const ADMIN = process.env.INTEGRATION_ADMIN_DATABASE_URL
const ENC_KEY = randomBytes(32).toString("base64")
const PASSWORD = "Correct-Horse-Battery-9"
const SHOP_PASSWORD = "Sobuj#Ghar2026"
const MIGRATIONS = path.join(process.cwd(), "db", "migrations")
const ENABLED = Boolean(SUPER && APP && ADMIN)

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
const code = (secret: string, offsetSteps = 0) => totpCode(secret, Math.floor(Date.now() / 1000 / 30) + offsetSteps)

/** a scratch database with every migration applied, plus the three role connections */
async function makeDb(prefix: string) {
  const superSql = open(SUPER ?? "")
  const name = `${prefix}_${randomBytes(4).toString("hex")}`
  await superSql.unsafe(`CREATE DATABASE ${name}`)
  // a multi-statement migration file (BEGIN ... COMMIT) needs a single connection; queries afterwards use a small pool
  const mig = open(withDb(SUPER ?? "", name), 1)
  await mig`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`
  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort()
  for (const f of files) await mig.unsafe(await readFile(path.join(MIGRATIONS, f), "utf8"))
  await mig.end({ timeout: 5 })
  const sup = open(withDb(SUPER ?? "", name), 2)
  const adminRepo = createPgAdmin({ connectionString: withDb(ADMIN ?? "", name), max: 4 })
  const shopRepo = createPgRepo({ connectionString: withDb(APP ?? "", name), max: 3 })
  const asApp = open(withDb(APP ?? "", name))
  const asAdmin = open(withDb(ADMIN ?? "", name))
  return {
    name, sup, adminRepo, shopRepo, asApp, asAdmin,
    async drop() {
      await adminRepo.close()
      await shopRepo.close()
      await asApp.end({ timeout: 5 })
      await asAdmin.end({ timeout: 5 })
      await sup.end({ timeout: 5 })
      await superSql.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      await superSql.end({ timeout: 5 })
    },
  }
}
type Db = Awaited<ReturnType<typeof makeDb>>

interface SeedStore {
  name: string
  kind?: "pharmacy" | "cosmetics" | "other"
  status?: StoreStatus
  trialEndsAt?: Date | null
  createdAt: Date
  lastSyncAt?: Date | null
  ownerPhone: string
  ownerName?: string
  staffPhones?: string[]
  devices?: number
}
async function seedStore(sup: postgres.Sql, s: SeedStore): Promise<string> {
  const status = s.status ?? "active"
  const trial = s.trialEndsAt === undefined ? (status === "trial" ? new Date(Date.now() + 5 * 86_400_000) : null) : s.trialEndsAt
  const [row] = await sup<Array<{ id: string }>>`
    INSERT INTO stores (name, kind, status, grandfathered, trial_ends_at, created_at, last_sync_at, phone)
    VALUES (${s.name}, ${s.kind ?? "pharmacy"}, ${status}, false, ${trial}, ${s.createdAt}, ${s.lastSyncAt ?? null}, ${s.ownerPhone}) RETURNING id`
  const id = row!.id
  await sup`INSERT INTO users (store_id, name, phone, password_hash, role, created_at)
            VALUES (${id}, ${s.ownerName ?? "Owner"}, ${s.ownerPhone}, 'scrypt$HASH-MARKER-owner', 'owner', ${s.createdAt})`
  for (const p of s.staffPhones ?? []) {
    await sup`INSERT INTO users (store_id, name, phone, password_hash, role, created_at) VALUES (${id}, 'Staff', ${p}, 'scrypt$HASH-MARKER-staff', 'staff', ${s.createdAt})`
  }
  for (let i = 0; i < (s.devices ?? 0); i++) {
    await sup`INSERT INTO sync_devices (store_id, device_id, code, created_at) VALUES (${id}, ${randomUUID()}, ${String.fromCharCode(65 + i)}, ${s.createdAt})`
  }
  return id
}

// ======================================================================================================================
describe.skipIf(!ENABLED)("013: memory repo and SQL agree (parity)", () => {
  let db: Db
  const ids: Record<string, string> = {}
  const memory = createMemoryAdmin()
  const day = 86_400_000
  const base = Date.parse("2026-01-10T06:00:00.000Z")

  beforeAll(async () => {
    db = await makeDb("par")
    const now = Date.now()
    const rows: Array<SeedStore & { key: string }> = [
      { key: "a", name: "Alpha Pharmacy", kind: "pharmacy", status: "active", createdAt: new Date(base), lastSyncAt: new Date(now - 1 * day), ownerPhone: "01711000001", staffPhones: ["01811000001"], devices: 2 },
      { key: "b", name: "beta cosmetics", kind: "cosmetics", status: "suspended", createdAt: new Date(base + 1 * day), lastSyncAt: new Date(now - 6 * day), ownerPhone: "01711000002", devices: 1 },
      { key: "c", name: "Charlie", kind: "other", status: "trial", createdAt: new Date(base + 2 * day), lastSyncAt: null, ownerPhone: "01711000003" },
      { key: "d", name: "দোকান বাংলা", kind: "pharmacy", status: "grace", createdAt: new Date(base + 3 * day), lastSyncAt: new Date(now - 2 * 3_600_000), ownerPhone: "01711000004", staffPhones: ["01811000004", "01911000004"] },
      { key: "e", name: "Delta 100% Pharma", kind: "pharmacy", status: "read_only", createdAt: new Date(base + 4 * day), lastSyncAt: new Date(now - 10 * day), ownerPhone: "01711000005" },
      { key: "f", name: "echo_store", kind: "cosmetics", status: "active", createdAt: new Date(base + 5 * day), lastSyncAt: null, ownerPhone: "01711000006", devices: 3 },
      { key: "g", name: "Foxtrot", kind: "pharmacy", status: "active", createdAt: new Date(base + 5 * day), lastSyncAt: new Date(now - 30 * 60_000), ownerPhone: "01711000007" }, // same createdAt as f: id breaks the tie
      { key: "h", name: "Golf", kind: "other", status: "cancelled", createdAt: new Date(base + 7 * day), lastSyncAt: new Date(now - 40 * day), ownerPhone: "01711000008" },
    ]
    for (const r of rows) {
      const id = await seedStore(db.sup, r)
      ids[r.key] = id
      memory.seedTenant({
        id, name: r.name, kind: r.kind, ownerName: "Owner", ownerPhone: r.ownerPhone, status: r.status, createdAt: r.createdAt.toISOString(),
        trialEndsAt: r.status === "trial" ? new Date(now + 5 * day).toISOString() : null, lastSyncAt: r.lastSyncAt?.toISOString() ?? null, devices: r.devices ?? 0,
      })
      for (const p of r.staffPhones ?? []) memory.seedStaff(id, { name: "Staff", phone: p, role: "staff" })
    }
  }, 60_000)
  afterAll(async () => { await db?.drop() })

  const strip = (r: { tenants: unknown[]; total: number; nextCursor: string | null }) => JSON.stringify({ ...r, tenants: (r.tenants as Array<Record<string, unknown>>).map(({ trialEndsAt: _t, ...rest }) => rest) })
  const q = (o: Partial<TenantListQuery> = {}): TenantListQuery => ({ sort: "created", dir: "desc", limit: 50, ...o })

  const cases: Array<[string, Partial<TenantListQuery>]> = [
    ["default (newest first)", {}],
    ["created asc", { dir: "asc" }],
    ["name asc (case-insensitive, Bengali last)", { sort: "name", dir: "asc" }],
    ["name desc", { sort: "name", dir: "desc" }],
    ["lastSync asc (never synced first)", { sort: "lastSync", dir: "asc" }],
    ["lastSync desc", { sort: "lastSync", dir: "desc" }],
    ["status asc", { sort: "status", dir: "asc" }],
    ["status filter", { status: "suspended" }],
    ["kind filter", { kind: "cosmetics" }],
    ["noSyncDays=3 (stale + never)", { noSyncDays: 3 }],
    ["name search is case-insensitive", { q: "ALPHA" }],
    ["owner phone search", { q: "01711000003" }],
    ["staff phone search", { q: "01911000004" }],
    ["partial phone digits match nothing (masking cannot be probed)", { q: "0171100" }],
    ["phone suffix matches nothing", { q: "11000003" }],
    ["id search", { q: "__ID_E__" }],
    ["LIKE metacharacters are literals: %", { q: "%" }],
    ["LIKE metacharacters are literals: _", { q: "_" }],
    ["limit 3 offset 0", { limit: 3 }],
  ]
  it.each(cases)("list parity: %s", async (_label, query) => {
    const qq = { ...query }
    if (qq.q === "__ID_E__") qq.q = ids.e!.slice(0, 13)
    const [m, p] = await Promise.all([memory.listTenants(q(qq)), db.adminRepo.listTenants(q(qq))])
    expect(strip(p)).toBe(strip(m))
    // trial end is compared loosely (the two sides computed "now + 5 days" at slightly different instants)
    for (let i = 0; i < p.tenants.length; i++) expect(Boolean(p.tenants[i]!.trialEndsAt)).toBe(Boolean(m.tenants[i]!.trialEndsAt))
  })

  it("paging by cursor walks the same sequence in both", async () => {
    const walk = async (repo: AdminRepo) => {
      const seen: string[] = []
      let cursor: string | undefined
      do {
        const page = await repo.listTenants(q({ limit: 3, sort: "name", dir: "asc", cursor }))
        seen.push(...page.tenants.map((t) => t.id))
        cursor = page.nextCursor ?? undefined
      } while (cursor)
      return seen
    }
    const [m, p] = [await walk(memory), await walk(db.adminRepo)]
    expect(p).toEqual(m)
    expect(new Set(p).size).toBe(8)
  })

  it("detail parity: staff masked and ordered, devices by code", async () => {
    const [m, p] = await Promise.all([memory.getTenant(ids.a!), db.adminRepo.getTenant(ids.a!)])
    expect(p!.tenant.deviceCount).toBe(m!.tenant.deviceCount)
    expect(p!.staff.map((s) => [s.role, s.phoneMasked])).toEqual(m!.staff.map((s) => [s.role, s.phoneMasked]))
    expect(p!.devices.map((d) => d.code)).toEqual(m!.devices.map((d) => d.code))
  })
})

// ======================================================================================================================
describe.skipIf(!ENABLED)("013: privileges, data minimisation, transitions, and acceptance 1 and 2 over HTTP", () => {
  let db: Db
  let app: ReturnType<typeof createApp>
  const stamp = () => randomBytes(3).toString("hex")

  beforeAll(async () => {
    db = await makeDb("ten")
    app = createApp({ repo: db.shopRepo, jwtSecret: "s".repeat(40), admin: { repo: db.adminRepo, jwtSecret: "a".repeat(40), totpEncKey: ENC_KEY } })
  }, 60_000)
  afterAll(async () => { await db?.drop() })

  async function call(method: string, p: string, o: { body?: unknown; token?: string } = {}) {
    const res = await app.fetch(
      new Request(`https://edge.test/api${p}`, {
        method,
        headers: { "content-type": "application/json", "x-real-ip": "10.9.9.9", "user-agent": "vitest", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) },
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
      }),
    )
    const text = await res.text()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, json: (text ? JSON.parse(text) : null) as any, raw: text }
  }
  async function signedIn(role: "super" | "support" | "finance" | "viewer", withStepUp: boolean) {
    const secret = generateTotpSecret()
    const secretEnc = encryptSecret(secret, ENC_KEY)
    const email = `${role}-${stamp()}@bipone.test`
    const id = await db.adminRepo.createAdmin({ email, name: `Name ${role}`, role, passwordHash: await hashPassword(PASSWORD), totpSecretEnc: secretEnc, createdBy: null })
    await db.adminRepo.totpConfirm(id, [], 0, secretEnc)
    const login = await call("POST", "/v1/admin/auth/login", { body: { email, password: PASSWORD } })
    const full = await call("POST", "/v1/admin/auth/2fa", { token: login.json.pendingToken, body: { code: code(secret) } })
    expect(full.status, full.raw).toBe(200)
    const token = full.json.token as string
    if (withStepUp) expect((await call("POST", "/v1/admin/auth/step-up", { token, body: { password: PASSWORD, code: code(secret, 1) } })).status).toBe(200)
    return { id, token }
  }
  const phone = () => `019${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`
  async function newShop(ph = phone()) {
    const r = await call("POST", "/v1/auth/register-store", { body: { storeName: "সবুজ দোকান", ownerName: "করিম", phone: ph, storeKind: "pharmacy", password: SHOP_PASSWORD } })
    expect(r.status, r.raw).toBe(201)
    const me = await call("GET", "/v1/me", { token: r.json.token })
    return { token: r.json.token as string, phone: ph, storeId: me.json.store.id as string }
  }
  const DEV = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"

  it("013 is recorded; admin_app and pos_app have no direct table access; the internal reason is unreadable to the shop role", async () => {
    expect((await db.sup`SELECT 1 FROM schema_migrations WHERE name = '013_admin_tenant_ops.sql'`).length).toBe(1)
    expect(await sqlCode(db.asAdmin`SELECT * FROM tenant_notes`)).toBe("42501")
    expect(await sqlCode(db.asAdmin`SELECT * FROM tenant_status_events`)).toBe("42501")
    expect(await sqlCode(db.asAdmin`SELECT * FROM stores`)).toBe("42501")
    expect(await sqlCode(db.asApp`SELECT * FROM tenant_notes`)).toBe("42501")
    expect(await sqlCode(db.asApp`SELECT reason FROM tenant_status_events`)).toBe("42501") // the column grant leaves it out
    expect(await sqlCode(db.asApp`SELECT admin_id FROM tenant_status_events`)).toBe("42501")
    expect(await sqlCode(db.asApp`SELECT at, to_status, message FROM tenant_status_events`)).toBe("ok")
    expect(await sqlCode(db.asApp`INSERT INTO tenant_status_events (store_id, from_status, to_status, reason) VALUES (gen_random_uuid(), 'active', 'suspended', 'x')`)).toBe("42501")
    expect(await sqlCode(db.asApp`UPDATE stores SET status = 'suspended'`)).toBe("42501") // the shop role cannot change status or last_sync_at directly
  })

  it("function privileges: the shop role cannot call admin functions, the admin role cannot call the shop touch", async () => {
    for (const fn of ["admin_tenant_list(NULL,NULL,NULL,NULL,'created','desc',1,0)", "admin_tenant_phones(gen_random_uuid())", "admin_audit_list(NULL,NULL,NULL,NULL,NULL,NULL,NULL,1)"]) {
      expect(await sqlCode(db.asApp.unsafe(`SELECT * FROM ${fn}`)), fn).toBe("42501")
    }
    expect(await sqlCode(db.asAdmin`SELECT sync_touch_store()`)).toBe("42501")
    expect(await sqlCode(db.asApp`SELECT sync_touch_store()`)).toBe("ok")
    const leaks = await db.sup`
      SELECT p.proname FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'admin\_%'
         AND has_function_privilege('pos_app', p.oid, 'EXECUTE')`
    expect(leaks).toEqual([])
  })

  it("data minimisation: no admin function returns payloads, password hashes, full staff phones, device ids or stack traces", async () => {
    const id = await seedStore(db.sup, { name: "Minimal Pharma", createdAt: new Date(), ownerPhone: "01711777001", staffPhones: ["01811777002"], devices: 1 })
    const [dev] = await db.sup<Array<{ device_id: string; code: string }>>`SELECT device_id, code FROM sync_devices WHERE store_id = ${id}`
    const [owner] = await db.sup<Array<{ id: string }>>`SELECT id FROM users WHERE store_id = ${id} AND role = 'owner'`
    await db.sup`INSERT INTO sync_events (store_id, id, device_code, user_id, kind, client_at, payload)
                 VALUES (${id}, ${randomUUID()}, ${dev!.code}, ${owner!.id}, 'sale_completed', now(), ${db.sup.json({ costPoisha: 99999, note: "PAYLOAD-MARKER" })})`
    await db.sup`INSERT INTO client_errors (fingerprint, store_id, kind, message, stack, path, user_agent)
                 VALUES (${randomUUID()}, ${id}, 'render', 'boom', 'STACK-MARKER', '/secret/path', 'UA-MARKER')`
    const sa = await signedIn("super", false)
    await db.adminRepo.addNote(id, sa.id, "a note", ["vip"])
    const dump = JSON.stringify([await db.adminRepo.getTenant(id), await db.adminRepo.listTenants({ sort: "created", dir: "desc", limit: 100, q: "Minimal" }), await db.adminRepo.listNotes(id), (await db.adminRepo.listAudit({ limit: 200 })).rows])
    for (const secret of ["HASH-MARKER", "PAYLOAD-MARKER", "99999", "01811777002", "01711777001", dev!.device_id, "STACK-MARKER", "/secret/path", "UA-MARKER"]) {
      expect(dump, secret).not.toContain(secret)
    }
    const detail = await db.adminRepo.getTenant(id)
    expect(detail!.tenant.lastEventAt).toEqual(expect.any(String)) // the timestamp is available, the content is not
    expect(detail!.recentErrors[0]).toMatchObject({ kind: "render", message: "boom" })
    expect(await db.adminRepo.revealPhones(id)).toEqual([expect.objectContaining({ role: "owner", phone: "01711777001" }), expect.objectContaining({ role: "staff", phone: "01811777002" })])
    expect(await db.adminRepo.revealPhones(randomUUID())).toBeNull()
  })

  it("the status machine: SQL and src/domain/tenant-admin.ts agree for every status x action x trial state", async () => {
    const statuses: StoreStatus[] = ["trial", "active", "grace", "read_only", "suspended", "pending_deletion", "deleted", "cancelled"]
    const actions: TenantStatusAction[] = ["suspend", "read_only", "reactivate"]
    const admin = await signedIn("super", false)
    for (const status of statuses) {
      for (const action of actions) {
        for (const trialEnded of [false, true]) {
          // 'trial' needs an end date (CHECK); for the others the trial state only matters to reactivate
          const trialEndsAt = status === "trial" && trialEnded ? new Date(Date.now() - 86_400_000) : new Date(Date.now() + (trialEnded ? -1 : 1) * 3 * 86_400_000)
          const id = await seedStore(db.sup, { name: `m-${status}-${action}-${trialEnded}`, status, trialEndsAt, createdAt: new Date(), ownerPhone: phone() })
          const expected = nextStatus(action, status, trialEndsAt.toISOString(), Date.now())
          const got = await db.adminRepo.changeTenantStatus({ storeId: id, action, adminId: admin.id, reason: "parity", message: null }).then((r) => r.toStatus, (e) => (e as { code?: string }).code)
          expect(got, `${status} --${action}--> (trial ended: ${trialEnded})`).toBe(expected ?? "invalid_transition")
        }
      }
    }
  }, 60_000)

  it("two racing suspends: exactly one wins, one history row, no double change", async () => {
    const id = await seedStore(db.sup, { name: "Race", createdAt: new Date(), ownerPhone: phone() })
    const admin = await signedIn("super", false)
    const attempt = () => db.adminRepo.changeTenantStatus({ storeId: id, action: "suspend", adminId: admin.id, reason: "race", message: null }).then(() => "ok", (e) => (e as { code?: string }).code)
    const results = (await Promise.all([attempt(), attempt(), attempt()])).sort()
    expect(results).toEqual(["invalid_transition", "invalid_transition", "ok"])
    expect((await db.sup`SELECT count(*)::int AS n FROM tenant_status_events WHERE store_id = ${id}`)[0]!.n).toBe(1)
  })

  it("an unknown tenant is not_found everywhere; a note cannot be attached to it", async () => {
    const ghost = randomUUID()
    expect(await db.adminRepo.getTenant(ghost)).toBeNull()
    expect(await db.adminRepo.listNotes(ghost)).toBeNull()
    expect(await db.adminRepo.addNote(ghost, randomUUID(), "x", [])).toBeNull()
    await expect(db.adminRepo.changeTenantStatus({ storeId: ghost, action: "suspend", adminId: randomUUID(), reason: "x", message: null })).rejects.toMatchObject({ code: "not_found" })
  })

  it("ACCEPTANCE 1: a Support admin suspending gets 403, and the DB holds a denied audit row naming the tenant", async () => {
    const shop = await newShop()
    const sup = await signedIn("support", true)
    const r = await call("POST", `/v1/admin/tenants/${shop.storeId}/suspend`, { token: sup.token, body: { reason: "should not work" } })
    expect(r.status, r.raw).toBe(403)
    const [row] = await db.sup`SELECT outcome, admin_id, target_type, target_id, store_id FROM admin_audit_log WHERE action = 'admin.tenant.suspend' AND store_id = ${shop.storeId}`
    expect(row).toMatchObject({ outcome: "denied", admin_id: sup.id, target_type: "tenant", target_id: shop.storeId, store_id: shop.storeId })
    expect((await call("GET", "/v1/sync/pull?after=0", { token: shop.token })).status).toBe(200)
  })

  it("ACCEPTANCE 2: Super + step-up suspends; next sync and login say tenant_suspended; audit row; owner sees the notice, not the reason; local data untouched; reactivation restores", async () => {
    const shop = await newShop()
    await call("POST", "/v1/sync/register-device", { token: shop.token, body: { deviceId: DEV } })
    const ev = { id: randomUUID(), kind: "product_upserted", at: new Date().toISOString(), payload: { id: randomUUID(), name: "Napa" } }
    expect((await call("POST", "/v1/sync/push", { token: shop.token, body: { deviceId: DEV, events: [ev] } })).status).toBe(200)

    const root = await signedIn("super", true)
    const message = "আপনার অ্যাকাউন্ট সাময়িক বন্ধ আছে"
    const reason = "INTERNAL: chargeback dispute"
    const s = await call("POST", `/v1/admin/tenants/${shop.storeId}/suspend`, { token: root.token, body: { reason, message } })
    expect(s.status, s.raw).toBe(200)
    expect(s.json).toMatchObject({ fromStatus: "trial", toStatus: "suspended" })

    const pull = await call("GET", "/v1/sync/pull?after=0", { token: shop.token })
    expect(pull.status).toBe(403)
    expect(pull.json.error).toMatchObject({ code: "tenant_suspended", details: { status: "suspended", message } })
    const push = await call("POST", "/v1/sync/push", { token: shop.token, body: { deviceId: DEV, events: [{ ...ev, id: randomUUID() }] } })
    expect(push.status).toBe(403) // 403, never 400/413: the phone keeps its queue
    const login = await call("POST", "/v1/auth/login", { body: { phone: shop.phone, password: SHOP_PASSWORD } })
    expect(login.json).toMatchObject({ tenantStatus: "suspended", statusMessage: message })

    // audit row: ok, with the reason and the before/after status
    const [audit] = await db.sup`SELECT outcome, reason, before, after, admin_id, store_id FROM admin_audit_log WHERE action = 'admin.tenant.suspend' AND outcome = 'ok' AND store_id = ${shop.storeId}`
    expect(audit).toMatchObject({ outcome: "ok", reason, admin_id: root.id, store_id: shop.storeId, before: { status: "trial" }, after: { status: "suspended", ownerMessage: message } })

    // the owner sees the notice but never the internal reason
    const activity = await call("GET", "/v1/account-activity", { token: shop.token })
    expect(activity.status).toBe(200)
    expect(activity.json.activity).toEqual([{ at: expect.any(String), status: "suspended", message }])
    expect(activity.raw).not.toContain("chargeback")

    // nothing was deleted: the synced event is still on the server, and the rejected push stored nothing
    expect((await db.sup`SELECT count(*)::int AS n FROM sync_events WHERE store_id = ${shop.storeId}`)[0]!.n).toBe(1)

    const back = await call("POST", `/v1/admin/tenants/${shop.storeId}/reactivate`, { token: root.token, body: { reason: "paid" } })
    expect(back.json).toMatchObject({ fromStatus: "suspended", toStatus: "trial" })
    expect((await call("GET", "/v1/sync/pull?after=0", { token: shop.token })).status).toBe(200)
    expect((await call("GET", "/v1/account-activity", { token: shop.token })).json.activity.map((e: { status: string }) => e.status)).toEqual(["trial", "suspended"])
  })

  it("the shop touch: push and pull set last_sync_at, but at most once per 5 minutes, and only for the caller's own store", async () => {
    const shop = await newShop()
    const get = async (id: string) => (await db.sup<Array<{ t: Date | null }>>`SELECT last_sync_at AS t FROM stores WHERE id = ${id}`)[0]!.t
    expect(await get(shop.storeId)).toBeNull()
    await call("POST", "/v1/sync/register-device", { token: shop.token, body: { deviceId: DEV } })
    expect((await call("GET", "/v1/sync/pull?after=0", { token: shop.token })).status).toBe(200)
    const first = await get(shop.storeId)
    expect(first).toBeInstanceOf(Date)
    await call("GET", "/v1/sync/pull?after=0", { token: shop.token })
    expect((await get(shop.storeId))!.getTime()).toBe(first!.getTime()) // throttled: not rewritten
    await db.sup`UPDATE stores SET last_sync_at = now() - interval '10 minutes' WHERE id = ${shop.storeId}`
    await call("GET", "/v1/sync/pull?after=0", { token: shop.token })
    expect((await get(shop.storeId))!.getTime()).toBeGreaterThan(Date.now() - 60_000) // refreshed
    const other = await newShop()
    expect(await get(other.storeId)).toBeNull() // another store's sync never touched this one
  })
})

// ======================================================================================================================
describe.skipIf(!ENABLED)("ACCEPTANCE 7: 10,000 tenants, \"no sync for 3 days\", p95 < 500 ms, correct counts", () => {
  let db: Db
  beforeAll(async () => {
    db = await makeDb("big")
    // 10,000 stores: 30% never synced, 20% synced 5 days ago, 50% synced an hour ago; owners for all, staff and devices for some
    await db.sup`
      INSERT INTO stores (name, kind, status, grandfathered, trial_ends_at, created_at, last_sync_at, phone)
      SELECT 'Shop ' || i, (ARRAY['pharmacy','cosmetics','other'])[1 + i % 3],
             CASE WHEN i % 10 = 0 THEN 'suspended' WHEN i % 7 = 0 THEN 'trial' ELSE 'active' END, false,
             CASE WHEN i % 7 = 0 AND i % 10 <> 0 THEN now() + interval '5 days' END,
             now() - (i || ' minutes')::interval,
             CASE WHEN i % 10 < 3 THEN NULL WHEN i % 10 < 5 THEN now() - interval '5 days' ELSE now() - interval '1 hour' END,
             '01' || lpad(i::text, 9, '0')
      FROM generate_series(1, 10000) AS i`
    await db.sup`INSERT INTO users (store_id, name, phone, password_hash, role)
                 SELECT s.id, 'Owner of ' || s.name, s.phone, 'x', 'owner' FROM stores s`
    await db.sup`INSERT INTO users (store_id, name, phone, password_hash, role)
                 SELECT s.id, 'Staff of ' || s.name, '02' || substr(s.phone, 3), 'x', 'staff' FROM stores s WHERE substr(s.phone, 11)::int % 3 = 0`
    await db.sup`INSERT INTO sync_devices (store_id, device_id, code) SELECT s.id, gen_random_uuid(), 'A' FROM stores s WHERE substr(s.phone, 11)::int % 2 = 0`
    await db.sup`ANALYZE`
  }, 120_000)
  afterAll(async () => { await db?.drop() })

  const timed = async <T>(fn: () => Promise<T>) => {
    const t0 = performance.now()
    const out = await fn()
    return { out, ms: performance.now() - t0 }
  }
  const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1]!

  it("the filtered list returns the right rows and the exact total, and 20 timed runs have p95 < 500 ms", async () => {
    const [expected] = await db.sup<Array<{ n: number }>>`SELECT count(*)::int AS n FROM stores WHERE last_sync_at IS NULL OR last_sync_at < now() - interval '3 days'`
    expect(expected!.n).toBe(5000) // 30% never + 20% five days ago
    const query: TenantListQuery = { noSyncDays: 3, sort: "created", dir: "desc", limit: 50 }
    const warm = await db.adminRepo.listTenants(query)
    expect(warm.total).toBe(expected!.n)
    expect(warm.tenants).toHaveLength(50)
    expect(warm.nextCursor).not.toBeNull()
    for (const t of warm.tenants) expect(t.lastSyncAt === null || Date.parse(t.lastSyncAt) < Date.now() - 3 * 86_400_000).toBe(true)

    const runs: number[] = []
    for (let i = 0; i < 20; i++) runs.push((await timed(() => db.adminRepo.listTenants(query))).ms)
    const worst = p95(runs)
    console.log(`acceptance 7: 10,000 tenants, noSyncDays=3: p95=${worst.toFixed(1)} ms, max=${Math.max(...runs).toFixed(1)} ms over ${runs.length} runs`)
    expect(worst).toBeLessThan(500)
  })

  it("other list shapes stay fast too: search, sort by last sync, deep page, status filter", async () => {
    const shapes: Array<[string, TenantListQuery]> = [
      ["name search", { q: "Shop 99", sort: "created", dir: "desc", limit: 50 }],
      ["phone search", { q: "01000000500", sort: "created", dir: "desc", limit: 50 }],
      ["sort lastSync", { sort: "lastSync", dir: "asc", limit: 50 }],
      ["sort name", { sort: "name", dir: "asc", limit: 100 }],
      ["deep page", { sort: "created", dir: "desc", limit: 50, cursor: Buffer.from("o:9900").toString("base64url") }],
      ["status filter", { status: "suspended", sort: "created", dir: "desc", limit: 50 }],
    ]
    for (const [label, query] of shapes) {
      await db.adminRepo.listTenants(query)
      const { out, ms } = await timed(() => db.adminRepo.listTenants(query))
      expect(ms, label).toBeLessThan(500)
      expect(out.total, label).toBeGreaterThan(0)
    }
    expect((await db.adminRepo.listTenants({ status: "suspended", sort: "created", dir: "desc", limit: 50 })).total).toBe(1000)
    expect((await db.adminRepo.listTenants({ q: "01000000500", sort: "created", dir: "desc", limit: 50 })).total).toBe(1) // the full number: one store
    expect((await db.adminRepo.listTenants({ q: "0100000050", sort: "created", dir: "desc", limit: 50 })).total).toBe(0) // a prefix matches nothing (exact-only: masking cannot be probed)
  })
})

// ======================================================================================================================
describe.skipIf(!ENABLED)("013 rollback (db/rollback/013_down.sql)", () => {
  it("refuses while notes or status history exist, then restores the 012 schema and 013 can be applied again; shop data survives", async () => {
    const db = await makeDb("rb")
    const one = open(withDb(SUPER ?? "", db.name), 1) // BEGIN ... COMMIT files need a single connection
    const read = (...p: string[]) => readFile(path.join(process.cwd(), ...p), "utf8")
    try {
      const id = await seedStore(db.sup, { name: "Keep me", createdAt: new Date(), ownerPhone: "01711888001" })
      await db.sup`INSERT INTO tenant_notes (store_id, body) VALUES (${id}, 'important')`
      const down = await read("db", "rollback", "013_down.sql")

      expect(await sqlCode(one.unsafe(down))).toBe("P0001") // data present: refuses
      await one.unsafe("ROLLBACK").catch(() => undefined)
      expect((await db.sup`SELECT count(*)::int AS n FROM tenant_notes`)[0]!.n).toBe(1)

      await one.unsafe(`SET bipone.discard_tenant_ops = 'yes';\n${down}`)
      expect(await db.sup`SELECT relname FROM pg_class WHERE relname IN ('tenant_notes', 'tenant_status_events')`).toEqual([])
      expect(await db.sup`SELECT column_name FROM information_schema.columns WHERE table_name = 'stores' AND column_name = 'last_sync_at'`).toEqual([])
      expect(await db.sup`SELECT proname FROM pg_proc WHERE proname LIKE 'admin\_tenant\_%' OR proname IN ('admin_mask_phone', 'admin_audit_list', 'sync_touch_store')`).toEqual([])
      expect((await db.sup`SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'admin_get'`)[0]!.n).toBe(1) // 012 is untouched
      expect((await db.sup`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '013_admin_tenant_ops.sql'`)[0]!.n).toBe(0)
      expect((await db.sup`SELECT name FROM stores WHERE id = ${id}`)[0]!.name).toBe("Keep me")

      await one.unsafe(await read("db", "migrations", "013_admin_tenant_ops.sql")) // re-apply
      expect((await db.sup`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '013_admin_tenant_ops.sql'`)[0]!.n).toBe(1)
      expect((await db.adminRepo.listTenants({ sort: "created", dir: "desc", limit: 10 })).total).toBe(1)
    } finally {
      await one.end({ timeout: 5 })
      await db.drop()
    }
  }, 60_000)
})
