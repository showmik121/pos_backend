import { describe, expect, it } from "vitest"
import { assertPaidAt, assertPaymentAmount, dueStatus, extendTrial, normalizeTxnRef, paidUntilAfterVoid, periodFor, statusAfterPayment, PERIOD_DAYS } from "../../src/domain/billing.js"
import type { StoreStatus } from "../../src/db/types.js"

const DAY = 86_400_000
const T0 = Date.parse("2026-03-01T00:00:00.000Z")

describe("periodFor", () => {
  it("starts at the payment time when there is no running period", () => {
    expect(periodFor(null, T0)).toEqual({ startMs: T0, endMs: T0 + PERIOD_DAYS * DAY })
  })
  it("starts when the running period ends if the shop pays early (no days are lost)", () => {
    const end = T0 + 10 * DAY
    expect(periodFor(end, T0)).toEqual({ startMs: end, endMs: end + 30 * DAY })
  })
  it("starts at the payment time when the previous period already ended", () => {
    expect(periodFor(T0 - 5 * DAY, T0)).toEqual({ startMs: T0, endMs: T0 + 30 * DAY })
  })
})

describe("statusAfterPayment: a payment returns the shop to active from anywhere before deletion", () => {
  const ok: StoreStatus[] = ["trial", "active", "grace", "read_only", "suspended", "pending_deletion", "cancelled"]
  it.each(ok)("%s -> active", (s) => expect(statusAfterPayment(s)).toBe("active"))
  it("refuses a deleted shop", () => expect(() => statusAfterPayment("deleted")).toThrowError(expect.objectContaining({ code: "invalid_transition" })))
  it("refuses an unknown status (fail closed)", () => expect(() => statusAfterPayment("bogus" as StoreStatus)).toThrow())
})

describe("assertPaymentAmount", () => {
  it("accepts the plan price or more, in whole poisha", () => {
    expect(() => assertPaymentAmount(119_900, 119_900)).not.toThrow()
    expect(() => assertPaymentAmount(119_900, 130_000)).not.toThrow()
  })
  it.each([119_899, 0, -1, 119_900.5, Number.NaN, 1e15])("rejects %s", (amount) => {
    expect(() => assertPaymentAmount(119_900, amount)).toThrowError(expect.objectContaining({ code: expect.stringMatching(/amount/) }))
  })
})

describe("extendTrial", () => {
  const end = T0 + 3 * DAY
  it("adds days to the current end", () => expect(extendTrial("trial", end, T0, 7)).toBe(end + 7 * DAY))
  it("adds days from now if the trial end has passed", () => expect(extendTrial("trial", T0 - DAY, T0, 7)).toBe(T0 + 7 * DAY))
  it("is capped: the trial never ends more than 60 days from now", () => {
    expect(() => extendTrial("trial", T0 + 50 * DAY, T0, 20)).toThrowError(expect.objectContaining({ code: "trial_cap" }))
    expect(extendTrial("trial", T0 + 50 * DAY, T0, 10)).toBe(T0 + 60 * DAY)
  })
  it.each([0, -3, 31, 1.5])("rejects %s days", (d) => expect(() => extendTrial("trial", end, T0, d)).toThrowError(expect.objectContaining({ code: "invalid_input" })))
  it.each<StoreStatus>(["active", "grace", "read_only", "suspended", "cancelled", "deleted", "pending_deletion"])("only a trial can be extended, not %s", (s) => {
    expect(() => extendTrial(s, end, T0, 5)).toThrowError(expect.objectContaining({ code: "invalid_transition" }))
  })
})

describe("dueStatus: the dunning ladder (what the A6 job will apply; here only the pure rule)", () => {
  const due = T0
  const at = (days: number) => due + days * DAY
  const cases: Array<[StoreStatus, number, StoreStatus]> = [
    ["active", -1, "active"], ["active", 0, "active"], ["active", 0.01, "grace"], ["active", 6.9, "grace"],
    ["active", 7, "read_only"], ["active", 29.9, "read_only"], ["active", 30, "suspended"], ["active", 119.9, "suspended"],
    ["active", 120, "pending_deletion"], ["active", 400, "pending_deletion"],
    ["trial", -2, "trial"], ["trial", 1, "grace"], ["trial", 8, "read_only"],
    ["grace", 8, "read_only"], ["read_only", 31, "suspended"], ["suspended", 121, "pending_deletion"],
  ]
  it.each(cases)("%s at %s days past due -> %s", (from, days, to) => expect(dueStatus({ status: from, dueMs: due, nowMs: at(days) })).toBe(to))

  it("never moves a shop BACK: an admin-suspended shop stays suspended even when its due date is in the future", () => {
    expect(dueStatus({ status: "suspended", dueMs: due, nowMs: at(-10) })).toBe("suspended")
    expect(dueStatus({ status: "read_only", dueMs: due, nowMs: at(1) })).toBe("read_only")
  })
  it.each<StoreStatus>(["deleted", "cancelled", "pending_deletion"])("%s is final for dunning", (s) => {
    expect(dueStatus({ status: s, dueMs: due, nowMs: at(500) })).toBe(s)
  })
  it("a shop with no due date is left alone (grandfathered / never billed)", () => {
    expect(dueStatus({ status: "active", dueMs: null, nowMs: at(500) })).toBe("active")
  })
  it("is idempotent: running it again on its own result changes nothing", () => {
    for (const [from, days] of cases) {
      const once = dueStatus({ status: from, dueMs: due, nowMs: at(days) })
      expect(dueStatus({ status: once, dueMs: due, nowMs: at(days) })).toBe(once)
    }
  })
})

describe("review fixes (normalizeTxnRef, assertPaidAt, paidUntilAfterVoid)", () => {
  const D = 86_400_000
  it("normalizeTxnRef trims, upper-cases and turns empty into null", () => {
    expect(normalizeTxnRef("  tx-9a ")).toBe("TX-9A")
    expect(normalizeTxnRef("   ")).toBeNull()
    expect(normalizeTxnRef(null)).toBeNull()
  })
  it("assertPaidAt: now and 30 days back pass; future, older and NaN fail with their own codes", () => {
    const now = 1_800_000_000_000
    expect(() => assertPaidAt(now, now)).not.toThrow()
    expect(() => assertPaidAt(now - 30 * D, now)).not.toThrow()
    expect(() => assertPaidAt(now + 1, now)).toThrow(expect.objectContaining({ code: "paid_in_future" }))
    expect(() => assertPaidAt(now - 30 * D - 1, now)).toThrow(expect.objectContaining({ code: "paid_too_old" }))
    expect(() => assertPaidAt(Number.NaN, now)).toThrow(expect.objectContaining({ code: "invalid_input" }))
  })
  it("paidUntilAfterVoid replays the chain; with nothing left it falls back to the voided payment's paid_at", () => {
    const t0 = 1_800_000_000_000
    expect(paidUntilAfterVoid([t0, t0 + D], t0)).toBe(t0 + 60 * D) // second starts when the first ends
    expect(paidUntilAfterVoid([t0 + D], t0)).toBe(t0 + 31 * D) // first voided: the second stands on its own date
    expect(paidUntilAfterVoid([t0, t0 + 45 * D], t0)).toBe(t0 + 75 * D) // a gap is not filled
    expect(paidUntilAfterVoid([], t0)).toBe(t0)
  })
})
