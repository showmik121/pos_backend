import { randomBytes } from "node:crypto"
import { describe, expect, it } from "vitest"
import { decryptSecret, encryptSecret, generateRecoveryCodes, hashRecoveryCode, assertEncKey } from "../../src/auth/admin-crypto.js"
import { signAdminToken, verifyAdminToken } from "../../src/auth/admin-token.js"
import { signToken, verifyToken } from "../../src/auth/token.js"
import { base32Decode, base32Encode, generateTotpSecret, otpauthUri, totpCode, verifyTotp } from "../../src/auth/totp.js"
import { ADMIN_ACTIONS, can, requiresStepUp, type AdminRole } from "../../src/domain/admin-permissions.js"

const ADMIN_SECRET = "a".repeat(40)
const SHOP_SECRET = "s".repeat(40)

describe("TOTP (RFC 6238, SHA-1, 6 digits, 30 s)", () => {
  // RFC 6238 appendix B, secret = ASCII "12345678901234567890"
  const secret = base32Encode(Buffer.from("12345678901234567890"))
  it("matches the RFC 6238 test vectors (last 6 digits)", () => {
    expect(totpCode(secret, Math.floor(59 / 30))).toBe("287082")
    expect(totpCode(secret, Math.floor(1111111109 / 30))).toBe("081804")
    expect(totpCode(secret, Math.floor(1234567890 / 30))).toBe("005924")
  })
  it("base32 round-trips", () => {
    const raw = randomBytes(20)
    expect(Buffer.from(base32Decode(base32Encode(raw)))).toEqual(raw)
  })
  it("generates a 32-char base32 secret (160 bits) that differs every time", () => {
    const a = generateTotpSecret()
    expect(a).toMatch(/^[A-Z2-7]{32}$/)
    expect(generateTotpSecret()).not.toBe(a)
  })
  it("accepts the current step and +-1 step, rejects further drift and wrong codes", () => {
    const now = 1_700_000_000_000
    const step = Math.floor(now / 1000 / 30)
    expect(verifyTotp(secret, totpCode(secret, step), now)).toBe(step)
    expect(verifyTotp(secret, totpCode(secret, step - 1), now)).toBe(step - 1)
    expect(verifyTotp(secret, totpCode(secret, step + 1), now)).toBe(step + 1)
    expect(verifyTotp(secret, totpCode(secret, step + 2), now)).toBeNull()
    expect(verifyTotp(secret, totpCode(secret, step - 2), now)).toBeNull()
    expect(verifyTotp(secret, "000000", now)).toBeNull()
  })
  it("rejects malformed input without throwing", () => {
    for (const bad of ["", "12345", "1234567", "abcdef", "12 456", null, undefined, 123456]) {
      expect(verifyTotp(secret, bad as never, 1_700_000_000_000)).toBeNull()
    }
  })
  it("builds an otpauth URI with issuer and escaped label", () => {
    const uri = otpauthUri("JBSWY3DPEHPK3PXP", "a+b@example.com", "Bipone Admin")
    expect(uri).toBe("otpauth://totp/Bipone%20Admin:a%2Bb%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Bipone%20Admin&algorithm=SHA1&digits=6&period=30")
  })
})

describe("secret encryption (AES-256-GCM) and recovery codes", () => {
  const key = randomBytes(32).toString("base64")
  it("round-trips and uses a fresh IV each time", () => {
    const a = encryptSecret("JBSWY3DPEHPK3PXP", key)
    const b = encryptSecret("JBSWY3DPEHPK3PXP", key)
    expect(a).not.toBe(b)
    expect(a).not.toContain("JBSWY3DPEHPK3PXP")
    expect(decryptSecret(a, key)).toBe("JBSWY3DPEHPK3PXP")
  })
  it("fails on a wrong key, a tampered envelope, or garbage", () => {
    const enc = encryptSecret("secret", key)
    expect(() => decryptSecret(enc, randomBytes(32).toString("base64"))).toThrow()
    const parts = enc.split(".")
    parts[3] = Buffer.from("tampered").toString("base64url")
    expect(() => decryptSecret(parts.join("."), key)).toThrow()
    expect(() => decryptSecret("garbage", key)).toThrow()
  })
  it("requires a 32-byte base64 key", () => {
    expect(() => assertEncKey(randomBytes(16).toString("base64"))).toThrow(/ADMIN_TOTP_ENC_KEY/)
    expect(() => assertEncKey(undefined)).toThrow(/ADMIN_TOTP_ENC_KEY/)
    expect(() => assertEncKey(key)).not.toThrow()
  })
  it("makes 10 unique recovery codes; hashing ignores case, dashes and spaces", () => {
    const codes = generateRecoveryCodes()
    expect(codes).toHaveLength(10)
    expect(new Set(codes).size).toBe(10)
    for (const c of codes) expect(c).toMatch(/^[a-z2-7]{5}-[a-z2-7]{5}$/)
    const c = codes[0]!
    expect(hashRecoveryCode(c, key)).toBe(hashRecoveryCode(c.toUpperCase().replace("-", " "), key))
    expect(hashRecoveryCode(c, key)).not.toBe(hashRecoveryCode(codes[1]!, key))
    expect(hashRecoveryCode(c, key)).not.toContain(c.replace("-", ""))
  })
})

describe("admin token: own secret and audience (acceptance 3 building blocks)", () => {
  const now = 1_700_000_000_000
  const claims = { sub: "admin-1", sid: "sess-1" }
  it("round-trips for its audience and carries no role (role is read from the DB per request)", () => {
    const t = signAdminToken(claims, "admin", ADMIN_SECRET, { now, ttlSeconds: 600 })
    const v = verifyAdminToken(t, ADMIN_SECRET, "admin", { now })
    expect(v).toMatchObject({ sub: "admin-1", sid: "sess-1", aud: "admin" })
    expect(v).not.toHaveProperty("role")
  })
  it("rejects a pending token where an active one is required, and the reverse", () => {
    const pending = signAdminToken(claims, "admin-pending", ADMIN_SECRET, { now })
    const active = signAdminToken(claims, "admin", ADMIN_SECRET, { now })
    expect(verifyAdminToken(pending, ADMIN_SECRET, "admin", { now })).toBeNull()
    expect(verifyAdminToken(active, ADMIN_SECRET, "admin-pending", { now })).toBeNull()
  })
  it("rejects expired, tampered, wrong-secret and non-string tokens", () => {
    const t = signAdminToken(claims, "admin", ADMIN_SECRET, { now, ttlSeconds: 60 })
    expect(verifyAdminToken(t, ADMIN_SECRET, "admin", { now: now + 61_000 })).toBeNull()
    expect(verifyAdminToken(t + "x", ADMIN_SECRET, "admin", { now })).toBeNull()
    expect(verifyAdminToken(t, "b".repeat(40), "admin", { now })).toBeNull()
    expect(verifyAdminToken(undefined, ADMIN_SECRET, "admin", { now })).toBeNull()
  })
  it("a shop token is never accepted as an admin token, even with the SAME secret (aud check)", () => {
    const shop = signToken({ sub: "u", sid: "s", role: "owner" }, ADMIN_SECRET, { now })
    expect(verifyAdminToken(shop, ADMIN_SECRET, "admin", { now })).toBeNull()
  })
  it("an admin token is never accepted as a shop token, with the same or a different secret", () => {
    const t = signAdminToken(claims, "admin", ADMIN_SECRET, { now })
    expect(verifyToken(t, ADMIN_SECRET, { now })).toBeNull() // same secret: shop verifier refuses any token that carries aud
    expect(verifyToken(t, SHOP_SECRET, { now })).toBeNull()
  })
  it("refuses short secrets", () => {
    expect(() => signAdminToken(claims, "admin", "short", { now })).toThrow(/ADMIN_JWT_SECRET/)
  })
})

describe("admin permission matrix (PRD §3)", () => {
  const roles: AdminRole[] = ["super", "support", "finance", "viewer"]
  const allowed = (action: keyof typeof ADMIN_ACTIONS) => roles.filter((r) => can(r, action))
  it("only super manages admins", () => {
    for (const a of ["admins.list", "admins.create", "admins.update", "admins.reset2fa", "admins.resetPassword"] as const) expect(allowed(a)).toEqual(["super"])
  })
  it("support cannot suspend or touch billing; finance cannot suspend or impersonate", () => {
    expect(can("support", "tenant.suspend")).toBe(false)
    expect(can("support", "billing.payment.record")).toBe(false)
    expect(can("finance", "tenant.suspend")).toBe(false)
    expect(can("finance", "support.impersonate")).toBe(false)
    expect(can("finance", "billing.payment.record")).toBe(true)
    expect(can("super", "tenant.suspend")).toBe(true)
  })
  it("viewer is read-only with no personal-data reveal", () => {
    expect(can("viewer", "tenant.read")).toBe(true)
    expect(can("viewer", "tenant.reveal_phone")).toBe(false)
    expect(can("viewer", "health.read")).toBe(true)
    expect(can("viewer", "health.triage")).toBe(false)
    for (const a of Object.keys(ADMIN_ACTIONS) as (keyof typeof ADMIN_ACTIONS)[]) {
      if (a === "tenant.read" || a === "audit.read" || a === "health.read") continue
      expect(can("viewer", a), a).toBe(false)
    }
  })
  it("unknown roles and actions are denied (fail closed)", () => {
    expect(can("hacker" as never, "tenant.read")).toBe(false)
    expect(can("super", "nope" as never)).toBe(false)
  })
  it("destructive and identity actions require step-up; reads do not", () => {
    for (const a of ["tenant.suspend", "admins.create", "admins.update", "admins.reset2fa", "admins.resetPassword", "support.impersonate", "tenant.export"] as const) {
      expect(requiresStepUp(a), a).toBe(true)
    }
    expect(requiresStepUp("tenant.read")).toBe(false)
    expect(requiresStepUp("audit.read")).toBe(false)
  })
})
