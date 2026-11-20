import { randomInt } from "node:crypto"
import { DomainError } from "../domain/errors.js"
import type { AdminRole } from "../domain/admin-permissions.js"
import type { AdminRepo } from "../db/admin.js"
import { encryptSecret } from "./admin-crypto.js"
import { loginEmailBucket } from "./admin-throttle-keys.js"
import { hashPassword } from "./password.js"
import { generateTotpSecret, otpauthUri } from "./totp.js"

// Break-glass bootstrap used by scripts/create-admin.ts (PRD §17.1, §17.2). It is the ONLY way to create the first super
// admin and to recover when the last super admin loses access. It runs locally with DATABASE_URL_UNPOOLED, is never
// reachable over HTTP, and writes an audit row with actor = "cli". The credentials it returns are for the operator's
// terminal ONLY: they are never logged, stored or written to the audit log.

export interface CliCredentials {
  adminId: string
  email: string
  password: string
  totpSecret: string
  otpauthUri: string
}

// no look-alike characters (0/O, 1/l/I) so it can be typed from a screen without mistakes
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"
const LOWER = "abcdefghjkmnpqrstuvwxyz"
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ"
const SYMBOLS = "-_.!#"

export function generatePassword(length = 24): string {
  const chars: string[] = []
  for (let i = 0; i < length; i++) chars.push(ALPHABET[randomInt(ALPHABET.length)]!)
  // guarantee a digit, an upper, a lower and a symbol, each in a distinct position, regardless of luck
  const positions = [...Array(length).keys()]
  const take = () => positions.splice(randomInt(positions.length), 1)[0]!
  chars[take()] = String(2 + randomInt(8))
  chars[take()] = UPPER[randomInt(UPPER.length)]!
  chars[take()] = LOWER[randomInt(LOWER.length)]!
  chars[take()] = SYMBOLS[randomInt(SYMBOLS.length)]!
  return chars.join("")
}

const credentials = (adminId: string, email: string, password: string, secret: string, issuer: string): CliCredentials => ({
  adminId, email, password, totpSecret: secret, otpauthUri: otpauthUri(secret, email, issuer),
})

export async function createAdminViaCli(
  repo: AdminRepo,
  encKey: string,
  input: { email: string; name: string; role?: AdminRole },
  opts: { issuer?: string } = {},
): Promise<CliCredentials> {
  const role = input.role ?? "super"
  const email = input.email.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new DomainError("invalid_input", "A valid email is required.")
  if (!input.name.trim()) throw new DomainError("invalid_input", "A name is required.")
  const password = generatePassword()
  const secret = generateTotpSecret()
  const id = await repo.createAdmin({
    email, name: input.name.trim(), role, passwordHash: await hashPassword(password), totpSecretEnc: encryptSecret(secret, encKey), createdBy: null,
  })
  await repo.appendAudit({
    adminId: id, actor: "cli", action: "admin.cli_create", targetType: "admin", targetId: id,
    after: { email, role, via: "cli" }, outcome: "ok",
  })
  return credentials(id, email, password, secret, opts.issuer ?? "Bipone Admin")
}

/** Recovery for an existing admin: new password + fresh 2FA secret, all sessions ended, recovery codes cleared. */
export async function resetAdminViaCli(repo: AdminRepo, encKey: string, emailInput: string, opts: { issuer?: string } = {}): Promise<CliCredentials> {
  const email = emailInput.trim().toLowerCase()
  const admin = await repo.findAdminByEmail(email)
  if (!admin) throw new DomainError("not_found", "No admin with that email.")
  const password = generatePassword()
  const secret = generateTotpSecret()
  // Reactivate FIRST: totpBegin refuses an inactive admin, and the operator must never be shown a secret that was not stored.
  if (!admin.active && !(await repo.setRoleActive(admin.id, admin.role, true))) throw new DomainError("not_found", "No admin with that email.")
  await repo.setPassword(admin.id, await hashPassword(password), true) // ends every session
  await repo.reset2fa(admin.id) // clears the old secret + recovery codes, forces re-enrolment
  if (!(await repo.totpBegin(admin.id, encryptSecret(secret, encKey)))) {
    throw new DomainError("internal", "Could not store the new 2FA secret; nothing was printed. Run the reset again.")
  }
  // The login/2FA throttles are keyed by email and admin id, so the operator can be locked out by earlier failed attempts
  // (including attacker traffic): clearing them is part of break-glass. Per-IP buckets are not enumerable and expire on their own.
  await repo.throttleReset(loginEmailBucket(email))
  await repo.throttleReset(`2fa:${admin.id}`)
  await repo.throttleReset(`enroll:${admin.id}`)
  await repo.appendAudit({
    adminId: admin.id, actor: "cli", action: "admin.cli_reset", targetType: "admin", targetId: admin.id,
    before: { active: admin.active, enrolled: admin.enrolled }, after: { passwordReset: true, enrolled: false, reactivated: !admin.active, via: "cli" }, outcome: "ok",
  })
  return credentials(admin.id, email, password, secret, opts.issuer ?? "Bipone Admin")
}
