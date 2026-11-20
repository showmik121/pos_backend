import { randomBytes } from "node:crypto"
import { expect } from "vitest"
import { createApp } from "../../server/app.js"
import { encryptSecret } from "../../src/auth/admin-crypto.js"
import { hashPassword } from "../../src/auth/password.js"
import { generateTotpSecret, totpCode } from "../../src/auth/totp.js"
import { createMemoryAdmin } from "../../src/db/memory-admin.js"
import { createMemoryRepo } from "../../src/db/memory.js"
import type { AdminRole } from "../../src/domain/admin-permissions.js"

// HTTP harness for /v1/admin tests: a shop app and an admin app over memory repos, wired so that a status change made by an
// admin is what the shop API enforces (in production both read the same stores.status column).
export const SHOP_SECRET = "s".repeat(40)
export const ADMIN_SECRET = "a".repeat(40)
export const ENC_KEY = randomBytes(32).toString("base64")
export const PASSWORD = "Correct-Horse-Battery-9"
export const OWNER_PHONE = "01711000030"

export function adminHarness() {
  let t = Date.parse("2026-11-20T06:00:00.000Z")
  const now = () => t
  const shopRepo = createMemoryRepo({ now })
  const adminRepo = createMemoryAdmin({ now, onStatusChange: (storeId, status, message) => shopRepo.setStoreStatus(storeId, status, message) })
  const app = createApp({ repo: shopRepo, jwtSecret: SHOP_SECRET, now, admin: { repo: adminRepo, jwtSecret: ADMIN_SECRET, totpEncKey: ENC_KEY } })

  async function call(method: string, path: string, o: { body?: unknown; token?: string; ip?: string } = {}) {
    const res = await app.fetch(
      new Request(`https://edge.test/api${path}`, {
        method,
        headers: { "content-type": "application/json", "x-real-ip": o.ip ?? "10.0.0.1", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) },
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
      }),
    )
    const text = await res.text()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, json: (text ? JSON.parse(text) : null) as any, raw: text }
  }

  const codeNow = (secret: string) => totpCode(secret, Math.floor(t / 1000 / 30))
  const tick = (seconds: number) => { t += seconds * 1000 }

  async function seedAdmin(role: AdminRole, email: string) {
    const secret = generateTotpSecret()
    const secretEnc = encryptSecret(secret, ENC_KEY)
    const id = await adminRepo.createAdmin({ email, name: `Name ${role}`, role, passwordHash: await hashPassword(PASSWORD), totpSecretEnc: secretEnc, createdBy: null })
    await adminRepo.totpConfirm(id, [], 0, secretEnc)
    return { id, email, secret }
  }

  async function signIn(a: { email: string; secret: string }) {
    const login = await call("POST", "/v1/admin/auth/login", { body: { email: a.email, password: PASSWORD } })
    expect(login.status, login.raw).toBe(200)
    tick(31)
    const r = await call("POST", "/v1/admin/auth/2fa", { token: login.json.pendingToken, body: { code: codeNow(a.secret) } })
    expect(r.status, r.raw).toBe(200)
    return r.json.token as string
  }

  async function stepUp(a: { secret: string }, token: string) {
    tick(31)
    const r = await call("POST", "/v1/admin/auth/step-up", { token, body: { password: PASSWORD, code: codeNow(a.secret) } })
    expect(r.status, r.raw).toBe(200)
  }

  /** a real shop (signed up through the shop API) that the admin directory also knows about */
  async function shop(phone = OWNER_PHONE, name = "সবুজ ফার্মেসি") {
    const r = await call("POST", "/v1/auth/register-store", { body: { storeName: name, ownerName: "করিম", phone, storeKind: "pharmacy", password: "Sobuj#Ghar2026" } })
    expect(r.status, r.raw).toBe(201)
    const me = await call("GET", "/v1/me", { token: r.json.token })
    const storeId = me.json.store.id as string
    adminRepo.seedTenant({ id: storeId, name, kind: "pharmacy", ownerName: "করিম", ownerPhone: phone, status: "trial", trialEndsAt: new Date(t + 14 * 86_400_000).toISOString() })
    return { storeId, ownerToken: r.json.token as string, phone }
  }

  /** an admin of `role`, signed in; `withStepUp` adds a fresh step-up */
  async function actor(role: AdminRole, email: string, withStepUp = false) {
    const a = await seedAdmin(role, email)
    const token = await signIn(a)
    if (withStepUp) await stepUp(a, token)
    return { ...a, token }
  }

  const auditFor = (storeId: string) => adminRepo.auditRows().filter((r) => r.storeId === storeId)
  return { call, adminRepo, shopRepo, app, seedAdmin, signIn, stepUp, shop, actor, auditFor, tick, now }
}
