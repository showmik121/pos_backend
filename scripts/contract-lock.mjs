// Pins the admin API contract so the pos_admin copy cannot drift from this repo (PRD 17.9, like the shop fixtures.lock).
//   node scripts/contract-lock.mjs          -> verify contract.lock matches the files (exit 1 if not)
//   node scripts/contract-lock.mjs --write  -> recompute contract.lock after an intentional contract change
// pos_admin keeps byte-identical copies of these two files plus the same contract.lock; its test fails if its copies differ from its lock.
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const FILES = ["src/contract/admin-api.ts", "src/domain/admin-permissions.ts"]
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

export function computeLock(base = root) {
  const h = createHash("sha256")
  for (const f of FILES) {
    // normalise line endings so a Windows checkout (autocrlf) hashes the same as Linux CI
    h.update(`${f}\n${readFileSync(path.join(base, f), "utf8").replace(/\r\n/g, "\n")}\n`)
  }
  return h.digest("hex")
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const lockPath = path.join(root, "contract.lock")
  const actual = computeLock()
  if (process.argv.includes("--write")) {
    writeFileSync(lockPath, `${actual}\n`)
    console.log(`contract.lock written: ${actual}`)
  } else {
    const pinned = readFileSync(lockPath, "utf8").trim()
    if (pinned !== actual) {
      console.error(`contract.lock is stale.\n  pinned: ${pinned}\n  actual: ${actual}\nRun: node scripts/contract-lock.mjs --write, then copy ${FILES.join(" and ")} and contract.lock into pos_admin.`)
      process.exit(1)
    }
    console.log(`contract.lock OK (${actual.slice(0, 12)})`)
  }
}
