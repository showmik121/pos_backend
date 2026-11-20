// Local, throwaway PostgreSQL for integration tests. NEVER touches a live database:
// it starts an embedded cluster in a temp dir on a random local port, runs every migration
// (twice, to prove idempotency) as the superuser, then runs the integration suite and
// tears everything down.
//
//   npm run test:pg            # run the whole integration suite
//   npm run test:pg -- <file>  # extra args are passed to vitest
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import EmbeddedPostgres from "embedded-postgres"

const ROLE_PASSWORD = randomBytes(18).toString("hex") // throwaway, local only, never printed

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo
      srv.close(() => resolve(port))
    })
  })
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "inherit", env: { ...process.env, ...env }, shell: process.platform === "win32" })
    child.on("exit", (code) => resolve(code ?? 1))
  })
}

const dir = await mkdtemp(path.join(os.tmpdir(), "pos-pg-"))
const port = await freePort()
const superPassword = randomBytes(18).toString("hex")
const pg = new EmbeddedPostgres({
  databaseDir: path.join(dir, "data"),
  user: "postgres",
  password: superPassword,
  port,
  persistent: false,
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
  onLog: () => {},
  onError: () => {},
})

let code = 1
try {
  await pg.initialise()
  await pg.start()
  await pg.createDatabase("pos")
  const base = `postgres://postgres:${superPassword}@127.0.0.1:${port}/pos`
  const migrateEnv = { DATABASE_URL_UNPOOLED: base, POS_APP_PASSWORD: ROLE_PASSWORD, ADMIN_APP_PASSWORD: ROLE_PASSWORD }
  for (let pass = 1; pass <= 2; pass++) {
    const c = await run("npx", ["tsx", "scripts/db-migrate.ts"], migrateEnv)
    if (c !== 0) throw new Error(`migration pass ${pass} failed`)
  }
  const testEnv = {
    INTEGRATION_SUPERUSER_URL: base,
    INTEGRATION_DATABASE_URL: `postgres://pos_app:${ROLE_PASSWORD}@127.0.0.1:${port}/pos`,
    INTEGRATION_ADMIN_DATABASE_URL: `postgres://admin_app:${ROLE_PASSWORD}@127.0.0.1:${port}/pos`,
  }
  code = await run("npx", ["vitest", "run", "--config", "vitest.integration.config.ts", ...process.argv.slice(2)], testEnv)
} catch (e) {
  console.error(e instanceof Error ? e.message : e)
} finally {
  await pg.stop().catch(() => {})
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}
process.exit(code)
