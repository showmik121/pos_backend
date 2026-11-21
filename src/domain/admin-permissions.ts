// Permission matrix (PRD §3). Pure, fail-closed: an unknown role or action is denied.
// Checked on the SERVER for every request; hiding a button in the UI is never the control.

export type AdminRole = "super" | "support" | "finance" | "viewer"

// action -> roles allowed. Later phases only call into actions that already exist here.
export const ADMIN_ACTIONS = {
  // identity (A0)
  "admins.list": ["super"],
  "admins.create": ["super"],
  "admins.update": ["super"],
  "admins.reset2fa": ["super"],
  "admins.resetPassword": ["super"],
  // tenants (A1+)
  "tenant.read": ["super", "support", "finance", "viewer"],
  "tenant.reveal_phone": ["super", "support"],
  "tenant.notes.write": ["super", "support"],
  "tenant.suspend": ["super"],
  "tenant.export": ["super"],
  // health (A2): sync health, client errors, negative stock, dashboard tiles. Triage writes, so Viewer/Finance cannot.
  "health.read": ["super", "support", "finance", "viewer"],
  "health.triage": ["super", "support"],
  // billing (A3). Support and Viewer may LOOK at billing; only Finance and Super change it.
  "billing.read": ["super", "support", "finance", "viewer"],
  "billing.payment.void": ["super", "finance"],
  "billing.payment.record": ["super", "finance"],
  "billing.trial.extend": ["super", "finance"],
  "billing.plan.edit": ["super"],
  // support (A4+)
  "support.impersonate": ["super", "support"],
  // audit
  "audit.read": ["super", "support", "finance", "viewer"],
  "audit.export": ["super"],
} as const satisfies Record<string, readonly AdminRole[]>

export type AdminAction = keyof typeof ADMIN_ACTIONS

// Sensitive actions need a fresh password + 2FA ("step-up", A-3).
const STEP_UP: ReadonlySet<AdminAction> = new Set<AdminAction>([
  "admins.create",
  "admins.update",
  "admins.reset2fa",
  "admins.resetPassword",
  "tenant.suspend",
  "tenant.export",
  "billing.plan.edit",
  "billing.payment.void",
  "support.impersonate",
  "audit.export",
])

export function can(role: AdminRole, action: AdminAction): boolean {
  const allowed = (ADMIN_ACTIONS as Record<string, readonly string[] | undefined>)[action]
  return allowed !== undefined && allowed.includes(role)
}

export function requiresStepUp(action: AdminAction): boolean {
  return STEP_UP.has(action)
}
