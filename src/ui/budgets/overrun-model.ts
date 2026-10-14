import type { BadgeLook } from '../document/badge-looks'
import { commonBudgetErrorKey, type CommonBudgetErrorKey } from './outcome'

// The screens of an over-budget approval (S6-16 · FR-BUD-101 · BR-BUD-12 to BR-BUD-15): its states as the badges of
// §9.10, what its requester may still do with it, what the ask form checks before it sends, and what the server
// actions return — success, or the error code with the parts of `details` the screen needs to say what happened and how
// to fix it (§9.9 rule 7, §14.2), never the raw message. Pure, so it is tested on its own
// (tests/unit/budget-overrun-screens.test.ts).

export type OverrunStatus = 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'RETURNED' | 'CANCELLED' | 'CONSUMED' | 'LAPSED'

/**
 * Each state with its light colour, a lucide icon and the words (NFR-A11Y-03): waiting (warn, as a request waits), approved
 * and not yet used (ok), used by the request's submit (ok, done), returned (warn), not approved (danger), cancelled
 * (neutral) and lapsed — what it funded went back out of the line (neutral, closed)
 */
export const OVERRUN_BADGES: Readonly<Record<OverrunStatus, BadgeLook>> = {
  PENDING_APPROVAL: { tone: 'warn', icon: 'Clock' },
  APPROVED: { tone: 'ok', icon: 'CircleCheck' },
  CONSUMED: { tone: 'ok', icon: 'CircleCheckBig' },
  RETURNED: { tone: 'warn', icon: 'Undo2' },
  REJECTED: { tone: 'danger', icon: 'CircleX' },
  CANCELLED: { tone: 'neutral', icon: 'Ban' },
  LAPSED: { tone: 'neutral', icon: 'Lock' },
}

/** One over-budget approval in the request page's list, its words ready (app/(workspace)/budgets/overruns/_present.ts) */
export interface OverrunRowView {
  readonly id: string
  readonly number: string
  readonly href: string
  readonly status: OverrunStatus
  readonly statusLabel: string
  readonly shortfall: string
  /** Where it stands for the request, when it still matters: waiting (the request is locked) or set aside until a day */
  readonly hint: string | null
  /** Its requester may cancel it now */
  readonly cancel: boolean
  readonly mine: boolean
}

export interface OverrunPanelView {
  readonly title: string
  /** What is short on the line, for the requester who may ask now; null otherwise */
  readonly short: { readonly headline: string; readonly amounts: ReadonlyArray<{ readonly label: string; readonly value: string; readonly total?: boolean }>; readonly unit: string; readonly hint: string } | null
  readonly canAsk: boolean
  /** "60,000.00", named in the ask Dialog */
  readonly shortfall: string | null
  readonly listLabel: string
  readonly rows: readonly OverrunRowView[]
}

/** Its requester cancels it while it waits, or once approved before the request's submit uses it (§6.4) */
export const overrunCancellable = (status: OverrunStatus, mine: boolean): boolean => mine && (status === 'PENDING_APPROVAL' || status === 'APPROVED')

export const REASON_MIN = 3

/** The reason the approver reads: at least REASON_MIN characters once trimmed, at most `max` */
export function overrunReasonError(reason: string, max: number): 'REASON' | 'REASON_TOO_LONG' | null {
  const trimmed = reason.trim()
  if (trimmed.length < REASON_MIN) return 'REASON'
  if (trimmed.length > max) return 'REASON_TOO_LONG'
  return null
}

export interface OverrunFailure {
  readonly ok: false
  readonly code: string
  readonly reason?: string
  readonly field?: string
  /** INTERNAL: the reference support finds in the logs */
  readonly requestId?: string
}

export type OverrunOutcome<T> = ({ readonly ok: true } & T) | OverrunFailure

/** Picks the screen-safe parts of a service error */
export function toOverrunFailure(error: { code: string; details?: Readonly<Record<string, unknown>> }): OverrunFailure {
  const d = error.details ?? {}
  return {
    ok: false,
    code: error.code,
    ...(typeof d.reason === 'string' ? { reason: d.reason } : {}),
    ...(typeof d.field === 'string' ? { field: d.field } : {}),
    ...(typeof d.requestId === 'string' ? { requestId: d.requestId } : {}),
  }
}

export type OverrunErrorKey =
  | 'DOA_NOT_CONFIGURED'
  | 'NOT_OVER_BUDGET'
  | 'LINE_NOT_OPEN'
  | 'OVERRUN_EXISTS'
  | 'NO_LINES'
  | 'REASON'
  | 'INPUT'
  | 'STATE'
  | 'NOT_FOUND'
  | 'NO_APPROVER'
  | 'TAX_RATE'
  | CommonBudgetErrorKey

/** Message key under budgetOverrun.errors for a refused ask or cancel */
export function overrunErrorKey(failure: OverrunFailure): OverrunErrorKey {
  switch (failure.code) {
    case 'DOA_NOT_CONFIGURED':
      return 'DOA_NOT_CONFIGURED'
    case 'INVALID_STATE_TRANSITION':
      return failure.reason === 'OVERRUN_EXISTS' ? 'OVERRUN_EXISTS' : 'STATE'
    case 'NOT_FOUND':
      return 'NOT_FOUND'
    case 'APPROVER_NOT_FOUND':
    case 'NO_HIGHER_AUTHORITY':
      return 'NO_APPROVER'
    case 'TAX_RATE_NOT_CONFIGURED':
      return 'TAX_RATE'
    case 'VALIDATION_FAILED':
      switch (failure.reason) {
        case 'NOT_OVER_BUDGET':
        case 'LINE_NOT_OPEN':
        case 'NO_LINES':
          return failure.reason
      }
      return failure.field === 'reason' ? 'REASON' : 'INPUT'
  }
  return commonBudgetErrorKey(failure)
}
