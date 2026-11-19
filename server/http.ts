import { DomainError } from "../src/domain/errors.js"
import type { PublicUser, Repo } from "../src/db/types.js"

// রুট-ফাইলগুলোর জন্য সাধারণ টুল। app.ts এগুলো জোগায়, routes/*.ts ব্যবহার করে (উল্টো নির্ভরতা নেই)।
export const MAX_BODY = 100 * 1024

export type Result = { status: number; body: unknown }

export interface RouteCtx {
  req: Request
  /** "METHOD /path" (প্রিফিক্স /api বাদে) */
  key: string
  repo: Repo
  /** টোকেন যাচাই করে সক্রিয় ইউজার দেয়; না হলে unauthorized */
  authenticate(): Promise<PublicUser>
  /** দোকান-ভিত্তিক হার-সীমা (পেরোলে too_many_attempts) */
  rateLimit(user: PublicUser): Promise<void>
  /** মালিক না হলে forbidden */
  requireOwner(user: PublicUser): void
  now(): number
}

export const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"

export async function readJson(req: Request, maxBody = MAX_BODY): Promise<Record<string, unknown>> {
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
