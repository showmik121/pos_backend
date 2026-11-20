import postgres from "postgres"
import { DomainError } from "../domain/errors.js"
import type { AuditRowDto, TenantDetail, TenantNote, TenantRow } from "../contract/admin-api.js"
import { decodeAuditCursor, decodeOffsetCursor, encodeOffsetCursor } from "../domain/tenant-admin.js"
import type { AdminRecord, AdminRepo, AdminSession, AdminSummary, AuditEntry } from "./admin.js"
import type { StoreKind, StoreStatus } from "./types.js"

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
  if (e?.code === "P0001" && e.message === "error_not_found") return new DomainError("not_found", "Error not found.")
  if (e?.code === "P0001" && e.message === "tenant_not_found") return new DomainError("not_found", "Tenant not found.")
  if (e?.code === "P0001" && e.message === "invalid_transition") {
    return new DomainError("invalid_transition", "That change is not allowed in the tenant's current status.")
  }
  return err
}

interface TenantListRow {
  id: string
  name: string
  kind: StoreKind
  owner_name: string | null
  owner_phone_masked: string | null
  created_at: Date
  status: StoreStatus
  grandfathered: boolean
  trial_ends_at: Date | null
  last_sync_at: Date | null
  device_count: number
  staff_count: number
}
const toTenantRow = (r: TenantListRow): TenantRow => ({
  id: r.id, name: r.name, kind: r.kind, ownerName: r.owner_name, ownerPhoneMasked: r.owner_phone_masked, createdAt: iso(r.created_at) as string,
  status: r.status, grandfathered: r.grandfathered, trialEndsAt: iso(r.trial_ends_at), lastSyncAt: iso(r.last_sync_at),
  deviceCount: r.device_count, staffCount: r.staff_count,
})
interface NoteRow { id: string; at: Date; admin_name: string | null; body: string; tags: string[] }
const toNote = (r: NoteRow): TenantNote => ({ id: Number(r.id), at: iso(r.at) as string, adminName: r.admin_name, body: r.body, tags: r.tags })

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
    // ---- tenants (A1): every call is one admin_* SECURITY DEFINER function (db/migrations/013)
    async listTenants(q) {
      const offset = decodeOffsetCursor(q.cursor)
      const rows = await run(sql<Array<TenantListRow & { total: string }>>`
        SELECT * FROM admin_tenant_list(${q.q ?? null}, ${q.status ?? null}, ${q.kind ?? null}, ${q.noSyncDays ?? null}, ${q.sort}, ${q.dir}, ${q.limit}, ${offset})`)
      const total = rows[0] ? Number(rows[0].total) : 0
      return { tenants: rows.map(toTenantRow), total, nextCursor: offset + q.limit < total ? encodeOffsetCursor(offset + q.limit) : null }
    },
    async getTenant(storeId): Promise<TenantDetail | null> {
      const head = await run(sql<Array<TenantListRow & {
        address: string | null; read_only_since: Date | null; status_message: string | null; status_changed_at: Date; last_event_at: Date | null
      }>>`SELECT * FROM admin_tenant_get(${storeId})`)
      const h = head[0]
      if (!h) return null
      const [staff, devices, history, errors] = await Promise.all([
        run(sql<Array<{ name: string; phone_masked: string; role: "owner" | "staff"; active: boolean; created_at: Date }>>`SELECT * FROM admin_tenant_staff(${storeId})`),
        run(sql<Array<{ code: string; created_at: Date }>>`SELECT * FROM admin_tenant_devices(${storeId})`),
        run(sql<Array<{ at: Date; from_status: StoreStatus; to_status: StoreStatus; admin_name: string | null; reason: string; message: string | null }>>`SELECT * FROM admin_tenant_status_history(${storeId})`),
        run(sql<Array<{ fingerprint: string; kind: string; message: string; count: number; last_at: Date; app_version: string | null }>>`SELECT * FROM admin_tenant_errors(${storeId})`),
      ])
      return {
        tenant: { ...toTenantRow(h), address: h.address, statusMessage: h.status_message, statusChangedAt: iso(h.status_changed_at) as string, readOnlySince: iso(h.read_only_since), lastEventAt: iso(h.last_event_at) },
        staff: staff.map((s) => ({ name: s.name, phoneMasked: s.phone_masked, role: s.role, active: s.active, createdAt: iso(s.created_at) as string })),
        devices: devices.map((d) => ({ code: d.code, createdAt: iso(d.created_at) as string })),
        statusHistory: history.map((e) => ({ at: iso(e.at) as string, fromStatus: e.from_status, toStatus: e.to_status, adminName: e.admin_name, reason: e.reason, message: e.message })),
        recentErrors: errors.map((e) => ({ fingerprint: e.fingerprint, kind: e.kind, message: e.message, count: e.count, lastAt: iso(e.last_at) as string, appVersion: e.app_version })),
      }
    },
    async revealPhones(storeId) {
      try {
        return await run(sql<Array<{ name: string; role: "owner" | "staff"; phone: string }>>`SELECT * FROM admin_tenant_phones(${storeId})`)
      } catch (err) {
        if (err instanceof DomainError && err.code === "not_found") return null
        throw err
      }
    },
    async changeTenantStatus({ storeId, action, adminId, reason, message }) {
      const rows = await run(sql<Array<{ from_status: StoreStatus; to_status: StoreStatus; changed_at: Date }>>`
        SELECT * FROM admin_tenant_set_status(${storeId}, ${action}, ${adminId}, ${reason}, ${message})`)
      const r = rows[0]!
      return { fromStatus: r.from_status, toStatus: r.to_status, changedAt: iso(r.changed_at) as string }
    },
    async listNotes(storeId) {
      try {
        return (await run(sql<NoteRow[]>`SELECT * FROM admin_tenant_notes(${storeId})`)).map(toNote)
      } catch (err) {
        if (err instanceof DomainError && err.code === "not_found") return null
        throw err
      }
    },
    async addNote(storeId, adminId, body, tags) {
      try {
        const rows = await run(sql<NoteRow[]>`SELECT * FROM admin_tenant_note_add(${storeId}, ${adminId}, ${body}, ${tags}::text[])`)
        return toNote(rows[0]!)
      } catch (err) {
        if (err instanceof DomainError && err.code === "not_found") return null
        throw err
      }
    },
    async listAudit(q) {
      const before = decodeAuditCursor(q.cursor)
      const rows = await run(sql<Array<{
        id: string; at: Date; admin_id: string | null; admin_name: string | null; actor: string; action: string; outcome: AuditRowDto["outcome"]
        target_type: string | null; target_id: string | null; store_id: string | null; reason: string | null; before: unknown; after: unknown; ip: string | null; request_id: string | null
      }>>`
        SELECT * FROM admin_audit_list(${q.action ?? null}, ${q.outcome ?? null}, ${q.adminId ?? null}, ${q.storeId ?? null}, ${q.from ?? null}, ${q.to ?? null}, ${before}, ${q.limit + 1})`)
      const page = rows.slice(0, q.limit)
      return {
        rows: page.map((r): AuditRowDto => ({
          id: Number(r.id), at: iso(r.at) as string, adminId: r.admin_id, adminName: r.admin_name, actor: r.actor, action: r.action, outcome: r.outcome,
          targetType: r.target_type, targetId: r.target_id, storeId: r.store_id, reason: r.reason, before: r.before ?? null, after: r.after ?? null,
          ip: r.ip, requestId: r.request_id,
        })),
        nextCursor: rows.length > q.limit ? String(page[page.length - 1]!.id) : null,
      }
    },

    // ---- health (A2): db/migrations/014
    async healthSync(q) {
      const rows = await run(sql<Array<{ id: string; name: string; status: StoreStatus; last_sync_at: Date | null; created_at: Date; hours_since: number; total: string }>>`
        SELECT * FROM admin_health_sync(${q.stuckHours}, ${q.limit})`)
      return {
        total: rows[0] ? Number(rows[0].total) : 0,
        tenants: rows.map((r) => ({ id: r.id, name: r.name, status: r.status, lastSyncAt: iso(r.last_sync_at), createdAt: iso(r.created_at) as string, hoursSinceSync: r.hours_since })),
      }
    },
    async listClientErrors(q) {
      const rows = await run(sql<Array<{
        fingerprint: string; kind: string; message: string; path: string | null; app_version: string | null; count: number; first_at: Date; last_at: Date
        store_id: string | null; status: "open" | "resolved" | "ignored"; note: string | null
      }>>`SELECT * FROM admin_health_errors(${q.status}, ${q.limit})`)
      return rows.map((r) => ({
        fingerprint: r.fingerprint, kind: r.kind, message: r.message, path: r.path, appVersion: r.app_version, count: r.count,
        firstAt: iso(r.first_at) as string, lastAt: iso(r.last_at) as string, firstStoreId: r.store_id, status: r.status, note: r.note,
      }))
    },
    async setErrorTriage({ fingerprint, status, note, adminId }) {
      try {
        const rows = await run(sql<Array<{ fingerprint: string; status: "open" | "resolved" | "ignored"; note: string | null; updated_at: Date }>>`
          SELECT * FROM admin_error_triage_set(${fingerprint}, ${status}, ${note}, ${adminId})`)
        const r = rows[0]!
        return { fingerprint: r.fingerprint, status: r.status, note: r.note, updatedAt: iso(r.updated_at) as string }
      } catch (err) {
        if (err instanceof DomainError && err.code === "not_found") return null
        throw err
      }
    },
    async negativeStock(q) {
      const rows = await run(sql<Array<{ id: string; name: string; status: StoreStatus; batches: string; units_short: string; total: string }>>`
        SELECT * FROM admin_health_negative_stock(${q.limit})`)
      return {
        total: rows[0] ? Number(rows[0].total) : 0,
        tenants: rows.map((r) => ({ id: r.id, name: r.name, status: r.status, batches: Number(r.batches), unitsShort: Number(r.units_short) })),
      }
    },
    async dashboard(stuckHours) {
      const rows = await run(sql<Array<{ by_status: Record<string, number>; stuck_sync: string; new_errors: string; negative_tenants: string; signups_today: string }>>`
        SELECT * FROM admin_dashboard(${stuckHours})`)
      const r = rows[0]!
      return {
        tenantsByStatus: r.by_status, stuckSync: Number(r.stuck_sync), newErrors: Number(r.new_errors),
        negativeStockTenants: Number(r.negative_tenants), signupsToday: Number(r.signups_today), stuckHours,
      }
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
