// আসল PostgreSQL এর বিরুদ্ধে চলে (CI এর "Postgres integration" জব, অথবা লোকালে নিচের env দিয়ে):
//   INTEGRATION_DATABASE_URL = pos_app রোলের URL (মাইগ্রেশনের পর, `npm run db:migrate`)
// না থাকলে পুরো ফাইল বাদ যায়। প্রতিটি টেস্ট নিজের আলাদা দোকান বানায়, তাই ডাটাবেস খালি না থাকলেও চলে।
import postgres from "postgres"
import { afterAll, describe, expect, it } from "vitest"
import { createApp } from "../../server/app.js"
import { createPgRepo } from "../../src/db/pg.js"

const URL_ = process.env.INTEGRATION_DATABASE_URL
const PASS = "Sobuj#Ghar2026"
const DEV = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const DEV2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

describe.skipIf(!URL_)("PostgreSQL: আসল ডাটাবেসে", () => {
  const repo = createPgRepo({ connectionString: URL_ ?? "", max: 4 })
  const app = createApp({ repo, jwtSecret: "k".repeat(40) })
  const raw = postgres(URL_ ?? "postgres://x@localhost/x", { max: 2, prepare: false, onnotice: () => {} })
  afterAll(async () => {
    await repo.close()
    await raw.end({ timeout: 5 })
  })

  let seed = Math.floor(Math.random() * 1e6)
  const phone = () => `017${String(seed++ % 1e8).padStart(8, "0")}`
  async function call(method: string, path: string, opts: { body?: unknown; token?: string } = {}) {
    const res = await app.fetch(
      new Request(`https://edge.test/api${path}`, {
        method,
        headers: { "content-type": "application/json", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      }),
    )
    const text = await res.text()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, json: (text ? JSON.parse(text) : null) as any }
  }
  async function shop() {
    const ph = phone()
    const r = await call("POST", "/v1/auth/register-store", { body: { storeName: "দোকান", ownerName: "মালিক", phone: ph, password: PASS } })
    expect(r.status).toBe(201)
    const sp = `018${ph.slice(3)}`
    const st = await call("POST", "/v1/staff", { token: r.json.token, body: { name: "রুবেল", phone: sp, password: "staffpass1" } })
    expect(st.status).toBe(201)
    const login = await call("POST", "/v1/auth/login", { body: { phone: sp, password: "staffpass1" } })
    return { owner: r.json.token as string, staff: login.json.token as string, storeId: r.json.user.storeId as string, phone: ph }
  }
  const evt = (kind: string, payload: Record<string, unknown> = { n: 1 }) => ({ id: crypto.randomUUID(), kind, at: "2026-11-18T10:00:00.000Z", payload })

  it("/health ডাটাবেস পিং করে ok দেয়", async () => {
    const r = await call("GET", "/health")
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ status: "ok", db: "ok" })
  })

  it("নিবন্ধন, লগইন, কর্মচারী ও একই ফোনে দ্বিতীয় নিবন্ধন আটকানো", async () => {
    const s = await shop()
    const login = await call("POST", "/v1/auth/login", { body: { phone: s.phone, password: PASS } })
    expect(login.status).toBe(200)
    const dup = await call("POST", "/v1/auth/register-store", { body: { storeName: "আরেক", ownerName: "কেউ", phone: s.phone, password: PASS } })
    expect(dup.status).toBe(409)
    const list = await call("GET", "/v1/staff", { token: s.owner })
    expect(list.json.staff).toHaveLength(2)
  })

  it("সিংক: দুই দোকানে একই deviceId আলাদা A পায়, ডিভাইস বদলালে B", async () => {
    const s1 = await shop()
    const s2 = await shop()
    const a1 = await call("POST", "/v1/sync/register-device", { token: s1.owner, body: { deviceId: DEV } })
    const a2 = await call("POST", "/v1/sync/register-device", { token: s2.owner, body: { deviceId: DEV } })
    const again = await call("POST", "/v1/sync/register-device", { token: s1.owner, body: { deviceId: DEV } })
    const b1 = await call("POST", "/v1/sync/register-device", { token: s1.owner, body: { deviceId: DEV2 } })
    expect([a1.json.code, a2.json.code, again.json.code, b1.json.code]).toEqual(["A", "A", "A", "B"])
  })

  it("সিংক: push → pull ক্রমে, ইডেমপোটেন্ট, কার্সর ও limit", async () => {
    const s = await shop()
    await call("POST", "/v1/sync/register-device", { token: s.owner, body: { deviceId: DEV } })
    const list = [evt("sale_created", { no: 1001 }), evt("product_upserted"), evt("customer_upserted")]
    const p1 = await call("POST", "/v1/sync/push", { token: s.owner, body: { deviceId: DEV, events: list } })
    expect(p1.status).toBe(200)
    await call("POST", "/v1/sync/push", { token: s.owner, body: { deviceId: DEV, events: [list[0]] } }) // আবার
    const all = await call("GET", "/v1/sync/pull?after=0", { token: s.owner })
    expect(all.json.events.map((e: { id: string }) => e.id)).toEqual(list.map((e) => e.id))
    expect(all.json.events[0].deviceCode).toBe("A")
    expect(all.json.events[0].payload).toEqual({ no: 1001 })
    const first = await call("GET", "/v1/sync/pull?after=0&limit=2", { token: s.owner })
    expect(first.json.hasMore).toBe(true)
    const rest = await call("GET", `/v1/sync/pull?after=${first.json.lastSeq}&limit=2`, { token: s.owner })
    expect(rest.json.events.map((e: { id: string }) => e.id)).toEqual([list[2]!.id])
  })

  it("সিংক: একসাথে অনেক push করলেও seq ক্রমে থাকে ও কিছু হারায় না", async () => {
    const s = await shop()
    await call("POST", "/v1/sync/register-device", { token: s.owner, body: { deviceId: DEV } })
    const batches = Array.from({ length: 8 }, () => [evt("sale_created"), evt("sale_created")])
    const rs = await Promise.all(batches.map((events) => call("POST", "/v1/sync/push", { token: s.owner, body: { deviceId: DEV, events } })))
    expect(rs.every((r) => r.status === 200)).toBe(true)
    const pull = await call("GET", "/v1/sync/pull?after=0&limit=100", { token: s.owner })
    const ids = pull.json.events.map((e: { id: string }) => e.id).sort()
    expect(ids).toEqual(batches.flat().map((e) => e.id).sort())
    const seqs: number[] = pull.json.events.map((e: { seq: number }) => e.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
  })

  it("সিংক: কর্মচারী sale_voided পাঠাতে পারে না, মালিক পারে; অনিবন্ধিত ডিভাইস আটকায়", async () => {
    const s = await shop()
    await call("POST", "/v1/sync/register-device", { token: s.owner, body: { deviceId: DEV } })
    expect((await call("POST", "/v1/sync/push", { token: s.staff, body: { deviceId: DEV, events: [evt("sale_voided")] } })).status).toBe(403)
    expect((await call("POST", "/v1/sync/push", { token: s.owner, body: { deviceId: DEV, events: [evt("sale_voided")] } })).status).toBe(200)
    expect((await call("POST", "/v1/sync/push", { token: s.owner, body: { deviceId: DEV2, events: [evt("sale_created")] } })).status).toBeGreaterThanOrEqual(400)
  })

  it("RLS: এক দোকান অন্য দোকানের ইভেন্ট pull-এ দেখে না, নিজের সীমার বাইরে লিখতেও পারে না", async () => {
    const s1 = await shop()
    const s2 = await shop()
    for (const s of [s1, s2]) await call("POST", "/v1/sync/register-device", { token: s.owner, body: { deviceId: DEV } })
    await call("POST", "/v1/sync/push", { token: s1.owner, body: { deviceId: DEV, events: [evt("sale_created")] } })
    expect((await call("GET", "/v1/sync/pull?after=0", { token: s2.owner })).json.events).toHaveLength(0)
  })

  it("RLS (সরাসরি SQL): দোকান ঠিক না করলে কিছু দেখা যায় না; অন্য দোকানের সারি ঢোকানো যায় না", async () => {
    const a = await shop()
    const b = await shop()
    const [{ n }] = await raw<{ n: string }[]>`SELECT count(*) AS n FROM stores`
    expect(Number(n)).toBe(0) // app.store_id ছাড়া RLS সব আটকায়
    const idA = a.storeId
    const idB = b.storeId
    expect(idA).not.toBe(idB)
    await raw.begin(async (tx) => {
      await tx`SELECT set_config('app.store_id', ${idA}, true)`
      const seen = await tx<{ id: string }[]>`SELECT id FROM stores`
      expect(seen.map((r: { id: string }) => r.id)).toEqual([idA])
      const users = await tx<{ store_id: string }[]>`SELECT store_id FROM users`
      expect(users.every((u: { store_id: string }) => u.store_id === idA)).toBe(true)
    })
    await expect(
      raw.begin(async (tx) => {
        await tx`SELECT set_config('app.store_id', ${idA}, true)`
        await tx`INSERT INTO sync_devices (store_id, device_id, code) VALUES (${idB}, ${crypto.randomUUID()}, 'Z')`
      }),
    ).rejects.toThrow(/row-level security/)
  })

  it("লগইন-থ্রটল (auth_throttle ফাংশন): ৫ বার ভুল পাসওয়ার্ডের পর ৪২৯", async () => {
    const s = await shop()
    const codes: number[] = []
    for (let i = 0; i < 6; i++) codes.push((await call("POST", "/v1/auth/login", { body: { phone: s.phone, password: "ভুল-পাসওয়ার্ড-১" } })).status)
    expect(codes.slice(0, 5).every((c) => c === 401)).toBe(true)
    expect(codes[5]).toBe(429)
  })

  it("ক্র্যাশ রিপোর্ট: ফাংশন দিয়ে লেখা যায় (একই ত্রুটি দুবার ঠিকঠাক), কিন্তু টেবিল সরাসরি পড়া/লেখা যায় না", async () => {
    const body = { kind: "window", message: `ইন্টিগ্রেশন-${Date.now()}`, stack: "Error\n at x", path: "/a/?t=1", appVersion: "t" }
    expect((await call("POST", "/v1/client-errors", { body })).status).toBe(200)
    expect((await call("POST", "/v1/client-errors", { body })).status).toBe(200)
    await expect(raw`SELECT * FROM client_errors`).rejects.toThrow(/permission denied/)
    await expect(raw`DELETE FROM client_errors`).rejects.toThrow(/permission denied/)
  })

  it("অনুমতি: pos_app password_hash পড়তে, ইভেন্ট বদলাতে/মুছতে, schema_migrations ছুঁতে পারে না", async () => {
    await expect(raw`SELECT password_hash FROM users LIMIT 1`).rejects.toThrow(/permission denied/)
    await expect(raw`UPDATE sync_events SET kind = 'zz_zz'`).rejects.toThrow(/permission denied/)
    await expect(raw`DELETE FROM sync_events`).rejects.toThrow(/permission denied/)
    await expect(raw`SELECT * FROM schema_migrations`).rejects.toThrow(/permission denied/)
  })

  // ---- ০০৬: পণ্য ও ব্যাচের স্কিমা (REST API-র আগের স্তর)
  async function asStore<T>(storeId: string, fn: (tx: typeof raw) => Promise<T>): Promise<T> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (await raw.begin(async (tx: any) => {
      await tx`SELECT set_config('app.store_id', ${storeId}, true)`
      return fn(tx)
    })) as T
  }

  it("০০৬: একই product id দুই দোকানে চলে, একে অপরের ডেটা দেখে না; বারকোড দোকান-ভিত্তিক ইউনিক", async () => {
    const a = await shop()
    const b = await shop()
    const pid = crypto.randomUUID()
    const code = `890${Date.now()}`
    await asStore(a.storeId, async (tx) => {
      await tx`INSERT INTO products (id, store_id, name, sell_price_poisha) VALUES (${pid}, ${a.storeId}, 'এ-পণ্য', 500)`
      await tx`INSERT INTO product_barcodes (store_id, code, product_id, pack_size) VALUES (${a.storeId}, ${code}, ${pid}, 1)`
    })
    await asStore(b.storeId, async (tx) => {
      expect(await tx`SELECT 1 FROM products WHERE id = ${pid}`).toHaveLength(0)
      await tx`INSERT INTO products (id, store_id, name, sell_price_poisha) VALUES (${pid}, ${b.storeId}, 'বি-পণ্য', 700)`
      await tx`INSERT INTO product_barcodes (store_id, code, product_id, pack_size) VALUES (${b.storeId}, ${code}, ${pid}, 1)`
    })
    await expect(
      asStore(b.storeId, (tx) => tx`INSERT INTO product_barcodes (store_id, code, product_id, pack_size) VALUES (${b.storeId}, ${code}, ${pid}, 10)`),
    ).rejects.toThrow(/duplicate key/)
  })

  it("০০৬: ব্যাচ — একই পণ্য+নম্বর+মেয়াদ মেশে (ইউনিক), ঋণাত্মক স্টক চলে, নিষিদ্ধ কলাম বদলানো যায় না, অন্য দোকানের পণ্যে ব্যাচ হয় না", async () => {
    const a = await shop()
    const b = await shop()
    const pid = crypto.randomUUID()
    const bid = crypto.randomUUID()
    await asStore(a.storeId, async (tx) => {
      await tx`INSERT INTO products (id, store_id, name, sell_price_poisha) VALUES (${pid}, ${a.storeId}, 'পণ্য', 500)`
      await tx`INSERT INTO stock_batches (id, store_id, product_id, batch_no, expiry_date, qty_remaining) VALUES (${bid}, ${a.storeId}, ${pid}, 'B1', '2027-01-31', 10)`
    })
    // ০০৯-এ ইউনিক সূচক সরানো হয়েছে (প্রজেক্টর ক্লায়েন্টের নিজস্ব ব্যাচ id রাখে); মেশানো এখন অ্যাপ লকের নিচে করে
    await asStore(a.storeId, (tx) => tx`INSERT INTO stock_batches (id, store_id, product_id, batch_no, expiry_date, qty_remaining) VALUES (${crypto.randomUUID()}, ${a.storeId}, ${pid}, 'B1', '2027-01-31', 5)`)
    await asStore(a.storeId, async (tx) => {
      await tx`UPDATE stock_batches SET qty_remaining = -3 WHERE id = ${bid}`
      const [row] = await tx`SELECT qty_remaining FROM stock_batches WHERE id = ${bid}`
      expect(row?.qty_remaining).toBe(-3)
    })
    await expect(
      asStore(a.storeId, (tx) => tx`UPDATE stock_batches SET expiry_date = '2030-01-01' WHERE id = ${bid}`),
    ).rejects.toThrow(/permission denied/)
    await asStore(b.storeId, async (tx) => {
      expect(await tx`SELECT 1 FROM stock_batches WHERE id = ${bid}`).toHaveLength(0)
    })
    await expect(
      asStore(b.storeId, (tx) => tx`INSERT INTO stock_batches (id, store_id, product_id, qty_remaining) VALUES (${crypto.randomUUID()}, ${b.storeId}, ${pid}, 1)`),
    ).rejects.toThrow(/foreign key/)
  })

  // ---- পণ্য API (আসল PostgreSQL, RLS ও ইনডেক্সসহ)
  const product = (over: Record<string, unknown> = {}) => ({
    id: crypto.randomUUID(),
    name: `পণ্য-${Math.random().toString(36).slice(2, 8)}`,
    unit: "strip",
    cartonSize: 10,
    costPoisha: 300,
    pricePoisha: 500,
    minStock: 5,
    category: "ওষুধ",
    open: false,
    barcodes: [{ code: `BC-${crypto.randomUUID()}`, packSize: 1 }],
    ...over,
  })

  it("পণ্য API: তৈরি, ইডেমপোটেন্ট, সমান্তরাল একই id, ভিন্ন বডিতে ৪০৯, বারকোড সংঘাত", async () => {
    const s = await shop()
    const p = product()
    const [r1, r2] = await Promise.all([
      call("POST", "/v1/products", { token: s.owner, body: p }),
      call("POST", "/v1/products", { token: s.owner, body: p }),
    ])
    expect([r1.status, r2.status].sort()).toEqual([200, 201])
    expect((await call("POST", "/v1/products", { token: s.owner, body: { ...p, pricePoisha: 1 } })).json.error.code).toBe("id_conflict")
    const dup = await call("POST", "/v1/products", { token: s.owner, body: product({ barcodes: p.barcodes }) })
    expect(dup.status).toBe(409)
    expect(dup.json.error.code).toBe("duplicate_barcode")
    const got = await call("GET", `/v1/products/${p.id}`, { token: s.owner })
    expect(got.json.product).toMatchObject({ id: p.id, pricePoisha: 500, costPoisha: 300, cartonSize: 10, stockQty: 0, barcodes: p.barcodes })
  })

  it("পণ্য API: দুই দোকানে একই id ও একই বারকোড আলাদা; অন্যের পণ্য ৪০৪; কর্মচারীর কাছে ক্রয়মূল্য null", async () => {
    const a = await shop()
    const b = await shop()
    const id = crypto.randomUUID()
    const code = `SH-${crypto.randomUUID()}`
    const pa = product({ id, name: "এ", barcodes: [{ code, packSize: 1 }] })
    const pb = product({ id, name: "বি", barcodes: [{ code, packSize: 1 }] })
    expect((await call("POST", "/v1/products", { token: a.owner, body: pa })).status).toBe(201)
    expect((await call("GET", `/v1/products/${id}`, { token: b.owner })).status).toBe(404)
    expect((await call("PATCH", `/v1/products/${id}`, { token: b.owner, body: { name: "হাইজ্যাক" } })).status).toBe(404)
    expect((await call("POST", "/v1/products", { token: b.owner, body: pb })).status).toBe(201)
    expect((await call("GET", `/v1/products/${id}`, { token: a.owner })).json.product.name).toBe("এ")
    expect((await call("GET", `/v1/products?barcode=${code}`, { token: b.owner })).json.items.map((x: { name: string }) => x.name)).toEqual(["বি"])
    expect((await call("GET", `/v1/products/${id}`, { token: a.staff })).json.product.costPoisha).toBeNull()
  })

  it("পণ্য API: তালিকা পেজিনেশন (প্রতিটি একবার), খোঁজা, PATCH ও stale", async () => {
    const s = await shop()
    const made: string[] = []
    for (let i = 0; i < 5; i++) {
      const p = product({ name: i % 2 ? `ক্রিম ${i}` : `সিরাপ ${i}`, category: i % 2 ? "কসমেটিক্স" : "ওষুধ" })
      made.push(p.id)
      expect((await call("POST", "/v1/products", { token: s.owner, body: p })).status).toBe(201)
    }
    const seen: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 6; page++) {
      const r = await call("GET", `/v1/products?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { token: s.owner })
      expect(r.status).toBe(200)
      seen.push(...r.json.items.map((x: { id: string }) => x.id))
      cursor = r.json.nextCursor
      if (!cursor) break
    }
    expect(new Set(seen)).toEqual(new Set(made))
    expect(seen).toHaveLength(5)
    expect((await call("GET", `/v1/products?q=${encodeURIComponent("ক্রিম")}`, { token: s.owner })).json.items).toHaveLength(2)
    expect((await call("GET", `/v1/products?category=${encodeURIComponent("ওষুধ")}`, { token: s.owner })).json.items).toHaveLength(3)
    const target = made[0]!
    const cur = (await call("GET", `/v1/products/${target}`, { token: s.owner })).json.product
    const stale = await call("PATCH", `/v1/products/${target}`, { token: s.owner, body: { name: "নতুন", expectedUpdatedAt: "2000-01-01T00:00:00.000Z" } })
    expect(stale.json.error.code).toBe("stale")
    const ok = await call("PATCH", `/v1/products/${target}`, { token: s.owner, body: { name: "নতুন", pricePoisha: 650, expectedUpdatedAt: cur.updatedAt } })
    expect(ok.status).toBe(200)
    expect(ok.json.product).toMatchObject({ name: "নতুন", pricePoisha: 650, costPoisha: 300 })
    const withCodes = await call("PATCH", `/v1/products/${target}`, { token: s.owner, body: { barcodes: [{ code: `N-${target}`, packSize: 1 }, { code: `C-${target}`, packSize: 10 }] } })
    expect(withCodes.json.product.barcodes).toHaveLength(2)
    const add = await call("POST", `/v1/products/${target}/barcodes`, { token: s.owner, body: { code: `C-${target}`, packSize: 10 } })
    expect(add.status).toBe(200)
  })

  const rcpt = (over: Record<string, unknown> = {}) => ({
    id: crypto.randomUUID(), qty: 10, unit: "piece", batchNo: "B1", expiryDate: "2030-06-30", costPoisha: 300, ...over,
  })

  it("স্টক API: জমা, একই ব্যাচে মেশা, ইডেমপোটেন্ট রসিদ, সমান্তরাল জমায় কিছু হারায় না", async () => {
    const s = await shop()
    const p = product()
    expect((await call("POST", "/v1/products", { token: s.owner, body: p })).status).toBe(201)
    const url = `/v1/products/${p.id}/stock-ins`
    const first = rcpt({ qty: 12, costPoisha: 320, pricePoisha: 550 })
    const a = await call("POST", url, { token: s.owner, body: first })
    expect(a.status).toBe(201)
    expect(a.json.batch).toMatchObject({ qtyRemaining: 12, costPoisha: 320, batchNo: "B1", expiryDate: "2030-06-30" })
    expect((await call("POST", url, { token: s.owner, body: first })).status).toBe(200)
    expect((await call("POST", url, { token: s.owner, body: { ...first, qty: 13 } })).json.error.code).toBe("id_conflict")
    const mixed = await Promise.all(Array.from({ length: 6 }, () => call("POST", url, { token: s.owner, body: rcpt({ qty: 5 }) })))
    expect(mixed.every((r) => r.status === 201)).toBe(true)
    expect(new Set(mixed.map((r) => r.json.batch.id)).size).toBe(1)
    const got = (await call("GET", `/v1/products/${p.id}`, { token: s.owner })).json.product
    expect(got).toMatchObject({ stockQty: 12 + 30, costPoisha: 300, pricePoisha: 550 })
    expect((await call("GET", `/v1/batches?productId=${p.id}`, { token: s.staff })).json.items[0].costPoisha).toBeNull()
  })

  it("স্টক API: ব্যাচ পেজিনেশন, status ফিল্টার, সরানো (শুধু মালিক), ক্ষতির খাতা, অন্য দোকানে অদৃশ্য", async () => {
    const s = await shop()
    const other = await shop()
    const p = product()
    await call("POST", "/v1/products", { token: s.owner, body: p })
    const url = `/v1/products/${p.id}/stock-ins`
    const ids: string[] = []
    for (const [no, exp] of [["A", "2030-01-31"], ["B", "2031-01-31"], ["C", "2032-01-31"], ["OLD", "2020-01-31"]] as const) {
      const r = await call("POST", url, { token: s.owner, body: rcpt({ batchNo: no, expiryDate: exp, qty: 4 }) })
      ids.push(r.json.batch.id)
    }
    const seen: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 6; page++) {
      const r = await call("GET", `/v1/batches?productId=${p.id}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { token: s.owner })
      expect(r.status).toBe(200)
      seen.push(...r.json.items.map((b: { batchNo: string }) => b.batchNo))
      cursor = r.json.nextCursor
      if (!cursor) break
    }
    expect(seen).toEqual(["OLD", "A", "B", "C"])
    const names = async (q: string) => (await call("GET", `/v1/batches?productId=${p.id}&${q}`, { token: s.owner })).json.items.map((b: { batchNo: string }) => b.batchNo)
    expect(await names("status=expired")).toEqual(["OLD"])
    expect(await names("status=active")).toEqual(["A", "B", "C"])
    expect((await call("GET", `/v1/batches?productId=${p.id}`, { token: other.owner })).json.items).toEqual([])
    const target = ids[1]!
    const body = { id: crypto.randomUUID(), reason: "নষ্ট" }
    expect((await call("POST", `/v1/batches/${target}/removals`, { token: s.staff, body })).status).toBe(403)
    expect((await call("POST", `/v1/batches/${target}/removals`, { token: other.owner, body })).status).toBe(404)
    expect((await call("POST", `/v1/batches/${target}/removals`, { token: s.owner, body })).status).toBe(201)
    expect((await call("POST", `/v1/batches/${target}/removals`, { token: s.owner, body })).status).toBe(200)
    expect(await names("status=active")).toEqual(["A", "C"])
    expect((await call("GET", `/v1/products/${p.id}`, { token: s.owner })).json.product.stockQty).toBe(12)
    const log = await call("GET", "/v1/batch-removals", { token: s.owner })
    expect(log.json.items).toHaveLength(1)
    expect(log.json.items[0]).toMatchObject({ batchNo: "B", qty: 4, costPoisha: 300, reason: "নষ্ট", by: "মালিক" })
    expect(log.json.totalLossPoisha).toBe(1200)
    expect((await call("GET", "/v1/batch-removals", { token: other.owner })).json.items).toEqual([])
  })

  it("কাস্টমার API: ইডেমপোটেন্ট তৈরি, ফোন সংঘাত, দোকান-ভিত্তিক আলাদা, সমান্তরাল একই id", async () => {
    const a = await shop()
    const b = await shop()
    const id = crypto.randomUUID()
    const ph = `017${String(seed++ % 1e8).padStart(8, "0")}`
    const body = { id, name: "করিম", phone: ph }
    const racing = await Promise.all(Array.from({ length: 4 }, () => call("POST", "/v1/customers", { token: a.owner, body })))
    expect(racing.map((r) => r.status).sort()).toEqual([200, 200, 200, 201])
    expect((await call("POST", "/v1/customers", { token: a.owner, body: { ...body, name: "অন্য" } })).json.error.code).toBe("id_conflict")
    const dup = await call("POST", "/v1/customers", { token: a.owner, body: { id: crypto.randomUUID(), name: "ডুপ", phone: ph } })
    expect([dup.status, dup.json.error.code]).toEqual([409, "duplicate_phone"])
    expect((await call("GET", `/v1/customers/${id}`, { token: b.owner })).status).toBe(404)
    expect((await call("POST", "/v1/customers", { token: b.owner, body })).status).toBe(201)
    expect((await call("GET", `/v1/customers?q=${encodeURIComponent("করি")}`, { token: a.owner })).json.items).toHaveLength(1)
  })

  it("বাকির খাতা API: আগের বাকি, আদায়, বেশি আদায় আটকানো, সমান্তরাল আদায়ে ব্যালান্স ঋণাত্মক হয় না, ইডেমপোটেন্সি, বাকির তালিকা", async () => {
    const s = await shop()
    const cid = crypto.randomUUID()
    await call("POST", "/v1/customers", { token: s.owner, body: { id: cid, name: "বাকিওয়ালা", phone: "" } })
    expect((await call("POST", `/v1/customers/${cid}/opening-balances`, { token: s.staff, body: { id: crypto.randomUUID(), amount: 1000 } })).status).toBe(403)
    const open = await call("POST", `/v1/customers/${cid}/opening-balances`, { token: s.owner, body: { id: crypto.randomUUID(), amount: 1000 } })
    expect([open.status, open.json.balancePoisha]).toEqual([201, 1000])
    // ১০০ করে ১৫টি সমান্তরাল আদায়: বাকি ১০০০ তাই ঠিক ১০টি সফল
    const pays = await Promise.all(
      Array.from({ length: 15 }, () => call("POST", `/v1/customers/${cid}/payments`, { token: s.staff, body: { id: crypto.randomUUID(), amount: 100, method: "nagad" } })),
    )
    expect(pays.filter((r) => r.status === 201)).toHaveLength(10)
    expect(pays.filter((r) => r.status === 409).every((r) => r.json.error.code === "overpay")).toBe(true)
    expect((await call("GET", `/v1/customers/${cid}`, { token: s.owner })).json.customer.balancePoisha).toBe(0)
    const replay = pays.find((r) => r.status === 201)!.json.entry
    const again = await call("POST", `/v1/customers/${cid}/payments`, { token: s.staff, body: { id: replay.id, amount: 100, method: "nagad" } })
    expect([again.status, again.json.balancePoisha]).toEqual([200, 0])
    const ledger = await call("GET", `/v1/customers/${cid}/ledger?limit=100`, { token: s.owner })
    expect(ledger.json.items).toHaveLength(11)
    expect((await call("GET", "/v1/dues", { token: s.owner })).json.items).toEqual([])
    await call("POST", `/v1/customers/${cid}/opening-balances`, { token: s.owner, body: { id: crypto.randomUUID(), amount: 700 } })
    const dues = await call("GET", "/v1/dues", { token: s.owner })
    expect(dues.json.items.map((r: { balancePoisha: number }) => r.balancePoisha)).toEqual([700])
    expect(dues.json.totalDuePoisha).toBe(700)
  })

  it("বিক্রি API: সমান্তরাল বিক্রিতে স্টক ঋণাত্মক হয় না, একই id একবারই, একই বিল নম্বরে একটিই, দুইবার বাতিলে স্টক একবারই ফেরে", async () => {
    const s = await shop()
    const pid = crypto.randomUUID()
    await call("POST", "/v1/products", { token: s.owner, body: product({ id: pid, name: "প্যারা", pricePoisha: 500, costPoisha: 300 }) })
    await call("POST", `/v1/products/${pid}/stock-ins`, { token: s.owner, body: rcpt({ qty: 5 }) })
    const qty = async () => (await call("GET", `/v1/products/${pid}`, { token: s.owner })).json.product.stockQty as number
    const sale = (no: number, over: Record<string, unknown> = {}) => ({
      id: crypto.randomUUID(), no, prefix: "A", lines: [{ productId: pid, qty: 1 }], payments: [{ method: "cash", amount: 500 }], ...over,
    })

    // ৮টি সমান্তরাল ১-পিসের বিক্রি, স্টক ৫: ঠিক ৫টি সফল, বাকিগুলো ৪০৯ insufficient_stock
    const racing = await Promise.all(Array.from({ length: 8 }, (_, i) => call("POST", "/v1/sales", { token: s.staff, body: sale(2001 + i) })))
    expect(racing.filter((r) => r.status === 201)).toHaveLength(5)
    expect(racing.filter((r) => r.status === 409).every((r) => r.json.error.code === "insufficient_stock")).toBe(true)
    expect(await qty()).toBe(0)

    // একই id সমান্তরালে: একটি ২০১, বাকিগুলো ২০০ (স্টকে ৫ ফিরিয়ে দেখি)
    await call("POST", `/v1/products/${pid}/stock-ins`, { token: s.owner, body: rcpt({ qty: 10, batchNo: "B2" }) })
    const same = sale(3001)
    const echo = await Promise.all(Array.from({ length: 4 }, () => call("POST", "/v1/sales", { token: s.staff, body: same })))
    expect(echo.map((r) => r.status).sort()).toEqual([200, 200, 200, 201])
    expect(await qty()).toBe(9)
    expect((await call("POST", "/v1/sales", { token: s.staff, body: { ...same, lines: [{ productId: pid, qty: 2 }] } })).json.error.code).toBe("id_conflict")

    // একই (উপসর্গ, নম্বর), ভিন্ন id: একটিই টেকে
    const twins = await Promise.all([call("POST", "/v1/sales", { token: s.staff, body: sale(4001) }), call("POST", "/v1/sales", { token: s.staff, body: sale(4001) })])
    expect(twins.map((r) => r.status).sort()).toEqual([201, 409])
    expect(twins.find((r) => r.status === 409)!.json.error.code).toBe("duplicate_bill_no")
    expect(await qty()).toBe(8)

    // দুইবার সমান্তরাল বাতিল: একটি ২০০, অন্যটি ৪০৯; স্টক একবারই ফেরে
    const target = echo.find((r) => r.status === 201)!.json.sale.id as string
    const voids = await Promise.all([1, 2].map(() => call("POST", `/v1/sales/${target}/void`, { token: s.owner, body: { reason: "ভুল" } })))
    expect(voids.map((r) => r.status).sort()).toEqual([200, 409])
    expect(await qty()).toBe(9)
    expect((await call("GET", `/v1/sales/${target}`, { token: s.staff })).json.sale.voided).toMatchObject({ by: "মালিক", reason: "ভুল" })
  })

  it("বিক্রি API: বাকির বিল খাতায় লেখে ও বাতিলে ফেরায়; অফলাইন বিলে স্টক ঋণাত্মক ও oversold; অন্য দোকানে অদৃশ্য", async () => {
    const s = await shop()
    const other = await shop()
    const pid = crypto.randomUUID()
    const cid = crypto.randomUUID()
    await call("POST", "/v1/products", { token: s.owner, body: product({ id: pid, name: "ক্রিম", pricePoisha: 1000, costPoisha: 600 }) })
    await call("POST", `/v1/products/${pid}/stock-ins`, { token: s.owner, body: rcpt({ qty: 3, batchNo: "C1", costPoisha: 600 }) })
    await call("POST", "/v1/customers", { token: s.owner, body: { id: cid, name: "রহিম", phone: "" } })

    const due = await call("POST", "/v1/sales", { token: s.staff, body: { id: crypto.randomUUID(), no: 1001, prefix: "A", customerId: cid, lines: [{ productId: pid, qty: 2 }], payments: [{ method: "cash", amount: 500 }] } })
    expect(due.status).toBe(201)
    expect(due.json.sale).toMatchObject({ total: 2000, due: 1500, customerName: "রহিম" })
    expect(due.json.sale.lines[0].allocations[0].costPoisha).toBeNull() // স্টাফের কাছে গোপন
    expect((await call("GET", `/v1/customers/${cid}`, { token: s.owner })).json.customer.balancePoisha).toBe(1500)
    const noCustomer = await call("POST", "/v1/sales", { token: s.staff, body: { id: crypto.randomUUID(), no: 1002, prefix: "A", lines: [{ productId: pid, qty: 1 }], payments: [] } })
    expect([noCustomer.status, noCustomer.json.error.code]).toEqual([400, "customer_required"])

    const off = await call("POST", "/v1/sales", { token: s.staff, body: { id: crypto.randomUUID(), no: 1001, prefix: "B", offline: true, at: "2026-11-01T10:00:00.000Z", lines: [{ productId: pid, qty: 4, unitPrice: 900 }], payments: [{ method: "cash", amount: 3600 }] } })
    expect(off.status).toBe(201)
    expect(off.json.sale).toMatchObject({ oversold: true, at: "2026-11-01T10:00:00.000Z", total: 3600 })
    expect((await call("GET", `/v1/products/${pid}`, { token: s.owner })).json.product.stockQty).toBe(-3)

    const voided = await call("POST", `/v1/sales/${due.json.sale.id}/void`, { token: s.owner, body: { reason: "ভুল বিল" } })
    expect(voided.json).toMatchObject({ restoredQty: 2, lostQty: 0, refundPoisha: 500 })
    expect((await call("GET", `/v1/customers/${cid}`, { token: s.owner })).json.customer.balancePoisha).toBe(0)
    expect((await call("GET", "/v1/sales", { token: s.owner })).json.items.map((x: { no: number }) => x.no)).toEqual([1001, 1001])
    expect((await call("GET", `/v1/sales/${due.json.sale.id}`, { token: other.owner })).status).toBe(404)
    expect((await call("GET", "/v1/sales", { token: other.owner })).json.items).toEqual([])
  })

  describe("প্রজেক্টর: ইভেন্ট → কাঠামোবদ্ধ টেবিল", () => {
    const U = (n: number) => `71000000-0000-4000-8000-${String(n).padStart(12, "0")}`
    const T = (m: number) => `2026-11-12T06:${String(m).padStart(2, "0")}:00.000Z`
    const E = (n: number, kind: string, m: number, payload: Record<string, unknown>) => ({ id: U(n), kind, at: T(m), payload })
    const prod = { id: U(1), name: "প্যারা", barcodes: [{ code: `89${seed++}`, packSize: 1 }], unit: "strip", cartonSize: 10, costPoisha: 300, pricePoisha: 500, minStock: 5, category: "ওষুধ", open: false, createdAt: T(0) }
    const cust = { id: U(2), name: "করিম", phone: "", createdAt: T(0) }
    const stockIn = { batchId: U(10), productId: U(1), batchNo: "B1", expiryDate: "2027-12-31", qty: 10, costPoisha: 300, receivedAt: T(1) }
    const saleBody = {
      id: U(50), no: 1001, prefix: "A", at: T(3), cashier: "রুবেল",
      lines: [{ productId: U(1), name: "প্যারা", qty: 4, unitPrice: 500, discount: 0, allocations: [{ batchId: U(10), batchNo: "B1", qty: 4, costPoisha: 300 }] }],
      subtotal: 2000, lineDiscount: 0, billDiscount: 0, total: 2000, payments: [{ method: "cash", amount: 1500 }], change: 0, due: 500,
      customerId: U(2), customerName: "করিম",
    }
    const saleLedger = { id: U(61), customerId: U(2), at: T(3), kind: "sale", amount: 500, saleNo: 1001, salePrefix: "A", by: "রুবেল" }
    const flow = () => [
      E(100, "product_upserted", 0, { product: prod }),
      E(101, "customer_upserted", 0, { customer: cust }),
      E(102, "stock_in", 1, stockIn),
      E(103, "sale_completed", 3, { sale: saleBody, ledger: saleLedger }),
    ]
    const qty = async (storeId: string) => {
      const r = await asStore(storeId, (tx) => tx`SELECT qty_remaining FROM stock_batches WHERE id = ${U(10)}`)
      return Number(r[0]?.qty_remaining)
    }

    it("পূর্ণ প্রবাহ: পণ্য, স্টক, বাকির বিল, আদায়, ব্যাচ সরানো — আর দ্বিতীয়বার দিলে কিছু বদলায় না", async () => {
      const s = await shop()
      const evs = [
        ...flow(),
        E(104, "due_received", 4, { entry: { id: U(62), customerId: U(2), at: T(4), kind: "payment", amount: 200, saleNo: null, by: "মালিক" } }),
        E(105, "batch_removed", 5, { removed: { id: U(70), at: T(5), by: "মালিক", batchId: U(10), productId: U(1), productName: "প্যারা", batchNo: "B1", expiryDate: "2027-12-31", qty: 6, costPoisha: 300, reason: "মেয়াদ শেষ" } }),
      ]
      const r1 = await repo.projection.project(s.storeId, evs)
      expect(r1).toEqual({ applied: 6, deferred: 0, ignored: 0, duplicate: 0, failed: 0 })
      const bill = await call("GET", `/v1/sales/${U(50)}`, { token: s.owner })
      expect(bill.status).toBe(200)
      expect(bill.json.sale.total).toBe(2000)
      expect(bill.json.sale.due).toBe(500)
      expect(bill.json.sale.cashier).toBe("রুবেল")
      expect(await qty(s.storeId)).toBe(0)
      const bal = await asStore(s.storeId, (tx) => tx`SELECT coalesce(sum(amount_poisha),0) AS b FROM due_ledger WHERE customer_id = ${U(2)}`)
      expect(Number(bal[0]?.b)).toBe(300)
      const r2 = await repo.projection.project(s.storeId, evs)
      expect(r2.duplicate).toBe(6)
      expect(r2.applied).toBe(0)
      expect(await qty(s.storeId)).toBe(0)
    })

    it("ক্রম উল্টো হলেও একই ফল: বিক্রি আগে এলে অপেক্ষায় থাকে, পণ্য-স্টক এলে বসে", async () => {
      const s = await shop()
      const [p, c, st, sl] = flow() as [ReturnType<typeof E>, ReturnType<typeof E>, ReturnType<typeof E>, ReturnType<typeof E>]
      // বাস্তবে ইভেন্ট আগে লগে ঢোকে, তারপর প্রজেক্ট হয়; অপেক্ষারতগুলো লগ থেকেই আবার পড়া হয়
      await asStore(s.storeId, async (tx) => {
        const [u] = await tx`SELECT id FROM users LIMIT 1`
        await tx`INSERT INTO sync_devices (store_id, device_id, code) VALUES (${s.storeId}, ${crypto.randomUUID()}, 'A')`
        await tx`INSERT INTO sync_events (store_id, id, device_code, user_id, kind, client_at, payload) VALUES (${s.storeId}, ${sl.id}, 'A', ${u?.id}, ${sl.kind}, ${sl.at}::timestamptz, ${tx.json(sl.payload as never)})`
      })
      const first = await repo.projection.project(s.storeId, [sl])
      expect(first.deferred).toBe(1)
      expect((await call("GET", `/v1/sales/${U(50)}`, { token: s.owner })).status).toBe(404)
      const second = await repo.projection.project(s.storeId, [st, c, p])
      expect(second.failed).toBe(0)
      expect((await call("GET", `/v1/sales/${U(50)}`, { token: s.owner })).status).toBe(200)
      expect(await qty(s.storeId)).toBe(6)
    })

    it("বাতিল: স্টক ফেরে, বাকি কমে, দ্বিতীয়বার দিলে দ্বিগুণ হয় না", async () => {
      const s = await shop()
      const voidEv = E(110, "sale_voided", 6, { saleId: U(50), voided: { at: T(6), by: "মালিক", reason: "ভুল বিল" }, ledger: { id: `void:${U(50)}`, customerId: U(2), at: T(6), kind: "void", amount: 500, saleNo: 1001, salePrefix: "A", by: "মালিক" } })
      await repo.projection.project(s.storeId, [...flow(), voidEv])
      expect(await qty(s.storeId)).toBe(10)
      const bal = await asStore(s.storeId, (tx) => tx`SELECT coalesce(sum(amount_poisha),0) AS b FROM due_ledger WHERE customer_id = ${U(2)}`)
      expect(Number(bal[0]?.b)).toBe(0)
      await repo.projection.project(s.storeId, [{ ...voidEv, id: U(111) }])
      expect(await qty(s.storeId)).toBe(10)
    })

    it("শেষ-বদল জেতে: পুরনো পণ্য-ইভেন্ট পরে এলেও নাম বদলায় না; খারাপ ইভেন্ট বাকিদের আটকায় না", async () => {
      const s = await shop()
      const newer = E(120, "product_upserted", 9, { product: { ...prod, name: "নতুন নাম" } })
      const older = E(121, "product_upserted", 2, { product: { ...prod, name: "পুরনো নাম" } })
      const junk = E(122, "product_upserted", 3, { product: { ...prod, unit: "kg" } })
      const r = await repo.projection.project(s.storeId, [newer, older, junk])
      expect(r.ignored).toBe(1)
      expect(r.failed).toBe(0)
      const row = await asStore(s.storeId, (tx) => tx`SELECT name FROM products WHERE id = ${U(1)}`)
      expect(row[0]?.name).toBe("নতুন নাম")
    })
  })
})
