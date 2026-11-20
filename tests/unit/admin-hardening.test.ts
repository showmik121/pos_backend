import { randomBytes } from "node:crypto"
import { describe, expect, it } from "vitest"
import { createApp } from "../../server/app.js"
import { createAdminViaCli, resetAdminViaCli } from "../../src/auth/admin-bootstrap.js"
import { decryptSecret, encryptSecret } from "../../src/auth/admin-crypto.js"
import { loginEmailBucket, loginIpBucket } from "../../src/auth/admin-throttle-keys.js"
import { hashPassword } from "../../src/auth/password.js"
import { generateTotpSecret } from "../../src/auth/totp.js"
import { createMemoryAdmin } from "../../src/db/memory-admin.js"
import { createMemoryRepo } from "../../src/db/memory.js"

// Findings from the A0 review (security + typescript reviewers):
//  - unauthenticated callers could append unlimited rows to the append-only audit table
//  - anyone who knew an admin email could keep that admin locked out of login, and the break-glass CLI did not unlock it
//  - the CLI reset could print a TOTP secret that was never stored (deactivated admin)
const ENC_KEY = randomBytes(32).toString("base64")
const PASSWORD = "Correct-Horse-Battery-9"

function harness() {
  const now = () => Date.parse("2026-11-20T06:00:00.000Z")
  const adminRepo = createMemoryAdmin({ now })
  const app = createApp({
    repo: createMemoryRepo({ now }), jwtSecret: "s".repeat(40), now,
    admin: { repo: adminRepo, jwtSecret: "a".repeat(40), totpEncKey: ENC_KEY },
  })
  async function call(method: string, path: string, o: { body?: unknown; token?: string; ip?: string } = {}) {
    const res = await app.fetch(new Request(`https://edge.test/api${path}`, {
      method,
      headers: { "content-type": "application/json", "x-real-ip": o.ip ?? "10.0.0.1", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) },
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
    }))
    const text = await res.text()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, json: (text ? JSON.parse(text) : null) as any }
  }
  return { adminRepo, call }
}

describe("unauthenticated callers cannot flood the append-only audit log", () => {
  it("caps the denied rows written for requests with no valid session, and always records real successes", async () => {
    const h = harness()
    const secretEnc = encryptSecret(generateTotpSecret(), ENC_KEY)
    const id = await h.adminRepo.createAdmin({ email: "root@bipone.test", name: "R", role: "super", passwordHash: await hashPassword(PASSWORD), totpSecretEnc: secretEnc, createdBy: null })
    await h.adminRepo.totpConfirm(id, [], 0, secretEnc)

    for (let i = 0; i < 120; i++) await h.call("POST", "/v1/admin/auth/logout", { token: "garbage.token.value", body: {} })

    const denied = h.adminRepo.auditRows().filter((r) => r.outcome !== "ok")
    expect(denied.length).toBeLessThanOrEqual(30)

    // a legitimate login from the same address is still audited after the flood
    const login = await h.call("POST", "/v1/admin/auth/login", { body: { email: "root@bipone.test", password: PASSWORD } })
    expect(login.status).toBe(200)
    expect(h.adminRepo.auditRows().some((r) => r.outcome === "ok" && r.targetId === id)).toBe(true)
  })

  it("bounds the length of attacker-chosen text stored in the audit row", async () => {
    const h = harness()
    const email = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.test`
    await h.call("POST", "/v1/admin/auth/login", { body: { email, password: PASSWORD } })
    const rows = h.adminRepo.auditRows()
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect((r.targetId ?? "").length).toBeLessThanOrEqual(120)
  })
})

describe("login lockout by email alone", () => {
  it("a stranger burning the per-email bucket from other addresses cannot lock the real admin out after ten tries", async () => {
    const h = harness()
    await h.adminRepo.createAdmin({ email: "root@bipone.test", name: "R", role: "super", passwordHash: await hashPassword(PASSWORD), totpSecretEnc: null, createdBy: null })
    for (let i = 0; i < 12; i++) await h.call("POST", "/v1/admin/auth/login", { body: { email: "root@bipone.test", password: "wrong-password-xyz" }, ip: `10.9.0.${i + 1}` })
    const ok = await h.call("POST", "/v1/admin/auth/login", { body: { email: "root@bipone.test", password: PASSWORD }, ip: "10.7.7.7" })
    expect(ok.status).toBe(200)
  })

  it("ONE address hammering an admin's email cannot fill the email bucket past what its own IP/pair limits allow (santa round 1)", async () => {
    const h = harness()
    await h.adminRepo.createAdmin({ email: "root@bipone.test", name: "R", role: "super", passwordHash: await hashPassword(PASSWORD), totpSecretEnc: null, createdBy: null })
    for (let i = 0; i < 60; i++) await h.call("POST", "/v1/admin/auth/login", { body: { email: "root@bipone.test", password: "wrong-password-xyz" }, ip: "6.6.6.6" })
    const ok = await h.call("POST", "/v1/admin/auth/login", { body: { email: "root@bipone.test", password: PASSWORD }, ip: "1.2.3.4" })
    expect(ok.status).toBe(200)
  })

  it("one IPv6 host rotating addresses inside its /64 is ONE address for the login limits (santa round 2)", async () => {
    const h = harness()
    await h.adminRepo.createAdmin({ email: "root@bipone.test", name: "R", role: "super", passwordHash: await hashPassword(PASSWORD), totpSecretEnc: null, createdBy: null })
    for (let i = 1; i <= 15; i++) for (let k = 0; k < 5; k++) {
      await h.call("POST", "/v1/admin/auth/login", { body: { email: "root@bipone.test", password: "wrong-password-xyz" }, ip: `2001:db8:0:1::${i.toString(16)}` })
    }
    const ok = await h.call("POST", "/v1/admin/auth/login", { body: { email: "root@bipone.test", password: PASSWORD }, ip: "1.2.3.4" })
    expect(ok.status).toBe(200)
  })

  it("IPv6 spellings of the same /64 map to the same bucket; IPv4 and other /64s stay separate", () => {
    expect(loginIpBucket("2001:DB8:0:1::5")).toBe(loginIpBucket("2001:db8:0:1:ffff::9"))
    expect(loginIpBucket("2001:db8::1")).toBe(loginIpBucket("2001:db8:0:0:0:0:0:2"))
    expect(loginIpBucket("2001:db8:0:2::1")).not.toBe(loginIpBucket("2001:db8:0:1::1"))
    expect(loginIpBucket("1.2.3.4")).toBe("login:i:1.2.3.4")
    expect(loginIpBucket("::ffff:1.2.3.4")).toBe("login:i:1.2.3.4")
  })

  it("the break-glass CLI reset clears the login and 2FA throttles so the operator can actually sign in", async () => {
    const h = harness()
    const creds = await createAdminViaCli(h.adminRepo, ENC_KEY, { email: "root@bipone.test", name: "Root" })
    for (let i = 0; i < 80; i++) await h.adminRepo.throttle(loginEmailBucket(creds.email), 50, 15 * 60)
    for (let i = 0; i < 10; i++) await h.adminRepo.throttle(`2fa:${creds.adminId}`, 5, 5 * 60)
    const blocked = await h.call("POST", "/v1/admin/auth/login", { body: { email: creds.email, password: creds.password }, ip: "10.7.7.7" })
    expect(blocked.status).toBe(429)

    const fresh = await resetAdminViaCli(h.adminRepo, ENC_KEY, creds.email)
    const ok = await h.call("POST", "/v1/admin/auth/login", { body: { email: fresh.email, password: fresh.password }, ip: "10.7.7.7" })
    expect(ok.status).toBe(200)
    expect(await h.adminRepo.throttle(`2fa:${creds.adminId}`, 5, 5 * 60)).toBe(true)
  })
})

describe("last-super rule counts only enrolled supers (same as SQL)", () => {
  it("an un-enrolled second super is not a spare: the only enrolled super cannot be demoted", async () => {
    const h = harness()
    const secretEnc = encryptSecret(generateTotpSecret(), ENC_KEY)
    const a = await h.adminRepo.createAdmin({ email: "a@bipone.test", name: "A", role: "super", passwordHash: "x", totpSecretEnc: secretEnc, createdBy: null })
    await h.adminRepo.totpConfirm(a, [], 1, secretEnc)
    await h.adminRepo.createAdmin({ email: "b@bipone.test", name: "B", role: "super", passwordHash: "x", totpSecretEnc: null, createdBy: null })
    await expect(h.adminRepo.setRoleActive(a, "viewer", true)).rejects.toMatchObject({ code: "last_super_admin" })
    expect((await h.adminRepo.getAdmin(a))?.role).toBe("super")
  })
})

describe("CLI break-glass reset", () => {
  it("prints only a TOTP secret that is really stored, even for a deactivated admin", async () => {
    const h = harness()
    const creds = await createAdminViaCli(h.adminRepo, ENC_KEY, { email: "support@bipone.test", name: "S", role: "support" })
    await h.adminRepo.setRoleActive(creds.adminId, "support", false)
    const fresh = await resetAdminViaCli(h.adminRepo, ENC_KEY, creds.email)
    const stored = (await h.adminRepo.getAdmin(creds.adminId))!
    expect(stored.active).toBe(true)
    expect(stored.totpSecretEnc).not.toBeNull()
    expect(decryptSecret(stored.totpSecretEnc!, ENC_KEY)).toBe(fresh.totpSecret)
  })
})
