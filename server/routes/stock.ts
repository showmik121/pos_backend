import { decodeCursor, encodeCursor, parseLimit } from "../../src/domain/cursor.js"
import { DomainError } from "../../src/domain/errors.js"
import { parseUuid, presentProduct } from "../../src/domain/product.js"
import {
  BATCH_STATUSES,
  EXPIRING_DEFAULT_DAYS,
  EXPIRING_MAX_DAYS,
  dhakaToday,
  parseRemoval,
  parseStockIn,
  presentBatch,
  type BatchStatus,
} from "../../src/domain/stock.js"
import type { BatchListQuery } from "../../src/db/stock.js"
import { readJson, UUID, type Result, type RouteCtx } from "../http.js"

const STOCK_IN = new RegExp(`^POST /v1/products/(${UUID})/stock-ins$`)
const REMOVAL = new RegExp(`^POST /v1/batches/(${UUID})/removals$`)
const DATE = /^\d{4}-\d{2}-\d{2}$/

const bad = (msg: string) => new DomainError("invalid_input", msg)

function parseBatchQuery(url: URL, today: string): BatchListQuery {
  const q = url.searchParams
  const query: BatchListQuery = { limit: parseLimit(q.get("limit")), expiringWithinDays: EXPIRING_DEFAULT_DAYS, today }
  const productId = q.get("productId")
  if (productId) query.productId = parseUuid(productId, "productId")
  const status = q.get("status")
  if (status) {
    if (!(BATCH_STATUSES as readonly string[]).includes(status)) throw bad("status active, expired বা expiring হতে হবে")
    query.status = status as BatchStatus
  }
  const within = q.get("expiringWithinDays")
  if (within !== null) {
    if (!/^\d{1,4}$/.test(within) || Number(within) < 1 || Number(within) > EXPIRING_MAX_DAYS) {
      throw bad(`expiringWithinDays ১ থেকে ${EXPIRING_MAX_DAYS}-এর মধ্যে হতে হবে`)
    }
    query.expiringWithinDays = Number(within)
  }
  const cursor = q.get("cursor")
  if (cursor) {
    const [key, id] = decodeCursor(cursor, ["string", "string"]) as [string, string]
    if (!DATE.test(key)) throw bad("cursor সঠিক নয়")
    query.after = { key, id: parseUuid(id, "cursor") }
  }
  return query
}

function parseInstant(q: URLSearchParams, name: string): string | undefined {
  const v = q.get(name)
  if (!v) return undefined
  if (v.length > 40 || Number.isNaN(Date.parse(v))) throw bad(`${name} সঠিক সময় নয়`)
  return new Date(v).toISOString()
}

export async function stockRoutes(ctx: RouteCtx): Promise<Result | null> {
  const { req, key, repo } = ctx

  const stockIn = STOCK_IN.exec(key)
  if (stockIn) {
    const user = await ctx.authenticate()
    await ctx.rateLimit(user)
    const store = await repo.getStore(user.storeId)
    const cmd = parseStockIn(await readJson(req), stockIn[1]!, store?.kind === "pharmacy")
    const result = await repo.stockIn(user.storeId, user.id, cmd)
    if (!result) throw new DomainError("not_found", "পণ্য পাওয়া যায়নি")
    const today = dhakaToday(ctx.now())
    return {
      status: result.created ? 201 : 200,
      body: { batch: presentBatch(result.batch, user.role, today), product: presentProduct(result.product, user.role) },
    }
  }

  if (key === "GET /v1/batches") {
    const user = await ctx.authenticate()
    await ctx.rateLimit(user)
    const today = dhakaToday(ctx.now())
    const { items, hasMore } = await repo.listBatches(user.storeId, parseBatchQuery(new URL(req.url), today))
    const last = items[items.length - 1]
    return {
      status: 200,
      body: {
        items: items.map((b) => presentBatch(b, user.role, today)),
        nextCursor: hasMore && last ? encodeCursor([last.expiryDate ?? "9999-12-31", last.id]) : null,
      },
    }
  }

  const removal = REMOVAL.exec(key)
  if (removal) {
    const user = await ctx.authenticate()
    ctx.requireOwner(user)
    await ctx.rateLimit(user)
    const input = parseRemoval(await readJson(req))
    const result = await repo.removeBatch(user.storeId, user.id, removal[1]!, input)
    if (!result) throw new DomainError("not_found", "ব্যাচ পাওয়া যায়নি")
    return { status: result.created ? 201 : 200, body: { removal: result.removal } }
  }

  if (key === "GET /v1/batch-removals") {
    const user = await ctx.authenticate()
    ctx.requireOwner(user)
    await ctx.rateLimit(user)
    const q = new URL(req.url).searchParams
    const range: { from?: string; to?: string } = {}
    const from = parseInstant(q, "from")
    const to = parseInstant(q, "to")
    if (from) range.from = from
    if (to) range.to = to
    return { status: 200, body: await repo.listRemovals(user.storeId, range) }
  }

  return null
}
