import { commonBudgetErrorKey, type CommonBudgetErrorKey } from './outcome'

// What the server actions of the budget transfer screens return (S6-15 · FR-BUD-103): success with the transfer, or the
// error code with the parts of `details` the screen needs to say what happened and how to fix it (§9.9 rule 7, §14.2)
// — never the raw message. BUDGET_INSUFFICIENT carries the shortfall in baht text; DOA_NOT_CONFIGURED says the DOA in
// effect has no BUDGET_TRANSFER rule (AC4).

export interface TransferFailure {
  readonly ok: false
  readonly code: string
  readonly reason?: string
  readonly field?: string
  /** BUDGET_INSUFFICIENT: what the source lacks, baht text ("0.01") */
  readonly shortfall?: string
  readonly requestId?: string
}

export type TransferOutcome<T> = ({ readonly ok: true } & T) | TransferFailure

/** Picks the screen-safe parts of a service error */
export function toTransferFailure(error: { code: string; details?: Readonly<Record<string, unknown>> }): TransferFailure {
  const d = error.details ?? {}
  return {
    ok: false,
    code: error.code,
    ...(typeof d.reason === 'string' ? { reason: d.reason } : {}),
    ...(typeof d.field === 'string' ? { field: d.field } : {}),
    ...(typeof d.shortfall === 'string' ? { shortfall: d.shortfall } : {}),
    ...(typeof d.requestId === 'string' ? { requestId: d.requestId } : {}),
  }
}

export type TransferErrorKey =
  | 'INSUFFICIENT'
  | 'DOA_NOT_CONFIGURED'
  | 'LINES_DO_NOT_FIT_KIND'
  | 'SAME_LINE'
  | 'UNKNOWN_LINE'
  | 'LINE_NOT_OPEN'
  | 'OTHER_FISCAL_YEAR'
  | 'AMOUNT_NOT_POSITIVE'
  | 'INPUT'
  | 'STATE'
  | 'NOT_FOUND'
  | 'NO_APPROVER'
  | CommonBudgetErrorKey

/** Message key under budgetTransfer.errors for a refused create, send or cancel */
export function transferErrorKey(failure: TransferFailure): TransferErrorKey {
  switch (failure.code) {
    case 'BUDGET_INSUFFICIENT':
      return 'INSUFFICIENT'
    case 'DOA_NOT_CONFIGURED':
      return 'DOA_NOT_CONFIGURED'
    case 'INVALID_STATE_TRANSITION':
      return 'STATE'
    case 'NOT_FOUND':
      return 'NOT_FOUND'
    case 'APPROVER_NOT_FOUND':
      return 'NO_APPROVER'
    case 'VALIDATION_FAILED':
      switch (failure.reason) {
        case 'LINES_DO_NOT_FIT_KIND':
        case 'SAME_LINE':
        case 'LINE_NOT_OPEN':
        case 'OTHER_FISCAL_YEAR':
        case 'AMOUNT_NOT_POSITIVE':
          return failure.reason
        case 'UNKNOWN':
          return 'UNKNOWN_LINE'
      }
      return 'INPUT'
  }
  return commonBudgetErrorKey(failure)
}

/** The field of the form a refusal is about, so it is said beside it; null for the form as a whole */
export function transferErrorField(failure: TransferFailure): 'from' | 'to' | 'amount' | 'reason' | null {
  const key = transferErrorKey(failure)
  if (key === 'INSUFFICIENT' || key === 'AMOUNT_NOT_POSITIVE') return 'amount'
  if (key === 'SAME_LINE' || key === 'OTHER_FISCAL_YEAR') return 'to'
  if (key === 'UNKNOWN_LINE' || key === 'LINE_NOT_OPEN') return failure.field === 'toBudgetLineId' ? 'to' : 'from'
  if (key === 'INPUT') return failure.field === 'reason' ? 'reason' : failure.field === 'amount' ? 'amount' : null
  return null
}
