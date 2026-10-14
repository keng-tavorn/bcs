import { amountToSatang } from '@/core/money/dto'
import { formatSatang } from '@/core/money/format'
import { failedKey, NO_ANSWER, noAnswerKey, type ReceivingAction } from './failed'
import type { ReceiptPreviewView } from './types'

// What a receiving server action returns to its form (spec §14.2, §9.9 rule 7): success with what happened, or the
// error code with the parts of `details` the screen needs to say what happened and how to fix it — never the raw
// message. Amounts arrive as decimal text (satang never leaves the server as a float) and are shown with thousands
// separators and 2 decimals (§9.9 principle 6).

export type ReceivingFailure = {
  readonly ok: false
  readonly code: string
  readonly reason?: string
  readonly field?: string
  /** SOD_VIOLATION: BR-SOD-02 or BR-SOD-07 */
  readonly rule?: string
  /** VALIDATION_FAILED EXCESS_DISPOSITION_REQUIRED: the quantity beyond the tolerance */
  readonly excess?: string
  /** VALIDATION_FAILED DAMAGED_BEYOND_ORDER: how much of the damaged goods could be kept */
  readonly keepable?: string
  /**
   * BUDGET_INSUFFICIENT, formatted baht: only when the member may view the budget line (§2.4 budget.view) — the service
   * leaves them out otherwise, and the message then has no figures
   */
  readonly available?: string
  readonly shortfall?: string
  /** INTERNAL: the reference support finds in the logs */
  readonly requestId?: string
}

export type PostOutcome =
  | {
      readonly ok: true
      /** The new receipt's number (GR-2569-00012) */
      readonly number: string
      readonly poStatus: string
      /** Variances recorded by this receipt, and how many of them wait for an approver */
      readonly varianceCount: number
      readonly pendingApproval: number
    }
  | ReceivingFailure

export type PreviewOutcome = { readonly ok: true; readonly preview: ReceiptPreviewView } | ReceivingFailure

export type CloseShortOutcome = { readonly ok: true; readonly lines: number } | ReceivingFailure

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : typeof value === 'number' ? String(value) : undefined)

/** "12345.5" → "12,345.50"; anything that is not an amount is left out */
function baht(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    return formatSatang(amountToSatang(value))
  } catch {
    return undefined
  }
}

/** Picks the screen-safe parts of a service error. */
export function toReceivingFailure(error: { code: string; details?: Readonly<Record<string, unknown>> }): ReceivingFailure {
  const d = error.details ?? {}
  const pick = {
    reason: text(d.reason),
    field: text(d.field),
    rule: text(d.rule),
    excess: text(d.excess),
    keepable: text(d.keepable),
    available: baht(d.available),
    shortfall: baht(d.shortfall),
    requestId: text(d.requestId),
  }
  return { ok: false, code: error.code, ...Object.fromEntries(Object.entries(pick).filter(([, v]) => v !== undefined)) }
}

export const RECEIVING_ERROR_KEYS = [
  'SOD_APPROVER',
  'SOD_REQUESTER',
  'FORBIDDEN',
  'STATE',
  'CLOSE_SHORT_PENDING',
  'DAMAGED_PENDING',
  'NOTHING_SHORT',
  'QUANTITY',
  'NOTHING_RECEIVED',
  'EXCESS_CHOICE',
  'DAMAGED_CHOICE',
  'DAMAGED_BEYOND_ORDER',
  'PHOTO_REQUIRED',
  'PHOTO',
  'LINE',
  'REASON',
  'CONFIRM',
  'TOLERANCE',
  'AI_REVIEW_PENDING',
  'BUDGET_INSUFFICIENT',
  'BUDGET_INSUFFICIENT_PLAIN',
  'BUDGET_LINE_CLOSED',
  'NO_APPROVER',
  'NOT_FOUND',
  'BUSY',
  'CONFLICT',
  'UNAUTHENTICATED',
  'INTERNAL',
  'FAILED',
  'CHECK_FAILED',
  'NO_ANSWER',
] as const
export type ReceivingErrorKey = (typeof RECEIVING_ERROR_KEYS)[number]

/**
 * Message key under receiving.errors for a failed check (preview), receipt or close-short. A failure that tells no more
 * than that the action did not go through is worded for the action (./failed.ts): the check before recording passes
 * 'check', since it writes nothing. No answer from the server (NO_ANSWER) leaves recording uncertain — it says so, and
 * to press the same button again unchanged; a code the screen does not know is an answer: nothing was recorded.
 */
export function receivingErrorKey(failure: ReceivingFailure, action: ReceivingAction = 'record'): ReceivingErrorKey {
  const { code, reason, field } = failure
  switch (code) {
    case 'SOD_VIOLATION':
      // BR-SOD-07: the requester may not receive under this DOA · BR-SOD-02 (and anything else): an approver of the PR or PO
      return failure.rule === 'BR-SOD-07' ? 'SOD_REQUESTER' : 'SOD_APPROVER'
    case 'FORBIDDEN':
      return 'FORBIDDEN'
    case 'INVALID_STATE_TRANSITION':
      if (reason === 'CLOSE_SHORT_PENDING') return 'CLOSE_SHORT_PENDING'
      if (reason === 'DAMAGED_PENDING') return 'DAMAGED_PENDING'
      return 'STATE'
    case 'VALIDATION_FAILED':
      if (reason === 'EXCESS_DISPOSITION_REQUIRED') return 'EXCESS_CHOICE'
      if (reason === 'DAMAGED_DISPOSITION_REQUIRED') return 'DAMAGED_CHOICE'
      if (reason === 'DAMAGED_BEYOND_ORDER') return 'DAMAGED_BEYOND_ORDER'
      if (reason === 'PHOTO_REQUIRED') return 'PHOTO_REQUIRED'
      if (reason === 'FILE' || field === 'photoFileIds') return 'PHOTO'
      if (reason === 'NOTHING_SHORT') return 'NOTHING_SHORT'
      if (reason === 'NOTHING_RECEIVED') return 'NOTHING_RECEIVED'
      if (reason === 'LINE' || reason === 'DUPLICATE_LINE') return 'LINE'
      if (reason === 'TOLERANCE') return 'TOLERANCE'
      if (field === 'reason') return 'REASON'
      if (field === 'confirm') return 'CONFIRM'
      return 'QUANTITY'
    case 'BUDGET_INSUFFICIENT':
      // The figures come only to those who may view the budget line
      return failure.available && failure.shortfall ? 'BUDGET_INSUFFICIENT' : 'BUDGET_INSUFFICIENT_PLAIN'
    case 'BUDGET_LINE_CLOSED':
    case 'NOT_FOUND':
    case 'UNAUTHENTICATED':
    case 'INTERNAL':
      return code
    case 'DOA_NOT_CONFIGURED':
    case 'DOA_AMBIGUOUS':
    case 'APPROVER_NOT_FOUND':
    case 'NO_HIGHER_AUTHORITY':
      return 'NO_APPROVER'
    case 'RATE_LIMITED':
      return 'BUSY'
    // BR-AI-17: a quantity the AI read from the delivery note still waits for the receiver
    case 'AI_REVIEW_PENDING':
      return 'AI_REVIEW_PENDING'
    case 'IDEMPOTENCY_CONFLICT':
      return 'CONFLICT'
    // No answer (./failed.ts NO_ANSWER; the server never answers this code): recording may have gone through
    case NO_ANSWER.code:
      return noAnswerKey(action)
    default:
      return failedKey(action)
  }
}

/** The values a receiving.errors message may name, '-' for those the failure does not carry */
export function receivingErrorValues(failure: ReceivingFailure): Record<'excess' | 'keepable' | 'available' | 'shortfall' | 'requestId', string> {
  return {
    excess: failure.excess ?? '-',
    keepable: failure.keepable ?? '-',
    available: failure.available ?? '-',
    shortfall: failure.shortfall ?? '-',
    requestId: failure.requestId ?? '-',
  }
}
