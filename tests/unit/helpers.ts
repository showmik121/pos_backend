import { createApp } from "../../server/app.js"
import { createMemoryRepo } from "../../src/db/memory.js"

// দুই-দোকান, মালিক/স্টাফসহ HTTP টেস্ট-হার্নেস (memory repo)। stock.test.ts-এর নিজস্ব কপি আছে; নতুন ফাইলগুলো এটি ব্যবহার করে।
export const NOW = Date.parse("2026-11-12T06:00:00.000Z") // ঢাকায় ২০২৬-১১-১২
const SECRET = "k".repeat(40)
const PASS = "Sobuj#Ghar2026"

export function start(now: () => number = () => NOW) {
  const repo = createMemoryRepo({ now })
  const app = createApp({ repo, jwtSecret: SECRET, now })
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
  async function shop(phone: string, storeKind = "pharmacy") {
    const r = await call("POST", "/v1/auth/register-store", { body: { storeName: "দোকান", ownerName: "মালিক", phone, storeKind, password: PASS } })
    const staff = await call("POST", "/v1/staff", { token: r.json.token, body: { name: "রুবেল", phone: `0181${phone.slice(4)}`, password: "staffpass1" } })
    const login = await call("POST", "/v1/auth/login", { body: { phone: staff.json.user.phone, password: "staffpass1" } })
    return { owner: r.json.token as string, staff: login.json.token as string }
  }
  return { call, shop, repo }
}

let n = 0
export const uid = () => `30000000-0000-4000-8000-${String(++n).padStart(12, "0")}`
