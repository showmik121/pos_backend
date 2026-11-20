// Break-glass admin bootstrap (docs/ADMIN_PANEL_PRD.md §17.1, §17.2). Run LOCALLY by the operator:
//
//   npm run create-admin -- --email you@example.com --name "Your Name"            # first / additional super admin
//   npm run create-admin -- --email you@example.com --name "Staff" --role support
//   npm run create-admin -- --email you@example.com --reset                       # lost password or 2FA: new credentials
//
// Needs (in your local .env, never in chat or git): DATABASE_URL_UNPOOLED (postgres role, same as db:migrate) and
// ADMIN_TOTP_ENC_KEY (the SAME value as the deployed secret, or the admin could not use the 2FA secret it creates).
// The password and the 2FA secret are printed ONCE, to this terminal only. They are not stored anywhere readable.
import { parseArgs } from "node:util"
import { assertEncKey } from "../src/auth/admin-crypto.js"
import { createAdminViaCli, resetAdminViaCli } from "../src/auth/admin-bootstrap.js"
import { createPgAdmin } from "../src/db/pg-admin.js"
import type { AdminRole } from "../src/domain/admin-permissions.js"

try {
  process.loadEnvFile()
} catch {
  /* no .env */
}

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    name: { type: "string" },
    role: { type: "string", default: "super" },
    reset: { type: "boolean", default: false },
  },
})

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.MIGRATE_DATABASE_URL
const key = process.env.ADMIN_TOTP_ENC_KEY
const ROLES = ["super", "support", "finance", "viewer"]

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

if (!url) fail("Set DATABASE_URL_UNPOOLED in your local .env (the same Session-pooler `postgres` URL that db:migrate uses).")
try {
  assertEncKey(key)
} catch {
  fail("Set ADMIN_TOTP_ENC_KEY in your local .env: 32 random bytes, base64 (it must equal the deployed secret).")
}
if (!values.email) fail("--email is required")
if (!values.reset && !values.name) fail("--name is required when creating an admin")
if (!ROLES.includes(values.role ?? "")) fail(`--role must be one of: ${ROLES.join(", ")}`)

const repo = createPgAdmin({ connectionString: url as string, max: 1 })
try {
  const creds = values.reset
    ? await resetAdminViaCli(repo, key as string, values.email)
    : await createAdminViaCli(repo, key as string, { email: values.email, name: values.name as string, role: values.role as AdminRole })

  console.log(values.reset ? "\nAdmin reset. Sessions ended; sign in with the new password, then confirm 2FA with the new secret." : "\nAdmin created.")
  console.log("Shown ONCE. Put them in a password manager now; nothing here is stored.\n")
  console.log(`  email:     ${creds.email}`)
  console.log(`  password:  ${creds.password}`)
  console.log(`  2FA secret (base32): ${creds.totpSecret}`)
  console.log(`  2FA URI (paste into an authenticator app that accepts otpauth://): ${creds.otpauthUri}`)
  console.log("\nNext: sign in at the admin site, then enter the 6-digit code from your authenticator to finish enrolment.\n")
} catch (err) {
  fail(err instanceof Error ? err.message : "failed")
} finally {
  await repo.close()
}
