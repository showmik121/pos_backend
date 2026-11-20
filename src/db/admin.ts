import type { AdminRole } from "../domain/admin-permissions.js"

// Admin data access. Two implementations behind this interface, like the shop Repo:
// pg-admin.ts (admin_app role -> admin_* SECURITY DEFINER functions only) and memory-admin.ts (tests).

export type SessionStage = "pending" | "active"

export interface AdminRecord {
  id: string
  email: string
  name: string
  role: AdminRole
  passwordHash: string
  /** AES-GCM envelope; null until enrolment starts */
  totpSecretEnc: string | null
  /** false until the first valid code: no data is returned to a non-enrolled admin (acceptance 6) */
  enrolled: boolean
  totpLastStep: number | null
  recoveryCodesHash: string[]
  active: boolean
  mustReenroll: boolean
  allowedIps: string[]
  lastLoginAt: string | null
  createdAt: string
}

export interface AdminSummary {
  id: string
  email: string
  name: string
  role: AdminRole
  active: boolean
  enrolled: boolean
  mustReenroll: boolean
  lastLoginAt: string | null
  createdAt: string
}

export interface AdminSession {
  sessionId: string
  adminId: string
  stage: SessionStage
  stepUpUntil: string | null
  email: string
  name: string
  role: AdminRole
}

export interface AuditEntry {
  adminId: string | null
  actor: "admin" | "cli" | "system"
  action: string
  targetType?: string | null
  targetId?: string | null
  storeId?: string | null
  reason?: string | null
  before?: unknown
  after?: unknown
  ip?: string | null
  ua?: string | null
  outcome: "ok" | "denied" | "error"
  requestId?: string | null
}

export interface AdminRepo {
  findAdminByEmail(email: string): Promise<AdminRecord | null>
  getAdmin(id: string): Promise<AdminRecord | null>
  listAdmins(): Promise<AdminSummary[]>
  /** email_taken (409) if the address exists */
  createAdmin(input: { email: string; name: string; role: AdminRole; passwordHash: string; totpSecretEnc: string | null; createdBy: string | null }): Promise<string>
  /** false if no such admin; throws last_super_admin if it would leave zero active super admins; deactivation revokes all sessions */
  setRoleActive(id: string, role: AdminRole, active: boolean): Promise<boolean>
  setPassword(id: string, passwordHash: string, forceReenroll: boolean): Promise<boolean>
  /** store the encrypted secret while not yet enrolled */
  totpBegin(id: string, secretEnc: string): Promise<boolean>
  /** `secretEnc` must be the stored secret whose code was just verified; a changed secret (concurrent re-begin) is refused */
  totpConfirm(id: string, recoveryCodeHashes: string[], step: number, secretEnc: string): Promise<boolean>
  /** replay guard: true once per 30 s step */
  totpUseStep(id: string, step: number): Promise<boolean>
  /** removes the code atomically: true once */
  consumeRecovery(id: string, codeHash: string): Promise<boolean>
  reset2fa(id: string): Promise<boolean>
  recordLogin(id: string): Promise<void>

  createSession(adminId: string, stage: SessionStage, expiresSeconds: number, ip: string | null, ua: string | null): Promise<string>
  /** live-check + touch in one step: null if revoked, idle-expired, past the absolute limit, or the admin is inactive */
  touchSession(sessionId: string, idleSeconds: number): Promise<AdminSession | null>
  revokeSession(sessionId: string, reason: string): Promise<void>
  stepUpSession(sessionId: string, seconds: number): Promise<string | null>

  appendAudit(entry: AuditEntry): Promise<number>
  /** bucket is namespaced "admin:" inside the repo so shop attempts can never lock admins out (§17.8) */
  throttle(bucket: string, max: number, windowSeconds: number): Promise<boolean>
  throttleReset(bucket: string): Promise<void>
  close(): Promise<void>
}
