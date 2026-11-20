import { randomBytes } from "node:crypto"
import { describe, expect, it } from "vitest"
import { createApp } from "../../server/app.js"
import { createAdminViaCli, generatePassword, resetAdminViaCli } from "../../src/auth/admin-bootstrap.js"
import { hashRecoveryCode } from "../../src/auth/admin-crypto.js"
import { totpCode } from "../../src/auth/totp.js"
import { createMemoryAdmin } from "../../src/db/memory-admin.js"
import { createMemoryRepo } from "../../src/db/memory.js"

const KEY = randomBytes(32).toString("base64")

function setup() {
  let t = Date.parse("2026-11-20T06:00:00.000Z")
  const now = () => t
  const repo = createMemoryAdmin({ now })
  const app = createApp({ repo: createMemoryRepo({ now }), jwtSecret: "s".repeat(40), now, admin: { repo, jwtSecret: "a".repeat(40), totpEncKey: KEY } })
  const call = async (method: string, path: string, o: { body?: unknown; token?: string } = {}) => {
    const res = await app.fetch(new Request(`https://edge.test/api${path}`, {
      method, headers: { "content-type": "application/json", "x-real-ip": "10.0.0.1", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) },
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
    }))
    const text = await res.text()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, json: (text ? JSON.parse(text) : null) as any }
  }
  return { repo, call, tick: (s: number) => { t += s * 1000 }, code: (secret: string) => totpCode(secret, Math.floor(t / 1000 / 30)) }
}

describe("create-admin CLI (PRD §17.1, §17.2)", () => {
  it("generates strong, typeable passwords", () => {
    for (let i = 0; i < 50; i++) {
      const p = generatePassword()
      expect(p).toHaveLength(24)
      expect(p).toMatch(/[A-Z]/)
      expect(p).toMatch(/[a-z]/)
      expect(p).toMatch(/[2-9]/)
      expect(p).toMatch(/[-_.!#]/)
      expect(p).not.toMatch(/[0OIl1]/)
    }
    expect(generatePassword()).not.toBe(generatePassword())
  })

  it("the first super admin it creates can sign in, enrol with the printed secret, and use the API", async () => {
    const s = setup()
    const creds = await createAdminViaCli(s.repo, KEY, { email: "Founder@Bipone.test", name: "Founder" })
    expect(creds.email).toBe("founder@bipone.test")
    expect(creds.otpauthUri).toContain(`secret=${creds.totpSecret}`)

    const login = await s.call("POST", "/v1/admin/auth/login", { body: { email: "founder@bipone.test", password: creds.password } })
    expect(login.status).toBe(200)
    expect(login.json.stage).toBe("enroll") // not enrolled until the first valid code
    s.tick(31)
    const done = await s.call("POST", "/v1/admin/auth/2fa/enroll-confirm", { token: login.json.pendingToken, body: { code: s.code(creds.totpSecret) } })
    expect(done.status).toBe(200)
    expect(done.json.recoveryCodes).toHaveLength(10)
    const me = await s.call("GET", "/v1/admin/me", { token: done.json.token })
    expect(me.json.admin).toMatchObject({ role: "super", email: "founder@bipone.test", enrolled: true })
  })

  it("audits with actor=cli and never records the password, the 2FA secret or its envelope", async () => {
    const s = setup()
    const creds = await createAdminViaCli(s.repo, KEY, { email: "founder@bipone.test", name: "Founder", role: "super" })
    const rows = s.repo.auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ actor: "cli", action: "admin.cli_create", outcome: "ok", adminId: creds.adminId })
    const dump = JSON.stringify(rows)
    for (const secret of [creds.password, creds.totpSecret, (await s.repo.getAdmin(creds.adminId))!.totpSecretEnc!, (await s.repo.getAdmin(creds.adminId))!.passwordHash]) {
      expect(dump).not.toContain(secret)
    }
  })

  it("rejects a duplicate email, a bad email and an empty name", async () => {
    const s = setup()
    await createAdminViaCli(s.repo, KEY, { email: "a@bipone.test", name: "A" })
    await expect(createAdminViaCli(s.repo, KEY, { email: "A@bipone.test", name: "A2" })).rejects.toMatchObject({ code: "email_taken" })
    await expect(createAdminViaCli(s.repo, KEY, { email: "nope", name: "X" })).rejects.toMatchObject({ code: "invalid_input" })
    await expect(createAdminViaCli(s.repo, KEY, { email: "b@bipone.test", name: "  " })).rejects.toMatchObject({ code: "invalid_input" })
  })

  it("--reset is the break-glass: new password and 2FA, old sessions and recovery codes die, a deactivated admin is reactivated", async () => {
    const s = setup()
    const first = await createAdminViaCli(s.repo, KEY, { email: "founder@bipone.test", name: "Founder" })
    const l = await s.call("POST", "/v1/admin/auth/login", { body: { email: first.email, password: first.password } })
    s.tick(31)
    const done = await s.call("POST", "/v1/admin/auth/2fa/enroll-confirm", { token: l.json.pendingToken, body: { code: s.code(first.totpSecret) } })
    await s.repo.consumeRecovery(first.adminId, hashRecoveryCode("zzzzz-zzzzz", KEY)) // no such code: stays false

    const again = await resetAdminViaCli(s.repo, KEY, "FOUNDER@bipone.test")
    expect(again.adminId).toBe(first.adminId)
    expect(again.password).not.toBe(first.password)
    expect((await s.call("GET", "/v1/admin/me", { token: done.json.token })).status).toBe(401) // old session gone
    expect((await s.call("POST", "/v1/admin/auth/login", { body: { email: first.email, password: first.password } })).status).toBe(401)
    const login = await s.call("POST", "/v1/admin/auth/login", { body: { email: first.email, password: again.password } })
    expect(login.json.stage).toBe("enroll")
    s.tick(31)
    expect((await s.call("POST", "/v1/admin/auth/2fa/enroll-confirm", { token: login.json.pendingToken, body: { code: s.code(again.totpSecret) } })).status).toBe(200)

    expect(s.repo.auditRows().filter((r) => r.actor === "cli").map((r) => r.action)).toEqual(["admin.cli_create", "admin.cli_reset"])
    await expect(resetAdminViaCli(s.repo, KEY, "ghost@bipone.test")).rejects.toMatchObject({ code: "not_found" })
  })
})
