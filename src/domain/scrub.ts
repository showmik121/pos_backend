// Crash-report text comes from /v1/client-errors, which needs no token (server/app.ts), so it is untrusted input. The shop app masks
// numbers of 6+ digits before sending, but a caller can skip the app. The admin API therefore scrubs again on the way OUT, and the
// admin UI must still render these fields as plain text (never HTML). Pure.

const LONG_NUMBER = /[0-9০-৯]{6,}/g // ASCII and Bengali digits: phone numbers, bill and card numbers
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g
const VERSION = /^[A-Za-z0-9._+-]{1,40}$/

export function scrubCrashText(text: string): string {
  return text.replace(CONTROL, "").replace(LONG_NUMBER, "#")
}

/** a build id or version string, or null if it is anything else */
export function safeVersion(v: string | null): string | null {
  return v !== null && VERSION.test(v) ? v : null
}
