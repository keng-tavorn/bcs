// What the budget pages' server actions return to their forms: success with what the screen reports, or the error
// code with the parts of `details` the screen needs to say what happened and how to fix it (§9.9 rule 7, §14.2) —
// never the raw message. The shapes mirror the services' DTOs (src/server/services/budget), which screens cannot import.

export const IMPORT_FIELDS = ['fiscalYear', 'department', 'costCenter', 'code', 'nameTh', 'accountCode', 'amount'] as const
export type ImportField = (typeof IMPORT_FIELDS)[number]

export const IMPORT_REASONS = [
  'REQUIRED',
  'TOO_LONG',
  'INVALID_AMOUNT',
  'DUPLICATE_IN_FILE',
  'UNKNOWN_FISCAL_YEAR',
  'FISCAL_YEAR_CLOSED',
  'UNKNOWN_DEPARTMENT',
  'UNKNOWN_COST_CENTER',
  'COST_CENTER_OF_ANOTHER_DEPARTMENT',
  'LINE_OF_ANOTHER_DEPARTMENT',
  'NO_ROWS',
  'TOO_MANY_ROWS',
  'UNREADABLE',
  'MISSING_HEADER',
] as const
export type ImportReason = (typeof IMPORT_REASONS)[number]

export interface NameView {
  readonly th: string
  readonly en: string | null
}

export interface ImportCheckRowView {
  readonly row: number
  readonly values: Readonly<Record<ImportField, string>>
  readonly amount: { readonly amount: string } | null
  readonly errors: ReadonlyArray<{ readonly field: ImportField; readonly reason: ImportReason }>
  readonly action: 'CREATE' | 'ADD' | null
  readonly currentPlanned: { readonly amount: string } | null
  /** A row that adds to a line with another name, account code or cost center: the line keeps its own */
  readonly warnings: ReadonlyArray<{ readonly field: 'nameTh' | 'accountCode' | 'costCenter'; readonly reason: 'DIFFERS_FROM_LINE'; readonly current: string | null }>
}

/** The check of a file before it is imported (nothing saved) */
export interface ImportCheckView {
  readonly fileName: string
  /** sha256 of the file checked: sent with the import, which refuses another file (RECHECK) */
  readonly checksum: string
  readonly rows: readonly ImportCheckRowView[]
  readonly fileErrors: ReadonlyArray<{ readonly row: number; readonly reason: ImportReason }>
  readonly ready: boolean
  readonly total: { readonly amount: string }
  readonly creates: number
  readonly adds: number
  readonly duplicate: { readonly importedAt: string; readonly fileName: string; readonly importedBy: NameView | null } | null
}

export interface BudgetFailure {
  readonly ok: false
  readonly code: string
  readonly reason?: string
  readonly field?: string
  /** The rows the import refused (the organization changed after the check) */
  readonly rows?: ReadonlyArray<{ readonly row: number; readonly field: string; readonly reason: string }>
  /** the reference of an unexpected error (§14.2 INTERNAL), so support can find it in the logs */
  readonly requestId?: string
}

export type ImportCheckOutcome = { readonly ok: true; readonly check: ImportCheckView } | BudgetFailure
export type ImportOutcome = { readonly ok: true; readonly rows: number; readonly linesCreated: number; readonly total: { readonly amount: string } } | BudgetFailure
export type GrantOutcome = { readonly ok: true } | BudgetFailure

/** Picks the screen-safe parts of a service error */
export function toBudgetFailure(error: { code: string; details?: Readonly<Record<string, unknown>> }): BudgetFailure {
  const d = error.details ?? {}
  const rows = Array.isArray(d.rows)
    ? (d.rows as Array<Record<string, unknown>>).map((r) => ({ row: Number(r.row), field: String(r.field ?? 'file'), reason: String(r.reason ?? '') }))
    : undefined
  return {
    ok: false,
    code: error.code,
    ...(typeof d.reason === 'string' ? { reason: d.reason } : {}),
    ...(typeof d.field === 'string' ? { field: d.field } : {}),
    ...(rows ? { rows } : {}),
    ...(typeof d.requestId === 'string' ? { requestId: d.requestId } : {}),
  }
}

/** Failures every budget form explains the same way */
export type CommonBudgetErrorKey = 'FORBIDDEN' | 'UNAUTHENTICATED' | 'BUSY' | 'CONFLICT' | 'INTERNAL' | 'FAILED'

export function commonBudgetErrorKey(failure: BudgetFailure): CommonBudgetErrorKey {
  switch (failure.code) {
    case 'FORBIDDEN':
    case 'UNAUTHENTICATED':
    case 'INTERNAL':
      return failure.code
    case 'RATE_LIMITED':
      return 'BUSY'
    case 'IDEMPOTENCY_CONFLICT':
      return 'CONFLICT'
    default:
      return 'FAILED'
  }
}

/**
 * The import's refusal after the check: the file must be checked again — the organization's data changed (rows), the
 * same file came in meanwhile (DUPLICATE_FILE), or the file sent is not the one checked (RECHECK)
 */
export const needsRecheck = (failure: BudgetFailure): boolean =>
  failure.code === 'VALIDATION_FAILED' && (Boolean(failure.rows?.length) || failure.reason === 'DUPLICATE_FILE' || failure.reason === 'RECHECK')

export type GrantErrorKey =
  | 'LINE'
  | 'LINE_CLOSED'
  | 'DEPARTMENT'
  | 'OWN_DEPARTMENT'
  | 'MEMBER'
  | 'FIRST_DAY'
  | 'LAST_DAY'
  | 'PERIOD'
  | 'PAST_PERIOD'
  | 'STATE'
  | 'NOT_FOUND'
  | 'INPUT'
  | CommonBudgetErrorKey

/** Message key under budgets.grants.errors for a failed grant or revoke */
export function grantErrorKey(failure: BudgetFailure): GrantErrorKey {
  if (failure.code === 'VALIDATION_FAILED') {
    switch (failure.reason) {
      case 'OWN_DEPARTMENT':
      case 'PERIOD':
      case 'PAST_PERIOD':
        return failure.reason
      case 'BUDGET_LINE_CLOSED':
        return 'LINE_CLOSED'
      case 'DEPARTMENT':
        return 'DEPARTMENT'
      case 'MEMBER':
        return 'MEMBER'
    }
    switch (failure.field) {
      case 'budgetLineId':
        return 'LINE'
      case 'granteeDepartmentId':
        return 'DEPARTMENT'
      case 'granteeMemberId':
        return 'MEMBER'
      case 'firstDay':
      case 'validFrom':
        return 'FIRST_DAY'
      case 'lastDay':
      case 'validTo':
        return 'LAST_DAY'
    }
    return 'INPUT'
  }
  if (failure.code === 'INVALID_STATE_TRANSITION') return 'STATE'
  if (failure.code === 'NOT_FOUND') return 'NOT_FOUND'
  return commonBudgetErrorKey(failure)
}
