import postgres from "postgres"
import { DomainError } from "../domain/errors.js"
import type { AdminRecord, AdminRepo, AdminSession, AdminSummary, AuditEntry } from "./admin.js"

// PostgreSQL AdminRepo. Connects as the `admin_app` role, which has NO table grants:
// every call below is an admin_* SECURITY DEFINER function (db/migrations/012). Never connect as `postgres` or `pos_app`.
// All SQL is parameterised (postgres.js tagged templates).
interface AdminRow {
  id: string
  email: string
  name: string
  role: AdminRecord["role"]
  password_hash: string
  totp_secret_enc: string | null
  totp_confirmed_at: Date | null
  totp_last_step: string | number | null
  recovery_codes_hash: string[]
  active: boolean
  must_reenroll: boolean
  allowed_ips: string[]
  last_login_at: Date | null
  created_at: Date
}

const iso = (d: Date | string | null): string | null => (d === null ? null : new Date(d).toISOString())
const toRecord = (r: AdminRow): AdminRecord => ({
  id: r.id, email: r.email, name: r.name, role: r.role, passwordHash: r.password_hash, totpSecretEnc: r.totp_secret_enc,
  enrolled: r.totp_confirmed_at !== null, totpLastStep: r.totp_last_step === null ? null : Number(r.totp_last_step),
  recoveryCodesHash: r.recovery_codes_hash, active: r.active, mustReenroll: r.must_reenroll, allowedIps: r.allowed_ips,
  lastLoginAt: iso(r.last_login_at), createdAt: iso(r.created_at) as string,
})

function mapError(err: unknown): unknown {
  const e = err as { code?: string; message?: string } | null
  if (e?.code === "23505") return new DomainError("email_taken", "এই ইমেইলে আগেই অ্যাডমিন আছে")
  if (e?.code === "P0001" && e.message === "last_super_admin") {
    return new DomainError("last_super_admin", "শেষ সুপার অ্যাডমিনকে সরানো বা নামানো যাবে না")
  }
  return err
}

export function createPgAdmin(opts: { connectionString: string; max?: number }): AdminRepo {
  const sql = postgres(opts.connectionString, { prepare: false, max: opts.max ?? 3, idle_timeout: 20, connect_timeout: 10 })
  const run = async <T>(p: Promise<T>): Promise<T> => {
    try {
      return await p
    } catch (err) {
      throw mapError(err)
    }
  }

  return {
    async findAdminByEmail(email) {
      const rows = await run(sql<AdminRow[]>`SELECT * FROM admin_find_by_email(${email})`)
      return rows[0] ? toRecord(rows[0]) : null
    },
    async getAdmin(id) {
      const rows = await run(sql<AdminRow[]>`SELECT * FROM admin_get(${id})`)
      return rows[0] ? toRecord(rows[0]) : null
    },
    async listAdmins() {
      const rows = await run(sql<Array<{ id: string; email: string; name: string; role: AdminRecord["role"]; active: boolean; enrolled: boolean; must_reenroll: boolean; last_login_at: Date | null; created_at: Date }>>`
        SELECT * FROM admin_list_admins()`)
      return rows.map((r): AdminSummary => ({
        id: r.id, email: r.email, name: r.name, role: r.role, active: r.active, enrolled: r.enrolled,
        mustReenroll: r.must_reenroll, lastLoginAt: iso(r.last_login_at), createdAt: iso(r.created_at) as string,
      }))
    },
    async createAdmin({ email, name, role, passwordHash, totpSecretEnc, createdBy }) {
      const rows = await run(sql<Array<{ id: string }>>`
        SELECT admin_create(${email}, ${name}, ${role}, ${passwordHash}, ${totpSecretEnc}, ${createdBy}) AS id`)
      return rows[0]!.id
    },
    async setRoleActive(id, role, active) {
      const rows = await run(sql<Array<{ ok: boolean }>>`SELECT admin_set_role_active(${id}, ${role}, ${active}) AS ok`)
      return rows[0]!.ok
    },
    async setPassword(id, passwordHash, forceReenroll) {
      const rows = await run(sql<Array<{ ok: boolean }>>`SELECT admin_set_password(${id}, ${passwordHash}, ${forceReenroll}) AS ok`)
      return rows[0]!.ok
    },
    async totpBegin(id, secretEnc) {
      const rows = await run(sql<Array<{ ok: boolean }>>`SELECT admin_totp_begin(${id}, ${secretEnc}) AS ok`)
      return rows[0]!.ok
    },
    async totpConfirm(id, hashes, step, secretEnc) {
      const rows = await run(sql<Array<{ ok: boolean }>>`SELECT admin_totp_confirm(${id}, ${hashes}::text[], ${step}, ${secretEnc}) AS ok`)
      return rows[0]!.ok
    },
    async totpUseStep(id, step) {
      const rows = await run(sql<Array<{ ok: boolean }>>`SELECT admin_totp_use_step(${id}, ${step}) AS ok`)
      return rows[0]!.ok
    },
    async consumeRecovery(id, codeHash) {
      const rows = await run(sql<Array<{ ok: boolean }>>`SELECT admin_consume_recovery(${id}, ${codeHash}) AS ok`)
      return rows[0]!.ok
    },
    async reset2fa(id) {
      const rows = await run(sql<Array<{ ok: boolean }>>`SELECT admin_reset_2fa(${id}) AS ok`)
      return rows[0]!.ok
    },
    async recordLogin(id) {
      await run(sql`SELECT admin_record_login(${id})`)
    },

    async createSession(adminId, stage, expiresSeconds, ip, ua) {
      const rows = await run(sql<Array<{ id: string }>>`SELECT admin_session_create(${adminId}, ${stage}, ${expiresSeconds}, ${ip}, ${ua}) AS id`)
      return rows[0]!.id
    },
    async touchSession(sessionId, idleSeconds) {
      const rows = await run(sql<Array<{ session_id: string; admin_id: string; stage: AdminSession["stage"]; stepup_until: Date | null; email: string; name: string; role: AdminSession["role"] }>>`
        SELECT * FROM admin_session_touch(${sessionId}, ${idleSeconds})`)
      const r = rows[0]
      return r ? { sessionId: r.session_id, adminId: r.admin_id, stage: r.stage, stepUpUntil: iso(r.stepup_until), email: r.email, name: r.name, role: r.role } : null
    },
    async revokeSession(sessionId, reason) {
      await run(sql`SELECT admin_session_revoke(${sessionId}, ${reason})`)
    },
    async stepUpSession(sessionId, seconds) {
      const rows = await run(sql<Array<{ until: Date | null }>>`SELECT admin_session_stepup(${sessionId}, ${seconds}) AS until`)
      return iso(rows[0]?.until ?? null)
    },

    async appendAudit(e: AuditEntry) {
      const rows = await run(sql<Array<{ id: string }>>`
        SELECT admin_audit_append(${e.adminId}, ${e.actor}, ${e.action}, ${e.targetType ?? null}, ${e.targetId ?? null}, ${e.storeId ?? null},
          ${e.reason ?? null}, ${e.before === undefined ? null : sql.json(e.before as never)}, ${e.after === undefined ? null : sql.json(e.after as never)},
          ${e.ip ?? null}, ${e.ua ?? null}, ${e.outcome}, ${e.requestId ?? null}) AS id`)
      return Number(rows[0]!.id)
    },
    async throttle(bucket, max, windowSeconds) {
      const rows = await run(sql<Array<{ ok: boolean }>>`SELECT admin_throttle(${bucket}, ${max}, ${windowSeconds}) AS ok`)
      return rows[0]!.ok
    },
    async throttleReset(bucket) {
      await run(sql`SELECT admin_throttle_reset(${bucket})`)
    },
    async close() {
      await sql.end({ timeout: 5 })
    },
  }
}
