import { describe, expect, it } from "vitest"
import { safeVersion, scrubCrashText } from "../../src/domain/scrub.js"

describe("scrubCrashText", () => {
  it("masks runs of 6 or more digits, ASCII and Bengali, and keeps shorter numbers", () => {
    expect(scrubCrashText("call 01711000030 or ০১৭১১০০০০৩০ now")).toBe("call # or # now")
    expect(scrubCrashText("bill 1001 item 12345")).toBe("bill 1001 item 12345")
    expect(scrubCrashText("a123456b")).toBe("a#b")
  })
  it("strips control characters but keeps newlines and tabs", () => {
    expect(scrubCrashText("a\u0000b\u0007c\nd\te")).toBe("abc\nd\te")
  })
})
describe("safeVersion", () => {
  it("accepts build ids and versions, rejects markup and long text", () => {
    expect(safeVersion("abc1234")).toBe("abc1234")
    expect(safeVersion("1.2.3-rc.1")).toBe("1.2.3-rc.1")
    expect(safeVersion("<img src=x>")).toBeNull()
    expect(safeVersion("x".repeat(41))).toBeNull()
    expect(safeVersion(null)).toBeNull()
  })
})
