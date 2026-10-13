// What an admin server action returns to its form: success, or the error code with the parts of `details` the
// screen needs to explain what happened and how to fix it (§9.9 rule 7, §14.2). Never the raw message.

// Columns and reasons of the member import (src/server/services/members/import.ts), as message keys
export const IMPORT_FIELDS = ['email', 'displayNameTh', 'displayNameEn', 'employeeCode', 'roles', 'file'] as const
export const IMPORT_REASONS = [
  'REQUIRED',
  'INVALID_EMAIL',
  'TOO_LONG',
  'UNKNOWN_ROLE',
  'DUPLICATE_IN_FILE',
  'ALREADY_MEMBER',
  'EMPLOYEE_CODE_TAKEN',
  'NO_ROWS',
  'TOO_MANY_ROWS',
  'UNREADABLE',
  'MISSING_HEADER',
] as const
export type ImportField = (typeof IMPORT_FIELDS)[number]
export type ImportReason = (typeof IMPORT_REASONS)[number]

export interface ImportRowErrorView {
  readonly row: number
  readonly field: ImportField
  readonly reason: ImportReason
}

export type AdminOutcome =
  | {
      readonly ok: true
      readonly count?: number
      // invitations: whether the e-mail went out (null: a repeat of a submission already handled); for an import, how
      // many went out (null: the same file was imported before) and the addresses that still need a resend
      readonly emailSent?: boolean | null
      readonly emailsSent?: number | null
      readonly notSent?: readonly string[]
    }
  | {
      readonly ok: false
      readonly code: string
      readonly reason?: string
      readonly field?: string
      readonly rows?: readonly ImportRowErrorView[]
      readonly modules?: readonly string[]
      readonly documents?: readonly string[]
      // DOA document types a module needs before it is switched on (BR-DOA-24)
      readonly documentTypes?: readonly string[]
      // the reference of an unexpected error (§14.2 INTERNAL), so support can find it in the logs
      readonly requestId?: string
    }

export type AdminFailure = Extract<AdminOutcome, { ok: false }>

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((v) => typeof v === 'string') ? (value as string[]) : undefined

const oneOf = <T extends string>(list: readonly T[], value: unknown, fallback: T): T =>
  typeof value === 'string' && (list as readonly string[]).includes(value) ? (value as T) : fallback

/** Picks the screen-safe parts of a service error. */
export function toFailure(error: { code: string; details?: Record<string, unknown> }): AdminFailure {
  const d = error.details ?? {}
  const rows = Array.isArray(d.rows)
    ? (d.rows as Array<Record<string, unknown>>).map((r) => ({
        row: Number(r.row),
        field: oneOf(IMPORT_FIELDS, r.field, 'file'),
        reason: oneOf(IMPORT_REASONS, r.reason, 'UNREADABLE'),
      }))
    : undefined
  const modules = strings(d.missing) ?? strings(d.modules)
  const documents = strings(d.documents)
  const documentTypes = strings(d.documentTypes)
  return {
    ok: false,
    code: error.code,
    ...(typeof d.reason === 'string' ? { reason: d.reason } : {}),
    ...(typeof d.field === 'string' ? { field: d.field } : {}),
    ...(rows ? { rows } : {}),
    ...(modules ? { modules } : {}),
    ...(documents ? { documents } : {}),
    ...(documentTypes ? { documentTypes } : {}),
    ...(typeof d.requestId === 'string' ? { requestId: d.requestId } : {}),
  }
}

export const MEMBER_ERROR_KEYS = [
  'SELF_GRANT',
  'SHARED_IDENTITY',
  'LAST_ORG_ADMIN',
  'ALREADY_GRANTED',
  'ALREADY_MEMBER',
  'SELF',
  'REASON',
  'CONFIRM',
  'EMAIL',
  'NAME',
  'INPUT',
  'FORBIDDEN',
  'NOT_FOUND',
  'STATE',
  'BUSY',
  'FILE_MISSING',
  'FILE_TOO_LARGE',
  'ROLE_NOT_HELD',
  'UNAUTHENTICATED',
  'CONFLICT',
  'INTERNAL',
  'FAILED',
] as const
export type MemberErrorKey = (typeof MEMBER_ERROR_KEYS)[number]

const REASON_KEYS: readonly MemberErrorKey[] = ['SELF_GRANT', 'SHARED_IDENTITY', 'LAST_ORG_ADMIN', 'ALREADY_GRANTED', 'ALREADY_MEMBER', 'SELF', 'FILE_MISSING', 'FILE_TOO_LARGE']

/** Message key under admin.members.errors for a failed member action. */
export function memberErrorKey(failure: AdminFailure): MemberErrorKey {
  const { code, reason, field } = failure
  const byReason = REASON_KEYS.find((k) => k === reason)
  if (byReason) return byReason
  if (code === 'VALIDATION_FAILED' && field === 'reason') return 'REASON'
  if (code === 'VALIDATION_FAILED' && field === 'email') return 'EMAIL'
  if (code === 'VALIDATION_FAILED' && field === 'displayNameTh') return 'NAME'
  if (code === 'VALIDATION_FAILED') return 'INPUT'
  if (code === 'UNAUTHENTICATED') return 'UNAUTHENTICATED'
  if (code === 'FORBIDDEN') return 'FORBIDDEN'
  // revoking a role the member no longer holds: the member is there, the role is not
  if (code === 'NOT_FOUND' && field === 'role') return 'ROLE_NOT_HELD'
  if (code === 'NOT_FOUND') return 'NOT_FOUND'
  if (code === 'INVALID_STATE_TRANSITION') return 'STATE'
  if (code === 'IDEMPOTENCY_CONFLICT') return 'CONFLICT'
  if (code === 'RATE_LIMITED') return 'BUSY'
  if (code === 'INTERNAL') return 'INTERNAL'
  return 'FAILED'
}

/** Values every admin.members.errors message may use: the §14.2 reference of an unexpected error. */
export function memberErrorValues(failure: AdminFailure): { requestId: string } {
  return { requestId: failure.requestId ?? '-' }
}
