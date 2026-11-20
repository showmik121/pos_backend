import { describe, expect, it } from "vitest"
import { start, uid } from "./helpers.js"

const cust = (over: Record<string, unknown> = {}) => ({ id: uid(), name: "করিম", phone: "01712345678", ...over })

async function setup() {
  const t = start()
  const s = await t.shop("01711111111")
  return { ...t, ...s }
}

describe("কাস্টমার", () => {
  it("তৈরি ২০১ (বাংলা অঙ্কের নম্বর ইংরেজিতে সংরক্ষণ), শুরুতে বাকি ০; একই বডি আবার ২০০; ভিন্ন বডিতে ৪০৯ id_conflict", async () => {
    const { call, staff } = await setup()
    const c = cust({ phone: "০১৭১২৩৪৫৬৭৮" })
    const r = await call("POST", "/v1/customers", { token: staff, body: c })
    expect(r.status).toBe(201)
    expect(r.json.customer).toMatchObject({ id: c.id, name: "করিম", phone: "01712345678", balancePoisha: 0 })
    expect((await call("POST", "/v1/customers", { token: staff, body: c })).status).toBe(200)
    const diff = await call("POST", "/v1/customers", { token: staff, body: { ...c, name: "রহিম" } })
    expect([diff.status, diff.json.error.code]).toEqual([409, "id_conflict"])
  })

  it("ফোন ছাড়াও চলে (খালি স্ট্রিং); একই ফোনে দ্বিতীয় কাস্টমার ৪০৯ duplicate_phone; ভুল ফোন/নাম ৪০০", async () => {
    const { call, owner } = await setup()
    const a = await call("POST", "/v1/customers", { token: owner, body: cust({ phone: "" }) })
    expect(a.status).toBe(201)
    expect(a.json.customer.phone).toBe("")
    expect((await call("POST", "/v1/customers", { token: owner, body: cust({ phone: "" }) })).status).toBe(201)
    expect((await call("POST", "/v1/customers", { token: owner, body: cust() })).status).toBe(201)
    const dup = await call("POST", "/v1/customers", { token: owner, body: cust({ phone: "+8801712345678" }) })
    expect([dup.status, dup.json.error.code]).toEqual([409, "duplicate_phone"])
    expect((await call("POST", "/v1/customers", { token: owner, body: cust({ phone: "12345" }) })).status).toBe(400)
    expect((await call("POST", "/v1/customers", { token: owner, body: cust({ name: "  " }) })).status).toBe(400)
    expect((await call("POST", "/v1/customers", { token: owner, body: cust({ id: "x" }) })).status).toBe(400)
  })

  it("প্রতি দোকানের কাস্টমার আলাদা: একই id ও একই ফোন দুই দোকানে চলে, অন্যেরটা ৪০৪", async () => {
    const t = start()
    const a = await t.shop("01711111111")
    const b = await t.shop("01722222222")
    const c = cust()
    expect((await t.call("POST", "/v1/customers", { token: a.owner, body: c })).status).toBe(201)
    expect((await t.call("GET", `/v1/customers/${c.id}`, { token: b.owner })).status).toBe(404)
    expect((await t.call("POST", "/v1/customers", { token: b.owner, body: c })).status).toBe(201)
    expect((await t.call("GET", "/v1/customers", { token: b.owner })).json.items).toHaveLength(1)
  })

  it("তালিকা: নামের ক্রমে, খোঁজা (নাম/ফোন), কার্সর-পেজিনেশনে প্রতিটি একবার", async () => {
    const { call, owner } = await setup()
    const ids: string[] = []
    for (const [i, name] of ["ক", "খ", "গ", "ঘ", "ঙ"].entries()) {
      const c = cust({ name: `${name}-কাস্টমার`, phone: `0171000000${i}` })
      ids.push(c.id)
      await call("POST", "/v1/customers", { token: owner, body: c })
    }
    const seen: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 6; page++) {
      const r = await call("GET", `/v1/customers?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { token: owner })
      expect(r.status).toBe(200)
      seen.push(...r.json.items.map((x: { id: string }) => x.id))
      cursor = r.json.nextCursor
      if (!cursor) break
    }
    expect(seen).toEqual(ids)
    expect((await call("GET", `/v1/customers?q=${encodeURIComponent("গ-")}`, { token: owner })).json.items).toHaveLength(1)
    expect((await call("GET", "/v1/customers?q=01710000003", { token: owner })).json.items[0].id).toBe(ids[3])
    expect((await call("GET", "/v1/customers?limit=0", { token: owner })).status).toBe(400)
  })
})

describe("বাকির খাতা", () => {
  async function withCustomer() {
    const t = await setup()
    const c = cust()
    await t.call("POST", "/v1/customers", { token: t.owner, body: c })
    return { ...t, c }
  }
  const owe = (call: ReturnType<typeof start>["call"], token: string, cid: string, amount: number, id = uid()) =>
    call("POST", `/v1/customers/${cid}/opening-balances`, { token, body: { id, amount } })

  it("আগের বাকি (শুধু মালিক) যোগ হয়, ব্যালান্স বাড়ে; স্টাফ ৪০৩; পরিমাণ ধনাত্মক পূর্ণসংখ্যা", async () => {
    const { call, owner, staff, c } = await withCustomer()
    expect((await owe(call, staff, c.id, 5000)).status).toBe(403)
    const r = await owe(call, owner, c.id, 5000)
    expect(r.status).toBe(201)
    expect(r.json.entry).toMatchObject({ kind: "opening", amountPoisha: 5000, by: "মালিক" })
    expect(r.json.balancePoisha).toBe(5000)
    expect((await call("GET", `/v1/customers/${c.id}`, { token: owner })).json.customer.balancePoisha).toBe(5000)
    for (const bad of [0, -5, 1.5, "100"]) expect((await owe(call, owner, c.id, bad as number)).status).toBe(400)
    expect((await owe(call, owner, uid(), 100)).status).toBe(404)
  })

  it("বাকি আদায় (স্টাফও পারে): ব্যালান্স কমে; বেশি আদায় ৪০৯ overpay; ঠিক শূন্য পর্যন্ত চলে", async () => {
    const { call, owner, staff, c } = await withCustomer()
    await owe(call, owner, c.id, 5000)
    const pay = (amount: number, over: Record<string, unknown> = {}) =>
      call("POST", `/v1/customers/${c.id}/payments`, { token: staff, body: { id: uid(), amount, method: "bkash", ...over } })
    const a = await pay(2000)
    expect(a.status).toBe(201)
    expect(a.json.entry).toMatchObject({ kind: "payment", amountPoisha: 2000, method: "bkash", by: "রুবেল" })
    expect(a.json.balancePoisha).toBe(3000)
    const over = await pay(3001)
    expect([over.status, over.json.error.code]).toEqual([409, "overpay"])
    expect((await pay(3000)).json.balancePoisha).toBe(0)
    expect((await pay(1)).json.error.code).toBe("overpay")
    expect((await pay(0)).status).toBe(400)
    expect((await pay(10, { method: "card" })).status).toBe(400)
  })

  it("পেমেন্ট ইডেমপোটেন্ট: একই id আবার = ২০০, দুবার কাটে না; ভিন্ন পরিমাণে ৪০৯ id_conflict", async () => {
    const { call, owner, c } = await withCustomer()
    await owe(call, owner, c.id, 5000)
    const body = { id: uid(), amount: 1000, method: "cash" }
    expect((await call("POST", `/v1/customers/${c.id}/payments`, { token: owner, body })).status).toBe(201)
    const again = await call("POST", `/v1/customers/${c.id}/payments`, { token: owner, body })
    expect(again.status).toBe(200)
    expect(again.json.balancePoisha).toBe(4000)
    const diff = await call("POST", `/v1/customers/${c.id}/payments`, { token: owner, body: { ...body, amount: 999 } })
    expect([diff.status, diff.json.error.code]).toEqual([409, "id_conflict"])
    expect((await call("GET", `/v1/customers/${c.id}`, { token: owner })).json.customer.balancePoisha).toBe(4000)
  })

  it("খাতার তালিকা: নতুন আগে, প্রতিটি এন্ট্রিতে kind/ধনাত্মক পরিমাণ/কে; কার্সর; অন্য দোকানে ৪০৪", async () => {
    const { call, owner, c } = await withCustomer()
    await owe(call, owner, c.id, 5000)
    await call("POST", `/v1/customers/${c.id}/payments`, { token: owner, body: { id: uid(), amount: 1000 } })
    await call("POST", `/v1/customers/${c.id}/payments`, { token: owner, body: { id: uid(), amount: 500 } })
    const all = await call("GET", `/v1/customers/${c.id}/ledger`, { token: owner })
    expect(all.status).toBe(200)
    expect(all.json.items).toHaveLength(3)
    expect(all.json.items.map((e: { kind: string }) => e.kind).sort()).toEqual(["opening", "payment", "payment"])
    expect(all.json.items.every((e: { amountPoisha: number }) => e.amountPoisha > 0)).toBe(true)
    const seen: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 5; page++) {
      const r = await call("GET", `/v1/customers/${c.id}/ledger?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { token: owner })
      seen.push(...r.json.items.map((e: { id: string }) => e.id))
      cursor = r.json.nextCursor
      if (!cursor) break
    }
    expect(new Set(seen).size).toBe(3)
    const other = await setup2(call)
    expect((await call("GET", `/v1/customers/${c.id}/ledger`, { token: other })).status).toBe(404)
    expect((await call("POST", `/v1/customers/${c.id}/payments`, { token: other, body: { id: uid(), amount: 1 } })).status).toBe(404)
  })

  it("বাকির তালিকা: শুধু বাকি > ০, বেশি বাকি আগে, মোট বাকিসহ", async () => {
    const { call, owner } = await setup()
    const mk = async (name: string, due: number) => {
      const c = cust({ name, phone: "" })
      await call("POST", "/v1/customers", { token: owner, body: c })
      if (due) await owe(call, owner, c.id, due)
      return c
    }
    const a = await mk("কম", 1000)
    const b = await mk("বেশি", 9000)
    await mk("শূন্য", 0)
    const paid = await mk("শোধ", 700)
    await call("POST", `/v1/customers/${paid.id}/payments`, { token: owner, body: { id: uid(), amount: 700 } })
    const r = await call("GET", "/v1/dues", { token: owner })
    expect(r.status).toBe(200)
    expect(r.json.items.map((x: { customer: { id: string } }) => x.customer.id)).toEqual([b.id, a.id])
    expect(r.json.items[0]).toMatchObject({ balancePoisha: 9000 })
    expect(r.json.totalDuePoisha).toBe(10000)
    const p1 = await call("GET", "/v1/dues?limit=1", { token: owner })
    expect(p1.json.items).toHaveLength(1)
    expect(p1.json.nextCursor).toBeTruthy()
    const p2 = await call("GET", `/v1/dues?limit=1&cursor=${encodeURIComponent(p1.json.nextCursor)}`, { token: owner })
    expect(p2.json.items[0].customer.id).toBe(a.id)
    expect(p2.json.nextCursor).toBeNull()
    expect(p2.json.totalDuePoisha).toBe(10000)
  })
})

async function setup2(call: ReturnType<typeof start>["call"]) {
  const r = await call("POST", "/v1/auth/register-store", { body: { storeName: "অন্য", ownerName: "অন্যজন", phone: "01733333333", storeKind: "pharmacy", password: "Sobuj#Ghar2026" } })
  return r.json.token as string
}
