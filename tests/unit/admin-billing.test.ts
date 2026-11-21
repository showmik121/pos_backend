import { describe, expect, it } from "vitest"
import { BillingOverviewSchema, PaymentSchema, RecordPaymentResultSchema, TenantBillingSchema } from "../../src/contract/admin-api.js"
import { DEFAULT_PLANS } from "../../src/db/memory-admin.js"
import { adminHarness } from "./admin-harness.js"

// A3 manual billing over the in-memory repo (the real-Postgres twin is tests/integration/admin-billing-pg.test.ts).
const BUSINESS = DEFAULT_PLANS.find((p) => p.code === "business")!
const STARTER = DEFAULT_PLANS.find((p) => p.code === "starter")!
const DAY = 86_400_000
const key = (n: number) => `idem-key-${String(n).padStart(4, "0")}`
const pay = (n: number, over: Record<string, unknown> = {}) => ({ idempotencyKey: key(n), amountPoisha: BUSINESS.pricePoisha, method: "bkash", txnRef: `TX-${n}-ABCDEF`, ...over })

async function setup(role: "finance" | "super" | "support" | "viewer" = "finance") {
  const h = adminHarness()
  const shop = await h.shop()
  const a = await h.actor(role, `${role}@bipone.test`, true)
  const post = (path: string, body: unknown, token = a.token) => h.call("POST", path, { token, body })
  const record = (body: unknown, store = shop.storeId) => post(`/v1/admin/tenants/${store}/payments`, body)
  const billing = async (store = shop.storeId) => {
    const r = await h.call("GET", `/v1/admin/tenants/${store}/billing`, { token: a.token })
    expect(r.status, r.raw).toBe(200)
    return TenantBillingSchema.parse(r.json)
  }
  return { h, shop, a, post, record, billing }
}

describe("acceptance 5: Finance records a manual payment", () => {
  it("a suspended shop that pays is active again: the shop's own sync works, one ok audit row, one 30-day period", async () => {
    const { h, shop, a, record, billing } = await setup()
    const boss = await h.actor("super", "boss@bipone.test", true)
    expect((await h.call("POST", `/v1/admin/tenants/${shop.storeId}/suspend`, { token: boss.token, body: { reason: "overdue for months" } })).status).toBe(200)
    expect((await h.call("GET", "/v1/sync/pull?after=0", { token: shop.ownerToken })).status).toBe(403)

    const r = await record(pay(1))
    expect(r.status, r.raw).toBe(201)
    const out = RecordPaymentResultSchema.parse(r.json)
    expect(out).toMatchObject({ replayed: false, fromStatus: "suspended", toStatus: "active" })
    expect(Date.parse(out.payment.periodEnd) - Date.parse(out.payment.periodStart)).toBe(30 * DAY)
    expect(out.payment.recordedByName).toBe("Name finance")

    expect((await h.call("GET", "/v1/sync/pull?after=0", { token: shop.ownerToken })).status).toBe(200)
    const rows = h.auditFor(shop.storeId).filter((x) => x.action === "admin.billing.payment_record")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ outcome: "ok", adminId: a.id, targetType: "tenant", targetId: shop.storeId, storeId: shop.storeId })
    expect(rows[0]!.after).toMatchObject({ status: "active", paymentId: out.payment.id, amountPoisha: BUSINESS.pricePoisha, method: "bkash", replayed: false })
    expect(JSON.stringify(rows[0])).not.toContain("TX-1-ABCDEF") // the transaction reference lives in the payment, not in the audit row

    const b = await billing()
    expect(b).toMatchObject({ status: "active", grandfathered: false, currentPeriodEnd: out.payment.periodEnd })
    expect(b.plan?.code).toBe("business")
    expect(b.events[0]).toMatchObject({ fromStatus: "suspended", toStatus: "active", adminName: "Name finance" })
  })

  it("a second payment starts when the running period ends (nobody loses days by paying early)", async () => {
    const { record } = await setup()
    const p1 = RecordPaymentResultSchema.parse((await record(pay(1))).json).payment
    const p2 = RecordPaymentResultSchema.parse((await record(pay(2))).json).payment
    expect(p2.periodStart).toBe(p1.periodEnd)
    expect(Date.parse(p2.periodEnd) - Date.parse(p2.periodStart)).toBe(30 * DAY)
  })

  it("a payment dated in the past that falls after the old period lapsed starts at paid_at", async () => {
    const { h, record } = await setup()
    const paidAt = new Date(h.now() - 3 * DAY).toISOString()
    const p = RecordPaymentResultSchema.parse((await record(pay(1, { paidAt }))).json).payment
    expect(p.periodStart).toBe(paidAt)
  })
})

describe("who may do what (PRD §3), every denial audited", () => {
  it.each(["support", "viewer"] as const)("%s cannot record or void a payment, change a plan or extend a trial; it CAN read billing", async (role) => {
    const { h, shop, a, record, billing } = await setup(role)
    const denied = await record(pay(1))
    expect(denied.status).toBe(403)
    expect((await h.call("POST", `/v1/admin/payments/${shop.storeId}/void`, { token: a.token, body: { reason: "mistake made" } })).status).toBe(403)
    expect((await h.call("PATCH", `/v1/admin/plans/${STARTER.id}`, { token: a.token, body: { name: "X", reason: "no right" } })).status).toBe(403)
    expect((await h.call("POST", `/v1/admin/tenants/${shop.storeId}/trial/extend`, { token: a.token, body: { days: 3, reason: "no right" } })).status).toBe(403)
    const actions = h.adminRepo.auditRows().filter((r) => r.outcome === "denied").map((r) => r.action)
    expect(actions).toEqual(expect.arrayContaining(["admin.billing.payment_record", "admin.billing.payment_void", "admin.billing.plan_update", "admin.billing.trial_extend"]))
    expect((await billing()).payments).toEqual([]) // nothing was recorded
    expect((await h.call("GET", "/v1/admin/billing/overview", { token: a.token })).status).toBe(200)
    expect((await h.call("GET", "/v1/admin/plans", { token: a.token })).status).toBe(200)
  })

  it("only Super edits plans, and with step-up; Finance voids only with step-up", async () => {
    const h = adminHarness()
    const shop = await h.shop()
    const fin = await h.actor("finance", "fin@bipone.test", false) // no step-up yet
    const boss = await h.actor("super", "boss@bipone.test", false)
    const rec = await h.call("POST", `/v1/admin/tenants/${shop.storeId}/payments`, { token: fin.token, body: pay(1) })
    expect(rec.status, "recording needs no step-up").toBe(201)

    expect((await h.call("PATCH", `/v1/admin/plans/${STARTER.id}`, { token: fin.token, body: { name: "Mine", reason: "not allowed" } })).status).toBe(403)
    const noStep = await h.call("PATCH", `/v1/admin/plans/${STARTER.id}`, { token: boss.token, body: { name: "Basic", reason: "rename plan" } })
    expect(noStep.status).toBe(403)
    expect(noStep.json.error.code).toBe("step_up_required")
    const voidNoStep = await h.call("POST", `/v1/admin/payments/${rec.json.payment.id}/void`, { token: fin.token, body: { reason: "wrong shop picked" } })
    expect(voidNoStep.json.error.code).toBe("step_up_required")
    expect((await h.call("GET", `/v1/admin/tenants/${shop.storeId}/billing`, { token: fin.token })).json.payments[0].voidedAt).toBeNull()

    await h.stepUp(boss, boss.token)
    const ok = await h.call("PATCH", `/v1/admin/plans/${STARTER.id}`, { token: boss.token, body: { name: "Basic", pricePoisha: 59_900, reason: "rename plan" } })
    expect(ok.status, ok.raw).toBe(200)
    const row = h.adminRepo.auditRows().find((r) => r.action === "admin.billing.plan_update" && r.outcome === "ok")!
    expect(row).toMatchObject({ targetType: "plan", targetId: STARTER.id, reason: "rename plan" })
    expect(row.before).toMatchObject({ name: "Starter", pricePoisha: 49_900 })
    expect(row.after).toMatchObject({ name: "Basic", pricePoisha: 59_900 })
  })

  it("a plan price change applies to new periods only: recorded payments are untouched", async () => {
    const { h, record, billing } = await setup("super")
    const before = RecordPaymentResultSchema.parse((await record(pay(1))).json).payment
    expect((await h.call("PATCH", `/v1/admin/plans/${BUSINESS.id}`, { token: (await h.actor("super", "two@bipone.test", true)).token, body: { pricePoisha: 300_000, reason: "new price list" } })).status).toBe(200)
    expect((await billing()).payments[0]).toEqual(before)
    const low = await record(pay(2)) // 249,900 is now below the 300,000 price
    expect(low.status).toBe(422)
    expect(low.json.error.code).toBe("amount_below_price")
  })
})

describe("recording rules", () => {
  it("the same idempotency key + same request returns the first payment (replayed), applies nothing twice", async () => {
    const { h, shop, record, billing } = await setup()
    const first = await record(pay(1))
    const again = await record(pay(1))
    expect(again.status).toBe(201)
    expect(again.json.replayed).toBe(true)
    expect(again.json.payment).toEqual(first.json.payment)
    expect((await billing()).payments).toHaveLength(1)
    // the replay is itself an audited, mutating call
    expect(h.auditFor(shop.storeId).filter((x) => x.action === "admin.billing.payment_record" && x.outcome === "ok")).toHaveLength(2)
  })

  it("the same key with a DIFFERENT request is refused (409) and records nothing", async () => {
    const { record, billing } = await setup()
    await record(pay(1))
    const clash = await record(pay(1, { amountPoisha: BUSINESS.pricePoisha + 1 }))
    expect(clash.status).toBe(409)
    expect(clash.json.error.code).toBe("idempotency_conflict")
    expect((await billing()).payments).toHaveLength(1)
  })

  it("the same method + transaction reference twice is refused; after a void it can be used again", async () => {
    const { h, record, billing, post } = await setup()
    const first = await record(pay(1, { txnRef: "BK-SAME-REF-1" }))
    const dup = await record(pay(2, { txnRef: "BK-SAME-REF-1" }))
    expect(dup.status).toBe(409)
    expect(dup.json.error.code).toBe("duplicate_txn")
    // another method with the same text is a different reference
    expect((await record(pay(3, { txnRef: "BK-SAME-REF-1", method: "nagad" }))).status).toBe(201)
    const fin2 = await h.actor("finance", "fin2@bipone.test", true)
    expect((await post(`/v1/admin/payments/${first.json.payment.id}/void`, { reason: "entered twice by mistake" }, fin2.token)).status).toBe(200)
    expect((await record(pay(4, { txnRef: "BK-SAME-REF-1" }))).status).toBe(201)
    expect((await billing()).payments).toHaveLength(3)
  })

  it.each([
    ["below the plan price", { amountPoisha: BUSINESS.pricePoisha - 1 }, 422, "amount_below_price"],
    ["a non-cash payment without a reference", { txnRef: undefined }, 422, "txn_ref_required"],
    ["a payment dated in the future", { paidAt: "2999-01-01T00:00:00.000Z" }, 422, "paid_in_future"],
  ])("refuses %s", async (_n, over, status, code) => {
    const { record, billing } = await setup()
    const r = await record(pay(1, over))
    expect(r.status, r.raw).toBe(status)
    expect(r.json.error.code).toBe(code)
    expect((await billing()).payments).toEqual([])
  })

  it("cash needs no reference; a plan can be chosen; an inactive plan is refused", async () => {
    const { h, record, billing } = await setup("super")
    const cash = await record({ idempotencyKey: key(1), amountPoisha: STARTER.pricePoisha, method: "cash", planId: STARTER.id })
    expect(cash.status, cash.raw).toBe(201)
    expect(cash.json.payment.txnRef).toBeNull()
    expect((await billing()).plan?.code).toBe("starter")
    const boss = await h.actor("super", "two@bipone.test", true)
    await h.call("PATCH", `/v1/admin/plans/${STARTER.id}`, { token: boss.token, body: { active: false, reason: "retire this plan" } })
    const off = await record({ idempotencyKey: key(2), amountPoisha: STARTER.pricePoisha, method: "cash", planId: STARTER.id })
    expect(off.status).toBe(409)
    expect(off.json.error.code).toBe("plan_inactive")
  })

  it("money is whole poisha: fractions, zero and negatives never reach the repo", async () => {
    const { record, billing } = await setup()
    for (const amountPoisha of [1.5, 0, -100, 100_000_001]) {
      const r = await record(pay(1, { amountPoisha }))
      expect(r.status, String(amountPoisha)).toBeGreaterThanOrEqual(400)
      expect(r.status).toBeLessThan(500)
    }
    expect((await billing()).payments).toEqual([])
  })

  it("a deleted shop takes no payment; an unknown shop is 404", async () => {
    const { h, record } = await setup()
    const gone = h.adminRepo.seedTenant({ name: "Gone", ownerPhone: "01711000077", status: "deleted" })
    const r = await record(pay(1), gone)
    expect(r.status).toBe(409)
    expect(r.json.error.code).toBe("invalid_transition")
    expect((await record(pay(2), "00000000-0000-4000-8000-000000000001")).status).toBe(404)
  })
})

describe("void", () => {
  it("never deletes: the record stays, marked voided; the paid-until date is recomputed; the status is NOT changed", async () => {
    const { h, shop, record, billing } = await setup()
    const p1 = RecordPaymentResultSchema.parse((await record(pay(1))).json).payment
    const p2 = RecordPaymentResultSchema.parse((await record(pay(2))).json).payment
    expect((await billing()).currentPeriodEnd).toBe(p2.periodEnd)
    const boss = await h.actor("finance", "fin2@bipone.test", true)
    const v = await h.call("POST", `/v1/admin/payments/${p2.id}/void`, { token: boss.token, body: { reason: "paid by the wrong shop" } })
    expect(v.status, v.raw).toBe(200)
    expect(PaymentSchema.parse(v.json.payment).voidedAt).not.toBeNull()
    expect(v.json.storeId).toBe(shop.storeId)

    const b = await billing()
    expect(b.payments).toHaveLength(2)
    expect(b.payments.find((p) => p.id === p2.id)).toMatchObject({ voidReason: "paid by the wrong shop" })
    expect(b.currentPeriodEnd).toBe(p1.periodEnd)
    expect(b.status).toBe("active")
    const row = h.adminRepo.auditRows().find((r) => r.action === "admin.billing.payment_void" && r.outcome === "ok")!
    expect(row).toMatchObject({ targetType: "payment", targetId: p2.id, storeId: shop.storeId, reason: "paid by the wrong shop" })

    const twice = await h.call("POST", `/v1/admin/payments/${p2.id}/void`, { token: boss.token, body: { reason: "again by mistake" } })
    expect(twice.status).toBe(409)
    expect(twice.json.error.code).toBe("payment_already_voided")
    expect((await h.call("POST", `/v1/admin/payments/00000000-0000-4000-8000-000000000001/void`, { token: boss.token, body: { reason: "no such payment" } })).status).toBe(404)
  })

  it("voiding the only payment leaves the status alone but dates the shop from that payment, so it becomes overdue instead of paid-forever", async () => {
    const { h, record, billing } = await setup()
    const p = RecordPaymentResultSchema.parse((await record(pay(1))).json).payment
    const fin2 = await h.actor("finance", "fin2@bipone.test", true)
    await h.call("POST", `/v1/admin/payments/${p.id}/void`, { token: fin2.token, body: { reason: "bounced payment" } })
    expect(await billing()).toMatchObject({ status: "active", currentPeriodEnd: p.paidAt })
  })

  it("voiding an EARLIER payment of a chain pulls the later one forward (no free gap)", async () => {
    const { h, record, billing } = await setup()
    const p1 = RecordPaymentResultSchema.parse((await record(pay(1))).json).payment
    const p2 = RecordPaymentResultSchema.parse((await record(pay(2))).json).payment
    expect(p2.periodEnd).toBe(new Date(Date.parse(p1.periodEnd) + 30 * DAY).toISOString())
    const fin2 = await h.actor("finance", "fin2@bipone.test", true)
    await h.call("POST", `/v1/admin/payments/${p1.id}/void`, { token: fin2.token, body: { reason: "wrong shop paid" } })
    // one payment is left: 30 days from its own paid_at, not the 60 the chain used to give
    expect((await billing()).currentPeriodEnd).toBe(new Date(Date.parse(p2.paidAt) + 30 * DAY).toISOString())
  })
})

describe("trial extension", () => {
  it("extends a trial by 1..30 days, audited with the reason; refuses non-trials and the 60-day cap", async () => {
    const { h, shop, a, record } = await setup()
    const before = Date.parse((await h.call("GET", `/v1/admin/tenants/${shop.storeId}/billing`, { token: a.token })).json.trialEndsAt)
    const ext = await h.call("POST", `/v1/admin/tenants/${shop.storeId}/trial/extend`, { token: a.token, body: { days: 7, reason: "needs time to import stock" } })
    expect(ext.status, ext.raw).toBe(200)
    expect(Date.parse(ext.json.trialEndsAt)).toBe(before + 7 * DAY)
    const row = h.auditFor(shop.storeId).find((x) => x.action === "admin.billing.trial_extend" && x.outcome === "ok")!
    expect(row).toMatchObject({ reason: "needs time to import stock", targetType: "tenant" })
    expect(row.after).toMatchObject({ extendedByDays: 7 })

    for (let i = 0; i < 4; i++) await h.call("POST", `/v1/admin/tenants/${shop.storeId}/trial/extend`, { token: a.token, body: { days: 30, reason: "keep extending" } })
    const capped = await h.call("POST", `/v1/admin/tenants/${shop.storeId}/trial/extend`, { token: a.token, body: { days: 30, reason: "keep extending" } })
    expect(capped.status).toBe(409)
    expect(capped.json.error.code).toBe("trial_cap")

    expect((await h.call("POST", `/v1/admin/tenants/${shop.storeId}/trial/extend`, { token: a.token, body: { days: 31, reason: "too many days" } })).status).toBe(400)
    await record(pay(1)) // now active
    const notTrial = await h.call("POST", `/v1/admin/tenants/${shop.storeId}/trial/extend`, { token: a.token, body: { days: 3, reason: "not a trial" } })
    expect(notTrial.status).toBe(409)
    expect(notTrial.json.error.code).toBe("invalid_transition")
  })
})

describe("overview reconciles with the payment rows (PRD §14)", () => {
  it("MRR, this month's collection and voids are computed from payments only; grandfathered shops are not overdue; overdue counts whole days", async () => {
    const { h, shop, a, record } = await setup()
    const p1 = RecordPaymentResultSchema.parse((await record(pay(1))).json).payment
    const p2 = RecordPaymentResultSchema.parse((await record(pay(2, { amountPoisha: 300_000, method: "cash", txnRef: undefined }))).json).payment
    const second = h.adminRepo.seedTenant({ name: "Second", ownerPhone: "01711000066", status: "active" })
    await record(pay(3, { amountPoisha: 250_000, txnRef: "NG-0003-XYZ", method: "nagad" }), second)
    const fin2 = await h.actor("finance", "fin2@bipone.test", true)
    await h.call("POST", `/v1/admin/payments/${p2.id}/void`, { token: fin2.token, body: { reason: "entered by mistake" } })
    // shops that are late / not billed yet
    h.adminRepo.seedTenant({ name: "Late", ownerPhone: "01711000055", status: "grace", grandfathered: false, currentPeriodEnd: new Date(h.now() - 10.5 * DAY).toISOString() })
    h.adminRepo.seedTenant({ name: "Old", ownerPhone: "01711000044", status: "active", grandfathered: true, currentPeriodEnd: new Date(h.now() - 99 * DAY).toISOString() })
    h.adminRepo.seedTenant({ name: "Fresh", ownerPhone: "01711000033", status: "active", grandfathered: false, currentPeriodEnd: new Date(h.now() - 0.5 * DAY).toISOString() })

    const o = BillingOverviewSchema.parse((await h.call("GET", "/v1/admin/billing/overview", { token: a.token })).json)
    expect(o.collectedThisMonthPoisha).toBe(p1.amountPoisha + 250_000)
    expect(o.paymentsThisMonth).toBe(2)
    expect(o.mrrPoisha).toBe(o.collectedThisMonthPoisha) // both live payments cover "now"
    expect(o.voidedThisMonthPoisha).toBe(300_000)
    expect(o.grandfathered).toBe(1)
    expect(o.overdue).toHaveLength(1)
    expect(o.overdue[0]).toMatchObject({ name: "Late", daysOverdue: 10, status: "grace" })
    expect(o.overdueTotal).toBe(1)
    expect(o.tenantsByStatus.active).toBeGreaterThanOrEqual(3)
    expect(shop.storeId).toBeTruthy()
  })

  it("lists trials ending within 7 days", async () => {
    const { h, a } = await setup()
    const id = h.adminRepo.seedTenant({ name: "Soon", ownerPhone: "01711000022", status: "trial", trialEndsAt: new Date(h.now() + 2 * DAY).toISOString() })
    h.adminRepo.seedTenant({ name: "Later", ownerPhone: "01711000021", status: "trial", trialEndsAt: new Date(h.now() + 20 * DAY).toISOString() })
    const o = BillingOverviewSchema.parse((await h.call("GET", "/v1/admin/billing/overview", { token: a.token })).json)
    expect(o.trialsEndingSoon.map((t) => t.id)).toEqual([id])
  })
})

describe("what the admin API never exposes", () => {
  it("billing responses carry no password hashes, no cost prices and no shop business data", async () => {
    const { h, a, record, shop } = await setup()
    await record(pay(1))
    const texts = [
      (await h.call("GET", `/v1/admin/tenants/${shop.storeId}/billing`, { token: a.token })).raw,
      (await h.call("GET", "/v1/admin/billing/overview", { token: a.token })).raw,
      (await h.call("GET", "/v1/admin/plans", { token: a.token })).raw,
    ].join("\n")
    for (const banned of ["password", "hash", "cost", "buy_price", "sale", "customer"]) expect(texts.toLowerCase(), banned).not.toContain(banned)
  })
})

describe("review fixes: backdating, reference spelling, replay signature, malformed input", () => {
  it("refuses a payment dated more than 30 days back (422 paid_too_old) and accepts one inside the window", async () => {
    const { record } = await setup()
    const old = await record(pay(1, { paidAt: new Date(Date.now() - 31 * DAY).toISOString() }))
    expect(old.status).toBe(422)
    expect(old.json.error.code).toBe("paid_too_old")
    expect((await record(pay(2, { paidAt: new Date(Date.now() - 20 * DAY).toISOString() }))).status).toBe(201)
  })

  it("a transaction reference is one thing however it is spelled: abc, ABC and ' ABC ' are duplicates", async () => {
    const { record, billing } = await setup()
    expect((await record(pay(1, { txnRef: "tx-case-1" }))).status).toBe(201)
    const dup = await record(pay(2, { txnRef: "  TX-CASE-1 " }))
    expect(dup.status).toBe(409)
    expect(dup.json.error.code).toBe("duplicate_txn")
    expect((await billing()).payments[0]?.txnRef).toBe("TX-CASE-1")
  })

  it("the same instant written two ways replays instead of conflicting", async () => {
    const { record } = await setup()
    const at = new Date(Date.now() - DAY)
    const first = await record(pay(1, { paidAt: at.toISOString() }))
    expect(first.status).toBe(201)
    const again = await record(pay(1, { paidAt: at.toISOString().replace(".000Z", "Z").replace(/\.(\d{3})Z$/, ".$1Z") }))
    expect(again.status, again.raw).toBe(201)
    expect(again.json.replayed).toBe(true)
  })

  it("a voided payment's reference can be entered again; a voided payment is a normal row afterwards", async () => {
    const { h, record, billing } = await setup()
    const p = RecordPaymentResultSchema.parse((await record(pay(1, { txnRef: "REUSE-1" }))).json).payment
    const fin2 = await h.actor("finance", "fin2@bipone.test", true)
    await h.call("POST", `/v1/admin/payments/${p.id}/void`, { token: fin2.token, body: { reason: "entered twice" } })
    expect((await record(pay(2, { txnRef: "reuse-1" }))).status).toBe(201)
    expect((await billing()).payments).toHaveLength(2)
  })
})
