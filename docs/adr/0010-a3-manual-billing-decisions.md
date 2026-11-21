# ADR 0010: A3 manual billing decisions (plans, payments, trial, revenue)

Status: accepted (A3 backend + panel UI) · Date: 2026-11-21 · Spec: ADMIN_PANEL_PRD billing (acceptance row 5) · Migration 015 · Extends ADR 0001, 0003, 0005

## 1. Plans are data, prices are placeholders
`plans` holds starter / growth / business with prices 49,900 / 119,900 / 249,900 poisha. PRD Q2 (the real prices) is NOT confirmed: Finance or Super must set the real prices in the panel before the first real payment. A price change applies to new periods only; recorded payments never change.

## 2. One payment = one 30-day period (exactly 720 hours)
- Amount must be at least the plan price. No partial payments; overpayment is recorded as paid and still buys one period.
- The period starts at the current period end if that is still in the future, otherwise at `paid_at`. Paying early therefore never wastes days.
- A payment clears `grandfathered` and moves a shop in `trial`, `grace`, `active` or `cancelled` to `active`. A shop an admin (or the dunning ladder) put in `suspended`, `read_only` or `pending_deletion` KEEPS that status: the payment is recorded, and an admin reactivates the shop in a separate, audited step (owner decision, 2026-11-21: "payment is recorded, the admin activates afterwards"). `deleted` refuses the payment. Rules live in `src/domain/billing.ts` (pure) and are mirrored in SQL; a parity test runs the memory repo and the real functions side by side.

## 3. Void never deletes
A void marks the row (`voided_at`, reason, admin) and recomputes `current_period_end` from the remaining non-voided payments. It does NOT change the shop status: suspending or reactivating stays a separate, audited decision (ADR 0003). Voiding twice is refused.

## 4. Idempotency and duplicates
- `idempotencyKey` is per shop. Same key + same request returns the first result (`replayed: true`); same key + different request is `idempotency_conflict`.
- A (method, txn_ref) pair may exist only once among non-voided payments (partial unique index `subpay_txn_unique`), so a voided payment's ID can be re-entered. `txn_ref` is required except for cash.
- The panel reuses the key after a network/5xx failure (outcome unknown) and mints a new one after a definite 4xx refusal.

## 5. Trial extension
Only `trial` shops, 1 to 30 days per action, never beyond now + 60 days (`trial_cap`).

## 6. Revenue comes from payment rows only
MRR, collected this month and voided this month are sums over `subscription_payments`; a test reconciles the overview against an independent SQL sum. "Month" is the Asia/Dhaka calendar month. All money is integer poisha; timestamps are timestamptz and shown in Asia/Dhaka.

## 7. Overdue and dunning
Overdue = not grandfathered, not deleted/cancelled, and the due date (trial end for trial, else period end) is at least one whole day past. `dueStatus` (the dunning ladder) is a pure function only; nothing schedules it in A3. A6 will add the scheduler.

## 8. Permissions
`billing.read`: super, support, finance, viewer. `billing.payment.record` and `billing.trial.extend`: super, finance (no step-up). `billing.payment.void` and `billing.plan.edit` need step-up (plan edit: super only). Every mutating route writes an audit row; the transaction ID is kept out of the audit row.

## 9. Table naming
The shop's own `payments` table (001/008) is untouched. The admin billing table is `subscription_payments` (constraints `subpay_*`).
