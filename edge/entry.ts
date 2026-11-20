// Supabase Edge Function এর এন্ট্রি। edge/build.mjs এটি (এবং পুরো API) একটি ফাইলে বান্ডেল করে
// supabase/functions/api/app.bundle.js এ রাখে, যা Supabase এ Deno চালায়।
import { buildAppFromEnv } from "../server/config.js"
import { hashPassword, verifyPassword } from "../src/auth/password.js"
import { signToken, verifyToken } from "../src/auth/token.js"
import { decryptSecret, encryptSecret } from "../src/auth/admin-crypto.js"
import { signAdminToken, verifyAdminToken } from "../src/auth/admin-token.js"
import { base32Encode, totpCode } from "../src/auth/totp.js"

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

  // Admin panel primitives must also work in Deno (AES-GCM, HMAC-SHA1 TOTP, admin JWT with audience)
  const key = Buffer.from("k".repeat(32)).toString("base64")
  if (decryptSecret(encryptSecret("JBSWY3DPEHPK3PXP", key), key) !== "JBSWY3DPEHPK3PXP") problems.push("admin: AES-GCM round-trip failed")
  const totpSecret = base32Encode(new TextEncoder().encode("12345678901234567890"))
  if (totpCode(totpSecret, Math.floor(59 / 30)) !== "287082") problems.push("admin: TOTP RFC 6238 vector failed")
  const adminSecret = "z".repeat(40)
  const adminToken = signAdminToken({ sub: "a", sid: "s" }, "admin", adminSecret)
  if (verifyAdminToken(adminToken, adminSecret, "admin")?.sid !== "s") problems.push("admin: token verify failed")
  if (verifyAdminToken(adminToken, adminSecret, "admin-pending") !== null) problems.push("admin: audience not enforced")
  if (verifyToken(adminToken, adminSecret) !== null) problems.push("admin: admin token accepted by the shop verifier")
  return problems
}
