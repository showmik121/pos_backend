import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { Buffer } from "node:buffer"

// TOTP (RFC 6238 / RFC 4226): HMAC-SHA1, 6 digits, 30 s step. No external library (same approach as token.ts).
// Pure except for generateTotpSecret (randomness).

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
export const TOTP_STEP_SECONDS = 30
export const TOTP_DIGITS = 6

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ""
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(text: string): Uint8Array {
  const clean = text.replace(/=+$/, "").toUpperCase()
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch)
    if (idx < 0) throw new Error("invalid base32")
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Uint8Array.from(out)
}

/** 160-bit secret, base32 (32 chars). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

export function totpCode(secretBase32: string, step: number, digits = TOTP_DIGITS): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const mac = createHmac("sha1", Buffer.from(base32Decode(secretBase32))).update(counter).digest()
  const offset = mac[mac.length - 1]! & 15
  const bin =
    ((mac[offset]! & 127) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!
  return String(bin % 10 ** digits).padStart(digits, "0")
}

/**
 * Returns the matching 30 s step (so the caller can record it and refuse replays), or null.
 * Accepts the current step and one step either side (clock drift). Never throws on bad input.
 */
export function verifyTotp(secretBase32: string, code: unknown, nowMs: number, window = 1): number | null {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return null
  const current = Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS)
  const given = Buffer.from(code)
  let matched: number | null = null
  for (const delta of [0, -1, 1].filter((d) => Math.abs(d) <= window)) {
    const expected = Buffer.from(totpCode(secretBase32, current + delta))
    if (timingSafeEqual(given, expected) && matched === null) matched = current + delta // no early exit: constant work
  }
  return matched
}

export function otpauthUri(secretBase32: string, account: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`
}
