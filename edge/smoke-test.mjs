// বিল্ড করা Supabase বান্ডেল Deno তে চালিয়ে কয়েকটি রুট যাচাই করে (ডাটাবেস লাগে না)।
// ব্যবহার (`node edge/build.mjs` এর পর): deno run -A edge/smoke-test.mjs
const inCI = Deno.env.get("GITHUB_ACTIONS")
const report = (msg) => {
  if (inCI) console.log(`::error title=Edge smoke test::${String(msg).replace(/\r?\n/g, "%0A")}`)
  console.error(msg)
}

// Supabase এর রানটাইমে Node এর গ্লোবাল নেই; সরিয়ে দিই যাতে এগুলোর ওপর নির্ভর করা কোড ধরা পড়ে।
for (const name of ["Buffer", "global", "process", "setImmediate", "clearImmediate"]) {
  delete globalThis[name]
}
globalThis.window ??= globalThis

let mod
try {
  mod = await import("../supabase/functions/api/app.bundle.js")
} catch (err) {
  report(`Bundle Deno তে লোড হয়নি: ${err?.stack || err}`)
  Deno.exit(1)
}
const app = mod.default

const post = (body) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

const checks = [
  ["GET", "/api/health", undefined, 200],
  ["GET", "/api/v1/me", undefined, 401], // টোকেন নেই
  ["GET", "/api/v1/staff", undefined, 401],
  ["POST", "/api/v1/auth/login", post({ phone: "123", password: "x" }), 400], // ভুল ফোন, ডাটাবেস লাগে না
  ["GET", "/api/does-not-exist", undefined, 404],
]

let failed = 0
for (const [method, path, init, expected] of checks) {
  let res
  try {
    res = await app.fetch(new Request(`https://edge.test${path}`, { method, ...init }))
  } catch (err) {
    report(`${path} exception ছুড়েছে: ${err?.stack || err}`)
    failed++
    continue
  }
  const ok = res.status === expected
  if (!ok) {
    failed++
    report(`${path} -> ${res.status}, প্রত্যাশিত ${expected}: ${(await res.text()).slice(0, 300)}`)
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${method} ${path}  -> ${res.status} (প্রত্যাশিত ${expected})`)
}

// Deno তে scrypt ও HMAC (পাসওয়ার্ড ও JWT) ঠিকমতো চলে কিনা
try {
  const problems = await mod.selfTest()
  for (const p of problems) {
    failed++
    report(`selfTest: ${p}`)
  }
  console.log(problems.length ? "FAIL  selfTest (scrypt/jwt)" : "PASS  selfTest (scrypt/jwt)")
} catch (err) {
  failed++
  report(`selfTest exception: ${err?.stack || err}`)
}

if (failed) {
  console.error(`${failed}টি edge যাচাই ব্যর্থ`)
  Deno.exit(1)
}
console.log("Supabase Edge বান্ডেল Deno তে ঠিকমতো চলছে।")
