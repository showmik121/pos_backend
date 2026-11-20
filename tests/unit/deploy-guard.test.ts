// A0 deploy guard: auto-deploy must not ship API code before the DB migrations it needs are applied.
import { spawnSync } from "node:child_process"
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { checkDeployGuard, latestMigration, parseApplied } from "../../scripts/deploy-guard.mjs"

describe("parseApplied", () => {
  it("accepts plain digits, with or without leading zeros and whitespace", () => {
    expect(parseApplied("13")).toBe(13)
    expect(parseApplied(" 013 ")).toBe(13)
  })
  it("rejects anything else, including file names and huge numbers", () => {
    for (const bad of ["", undefined, "abc", "-1", "13a", "013_x.sql", "13_.sql", "1e3", "99999999999999999999"]) expect(parseApplied(bad)).toBeNull()
  })
})

describe("latestMigration", () => {
  it("picks the highest numbered .sql file and ignores non-sql files", () => {
    expect(latestMigration(["001_a.sql", "012_b.sql", "013_c.sql", "README.md", "009_x.sql"])).toBe(13)
  })
  it("returns 0 when there are no migrations", () => {
    expect(latestMigration([])).toBe(0)
  })
  it("throws on a .sql file db-migrate would run but whose name has no NNN_ prefix", () => {
    for (const bad of ["014.sql", "014-foo.sql", "foo.sql", "014_.sql"]) expect(() => latestMigration(["013_a.sql", bad])).toThrow()
  })
})

describe("checkDeployGuard", () => {
  const files = ["012_a.sql", "013_b.sql"]
  it("passes when applied equals or is ahead of the latest", () => {
    expect(checkDeployGuard({ files, applied: "13" }).ok).toBe(true)
    expect(checkDeployGuard({ files, applied: "14" }).ok).toBe(true)
  })
  it("blocks when behind, and says which migration is needed", () => {
    const r = checkDeployGuard({ files, applied: "12" })
    expect(r.ok).toBe(false)
    expect(r.message).toContain("013")
    expect(r.message).toContain("012")
  })
  it("blocks with a distinct message when nothing valid is recorded (fail closed)", () => {
    for (const applied of [undefined, "", "  ", "oops", "99999999999999999999"]) {
      const r = checkDeployGuard({ files, applied })
      expect(r.ok).toBe(false)
      expect(r.message).toContain("APPLIED_MIGRATION")
    }
  })
  it("blocks when the migrations folder is empty, even with applied=0", () => {
    expect(checkDeployGuard({ files: [], applied: "0" }).ok).toBe(false)
  })
  it("blocks on a mis-named migration file", () => {
    expect(checkDeployGuard({ files: ["013_a.sql", "014.sql"], applied: "13" }).ok).toBe(false)
  })
})

describe("deploy-guard-run CLI (the real script, as CI runs it)", () => {
  const script = path.resolve(__dirname, "../../scripts/deploy-guard-run.mjs")
  const run = (applied: string | undefined, dir: string, entry = script) => {
    const env: NodeJS.ProcessEnv = { ...process.env, MIGRATIONS_DIR: dir }
    delete env.APPLIED_MIGRATION
    if (applied !== undefined) env.APPLIED_MIGRATION = applied
    return spawnSync(process.execPath, [entry], { env, encoding: "utf8" })
  }
  const dir = mkdtempSync(path.join(tmpdir(), "mig-"))
  writeFileSync(path.join(dir, "013_x.sql"), "")

  it("exits 0 when applied >= latest, 1 when behind, 1 when unset", () => {
    expect(run("13", dir).status).toBe(0)
    const behind = run("12", dir)
    expect(behind.status).toBe(1)
    expect(behind.stderr).toContain("::error title=Deploy guard::")
    expect(run(undefined, dir).status).toBe(1)
  })
  it("still fails closed when invoked through a symlinked path", () => {
    const link = path.join(mkdtempSync(path.join(tmpdir(), "lnk-")), "scripts")
    symlinkSync(path.dirname(script), link)
    expect(run(undefined, dir, path.join(link, "deploy-guard-run.mjs")).status).toBe(1)
  })
  it("exits 1 when the migrations folder cannot be read", () => {
    expect(run("13", path.join(dir, "nope")).status).toBe(1)
  })
})
