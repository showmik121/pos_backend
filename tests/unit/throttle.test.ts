import { describe, expect, it } from "vitest"
import { clientIp, createApp } from "../../server/app.js"
import { createMemoryRepo } from "../../src/db/memory.js"

const SECRET = "k".repeat(40)
const owner = {
  storeName: "রহমান ফার্মেসি",
  storeKind: "pharmacy",
  ownerName: "আব্দুর রহমান",
  phone: "01712345678",
  password: "Sobuj#Ghar2026",
}

function start() {
  const repo = createMemoryRepo()
  const app = createApp({ repo, jwtSecret: SECRET })
  async function call(path: string, body: unknown, ip?: string) {
    const res = await app.fetch(
      new Request(`https://edge.test/api${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(ip ? { "cf-connecting-ip": ip } : {}) },
        body: JSON.stringify(body),
      }),
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, json: (await res.json()) as any }
  }
  const login = (password: string, ip?: string, phone = owner.phone) => call("/v1/auth/login", { phone, password }, ip)
  return { repo, call, login }
}

describe("ডাটাবেস-ভিত্তিক হার-সীমা (মেমরি বাস্তবায়নে)", () => {
  it("repo.throttle: সীমা পেরোলে false, সময় গেলে খোলে, আটকে থাকলে মেয়াদ বাড়ে না, reset কাজ করে", async () => {
    let t = 1_000_000
    const repo = createMemoryRepo({ now: () => t })
    expect(await repo.throttle("k", 3, 10)).toBe(true)
    expect(await repo.throttle("k", 3, 10)).toBe(true)
    expect(await repo.throttle("k", 3, 10)).toBe(true)
    expect(await repo.throttle("k", 3, 10)).toBe(false)
    expect(await repo.throttle("other", 3, 10)).toBe(true) // অন্য bucket প্রভাবিত নয়
    t += 5_000
    expect(await repo.throttle("k", 3, 10)).toBe(false) // আটকে থাকা চেষ্টা গোনা হয়নি, কিন্তু উইন্ডো এখনো চলছে
    t += 6_000 // প্রথম তিনটি এখন ১১ সেকেন্ড আগের
    expect(await repo.throttle("k", 3, 10)).toBe(true)
    await repo.throttleReset("k")
    expect(await repo.throttle("k", 1, 10)).toBe(true)
  })

  it("৫ ভুলের পর একই ফোন+IP আটকায়, কিন্তু অন্য IP থেকে আসল মালিক ঢুকতে পারে", async () => {
    const { call, login } = start()
    await call("/v1/auth/register-store", owner, "9.9.9.9")
    for (let i = 0; i < 5; i++) expect((await login("ভুল-পাসওয়ার্ড-১", "6.6.6.6")).status).toBe(401)
    const attacker = await login(owner.password, "6.6.6.6")
    expect(attacker.status).toBe(429) // আক্রমণকারীর IP থেকে সঠিক পাসওয়ার্ডেও আটকানো
    expect(attacker.json.error.code).toBe("too_many_attempts")
    const real = await login(owner.password, "7.7.7.7")
    expect(real.status).toBe(200) // মালিক নিজের IP থেকে লকআউট হননি
  })

  it("সফল লগইনে ফোন+IP এর গোনা শূন্য হয়", async () => {
    const { call, login } = start()
    await call("/v1/auth/register-store", owner, "9.9.9.9")
    for (let i = 0; i < 4; i++) await login("ভুল-পাসওয়ার্ড-১", "5.5.5.5")
    expect((await login(owner.password, "5.5.5.5")).status).toBe(200)
    for (let i = 0; i < 4; i++) expect((await login("ভুল-পাসওয়ার্ড-১", "5.5.5.5")).status).toBe(401)
    expect((await login(owner.password, "5.5.5.5")).status).toBe(200)
  })

  it("একই ফোনে ছড়ানো IP থেকে আক্রমণ: ফোন-প্রতি ওপরের সীমায় (৫০) থামে", async () => {
    const { call, login } = start()
    await call("/v1/auth/register-store", owner, "9.9.9.9")
    let blockedAt = -1
    for (let i = 0; i < 60; i++) {
      const r = await login("ভুল-পাসওয়ার্ড-১", `10.0.${Math.floor(i / 250)}.${i % 250}`)
      if (r.status === 429) {
        blockedAt = i
        break
      }
    }
    expect(blockedAt).toBe(50)
  })

  it("এক IP থেকে নানা নম্বরে চেষ্টা: ৬০ বারের পর আটকায়", async () => {
    const { login } = start()
    let blockedAt = -1
    for (let i = 0; i < 70; i++) {
      const r = await login("ভুল-পাসওয়ার্ড-১", "4.4.4.4", `01911${String(100000 + i)}`)
      if (r.status === 429) {
        blockedAt = i
        break
      }
    }
    expect(blockedAt).toBe(60)
  })

  it("নিবন্ধন: এক IP থেকে ঘণ্টায় ৫টির বেশি নয়, অন্য IP চলে", async () => {
    const { call } = start()
    const mk = (i: number, ip: string) => call("/v1/auth/register-store", { ...owner, phone: `0181100${String(1000 + i)}` }, ip)
    for (let i = 0; i < 5; i++) expect((await mk(i, "3.3.3.3")).status).toBe(201)
    const sixth = await mk(5, "3.3.3.3")
    expect(sixth.status).toBe(429)
    expect(sixth.json.error.code).toBe("too_many_attempts")
    expect((await mk(6, "2.2.2.2")).status).toBe(201)
  })

  it("IP হেডার না থাকলেও (শুধু ফোন-ভিত্তিক সীমায়) আগের মতো ৫ ভুলে আটকায়", async () => {
    const { call, login } = start()
    await call("/v1/auth/register-store", owner)
    for (let i = 0; i < 5; i++) expect((await login("ভুল-পাসওয়ার্ড-১")).status).toBe(401)
    expect((await login(owner.password)).status).toBe(429)
  })

  it("দুর্বল পাসওয়ার্ডে নিবন্ধন ও স্টাফ তৈরি বাতিল; নিজের ফোন নম্বর পাসওয়ার্ড নয়", async () => {
    const { call } = start()
    const weak = await call("/v1/auth/register-store", { ...owner, password: "password123" })
    expect(weak.status).toBe(400)
    expect(weak.json.error.code).toBe("weak_password")
    const selfPhone = await call("/v1/auth/register-store", { ...owner, password: "01712345678" })
    expect(selfPhone.json.error.code).toBe("weak_password")
    expect((await call("/v1/auth/register-store", owner)).status).toBe(201)
  })
})

describe("clientIp", () => {
  const req = (h: Record<string, string>) => new Request("https://x.test/", { headers: h })
  it("হেডারের ক্রম ও যাচাই", () => {
    expect(clientIp(req({ "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9" }))).toBe("1.2.3.4")
    expect(clientIp(req({ "x-real-ip": "5.6.7.8" }))).toBe("5.6.7.8")
    expect(clientIp(req({ "x-forwarded-for": "8.8.8.8, 10.0.0.1" }))).toBe("8.8.8.8")
    expect(clientIp(req({ "cf-connecting-ip": "2001:db8::1" }))).toBe("2001:db8::1")
    expect(clientIp(req({}))).toBeNull()
    expect(clientIp(req({ "cf-connecting-ip": "not an ip; DROP TABLE" }))).toBeNull()
  })
})
