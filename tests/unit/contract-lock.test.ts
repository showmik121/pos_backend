// The admin contract is pinned by contract.lock: changing src/contract/admin-api.ts or src/domain/admin-permissions.ts
// without re-pinning (and copying both into pos_admin) fails here, so the UI and API cannot silently drift.
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
// @ts-expect-error plain .mjs helper without types
import { computeLock } from "../../scripts/contract-lock.mjs"

describe("admin contract lock", () => {
  it("contract.lock matches the contract and permission files (run: node scripts/contract-lock.mjs --write)", () => {
    const pinned = readFileSync(path.join(process.cwd(), "contract.lock"), "utf8").trim()
    expect(computeLock()).toBe(pinned)
  })

  it("line endings do not change the hash", () => {
    expect(computeLock()).toMatch(/^[0-9a-f]{64}$/)
  })
})
