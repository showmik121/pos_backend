import { randomUUID } from "node:crypto"
import { DomainError } from "../domain/errors.js"
import type { AdminRecord, AdminRepo, AdminSession, AdminSummary, AuditEntry } from "./admin.js"

// In-memory AdminRepo for unit tests. Mirrors the SQL functions in db/migrations/012 (same guards, same atomic semantics).
export interface AuditRow extends AuditEntry {
  id: number
  at: string
}

export function createMemoryAdmin(opts: { now?: () => number } = {}): AdminRepo & {
  auditRows(): AuditRow[]
  sessionRow(id: string): { revokedAt: string | null; revokedReason: string | null; expiresAt: number } | undefined
} {
  const now = opts.now ?? (() => Date.now())
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
