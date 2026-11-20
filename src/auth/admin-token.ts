import { createHmac, timingSafeEqual } from "node:crypto"
import { Buffer } from "node:buffer"

// Admin JWT: HS256 like token.ts, but with its OWN secret (ADMIN_JWT_SECRET) and a mandatory audience.
//   aud "admin-pending" = password accepted, 2FA not yet done (may only reach the 2FA/enrolment routes)
//   aud "admin"         = fully authenticated session
// No role in the token: the role is read from the database on every request, so a demotion or
// deactivation applies immediately. sid points at admin_sessions (revocable, idle/absolute limits).
const b64u = (buf: string | Uint8Array): string => Buffer.from(buf).toString("base64url")
const HEADER = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }))

export type AdminAudience = "admin" | "admin-pending"

export interface AdminClaims {
  sub: string // platform_admins.id
  sid: string // admin_sessions.id
  aud: AdminAudience
  iat: number
  exp: number
}

export function assertAdminSecret(secret: unknown): asserts secret is string {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error("ADMIN_JWT_SECRET কমপক্ষে ৩২ অক্ষরের হতে হবে")
  }
}

const sign = (data: string, secret: string): Buffer => createHmac("sha256", secret).update(data).digest()

export function signAdminToken(
  claims: Pick<AdminClaims, "sub" | "sid">,
  aud: AdminAudience,
  secret: string,
  opts: { ttlSeconds?: number; now?: number } = {},
): string {
  assertAdminSecret(secret)
  const { ttlSeconds = 1_800, now = Date.now() } = opts
  const iat = Math.floor(now / 1000)
  const payload = b64u(JSON.stringify({ sub: claims.sub, sid: claims.sid, aud, iat, exp: iat + ttlSeconds }))
  const data = `${HEADER}.${payload}`
  return `${data}.${b64u(sign(data, secret))}`
}

/** Claims if valid for exactly this audience, otherwise null. */
export function verifyAdminToken(
  token: unknown,
  secret: string,
  aud: AdminAudience,
  opts: { now?: number } = {},
): AdminClaims | null {
  assertAdminSecret(secret)
  const now = opts.now ?? Date.now()
  if (typeof token !== "string") return null
  const parts = token.split(".")
  if (parts.length !== 3 || parts[0] !== HEADER) return null
  const expected = sign(`${parts[0]}.${parts[1]}`, secret)
  const given = Buffer.from(parts[2]!, "base64url")
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  try {
    const c = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Partial<AdminClaims>
    if (c.aud !== aud) return null
    if (typeof c.exp !== "number" || c.exp <= Math.floor(now / 1000)) return null
    if (typeof c.sub !== "string" || typeof c.sid !== "string" || typeof c.iat !== "number") return null
    return { sub: c.sub, sid: c.sid, aud: c.aud, iat: c.iat, exp: c.exp }
  } catch {
    return null
  }
}
