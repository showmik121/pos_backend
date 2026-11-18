import { describe, expect, it } from "vitest"
import { Buffer } from "node:buffer"
import { hashPassword, verifyPassword } from "../../src/auth/password.js"
import { signToken, verifyToken } from "../../src/auth/token.js"

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

  it("দুর্বল পাসওয়ার্ড বাতিল", async () => {
    const weak = [
      "password123", // চালু তালিকায়
      "PASSWORD123", // বড় হাতেও একই
      "aaaaaaaa", // একই অক্ষর
      "12345678", // ধারা
      "87654321",
      "01712345678", // মোবাইল নম্বর
      "+8801712345678",
    ]
    for (const w of weak) await expect(hashPassword(w)).rejects.toMatchObject({ code: "weak_password" })
    // নিজের ফোন নম্বর (৮৮ ছাড়া) পাসওয়ার্ড হতে পারবে না
    await expect(hashPassword("01911223344", { phone: "01911223344" })).rejects.toMatchObject({ code: "weak_password" })
    // ভালো পাসওয়ার্ড চলে
    expect(await hashPassword("Sobuj#Ghar2026")).toMatch(/^scrypt\$/)
    expect(await hashPassword("staffpass1")).toMatch(/^scrypt\$/)
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
