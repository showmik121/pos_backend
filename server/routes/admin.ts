import { verifyAdminToken } from "../../src/auth/admin-token.js"
import { ADMIN_POLICY, ADMIN_ROUTE_IDS, adminContract, type AdminRouteId, type RouteContract } from "../../src/contract/admin-api.js"
import type { AdminSession, AuditEntry } from "../../src/db/admin.js"
import { can, requiresStepUp } from "../../src/domain/admin-permissions.js"
import { DomainError } from "../../src/domain/errors.js"
import type { Result } from "../http.js"
import { adminHandlers, type AdminCtx, type AuditExtra } from "./admin-handlers.js"

// /v1/admin dispatcher. EVERY admin route goes through here, in this order:
//   1. token (own secret + audience)  2. live DB session (idle/absolute/revoked/active)  3. per-admin rate limit
//   4. permission matrix  5. step-up  6. body validation (contract schema)  7. handler  8. AUDIT
// The route table is the contract (src/contract/admin-api.ts): there is no way to add a route without declaring
// whether it mutates, and every mutating route writes an audit row, including denied attempts (acceptance 1 and 9).

const MAX_BODY = 16 * 1024
const REQUEST_LIMIT = { max: 300, window: 60 }
// Before any session exists a caller is anyone on the internet. Their traffic is bounded per address BEFORE any audit write,
// and the denial rows they cause are budgeted so they cannot fill the append-only (never purgeable) audit table.
const PRE_AUTH_LIMIT = { max: 300, window: 60 }
const ANON_AUDIT_IP = { max: 20, window: 60 * 60 }
const ANON_AUDIT_ALL = { max: 500, window: 60 * 60 }
const AUDIT_TARGET_MAX = 120 // attacker-chosen text (e.g. a login email) is clipped before it is stored forever
const DENIED_CODES = new Set(["forbidden", "step_up_required", "unauthorized", "invalid_credentials", "invalid_code", "too_many_attempts", "enrollment_required"])

interface Compiled {
  id: AdminRouteId
  contract: RouteContract
  regex: RegExp
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
export const ADMIN_ROUTES: readonly Compiled[] = ADMIN_ROUTE_IDS.map((id) => {
  const contract: RouteContract = adminContract[id]
  return { id, contract, regex: new RegExp(`^${contract.path.replace(":id", `(${UUID})`)}$`) }
})

export interface AdminRequestInfo {
  req: Request
  /** path after /v1/admin, e.g. "/auth/login" */
  path: string
  ctx: AdminCtx
  requestId: string | null
}

const unauthorized = () => new DomainError("unauthorized", "Sign in again.")

async function authenticate(info: AdminRequestInfo, level: "pending" | "session"): Promise<AdminSession> {
  const header = info.req.headers.get("authorization") ?? ""
  const claims = header.startsWith("Bearer ")
    ? verifyAdminToken(header.slice(7), info.ctx.jwtSecret, level === "pending" ? "admin-pending" : "admin", { now: info.ctx.now() })
    : null
  if (!claims) throw unauthorized()
  const idle = level === "pending" ? ADMIN_POLICY.pendingSeconds : ADMIN_POLICY.idleSeconds
  const session = await info.ctx.repo.touchSession(claims.sid, idle)
  // the token's subject must own the session, and the stage must match what the route needs
  if (!session || session.adminId !== claims.sub || session.stage !== (level === "pending" ? "pending" : "active")) throw unauthorized()
  if (!(await info.ctx.repo.throttle(`req:${session.adminId}`, REQUEST_LIMIT.max, REQUEST_LIMIT.window))) {
    throw new DomainError("too_many_attempts", "Too many requests. Slow down.")
  }
  return session
}

// Failures with no valid session may write a bounded number of audit rows per address and overall (successes never go through this).
async function withinAnonAuditBudget(ctx: AdminCtx): Promise<boolean> {
  const perIp = ctx.ip === null || (await ctx.repo.throttle(`audit:anon:${ctx.ip}`, ANON_AUDIT_IP.max, ANON_AUDIT_IP.window))
  return perIp && (await ctx.repo.throttle("audit:anon:all", ANON_AUDIT_ALL.max, ANON_AUDIT_ALL.window))
}

async function parseBody(req: Request, contract: RouteContract): Promise<unknown> {
  let raw: unknown = {}
  if (contract.method !== "GET") {
    const text = await req.text()
    if (text.length > MAX_BODY) throw new DomainError("payload_too_large", "Request is too large.")
    try {
      raw = text ? JSON.parse(text) : {}
    } catch {
      throw new DomainError("invalid_json", "Request body is not valid JSON.")
    }
  }
  const parsed = contract.request.safeParse(raw)
  if (!parsed.success) {
    // field paths and messages only, never the submitted values (they may contain passwords)
    throw new DomainError("invalid_input", "Request is not valid.", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    })
  }
  return parsed.data
}

export async function adminRoute(info: AdminRequestInfo): Promise<Result> {
  const { req, path, ctx } = info
  const route = ADMIN_ROUTES.find((r) => r.contract.method === req.method && r.regex.test(path))
  if (!route) throw new DomainError("not_found", "Not found.")
  const { contract, id } = route
  const params = { id: route.regex.exec(path)?.[1] }

  // bounded per address before anything is written (deliberately not audited: it is the flood guard itself)
  if (ctx.ip && !(await ctx.repo.throttle(`pre:${ctx.ip}`, PRE_AUTH_LIMIT.max, PRE_AUTH_LIMIT.window))) {
    throw new DomainError("too_many_attempts", "Too many requests. Slow down.")
  }

  let session: AdminSession | null = null
  let extra: AuditExtra = {}
  const audit = async (outcome: AuditEntry["outcome"]) => {
    if (!contract.mutating) return
    // no valid session = anyone on the internet: their failures are budgeted, their successes (a real login) never are
    if (outcome !== "ok" && session === null && !(await withinAnonAuditBudget(ctx))) return
    const row: AuditEntry = {
      adminId: session?.adminId ?? null,
      actor: "admin",
      action: contract.audit as string,
      targetType: params.id ? "admin" : null,
      targetId: params.id ?? null,
      ...extra,
      ...(extra.adminId !== undefined ? { adminId: extra.adminId } : {}),
      ip: ctx.ip,
      ua: ctx.ua,
      outcome,
      requestId: info.requestId,
    }
    await ctx.repo.appendAudit({ ...row, targetId: row.targetId ? row.targetId.slice(0, AUDIT_TARGET_MAX) : row.targetId })
  }

  let applied = false // the handler already committed its change: a later failure must not be recorded as "the action failed"
  try {
    if (contract.auth !== "none") session = await authenticate(info, contract.auth)
    if (contract.action) {
      if (!can(session!.role, contract.action)) throw new DomainError("forbidden", "Your role cannot do this.")
      if (requiresStepUp(contract.action) && !(session!.stepUpUntil && Date.parse(session!.stepUpUntil) > ctx.now())) {
        throw new DomainError("step_up_required", "Confirm your password and 2FA code to continue.")
      }
    }
    const body = await parseBody(req, contract)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (adminHandlers[id] as any)({ ctx, body, params, session })
    extra = result.audit ?? {}
    applied = true
    await audit("ok") // a failed audit write fails the request loudly: an unaudited admin action must not look successful
    return { status: contract.status, body: result.body }
  } catch (err) {
    if (applied) {
      // The change is committed but its audit row could not be written. Writing an "error" row now would make the immutable trail
      // claim the action failed. Say so in the log instead (request id = the key to reconcile by hand); the 500 tells the caller.
      console.error(`admin action APPLIED but audit write failed: ${contract.audit as string} request=${info.requestId}`, err)
      throw err
    }
    // handlers may attach audit details (e.g. the attempted email) to the error they throw
    const attached = err instanceof DomainError ? (err as DomainError & { audit?: AuditExtra }).audit : undefined
    if (attached) extra = attached
    const outcome: AuditEntry["outcome"] = err instanceof DomainError && DENIED_CODES.has(err.code) ? "denied" : "error"
    try {
      await audit(outcome)
    } catch (auditErr) {
      console.error("admin audit write failed", auditErr) // never mask the original error
    }
    throw err
  }
}
