import { describe, expect, it } from "vitest"
import { Buffer } from "node:buffer"
import { hashPassword, verifyPassword } from "../../src/auth/password.js"
import { signToken, verifyToken } from "../../src/auth/token.js"
import { createFailureLimiter } from "../../src/auth/rate-limit.js"

const SECRET = "x".repeat(40)

describe("পাসওয়ার্ড", () => {
  it("হ্যাশ ও যাচাই", async () => {
    const h = await hashPassword("correct horse")
    expect(h).toMatch(/^scrypt\$/)
    expect(await verifyPassword("correct horse", h)).toBe(true)
    expect(await verifyPassword("wrong horse", h)).toBe(false)
    expect(await verifyPassword("x", "garbage")).toBe(false)
    expect(h).not.toBe(await hashPassword("correct horse")) // আলাদা salt
    await expect(hashPassword("short")).rejects.toMatchObject({ code: "weak_password" })
  })
})

describe("টোকেন", () => {
  it("সই, মেয়াদ, ছেঁড়াফাঁড়া", () => {
    const now = 1_800_000_000_000
    const t = signToken({ sub: "u1", sid: "s1", role: "owner" }, SECRET, { ttlSeconds: 60, now })
    expect(verifyToken(t, SECRET, { now: now + 30_000 })?.sub).toBe("u1")
    expect(verifyToken(t, SECRET, { now: now + 61_000 })).toBeNull() // মেয়াদ শেষ
    expect(verifyToken(t, "y".repeat(40), { now })).toBeNull() // ভুল সিক্রেট

    const [h, p, s] = t.split(".")
    const forged = Buffer.from(JSON.stringify({ sub: "u1", sid: "OTHER", role: "owner", exp: 9e9 })).toString("base64url")
    expect(verifyToken(`${h}.${forged}.${s}`, SECRET, { now })).toBeNull() // payload বদলানো
    const none = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")
    expect(verifyToken(`${none}.${p}.`, SECRET, { now })).toBeNull() // alg=none আক্রমণ
    expect(verifyToken("abc", SECRET)).toBeNull()
    expect(() => signToken({ sub: "a", sid: "b", role: "owner" }, "short")).toThrow(/৩২/)
  })
})

describe("লগইন ব্যর্থতার সীমা", () => {
  it("সীমা পেরোলে আটকায়, সময় গেলে খোলে", () => {
    let t = 0
    const l = createFailureLimiter({ max: 3, windowMs: 1000, now: () => t })
    for (let i = 0; i < 3; i++) l.fail("k")
    expect(l.isBlocked("k")).toBe(true)
    expect(l.isBlocked("other")).toBe(false)
    t = 1500
    expect(l.isBlocked("k")).toBe(false)
    l.fail("k")
    l.reset("k")
    expect(l.isBlocked("k")).toBe(false)
  })
})
