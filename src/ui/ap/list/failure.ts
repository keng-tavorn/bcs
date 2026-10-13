import type { ApFailure } from './outcome'

// The message key (apList.errors) of a failed tier-2 invoice action: what happened and how to fix it (§9.9 rule 7).

export type ApErrorKey =
  | 'NO_ANSWER'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'MODULE_DISABLED'
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'INVOICE_TRACK_MISMATCH'
  | 'IDEMPOTENCY_CONFLICT'
  | 'FILE_TYPE'
  | 'FILE_TOO_LARGE'
  | 'FILE_EMPTY'
  | 'FILE_IN_USE'
  | 'FILE_UNREADABLE'
  | 'REASON_REQUIRED'
  | 'REASON_TOO_LONG'
  | 'INVALID'
  | 'FAILED'

const BY_REASON: Readonly<Record<string, ApErrorKey>> = {
  TYPE_NOT_ALLOWED: 'FILE_TYPE',
  TOO_LARGE: 'FILE_TOO_LARGE',
  EMPTY: 'FILE_EMPTY',
  FILE_MISSING: 'FILE_EMPTY',
  FILE_IN_USE: 'FILE_IN_USE',
  FILE: 'FILE_UNREADABLE',
  FILE_OTHER_PO: 'FILE_UNREADABLE',
  REQUIRED: 'REASON_REQUIRED',
  TOO_LONG: 'REASON_TOO_LONG',
}

export function apErrorKey(failure: ApFailure): ApErrorKey {
  switch (failure.code) {
    case 'NO_ANSWER':
    case 'UNAUTHENTICATED':
    case 'FORBIDDEN':
    case 'MODULE_DISABLED':
    case 'NOT_FOUND':
    case 'INVOICE_TRACK_MISMATCH':
    case 'IDEMPOTENCY_CONFLICT':
      return failure.code
    case 'INVALID_STATE_TRANSITION':
    case 'CONFLICT_VERSION':
      return 'INVALID_STATE'
    case 'VALIDATION_FAILED':
      return (failure.reason && BY_REASON[failure.reason]) || 'INVALID'
    default:
      return 'FAILED'
  }
}
