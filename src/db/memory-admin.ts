import { randomUUID } from "node:crypto"
import { DomainError } from "../domain/errors.js"
import type { AuditRowDto, TenantDetail, TenantNote, TenantRow } from "../contract/admin-api.js"
import { decodeAuditCursor, decodeOffsetCursor, encodeOffsetCursor, maskPhone, nextStatus } from "../domain/tenant-admin.js"
import type { AdminRecord, AdminRepo, AdminSession, AdminSummary, AuditEntry } from "./admin.js"
import type { StoreKind, StoreStatus } from "./types.js"

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
}

export function createMemoryAdmin(opts: { now?: () => number; onStatusChange?: (storeId: string, status: StoreStatus, message: string | null) => void } = {}): AdminRepo & {
  auditRows(): AuditRow[]
  sessionRow(id: string): { revokedAt: string | null; revokedReason: string | null; expiresAt: number } | undefined
  /** test seam: puts a tenant into the directory the admin routes read (production reads the stores table) */
  seedTenant(seed: TenantSeed): string
  seedStaff(storeId: string, p: { name: string; phone: string; role?: "owner" | "staff" }): void
} {
  const now = opts.now ?? (() => Date.now())
  const tenants = new Map<string, TenantRec>()
  let noteSeq = 0
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
      })
      return id
    },
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
