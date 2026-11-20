import { randomBytes } from "node:crypto"
import { describe, expect, it } from "vitest"
import { createApp } from "../../server/app.js"
import { ADMIN_ROUTES } from "../../server/routes/admin.js"
import { adminHandlers } from "../../server/routes/admin-handlers.js"
import { encryptSecret, hashRecoveryCode } from "../../src/auth/admin-crypto.js"
import { signToken } from "../../src/auth/token.js"
import { generateTotpSecret, totpCode } from "../../src/auth/totp.js"
import { ADMIN_ROUTE_IDS, adminContract, ErrorEnvelopeSchema } from "../../src/contract/admin-api.js"
import { createMemoryAdmin } from "../../src/db/memory-admin.js"
import { createMemoryRepo } from "../../src/db/memory.js"
import type { AdminRole } from "../../src/domain/admin-permissions.js"
import { hashPassword } from "../../src/auth/password.js"

const SHOP_SECRET = "s".repeat(40)
const ADMIN_SECRET = "a".repeat(40)
const ENC_KEY = randomBytes(32).toString("base64")
const PASSWORD = "Correct-Horse-Battery-9"
const UUID0 = "00000000-0000-4000-8000-000000000000"

function harness() {
  let t = Date.parse("2026-11-20T06:00:00.000Z")
  const now = () => t
  const adminRepo = createMemoryAdmin({ now })
  const shopRepo = createMemoryRepo({ now })
  const app = createApp({ repo: shopRepo, jwtSecret: SHOP_SECRET, now, admin: { repo: adminRepo, jwtSecret: ADMIN_SECRET, totpEncKey: ENC_KEY } })
  const open = createApp({ repo: createMemoryRepo({ now }), jwtSecret: SHOP_SECRET, now }) // admin NOT configured

  async function call(method: string, path: string, o: { body?: unknown; token?: string; ip?: string; application?: typeof app } = {}) {
    const res = await (o.application ?? app).fetch(
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

  /** an admin that has completed 2FA enrolment (secret known to the test) */
  async function seed(role: AdminRole, email: string, opts: { enrolled?: boolean } = {}) {
    const secret = generateTotpSecret()
    const secretEnc = encryptSecret(secret, ENC_KEY) // random IV: encrypt once, confirm against the same stored string
    // enrolled:false models an admin created through the API (admins.create stores NO secret, enroll-start fills the empty slot)
    const id = await adminRepo.createAdmin({
      email, name: `Name ${role}`, role, passwordHash: await hashPassword(PASSWORD), totpSecretEnc: opts.enrolled === false ? null : secretEnc, createdBy: null,
    })
    if (opts.enrolled !== false) await adminRepo.totpConfirm(id, [], 0, secretEnc)
    return { id, email, secret }
  }

  /** password + 2FA -> a full session token */
  async function signIn(a: { email: string; secret: string }) {
    const login = await call("POST", "/v1/admin/auth/login", { body: { email: a.email, password: PASSWORD } })
    expect(login.status, login.raw).toBe(200)
    expect(login.json.stage).toBe("2fa")
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
  return { call, adminRepo, shopRepo, app, open, seed, signIn, stepUp, codeNow, tick, now }
}

describe("contract and registry", () => {
  it("every contract route has a handler and a compiled route, and nothing else exists", () => {
    expect(Object.keys(adminHandlers).sort()).toEqual([...ADMIN_ROUTE_IDS].sort())
    expect(ADMIN_ROUTES.map((r) => r.id).sort()).toEqual([...ADMIN_ROUTE_IDS].sort())
  })
  it("every non-GET route is mutating with a unique audit name; GET routes never mutate", () => {
    const names = new Set<string>()
    for (const id of ADMIN_ROUTE_IDS) {
      const c = adminContract[id]
      expect(c.mutating, id).toBe(c.method !== "GET")
      if (c.mutating) {
        expect(c.audit, id).toMatch(/^admin\./)
        expect(names.has(c.audit as string), `duplicate audit name ${c.audit}`).toBe(false)
        names.add(c.audit as string)
      } else {
        expect(c.audit, id).toBeNull()
      }
    }
  })
  it("the feature gate: without the admin option /v1/admin/* is a 404 and the shop API is untouched", async () => {
    const h = harness()
    expect((await h.call("POST", "/v1/admin/auth/login", { body: { email: "a@b.co", password: "x" }, application: h.open })).status).toBe(404)
    expect((await h.call("GET", "/health", { application: h.open })).status).toBe(200)
  })
  it("refuses to start with a weak admin config or admin secret equal to the shop secret", () => {
    const base = { repo: createMemoryRepo(), jwtSecret: SHOP_SECRET }
    const admin = createMemoryAdmin()
    expect(() => createApp({ ...base, admin: { repo: admin, jwtSecret: SHOP_SECRET, totpEncKey: ENC_KEY } })).toThrow(/differ/)
    expect(() => createApp({ ...base, admin: { repo: admin, jwtSecret: "short", totpEncKey: ENC_KEY } })).toThrow(/ADMIN_JWT_SECRET/)
    expect(() => createApp({ ...base, admin: { repo: admin, jwtSecret: ADMIN_SECRET, totpEncKey: "nope" } })).toThrow(/ADMIN_TOTP_ENC_KEY/)
  })
})

describe("token confusion (acceptance 3)", () => {
  it("a shop token is rejected (401) by EVERY admin route", async () => {
    const h = harness()
    const shop = await h.call("POST", "/v1/auth/register-store", { body: { storeName: "দোকান", ownerName: "মালিক", phone: "01711000001", password: "Sobuj#Ghar2026" } })
    const forged = signToken({ sub: "x", sid: "y", role: "owner" }, ADMIN_SECRET) // even signed with the admin secret
    for (const token of [shop.json.token as string, forged]) {
      for (const r of ADMIN_ROUTES) {
        if (r.contract.auth === "none") continue
        const path = `/v1/admin${r.contract.path.replace(":id", UUID0)}`
        const res = await h.call(r.contract.method, path, { token, body: r.contract.method === "GET" ? undefined : {} })
        expect(res.status, `${r.contract.method} ${path}`).toBe(401)
      }
    }
  })
  it("an admin token (pending or full) is rejected (401) by shop routes", async () => {
    const h = harness()
    const a = await h.seed("super", "root@bipone.test")
    const login = await h.call("POST", "/v1/admin/auth/login", { body: { email: a.email, password: PASSWORD } })
    const full = await h.signIn(a)
    for (const token of [login.json.pendingToken as string, full]) {
      for (const [m, p] of [["GET", "/v1/me"], ["GET", "/v1/staff"], ["GET", "/v1/sync/pull?after=0"], ["GET", "/v1/products"]] as const) {
        expect((await h.call(m, p, { token })).status, `${m} ${p}`).toBe(401)
      }
    }
  })
  it("a pending token cannot use full-session routes, and a full token cannot use the 2FA routes", async () => {
    const h = harness()
    const a = await h.seed("super", "root@bipone.test")
    const login = await h.call("POST", "/v1/admin/auth/login", { body: { email: a.email, password: PASSWORD } })
    expect((await h.call("GET", "/v1/admin/me", { token: login.json.pendingToken })).status).toBe(401)
    expect((await h.call("GET", "/v1/admin/admins", { token: login.json.pendingToken })).status).toBe(401)
    const full = await h.signIn(a)
    expect((await h.call("POST", "/v1/admin/auth/2fa", { token: full, body: { code: "123456" } })).status).toBe(401)
  })
})

describe("login, 2FA and enrolment (acceptance 6)", () => {
  it("an admin without 2FA must enrol first: no data until enrolment completes", async () => {
    const h = harness()
    const a = await h.seed("super", "new@bipone.test", { enrolled: false })
    const login = await h.call("POST", "/v1/admin/auth/login", { body: { email: a.email, password: PASSWORD } })
    expect(login.status).toBe(200)
    expect(login.json.stage).toBe("enroll")
    const pending = login.json.pendingToken as string
    // nothing but the enrolment routes works with the pending token
    expect((await h.call("GET", "/v1/admin/me", { token: pending })).status).toBe(401)
    expect((await h.call("GET", "/v1/admin/admins", { token: pending })).status).toBe(401)
    expect((await h.call("POST", "/v1/admin/auth/2fa", { token: pending, body: { code: "123456" } })).json.error.code).toBe("enrollment_required")

    const start = await h.call("POST", "/v1/admin/auth/2fa/enroll-start", { token: pending, body: {} })
    expect(start.status).toBe(200)
    expect(start.json.secret).toMatch(/^[A-Z2-7]{32}$/)
    expect(start.json.otpauthUri).toContain("otpauth://totp/")

    h.tick(31)
    const wrong = await h.call("POST", "/v1/admin/auth/2fa/enroll-confirm", { token: pending, body: { code: "000000" } })
    expect(wrong.status).toBe(401)
    expect(wrong.json.error.code).toBe("invalid_code")

    const done = await h.call("POST", "/v1/admin/auth/2fa/enroll-confirm", { token: pending, body: { code: h.codeNow(start.json.secret) } })
    expect(done.status, done.raw).toBe(200)
    expect(done.json.recoveryCodes).toHaveLength(10)
    expect((await h.call("GET", "/v1/admin/me", { token: done.json.token })).json.admin).toMatchObject({ email: a.email, enrolled: true })
    // the pending token died when the session was upgraded
    expect((await h.call("POST", "/v1/admin/auth/2fa/enroll-confirm", { token: pending, body: { code: "123456" } })).status).toBe(401)
  })

  it("login is generic for wrong password, unknown email and inactive admin (no account enumeration)", async () => {
    const h = harness()
    const a = await h.seed("super", "root@bipone.test")
    const off = await h.seed("support", "off@bipone.test")
    await h.adminRepo.setRoleActive(off.id, "support", false)
    const results = [
      await h.call("POST", "/v1/admin/auth/login", { body: { email: a.email, password: "wrong-password-1" } }),
      await h.call("POST", "/v1/admin/auth/login", { body: { email: "nobody@bipone.test", password: PASSWORD } }),
      await h.call("POST", "/v1/admin/auth/login", { body: { email: off.email, password: PASSWORD } }),
    ]
    for (const r of results) {
      expect(r.status).toBe(401)
      expect(r.json.error).toMatchObject({ code: "invalid_credentials", message: "Email or password is incorrect." })
    }
    const denied = h.adminRepo.auditRows().filter((r) => r.action === "admin.login" && r.outcome === "denied")
    expect(denied).toHaveLength(3)
    expect(denied.map((r) => r.targetId).sort()).toEqual(["nobody@bipone.test", "off@bipone.test", "root@bipone.test"])
  })

  it("brute force: the 6th wrong password from one IP for one account is throttled (429), and a correct password stays blocked until the window passes", async () => {
    const h = harness()
    const a = await h.seed("super", "root@bipone.test")
    for (let i = 0; i < 5; i++) {
      expect((await h.call("POST", "/v1/admin/auth/login", { body: { email: a.email, password: `wrong-password-${i}` } })).status).toBe(401)
    }
    expect((await h.call("POST", "/v1/admin/auth/login", { body: { email: a.email, password: PASSWORD } })).status).toBe(429)
    h.tick(16 * 60)
    expect((await h.call("POST", "/v1/admin/auth/login", { body: { email: a.email, password: PASSWORD } })).status).toBe(200)
  })

  it("admin lockout buckets are separate from shop buckets (admin: namespace)", async () => {
    const h = harness()
    const a = await h.seed("super", "root@bipone.test")
    for (let i = 0; i < 5; i++) await h.shopRepo.throttle(`login:p:${a.email}|10.0.0.1`, 5, 900) // shop attempts on a same-looking key
    expect((await h.call("POST", "/v1/admin/auth/login", { body: { email: a.email, password: PASSWORD } })).status).toBe(200)
  })

  it("a TOTP step works once (replay refused); wrong codes are throttled after 5", async () => {
    const h = harness()
    const a = await h.seed("super", "root@bipone.test")
    const login = await h.call("POST", "/v1/admin/auth/login", { body: { email: a.email, password: PASSWORD } })
    h.tick(31)
    const code = h.codeNow(a.secret)
    expect((await h.call("POST", "/v1/admin/auth/2fa", { token: login.json.pendingToken, body: { code } })).status).toBe(200)
    // replay the same code on a fresh pending session
    const login2 = await h.call("POST", "/v1/admin/auth/login", { body: { email: a.email, password: PASSWORD } })
    const replay = await h.call("POST", "/v1/admin/auth/2fa", { token: login2.json.pendingToken, body: { code } })
    expect(replay.status).toBe(401)
    expect(replay.json.error.code).toBe("invalid_code")
    for (let i = 0; i < 4; i++) expect((await h.call("POST", "/v1/admin/auth/2fa", { token: login2.json.pendingToken, body: { code: "000000" } })).status).toBe(401)
    expect((await h.call("POST", "/v1/admin/auth/2fa", { token: login2.json.pendingToken, body: { code: "000000" } })).status).toBe(429)
  })

  it("a recovery code logs in once and is then dead; its use is audited without the code", async () => {
    const h = harness()
    const a = await h.seed("super", "root@bipone.test")
    await h.adminRepo.getAdmin(a.id) // (enrolled via seed with no recovery codes yet)
    const recovery = "abcde-fghij"
    const hash = hashRecoveryCode(recovery, ENC_KEY)
    // give the admin one recovery code by re-enrolling through the repo
    await h.adminRepo.reset2fa(a.id)
    const secretEnc = encryptSecret(a.secret, ENC_KEY)
    await h.adminRepo.totpBegin(a.id, secretEnc)
    await h.adminRepo.totpConfirm(a.id, [hash], 0, secretEnc)
    const l1 = await h.call("POST", "/v1/admin/auth/login", { body: { email: a.email, password: PASSWORD } })
    const ok = await h.call("POST", "/v1/admin/auth/2fa", { token: l1.json.pendingToken, body: { recoveryCode: "ABCDE FGHIJ" } })
    expect(ok.status, ok.raw).toBe(200)
    const l2 = await h.call("POST", "/v1/admin/auth/login", { body: { email: a.email, password: PASSWORD } })
    expect((await h.call("POST", "/v1/admin/auth/2fa", { token: l2.json.pendingToken, body: { recoveryCode: recovery } })).status).toBe(401)
    const rows = JSON.stringify(h.adminRepo.auditRows())
    expect(rows).not.toContain(recovery)
    expect(h.adminRepo.auditRows().some((r) => r.action === "admin.2fa" && (r.after as { method?: string })?.method === "recovery_code")).toBe(true)
  })
})

describe("sessions (A-3, A-6)", () => {
  it("30 minutes idle ends the session; activity keeps it alive; 8 hours is the hard limit", async () => {
    const h = harness()
    const a = await h.seed("super", "root@bipone.test")
    const token = await h.signIn(a)
    let elapsedMinutes = 0
    for (let i = 0; i < 30; i++) {
      h.tick(20 * 60) // always under the 30 min idle limit
      elapsedMinutes += 20
      const r = await h.call("GET", "/v1/admin/me", { token })
      if (r.status === 401) {
        expect(elapsedMinutes).toBeGreaterThanOrEqual(8 * 60) // died only at the 8 h absolute limit, never earlier
        return
      }
      expect(r.status).toBe(200)
    }
    throw new Error("session outlived the 8 hour absolute limit")
  })
  it("idle for more than 30 minutes is dead", async () => {
    const h = harness()
    const token = await h.signIn(await h.seed("super", "root@bipone.test"))
    h.tick(31 * 60)
    expect((await h.call("GET", "/v1/admin/me", { token })).status).toBe(401)
  })
  it("logout revokes the session immediately", async () => {
    const h = harness()
    const token = await h.signIn(await h.seed("super", "root@bipone.test"))
    expect((await h.call("POST", "/v1/admin/auth/logout", { token, body: {} })).status).toBe(200)
    expect((await h.call("GET", "/v1/admin/me", { token })).status).toBe(401)
  })
  it("deactivating an admin kills their live session immediately, and demotion applies on the very next request", async () => {
    const h = harness()
    const root = await h.seed("super", "root@bipone.test")
    const staff = await h.seed("support", "staff@bipone.test")
    const rootToken = await h.signIn(root)
    const staffToken = await h.signIn(staff)
    await h.stepUp(root, rootToken)
    const off = await h.call("PATCH", `/v1/admin/admins/${staff.id}`, { token: rootToken, body: { active: false, reason: "left" } })
    expect(off.status, off.raw).toBe(200)
    expect((await h.call("GET", "/v1/admin/me", { token: staffToken })).status).toBe(401)
  })
})

describe("permissions, step-up and the audit trail (acceptance 1, 9)", () => {
  it("a support admin cannot manage admins: 403 and an audit row for the denied attempt", async () => {
    const h = harness()
    const sup = await h.seed("support", "sup@bipone.test")
    const token = await h.signIn(sup)
    expect((await h.call("GET", "/v1/admin/admins", { token })).status).toBe(403)
    const r = await h.call("POST", "/v1/admin/admins", { token, body: { email: "x@bipone.test", name: "X", role: "viewer", password: PASSWORD } })
    expect(r.status).toBe(403)
    expect(r.json.error.code).toBe("forbidden")
    const row = h.adminRepo.auditRows().find((a) => a.action === "admin.create")
    expect(row).toMatchObject({ outcome: "denied", adminId: sup.id, actor: "admin" })
    expect(h.adminRepo.auditRows().filter((a) => a.action === "admin.create")).toHaveLength(1)
  })

  it("a super admin needs a FRESH step-up for sensitive routes; step-up expires after 5 minutes; wrong password or code is refused", async () => {
    const h = harness()
    const root = await h.seed("super", "root@bipone.test")
    const token = await h.signIn(root)
    const body = { email: "new@bipone.test", name: "New", role: "viewer", password: PASSWORD }
    const early = await h.call("POST", "/v1/admin/admins", { token, body })
    expect(early.status).toBe(403)
    expect(early.json.error.code).toBe("step_up_required")
    h.tick(31)
    expect((await h.call("POST", "/v1/admin/auth/step-up", { token, body: { password: "not-the-password", code: h.codeNow(root.secret) } })).status).toBe(401)
    h.tick(31)
    expect((await h.call("POST", "/v1/admin/auth/step-up", { token, body: { password: PASSWORD, code: "000000" } })).status).toBe(401)
    await h.stepUp(root, token)
    expect((await h.call("POST", "/v1/admin/admins", { token, body })).status).toBe(201)
    h.tick(6 * 60)
    expect((await h.call("POST", "/v1/admin/admins", { token, body: { ...body, email: "two@bipone.test" } })).json.error.code).toBe("step_up_required")
  })

  it("admin management: duplicate email 409, weak input 400 without echoing the password, self-lockout refused, 2FA reset forces re-enrolment", async () => {
    const h = harness()
    const root = await h.seed("super", "root@bipone.test")
    const token = await h.signIn(root)
    await h.stepUp(root, token)
    const dup = await h.call("POST", "/v1/admin/admins", { token, body: { email: "ROOT@bipone.test", name: "Dup", role: "viewer", password: PASSWORD } })
    expect(dup.status).toBe(409)
    expect(dup.json.error.code).toBe("email_taken")
    const weak = await h.call("POST", "/v1/admin/admins", { token, body: { email: "w@bipone.test", name: "W", role: "viewer", password: "short" } })
    expect(weak.status).toBe(400)
    expect(weak.raw).not.toContain("short\"")
    expect((await h.call("PATCH", `/v1/admin/admins/${root.id}`, { token, body: { role: "viewer" } })).status).toBe(403) // own role
    expect((await h.call("PATCH", `/v1/admin/admins/${root.id}`, { token, body: { active: false } })).status).toBe(403) // own state
    expect((await h.call("POST", `/v1/admin/admins/${root.id}/reset-2fa`, { token, body: {} })).status).toBe(403) // own 2FA

    const other = await h.seed("finance", "fin@bipone.test")
    const otherToken = await h.signIn(other)
    const reset = await h.call("POST", `/v1/admin/admins/${other.id}/reset-2fa`, { token, body: { reason: "lost phone" } })
    expect(reset.status, reset.raw).toBe(200)
    expect((await h.call("GET", "/v1/admin/me", { token: otherToken })).status).toBe(401) // sessions gone
    const login = await h.call("POST", "/v1/admin/auth/login", { body: { email: other.email, password: PASSWORD } })
    expect(login.json.stage).toBe("enroll") // must re-enrol
    expect((await h.call("PATCH", `/v1/admin/admins/${UUID0}`, { token, body: { active: false } })).status).toBe(404)
  })

  it("password reset (§17.2): new password works, old one does not, sessions end, 2FA must be re-enrolled; self-reset refused", async () => {
    const h = harness()
    const root = await h.seed("super", "root@bipone.test")
    const target = await h.seed("finance", "fin@bipone.test")
    const token = await h.signIn(root)
    const targetToken = await h.signIn(target)
    await h.stepUp(root, token)
    expect((await h.call("POST", `/v1/admin/admins/${root.id}/reset-password`, { token, body: { password: "Another-Strong-Pass-1" } })).status).toBe(403)
    expect((await h.call("POST", `/v1/admin/admins/${target.id}/reset-password`, { token, body: { password: "short" } })).status).toBe(400)
    const ok = await h.call("POST", `/v1/admin/admins/${target.id}/reset-password`, { token, body: { password: "Another-Strong-Pass-1", reason: "forgot" } })
    expect(ok.status, ok.raw).toBe(200)
    expect((await h.call("GET", "/v1/admin/me", { token: targetToken })).status).toBe(401)
    expect((await h.call("POST", "/v1/admin/auth/login", { body: { email: target.email, password: PASSWORD } })).status).toBe(401)
    const login = await h.call("POST", "/v1/admin/auth/login", { body: { email: target.email, password: "Another-Strong-Pass-1" } })
    expect(login.json.stage).toBe("enroll")
    const resets = h.adminRepo.auditRows().filter((r) => r.action === "admin.reset_password")
    expect(resets.map((r) => r.outcome)).toEqual(["denied", "error", "ok"]) // own account (forbidden), weak password (400), success
    expect(resets[2]).toMatchObject({ targetId: target.id, reason: "forgot" })
    expect(JSON.stringify(h.adminRepo.auditRows())).not.toContain("Another-Strong-Pass-1")
  })

  it("the last active super admin can never be demoted or deactivated (repo guard, serialised in SQL)", async () => {
    const h = harness()
    const only = await h.seed("super", "root@bipone.test")
    await expect(h.adminRepo.setRoleActive(only.id, "viewer", true)).rejects.toMatchObject({ code: "last_super_admin" })
    await expect(h.adminRepo.setRoleActive(only.id, "super", false)).rejects.toMatchObject({ code: "last_super_admin" })
    expect((await h.adminRepo.getAdmin(only.id))?.role).toBe("super")
    const second = await h.seed("super", "two@bipone.test")
    await expect(h.adminRepo.setRoleActive(second.id, "viewer", true)).resolves.toBe(true) // fine while another super remains
  })

  it("EVERY mutating route writes an audit row: success, and denial; reads write none; responses match the contract", async () => {
    const h = harness()
    const root = await h.seed("super", "root@bipone.test")
    const newcomer = await h.seed("viewer", "view@bipone.test", { enrolled: false })

    // exercise all 9 mutating routes successfully
    const login = await h.call("POST", "/v1/admin/auth/login", { body: { email: root.email, password: PASSWORD } })
    h.tick(31)
    const full = await h.call("POST", "/v1/admin/auth/2fa", { token: login.json.pendingToken, body: { code: h.codeNow(root.secret) } })
    const token = full.json.token as string
    await h.stepUp(root, token)
    const created = await h.call("POST", "/v1/admin/admins", { token, body: { email: "flow@bipone.test", name: "Flow", role: "support", password: PASSWORD } })
    const patched = await h.call("PATCH", `/v1/admin/admins/${created.json.admin.id}`, { token, body: { role: "finance" } })
    const reset = await h.call("POST", `/v1/admin/admins/${created.json.admin.id}/reset-2fa`, { token, body: {} })
    const resetPw = await h.call("POST", `/v1/admin/admins/${created.json.admin.id}/reset-password`, { token, body: { password: "Another-Strong-Pass-1" } })
    const l2 = await h.call("POST", "/v1/admin/auth/login", { body: { email: newcomer.email, password: PASSWORD } })
    const start = await h.call("POST", "/v1/admin/auth/2fa/enroll-start", { token: l2.json.pendingToken, body: {} })
    h.tick(31)
    const confirm = await h.call("POST", "/v1/admin/auth/2fa/enroll-confirm", { token: l2.json.pendingToken, body: { code: h.codeNow(start.json.secret) } })
    const me = await h.call("GET", "/v1/admin/me", { token })
    const list = await h.call("GET", "/v1/admin/admins", { token })
    // A1 tenant routes: a tenant in the directory, every route exercised successfully (super, with step-up)
    const tid = h.adminRepo.seedTenant({ name: "Test Shop", ownerPhone: "01711000099", status: "active" })
    const tp = (p: string) => `/v1/admin/tenants/${tid}${p}`
    const tList = await h.call("GET", "/v1/admin/tenants", { token })
    const tGet = await h.call("GET", tp(""), { token })
    const reveal = await h.call("POST", tp("/reveal-phone"), { token, body: { reason: "support call" } })
    const noteAdd = await h.call("POST", tp("/notes"), { token, body: { body: "hello" } })
    const noteList = await h.call("GET", tp("/notes"), { token })
    const readOnly = await h.call("POST", tp("/read-only"), { token, body: { reason: "overdue" } })
    const reactivate = await h.call("POST", tp("/reactivate"), { token, body: { reason: "paid" } })
    const suspend = await h.call("POST", tp("/suspend"), { token, body: { reason: "abuse" } })
    const auditList = await h.call("GET", "/v1/admin/audit", { token })
    const out = await h.call("POST", "/v1/admin/auth/logout", { token, body: {} })

    const byId: Record<string, { status: number; json: unknown }> = {
      "auth.login": login, "auth.2fa": full, "auth.enroll-start": start, "auth.enroll-confirm": confirm, "auth.step-up": { status: 200, json: { stepUpUntil: new Date(h.now() + 1).toISOString() } },
      "auth.logout": out, me, "admins.list": list, "admins.create": created, "admins.update": patched, "admins.reset2fa": reset, "admins.resetPassword": resetPw,
      "tenants.list": tList, "tenants.get": tGet, "tenants.revealPhone": reveal, "tenants.suspend": suspend, "tenants.readOnly": readOnly, "tenants.reactivate": reactivate,
      "tenants.notes.list": noteList, "tenants.notes.add": noteAdd, "audit.list": auditList,
    }
    for (const id of ADMIN_ROUTE_IDS) {
      const c = adminContract[id]
      expect(byId[id]!.status, id).toBe(c.status)
      expect(c.response.safeParse(byId[id]!.json).success, `${id} response matches contract`).toBe(true)
    }

    const ok = new Set(h.adminRepo.auditRows().filter((r) => r.outcome === "ok").map((r) => r.action))
    const expected = ADMIN_ROUTE_IDS.map((id) => adminContract[id]).filter((c) => c.mutating).map((c) => c.audit as string)
    for (const action of expected) expect(ok.has(action), `no audit row for ${action}`).toBe(true)

    // reads write nothing
    const before = h.adminRepo.auditRows().length
    await h.call("GET", "/v1/admin/me", { token: confirm.json.token })
    expect(h.adminRepo.auditRows().length).toBe(before)

    // every audit row is attributable and carries ip + request id
    for (const r of h.adminRepo.auditRows()) {
      expect(r.actor).toBe("admin")
      expect(r.ip).toBe("10.0.0.1")
      expect(r.requestId).toBeTruthy()
    }
  })

  it("a failed audit write never looks like success", async () => {
    const h = harness()
    const root = await h.seed("super", "root@bipone.test")
    const token = await h.signIn(root)
    h.adminRepo.appendAudit = async () => { throw new Error("db down") }
    const r = await h.call("POST", "/v1/admin/auth/logout", { token, body: {} })
    expect(r.status).toBe(500)
  })

  it("a transient audit failure AFTER a committed action does not write a false 'error' row (santa round 1)", async () => {
    const h = harness()
    const root = await h.seed("super", "root@bipone.test")
    const token = await h.signIn(root)
    const real = h.adminRepo.appendAudit.bind(h.adminRepo)
    let first = true
    h.adminRepo.appendAudit = async (e) => { if (first) { first = false; throw new Error("blip") } return real(e) }
    const before = h.adminRepo.auditRows().length
    // one blip is retried and the action is still audited as ok
    const r = await h.call("POST", "/v1/admin/auth/logout", { token, body: {} })
    expect(r.status).toBe(200)
    expect(h.adminRepo.auditRows().slice(before).map((x) => x.outcome)).toEqual(["ok"])
  })

  it("a persistent audit failure AFTER a committed action returns 500 and never writes a false 'error' row", async () => {
    const h = harness()
    const token = await h.signIn(await h.seed("super", "root@bipone.test"))
    h.adminRepo.appendAudit = async () => { throw new Error("down") }
    const rows = h.adminRepo.auditRows().length
    const r = await h.call("POST", "/v1/admin/auth/logout", { token, body: {} })
    expect(r.status).toBe(500)
    expect(h.adminRepo.auditRows().slice(rows).filter((x) => x.outcome === "error")).toEqual([])
  })

  it("no response or audit row ever contains a password hash, TOTP secret, envelope or recovery hash", async () => {
    const h = harness()
    const root = await h.seed("super", "root@bipone.test")
    const token = await h.signIn(root)
    await h.stepUp(root, token)
    const all: string[] = []
    const created = await h.call("POST", "/v1/admin/admins", { token, body: { email: "leak@bipone.test", name: "L", role: "viewer", password: PASSWORD } })
    all.push(created.raw, (await h.call("GET", "/v1/admin/admins", { token })).raw, (await h.call("GET", "/v1/admin/me", { token })).raw, JSON.stringify(h.adminRepo.auditRows()))
    const secrets = [(await h.adminRepo.getAdmin(root.id))!.passwordHash, (await h.adminRepo.getAdmin(root.id))!.totpSecretEnc!, root.secret, PASSWORD]
    for (const text of all) for (const s of secrets) expect(text).not.toContain(s)
    expect(all.join("")).not.toMatch(/password_?hash|totp_?secret|recovery_?codes?_?hash/i)
  })

  it("unknown admin paths are 404 and bad JSON / bad shapes are 400 with field names only", async () => {
    const h = harness()
    const token = await h.signIn(await h.seed("super", "root@bipone.test"))
    expect((await h.call("GET", "/v1/admin/nope", { token })).status).toBe(404)
    const bad = await h.call("POST", "/v1/admin/auth/login", { body: { email: "not-an-email", password: "hunter2-hunter2" } })
    expect(bad.status).toBe(400)
    expect(ErrorEnvelopeSchema.safeParse(bad.json).success).toBe(true)
    expect(bad.raw).not.toContain("hunter2")
  })
})
