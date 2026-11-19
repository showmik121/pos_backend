import { DomainError } from "./errors.js"

// keyset পেজিনেশনের অস্বচ্ছ কার্সর: [sortKey..., id] JSON → UTF-8 → base64url।
// btoa/atob Node ও Deno দুটোতেই আছে (Buffer শুধু Node-এ)।
export type CursorPart = string | number

export function encodeCursor(parts: readonly CursorPart[]): string {
  const bytes = new TextEncoder().encode(JSON.stringify(parts))
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function decodeCursor(raw: string, shape: ReadonlyArray<"string" | "number">): CursorPart[] {
  const bad = () => new DomainError("invalid_input", "cursor সঠিক নয়")
  if (!/^[A-Za-z0-9_-]{1,600}$/.test(raw)) throw bad()
  try {
    const b64 = raw.replace(/-/g, "+").replace(/_/g, "/")
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4))
    const parts: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))))
    if (!Array.isArray(parts) || parts.length !== shape.length || parts.some((p, i) => typeof p !== shape[i])) throw bad()
    return parts as CursorPart[]
  } catch {
    throw bad()
  }
}

export const PAGE_DEFAULT = 50
export const PAGE_MAX = 200

/** ?limit= পার্স: ১–২০০, না দিলে ৫০ */
export function parseLimit(raw: string | null): number {
  if (raw === null) return PAGE_DEFAULT
  if (!/^\d{1,4}$/.test(raw)) throw new DomainError("invalid_input", "limit সংখ্যা হতে হবে")
  const n = Number(raw)
  if (n < 1 || n > PAGE_MAX) throw new DomainError("invalid_input", `limit ১ থেকে ${PAGE_MAX}-এর মধ্যে হতে হবে`)
  return n
}
