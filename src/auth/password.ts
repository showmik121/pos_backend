import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto"
import { Buffer } from "node:buffer"
import { DomainError } from "../domain/errors.js"
import { COMMON_PASSWORDS } from "./common-passwords.js"

const N = 16384
const R = 8
const P = 1
const KEYLEN = 64

function scrypt(password: string, salt: Uint8Array, keylen: number, opts: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)))
  })
}

const WEAK = () => new DomainError("weak_password", "এই পাসওয়ার্ডটি খুব সহজ, অন্য একটি দিন (অক্ষর ও সংখ্যা মিলিয়ে)")

// ১২৩৪৫৬৭৮ বা ৮৭৬৫৪৩২১ ধরনের ধারা
function isDigitRun(p: string): boolean {
  if (!/^\d+$/.test(p)) return false
  const d = [...p].map(Number)
  const step = (d[1] ?? 0) - (d[0] ?? 0)
  return Math.abs(step) === 1 && d.every((x, i) => i === 0 || x - (d[i - 1] ?? 0) === step)
}

export function validatePasswordStrength(password: unknown, ctx: { phone?: string } = {}): asserts password is string {
  if (typeof password !== "string" || password.length < 8) {
    throw new DomainError("weak_password", "পাসওয়ার্ড কমপক্ষে ৮ অক্ষরের হতে হবে")
  }
  if (password.length > 128) throw new DomainError("weak_password", "পাসওয়ার্ড খুব বড়")
  const p = password.toLowerCase()
  if (COMMON_PASSWORDS.has(p)) throw WEAK()
  if (/^(.)\1+$/u.test(p)) throw WEAK() // একই অক্ষর বারবার
  if (isDigitRun(p)) throw WEAK()
  if (/^(\+?88)?01[3-9]\d{8}$/.test(p)) throw WEAK() // মোবাইল নম্বরই পাসওয়ার্ড
  if (ctx.phone && p.replace(/^\+?88/, "") === ctx.phone) throw WEAK()
}

// ফরম্যাট: scrypt$N$r$p$saltB64$hashB64 — প্যারামিটার সংরক্ষিত থাকায় ভবিষ্যতে বাড়ানো যাবে।
export async function hashPassword(password: unknown, ctx: { phone?: string } = {}): Promise<string> {
  validatePasswordStrength(password, ctx)
  const salt = randomBytes(16)
  const hash = await scrypt(password, salt, KEYLEN, { N, r: R, p: P })
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${hash.toString("base64")}`
}

export async function verifyPassword(password: unknown, stored: unknown): Promise<boolean> {
  if (typeof password !== "string" || typeof stored !== "string") return false
  const parts = stored.split("$")
  if (parts.length !== 6 || parts[0] !== "scrypt") return false
  const [, n, r, p, saltB64, hashB64] = parts
  const salt = Buffer.from(saltB64, "base64")
  const expected = Buffer.from(hashB64, "base64")
  const actual = await scrypt(password, salt, expected.length, { N: Number(n), r: Number(r), p: Number(p) })
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

// ইউজার না পাওয়া গেলেও একই সময় খরচ করতে, যাতে সময় দেখে ফোন নম্বর আছে কিনা বোঝা না যায়।
// Edge এ cold-start এ খরচ এড়াতে প্রথম ব্যবহারে বানানো হয়।
let dummy: Promise<string> | undefined
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword("dummy-password-for-timing")
  return dummy
}
