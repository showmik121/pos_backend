import { createHash } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { computeCart, settlePayments } from "../../src/domain/cart.js"
import { DomainError } from "../../src/domain/errors.js"
import { classifyExpiry } from "../../src/domain/expiry.js"
import { allocateFifo } from "../../src/domain/fifo.js"
import { planStockIn } from "../../src/domain/stock.js"
import { toBaseUnits } from "../../src/domain/units.js"

// গোল্ডেন ফিক্সচার: সত্য-উৎস ফ্রন্টএন্ড (pos_fontend/tests/fixtures/domain)। এখানে হুবহু কপি;
// ফ্রন্টএন্ডে বদলালে JSON ও fixtures.lock দুটোই কপি করতে হবে, নইলে আচরণ সরে যাবে।
const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "domain")

type Case = {
  name: string
  input: Record<string, unknown>
  output?: unknown
  error?: { code: string; details?: unknown }
}
type Fixture = { fn: string; cases: Case[] }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adapters: Record<string, (i: any) => unknown> = {
  classifyExpiry: (i) => classifyExpiry(i.expiryDate, i.today),
  toBaseUnits: (i) => toBaseUnits(i),
  computeCart: (i) => computeCart(i.lines, i.bill),
  settlePayments: (i) => settlePayments(i),
  allocateFifo: (i) => allocateFifo(i.batches, i.qtyNeeded, i.today),
  planStockIn: ({ product, ...cmd }) => planStockIn(product, { receiptId: "r", batchId: "b", productId: "p1", ...cmd }),
}

const files = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort()

describe("গোল্ডেন ফিক্সচার", () => {
  it("তালিকা লকের সাথে মেলে", () => {
    const lock = readFileSync(join(DIR, "fixtures.lock"), "utf8").trim()
    const actual = files
      .map((f) => `${createHash("sha256").update(readFileSync(join(DIR, f))).digest("hex")}  ${f}`)
      .join("\n")
    expect(actual).toBe(lock)
  })

  for (const file of files) {
    const fixture = JSON.parse(readFileSync(join(DIR, file), "utf8")) as Fixture
    describe(`${file} → ${fixture.fn}`, () => {
      const run = adapters[fixture.fn]
      it("ফাংশনের অ্যাডাপ্টার আছে", () => expect(run).toBeTypeOf("function"))
      for (const c of fixture.cases) {
        it(c.name, () => {
          if (c.error) {
            let thrown: unknown
            try {
              run!(c.input)
            } catch (e) {
              thrown = e
            }
            expect(thrown).toBeInstanceOf(DomainError)
            expect((thrown as DomainError).code).toBe(c.error.code)
            if (c.error.details) expect((thrown as DomainError).details).toEqual(c.error.details)
          } else {
            expect(run!(c.input)).toEqual(c.output)
          }
        })
      }
    })
  }
})
