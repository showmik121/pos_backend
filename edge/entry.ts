// Supabase Edge Function এর এন্ট্রি। edge/build.mjs এটি (এবং পুরো API) একটি ফাইলে বান্ডেল করে
// supabase/functions/api/app.bundle.js এ রাখে, যা Supabase এ Deno চালায়।
import { buildAppFromEnv } from "../server/config.js"
import { hashPassword, verifyPassword } from "../src/auth/password.js"
import { signToken, verifyToken } from "../src/auth/token.js"

const { app } = buildAppFromEnv()
export default app

// Deno তে scrypt ও HMAC ঠিকমতো চলে কিনা edge/smoke-test.mjs এ যাচাই করার জন্য (ডাটাবেস লাগে না)।
export async function selfTest(): Promise<string[]> {
  const problems: string[] = []
  const hash = await hashPassword("correct horse battery")
  if (!(await verifyPassword("correct horse battery", hash))) problems.push("scrypt: সঠিক পাসওয়ার্ড মেলেনি")
  if (await verifyPassword("wrong password!!", hash)) problems.push("scrypt: ভুল পাসওয়ার্ড মিলে গেছে")
  const secret = "x".repeat(40)
  const token = signToken({ sub: "u", sid: "s", role: "owner" }, secret)
  if (verifyToken(token, secret)?.sid !== "s") problems.push("jwt: যাচাই ব্যর্থ")
  if (verifyToken(token, "y".repeat(40)) !== null) problems.push("jwt: ভুল secret এ গৃহীত হয়েছে")
  return problems
}
