import { describe, expect, it } from "vitest"
import { createApp } from "../../server/app.js"
import { createMemoryRepo } from "../../src/db/memory.js"

const SECRET = "k".repeat(40)

function start() {
  const repo = createMemoryRepo()
  const app = createApp({ repo, jwtSecret: SECRET })
  async function post(body: unknown, headers: Record<string, string> = {}) {
    const res = await app.fetch(
      new Request("https://edge.test/api/v1/client-errors", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }),
    )
    return { status: res.status, json: (await res.json()) as { ok?: boolean; error?: { code: string } } }
  }
  return { repo, post, app }
}

const report = { kind: "render", message: "Cannot read properties of undefined", stack: "TypeError: x\n at a (app.js:1:1)", path: "/stock/?token=SECRET#frag", appVersion: "abc123" }

describe("POST /v1/client-errors", () => {
  it("লগইন ছাড়াও রিপোর্ট নেয়; query ও hash কেটে শুধু পথ রাখে", async () => {
    const { repo, post } = start()
    expect((await post(report, { "user-agent": "TestUA/1" })).status).toBe(200)
    const [saved] = repo.peekClientErrors()
    expect(saved).toMatchObject({ kind: "render", path: "/stock/", appVersion: "abc123", userAgent: "TestUA/1", storeId: null, count: 1 })
  })

  it("একই ত্রুটি আবার এলে গোনা বাড়ে, নতুন সারি হয় না", async () => {
    const { repo, post } = start()
    await post(report)
    await post(report)
    expect(repo.peekClientErrors()).toHaveLength(1)
    expect(repo.peekClientErrors()[0]?.count).toBe(2)
  })

  it("লম্বা লেখা ছাঁটে, খারাপ ইনপুট ফেরায়", async () => {
    const { repo, post } = start()
    await post({ ...report, message: "x".repeat(900), stack: "y".repeat(9000) })
    expect(repo.peekClientErrors()[0]?.message).toHaveLength(500)
    expect(repo.peekClientErrors()[0]?.stack).toHaveLength(4000)
    expect((await post({ ...report, message: "  " })).status).toBe(400)
    expect((await post({ ...report, kind: "weird" })).status).toBe(400)
  })

  it("বড় বডি (১৬ KB-এর বেশি) আটকায়", async () => {
    const { post } = start()
    const r = await post({ ...report, junk: "z".repeat(20000) })
    expect(r.status).toBe(413)
  })

  it("এক IP থেকে ঘণ্টায় ১০টির বেশি নয়; বাকিগুলো ১০০-র সীমায়", async () => {
    const { repo, post } = start()
    const h = { "cf-connecting-ip": "1.2.3.4" }
    for (let i = 0; i < 10; i++) expect((await post({ ...report, message: `m${i}` }, h)).status).toBe(200)
    expect((await post({ ...report, message: "m11" }, h)).status).toBe(429)
    expect(repo.peekClientErrors()).toHaveLength(10)
    expect((await post({ ...report, message: "other" }, { "cf-connecting-ip": "5.6.7.8" })).status).toBe(200)
  })

  it("সব মিলিয়ে ঘণ্টায় ১০০টির বেশি নয়", async () => {
    const { post } = start()
    let blocked = 0
    for (let i = 0; i < 110; i++) if ((await post({ ...report, message: `m${i}` }, { "cf-connecting-ip": `9.9.${Math.floor(i / 5)}.1` })).status === 429) blocked++
    expect(blocked).toBe(10)
  })

  it("অচল টোকেন দিলেও রিপোর্ট নেয়, দোকান জানা থাকে না", async () => {
    const { repo, post } = start()
    expect((await post(report, { authorization: "Bearer garbage" })).status).toBe(200)
    expect(repo.peekClientErrors()[0]?.storeId).toBeNull()
  })
})
