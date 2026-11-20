// Deploy guard logic (A0, RUNBOOK 3খ, ADR 0008). A push to main auto-deploys the API but does NOT run migrations.
// If the API ships before the migration it calls, every shop sync fails. The deploy job runs
// scripts/deploy-guard-run.mjs, which uses this module and fails closed.

const FILE_RE = /^(\d+)_.+\.sql$/
const pad = (n) => String(n).padStart(3, "0")

/** Applied-migration value from the Actions variable: digits only ("13" or "013"), else null. */
export function parseApplied(value) {
  const s = String(value ?? "").trim()
  if (!/^\d+$/.test(s)) return null
  const n = Number(s)
  return Number.isSafeInteger(n) ? n : null
}

/** Highest migration number among *.sql files. Throws on a .sql file that does not match NNN_name.sql
 *  (db-migrate.ts runs every *.sql, so a mis-named file must never be silently ignored here). */
export function latestMigration(files) {
  let max = 0
  for (const f of files) {
    if (!f.endsWith(".sql")) continue
    const m = FILE_RE.exec(f)
    if (!m) throw new Error(`Migration file name must look like NNN_name.sql, got: ${f}`)
    const n = Number(m[1])
    if (n > max) max = n
  }
  return max
}

/** Fails closed: a missing, unparsable or too-low APPLIED_MIGRATION, an empty migrations folder, or a bad file name blocks. */
export function checkDeployGuard({ files, applied }) {
  let latest
  try {
    latest = latestMigration(files)
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
  if (latest === 0) return { ok: false, message: "No migrations found in db/migrations; refusing to deploy." }
  const have = parseApplied(applied)
  if (have === null) {
    return { ok: false, message: `APPLIED_MIGRATION is not set or not a plain number. The repo has migration ${pad(latest)}. Apply migrations to the live DB (RUNBOOK 3খ), then set the Actions variable APPLIED_MIGRATION=${latest}.` }
  }
  if (have < latest) {
    return { ok: false, message: `Live DB is at migration ${pad(have)} but the code needs ${pad(latest)}. Deploying now would break every shop sync. Apply ${pad(latest)} first (RUNBOOK 3খ), then raise APPLIED_MIGRATION.` }
  }
  return { ok: true, message: `Deploy guard OK: applied ${pad(have)} >= latest ${pad(latest)}.` }
}
