import { decodeCursor, encodeCursor, parseLimit } from "../../src/domain/cursor.js"
import { DomainError } from "../../src/domain/errors.js"
import { parseBarcode, parseNewProduct, parseProductPatch, parseUuid, presentProduct } from "../../src/domain/product.js"
import type { ProductListQuery } from "../../src/db/catalog.js"
import { readJson, UUID, type Result, type RouteCtx } from "../http.js"

const ITEM = new RegExp(`^(GET|PATCH) /v1/products/(${UUID})$`)
const BARCODES = new RegExp(`^POST /v1/products/(${UUID})/barcodes$`)

function text(q: URLSearchParams, name: string, max: number): string | undefined {
  const v = q.get(name)
  if (v === null || v === "") return undefined
  if (v.length > max) throw new DomainError("invalid_input", `${name} খুব বড়`)
  return v
}

function parseListQuery(url: URL): ProductListQuery {
  const q = url.searchParams
  const query: ProductListQuery = { limit: parseLimit(q.get("limit")) }
  const search = text(q, "q", 100)
  const category = text(q, "category", 60)
  const barcode = text(q, "barcode", 64)
  if (search !== undefined) query.q = search
  if (category !== undefined) query.category = category
  if (barcode !== undefined) query.barcode = barcode
  const low = q.get("lowStock")
  if (low !== null && low !== "true" && low !== "false") throw new DomainError("invalid_input", "lowStock true/false হতে হবে")
  if (low === "true") query.lowStock = true
  const cursor = text(q, "cursor", 600)
  if (cursor !== undefined) {
    const [name, id] = decodeCursor(cursor, ["string", "string"]) as [string, string]
    query.after = { name, id: parseUuid(id, "cursor") }
  }
  return query
}

const notFound = () => new DomainError("not_found", "পণ্য পাওয়া যায়নি")

export async function productRoutes(ctx: RouteCtx): Promise<Result | null> {
  const { req, key, repo } = ctx

  if (key === "POST /v1/products") {
    const user = await ctx.authenticate()
    await ctx.rateLimit(user)
    const input = parseNewProduct(await readJson(req))
    const { product, created } = await repo.createProduct(user.storeId, input)
    return { status: created ? 201 : 200, body: { product: presentProduct(product, user.role) } }
  }

  if (key === "GET /v1/products") {
    const user = await ctx.authenticate()
    await ctx.rateLimit(user)
    const { items, hasMore } = await repo.listProducts(user.storeId, parseListQuery(new URL(req.url)))
    const last = items[items.length - 1]
    return {
      status: 200,
      body: {
        items: items.map((p) => presentProduct(p, user.role)),
        nextCursor: hasMore && last ? encodeCursor([last.name, last.id]) : null,
      },
    }
  }

  const item = ITEM.exec(key)
  if (item) {
    const user = await ctx.authenticate()
    await ctx.rateLimit(user)
    const id = item[2]!
    if (item[1] === "GET") {
      const product = await repo.getProduct(user.storeId, id)
      if (!product) throw notFound()
      return { status: 200, body: { product: presentProduct(product, user.role) } }
    }
    const patch = parseProductPatch(await readJson(req))
    const product = await repo.updateProduct(user.storeId, id, patch)
    if (!product) throw notFound()
    return { status: 200, body: { product: presentProduct(product, user.role) } }
  }

  const codes = BARCODES.exec(key)
  if (codes) {
    const user = await ctx.authenticate()
    await ctx.rateLimit(user)
    const result = await repo.addBarcode(user.storeId, codes[1]!, parseBarcode(await readJson(req)))
    if (!result) throw notFound()
    return { status: result.created ? 201 : 200, body: { product: presentProduct(result.product, user.role) } }
  }

  return null
}
