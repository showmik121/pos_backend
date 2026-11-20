import { createHash } from "node:crypto"

// Throttle bucket names for admin login. The database caps a bucket at 200 characters (auth_attempts CHECK in migration 002) and an
// email may be 254, so the email is hashed: the key length is fixed whatever the caller sends, and the memory repo and Postgres agree.
// Shared by the login handler and the break-glass CLI reset (they must clear the very same buckets).
const norm = (email: string) => email.trim().toLowerCase()
const h = (email: string) => createHash("sha256").update(norm(email)).digest("hex").slice(0, 32)

/**
 * The unit a login limit counts as "one address". IPv4 stays as is. IPv6 is reduced to its /64 (the smallest block an ISP hands one
 * subscriber, so one host can otherwise mint 2^64 "different" addresses), lower-cased and zero-expanded so every spelling of the
 * same block is one bucket. IPv4-mapped IPv6 (::ffff:a.b.c.d) counts as that IPv4 address. Anything unparseable is kept verbatim.
 */
export function ipGroup(ip: string): string {
  const v = ip.trim().toLowerCase()
  if (!v.includes(":")) return v
  const mapped = /^(?:0{0,4}:){2,5}ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v)
  if (mapped) return mapped[1]!
  if (!/^[0-9a-f:.]+$/.test(v) || v.includes(".")) return v
  const [head, tail, extra] = v.split("::")
  if (extra !== undefined) return v
  const a = head ? head.split(":") : []
  const b = tail ? tail.split(":") : []
  if (tail === undefined ? a.length !== 8 : a.length + b.length > 7) return v
  const groups = tail === undefined ? a : [...a, ...Array<string>(8 - a.length - b.length).fill("0"), ...b]
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return v
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":") + "::/64"
}

export const loginEmailBucket = (email: string): string => `login:e:${h(email)}`
export const loginIpBucket = (ip: string): string => `login:i:${ipGroup(ip)}`
export const loginPairBucket = (email: string, ip: string): string => `login:p:${h(email)}|${ipGroup(ip)}`
