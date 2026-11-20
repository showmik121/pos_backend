import { decodeCursor, encodeCursor, parseLimit } from "../../src/domain/cursor.js"
import { DomainError } from "../../src/domain/errors.js"
import { parseNewCustomer, parseOpening, parsePayment, type CustomerWithBalance } from "../../src/domain/dues.js"
import { parseUuid } from "../../src/domain/product.js"
import type { CustomerListQuery, DuesQuery, LedgerListQuery } from "../../src/db/dues.js"
import { readJson, UUID, type Result, type RouteCtx } from "../http.js"

const ITEM = new RegExp(`^GET /v1/customers/(${UUID})$`)
const PAYMENTS = new RegExp(`^POST /v1/customers/(${UUID})/payments$`)
const OPENING = new RegExp(`^POST /v1/customers/(${UUID})/opening-balances$`)
const LEDGER = new RegExp(`^GET /v1/customers/(${UUID})/ledger$`)

const bad = (msg: string) => new DomainError("invalid_input", msg)
const notFound = () => new DomainError("not_found", "কাস্টমার পাওয়া যায়নি")

const presentCustomer = (c: CustomerWithBalance) => ({ id: c.id, name: c.name, phone: c.phone, balancePoisha: c.balancePoisha, createdAt: c.createdAt })

function parseCustomerQuery(url: URL): CustomerListQuery {
  const q = url.searchParams
  const query: CustomerListQuery = { limit: parseLimit(q.get("limit")) }
  const search = q.get("q")
  if (search) {
    if (search.length > 100) throw bad("q খুব বড়")
    query.q = search
  }
  const cursor = q.get("cursor")
  if (cursor) {
    const [name, id] = decodeCursor(cursor, ["string", "string"]) as [string, string]
    query.after = { name, id: parseUuid(id, "cursor") }
  }
  return query
}

function parseLedgerQuery(url: URL): LedgerListQuery {
  const q = url.searchParams
  const query: LedgerListQuery = { limit: parseLimit(q.get("limit")) }
  const cursor = q.get("cursor")
  if (cursor) {
    const [at, id] = decodeCursor(cursor, ["string", "string"]) as [string, string]
    if (Number.isNaN(Date.parse(at))) throw bad("cursor সঠিক নয়")
    query.after = { at, id: parseUuid(id, "cursor") }
  }
  return query
}

function parseDuesQuery(url: URL): DuesQuery {
  const q = url.searchParams
  const query: DuesQuery = { limit: parseLimit(q.get("limit")) }
  const cursor = q.get("cursor")
  if (cursor) {
    const [balancePoisha, id] = decodeCursor(cursor, ["number", "string"]) as [number, string]
    query.after = { balancePoisha, id: parseUuid(id, "cursor") }
  }
  return query
}

export async function duesRoutes(ctx: RouteCtx): Promise<Result | null> {
  const { req, key, repo } = ctx

  if (key === "POST /v1/customers") {
    const user = await ctx.authenticate()
    await ctx.rateLimit(user)
    const { customer, created } = await repo.createCustomer(user.storeId, parseNewCustomer(await readJson(req)))
    return { status: created ? 201 : 200, body: { customer: presentCustomer(customer) } }
  }

  if (key === "GET /v1/customers") {
    const user = await ctx.authenticate()
    await ctx.rateLimit(user)
    const { items, hasMore } = await repo.listCustomers(user.storeId, parseCustomerQuery(new URL(req.url)))
    const last = items[items.length - 1]
    return { status: 200, body: { items: items.map(presentCustomer), nextCursor: hasMore && last ? encodeCursor([last.name, last.id]) : null } }
  }

  const item = ITEM.exec(key)
  if (item) {
    const user = await ctx.authenticate()
    await ctx.rateLimit(user)
    const customer = await repo.getCustomer(user.storeId, item[1]!)
    if (!customer) throw notFound()
    return { status: 200, body: { customer: presentCustomer(customer) } }
  }

  const payment = PAYMENTS.exec(key)
  const opening = OPENING.exec(key)
  if (payment || opening) {
    const user = await ctx.authenticate()
    if (opening) ctx.requireOwner(user) // আগের বাকি বসানো মালিকের কাজ
    await ctx.rateLimit(user)
    const body = await readJson(req)
    const input = opening ? parseOpening(body) : parsePayment(body)
    const result = await repo.addLedger(user.storeId, user.id, (payment ?? opening)![1]!, input)
    if (!result) throw notFound()
    return { status: result.created ? 201 : 200, body: { entry: result.entry, balancePoisha: result.balancePoisha } }
  }

  const ledger = LEDGER.exec(key)
  if (ledger) {
    const user = await ctx.authenticate()
    await ctx.rateLimit(user)
    const result = await repo.listLedger(user.storeId, ledger[1]!, parseLedgerQuery(new URL(req.url)))
    if (!result) throw notFound()
    const last = result.items[result.items.length - 1]
    return { status: 200, body: { items: result.items, nextCursor: result.hasMore && last ? encodeCursor([last.at, last.id]) : null } }
  }

  if (key === "GET /v1/dues") {
    const user = await ctx.authenticate()
    await ctx.rateLimit(user)
    const { items, hasMore, totalDuePoisha } = await repo.listDues(user.storeId, parseDuesQuery(new URL(req.url)))
    const last = items[items.length - 1]
    return { status: 200, body: { items, totalDuePoisha, nextCursor: hasMore && last ? encodeCursor([last.balancePoisha, last.customer.id]) : null } }
  }

  return null
}
