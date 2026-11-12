import { createHmac, timingSafeEqual } from "node:crypto"
import { Buffer } from "node:buffer"

// HS256 JWT — বাইরের লাইব্রেরি ছাড়া। অ্যালগরিদম সবসময় HS256 ধরা হয় (header এর alg বিশ্বাস করা হয় না)।
const b64u = (buf: string | Uint8Array): string => Buffer.from(buf).toString("base64url")
const HEADER = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }))

export type Role = "owner" | "staff"

export interface Claims {
  sub: string
  sid: string
  role: Role
  iat: number
  exp: number
}

function sign(data: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(data).digest()
}

export function assertSecret(secret: unknown): asserts secret is string {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error("JWT_SECRET কমপক্ষে ৩২ অক্ষরের হতে হবে")
  }
}

export function signToken(
  claims: Pick<Claims, "sub" | "sid" | "role">,
  secret: string,
  opts: { ttlSeconds?: number; now?: number } = {},
): string {
  assertSecret(secret)
  const { ttlSeconds = 43_200, now = Date.now() } = opts
  const iat = Math.floor(now / 1000)
  const payload = b64u(JSON.stringify({ ...claims, iat, exp: iat + ttlSeconds }))
  const data = `${HEADER}.${payload}`
  return `${data}.${b64u(sign(data, secret))}`
}

// ঠিক থাকলে claims ফেরত দেয়, নইলে null।
export function verifyToken(token: unknown, secret: string, opts: { now?: number } = {}): Claims | null {
  assertSecret(secret)
  const now = opts.now ?? Date.now()
  if (typeof token !== "string") return null
  const parts = token.split(".")
  if (parts.length !== 3 || parts[0] !== HEADER) return null
  const expected = sign(`${parts[0]}.${parts[1]}`, secret)
  const given = Buffer.from(parts[2], "base64url")
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Claims
    if (typeof claims.exp !== "number" || claims.exp <= Math.floor(now / 1000)) return null
    if (typeof claims.sub !== "string" || typeof claims.sid !== "string") return null
    return claims
  } catch {
    return null
  }
}
