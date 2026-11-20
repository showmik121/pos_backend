export function parseApplied(value: unknown): number | null
export function latestMigration(files: readonly string[]): number
export function checkDeployGuard(input: { files: readonly string[]; applied: string | undefined }): { ok: boolean; message: string }
