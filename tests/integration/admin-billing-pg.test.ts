// Migration 015 (A3 manual billing) on a REAL throwaway Postgres (npm run test:pg). Never point these URLs at a live database.
//   parity:      the memory repo (unit tests) and the SQL functions give the same answers, including the same error codes
//   money:       revenue numbers equal an independent SQL sum over the payment rows; periods are exactly 30 x 24 h
//   concurrency: two operators on one shop cannot interleave; one transaction reference cannot be recorded twice across shops
//   privileges:  admin_app has no table grants on the billing tables; pos_app cannot read them or call admin_*
//   rollback:    db/rollback/015_down.sql refuses to drop financial records silently, newest-first order is enforced
import { randomBytes, randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Payment, TenantBilling } from "../../src/contract/admin-api.js"
import { DEFAULT_PLANS, createMemoryAdmin } from "../../src/db/memory-admin.js"
import { createPgAdmin } from "../../src/db/pg-admin.js"

const SUPER = process.env.INTEGRATION_SUPERUSER_URL
const APP = process.env.INTEGRATION_DATABASE_URL
const ADMIN = process.env.INTEGRATION_ADMIN_DATABASE_URL
const MIGRATIONS = path.join(process.cwd(), "db", "migrations")
const ROLLBACK = path.join(process.cwd(), "db", "rollback")
const ENABLED = Boolean(SUPER && APP && ADMIN)
const DAY = 86_400_000
const BUSINESS = DEFAULT_PLANS.find((p) => p.code === "business")!
const STARTER = DEFAULT_PLANS.find((p) => p.code === "starter")!

const withDb = (url: string, db: string) => {
  const u = new URL(url)
  u.pathname = `/${db}`
  return u.toString()
}
const open = (url: string, max = 1) => postgres(url, { max, prepare: false, onnotice: () => {} })
async function sqlCode(p: PromiseLike<unknown>): Promise<string> {
  try {
    await p
    return "ok"
  } catch (e) {
    return (e as { code?: string }).code ?? "error"
  }
}
type Outcome<T> = { ok: T } | { code: string }
async function outcome<T>(p: Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: await p }
  } catch (e) {
    return { code: (e as { code?: string }).code ?? "error" }
  }
}
// what two repos must agree on: no ids of rows that were just created, no wall-clock stamps taken at call time
const pay = (p: Payment) => ({ ...p, id: undefined, recordedAt: undefined, paidAt: undefined, voidedAt: p.voidedAt !== null })
const byRef = (a: Payment, b: Payment) => (a.txnRef ?? "").localeCompare(b.txnRef ?? "") || a.amountPoisha - b.amountPoisha
const view = (b: TenantBilling | null) =>
  b && { ...b, payments: [...b.payments].sort(byRef).map(pay), events: b.events.map((e) => ({ ...e, at: undefined })) }
const second = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString()

describe.skipIf(!ENABLED)("015: billing functions, parity with the memory repo, money, concurrency, privileges, rollback", () => {
  const name = `billing_${randomBytes(4).toString("hex")}`
  let superSql: postgres.Sql
  let sup: postgres.Sql
  let asApp: postgres.Sql
  let asAdmin: postgres.Sql
  let pg: ReturnType<typeof createPgAdmin>
  const memory = createMemoryAdmin()
  const ids: Record<string, string> = {}
  const admin = { pg: randomUUID(), mem: "" }
  let phoneSeq = 0

  async function seedStore(key: string, o: { status: string; grandfathered?: boolean; trialEndsAt?: Date | null; currentPeriodEnd?: Date | null; planId?: string | null }) {
    const id = randomUUID()
    const phone = `0171200${String(++phoneSeq).padStart(4, "0")}`
    const trial = o.status === "trial" ? (o.trialEndsAt ?? new Date(Date.now() + 5 * DAY)) : (o.trialEndsAt ?? null)
    await sup`INSERT INTO stores (id, name, kind, status, grandfathered, trial_ends_at, current_period_end, plan_id, phone)
              VALUES (${id}, ${key}, 'pharmacy', ${o.status}, ${o.grandfathered ?? false}, ${trial}, ${o.currentPeriodEnd ?? null}, ${o.planId ?? null}, ${phone})`
    await sup`INSERT INTO users (store_id, name, phone, password_hash, role) VALUES (${id}, 'Owner', ${phone}, 'scrypt$x', 'owner')`
    memory.seedTenant({
      id, name: key, status: o.status as never, grandfathered: o.grandfathered ?? false, ownerPhone: phone,
      trialEndsAt: trial?.toISOString() ?? null, currentPeriodEnd: o.currentPeriodEnd?.toISOString() ?? null, planId: o.planId ?? null,
    })
    ids[key] = id
    return id
  }
  /** the same call against both repos; the admin id differs because each repo owns its own admin row */
  const both = async <K extends "recordPayment" | "voidPayment" | "extendTrial">(fn: K, mk: (adminId: string) => Parameters<ReturnType<typeof createPgAdmin>[K]>[0]) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = await outcome((pg[fn] as any)(mk(admin.pg)))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b = await outcome((memory[fn] as any)(mk(admin.mem)))
    return { a, b }
  }

  beforeAll(async () => {
    superSql = open(SUPER ?? "")
    await superSql.unsafe(`CREATE DATABASE ${name}`)
    const mig = open(withDb(SUPER ?? "", name), 1)
    await mig`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`
    for (const f of (await readdir(MIGRATIONS)).filter((x) => x.endsWith(".sql")).sort()) await mig.unsafe(await readFile(path.join(MIGRATIONS, f), "utf8"))
    await mig.end({ timeout: 5 })
    sup = open(withDb(SUPER ?? "", name), 2)
    asApp = open(withDb(APP ?? "", name))
    asAdmin = open(withDb(ADMIN ?? "", name))
    pg = createPgAdmin({ connectionString: withDb(ADMIN ?? "", name), max: 6 })
    await sup`INSERT INTO platform_admins (id, email, name, role, password_hash) VALUES (${admin.pg}, 'fin@bipone.test', 'Tester', 'finance', 'x')`
    admin.mem = await memory.createAdmin({ email: "fin@bipone.test", name: "Tester", role: "finance", passwordHash: "x", totpSecretEnc: null, createdBy: null })
  }, 120_000)

  afterAll(async () => {
    await pg?.close()
    await asApp?.end({ timeout: 5 })
    await asAdmin?.end({ timeout: 5 })
    await sup?.end({ timeout: 5 })
    await superSql?.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    await superSql?.end({ timeout: 5 })
  })

  it("the three placeholder plans are seeded with the same ids and prices as the memory repo; existing shops stay grandfathered and unpaid", async () => {
    expect(await pg.listPlans()).toEqual(await memory.listPlans())
    expect((await pg.listPlans()).map((p) => p.pricePoisha)).toEqual([49_900, 119_900, 249_900])
    expect((await sup`SELECT count(*)::int AS n FROM stores WHERE current_period_end IS NOT NULL`)[0]!.n).toBe(0)
  })

  it("recording, chaining and voiding: SQL equals memory (payments, status, paid-until date, events)", async () => {
    const shop = await seedStore("pays", { status: "suspended" })
    const paidAt = second(Date.now() - 2 * DAY)
    const r1 = await both("recordPayment", (adminId) => ({ storeId: shop, idempotencyKey: "pg-parity-0001", amountPoisha: 249_900, method: "bkash", txnRef: "BK-PG-0001", paidAt, planId: null, adminId }))
    expect(r1.a).toHaveProperty("ok")
    const [x, y] = [r1.a, r1.b] as Array<{ ok: { payment: Payment; replayed: boolean; fromStatus: string; toStatus: string } }>
    expect({ ...x.ok, payment: pay(x.ok.payment) }).toEqual({ ...y.ok, payment: pay(y.ok.payment) })
    expect(x.ok).toMatchObject({ replayed: false, fromStatus: "suspended", toStatus: "suspended" })
    expect(x.ok.payment.periodStart).toBe(paidAt)
    expect(Date.parse(x.ok.payment.periodEnd) - Date.parse(x.ok.payment.periodStart)).toBe(30 * DAY) // exactly 720 hours

    const r2 = await both("recordPayment", (adminId) => ({ storeId: shop, idempotencyKey: "pg-parity-0002", amountPoisha: 300_000, method: "cash", txnRef: null, paidAt: null, planId: null, adminId }))
    const [x2, y2] = [r2.a, r2.b] as Array<{ ok: { payment: Payment } }>
    expect(x2.ok.payment.periodStart).toBe(x.ok.payment.periodEnd) // chained, no days lost
    expect(y2.ok.payment.periodStart).toBe(y.ok.payment.periodEnd)

    const replay = await both("recordPayment", (adminId) => ({ storeId: shop, idempotencyKey: "pg-parity-0002", amountPoisha: 300_000, method: "cash", txnRef: null, paidAt: null, planId: null, adminId }))
    expect((replay.a as { ok: { replayed: boolean } }).ok.replayed).toBe(true)
    expect((replay.b as { ok: { replayed: boolean } }).ok.replayed).toBe(true)

    const v = await both("voidPayment", (adminId) => ({ paymentId: adminId === admin.pg ? x2.ok.payment.id : y2.ok.payment.id, reason: "wrong shop", adminId }))
    expect(v.a).toHaveProperty("ok")
    expect(v.b).toHaveProperty("ok")
    expect(view(await pg.tenantBilling(shop))).toEqual(view(await memory.tenantBilling(shop)))
    const after = (await pg.tenantBilling(shop))!
    expect(after).toMatchObject({ status: "suspended", grandfathered: false, currentPeriodEnd: x.ok.payment.periodEnd })
    expect(after.payments).toHaveLength(2) // void never deletes
    // the shop's own account activity shows the status change, with no internal reason column for it
    expect((await sup`SELECT from_status, to_status FROM tenant_status_events WHERE store_id = ${shop}`)).toEqual([]) // status unchanged: no status event
  })

  it("every refusal has the same error code in SQL and in memory", async () => {
    const shop = await seedStore("refuse", { status: "active" })
    const gone = await seedStore("gone", { status: "deleted" })
    const trial = await seedStore("trial", { status: "trial" })
    const base = { storeId: shop, idempotencyKey: "refuse-key-0001", amountPoisha: 249_900, method: "bkash" as const, txnRef: "RF-0001-AAAA", paidAt: null, planId: null }
    const cases: Array<[string, Partial<typeof base>, string]> = [
      ["below the price", { amountPoisha: 249_899 }, "amount_below_price"],
      ["zero", { amountPoisha: 0 }, "invalid_amount"],
      ["over the cap", { amountPoisha: 100_000_001 }, "invalid_amount"],
      ["no reference", { txnRef: null }, "txn_ref_required"],
      ["future", { paidAt: new Date(Date.now() + DAY).toISOString() }, "paid_in_future"],
      ["too old", { paidAt: new Date(Date.now() - 31 * DAY).toISOString() }, "paid_too_old"],
      ["bad key format", { idempotencyKey: "short" }, "invalid_input"],
      ["unknown plan", { planId: "00000000-0000-4000-8000-0000000000ff" }, "not_found"],
      ["deleted shop", { storeId: gone }, "invalid_transition"],
    ]
    for (const [label, over, code] of cases) {
      const r = await both("recordPayment", (adminId) => ({ ...base, ...over, adminId }))
      expect(r.a, `pg ${label}`).toEqual({ code })
      expect(r.b, `memory ${label}`).toEqual({ code })
    }
    expect(await pg.recordPayment({ ...base, storeId: randomUUID(), adminId: admin.pg })).toBeNull()

    const first = await both("recordPayment", (adminId) => ({ ...base, adminId }))
    expect(first.a).toHaveProperty("ok")
    expect(first.b).toHaveProperty("ok")
    const clash = await both("recordPayment", (adminId) => ({ ...base, amountPoisha: 250_000, adminId }))
    expect(clash.a).toEqual({ code: "idempotency_conflict" })
    expect(clash.b).toEqual({ code: "idempotency_conflict" })
    const dup = await both("recordPayment", (adminId) => ({ ...base, idempotencyKey: "refuse-key-0002", txnRef: " rf-0001-aaaa ", adminId }))
    expect(dup.a).toEqual({ code: "duplicate_txn" })
    expect(dup.b).toEqual({ code: "duplicate_txn" })

    // trial extension: same codes
    const ext = (days: number, store = trial) => both("extendTrial", (adminId) => ({ storeId: store, days, reason: "help", adminId }))
    expect((await ext(0)).a).toEqual({ code: "invalid_input" })
    expect((await ext(0)).b).toEqual({ code: "invalid_input" })
    const e1 = await ext(7)
    expect((e1.a as { ok: { status: string } }).ok.status).toBe("trial")
    expect(Math.abs(Date.parse((e1.a as { ok: { trialEndsAt: string } }).ok.trialEndsAt) - Date.parse((e1.b as { ok: { trialEndsAt: string } }).ok.trialEndsAt))).toBeLessThan(10_000)
    for (let i = 0; i < 3; i++) await ext(30)
    expect((await ext(30)).a).toEqual({ code: "trial_cap" })
    expect((await ext(30)).b).toEqual({ code: "trial_cap" })
    expect((await ext(3, shop)).a).toEqual({ code: "invalid_transition" })
    expect((await ext(3, shop)).b).toEqual({ code: "invalid_transition" })
    expect(await pg.extendTrial({ storeId: randomUUID(), days: 3, reason: "x", adminId: admin.pg })).toBeNull()

    // plan edits: merge, inactive plans refused, the same codes
    const u = await pg.updatePlan({ id: STARTER.id, patch: { name: "Basic", pricePoisha: 59_900, limits: { devices: 2 }, features: { reports: true }, active: false }, adminId: admin.pg })
    const m = await memory.updatePlan({ id: STARTER.id, patch: { name: "Basic", pricePoisha: 59_900, limits: { devices: 2 }, features: { reports: true }, active: false }, adminId: admin.mem })
    expect(u).toEqual(m)
    expect(u!.after.limits).toEqual({ devices: 2, staff: 1 }) // merged, not replaced
    const off = await both("recordPayment", (adminId) => ({ ...base, idempotencyKey: "refuse-key-0003", txnRef: "RF-0003-AAAA", planId: STARTER.id, adminId }))
    expect(off.a).toEqual({ code: "plan_inactive" })
    expect(off.b).toEqual({ code: "plan_inactive" })
    expect(await pg.updatePlan({ id: randomUUID(), patch: { name: "x" }, adminId: admin.pg })).toBeNull()
    await pg.updatePlan({ id: STARTER.id, patch: { name: "Starter", pricePoisha: 49_900, active: true }, adminId: admin.pg })
    await memory.updatePlan({ id: STARTER.id, patch: { name: "Starter", pricePoisha: 49_900, active: true }, adminId: admin.mem })
  })

  it("overview: SQL equals memory, and equals an independent sum over the payment rows (reconciliation, PRD §14)", async () => {
    const now = Date.now()
    await seedStore("late", { status: "grace", currentPeriodEnd: new Date(now - 10.5 * DAY) })
    await seedStore("old", { status: "active", grandfathered: true, currentPeriodEnd: new Date(now - 99 * DAY) })
    await seedStore("fresh", { status: "active", currentPeriodEnd: new Date(now - 0.5 * DAY) })
    await seedStore("soon", { status: "trial", trialEndsAt: new Date(now + 2 * DAY) })
    await seedStore("trial-over", { status: "trial", trialEndsAt: new Date(now - 3.2 * DAY) })
    const extra = await seedStore("pays2", { status: "active" })
    await both("recordPayment", (adminId) => ({ storeId: extra, idempotencyKey: "overview-key-0001", amountPoisha: 120_000, method: "rocket", txnRef: "RK-0001-AAAA", paidAt: null, planId: null, adminId }))
    const dead = await both("recordPayment", (adminId) => ({ storeId: extra, idempotencyKey: "overview-key-0002", amountPoisha: 250_000, method: "cash", txnRef: null, paidAt: null, planId: null, adminId }))
    await both("voidPayment", (adminId) => ({ paymentId: adminId === admin.pg ? (dead.a as { ok: { payment: Payment } }).ok.payment.id : (dead.b as { ok: { payment: Payment } }).ok.payment.id, reason: "typed twice", adminId }))

    const a = await pg.billingOverview()
    const b = await memory.billingOverview()
    expect(a).toEqual(b)
    expect(a.overdue.map((o) => [o.name, o.daysOverdue])).toEqual([["late", 10], ["trial-over", 3]])
    expect(a.trialsEndingSoon.map((t) => t.name)).toContain("soon")
    expect(a.grandfathered).toBeGreaterThanOrEqual(1)

    // reconciliation: the numbers equal a plain sum over the rows, computed here by a different query
    const rows = await sup<Array<{ mrr: string; month: string; n: number; voided: string }>>`
      SELECT coalesce(sum(amount_poisha) FILTER (WHERE voided_at IS NULL AND period_start <= now() AND now() < period_end), 0) AS mrr,
             coalesce(sum(amount_poisha) FILTER (WHERE voided_at IS NULL AND (paid_at AT TIME ZONE 'Asia/Dhaka') >= date_trunc('month', now() AT TIME ZONE 'Asia/Dhaka')
                                                   AND (paid_at AT TIME ZONE 'Asia/Dhaka') < date_trunc('month', now() AT TIME ZONE 'Asia/Dhaka') + interval '1 month'), 0) AS month,
             count(*) FILTER (WHERE voided_at IS NULL AND (paid_at AT TIME ZONE 'Asia/Dhaka') >= date_trunc('month', now() AT TIME ZONE 'Asia/Dhaka')
                                                   AND (paid_at AT TIME ZONE 'Asia/Dhaka') < date_trunc('month', now() AT TIME ZONE 'Asia/Dhaka') + interval '1 month')::int AS n,
             coalesce(sum(amount_poisha) FILTER (WHERE voided_at IS NOT NULL AND (voided_at AT TIME ZONE 'Asia/Dhaka') >= date_trunc('month', now() AT TIME ZONE 'Asia/Dhaka')
                                                   AND (voided_at AT TIME ZONE 'Asia/Dhaka') < date_trunc('month', now() AT TIME ZONE 'Asia/Dhaka') + interval '1 month'), 0) AS voided
      FROM subscription_payments`
    expect(a.mrrPoisha).toBe(Number(rows[0]!.mrr))
    expect(a.collectedThisMonthPoisha).toBe(Number(rows[0]!.month))
    expect(a.paymentsThisMonth).toBe(rows[0]!.n)
    expect(a.voidedThisMonthPoisha).toBe(Number(rows[0]!.voided))
    expect(a.voidedThisMonthPoisha).toBe(300_000 + 250_000) // the earlier test voided 300,000 too
  })

  it("concurrency: two operators on one shop serialise; one transaction reference across two shops records once; one key records once", async () => {
    const shop = await seedStore("race", { status: "active" })
    const mk = (n: number, over: Record<string, unknown> = {}) => ({
      storeId: shop, idempotencyKey: `race-key-${String(n).padStart(4, "0")}`, amountPoisha: 249_900, method: "bkash" as const, txnRef: `RC-${n}-AAAAAA`, paidAt: null, planId: null, adminId: admin.pg, ...over,
    })
    const two = await Promise.all([pg.recordPayment(mk(1)), pg.recordPayment(mk(2))])
    const [p1, p2] = two.map((r) => r!.payment).sort((a, b) => Date.parse(a.periodStart) - Date.parse(b.periodStart))
    expect(p2!.periodStart).toBe(p1!.periodEnd) // chained, never overlapping, whichever won the lock

    const same = await Promise.all(Array.from({ length: 5 }, () => outcome(pg.recordPayment(mk(3)))))
    expect(same.every((r) => "ok" in r)).toBe(true)
    expect(same.filter((r) => "ok" in r && !r.ok!.replayed)).toHaveLength(1)
    expect((await sup`SELECT count(*)::int AS n FROM subscription_payments WHERE idempotency_key = ${mk(3).idempotencyKey}`)[0]!.n).toBe(1)

    const other = await seedStore("race2", { status: "active" })
    const dup = await Promise.all([outcome(pg.recordPayment(mk(4, { txnRef: "RC-SHARED-REF" }))), outcome(pg.recordPayment(mk(5, { storeId: other, txnRef: "RC-SHARED-REF" })))])
    expect(dup.filter((r) => "ok" in r)).toHaveLength(1)
    expect(dup.filter((r) => "code" in r)).toEqual([{ code: "duplicate_txn" }])

    const voidTwice = await pg.recordPayment(mk(6))
    const votes = await Promise.all([outcome(pg.voidPayment({ paymentId: voidTwice!.payment.id, reason: "twice", adminId: admin.pg })), outcome(pg.voidPayment({ paymentId: voidTwice!.payment.id, reason: "twice", adminId: admin.pg }))])
    expect(votes.filter((r) => "ok" in r)).toHaveLength(1)
    expect(votes.filter((r) => "code" in r)).toEqual([{ code: "payment_already_voided" }])
  })

  it("table constraints hold even for a direct insert (defence in depth)", async () => {
    const store = ids.pays!
    const ins = (o: Record<string, unknown>) => {
      const v = { amount: 249_900, method: "bkash", txn: `DI-${randomBytes(4).toString("hex")}`, key: `direct-${randomBytes(6).toString("hex")}`, ps: new Date(), pe: new Date(Date.now() + DAY), vat: null, vr: null, ...o }
      return sup`INSERT INTO subscription_payments (store_id, amount_poisha, method, txn_ref, paid_at, period_start, period_end, idempotency_key, request_sig, voided_at, void_reason)
                 VALUES (${store}, ${v.amount as number}, ${v.method as string}, ${v.txn as string | null}, now(), ${v.ps as Date}, ${v.pe as Date}, ${v.key as string}, 'sig', ${v.vat as Date | null}, ${v.vr as string | null})`
    }
    expect(await sqlCode(ins({}))).toBe("ok")
    expect(await sqlCode(ins({ amount: 0 }))).toBe("23514")
    expect(await sqlCode(ins({ amount: 100_000_001 }))).toBe("23514")
    expect(await sqlCode(ins({ method: "paypal" }))).toBe("23514")
    expect(await sqlCode(ins({ txn: null }))).toBe("23514")               // non-cash needs a reference
    expect(await sqlCode(ins({ method: "cash", txn: null }))).toBe("ok")
    expect(await sqlCode(ins({ pe: new Date(Date.now() - DAY) }))).toBe("23514")
    expect(await sqlCode(ins({ key: "short" }))).toBe("23514")
    expect(await sqlCode(ins({ vat: new Date() }))).toBe("23514")         // voided without a reason
    const dupKey = `dupkey-${randomBytes(4).toString("hex")}`
    expect(await sqlCode(ins({ key: dupKey }))).toBe("ok")
    expect(await sqlCode(ins({ key: dupKey }))).toBe("23505")
    expect(await sqlCode(sup`UPDATE plans SET price_poisha = -1 WHERE code = 'starter'`)).toBe("23514")
    expect(await sqlCode(sup`UPDATE stores SET plan_id = ${randomUUID()} WHERE id = ${store}`)).toBe("23503")
    expect(await sqlCode(sup`DELETE FROM stores WHERE id = ${store}`)).toBe("23503") // a financial record never disappears with its shop
  })

  it("privilege boundary: admin_app still has NO table grants; the shop role cannot read billing or call admin_*; functions are admin_app-only", async () => {
    expect((await sup`SELECT count(*)::int AS n FROM information_schema.table_privileges WHERE grantee = 'admin_app'`)[0]!.n).toBe(0)
    for (const t of ["plans", "subscription_payments", "subscription_events"]) {
      expect(await sqlCode(asAdmin.unsafe(`SELECT * FROM ${t} LIMIT 1`)), `admin_app ${t}`).toBe("42501")
      expect(await sqlCode(asApp.unsafe(`SELECT * FROM ${t} LIMIT 1`)), `pos_app ${t}`).toBe("42501")
    }
    expect(await sqlCode(asAdmin`INSERT INTO subscription_payments (store_id) VALUES (${ids.pays!})`)).toBe("42501")
    expect(await sqlCode(asApp`SELECT * FROM admin_plans_list()`)).toBe("42501")
    expect(await sqlCode(asApp`SELECT * FROM admin_payment_record(${ids.pays!}, 'abcdefgh', 1, 'cash', NULL, NULL, NULL, NULL)`)).toBe("42501")
    expect(await sqlCode(asAdmin`SELECT * FROM admin_plans_list()`)).toBe("ok")
    const rls = await sup<Array<{ relname: string; relrowsecurity: boolean }>>`SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('plans', 'subscription_payments', 'subscription_events')`
    expect(rls).toHaveLength(3)
    expect(rls.every((r) => r.relrowsecurity)).toBe(true)
    // admin functions that 015 added are executable by admin_app alone
    const leaks = await sup`SELECT p.proname FROM pg_proc p WHERE p.proname IN ('admin_payment_record', 'admin_payment_void', 'admin_trial_extend', 'admin_plan_update', 'admin_billing_overview')
                              AND (has_function_privilege('pos_app', p.oid, 'EXECUTE') OR has_function_privilege('public', p.oid, 'EXECUTE'))`
    expect(leaks).toEqual([])
  })

  it("data minimisation: no billing function returns a password hash, a cost price or shop business data", async () => {
    const cols = await sup<Array<{ proname: string; cols: string }>>`
      SELECT p.proname, pg_get_function_result(p.oid) AS cols FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace AND (p.proname LIKE 'admin\_billing\_%' OR p.proname LIKE 'admin\_payment\_%' OR p.proname IN ('admin_plans_list', 'admin_plan_update', 'admin_trial_extend'))`
    expect(cols.length).toBeGreaterThanOrEqual(10)
    for (const c of cols) for (const banned of ["password", "hash", "cost", "buy_", "sale", "customer", "payload"]) expect(c.cols.toLowerCase(), `${c.proname} ${banned}`).not.toContain(banned)
  })

  it("rollback 015: refuses while it holds financial records, 014_down refuses while 015 is applied, then everything drops cleanly and 015 re-applies", async () => {
    const down015 = await readFile(path.join(ROLLBACK, "015_down.sql"), "utf8")
    const down014 = await readFile(path.join(ROLLBACK, "014_down.sql"), "utf8")
    // a failed BEGIN...COMMIT script leaves its connection in an aborted transaction, so every script gets a fresh connection
    const run = async (text: string) => {
      const c = open(withDb(SUPER ?? "", name), 1)
      try {
        return await sqlCode(c.unsafe(text))
      } finally {
        await c.end({ timeout: 5 })
      }
    }
    expect((await sup`SELECT count(*)::int AS n FROM subscription_payments`)[0]!.n).toBeGreaterThan(0)
    expect(await run(down014)).toBe("P0001") // newest first
    expect(await run(down015)).toBe("P0001")
    expect((await sup`SELECT to_regclass('subscription_payments') AS t`)[0]!.t).not.toBeNull()
    expect(await run(`SET bipone.discard_billing = 'yes'; ${down015}`)).toBe("ok")
    for (const t of ["plans", "subscription_payments", "subscription_events"]) expect((await sup.unsafe(`SELECT to_regclass('${t}') AS t`))[0]!.t).toBeNull()
    expect((await sup`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'stores' AND column_name = 'current_period_end'`)[0]!.n).toBe(0)
    expect((await sup`SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('admin_plans_list','admin_payment_record','admin_payment_void','admin_trial_extend','admin_billing_overview','admin_plan_update')`)[0]!.n).toBe(0)
    expect((await sup`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '015_admin_billing.sql'`)[0]!.n).toBe(0)
    expect((await sup`SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'admin_dashboard'`)[0]!.n).toBe(1) // 014 untouched
    expect((await sup`SELECT count(*)::int AS n FROM stores`)[0]!.n).toBeGreaterThan(5) // shop rows survive
    expect(await run(await readFile(path.join(MIGRATIONS, "015_admin_billing.sql"), "utf8"))).toBe("ok")
    expect((await sup`SELECT count(*)::int AS n FROM plans`)[0]!.n).toBe(3)
  })
})
