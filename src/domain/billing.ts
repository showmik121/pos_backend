import type { StoreStatus } from "../db/types.js"
import { DomainError } from "./errors.js"

// Manual billing rules (PRD §8.2). Pure: no clock, no database. Money is integer poisha; times are epoch milliseconds.
// The dunning ladder here is the RULE only; the scheduled job that applies it is A6 and must call dueStatus() so the rule lives in one place.

export const PERIOD_DAYS = 30
export const GRACE_DAYS = 7
/** days after the due date at which a shop is suspended */
export const SUSPEND_AFTER_DAYS = 30
/** days after the due date at which a suspended shop becomes pending_deletion (30 + 90) */
export const PENDING_DELETION_AFTER_DAYS = 120
export const TRIAL_EXTEND_MAX_DAYS = 30
/** a trial never ends later than this many days from now, however often it is extended */
export const TRIAL_MAX_AHEAD_DAYS = 60
/** one payment covers one period; a single payment above this is almost certainly a typo (BDT 1,000,000.00) */
export const MAX_PAYMENT_POISHA = 100_000_000

/** a payment may be backdated by at most one period; older than that the shop would be "active" with an already expired period */
export const MAX_BACKDATE_DAYS = PERIOD_DAYS

const DAY = 86_400_000

const ALL: readonly StoreStatus[] = ["trial", "active", "grace", "read_only", "suspended", "pending_deletion", "deleted", "cancelled"]
const isKnown = (s: string): s is StoreStatus => (ALL as readonly string[]).includes(s)

/** a payment covers PERIOD_DAYS starting when the running period ends (early payers lose no days), or at the payment time if none is running */
export function periodFor(currentPeriodEndMs: number | null, paidAtMs: number): { startMs: number; endMs: number } {
  const startMs = currentPeriodEndMs !== null && currentPeriodEndMs > paidAtMs ? currentPeriodEndMs : paidAtMs
  return { startMs, endMs: startMs + PERIOD_DAYS * DAY }
}

/** one transaction reference has one spelling: trimmed and upper-case, so "abc1" and "ABC1 " cannot both be recorded. Empty means none. */
export function normalizeTxnRef(raw: string | null | undefined): string | null {
  const t = (raw ?? "").trim().toUpperCase()
  return t === "" ? null : t
}

export function assertPaidAt(paidAtMs: number, nowMs: number): void {
  if (Number.isNaN(paidAtMs)) throw new DomainError("invalid_input", "The payment time is not valid.")
  if (paidAtMs > nowMs) throw new DomainError("paid_in_future", "The payment date cannot be in the future.")
  if (paidAtMs < nowMs - MAX_BACKDATE_DAYS * DAY) throw new DomainError("paid_too_old", `A payment cannot be dated more than ${MAX_BACKDATE_DAYS} days back.`)
}

/**
 * Paid-until after a void: the chain of the remaining payments is replayed in the order they were recorded (each starts when the previous one ends,
 * or at its own paid_at if later), exactly as they were first laid out. Voiding an earlier payment therefore pulls later ones forward instead of leaving a free gap.
 * With nothing left, the voided payment's own paid_at is used, so the shop is simply overdue from then (never "paid forever", never undated).
 */
export function paidUntilAfterVoid(remainingPaidAtMs: readonly number[], voidedPaidAtMs: number): number {
  let end: number | null = null
  for (const paidAt of remainingPaidAtMs) end = periodFor(end, paidAt).endMs
  return end ?? voidedPaidAtMs
}

/** Payment at any point before deletion returns the shop to active (PRD §8.2). Unknown statuses fail closed. */
export function statusAfterPayment(from: StoreStatus): "active" {
  if (!isKnown(from) || from === "deleted") throw new DomainError("invalid_transition", "This shop cannot take a payment in its current state.")
  return "active"
}

export function assertPaymentAmount(planPricePoisha: number, amountPoisha: number): void {
  if (!Number.isSafeInteger(amountPoisha) || amountPoisha <= 0 || amountPoisha > MAX_PAYMENT_POISHA) {
    throw new DomainError("invalid_amount", "The amount must be a whole number of poisha, above zero.")
  }
  if (amountPoisha < planPricePoisha) throw new DomainError("amount_below_price", "The amount is below the plan price. Partial payments are not supported.")
}

export function extendTrial(status: StoreStatus, trialEndsAtMs: number | null, nowMs: number, days: number): number {
  if (!Number.isInteger(days) || days < 1 || days > TRIAL_EXTEND_MAX_DAYS) {
    throw new DomainError("invalid_input", `Extend by 1 to ${TRIAL_EXTEND_MAX_DAYS} days.`)
  }
  if (status !== "trial") throw new DomainError("invalid_transition", "Only a shop in its trial can have the trial extended.")
  const base = trialEndsAtMs !== null && trialEndsAtMs > nowMs ? trialEndsAtMs : nowMs
  const next = base + days * DAY
  if (next > nowMs + TRIAL_MAX_AHEAD_DAYS * DAY) throw new DomainError("trial_cap", `A trial cannot end more than ${TRIAL_MAX_AHEAD_DAYS} days from now.`)
  return next
}

const RANK: Partial<Record<StoreStatus, number>> = { grace: 1, read_only: 2, suspended: 3, pending_deletion: 4 }
const FINAL: ReadonlySet<StoreStatus> = new Set<StoreStatus>(["deleted", "cancelled", "pending_deletion"])

/**
 * The status a shop should be in `nowMs` given its due date (period end, or trial end for a trial). It only ever moves a shop FORWARD
 * (a shop an admin suspended is not un-suspended by the ladder), never touches final states, and is idempotent.
 */
export function dueStatus(input: { status: StoreStatus; dueMs: number | null; nowMs: number }): StoreStatus {
  const { status, dueMs, nowMs } = input
  if (!isKnown(status) || FINAL.has(status) || dueMs === null) return status
  const overdueDays = (nowMs - dueMs) / DAY
  let computed: StoreStatus = status
  if (overdueDays > 0) computed = "grace"
  if (overdueDays >= GRACE_DAYS) computed = "read_only"
  if (overdueDays >= SUSPEND_AFTER_DAYS) computed = "suspended"
  if (overdueDays >= PENDING_DELETION_AFTER_DAYS) computed = "pending_deletion"
  return (RANK[computed] ?? 0) > (RANK[status] ?? 0) ? computed : status
}
