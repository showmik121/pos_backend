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
  /** relative to /v1/admin; ":id" is a UUID */
  path: string
  auth: AuthLevel
  /** permission-matrix action, or null for routes that only need a session (or none) */
  action: AdminAction | null
  /** every non-GET route is mutating and MUST write an audit row (acceptance 9) */
  mutating: boolean
  /** audit action name; required when mutating */
  audit: string | null
  /** success status code */
  status: number
  request: z.ZodType
  response: z.ZodType
}

const SessionResponse = (extra: z.ZodRawShape = {}) =>
  z.object({ token: z.string(), admin: AdminSummarySchema, expiresInSeconds: z.number().int().positive(), ...extra })

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
