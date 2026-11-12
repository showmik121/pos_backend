import { DomainError } from "./errors.js"

const DAY_MS = 86_400_000

export type ExpiryClass = "none" | "expired" | "critical" | "soon" | "ok"

function parseDate(s: unknown, name: string): number {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new DomainError("invalid_date", `${name} YYYY-MM-DD আকারে হতে হবে`)
  }
  const t = Date.parse(`${s}T00:00:00Z`)
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== s) {
    throw new DomainError("invalid_date", `${name} সঠিক তারিখ নয়`)
  }
  return t
}

// আজ থেকে মেয়াদ শেষ হতে কত দিন বাকি (শেষ হয়ে গেলে ঋণাত্মক)।
export function daysUntil(expiryDate: string, today: string): number {
  return Math.round((parseDate(expiryDate, "মেয়াদের তারিখ") - parseDate(today, "আজকের তারিখ")) / DAY_MS)
}

// expired = আজ বা তার আগে শেষ (বিক্রি বন্ধ); critical ≤ ৩০ দিন; soon ≤ ৯০ দিন; ok; none = মেয়াদ নেই।
export function classifyExpiry(expiryDate: string | null | undefined, today: string): ExpiryClass {
  if (expiryDate == null) return "none"
  const d = daysUntil(expiryDate, today)
  if (d <= 0) return "expired"
  if (d <= 30) return "critical"
  if (d <= 90) return "soon"
  return "ok"
}
