import { describe, expect, it } from "vitest"
import { createMemoryAdmin } from "../../src/db/memory-admin.js"

// admin_totp_confirm (migration 012) is bound to the exact encrypted secret whose code was verified, so a concurrent
// re-begin can never confirm an admin on a secret nobody checked. The memory repo must behave the same way as the SQL
// function, otherwise unit tests would pass while Postgres refuses (this gap hid a broken enrolment on real Postgres).
describe("totpConfirm is bound to the verified secret", () => {
  async function fresh() {
    const repo = createMemoryAdmin({ now: () => Date.parse("2026-11-20T06:00:00.000Z") })
    const id = await repo.createAdmin({ email: "a@example.test", name: "A", role: "super", passwordHash: "x", totpSecretEnc: "enc-secret-1", createdBy: null })
    return { repo, id }
  }

  it("confirms when the stored secret is the one that was verified", async () => {
    const { repo, id } = await fresh()
    expect(await repo.totpConfirm(id, ["h1"], 5, "enc-secret-1")).toBe(true)
    expect((await repo.getAdmin(id))?.enrolled).toBe(true)
  })

  it("refuses when the secret changed after verification (stale confirm)", async () => {
    const { repo, id } = await fresh()
    expect(await repo.totpConfirm(id, ["h1"], 5, "enc-secret-OTHER")).toBe(false)
    expect((await repo.getAdmin(id))?.enrolled).toBe(false)
  })

  it("refuses a second confirm once enrolled", async () => {
    const { repo, id } = await fresh()
    expect(await repo.totpConfirm(id, [], 1, "enc-secret-1")).toBe(true)
    expect(await repo.totpConfirm(id, [], 2, "enc-secret-1")).toBe(false)
  })
})

// admin_totp_begin only fills an EMPTY slot. The memory repo used to overwrite an existing secret, so unit tests passed
// while Postgres answered false (an admin refreshing the enrolment page was then stuck behind 409 already_enrolled).
describe("totpBegin only fills an empty secret slot (same as SQL)", () => {
  it("refuses to replace an existing unconfirmed secret, and works again after a 2FA reset", async () => {
    const repo = createMemoryAdmin({ now: () => Date.parse("2026-11-20T06:00:00.000Z") })
    const id = await repo.createAdmin({ email: "b@example.test", name: "B", role: "support", passwordHash: "x", totpSecretEnc: null, createdBy: null })
    expect(await repo.totpBegin(id, "enc-1")).toBe(true)
    expect(await repo.totpBegin(id, "enc-2")).toBe(false)
    expect((await repo.getAdmin(id))?.totpSecretEnc).toBe("enc-1")
    expect(await repo.reset2fa(id)).toBe(true)
    expect(await repo.totpBegin(id, "enc-3")).toBe(true)
  })
})
