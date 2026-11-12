import { DomainError } from "../src/domain/errors.js"
import { normalizePhone } from "../src/domain/phone.js"
import { hashPassword, verifyPassword, dummyHash } from "../src/auth/password.js"
import { signToken, verifyToken, assertSecret } from "../src/auth/token.js"
import { createFailureLimiter, type FailureLimiter } from "../src/auth/rate-limit.js"
import type { PublicUser, Repo, StoreKind } from "../src/db/types.js"

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
const STORE_KINDS: StoreKind[] = ["pharmacy", "cosmetics", "other"]
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"

function cleanText(value: unknown, name: string, opts: { max?: number } = {}): string {
  const max = opts.max ?? 120
  const s = typeof value === "string" ? value.trim() : ""
  if (!s) throw new DomainError("invalid_input", `${name} দিন`)
  if (s.length > max) throw new DomainError("invalid_input", `${name} খুব বড়`)
  return s
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const declared = Number(req.headers.get("content-length") ?? 0)
  if (declared > MAX_BODY) throw new DomainError("payload_too_large", "অনুরোধ খুব বড়")
  const text = await req.text()
  if (text.length > MAX_BODY) throw new DomainError("payload_too_large", "অনুরোধ খুব বড়")
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
  limiter?: FailureLimiter
}

export interface App {
  fetch(req: Request): Promise<Response>
}

type Result = { status: number; body: unknown }

export function createApp(opts: AppOptions): App {
  const { repo, jwtSecret, ttlSeconds = 43_200, corsOrigins = [], now = () => Date.now() } = opts
  const limiter = opts.limiter ?? createFailureLimiter({ now })
  assertSecret(jwtSecret)

  const tokenFor = (user: PublicUser) =>
    signToken({ sub: user.id, sid: user.storeId, role: user.role }, jwtSecret, { ttlSeconds, now: now() })

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
      const b = await readJson(req)
      const storeName = cleanText(b.storeName, "দোকানের নাম")
      const ownerName = cleanText(b.ownerName, "আপনার নাম")
      const storeKind = (b.storeKind ?? "pharmacy") as StoreKind
      if (!STORE_KINDS.includes(storeKind)) throw new DomainError("invalid_input", "দোকানের ধরন সঠিক নয়")
      const phone = normalizePhone(b.phone)
      const passwordHash = await hashPassword(b.password)
      const { storeId, userId } = await repo.registerStore({ storeName, storeKind, ownerName, phone, passwordHash })
      const user: PublicUser = { id: userId, storeId, name: ownerName, phone, role: "owner", active: true }
      return { status: 201, body: { token: tokenFor(user), user } }
    }

    if (key === "POST /v1/auth/login") {
      const b = await readJson(req)
      const phone = normalizePhone(b.phone)
      if (limiter.isBlocked(phone)) {
        throw new DomainError("too_many_attempts", "অনেকবার ভুল হয়েছে, কিছুক্ষণ পরে চেষ্টা করুন")
      }
      const found = await repo.findUserByPhone(phone)
      const ok = await verifyPassword(String(b.password ?? ""), found?.passwordHash ?? (await dummyHash()))
      if (!found || !found.active || !ok) {
        limiter.fail(phone)
        throw new DomainError("invalid_credentials", "ফোন নম্বর বা পাসওয়ার্ড ঠিক নয়")
      }
      limiter.reset(phone)
      const { passwordHash: _omit, ...user } = found
      return { status: 200, body: { token: tokenFor(user), user } }
    }

    if (key === "GET /v1/me") {
      const user = await authenticate(req)
      const store = await repo.getStore(user.storeId)
      return { status: 200, body: { user, store } }
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
      const staff = await repo.createStaff(owner.storeId, {
        name: cleanText(b.name, "স্টাফের নাম"),
        phone: normalizePhone(b.phone),
        passwordHash: await hashPassword(b.password),
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
