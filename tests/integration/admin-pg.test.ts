// Admin panel against REAL Postgres as the `admin_app` role (npm run test:pg). Runs in its own scratch database so the
// "last super admin" and counting assertions are deterministic. Never point these URLs at a live database.
import { randomBytes } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createApp } from "../../server/app.js"
import { encryptSecret } from "../../src/auth/admin-crypto.js"
import { hashPassword } from "../../src/auth/password.js"
import { generateTotpSecret, totpCode } from "../../src/auth/totp.js"
import { createPgAdmin } from "../../src/db/pg-admin.js"
import { createPgRepo } from "../../src/db/pg.js"
import type { AdminRepo } from "../../src/db/admin.js"

const SUPER = process.env.INTEGRATION_SUPERUSER_URL
const APP = process.env.INTEGRATION_DATABASE_URL
const ADMIN = process.env.INTEGRATION_ADMIN_DATABASE_URL
const ENC_KEY = randomBytes(32).toString("base64")
const PASSWORD = "Correct-Horse-Battery-9"
const MIGRATIONS = path.join(process.cwd(), "db", "migrations")

const withDb = (url: string, db: string) => {
  const u = new URL(url)
  u.pathname = `/${db}`
  return u.toString()
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!SUPER || !APP || !ADMIN)("admin panel on real Postgres (admin_app)", () => {
  const dbName = `adm_${randomBytes(4).toString("hex")}`
  let superSql: postgres.Sql
  let scratchSuper: postgres.Sql
  let admin: AdminRepo
  let shop: ReturnType<typeof createPgRepo>
  let app: ReturnType<typeof createApp>

  beforeAll(async () => {
    superSql = postgres(SUPER ?? "", { max: 1, prepare: false, onnotice: () => {} })
    await superSql.unsafe(`CREATE DATABASE ${dbName}`)
    scratchSuper = postgres(withDb(SUPER ?? "", dbName), { max: 1, prepare: false, onnotice: () => {} })
    await scratchSuper`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`
    const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort()
    for (const f of files) await scratchSuper.unsafe(await readFile(path.join(MIGRATIONS, f), "utf8"))
    admin = createPgAdmin({ connectionString: withDb(ADMIN ?? "", dbName), max: 4 })
    shop = createPgRepo({ connectionString: withDb(APP ?? "", dbName), max: 2 })
    app = createApp({ repo: shop, jwtSecret: "s".repeat(40), admin: { repo: admin, jwtSecret: "a".repeat(40), totpEncKey: ENC_KEY } })
  })
  afterAll(async () => {
    await admin?.close()
    await shop?.close()
    await scratchSuper?.end({ timeout: 5 })
    await superSql?.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
    await superSql?.end({ timeout: 5 })
  })

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
  async function seed(role: "super" | "support" | "finance" | "viewer", email: string, enrolled = true) {
    const secret = generateTotpSecret()
    // created exactly like create-admin does: through the SECURITY DEFINER function
    const secretEnc = encryptSecret(secret, ENC_KEY) // random IV: encrypt once, confirm against the same stored string
    const id = await admin.createAdmin({ email, name: email, role, passwordHash: await hashPassword(PASSWORD), totpSecretEnc: secretEnc, createdBy: null })
    if (enrolled) await admin.totpConfirm(id, [], 0, secretEnc)
    return { id, email, secret }
  }
  const code = (secret: string, offsetSteps = 0) => totpCode(secret, Math.floor(Date.now() / 1000 / 30) + offsetSteps)

  it("full operator flow over HTTP: login -> 2FA -> step-up -> create -> update -> reset-2fa -> logout, all audited in the database", async () => {
    const root = await seed("super", `root-${randomBytes(3).toString("hex")}@bipone.test`)
    const login = await call("POST", "/v1/admin/auth/login", { body: { email: root.email, password: PASSWORD } })
    expect(login.status, login.raw).toBe(200)
    const full = await call("POST", "/v1/admin/auth/2fa", { token: login.json.pendingToken, body: { code: code(root.secret) } })
    expect(full.status, full.raw).toBe(200)
    const token = full.json.token as string
    expect((await call("GET", "/v1/admin/me", { token })).json.admin.email).toBe(root.email)

    // step-up needs a code from a LATER step than the one just used (replay guard)
    const su = await call("POST", "/v1/admin/auth/step-up", { token, body: { password: PASSWORD, code: code(root.secret, 1) } })
    expect(su.status, su.raw).toBe(200)

    const created = await call("POST", "/v1/admin/admins", { token, body: { email: `fin-${randomBytes(3).toString("hex")}@bipone.test`, name: "Fin", role: "finance", password: PASSWORD } })
    expect(created.status, created.raw).toBe(201)
    const id = created.json.admin.id as string
    expect((await call("PATCH", `/v1/admin/admins/${id}`, { token, body: { role: "support", reason: "moved" } })).json.admin.role).toBe("support")
    expect((await call("POST", `/v1/admin/admins/${id}/reset-2fa`, { token, body: {} })).status).toBe(200)
    expect((await call("POST", "/v1/admin/auth/logout", { token, body: {} })).status).toBe(200)
    expect((await call("GET", "/v1/admin/me", { token })).status).toBe(401)

    const rows = await scratchSuper`SELECT action, outcome, admin_id, ip, ua, request_id FROM admin_audit_log WHERE admin_id = ${root.id} ORDER BY id`
    expect(rows.map((r) => r.action)).toEqual(["admin.login", "admin.2fa", "admin.step_up", "admin.create", "admin.update", "admin.reset_2fa", "admin.logout"])
    for (const r of rows) {
      expect(r.outcome).toBe("ok")
      expect(r.ip).toBe("10.9.9.9")
      expect(r.ua).toBe("vitest")
      expect(r.request_id).toBeTruthy()
    }
    // nothing sensitive reached the audit log
    const dump = JSON.stringify(await scratchSuper`SELECT * FROM admin_audit_log`)
    expect(dump).not.toContain(PASSWORD)
    expect(dump).not.toContain(root.secret)
  })

  it("a denied attempt is audited in the database too (support cannot create admins)", async () => {
    const sup = await seed("support", `sup-${randomBytes(3).toString("hex")}@bipone.test`)
    const login = await call("POST", "/v1/admin/auth/login", { body: { email: sup.email, password: PASSWORD } })
    const full = await call("POST", "/v1/admin/auth/2fa", { token: login.json.pendingToken, body: { code: code(sup.secret) } })
    const r = await call("POST", "/v1/admin/admins", { token: full.json.token, body: { email: "x@bipone.test", name: "X", role: "viewer", password: PASSWORD } })
    expect(r.status).toBe(403)
    const [row] = await scratchSuper`SELECT outcome, action FROM admin_audit_log WHERE admin_id = ${sup.id} AND action = 'admin.create'`
    expect(row).toMatchObject({ outcome: "denied", action: "admin.create" })
  })

  it("the last active super admin cannot be removed even by two racing requests (advisory lock in SQL)", async () => {
    await scratchSuper`UPDATE platform_admins SET role = 'viewer' WHERE role = 'super'` // earlier tests' supers: only this test's two remain
    const a = await seed("super", `race-a-${randomBytes(3).toString("hex")}@bipone.test`)
    const b = await seed("super", `race-b-${randomBytes(3).toString("hex")}@bipone.test`)
    const results = await Promise.allSettled([admin.setRoleActive(a.id, "viewer", true), admin.setRoleActive(b.id, "viewer", true)])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult
    expect(rejected.reason).toMatchObject({ code: "last_super_admin" })
    const [{ c }] = await scratchSuper`SELECT count(*)::int AS c FROM platform_admins WHERE role = 'super' AND active`
    expect(c).toBe(1)
  })

  it("a TOTP step is accepted once even under parallel requests; a recovery code is consumed once", async () => {
    const a = await seed("support", `atomic-${randomBytes(3).toString("hex")}@bipone.test`)
    const step = Math.floor(Date.now() / 1000 / 30) + 5
    const uses = await Promise.all([admin.totpUseStep(a.id, step), admin.totpUseStep(a.id, step), admin.totpUseStep(a.id, step)])
    expect(uses.filter(Boolean)).toHaveLength(1)
    expect(await admin.totpUseStep(a.id, step - 1)).toBe(false) // older step is a replay too

    await scratchSuper`UPDATE platform_admins SET recovery_codes_hash = ARRAY['h1','h2'] WHERE id = ${a.id}`
    const taken = await Promise.all([admin.consumeRecovery(a.id, "h1"), admin.consumeRecovery(a.id, "h1")])
    expect(taken.filter(Boolean)).toHaveLength(1)
    const [{ remaining }] = await scratchSuper`SELECT cardinality(recovery_codes_hash)::int AS remaining FROM platform_admins WHERE id = ${a.id}`
    expect(remaining).toBe(1)
  })

  it("sessions: idle and absolute limits are enforced by the database; deactivation revokes at once", async () => {
    const a = await seed("support", `sess-${randomBytes(3).toString("hex")}@bipone.test`)
    const live = await admin.createSession(a.id, "active", 3600, "1.2.3.4", "ua")
    expect(await admin.touchSession(live, 60)).toMatchObject({ adminId: a.id, stage: "active", role: "support" })
    await sleep(1200)
    expect(await admin.touchSession(live, 1)).toBeNull() // idle for > 1 s

    const short = await admin.createSession(a.id, "active", 1, null, null)
    await sleep(1200)
    expect(await admin.touchSession(short, 3600)).toBeNull() // past the absolute limit

    const s3 = await admin.createSession(a.id, "active", 3600, null, null)
    await scratchSuper`UPDATE platform_admins SET role = 'super' WHERE id = ${a.id}` // keep guard happy for the deactivate below
    await admin.setRoleActive(a.id, "super", false)
    expect(await admin.touchSession(s3, 3600)).toBeNull()
    const [{ reason }] = await scratchSuper`SELECT revoked_reason AS reason FROM admin_sessions WHERE id = ${s3}`
    expect(reason).toBe("deactivated")
  })

  it("admin and shop throttle buckets never collide (admin: namespace)", async () => {
    const bucket = `collide-${randomBytes(3).toString("hex")}`
    expect(await shop.throttle(bucket, 1, 60)).toBe(true)
    expect(await shop.throttle(bucket, 1, 60)).toBe(false) // shop bucket is full
    expect(await admin.throttle(bucket, 1, 60)).toBe(true) // the admin bucket of the same name is untouched
    expect(await admin.throttle(bucket, 1, 60)).toBe(false)
    const [{ c }] = await scratchSuper`SELECT count(*)::int AS c FROM auth_attempts WHERE bucket = ${`admin:${bucket}`}`
    expect(c).toBe(1)
  })

  it("duplicate email maps to email_taken; unknown ids return false/null instead of throwing", async () => {
    const email = `dup-${randomBytes(3).toString("hex")}@bipone.test`
    await seed("viewer", email)
    await expect(seed("viewer", email.toUpperCase())).rejects.toMatchObject({ code: "email_taken" })
    expect(await admin.getAdmin("00000000-0000-4000-8000-000000000000")).toBeNull()
    expect(await admin.setRoleActive("00000000-0000-4000-8000-000000000000", "viewer", true)).toBe(false)
    expect(await admin.reset2fa("00000000-0000-4000-8000-000000000000")).toBe(false)
  })
})
