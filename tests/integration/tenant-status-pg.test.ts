// Tenant-status enforcement against REAL Postgres + RLS (npm run test:pg). Complements tests/unit/tenant-status.test.ts.
import { randomUUID } from "node:crypto"
import postgres from "postgres"
import { afterAll, describe, expect, it } from "vitest"
import { createApp } from "../../server/app.js"
import { createPgRepo } from "../../src/db/pg.js"

const SUPER = process.env.INTEGRATION_SUPERUSER_URL
const APP = process.env.INTEGRATION_DATABASE_URL
const PASS = "Sobuj#Ghar2026"
const DEV = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"

describe.skipIf(!SUPER || !APP)("PostgreSQL: tenant status enforcement", () => {
  const repo = createPgRepo({ connectionString: APP ?? "", max: 4 })
  const app = createApp({ repo, jwtSecret: "k".repeat(40) })
  const superSql = postgres(SUPER ?? "postgres://x@localhost/x", { max: 1, prepare: false, onnotice: () => {} })
  const appSql = postgres(APP ?? "postgres://x@localhost/x", { max: 1, prepare: false, onnotice: () => {} })
  afterAll(async () => {
    await repo.close()
    await superSql.end({ timeout: 5 })
    await appSql.end({ timeout: 5 })
  })

  async function call(method: string, path: string, opts: { body?: unknown; token?: string } = {}) {
    const res = await app.fetch(
      new Request(`https://edge.test/api${path}`, {
        method,
        headers: { "content-type": "application/json", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      }),
    )
    const text = await res.text()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, json: (text ? JSON.parse(text) : null) as any }
  }
  const phone = () => `019${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`

  async function newShop() {
    const ph = phone()
    const r = await call("POST", "/v1/auth/register-store", { body: { storeName: "দোকান", ownerName: "মালিক", phone: ph, password: PASS } })
    expect(r.status).toBe(201)
    const me = await call("GET", "/v1/me", { token: r.json.token })
    return { token: r.json.token as string, phone: ph, storeId: me.json.store.id as string, me }
  }
  const setStatus = (storeId: string, status: string, message: string | null = null) =>
    superSql`UPDATE stores SET status = ${status}, status_message = ${message} WHERE id = ${storeId}`

  it("signup creates a trial store with a 14-day end date (through the real signup function)", async () => {
    const s = await newShop()
    expect(s.me.json.store.status).toBe("trial")
    const days = (Date.parse(s.me.json.store.trialEndsAt) - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(13.9)
    expect(days).toBeLessThanOrEqual(14 + 1 / 86_400) // the DB and Node clocks are separate: allow 1 s of skew
  })

  it("suspended: data routes 403 tenant_suspended with the operator's message; login and /v1/me still work", async () => {
    const s = await newShop()
    await setStatus(s.storeId, "suspended", "বকেয়া")
    const blocked = await call("GET", "/v1/products", { token: s.token })
    expect(blocked.status).toBe(403)
    expect(blocked.json.error).toMatchObject({ code: "tenant_suspended", details: { status: "suspended", message: "বকেয়া" } })
    const login = await call("POST", "/v1/auth/login", { body: { phone: s.phone, password: PASS } })
    expect(login.status).toBe(200)
    expect(login.json).toMatchObject({ tenantStatus: "suspended", statusMessage: "বকেয়া" })
    expect((await call("GET", "/v1/me", { token: s.token })).status).toBe(200)
  })

  it("read_only: reads and pull allowed, push and REST writes 403 tenant_read_only; reactivation restores everything", async () => {
    const s = await newShop()
    await call("POST", "/v1/sync/register-device", { token: s.token, body: { deviceId: DEV } })
    await setStatus(s.storeId, "read_only")
    expect((await call("GET", "/v1/products", { token: s.token })).status).toBe(200)
    expect((await call("GET", "/v1/sync/pull?after=0", { token: s.token })).status).toBe(200)
    const push = await call("POST", "/v1/sync/push", {
      token: s.token,
      body: { deviceId: DEV, events: [{ id: randomUUID(), kind: "product_upserted", at: new Date().toISOString(), payload: { id: randomUUID(), name: "x" } }] },
    })
    expect(push.status).toBe(403)
    expect(push.json.error.code).toBe("tenant_read_only")
    await setStatus(s.storeId, "active")
    const ev = { id: randomUUID(), kind: "product_upserted", at: new Date().toISOString(), payload: { id: randomUUID(), name: "x" } }
    expect((await call("POST", "/v1/sync/push", { token: s.token, body: { deviceId: DEV, events: [ev] } })).status).toBe(200)
  })

  it("a shop can never change its own status: pos_app has no UPDATE on stores.status (only the name)", async () => {
    const s = await newShop()
    await setStatus(s.storeId, "suspended")
    const tx = appSql.begin(async (t) => {
      await t`SELECT set_config('app.store_id', ${s.storeId}, true)`
      await t`UPDATE stores SET status = 'active' WHERE id = ${s.storeId}`
    })
    await expect(tx).rejects.toMatchObject({ code: "42501" })
    const [row] = await superSql`SELECT status FROM stores WHERE id = ${s.storeId}`
    expect(row!.status).toBe("suspended")
  })
})
