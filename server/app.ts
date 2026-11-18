import { DomainError } from "../src/domain/errors.js"
import { normalizePhone } from "../src/domain/phone.js"
import { hashPassword, verifyPassword, dummyHash } from "../src/auth/password.js"
import { signToken, verifyToken, assertSecret } from "../src/auth/token.js"
import type { NewSyncEvent, PublicUser, Repo, StoreKind } from "../src/db/types.js"

// Web-standard (Request → Response) অ্যাপ: একই কোড Node (লোকাল) ও Supabase Edge Function (Deno) এ চলে।
// সব রুট /api প্রিফিক্সের নিচে: https://<ref>.supabase.co/functions/v1/api/v1/...

const STATUS: Record<string, number> = {
  invalid_credentials: 401,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  phone_taken: 409,
  too_many_attempts: 429,
  payload_too_large: 413,
}
const statusFor = (code: string) => STATUS[code] ?? 400

const MAX_BODY = 100 * 1024
// সিংক: এক অনুরোধে সর্বোচ্চ ইভেন্ট, প্রতিটির সর্বোচ্চ আকার, শুধু মালিকের ইভেন্ট
const SYNC_MAX_BODY = 600 * 1024
const SYNC_MAX_EVENTS = 100
const SYNC_MAX_PAYLOAD = 32_000
const SYNC_PULL_DEFAULT = 200
const SYNC_PULL_MAX = 500
const SYNC_OWNER_ONLY = new Set(["sale_voided", "settings_updated"])
const SYNC_LIMIT: Limit = { max: 600, window: 60 }
const KIND_RE = /^[a-z][a-z0-9_]{1,39}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/

function parseDeviceId(v: unknown): string {
  if (typeof v !== "string" || !UUID_RE.test(v)) throw new DomainError("invalid_input", "deviceId সঠিক নয়")
  return v
}

function parseEvents(raw: unknown): NewSyncEvent[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > SYNC_MAX_EVENTS) {
    throw new DomainError("invalid_input", `events ১ থেকে ${SYNC_MAX_EVENTS}টি হতে হবে`)
  }
  return raw.map((r, i) => {
    const e = (r ?? {}) as Record<string, unknown>
    const where = `ইভেন্ট ${i + 1}`
    if (typeof e.id !== "string" || !UUID_RE.test(e.id)) throw new DomainError("invalid_input", `${where}: id সঠিক নয়`)
    if (typeof e.kind !== "string" || !KIND_RE.test(e.kind)) throw new DomainError("invalid_input", `${where}: kind সঠিক নয়`)
    if (typeof e.at !== "string" || !ISO_RE.test(e.at) || Number.isNaN(Date.parse(e.at))) throw new DomainError("invalid_input", `${where}: at সঠিক সময় নয়`)
    if (typeof e.payload !== "object" || e.payload === null || Array.isArray(e.payload)) throw new DomainError("invalid_input", `${where}: payload অবজেক্ট হতে হবে`)
    if (JSON.stringify(e.payload).length > SYNC_MAX_PAYLOAD) throw new DomainError("invalid_input", `${where}: payload খুব বড়`)
    return { id: e.id, kind: e.kind, at: e.at, payload: e.payload as Record<string, unknown> }
  })
}

const STORE_KINDS: StoreKind[] = ["pharmacy", "cosmetics", "other"]
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"

function cleanText(value: unknown, name: string, opts: { max?: number } = {}): string {
  const max = opts.max ?? 120
  const s = typeof value === "string" ? value.trim() : ""
  if (!s) throw new DomainError("invalid_input", `${name} দিন`)
  if (s.length > max) throw new DomainError("invalid_input", `${name} খুব বড়`)
  return s
}

// ক্লায়েন্টের IP। Supabase (Cloudflare এর পেছনে) cf-connecting-ip বসায়; না পেলে null (তখন IP-ভিত্তিক সীমা বাদ)।
export function clientIp(req: Request): string | null {
  const h = req.headers
  const raw = h.get("cf-connecting-ip") ?? h.get("x-real-ip") ?? h.get("x-forwarded-for")?.split(",")[0]
  const ip = raw?.trim()
  return ip && ip.length <= 64 && /^[0-9a-fA-F:.]+$/.test(ip) ? ip : null
}

// হার-সীমা (ডাটাবেসে গোনা হয়, তাই সব instance মিলে এক হিসাব)। window সেকেন্ডে।
interface Limit {
  max: number
  window: number
}
const LOGIN_PAIR: Limit = { max: 5, window: 15 * 60 } // একই ফোন + একই IP: ভুল পাসওয়ার্ড আন্দাজ ঠেকায়
const LOGIN_PHONE: Limit = { max: 50, window: 15 * 60 } // ছড়ানো IP থেকে আক্রমণের ওপরের সীমা
const LOGIN_IP: Limit = { max: 60, window: 15 * 60 } // এক IP থেকে নানা নম্বরে চেষ্টা
const REGISTER_IP: Limit = { max: 5, window: 60 * 60 }
const REGISTER_ALL: Limit = { max: 200, window: 60 * 60 }

async function readJson(req: Request, maxBody = MAX_BODY): Promise<Record<string, unknown>> {
  const declared = Number(req.headers.get("content-length") ?? 0)
  if (declared > maxBody) throw new DomainError("payload_too_large", "অনুরোধ খুব বড়")
  const text = await req.text()
  if (text.length > maxBody) throw new DomainError("payload_too_large", "অনুরোধ খুব বড়")
  if (!text) return {}
  try {
    const body: unknown = JSON.parse(text)
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("not object")
    return body as Record<string, unknown>
  } catch {
    throw new DomainError("invalid_json", "JSON সঠিক নয়")
  }
}

export interface AppOptions {
  repo: Repo
  jwtSecret: string
  ttlSeconds?: number
  corsOrigins?: string[]
  now?: () => number
}

export interface App {
  fetch(req: Request): Promise<Response>
}

type Result = { status: number; body: unknown }

export function createApp(opts: AppOptions): App {
  const { repo, jwtSecret, ttlSeconds = 43_200, corsOrigins = [], now = () => Date.now() } = opts
  assertSecret(jwtSecret)

  const tokenFor = (user: PublicUser) =>
    signToken({ sub: user.id, sid: user.storeId, role: user.role }, jwtSecret, { ttlSeconds, now: now() })

  // সবগুলো সীমার মধ্যে থাকলে true। একটিতে আটকালে বাকিগুলো আর গোনা হয় না।
  async function withinLimits(checks: Array<[string, Limit]>): Promise<boolean> {
    for (const [bucket, l] of checks) {
      if (!(await repo.throttle(bucket, l.max, l.window))) return false
    }
    return true
  }
  const tooMany = () => new DomainError("too_many_attempts", "অনেকবার চেষ্টা হয়েছে, কিছুক্ষণ পরে আবার চেষ্টা করুন")

  async function authenticate(req: Request): Promise<PublicUser> {
    const header = req.headers.get("authorization") ?? ""
    const claims = header.startsWith("Bearer ") ? verifyToken(header.slice(7), jwtSecret, { now: now() }) : null
    if (!claims) throw new DomainError("unauthorized", "আবার লগইন করুন")
    // টোকেন বৈধ থাকলেও ইউজার নিষ্ক্রিয় করা হয়ে থাকতে পারে — তাই প্রতিবার যাচাই
    const user = await repo.getUser(claims.sid, claims.sub)
    if (!user || !user.active) throw new DomainError("unauthorized", "আবার লগইন করুন")
    return user
  }

  function requireOwner(user: PublicUser) {
    if (user.role !== "owner") throw new DomainError("forbidden", "এটি শুধু মালিক করতে পারবেন")
  }

  async function route(req: Request, path: string): Promise<Result> {
    const key = `${req.method} ${path}`

    if (key === "GET /health") return { status: 200, body: { status: "ok" } }

    // A1: দোকান খোলা + মালিকের অ্যাকাউন্ট
    if (key === "POST /v1/auth/register-store") {
      const ip = clientIp(req)
      const checks: Array<[string, Limit]> = [...(ip ? ([[`reg:i:${ip}`, REGISTER_IP]] as Array<[string, Limit]>) : []), ["reg:all", REGISTER_ALL]]
      if (!(await withinLimits(checks))) throw tooMany()
      const b = await readJson(req)
      const storeName = cleanText(b.storeName, "দোকানের নাম")
      const ownerName = cleanText(b.ownerName, "আপনার নাম")
      const storeKind = (b.storeKind ?? "pharmacy") as StoreKind
      if (!STORE_KINDS.includes(storeKind)) throw new DomainError("invalid_input", "দোকানের ধরন সঠিক নয়")
      const phone = normalizePhone(b.phone)
      const passwordHash = await hashPassword(b.password, { phone })
      const { storeId, userId } = await repo.registerStore({ storeName, storeKind, ownerName, phone, passwordHash })
      const user: PublicUser = { id: userId, storeId, name: ownerName, phone, role: "owner", active: true }
      return { status: 201, body: { token: tokenFor(user), user } }
    }

    if (key === "POST /v1/auth/login") {
      const b = await readJson(req)
      const phone = normalizePhone(b.phone)
      const ip = clientIp(req)
      const pair = `login:p:${phone}|${ip ?? "?"}`
      const checks: Array<[string, Limit]> = [[pair, LOGIN_PAIR], [`login:p:${phone}`, LOGIN_PHONE]]
      if (ip) checks.push([`login:i:${ip}`, LOGIN_IP])
      if (!(await withinLimits(checks))) throw tooMany()
      const found = await repo.findUserByPhone(phone)
      const ok = await verifyPassword(String(b.password ?? ""), found?.passwordHash ?? (await dummyHash()))
      if (!found || !found.active || !ok) {
        throw new DomainError("invalid_credentials", "ফোন নম্বর বা পাসওয়ার্ড ঠিক নয়")
      }
      await repo.throttleReset(pair)
      const { passwordHash: _omit, ...user } = found
      return { status: 200, body: { token: tokenFor(user), user } }
    }

    if (key === "GET /v1/me") {
      const user = await authenticate(req)
      const store = await repo.getStore(user.storeId)
      return { status: 200, body: { user, store } }
    }

    // সিংক: ইভেন্ট-লগ (ডিভাইস নিবন্ধন, push, pull)
    if (key === "POST /v1/sync/register-device") {
      const user = await authenticate(req)
      const b = await readJson(req)
      const code = await repo.registerDevice(user.storeId, parseDeviceId(b.deviceId))
      return { status: 200, body: { code } }
    }

    if (key === "POST /v1/sync/push") {
      const user = await authenticate(req)
      if (!(await withinLimits([[`sync:s:${user.storeId}`, SYNC_LIMIT]]))) throw tooMany()
      const b = await readJson(req, SYNC_MAX_BODY)
      const deviceId = parseDeviceId(b.deviceId)
      const events = parseEvents(b.events)
      if (user.role !== "owner" && events.some((e) => SYNC_OWNER_ONLY.has(e.kind))) {
        throw new DomainError("forbidden", "এটি শুধু মালিক করতে পারবেন")
      }
      const accepted = await repo.pushEvents(user.storeId, user.id, deviceId, events)
      return { status: 200, body: { accepted } }
    }

    if (key === "GET /v1/sync/pull") {
      const user = await authenticate(req)
      if (!(await withinLimits([[`sync:s:${user.storeId}`, SYNC_LIMIT]]))) throw tooMany()
      const q = new URL(req.url).searchParams
      const afterText = q.get("after") ?? "0"
      const limitText = q.get("limit") ?? String(SYNC_PULL_DEFAULT)
      if (!/^\d{1,15}$/.test(afterText) || !/^\d{1,4}$/.test(limitText)) throw new DomainError("invalid_input", "after/limit সংখ্যা হতে হবে")
      const limit = Math.min(Math.max(Number(limitText), 1), SYNC_PULL_MAX)
      return { status: 200, body: await repo.pullEvents(user.storeId, Number(afterText), limit) }
    }

    // A2: স্টাফ ব্যবস্থাপনা (শুধু মালিক)
    if (key === "GET /v1/staff") {
      const user = await authenticate(req)
      requireOwner(user)
      return { status: 200, body: { staff: await repo.listStaff(user.storeId) } }
    }

    if (key === "POST /v1/staff") {
      const owner = await authenticate(req)
      requireOwner(owner)
      const b = await readJson(req)
      const phone = normalizePhone(b.phone)
      const staff = await repo.createStaff(owner.storeId, {
        name: cleanText(b.name, "স্টাফের নাম"),
        phone,
        passwordHash: await hashPassword(b.password, { phone }),
      })
      return { status: 201, body: { user: staff } }
    }

    const m = new RegExp(`^PATCH /v1/staff/(${UUID})$`).exec(key)
    if (m) {
      const owner = await authenticate(req)
      requireOwner(owner)
      const b = await readJson(req)
      if (typeof b.active !== "boolean") throw new DomainError("invalid_input", "active true/false হতে হবে")
      if (m[1] === owner.id) throw new DomainError("invalid_input", "নিজের অ্যাকাউন্ট বন্ধ করা যায় না")
      const updated = await repo.setUserActive(owner.storeId, m[1], b.active)
      if (!updated) throw new DomainError("not_found", "স্টাফ পাওয়া যায়নি")
      return { status: 200, body: { user: updated } }
    }

    throw new DomainError("not_found", "পাওয়া যায়নি")
  }

  function headers(req: Request): Headers {
    const h = new Headers({
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    })
    const origin = req.headers.get("origin")
    if (origin && corsOrigins.includes(origin)) {
      h.set("Access-Control-Allow-Origin", origin)
      h.set("Vary", "Origin")
      h.set("Access-Control-Allow-Headers", "Authorization, Content-Type")
      h.set("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS")
    }
    return h
  }

  return {
    async fetch(req) {
      const h = headers(req)
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: h })

      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h })

      try {
        const url = new URL(req.url)
        // Supabase Edge এ পাথ /api/... হিসেবে আসে (ফাংশনের নাম "api")
        const full = url.pathname.replace(/\/+$/, "") || "/"
        if (full !== "/api" && !full.startsWith("/api/")) throw new DomainError("not_found", "পাওয়া যায়নি")
        const result = await route(req, full.slice(4) || "/")
        return json(result.status, result.body)
      } catch (err) {
        if (err instanceof DomainError) {
          return json(statusFor(err.code), { error: { code: err.code, message: err.message, details: err.details ?? null } })
        }
        console.error(err)
        return json(500, { error: { code: "internal", message: "সার্ভারে সমস্যা হয়েছে, আবার চেষ্টা করুন", details: null } })
      }
    },
  }
}
