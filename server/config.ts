import { createPgRepo } from "../src/db/pg.js"
import { createApp, type App } from "./app.js"
import type { Repo } from "../src/db/types.js"

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
  })
  return { app, repo }
}
