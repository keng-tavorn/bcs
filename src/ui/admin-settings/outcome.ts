// What a settings server action (calendar, numbering, request types) returns to its form: success with what the
// screen reports, or the error code with the parts of `details` the screen needs to say what happened and how to fix
// it (§9.9 rule 7, §14.2). Never the raw message.

export const HOLIDAY_FIELDS = ['date', 'nameTh', 'file'] as const
export const HOLIDAY_REASONS = [
  'REQUIRED',
  'INVALID_DATE',
  'DATE_OUT_OF_RANGE',
  'TOO_LONG',
  'DUPLICATE_IN_FILE',
  'NO_ROWS',
  'TOO_MANY_ROWS',
  'UNREADABLE',
  'MISSING_HEADER',
] as const

export interface HolidayRowErrorView {
  readonly row: number
  readonly field: (typeof HOLIDAY_FIELDS)[number]
  readonly reason: (typeof HOLIDAY_REASONS)[number]
}

export const SCHEMA_ISSUES = ['TYPE', 'UNKNOWN_KEY', 'VALUE', 'FORMAT', 'SIZE', 'SHAPE', 'OTHER'] as const
export type SchemaIssueView = (typeof SCHEMA_ISSUES)[number]

/** A problem of an imported form, as src/server/services/request-types/form-import.ts reports it */
export type FormProblemView =
  | { readonly reason: 'EMPTY' | 'TOO_LARGE' | 'JSON_SYNTAX' | 'TOO_DEEP' }
  | { readonly reason: 'SCHEMA'; readonly issue: SchemaIssueView; readonly path: string; readonly keys?: readonly string[] }
  | { readonly reason: 'DUPLICATE_FIELD'; readonly field: string; readonly path: string }
  | { readonly reason: 'DUPLICATE_RULE'; readonly rule: string; readonly path: string }
  | { readonly reason: 'UNKNOWN_FIELD'; readonly field: string; readonly path: string }
  | { readonly reason: 'UNKNOWN_ATTACHMENT'; readonly attachment: string; readonly path: string }
  | { readonly reason: 'DUPLICATE_STEP'; readonly step: string; readonly path: string }
  | { readonly reason: 'RESERVED_STEP'; readonly step: string; readonly path: string }
  | { readonly reason: 'FIELD_IN_TWO_STEPS'; readonly field: string; readonly path: string }

/** Why a number pattern cannot be saved (src/server/services/numbering/admin.ts) */
export const NUMBERING_REFUSALS = ['UNKNOWN_TOKEN', 'SEQ_MISSING', 'SEQ_REPEATED', 'SEQ_WIDTH', 'YEAR_MISSING', 'MONTH_MISSING', 'NUMBER_COLLISION', 'OVERLAPS_OTHER_DOCUMENT'] as const
export type NumberingRefusalReason = (typeof NUMBERING_REFUSALS)[number]

export interface NumberingRefusalView {
  readonly reason: NumberingRefusalReason
  readonly tokens?: readonly string[]
  readonly example?: string
  readonly other?: string
}

export type SettingsOutcome =
  | {
      readonly ok: true
      /** holiday import: dates added and dates the calendar had already */
      readonly added?: number
      readonly skipped?: number
      /** form import: the version published */
      readonly versionNo?: number
    }
  | SettingsFailure

export interface SettingsFailure {
  readonly ok: false
  readonly code: string
  readonly reason?: string
  readonly field?: string
  readonly rows?: readonly HolidayRowErrorView[]
  readonly problems?: readonly FormProblemView[]
  readonly refusal?: NumberingRefusalView
  readonly currentVersionNo?: number | null
  /** the reference of an unexpected error (§14.2 INTERNAL), so support can find it in the logs */
  readonly requestId?: string
}

const oneOf = <T extends string>(list: readonly T[], value: unknown, fallback: T): T =>
  typeof value === 'string' && (list as readonly string[]).includes(value) ? (value as T) : fallback

const strings = (value: unknown): string[] | undefined => (Array.isArray(value) && value.every((v) => typeof v === 'string') ? (value as string[]) : undefined)

/** Picks the screen-safe parts of a service error. */
export function toSettingsFailure(error: { code: string; details?: Readonly<Record<string, unknown>> }): SettingsFailure {
  const d = error.details ?? {}
  const rows = Array.isArray(d.rows)
    ? (d.rows as Array<Record<string, unknown>>).map((r) => ({ row: Number(r.row), field: oneOf(HOLIDAY_FIELDS, r.field, 'file'), reason: oneOf(HOLIDAY_REASONS, r.reason, 'UNREADABLE') }))
    : undefined
  const refusal =
    typeof d.reason === 'string' && (NUMBERING_REFUSALS as readonly string[]).includes(d.reason)
      ? {
          reason: d.reason as NumberingRefusalReason,
          ...(strings(d.tokens) ? { tokens: strings(d.tokens)! } : {}),
          ...(typeof d.example === 'string' ? { example: d.example } : {}),
          ...(typeof d.other === 'string' ? { other: d.other } : {}),
        }
      : undefined
  return {
    ok: false,
    code: error.code,
    ...(typeof d.reason === 'string' ? { reason: d.reason } : {}),
    ...(typeof d.field === 'string' ? { field: d.field } : {}),
    ...(rows ? { rows } : {}),
    ...(Array.isArray(d.problems) ? { problems: d.problems as FormProblemView[] } : {}),
    ...(refusal ? { refusal } : {}),
    ...('currentVersionNo' in d ? { currentVersionNo: typeof d.currentVersionNo === 'number' ? d.currentVersionNo : null } : {}),
    ...(typeof d.requestId === 'string' ? { requestId: d.requestId } : {}),
  }
}

/**
 * The answer of a server action, or null when none arrived (the network dropped, or the server failed before it could
 * answer). The form then says it was not saved, clears its pending state and keeps its submission key, so trying again
 * cannot run the command twice (spec §4.3).
 */
export async function settle<T>(answer: Promise<T>): Promise<T | null> {
  try {
    return await answer
  } catch {
    return null
  }
}

export const COMMON_ERROR_KEYS = ['UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'BUSY', 'CONFLICT', 'INPUT', 'INTERNAL', 'FAILED'] as const
export type CommonErrorKey = (typeof COMMON_ERROR_KEYS)[number]

/** Message key under adminSettings.errors for a failure no form explains in its own words. */
export function commonErrorKey(failure: SettingsFailure): CommonErrorKey {
  switch (failure.code) {
    case 'UNAUTHENTICATED':
    case 'FORBIDDEN':
    case 'NOT_FOUND':
    case 'INTERNAL':
      return failure.code
    case 'RATE_LIMITED':
      return 'BUSY'
    case 'IDEMPOTENCY_CONFLICT':
      return 'CONFLICT'
    case 'VALIDATION_FAILED':
      return 'INPUT'
    default:
      return 'FAILED'
  }
}
