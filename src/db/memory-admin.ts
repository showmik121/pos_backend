import { randomUUID } from "node:crypto"
import { DomainError } from "../domain/errors.js"
import type { AuditRowDto, BillingOverview, ClientErrorRow, ErrorStatus, Payment, Plan, TenantBilling, TenantDetail, TenantNote, TenantRow } from "../contract/admin-api.js"
import { assertPaidAt, assertPaymentAmount, extendTrial as extendTrialDate, normalizeTxnRef, paidUntilAfterVoid, periodFor, statusAfterPayment } from "../domain/billing.js"
import { decodeAuditCursor, decodeOffsetCursor, encodeOffsetCursor, maskPhone, nextStatus } from "../domain/tenant-admin.js"
import type { AdminRecord, AdminRepo, AdminSession, AdminSummary, AuditEntry } from "./admin.js"
import type { StoreKind, StoreStatus } from "./types.js"

// statuses the sync-health views leave out: the shop is gone or going, or suspended (it cannot sync, so "stuck" would be noise)
// byte-order comparison, like Postgres with the C collation on hex/uuid text (localeCompare depends on the machine's locale)
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const GONE: ReadonlySet<StoreStatus> = new Set<StoreStatus>(["deleted", "cancelled", "pending_deletion", "suspended"])

const DAY_MS = 86_400_000
const TRIALS_SOON_DAYS = 7
const OVERVIEW_LIST_LIMIT = 50
/** [start, end) of the Asia/Dhaka calendar month containing `ms` (UTC+6, no DST), as epoch ms */
export function dhakaMonth(ms: number): { startMs: number; endMs: number } {
  const shifted = new Date(ms + 6 * 3_600_000)
  const y = shifted.getUTCFullYear()
  const m = shifted.getUTCMonth()
  return { startMs: Date.UTC(y, m, 1) - 6 * 3_600_000, endMs: Date.UTC(y, m + 1, 1) - 6 * 3_600_000 }
}
// Placeholder prices (BDT 499 / 1,199 / 2,499): PRD Q2 is still open. Same rows as db/migrations/015.
export const DEFAULT_PLAN_ID = "00000000-0000-4000-8000-000000000a03"
export const DEFAULT_PLANS: Plan[] = [
  { id: "00000000-0000-4000-8000-000000000a01", code: "starter", name: "Starter", pricePoisha: 49_900, limits: { devices: 1, staff: 1 }, features: { reports: false, multi_device: false }, active: true },
  { id: "00000000-0000-4000-8000-000000000a02", code: "growth", name: "Growth", pricePoisha: 119_900, limits: { devices: 2, staff: 3 }, features: { reports: true, multi_device: false }, active: true },
  { id: "00000000-0000-4000-8000-000000000a03", code: "business", name: "Business", pricePoisha: 249_900, limits: { devices: 5, staff: 10 }, features: { reports: true, multi_device: true }, active: true },
]

// In-memory AdminRepo for unit tests. Mirrors the SQL functions in db/migrations/012 and 013 (same guards, same atomic semantics).
export interface AuditRow extends AuditEntry {
  id: number
  at: string
}

export interface TenantSeed {
  id?: string
  name: string
  kind?: StoreKind
  address?: string | null
  ownerName?: string
  ownerPhone: string
  status?: StoreStatus
  grandfathered?: boolean
  createdAt?: string
  trialEndsAt?: string | null
  lastSyncAt?: string | null
  statusMessage?: string | null
  /** number of registered devices (codes A, B, ...) */
  devices?: number
  planId?: string | null
  currentPeriodEnd?: string | null
}

interface TenantRec {
  id: string
  name: string
  kind: StoreKind
  address: string | null
  createdAt: string
  status: StoreStatus
  grandfathered: boolean
  trialEndsAt: string | null
  readOnlySince: string | null
  statusMessage: string | null
  statusChangedAt: string
  lastSyncAt: string | null
  devices: Array<{ code: string; createdAt: string }>
  people: Array<{ name: string; phone: string; role: "owner" | "staff"; active: boolean; createdAt: string }>
  history: TenantDetail["statusHistory"]
  notes: TenantNote[]
  planId: string | null
  currentPeriodEnd: string | null
}

export function createMemoryAdmin(opts: { now?: () => number; onStatusChange?: (storeId: string, status: StoreStatus, message: string | null) => void } = {}): AdminRepo & {
  auditRows(): AuditRow[]
  sessionRow(id: string): { revokedAt: string | null; revokedReason: string | null; expiresAt: number } | undefined
  /** test seam: puts a tenant into the directory the admin routes read (production reads the stores table) */
  seedTenant(seed: TenantSeed): string
  seedStaff(storeId: string, p: { name: string; phone: string; role?: "owner" | "staff" }): void
  /** test seam: a row of the shop's client_errors table (one per fingerprint) */
  seedClientError(e: { fingerprint: string; kind: string; message: string; path: string | null; appVersion: string | null; count: number; firstAt: string; lastAt: string; storeId: string | null }): void
  /** test seam: live batches below zero for a tenant (production reads stock_batches) */
  seedNegativeStock(storeId: string, v: { batches: number; unitsShort: number }): void
} {
  const now = opts.now ?? (() => Date.now())
  const tenants = new Map<string, TenantRec>()
  const clientErrors = new Map<string, Omit<ClientErrorRow, "status" | "note" | "firstStoreId"> & { storeId: string | null }>()
  const triage = new Map<string, { status: ErrorStatus; note: string | null; updatedAt: string }>()
  const negative = new Map<string, { batches: number; unitsShort: number }>()
  // a resolved error seen again after it was resolved is open again; an ignored one stays ignored (db/migrations/014)
  const effectiveStatus = (fp: string): ErrorStatus => {
    const tr = triage.get(fp)
    const e = clientErrors.get(fp)
    if (!tr) return "open"
    return tr.status === "resolved" && e && Date.parse(e.lastAt) > Date.parse(tr.updatedAt) ? "open" : tr.status
  }
  let noteSeq = 0
  // billing (A3). Default plans mirror db/migrations/015 (same ids, so a test can run against either repo).
  const plans = new Map<string, Plan>(DEFAULT_PLANS.map((p) => [p.id, { ...p, limits: { ...p.limits }, features: { ...p.features } }]))
  const payments: Array<Payment & { idemKey: string; sig: string }> = []
  const subEvents = new Map<string, TenantBilling["events"]>()
  const admins = new Map<string, AdminRecord>()
  interface S { id: string; adminId: string; stage: "pending" | "active"; lastSeen: number; expiresAt: number; stepUpUntil: number | null; revokedAt: number | null; revokedReason: string | null }
  const sessions = new Map<string, S>()
  const audit: AuditRow[] = []
  const attempts = new Map<string, number[]>()
  let auditSeq = 0
  const iso = (ms: number) => new Date(ms).toISOString()

  const summary = (a: AdminRecord): AdminSummary => ({
    id: a.id, email: a.email, name: a.name, role: a.role, active: a.active, enrolled: a.enrolled,
    mustReenroll: a.mustReenroll, lastLoginAt: a.lastLoginAt, createdAt: a.createdAt,
  })
  const toTenantRow = (t: TenantRec): TenantRow => {
    const owner = t.people.find((p) => p.role === "owner")
    return {
      id: t.id, name: t.name, kind: t.kind, ownerName: owner?.name ?? null, ownerPhoneMasked: owner ? maskPhone(owner.phone) : null,
      createdAt: t.createdAt, status: t.status, grandfathered: t.grandfathered, trialEndsAt: t.trialEndsAt, lastSyncAt: t.lastSyncAt,
      deviceCount: t.devices.length, staffCount: t.people.filter((p) => p.role === "staff").length,
    }
  }
  const clonePlan = (p: Plan): Plan => ({ ...p, limits: { ...p.limits }, features: { ...p.features } })
  const publicPayment = (p: Payment & { idemKey: string; sig: string }): Payment => {
    const { idemKey: _k, sig: _s, ...rest } = p
    return rest
  }
  const pushEvent = (storeId: string, e: TenantBilling["events"][number]) => subEvents.set(storeId, [...(subEvents.get(storeId) ?? []), e])
  const billingView = (t: TenantRec): TenantBilling => ({
    storeId: t.id, status: t.status, grandfathered: t.grandfathered,
    plan: t.planId && plans.has(t.planId) ? clonePlan(plans.get(t.planId)!) : null,
    trialEndsAt: t.trialEndsAt, currentPeriodEnd: t.currentPeriodEnd,
    payments: payments.filter((p) => p.storeId === t.id).sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt) || cmp(b.id, a.id)).map(publicPayment),
    events: [...(subEvents.get(t.id) ?? [])].reverse(),
  })

  const revokeAll = (adminId: string, reason: string) => {
    for (const s of sessions.values()) if (s.adminId === adminId && s.revokedAt === null) { s.revokedAt = now(); s.revokedReason = reason }
  }
  // same as admin_set_role_active: only an ENROLLED super counts (one that cannot finish signing in is not a spare)
  const isSpareSuper = (a: AdminRecord) => a.role === "super" && a.active && a.enrolled && !a.mustReenroll
  const activeSupers = () => [...admins.values()].filter(isSpareSuper).length
  const put = (id: string, patch: Partial<AdminRecord>) => {
    const a = admins.get(id)
    if (!a) return false
    admins.set(id, { ...a, ...patch })
    return true
  }

  return {
    auditRows: () => audit.map((r) => ({ ...r })),
    sessionRow: (id) => {
      const s = sessions.get(id)
      return s && { revokedAt: s.revokedAt === null ? null : iso(s.revokedAt), revokedReason: s.revokedReason, expiresAt: s.expiresAt }
    },
    seedTenant(seed) {
      const id = seed.id ?? randomUUID()
      const createdAt = seed.createdAt ?? iso(now())
      const status = seed.status ?? "active"
      tenants.set(id, {
        id, name: seed.name, kind: seed.kind ?? "pharmacy", address: seed.address ?? null, createdAt, status,
        grandfathered: seed.grandfathered ?? false,
        trialEndsAt: seed.trialEndsAt ?? (status === "trial" ? iso(now() + 14 * 86_400_000) : null),
        readOnlySince: null, statusMessage: seed.statusMessage ?? null, statusChangedAt: createdAt, lastSyncAt: seed.lastSyncAt ?? null,
        devices: Array.from({ length: seed.devices ?? 0 }, (_, i) => ({ code: String.fromCharCode(65 + i), createdAt })), people: [{ name: seed.ownerName ?? "Owner", phone: seed.ownerPhone, role: "owner", active: true, createdAt }], history: [], notes: [],
        planId: seed.planId ?? null, currentPeriodEnd: seed.currentPeriodEnd ?? null,
      })
      return id
    },
    seedClientError(e) { clientErrors.set(e.fingerprint, { ...e }) },
    seedNegativeStock(storeId, v) { negative.set(storeId, v) },
    seedStaff(storeId, p) {
      tenants.get(storeId)?.people.push({ name: p.name, phone: p.phone, role: p.role ?? "staff", active: true, createdAt: iso(now()) })
    },

    async findAdminByEmail(email) {
      const e = email.trim().toLowerCase()
      return [...admins.values()].find((a) => a.email === e) ?? null
    },
    async getAdmin(id) { return admins.get(id) ?? null },
    async listAdmins() { return [...admins.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(summary) },

    async createAdmin({ email, name, role, passwordHash, totpSecretEnc }) {
      const e = email.trim().toLowerCase()
      if ([...admins.values()].some((a) => a.email === e)) throw new DomainError("email_taken", "এই ইমেইলে আগেই অ্যাডমিন আছে")
      const id = randomUUID()
      admins.set(id, {
        id, email: e, name, role, passwordHash, totpSecretEnc, enrolled: false, totpLastStep: null, recoveryCodesHash: [],
        active: true, mustReenroll: false, allowedIps: [], lastLoginAt: null, createdAt: iso(now()),
      })
      return id
    },

    async setRoleActive(id, role, active) {
      const before = admins.get(id)
      if (!before) return false
      const wasSuper = isSpareSuper(before)
      admins.set(id, { ...before, role, active })
      if (wasSuper && activeSupers() < 1) {
        admins.set(id, before) // rolled back, like the SQL exception
        throw new DomainError("last_super_admin", "শেষ সুপার অ্যাডমিনকে সরানো বা নামানো যাবে না")
      }
      if (!active) revokeAll(id, "deactivated")
      return true
    },

    async setPassword(id, passwordHash, forceReenroll) {
      const a = admins.get(id)
      if (!a) return false
      // same as admin_set_password: a forced re-enrolment ALSO clears 2FA in the same step (PRD 17.2)
      put(id, forceReenroll
        ? { passwordHash, mustReenroll: true, totpSecretEnc: null, enrolled: false, totpLastStep: null, recoveryCodesHash: [] }
        : { passwordHash })
      revokeAll(id, "password_changed")
      return true
    },

    async totpBegin(id, secretEnc) {
      const a = admins.get(id)
      // same as admin_totp_begin: only an EMPTY slot is filled, a secret that already exists is never silently replaced
      if (!a || !a.active || a.enrolled || a.totpSecretEnc !== null) return false
      return put(id, { totpSecretEnc: secretEnc, totpLastStep: null })
    },
    async totpConfirm(id, hashes, step, secretEnc) {
      const a = admins.get(id)
      if (!a || !a.active || a.enrolled || !a.totpSecretEnc || a.totpSecretEnc !== secretEnc) return false
      return put(id, { enrolled: true, totpLastStep: step, recoveryCodesHash: hashes, mustReenroll: false })
    },
    async totpUseStep(id, step) {
      const a = admins.get(id)
      if (!a || !a.active || !a.enrolled || (a.totpLastStep !== null && a.totpLastStep >= step)) return false
      return put(id, { totpLastStep: step })
    },
    async consumeRecovery(id, codeHash) {
      const a = admins.get(id)
      if (!a || !a.active || !a.recoveryCodesHash.includes(codeHash)) return false
      return put(id, { recoveryCodesHash: a.recoveryCodesHash.filter((h) => h !== codeHash) })
    },
    async reset2fa(id) {
      if (!put(id, { totpSecretEnc: null, enrolled: false, totpLastStep: null, recoveryCodesHash: [], mustReenroll: true })) return false
      revokeAll(id, "2fa_reset")
      return true
    },
    async recordLogin(id) { put(id, { lastLoginAt: iso(now()) }) },

    async createSession(adminId, stage, expiresSeconds) {
      const id = randomUUID()
      sessions.set(id, { id, adminId, stage, lastSeen: now(), expiresAt: now() + expiresSeconds * 1000, stepUpUntil: null, revokedAt: null, revokedReason: null })
      return id
    },
    async touchSession(sessionId, idleSeconds): Promise<AdminSession | null> {
      const s = sessions.get(sessionId)
      const a = s && admins.get(s.adminId)
      if (!s || !a || !a.active || s.revokedAt !== null || s.expiresAt <= now() || s.lastSeen <= now() - idleSeconds * 1000) return null
      s.lastSeen = now()
      return { sessionId: s.id, adminId: a.id, stage: s.stage, stepUpUntil: s.stepUpUntil === null ? null : iso(s.stepUpUntil), email: a.email, name: a.name, role: a.role }
    },
    async revokeSession(sessionId, reason) {
      const s = sessions.get(sessionId)
      if (s && s.revokedAt === null) { s.revokedAt = now(); s.revokedReason = reason }
    },
    async stepUpSession(sessionId, seconds) {
      const s = sessions.get(sessionId)
      if (!s || s.stage !== "active" || s.revokedAt !== null || s.expiresAt <= now()) return null
      s.stepUpUntil = now() + seconds * 1000
      return iso(s.stepUpUntil)
    },

    async appendAudit(entry) {
      audit.push({ ...entry, id: ++auditSeq, at: iso(now()) })
      return auditSeq
    },
    // ---- tenants (A1)
    async listTenants(q) {
      const needle = q.q?.toLowerCase()
      const cutoff = q.noSyncDays === undefined ? null : now() - q.noSyncDays * 86_400_000
      const matches = [...tenants.values()].filter(
        (t) =>
          (q.status === undefined || t.status === q.status) &&
          (q.kind === undefined || t.kind === q.kind) &&
          (cutoff === null || t.lastSyncAt === null || Date.parse(t.lastSyncAt) < cutoff) &&
          (needle === undefined || t.name.toLowerCase().includes(needle) || t.id.includes(needle) || t.people.some((p) => p.phone === q.q?.trim())),
      )
      const key = (t: TenantRec): string =>
        q.sort === "name" ? t.name.toLowerCase() : q.sort === "lastSync" ? (t.lastSyncAt ?? "1970-01-01T00:00:00.000Z") : q.sort === "status" ? t.status : t.createdAt
      const sign = q.dir === "asc" ? 1 : -1
      // same order as the SQL: the chosen key in the chosen direction, then id ascending
      matches.sort((a, b) => sign * (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      const offset = decodeOffsetCursor(q.cursor)
      const page = matches.slice(offset, offset + q.limit)
      return {
        tenants: page.map(toTenantRow),
        total: matches.length,
        nextCursor: offset + q.limit < matches.length ? encodeOffsetCursor(offset + q.limit) : null,
      }
    },
    async getTenant(storeId) {
      const t = tenants.get(storeId)
      if (!t) return null
      return {
        tenant: { ...toTenantRow(t), address: t.address, statusMessage: t.statusMessage, statusChangedAt: t.statusChangedAt, readOnlySince: t.readOnlySince, lastEventAt: null },
        staff: t.people.map((p) => ({ name: p.name, phoneMasked: maskPhone(p.phone), role: p.role, active: p.active, createdAt: p.createdAt })),
        devices: t.devices.map((d) => ({ ...d })),
        statusHistory: [...t.history].reverse(),
        recentErrors: [],
      }
    },
    async revealPhones(storeId) {
      const t = tenants.get(storeId)
      return t ? t.people.map((p) => ({ name: p.name, role: p.role, phone: p.phone })) : null
    },
    async changeTenantStatus({ storeId, action, adminId, reason, message }) {
      const t = tenants.get(storeId)
      if (!t) throw new DomainError("not_found", "Tenant not found.")
      const to = nextStatus(action, t.status, t.trialEndsAt, now())
      if (to === null) throw new DomainError("invalid_transition", `Cannot ${action.replace("_", "-")} a tenant that is ${t.status}.`)
      const at = iso(now())
      const from = t.status
      const ownerMessage = action === "reactivate" ? null : message
      tenants.set(storeId, {
        ...t, status: to, statusMessage: ownerMessage, statusChangedAt: at,
        readOnlySince: to === "read_only" ? at : null,
        history: [...t.history, { at, fromStatus: from, toStatus: to, adminName: admins.get(adminId)?.name ?? null, reason, message: ownerMessage }],
      })
      opts.onStatusChange?.(storeId, to, ownerMessage)
      return { fromStatus: from, toStatus: to, changedAt: at }
    },
    async listNotes(storeId) {
      const t = tenants.get(storeId)
      return t ? [...t.notes].reverse() : null
    },
    async addNote(storeId, adminId, body, tags) {
      const t = tenants.get(storeId)
      if (!t) return null
      const note: TenantNote = { id: ++noteSeq, at: iso(now()), adminName: admins.get(adminId)?.name ?? null, body, tags }
      t.notes.push(note)
      return { ...note }
    },
    async listAudit(q) {
      const before = decodeAuditCursor(q.cursor)
      const from = q.from === undefined ? null : Date.parse(q.from)
      const to = q.to === undefined ? null : Date.parse(q.to)
      const hits = audit
        .filter(
          (r) =>
            (q.action === undefined || r.action === q.action) &&
            (q.outcome === undefined || r.outcome === q.outcome) &&
            (q.adminId === undefined || r.adminId === q.adminId) &&
            (q.storeId === undefined || r.storeId === q.storeId) &&
            (from === null || Date.parse(r.at) >= from) &&
            (to === null || Date.parse(r.at) < to) &&
            (before === null || r.id < before),
        )
        .sort((a, b) => b.id - a.id)
      const page = hits.slice(0, q.limit)
      const rows: AuditRowDto[] = page.map((r) => ({
        id: r.id, at: r.at, adminId: r.adminId, adminName: r.adminId ? (admins.get(r.adminId)?.name ?? null) : null, actor: r.actor, action: r.action,
        outcome: r.outcome, targetType: r.targetType ?? null, targetId: r.targetId ?? null, storeId: r.storeId ?? null, reason: r.reason ?? null,
        before: r.before ?? null, after: r.after ?? null, ip: r.ip ?? null, requestId: r.requestId ?? null,
      }))
      return { rows, nextCursor: hits.length > q.limit ? String(page[page.length - 1]!.id) : null }
    },

    // ---- health (A2). Mirrors admin_health_* in db/migrations/014.
    async healthSync({ stuckHours, limit }) {
      const cutoff = now() - stuckHours * 3_600_000
      const rows = [...tenants.values()]
        .filter((t) => !GONE.has(t.status) && Date.parse(t.lastSyncAt ?? t.createdAt) < cutoff)
        .sort((a, b) => Date.parse(a.lastSyncAt ?? a.createdAt) - Date.parse(b.lastSyncAt ?? b.createdAt) || cmp(a.id, b.id))
      return {
        total: rows.length,
        tenants: rows.slice(0, limit).map((t) => ({
          id: t.id, name: t.name, status: t.status, lastSyncAt: t.lastSyncAt, createdAt: t.createdAt,
          hoursSinceSync: Math.floor((now() - Date.parse(t.lastSyncAt ?? t.createdAt)) / 3_600_000),
        })),
      }
    },
    async listClientErrors({ status, limit }) {
      return [...clientErrors.values()]
        .map((e): ClientErrorRow => {
          const tr = triage.get(e.fingerprint)
          return {
            fingerprint: e.fingerprint, kind: e.kind, message: e.message, path: e.path, appVersion: e.appVersion, count: e.count,
            firstAt: e.firstAt, lastAt: e.lastAt, firstStoreId: e.storeId, status: effectiveStatus(e.fingerprint), note: tr?.note ?? null,
          }
        })
        .filter((e) => status === "all" || e.status === status)
        .sort((a, b) => b.lastAt.localeCompare(a.lastAt) || cmp(a.fingerprint, b.fingerprint))
        .slice(0, limit)
    },
    async setErrorTriage({ fingerprint, status, note }) {
      if (!clientErrors.has(fingerprint)) return null
      const updatedAt = iso(now())
      triage.set(fingerprint, { status, note, updatedAt })
      return { fingerprint, status, note, updatedAt }
    },
    async negativeStock({ limit }) {
      const rows = [...negative.entries()]
        .filter(([id, v]) => tenants.has(id) && v.batches > 0)
        .map(([id, v]) => ({ id, name: tenants.get(id)!.name, status: tenants.get(id)!.status, batches: v.batches, unitsShort: v.unitsShort }))
        .sort((a, b) => b.unitsShort - a.unitsShort || cmp(a.id, b.id))
      return { total: rows.length, tenants: rows.slice(0, limit) }
    },
    async dashboard(stuckHours) {
      const all = [...tenants.values()]
      const byStatus: Record<string, number> = {}
      for (const t of all) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1
      const dhakaDay = (ms: number) => Math.floor((ms + 6 * 3_600_000) / 86_400_000)
      const cutoff = now() - stuckHours * 3_600_000
      return {
        tenantsByStatus: byStatus,
        stuckSync: all.filter((t) => !GONE.has(t.status) && Date.parse(t.lastSyncAt ?? t.createdAt) < cutoff).length,
        newErrors: [...clientErrors.values()].filter((e) => effectiveStatus(e.fingerprint) === "open" && Date.parse(e.lastAt) >= now() - 86_400_000).length,
        negativeStockTenants: [...negative.entries()].filter(([id, v]) => tenants.has(id) && v.batches > 0).length,
        signupsToday: all.filter((t) => dhakaDay(Date.parse(t.createdAt)) === dhakaDay(now())).length,
        stuckHours,
      }
    },

    // ---- billing (A3). Mirrors admin_billing_* in db/migrations/015. Money is integer poisha; revenue is computed from payment rows only.
    async listPlans() {
      return [...plans.values()].sort((a, b) => a.pricePoisha - b.pricePoisha || cmp(a.id, b.id)).map(clonePlan)
    },
    async updatePlan({ id, patch }) {
      const before = plans.get(id)
      if (!before) return null
      const after: Plan = {
        ...before,
        name: patch.name ?? before.name,
        pricePoisha: patch.pricePoisha ?? before.pricePoisha,
        active: patch.active ?? before.active,
        limits: { ...before.limits, ...patch.limits },
        features: { ...before.features, ...patch.features },
      }
      plans.set(id, after)
      return { before: clonePlan(before), after: clonePlan(after) }
    },
    async tenantBilling(storeId) {
      const t = tenants.get(storeId)
      return t ? billingView(t) : null
    },
    async recordPayment(input) {
      const t = tenants.get(input.storeId)
      if (!t) return null
      const txnRef = normalizeTxnRef(input.txnRef)
      if (!admins.get(input.adminId)?.active || !/^[A-Za-z0-9_-]{8,64}$/.test(input.idempotencyKey) || (input.txnRef ?? "").length > 60) {
        throw new DomainError("invalid_input", "The request was not accepted. Check the values.")
      }
      const sig = JSON.stringify([input.amountPoisha, input.method, txnRef, input.paidAt === null ? null : Date.parse(input.paidAt), input.planId])
      const prior = payments.find((p) => p.storeId === input.storeId && p.idemKey === input.idempotencyKey)
      if (prior) {
        if (prior.sig !== sig) throw new DomainError("idempotency_conflict", "This idempotency key was already used for a different payment.")
        return { payment: publicPayment(prior), replayed: true, fromStatus: t.status, toStatus: t.status }
      }
      const plan = plans.get(input.planId ?? t.planId ?? DEFAULT_PLAN_ID)
      if (!plan) throw new DomainError("not_found", "Plan not found.")
      if (!plan.active) throw new DomainError("plan_inactive", "This plan is not active.")
      if (input.method !== "cash" && txnRef === null) throw new DomainError("txn_ref_required", "A transaction reference is required for this payment method.")
      const paidAtMs = input.paidAt === null ? now() : Date.parse(input.paidAt)
      assertPaidAt(paidAtMs, now())
      assertPaymentAmount(plan.pricePoisha, input.amountPoisha)
      if (txnRef !== null && payments.some((p) => !p.voidedAt && p.method === input.method && p.txnRef === txnRef)) {
        throw new DomainError("duplicate_txn", "A payment with this method and transaction reference is already recorded.")
      }
      const from = t.status
      const to = statusAfterPayment(from)
      const period = periodFor(t.currentPeriodEnd === null ? null : Date.parse(t.currentPeriodEnd), paidAtMs)
      const at = iso(now())
      const rec = {
        id: randomUUID(), storeId: t.id, planId: plan.id, amountPoisha: input.amountPoisha, method: input.method, txnRef,
        paidAt: iso(paidAtMs), periodStart: iso(period.startMs), periodEnd: iso(period.endMs), recordedAt: at,
        recordedByName: admins.get(input.adminId)?.name ?? null, voidedAt: null, voidReason: null, idemKey: input.idempotencyKey, sig,
      }
      payments.push(rec)
      tenants.set(t.id, {
        ...t, status: to, grandfathered: false, planId: plan.id, currentPeriodEnd: rec.periodEnd,
        ...(from === to ? {} : { statusMessage: null, readOnlySince: null }), statusChangedAt: from === to ? t.statusChangedAt : at,
        history: from === to ? t.history : [...t.history, { at, fromStatus: from, toStatus: to, adminName: admins.get(input.adminId)?.name ?? null, reason: "Payment recorded", message: null }],
      })
      pushEvent(t.id, { at, fromStatus: from, toStatus: to, actor: "admin", adminName: admins.get(input.adminId)?.name ?? null, reason: "Payment recorded" })
      if (from !== to) opts.onStatusChange?.(t.id, to, null)
      return { payment: publicPayment(rec), replayed: false, fromStatus: from, toStatus: to }
    },
    async voidPayment({ paymentId, reason, adminId }) {
      const p = payments.find((x) => x.id === paymentId)
      if (!p) return null
      if (p.voidedAt) throw new DomainError("payment_already_voided", "This payment is already voided.")
      if (!admins.get(adminId)?.active) throw new DomainError("invalid_input", "The request was not accepted. Check the values.")
      p.voidedAt = iso(now())
      p.voidReason = reason
      const t = tenants.get(p.storeId)!
      const remaining = payments.filter((x) => x.storeId === t.id && !x.voidedAt).map((x) => Date.parse(x.paidAt))
      tenants.set(t.id, { ...t, currentPeriodEnd: iso(paidUntilAfterVoid(remaining, Date.parse(p.paidAt))) })
      pushEvent(t.id, { at: p.voidedAt, fromStatus: t.status, toStatus: t.status, actor: "admin", adminName: admins.get(adminId)?.name ?? null, reason: `Payment voided: ${reason}` })
      return { payment: publicPayment(p), storeId: t.id }
    },
    async extendTrial({ storeId, days, reason, adminId }) {
      const t = tenants.get(storeId)
      if (!t) return null
      if (!admins.get(adminId)?.active) throw new DomainError("invalid_input", "The request was not accepted. Check the values.")
      const next = extendTrialDate(t.status, t.trialEndsAt === null ? null : Date.parse(t.trialEndsAt), now(), days)
      tenants.set(storeId, { ...t, trialEndsAt: iso(next) })
      pushEvent(storeId, { at: iso(now()), fromStatus: t.status, toStatus: t.status, actor: "admin", adminName: admins.get(adminId)?.name ?? null, reason: `Trial extended by ${days} days: ${reason}` })
      return { trialEndsAt: iso(next), status: t.status }
    },
    async billingOverview() {
      const n = now()
      const { startMs, endMs } = dhakaMonth(n)
      const live = payments.filter((p) => !p.voidedAt)
      const all = [...tenants.values()]
      const byStatus: Record<string, number> = {}
      for (const t of all) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1
      const thisMonth = live.filter((p) => Date.parse(p.paidAt) >= startMs && Date.parse(p.paidAt) < endMs)
      const overdue = all
        .map((t) => ({ t, due: t.grandfathered || t.status === "deleted" || t.status === "cancelled" ? null : (t.status === "trial" ? t.trialEndsAt : t.currentPeriodEnd) }))
        .filter((x): x is { t: TenantRec; due: string } => x.due !== null && Math.floor((n - Date.parse(x.due)) / DAY_MS) >= 1)
        .map((x) => ({ id: x.t.id, name: x.t.name, status: x.t.status, dueAt: x.due, daysOverdue: Math.floor((n - Date.parse(x.due)) / DAY_MS) }))
        .sort((a, b) => b.daysOverdue - a.daysOverdue || cmp(a.id, b.id))
      return {
        mrrPoisha: live.filter((p) => Date.parse(p.periodStart) <= n && n < Date.parse(p.periodEnd)).reduce((s, p) => s + p.amountPoisha, 0),
        collectedThisMonthPoisha: thisMonth.reduce((s, p) => s + p.amountPoisha, 0),
        paymentsThisMonth: thisMonth.length,
        voidedThisMonthPoisha: payments.filter((p) => p.voidedAt && Date.parse(p.voidedAt) >= startMs && Date.parse(p.voidedAt) < endMs).reduce((s, p) => s + p.amountPoisha, 0),
        tenantsByStatus: byStatus,
        grandfathered: all.filter((t) => t.grandfathered).length,
        trialsEndingSoon: all
          .filter((t) => t.status === "trial" && t.trialEndsAt !== null && Date.parse(t.trialEndsAt) >= n && Date.parse(t.trialEndsAt) < n + TRIALS_SOON_DAYS * DAY_MS)
          .sort((a, b) => Date.parse(a.trialEndsAt!) - Date.parse(b.trialEndsAt!) || cmp(a.id, b.id))
          .slice(0, OVERVIEW_LIST_LIMIT)
          .map((t) => ({ id: t.id, name: t.name, trialEndsAt: t.trialEndsAt! })),
        overdue: overdue.slice(0, OVERVIEW_LIST_LIMIT),
        overdueTotal: overdue.length,
      } satisfies BillingOverview
    },

    async throttle(bucket, max, windowSeconds) {
      const key = `admin:${bucket}`
      const t = now()
      const recent = (attempts.get(key) ?? []).filter((x) => x > t - windowSeconds * 1000)
      if (recent.length >= max) { attempts.set(key, recent); return false }
      recent.push(t)
      attempts.set(key, recent)
      return true
    },
    async throttleReset(bucket) { attempts.delete(`admin:${bucket}`) },
    async close() {},
  }
}
