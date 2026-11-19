import { decodeCursor, encodeCursor, parseLimit } from "../../src/domain/cursor.js"
import { DomainError } from "../../src/domain/errors.js"
import { parseUuid } from "../../src/domain/product.js"
import { parseSaleCommand, parseVoid, presentSale, saleFingerprint } from "../../src/domain/sales.js"
import { dhakaToday } from "../../src/domain/stock.js"
import type { SaleListQuery } from "../../src/db/sales.js"
import { readJson, UUID, type Result, type RouteCtx } from "../http.js"

const ITEM = new RegExp(`^GET /v1/sales/(${UUID})$`)
const VOID = new RegExp(`^POST /v1/sales/(${UUID})/void$`)
/** ঘড়ির সামান্য গরমিল মেনে নিতে: এর বেশি ভবিষ্যতের at গ্রহণ হয় না */
const CLOCK_SKEW_MS = 5 * 60 * 1000

const bad = (msg: string) => new DomainError("invalid_input", msg)
const notFound = () => new DomainError("not_found", "বিল পাওয়া যায়নি")

function parseInstant(q: URLSearchParams, name: string): string | undefined {
  const v = q.get(name)
  if (!v) return undefined
  if (v.length > 40 || Number.isNaN(Date.parse(v))) throw bad(`${name} সঠিক সময় নয়`)
  return new Date(v).toISOString()
}

function parseSaleQuery(url: URL): SaleListQuery {
  const q = url.searchParams
  const query: SaleListQuery = { limit: parseLimit(q.get("limit")) }
  const from = parseInstant(q, "from")
  const to = parseInstant(q, "to")
  if (from) query.from = from
  if (to) query.to = to
  const customerId = q.get("customerId")
  if (customerId) query.customerId = parseUuid(customerId, "customerId")
  const cursor = q.get("cursor")
  if (cursor) {
    const [at, id] = decodeCursor(cursor, ["string", "string"]) as [string, string]
    if (Number.isNaN(Date.parse(at))) throw bad("cursor সঠিক নয়")
    query.after = { at, id: parseUuid(id, "cursor") }
  }
  return query
}

export async function salesRoutes(ctx: RouteCtx): Promise<Result | null> {
  const { req, key, repo } = ctx

  if (key === "POST /v1/sales") {
    const user = await ctx.authenticate()
    await ctx.rateLimit(user)
    const cmd = parseSaleCommand(await readJson(req))
    if (cmd.at && Date.parse(cmd.at) > ctx.now() + CLOCK_SKEW_MS) throw bad("বিলের সময় ভবিষ্যতের হতে পারে না")
    const hash = await saleFingerprint(cmd)
    const { sale, created } = await repo.createSale(user.storeId, user.id, cmd, { hash, today: dhakaToday(ctx.now()) })
    return { status: created ? 201 : 200, body: { sale: presentSale(sale, user.role) } }
  }

  if (key === "GET /v1/sales") {
    const user = await ctx.authenticate()
    await ctx.rateLimit(user)
    const { items, hasMore } = await repo.listSales(user.storeId, parseSaleQuery(new URL(req.url)))
    const last = items[items.length - 1]
    return { status: 200, body: { items: items.map((s) => presentSale(s, user.role)), nextCursor: hasMore && last ? encodeCursor([last.at, last.id]) : null } }
  }

  const item = ITEM.exec(key)
  if (item) {
    const user = await ctx.authenticate()
    await ctx.rateLimit(user)
    const sale = await repo.getSale(user.storeId, item[1]!)
    if (!sale) throw notFound()
    return { status: 200, body: { sale: presentSale(sale, user.role) } }
  }

  const voidMatch = VOID.exec(key)
  if (voidMatch) {
    const user = await ctx.authenticate()
    ctx.requireOwner(user)
    await ctx.rateLimit(user)
    const { reason } = parseVoid(await readJson(req))
    const result = await repo.voidSale(user.storeId, user.id, voidMatch[1]!, reason)
    if (!result) throw notFound()
    const { sale, ...rest } = result
    return { status: 200, body: { sale: presentSale(sale, user.role), ...rest } }
  }

  return null
}
