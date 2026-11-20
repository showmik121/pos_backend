import { assertEncKey } from "../src/auth/admin-crypto.js"
import { assertAdminSecret } from "../src/auth/admin-token.js"
import { createPgAdmin } from "../src/db/pg-admin.js"
import { createPgRepo } from "../src/db/pg.js"
import { createApp, type App, type AppOptions } from "./app.js"
import type { Repo } from "../src/db/types.js"

// Admin panel is ALL-OR-NOTHING and FAIL-CLOSED: it needs all three variables and valid values, otherwise it is simply
// not mounted (/v1/admin/* answers 404). A bad admin config must never take the shop API down, so this logs the
// variable NAMES and the reason only, never a value.
function adminFromEnv(env: Record<string, string | undefined>): AppOptions["admin"] {
  const { ADMIN_JWT_SECRET, ADMIN_DATABASE_URL, ADMIN_TOTP_ENC_KEY, JWT_SECRET } = env
  const present = [ADMIN_JWT_SECRET, ADMIN_DATABASE_URL, ADMIN_TOTP_ENC_KEY].filter(Boolean).length
  if (present === 0) return undefined
  try {
    if (present < 3) throw new Error("set ALL of ADMIN_JWT_SECRET, ADMIN_DATABASE_URL, ADMIN_TOTP_ENC_KEY, or none")
    assertAdminSecret(ADMIN_JWT_SECRET)
    assertEncKey(ADMIN_TOTP_ENC_KEY)
    if (ADMIN_JWT_SECRET === JWT_SECRET) throw new Error("ADMIN_JWT_SECRET must differ from JWT_SECRET")
    return {
      repo: createPgAdmin({ connectionString: ADMIN_DATABASE_URL as string, max: Number(env.ADMIN_DB_POOL_MAX ?? 2) }),
      jwtSecret: ADMIN_JWT_SECRET,
      totpEncKey: ADMIN_TOTP_ENC_KEY,
      issuer: env.ADMIN_TOTP_ISSUER || undefined,
    }
  } catch (err) {
    console.error("admin panel disabled:", err instanceof Error ? err.message : "invalid configuration")
    return undefined
  }
}

// পরিবেশ থেকে (process.env) আসল অ্যাপ বানায়। Node সার্ভার ও Edge Function দুটোই এটি ব্যবহার করে।
export function buildAppFromEnv(env: Record<string, string | undefined> = process.env): { app: App; repo: Repo } {
  const { DATABASE_URL, JWT_SECRET, ALLOWED_ORIGINS = "", TOKEN_TTL_SECONDS = "43200" } = env
  if (!DATABASE_URL) throw new Error("DATABASE_URL সেট করা নেই")
  if (!JWT_SECRET) throw new Error("JWT_SECRET সেট করা নেই")

  const repo = createPgRepo({ connectionString: DATABASE_URL, max: Number(env.DB_POOL_MAX ?? 5) })
  const app = createApp({
    repo,
    jwtSecret: JWT_SECRET,
    ttlSeconds: Number(TOKEN_TTL_SECONDS),
    corsOrigins: ALLOWED_ORIGINS.split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean),
    admin: adminFromEnv(env),
  })
  return { app, repo }
}
