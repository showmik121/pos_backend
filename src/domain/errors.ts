// ডোমেইন নিয়ম ভাঙলে এই ত্রুটি ছোড়া হয়। code মেশিনের জন্য, message ব্যবহারকারীর জন্য (বাংলা)।
export class DomainError extends Error {
  readonly code: string
  readonly details?: Record<string, unknown>

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = "DomainError"
    this.code = code
    this.details = details
  }
}

export function requirePositiveInt(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new DomainError("invalid_number", `${name} অবশ্যই ১ বা তার বেশি পূর্ণসংখ্যা হতে হবে`)
  }
  return value
}

export function requireNonNegativeInt(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new DomainError("invalid_number", `${name} অবশ্যই ০ বা তার বেশি পূর্ণসংখ্যা হতে হবে`)
  }
  return value
}
