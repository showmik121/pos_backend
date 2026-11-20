// CLI for the deploy guard. Always runs when executed (no entry-path detection that could silently skip the check).
//   APPLIED_MIGRATION=13 node scripts/deploy-guard-run.mjs     -> exit 0 only if 13 >= latest file in db/migrations
// Optional MIGRATIONS_DIR overrides the folder (tests).
import { readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { checkDeployGuard } from "./deploy-guard.mjs"

const dir = process.env.MIGRATIONS_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations")
let result
try {
  result = checkDeployGuard({ files: readdirSync(dir), applied: process.env.APPLIED_MIGRATION })
} catch (e) {
  result = { ok: false, message: `Cannot read migrations folder: ${e instanceof Error ? e.message : String(e)}` }
}
if (result.ok) console.log(result.message)
else {
  console.error(`::error title=Deploy guard::${result.message}`)
  process.exit(1)
}
