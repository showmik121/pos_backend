import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomInt } from "node:crypto"
import { Buffer } from "node:buffer"

// Encryption of TOTP secrets at rest (AES-256-GCM) and single-use recovery codes.
// Key: ADMIN_TOTP_ENC_KEY, 32 random bytes, base64. Losing it means every admin must re-enrol (§17.2 reset path).

const ENVELOPE_VERSION = "v1"
const RECOVERY_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"

export function assertEncKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || Buffer.from(key, "base64").length !== 32) {
    throw new Error("ADMIN_TOTP_ENC_KEY অবশ্যই ৩২ বাইটের base64 মান হতে হবে")
  }
}

const keyBytes = (key: string): Buffer => {
  assertEncKey(key)
  return Buffer.from(key, "base64")
}

/** Envelope: v1.<iv>.<tag>.<ciphertext>, all base64url. A fresh 96-bit IV for every call. */
export function encryptSecret(plain: string, key: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", keyBytes(key), iv)
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
  return [ENVELOPE_VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".")
}

/** Throws on a wrong key, a tampered envelope or garbage: never returns wrong plaintext. */
export function decryptSecret(envelope: string, key: string): string {
  const parts = envelope.split(".")
  if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) throw new Error("invalid envelope")
  const decipher = createDecipheriv("aes-256-gcm", keyBytes(key), Buffer.from(parts[1]!, "base64url"))
  decipher.setAuthTag(Buffer.from(parts[2]!, "base64url"))
  return Buffer.concat([decipher.update(Buffer.from(parts[3]!, "base64url")), decipher.final()]).toString("utf8")
}

/** 10 codes like "k3f9a-q2x7m" (50 bits each). Shown to the admin once; only HMACs are stored. */
export function generateRecoveryCodes(count = 10): string[] {
  const codes = new Set<string>()
  while (codes.size < count) {
    let raw = ""
    for (let i = 0; i < 10; i++) raw += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]
    codes.add(`${raw.slice(0, 5)}-${raw.slice(5)}`)
  }
  return [...codes]
}

/** Case, dashes and spaces are ignored so typing "K3F9A Q2X7M" works. HMAC (keyed) so a DB leak alone cannot be brute-forced offline. */
export function hashRecoveryCode(code: string, key: string): string {
  const normalized = code.toLowerCase().replace(/[\s-]/g, "")
  return createHmac("sha256", keyBytes(key)).update(`recovery:${normalized}`).digest("base64url")
}
