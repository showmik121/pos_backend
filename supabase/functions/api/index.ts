// Supabase Edge Function "api"।
// https://<project>.supabase.co/functions/v1/api/... এ আসা প্রতিটি অনুরোধ এখানে /api/... পাথ নিয়ে পৌঁছায়,
// যা server/app.ts এর রুটের সঙ্গে মেলে।
// app.bundle.js তৈরি হয় `node edge/build.mjs` দিয়ে (deploy-supabase.bat বা GitHub Actions চালায়)।

type Handler = (req: Request) => Response | Promise<Response>

let handler: Handler | null = null
let bootError = ""

try {
  const mod = await import("./app.bundle.js")
  const app = mod.default
  handler = (req) => app.fetch(req)
} catch (err) {
  // Supabase লগে (এবং সংক্ষেপে রেসপন্সে) দেখায়, যাতে ভুল ডিপ্লয় নিজেই কারণ বলে দেয়।
  bootError = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  console.error("[api] failed to start:", err)
}

Deno.serve((req) => {
  if (handler) return handler(req)
  return new Response(
    JSON.stringify({ error: { code: "BOOT_ERROR", message: bootError, details: null } }),
    { status: 500, headers: { "content-type": "application/json" } },
  )
})
