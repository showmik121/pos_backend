// API কে একটি ফাইলে বান্ডেল করে, যা Supabase Edge Functions (Deno) চালাতে পারে।
// ব্যবহার: node edge/build.mjs
import { builtinModules, createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import path from "node:path"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const builtins = new Set(builtinModules)

// Deno তে built-in মডিউলের আগে "node:" লাগে ("crypto" -> "node:crypto")।
const nodePrefix = {
  name: "node-prefix",
  setup(b) {
    b.onResolve({ filter: /^(node:)?[a-z_/]+$/ }, (args) => {
      const name = args.path.replace(/^node:/, "")
      if (!builtins.has(name)) return undefined
      return { path: `node:${name}`, external: true }
    })
  },
}

// GitHub Actions এ বিল্ড ত্রুটি রান পেজে annotation হিসেবে দেখায়।
function report(message) {
  const text = String(message).replace(/%/g, "%25").replace(/\r?\n/g, "%0A")
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=Edge build::${text}`)
  console.error(message)
}

let build
try {
  ;({ build } = createRequire(path.join(root, "package.json"))("esbuild"))
} catch (err) {
  report(`esbuild পাওয়া যায়নি (npm install চালান): ${err?.message?.split("\n")[0]}`)
  process.exit(1)
}

await build({
  entryPoints: [path.join(root, "edge/entry.ts")],
  outfile: path.join(root, "supabase/functions/api/app.bundle.js"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2022",
  minify: true,
  legalComments: "none",
  plugins: [nodePrefix],
  // Supabase এর রানটাইমে Node গ্লোবাল (Buffer, process, setImmediate…) নেই,
  // কিন্তু Postgres ড্রাইভার এগুলো আশা করে। এখানে জোগান দেওয়া হলো।
  banner: {
    js: [
      'import { createRequire as __posCreateRequire } from "node:module";',
      'import process from "node:process";',
      'import { Buffer as __posBuffer } from "node:buffer";',
      'import { setImmediate as __posSetImmediate, clearImmediate as __posClearImmediate } from "node:timers";',
      "globalThis.Buffer ??= __posBuffer;",
      "globalThis.global ??= globalThis;",
      "globalThis.process ??= process;",
      "globalThis.setImmediate ??= __posSetImmediate;",
      "globalThis.clearImmediate ??= __posClearImmediate;",
      "const require = __posCreateRequire(import.meta.url);",
    ].join(""),
  },
  logLevel: "info",
}).catch((err) => {
  const list = err?.errors?.length ? err.errors : [{ text: err?.message || String(err) }]
  for (const e of list.slice(0, 10)) {
    const where = e.location ? ` (${e.location.file}:${e.location.line})` : ""
    report(`${e.text}${where}`)
  }
  process.exit(1)
})

// The bundle must contain the admin routes and the tenant enforcement (PRD §17.6): a build that silently dropped them
// would deploy a shop API without suspension enforcement or an admin panel that 404s. Fail the build instead.
const { readFile } = await import("node:fs/promises")
const bundle = await readFile(path.join(root, "supabase/functions/api/app.bundle.js"), "utf8")
const required = ["/v1/admin/", "/auth/login", "/auth/2fa/enroll-confirm", "/admins/:id/reset-2fa", "admin.reset_2fa", "tenant_suspended", "tenant_read_only", "pending_deletion"]
const missing = required.filter((marker) => !bundle.includes(marker))
if (missing.length) {
  report(`Bundle is missing admin/enforcement code: ${missing.join(", ")}`)
  process.exit(1)
}

console.log("Built supabase/functions/api/app.bundle.js (admin routes and tenant enforcement present)")
