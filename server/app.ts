import { DomainError } from "../src/domain/errors.js"
import { normalizePhone } from "../src/domain/phone.js"
import { hashPassword, verifyPassword, dummyHash } from "../src/auth/password.js"
import { signToken, verifyToken, assertSecret } from "../src/auth/token.js"
import { readJson, UUID as UUID_PART, type Result, type RouteCtx } from "./http.js"
import { duesRoutes } from "./routes/dues.js"
import { productRoutes } from "./routes/products.js"
import { stockRoutes } from "./routes/stock.js"
import type { ClientErrorReport, NewSyncEvent, PublicUser, Repo, StoreKind } from "../src/db/types.js"

// Web-standard (Request → Response) অ্যাপ: একই কোড Node (লোকাল) ও Supabase Edge Function (Deno) এ চলে।
// সব রুট /api প্রিফিক্সের নিচে: https://<ref>.supabase.co/functions/v1/api/v1/...

const STATUS: Record<string, number> = {
  invalid_credentials: 401,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  phone_taken: 409,
  id_conflict: 409,
  duplicate_barcode: 409,
  duplicate_phone: 409,
  overpay: 409,
  stale: 409,
  batch_required: 422,
  expiry_required: 422,
  no_carton: 422,
  reason_required: 422,
  too_many_attempts: 429,
  payload_too_large: 413,
}
const statusFor = (code: string) => STATUS[code] ?? 400

// সিংক: এক অনুরোধে সর্বোচ্চ ইভেন্ট, প্রতিটির সর্বোচ্চ আকার, শুধু মালিকের ইভেন্ট
const SYNC_MAX_BODY = 600 * 1024
const SYNC_MAX_EVENTS = 100
const SYNC_MAX_PAYLOAD = 32_000
const SYNC_PULL_DEFAULT = 200
const SYNC_PULL_MAX = 500
const HEALTH_CACHE_MS = 5_000
const HEALTH_TIMEOUT_MS = 3_000
const SYNC_OWNER_ONLY = new Set(["sale_voided", "settings_updated"])
const SYNC_LIMIT: Limit = { max: 600, window: 60 }
const REST_LIMIT: Limit = { max: 600, window: 60 } // দোকান-ভিত্তিক, REST (পণ্য/স্টক/বিক্রি) অনুরোধ
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

const CLIENT_ERROR_MAX_BODY = 16 * 1024
const CLIENT_ERROR_IP: Limit = { max: 10, window: 60 * 60 } // এক IP থেকে ঘণ্টায় ১০
const CLIENT_ERROR_ALL: Limit = { max: 100, window: 60 * 60 } // সব মিলিয়ে ঘণ্টায় ১০০ (টেবিল ফাঁপা হওয়া ঠেকায়)
const CLIENT_ERROR_KINDS = ["render", "window", "rejection"] as const

/** ক্র্যাশ রিপোর্ট ছেঁটে নেয়: লম্বা হলে কাটে, অচেনা ধরন বাদ; query/hash বাদ দিয়ে শুধু পথ রাখে (টোকেন/আইডি ফাঁস ঠেকায়) */
function parseClientError(b: Record<string, unknown>, storeId: string | null, userAgent: string | null): ClientErrorReport {
  const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.slice(0, max) : null)
  const message = text(b.message, 500)
  if (!message) throw new DomainError("invalid_input", "message দিন")
  const kind = CLIENT_ERROR_KINDS.find((k) => k === b.kind)
  if (!kind) throw new DomainError("invalid_input", "kind সঠিক নয়")
  const path = typeof b.path === "string" ? (b.path.split(/[?#]/)[0] ?? "").slice(0, 200) || null : null
  return { storeId, kind, message, stack: text(b.stack, 4000), path, appVersion: text(b.appVersion, 40), userAgent: userAgent?.slice(0, 200) || null }
}

const STORE_KINDS: StoreKind[] = ["pharmacy", "cosmetics", "other"]
const UUID = UUID_PART

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

export interface AppOptions {
  repo: Repo
  jwtSecret: string
  ttlSeconds?: number
  corsOrigins?: string[]
  now?: () => number
  /** স্বাস্থ্য-পরীক্ষায় ডেটাবেসের জন্য অপেক্ষা (মিলিসেকেন্ড); টেস্টে ছোট করা যায় */
  healthTimeoutMs?: number
}

export interface App {
  fetch(req: Request): Promise<Response>
}

export function createApp(opts: AppOptions): App {
  const { repo, jwtSecret, ttlSeconds = 43_200, corsOrigins = [], now = () => Date.now(), healthTimeoutMs = HEALTH_TIMEOUT_MS } = opts
  assertSecret(jwtSecret)

  // স্বাস্থ্য-পরীক্ষা: ডেটাবেস পিং, ছোট ক্যাশসহ (বারবার ডাকলে ডেটাবেসে চাপ পড়ে না)
  let healthCache: { at: number; result: Result } | null = null
  async function health(): Promise<Result> {
    const t = now()
    if (healthCache && t - healthCache.at < HEALTH_CACHE_MS) return healthCache.result
    let timer: ReturnType<typeof setTimeout> | undefined
    let result: Result
    try {
      await Promise.race([
        repo.ping(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("health timeout")), healthTimeoutMs)
        }),
      ])
      result = { status: 200, body: { status: "ok", db: "ok" } }
    } catch (err) {
      console.error("health: ডেটাবেস পরীক্ষা ব্যর্থ", err) // ভেতরের বার্তা শুধু লগে, উত্তরে নয়
      result = { status: 503, body: { status: "degraded", db: "down" } }
    } finally {
      clearTimeout(timer)
    }
    healthCache = { at: t, result }
    return result
  }

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

    if (key === "GET /health") return health()

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

    // ফ্রন্টএন্ড ক্র্যাশ রিপোর্ট: লগইন ছাড়াও আসতে পারে (অ্যাপ ভাঙলে সেশন নাও থাকতে পারে), তাই কড়া হার-সীমা ও ছোট বডি
    if (key === "POST /v1/client-errors") {
      const ip = clientIp(req)
      const checks: Array<[string, Limit]> = [...(ip ? ([[`cerr:i:${ip}`, CLIENT_ERROR_IP]] as Array<[string, Limit]>) : []), ["cerr:all", CLIENT_ERROR_ALL]]
      if (!(await withinLimits(checks))) throw tooMany()
      const b = await readJson(req, CLIENT_ERROR_MAX_BODY)
      // টোকেন থাকলে দোকান জানি, না থাকলে বা অচল হলেও রিপোর্ট নিই
      const storeId = await authenticate(req).then((u) => u.storeId, () => null)
      await repo.recordClientError(parseClientError(b, storeId, req.headers.get("user-agent")))
      return { status: 200, body: { ok: true } }
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

    // REST: পণ্য, স্টক, কাস্টমার, বিক্রি (routes/*.ts)
    const ctx: RouteCtx = {
      req,
      key,
      repo,
      authenticate: () => authenticate(req),
      requireOwner,
      now,
      rateLimit: async (user) => {
        if (!(await withinLimits([[`rest:s:${user.storeId}`, REST_LIMIT]]))) throw tooMany()
      },
    }
    const rest = (await productRoutes(ctx)) ?? (await stockRoutes(ctx)) ?? (await duesRoutes(ctx))
    if (rest) return rest

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
