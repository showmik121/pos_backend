import { z } from "zod"
import type { AdminAction } from "../domain/admin-permissions.js"

// THE single source of truth for /v1/admin (PRD §17.9, contract-first).
//  - server/routes/admin*.ts type their handlers from this table, so a route cannot exist without a contract entry
//  - tests/unit/admin-api.test.ts validates real responses against these schemas (the "EVERY route" registry test)
//  - pos_admin (A1) copies this file; a hash lock to pin the two copies is an A1 deliverable (not built yet), like the shop fixtures.lock
// Money is integer poisha and timestamps are ISO-8601 UTC strings everywhere (none appear in A0).

export const AdminRoleSchema = z.enum(["super", "support", "finance", "viewer"])

export const AdminSummarySchema = z.object({
  id: z.uuid(),
  email: z.string(),
  name: z.string(),
  role: AdminRoleSchema,
  active: z.boolean(),
  enrolled: z.boolean(),
  mustReenroll: z.boolean(),
  lastLoginAt: z.string().nullable(),
  createdAt: z.string(),
})
export type AdminSummary = z.infer<typeof AdminSummarySchema>

export const ErrorEnvelopeSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.record(z.string(), z.unknown()).nullable() }),
})

const Code6 = z.string().regex(/^\d{6}$/, "6-digit code")
const Email = z.string().trim().toLowerCase().min(3).max(254).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "email")
const Reason = z.string().trim().min(1).max(1000).optional()
const Empty = z.object({}).strict()

export type AuthLevel = "none" | "pending" | "session"

export interface RouteContract {
  method: "GET" | "POST" | "PATCH"
  /** relative to /v1/admin; ":id" is a UUID, ":fingerprint" is 32 lowercase hex chars */
  path: string
  auth: AuthLevel
  /** permission-matrix action, or null for routes that only need a session (or none) */
  action: AdminAction | null
  /** every non-GET route is mutating and MUST write an audit row (acceptance 9) */
  mutating: boolean
  /** audit action name; required when mutating */
  audit: string | null
  /** what `:id` refers to; drives the default audit target, so a denied attempt on a tenant still records which tenant */
  target?: "admin" | "tenant" | "client_error"
  // a path may also carry `:fingerprint` (32 hex chars, a client_errors row); it is the audit target of that route, denied attempts included
  /** success status code */
  status: number
  request: z.ZodType
  response: z.ZodType
}

// generic so the extra fields (recoveryCodes on enrol-confirm) keep their type for the UI client
const SessionResponse = <T extends z.ZodRawShape = Record<never, never>>(extra?: T) =>
  z.object({ token: z.string(), admin: AdminSummarySchema, expiresInSeconds: z.number().int().positive(), ...(extra ?? ({} as T)) })

// ---------------------------------------------------------------- tenants (A1)
// Metadata and aggregates only (PRD §6): never event payloads, customers, sales, cost prices or password hashes.
// Phones are masked everywhere except the audited reveal-phone route.
export const StoreStatusSchema = z.enum(["trial", "active", "grace", "read_only", "suspended", "pending_deletion", "deleted", "cancelled"])
export const StoreKindSchema = z.enum(["pharmacy", "cosmetics", "other"])

export const TenantRowSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: StoreKindSchema,
  ownerName: z.string().nullable(),
  ownerPhoneMasked: z.string().nullable(),
  createdAt: z.string(),
  status: StoreStatusSchema,
  grandfathered: z.boolean(),
  trialEndsAt: z.string().nullable(),
  lastSyncAt: z.string().nullable(),
  deviceCount: z.number().int().nonnegative(),
  staffCount: z.number().int().nonnegative(),
})
export type TenantRow = z.infer<typeof TenantRowSchema>

export const TenantListQuerySchema = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  status: StoreStatusSchema.optional(),
  kind: StoreKindSchema.optional(),
  /** "not synced for N days": a store that never synced counts as stale */
  noSyncDays: z.coerce.number().int().min(1).max(3650).optional(),
  sort: z.enum(["created", "name", "lastSync", "status"]).default("created"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** opaque; produced by the previous page */
  cursor: z.string().max(200).optional(),
})
export type TenantListQuery = z.infer<typeof TenantListQuerySchema>

export const TenantDetailSchema = z.object({
  tenant: TenantRowSchema.extend({
    address: z.string().nullable(),
    statusMessage: z.string().nullable(),
    statusChangedAt: z.string(),
    readOnlySince: z.string().nullable(),
    lastEventAt: z.string().nullable(),
  }),
  staff: z.array(z.object({ name: z.string(), phoneMasked: z.string(), role: z.enum(["owner", "staff"]), active: z.boolean(), createdAt: z.string() })),
  devices: z.array(z.object({ code: z.string(), createdAt: z.string() })),
  statusHistory: z.array(
    z.object({ at: z.string(), fromStatus: StoreStatusSchema, toStatus: StoreStatusSchema, adminName: z.string().nullable(), reason: z.string(), message: z.string().nullable() }),
  ),
  recentErrors: z.array(z.object({ fingerprint: z.string(), kind: z.string(), message: z.string(), count: z.number().int(), lastAt: z.string(), appVersion: z.string().nullable() })),
})
export type TenantDetail = z.infer<typeof TenantDetailSchema>

const StatusReason = z.string().trim().min(3).max(1000)
// shown to the shop owner (Bangla) in the app banner; optional, the shop app falls back to its standard text
const OwnerMessage = z.string().trim().min(1).max(500).optional()
export const StatusChangeResultSchema = z.object({ fromStatus: StoreStatusSchema, toStatus: StoreStatusSchema, changedAt: z.string() })
export type StatusChangeResult = z.infer<typeof StatusChangeResultSchema>

export const TenantNoteSchema = z.object({ id: z.number().int(), at: z.string(), adminName: z.string().nullable(), body: z.string(), tags: z.array(z.string()) })
export type TenantNote = z.infer<typeof TenantNoteSchema>

export const AuditRowSchema = z.object({
  id: z.number().int(),
  at: z.string(),
  adminId: z.uuid().nullable(),
  adminName: z.string().nullable(),
  actor: z.string(),
  action: z.string(),
  outcome: z.enum(["ok", "denied", "error", "started"]),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  storeId: z.uuid().nullable(),
  reason: z.string().nullable(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  ip: z.string().nullable(),
  requestId: z.string().nullable(),
})
export type AuditRowDto = z.infer<typeof AuditRowSchema>

export const AuditListQuerySchema = z.object({
  action: z.string().trim().min(1).max(80).optional(),
  outcome: z.enum(["ok", "denied", "error", "started"]).optional(),
  adminId: z.uuid().optional(),
  storeId: z.uuid().optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** opaque; produced by the previous page */
  cursor: z.string().max(40).optional(),
})
export type AuditListQuery = z.infer<typeof AuditListQuerySchema>

// ---------------------------------------------------------------- health (A2)
// Metadata and counts only. Negative stock is reported as batch/unit COUNTS: never product names, prices or cost.
export const ErrorStatusSchema = z.enum(["open", "resolved", "ignored"])
export type ErrorStatus = z.infer<typeof ErrorStatusSchema>

/** a tenant with no successful sync for this many hours is "stuck": the default of the sync-health list and the dashboard tile */
export const DEFAULT_STUCK_HOURS = 24
export const SyncHealthQuerySchema = z.object({
  /** a store that never synced counts from its creation */
  stuckHours: z.coerce.number().int().min(1).max(8760).default(DEFAULT_STUCK_HOURS),
  limit: z.coerce.number().int().min(1).max(200).default(100),
})
export type SyncHealthQuery = z.infer<typeof SyncHealthQuerySchema>
export const SyncHealthRowSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  status: StoreStatusSchema,
  lastSyncAt: z.string().nullable(),
  createdAt: z.string(),
  hoursSinceSync: z.number().int().nonnegative(),
})
export type SyncHealthRow = z.infer<typeof SyncHealthRowSchema>

export const ClientErrorsQuerySchema = z.object({
  status: z.enum(["open", "resolved", "ignored", "all"]).default("open"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
export type ClientErrorsQuery = z.infer<typeof ClientErrorsQuerySchema>
// client_errors keeps one row per fingerprint and only the FIRST reporting store, so "affected tenants" cannot be counted (ADR 0009).
export const ClientErrorRowSchema = z.object({
  fingerprint: z.string(),
  kind: z.string(),
  message: z.string(),
  path: z.string().nullable(),
  appVersion: z.string().nullable(),
  count: z.number().int().nonnegative(),
  firstAt: z.string(),
  lastAt: z.string(),
  firstStoreId: z.uuid().nullable(),
  status: ErrorStatusSchema,
  note: z.string().nullable(),
})
export type ClientErrorRow = z.infer<typeof ClientErrorRowSchema>

// the fingerprint is in the PATH (so even a denied attempt audits which error it aimed at), the decision is in the body.
// Omitting `note` clears any earlier note: the note belongs to the latest decision.
export const ErrorTriageRequestSchema = z.object({
  status: ErrorStatusSchema,
  note: z.string().trim().min(1).max(500).optional(),
})
export const ErrorTriageResultSchema = z.object({ fingerprint: z.string(), status: ErrorStatusSchema, note: z.string().nullable(), updatedAt: z.string() })
export type ErrorTriageResult = z.infer<typeof ErrorTriageResultSchema>

export const NegativeStockQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) })
export type NegativeStockQuery = z.infer<typeof NegativeStockQuerySchema>
export const NegativeStockRowSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  status: StoreStatusSchema,
  /** number of live batches below zero */
  batches: z.number().int().positive(),
  /** total pieces short across those batches (positive number) */
  unitsShort: z.number().int().positive(),
})
export type NegativeStockRow = z.infer<typeof NegativeStockRowSchema>

export const DashboardSchema = z.object({
  tenantsByStatus: z.record(z.string(), z.number().int().nonnegative()),
  stuckSync: z.number().int().nonnegative(),
  /** open (not resolved/ignored) client errors seen in the last 24 hours */
  newErrors: z.number().int().nonnegative(),
  negativeStockTenants: z.number().int().nonnegative(),
  /** signups since midnight Asia/Dhaka */
  signupsToday: z.number().int().nonnegative(),
  /** the stuck-sync window these counts used */
  stuckHours: z.number().int().positive(),
})
export type Dashboard = z.infer<typeof DashboardSchema>

export const adminContract = {
  "auth.login": {
    method: "POST", path: "/auth/login", auth: "none", action: null, mutating: true, audit: "admin.login", status: 200,
    request: z.object({ email: Email, password: z.string().min(1).max(256) }),
    response: z.object({ stage: z.enum(["2fa", "enroll"]), pendingToken: z.string(), expiresInSeconds: z.number().int().positive() }),
  },
  "auth.2fa": {
    method: "POST", path: "/auth/2fa", auth: "pending", action: null, mutating: true, audit: "admin.2fa", status: 200,
    request: z
      .object({ code: Code6.optional(), recoveryCode: z.string().trim().min(5).max(32).optional() })
      .refine((b) => (b.code === undefined) !== (b.recoveryCode === undefined), "send exactly one of code or recoveryCode"),
    response: SessionResponse(),
  },
  "auth.enroll-start": {
    method: "POST", path: "/auth/2fa/enroll-start", auth: "pending", action: null, mutating: true, audit: "admin.2fa.enroll_start", status: 200,
    request: Empty,
    response: z.object({ secret: z.string(), otpauthUri: z.string() }),
  },
  "auth.enroll-confirm": {
    method: "POST", path: "/auth/2fa/enroll-confirm", auth: "pending", action: null, mutating: true, audit: "admin.2fa.enroll_confirm", status: 200,
    request: z.object({ code: Code6 }),
    response: SessionResponse({ recoveryCodes: z.array(z.string()).length(10) }),
  },
  "auth.step-up": {
    method: "POST", path: "/auth/step-up", auth: "session", action: null, mutating: true, audit: "admin.step_up", status: 200,
    request: z.object({ password: z.string().min(1).max(256), code: Code6 }),
    response: z.object({ stepUpUntil: z.string() }),
  },
  "auth.logout": {
    method: "POST", path: "/auth/logout", auth: "session", action: null, mutating: true, audit: "admin.logout", status: 200,
    request: Empty,
    response: z.object({ ok: z.literal(true) }),
  },
  me: {
    method: "GET", path: "/me", auth: "session", action: null, mutating: false, audit: null, status: 200,
    request: Empty,
    response: z.object({ admin: AdminSummarySchema, session: z.object({ stepUpUntil: z.string().nullable() }) }),
  },
  "admins.list": {
    method: "GET", path: "/admins", auth: "session", action: "admins.list", mutating: false, audit: null, status: 200,
    request: Empty,
    response: z.object({ admins: z.array(AdminSummarySchema) }),
  },
  "admins.create": {
    method: "POST", path: "/admins", auth: "session", action: "admins.create", mutating: true, audit: "admin.create", status: 201,
    request: z.object({ email: Email, name: z.string().trim().min(1).max(120), role: AdminRoleSchema, password: z.string().min(12).max(128), reason: Reason }),
    response: z.object({ admin: AdminSummarySchema }),
  },
  "admins.update": {
    method: "PATCH", path: "/admins/:id", auth: "session", action: "admins.update", mutating: true, audit: "admin.update", status: 200,
    request: z
      .object({ role: AdminRoleSchema.optional(), active: z.boolean().optional(), reason: Reason })
      .refine((b) => b.role !== undefined || b.active !== undefined, "role or active required"),
    response: z.object({ admin: AdminSummarySchema }),
  },
  "admins.reset2fa": {
    method: "POST", path: "/admins/:id/reset-2fa", auth: "session", action: "admins.reset2fa", mutating: true, audit: "admin.reset_2fa", status: 200,
    request: z.object({ reason: Reason }),
    response: z.object({ ok: z.literal(true) }),
  },
  // §17.2: a super admin resets another admin's password; the reset also clears 2FA, so the admin must re-enrol at next login
  "admins.resetPassword": {
    method: "POST", path: "/admins/:id/reset-password", auth: "session", action: "admins.resetPassword", mutating: true, audit: "admin.reset_password", status: 200,
    request: z.object({ password: z.string().min(12).max(128), reason: Reason }),
    response: z.object({ ok: z.literal(true) }),
  },
  // ---- tenants and audit viewer (A1)
  "tenants.list": {
    method: "GET", path: "/tenants", auth: "session", action: "tenant.read", mutating: false, audit: null, status: 200,
    request: TenantListQuerySchema,
    response: z.object({ tenants: z.array(TenantRowSchema), total: z.number().int().nonnegative(), nextCursor: z.string().nullable() }),
  },
  "tenants.get": {
    method: "GET", path: "/tenants/:id", auth: "session", action: "tenant.read", target: "tenant", mutating: false, audit: null, status: 200,
    request: Empty,
    response: TenantDetailSchema,
  },
  "tenants.revealPhone": {
    method: "POST", path: "/tenants/:id/reveal-phone", auth: "session", action: "tenant.reveal_phone", target: "tenant", mutating: true, audit: "admin.tenant.reveal_phone", status: 200,
    request: z.object({ reason: StatusReason }),
    response: z.object({ phones: z.array(z.object({ name: z.string(), role: z.enum(["owner", "staff"]), phone: z.string() })) }),
  },
  "tenants.suspend": {
    method: "POST", path: "/tenants/:id/suspend", auth: "session", action: "tenant.suspend", target: "tenant", mutating: true, audit: "admin.tenant.suspend", status: 200,
    request: z.object({ reason: StatusReason, message: OwnerMessage }),
    response: StatusChangeResultSchema,
  },
  "tenants.readOnly": {
    method: "POST", path: "/tenants/:id/read-only", auth: "session", action: "tenant.suspend", target: "tenant", mutating: true, audit: "admin.tenant.read_only", status: 200,
    request: z.object({ reason: StatusReason, message: OwnerMessage }),
    response: StatusChangeResultSchema,
  },
  "tenants.reactivate": {
    method: "POST", path: "/tenants/:id/reactivate", auth: "session", action: "tenant.suspend", target: "tenant", mutating: true, audit: "admin.tenant.reactivate", status: 200,
    request: z.object({ reason: StatusReason }),
    response: StatusChangeResultSchema,
  },
  "tenants.notes.list": {
    method: "GET", path: "/tenants/:id/notes", auth: "session", action: "tenant.read", target: "tenant", mutating: false, audit: null, status: 200,
    request: Empty,
    response: z.object({ notes: z.array(TenantNoteSchema) }),
  },
  "tenants.notes.add": {
    method: "POST", path: "/tenants/:id/notes", auth: "session", action: "tenant.notes.write", target: "tenant", mutating: true, audit: "admin.tenant.note_add", status: 201,
    request: z.object({
      body: z.string().trim().min(1).max(2000),
      tags: z.array(z.string().trim().toLowerCase().min(1).max(30).regex(/^[a-z0-9][a-z0-9 _-]*$/, "tag")).max(10).default([]),
    }),
    response: z.object({ note: TenantNoteSchema }),
  },
  "audit.list": {
    method: "GET", path: "/audit", auth: "session", action: "audit.read", mutating: false, audit: null, status: 200,
    request: AuditListQuerySchema,
    response: z.object({ rows: z.array(AuditRowSchema), nextCursor: z.string().nullable() }),
  },
  // ---- health and dashboard (A2)
  "health.sync": {
    method: "GET", path: "/health/sync", auth: "session", action: "health.read", mutating: false, audit: null, status: 200,
    request: SyncHealthQuerySchema,
    response: z.object({ tenants: z.array(SyncHealthRowSchema), total: z.number().int().nonnegative(), stuckHours: z.number().int().positive() }),
  },
  "health.errors": {
    method: "GET", path: "/health/errors", auth: "session", action: "health.read", mutating: false, audit: null, status: 200,
    request: ClientErrorsQuerySchema,
    response: z.object({ errors: z.array(ClientErrorRowSchema) }),
  },
  "health.errors.triage": {
    method: "POST", path: "/health/errors/:fingerprint/triage", auth: "session", action: "health.triage", target: "client_error", mutating: true, audit: "admin.health.error_triage", status: 200,
    request: ErrorTriageRequestSchema,
    response: ErrorTriageResultSchema,
  },
  "health.negativeStock": {
    method: "GET", path: "/health/negative-stock", auth: "session", action: "health.read", mutating: false, audit: null, status: 200,
    request: NegativeStockQuerySchema,
    response: z.object({ tenants: z.array(NegativeStockRowSchema), total: z.number().int().nonnegative() }),
  },
  "dashboard.get": {
    method: "GET", path: "/dashboard", auth: "session", action: "health.read", mutating: false, audit: null, status: 200,
    request: Empty,
    response: DashboardSchema,
  },
} as const satisfies Record<string, RouteContract>

export type AdminRouteId = keyof typeof adminContract
export type RequestOf<K extends AdminRouteId> = z.infer<(typeof adminContract)[K]["request"]>
export type ResponseOf<K extends AdminRouteId> = z.infer<(typeof adminContract)[K]["response"]>

export const ADMIN_ROUTE_IDS = Object.keys(adminContract) as AdminRouteId[]

// Session policy (PRD A-3). Idle is enforced in the database on every request; the absolute limit is the session row's expires_at.
export const ADMIN_POLICY = {
  idleSeconds: 30 * 60,
  absoluteSeconds: 8 * 60 * 60,
  pendingSeconds: 5 * 60,
  stepUpSeconds: 5 * 60,
} as const
