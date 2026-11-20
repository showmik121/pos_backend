import { signAdminToken } from "../../src/auth/admin-token.js"
import { decryptSecret, encryptSecret, generateRecoveryCodes, hashRecoveryCode } from "../../src/auth/admin-crypto.js"
import { dummyHash, hashPassword, verifyPassword } from "../../src/auth/password.js"
import { loginEmailBucket, loginIpBucket, loginPairBucket } from "../../src/auth/admin-throttle-keys.js"
import { generateTotpSecret, otpauthUri, verifyTotp } from "../../src/auth/totp.js"
import { ADMIN_POLICY, type AdminRouteId, type RequestOf, type ResponseOf } from "../../src/contract/admin-api.js"
import type { AdminRecord, AdminRepo, AdminSession, AdminSummary, AuditEntry } from "../../src/db/admin.js"
import { DomainError } from "../../src/domain/errors.js"

// Handlers for /v1/admin. Typed from the contract: a route cannot exist without a contract entry, and the
// dispatcher (admin.ts) does auth, permission, step-up, body validation and AUDIT around every one of these.
// Admin-facing messages are English (PRD Q5); the Bangla messages are only for shop owners.

export interface AdminCtx {
  repo: AdminRepo
  jwtSecret: string
  totpEncKey: string
  issuer: string
  now(): number
  ip: string | null
  ua: string | null
}

export interface HandlerArgs<K extends AdminRouteId> {
  ctx: AdminCtx
  body: RequestOf<K>
  params: { id?: string }
  /** null only for auth: "none" routes */
  session: AdminSession | null
}

/** What the handler adds to its audit row (never secrets: no passwords, TOTP secrets or recovery codes). */
export type AuditExtra = Partial<Pick<AuditEntry, "adminId" | "targetType" | "targetId" | "reason" | "before" | "after">>
export interface HandlerResult<K extends AdminRouteId> {
  body: ResponseOf<K>
  audit?: AuditExtra
}
export type Handlers = { [K in AdminRouteId]: (a: HandlerArgs<K>) => Promise<HandlerResult<K>> }

const LOGIN_PAIR = { max: 5, window: 15 * 60 }
// Per-email bucket is only a ceiling for spread-out attacks (same idea as the shop's LOGIN_PHONE). The hard lockout is email+IP:
// a low email-only limit would let anyone who knows an admin's email keep that admin out of the panel.
const LOGIN_EMAIL = { max: 50, window: 15 * 60 }
const LOGIN_IP = { max: 20, window: 15 * 60 }
const SECOND_FACTOR = { max: 5, window: 5 * 60 } // per admin: wrong codes, replays, step-up attempts
const ENROLL = { max: 10, window: 15 * 60 }

const tooMany = () => new DomainError("too_many_attempts", "Too many attempts. Try again later.")
const badCredentials = () => new DomainError("invalid_credentials", "Email or password is incorrect.")
const badCode = () => new DomainError("invalid_code", "The code is not valid.")

const summary = (a: AdminRecord): AdminSummary => ({
  id: a.id, email: a.email, name: a.name, role: a.role, active: a.active, enrolled: a.enrolled,
  mustReenroll: a.mustReenroll, lastLoginAt: a.lastLoginAt, createdAt: a.createdAt,
})

async function requireAdmin(ctx: AdminCtx, id: string): Promise<AdminRecord> {
  const a = await ctx.repo.getAdmin(id)
  if (!a || !a.active) throw new DomainError("unauthorized", "Sign in again.")
  return a
}

// Replaces the pending session with a full one. The absolute limit is the session row's expiry (8 h).
async function openSession(ctx: AdminCtx, admin: AdminRecord, pending: AdminSession) {
  await ctx.repo.revokeSession(pending.sessionId, "upgraded")
  await ctx.repo.recordLogin(admin.id)
  const sid = await ctx.repo.createSession(admin.id, "active", ADMIN_POLICY.absoluteSeconds, ctx.ip, ctx.ua)
  const token = signAdminToken({ sub: admin.id, sid }, "admin", ctx.jwtSecret, { ttlSeconds: ADMIN_POLICY.absoluteSeconds, now: ctx.now() })
  return { token, admin: summary({ ...admin, enrolled: true }), expiresInSeconds: ADMIN_POLICY.absoluteSeconds }
}

// One TOTP step is accepted once (replay guard is atomic in the database).
async function checkTotp(ctx: AdminCtx, admin: AdminRecord, code: string): Promise<number> {
  if (!admin.totpSecretEnc) throw new DomainError("enrollment_required", "Set up two-factor authentication first.")
  const step = verifyTotp(decryptSecret(admin.totpSecretEnc, ctx.totpEncKey), code, ctx.now())
  if (step === null || !(await ctx.repo.totpUseStep(admin.id, step))) throw badCode()
  return step
}

export const adminHandlers: Handlers = {
  async "auth.login"({ ctx, body }) {
    const { email, password } = body
    // ORDER MATTERS: the narrow per-address buckets go first and stop the request before it reaches the shared per-email bucket.
    // Otherwise one address could fill the email bucket with attempts its own limits already refused and lock the real admin out.
    // A missing address shares one "?" bucket (as the shop login does) instead of skipping the limit.
    const ip = ctx.ip ?? "?"
    const checks: Array<[string, { max: number; window: number }]> = [
      [loginPairBucket(email, ip), LOGIN_PAIR], [loginIpBucket(ip), LOGIN_IP], [loginEmailBucket(email), LOGIN_EMAIL],
    ]
    for (const [bucket, l] of checks) if (!(await ctx.repo.throttle(bucket, l.max, l.window))) throw tooMany()

    const admin = await ctx.repo.findAdminByEmail(email)
    const ok = await verifyPassword(password, admin?.passwordHash ?? (await dummyHash())) // same cost whether or not the account exists
    const ipAllowed = !admin || admin.allowedIps.length === 0 || (ctx.ip !== null && admin.allowedIps.includes(ctx.ip))
    if (!admin || !admin.active || !ok || !ipAllowed) {
      // the dispatcher reads `audit` off the error so failed logins are recorded with the attempted email
      throw Object.assign(badCredentials(), { audit: { adminId: admin?.id ?? null, targetType: "admin", targetId: email } satisfies AuditExtra })
    }
    await ctx.repo.throttleReset(loginEmailBucket(email))
    await ctx.repo.throttleReset(loginPairBucket(email, ip))

    const sid = await ctx.repo.createSession(admin.id, "pending", ADMIN_POLICY.pendingSeconds, ctx.ip, ctx.ua)
    const pendingToken = signAdminToken({ sub: admin.id, sid }, "admin-pending", ctx.jwtSecret, { ttlSeconds: ADMIN_POLICY.pendingSeconds, now: ctx.now() })
    return {
      body: { stage: admin.enrolled ? "2fa" : "enroll", pendingToken, expiresInSeconds: ADMIN_POLICY.pendingSeconds },
      audit: { adminId: admin.id, targetType: "admin", targetId: admin.id, after: { stage: admin.enrolled ? "2fa" : "enroll" } },
    }
  },

  async "auth.2fa"({ ctx, body, session }) {
    const pending = session!
    const admin = await requireAdmin(ctx, pending.adminId)
    if (!admin.enrolled) throw new DomainError("enrollment_required", "Set up two-factor authentication first.")
    if (!(await ctx.repo.throttle(`2fa:${admin.id}`, SECOND_FACTOR.max, SECOND_FACTOR.window))) throw tooMany()
    const audit: AuditExtra = { targetType: "admin", targetId: admin.id }
    if (body.recoveryCode !== undefined) {
      if (!(await ctx.repo.consumeRecovery(admin.id, hashRecoveryCode(body.recoveryCode, ctx.totpEncKey)))) throw badCode()
      audit.after = { method: "recovery_code", remainingCodes: admin.recoveryCodesHash.length - 1 }
    } else {
      await checkTotp(ctx, admin, body.code as string)
      audit.after = { method: "totp" }
    }
    await ctx.repo.throttleReset(`2fa:${admin.id}`)
    return { body: await openSession(ctx, admin, pending), audit }
  },

  async "auth.enroll-start"({ ctx, session }) {
    const admin = await requireAdmin(ctx, session!.adminId)
    if (admin.enrolled) throw new DomainError("already_enrolled", "Two-factor authentication is already set up.")
    if (!(await ctx.repo.throttle(`enroll:${admin.id}`, ENROLL.max, ENROLL.window))) throw tooMany()
    const secret = generateTotpSecret()
    if (!(await ctx.repo.totpBegin(admin.id, encryptSecret(secret, ctx.totpEncKey)))) {
      throw new DomainError("already_enrolled", "Two-factor authentication is already set up.")
    }
    return { body: { secret, otpauthUri: otpauthUri(secret, admin.email, ctx.issuer) }, audit: { targetType: "admin", targetId: admin.id } }
  },

  async "auth.enroll-confirm"({ ctx, body, session }) {
    const pending = session!
    const admin = await requireAdmin(ctx, pending.adminId)
    if (admin.enrolled) throw new DomainError("already_enrolled", "Two-factor authentication is already set up.")
    if (!admin.totpSecretEnc) throw new DomainError("enrollment_required", "Start setup first.")
    if (!(await ctx.repo.throttle(`2fa:${admin.id}`, SECOND_FACTOR.max, SECOND_FACTOR.window))) throw tooMany()
    const step = verifyTotp(decryptSecret(admin.totpSecretEnc, ctx.totpEncKey), body.code, ctx.now())
    if (step === null) throw badCode()
    const codes = generateRecoveryCodes()
    const hashes = codes.map((c) => hashRecoveryCode(c, ctx.totpEncKey))
    // bound to the exact secret the code was verified against: a concurrent re-begin cannot enrol the admin on an unchecked secret
    if (!(await ctx.repo.totpConfirm(admin.id, hashes, step, admin.totpSecretEnc))) throw new DomainError("already_enrolled", "Two-factor authentication is already set up.")
    await ctx.repo.throttleReset(`2fa:${admin.id}`)
    const opened = await openSession(ctx, admin, pending)
    // recovery codes are returned exactly once, here, and are not written to the audit log
    return { body: { ...opened, recoveryCodes: codes }, audit: { targetType: "admin", targetId: admin.id, after: { recoveryCodesIssued: codes.length } } }
  },

  async "auth.step-up"({ ctx, body, session }) {
    const s = session!
    const admin = await requireAdmin(ctx, s.adminId)
    if (!(await ctx.repo.throttle(`2fa:${admin.id}`, SECOND_FACTOR.max, SECOND_FACTOR.window))) throw tooMany()
    if (!(await verifyPassword(body.password, admin.passwordHash))) throw badCredentials()
    await checkTotp(ctx, admin, body.code)
    const until = await ctx.repo.stepUpSession(s.sessionId, ADMIN_POLICY.stepUpSeconds)
    if (!until) throw new DomainError("unauthorized", "Sign in again.")
    await ctx.repo.throttleReset(`2fa:${admin.id}`)
    return { body: { stepUpUntil: until }, audit: { targetType: "admin", targetId: admin.id } }
  },

  async "auth.logout"({ ctx, session }) {
    await ctx.repo.revokeSession(session!.sessionId, "logout")
    return { body: { ok: true as const }, audit: { targetType: "session", targetId: session!.sessionId } }
  },

  async me({ ctx, session }) {
    const admin = await requireAdmin(ctx, session!.adminId)
    return { body: { admin: summary(admin), session: { stepUpUntil: session!.stepUpUntil } } }
  },

  async "admins.list"({ ctx }) {
    return { body: { admins: await ctx.repo.listAdmins() } }
  },

  async "admins.create"({ ctx, body, session }) {
    const passwordHash = await hashPassword(body.password)
    const id = await ctx.repo.createAdmin({ email: body.email, name: body.name, role: body.role, passwordHash, totpSecretEnc: null, createdBy: session!.adminId })
    const created = await ctx.repo.getAdmin(id)
    return {
      body: { admin: summary(created!) },
      audit: { targetType: "admin", targetId: id, reason: body.reason ?? null, after: { email: body.email, role: body.role } },
    }
  },

  async "admins.update"({ ctx, body, params, session }) {
    const target = await ctx.repo.getAdmin(params.id!)
    if (!target) throw new DomainError("not_found", "Admin not found.")
    const role = body.role ?? target.role
    const active = body.active ?? target.active
    if (target.id === session!.adminId && (role !== target.role || active !== target.active)) {
      throw new DomainError("forbidden", "You cannot change your own role or active state.")
    }
    if (!(await ctx.repo.setRoleActive(target.id, role, active))) throw new DomainError("not_found", "Admin not found.")
    const updated = await ctx.repo.getAdmin(target.id)
    return {
      body: { admin: summary(updated!) },
      audit: { targetType: "admin", targetId: target.id, reason: body.reason ?? null, before: { role: target.role, active: target.active }, after: { role, active } },
    }
  },

  async "admins.resetPassword"({ ctx, body, params, session }) {
    const target = await ctx.repo.getAdmin(params.id!)
    if (!target) throw new DomainError("not_found", "Admin not found.")
    if (target.id === session!.adminId) throw new DomainError("forbidden", "Use the create-admin CLI to reset your own password.")
    const passwordHash = await hashPassword(body.password)
    // new password ends every session of that admin, and clearing 2FA forces re-enrolment at next login (§17.2)
    if (!(await ctx.repo.setPassword(target.id, passwordHash, true))) throw new DomainError("not_found", "Admin not found.")
    await ctx.repo.reset2fa(target.id)
    return {
      body: { ok: true as const },
      audit: { targetType: "admin", targetId: target.id, reason: body.reason ?? null, after: { passwordReset: true, enrolled: false, sessionsRevoked: true } },
    }
  },

  async "admins.reset2fa"({ ctx, body, params, session }) {
    const target = await ctx.repo.getAdmin(params.id!)
    if (!target) throw new DomainError("not_found", "Admin not found.")
    if (target.id === session!.adminId) throw new DomainError("forbidden", "Use the create-admin CLI to reset your own 2FA.")
    if (!(await ctx.repo.reset2fa(target.id))) throw new DomainError("not_found", "Admin not found.")
    return {
      body: { ok: true as const },
      audit: { targetType: "admin", targetId: target.id, reason: body.reason ?? null, before: { enrolled: target.enrolled }, after: { enrolled: false, sessionsRevoked: true } },
    }
  },
}
