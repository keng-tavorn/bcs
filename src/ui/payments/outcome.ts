// What a server action of the payment run screens returns to its part of the page (spec §14.2, §9.9 rule 7): what
// happened — the run made, a download address made now, whether the results completed the run — or the error code with
// the parts of `details` the screen needs to say what happened and how to fix it. Never the raw message.

export interface PayFailure {
  readonly ok: false
  readonly code: string
  readonly reason?: string
  readonly field?: string
  /** PAYMENT_FLAG_REASON_REQUIRED, PAYMENT_ITEM_NOT_POSITIVE, BANK_ACCOUNT_NOT_APPROVED: the supplier's code */
  readonly supplier?: string
  /** PAYMENT_FLAG_REASON_REQUIRED: the flag */
  readonly flag?: string
  /** DOCUMENT_NOT_PAYABLE: the invoice's number */
  readonly number?: string
  /** BANK_FILE_CHECK_FAILED: the checks that failed */
  readonly checks?: string
  /** SOD_VIOLATION: the rule */
  readonly rule?: string
  /** INTERNAL: the reference support finds in the logs */
  readonly requestId?: string
}

export type PayOutcome =
  | {
      readonly ok: true
      /** A run made (/finance/payments/new) */
      readonly paymentRunId?: string
      /** The proposed documents added to it, or why they were not */
      readonly added?: number
      readonly addFailure?: PayFailure
      /** A run sent for approval: its number */
      readonly number?: string
      /** A download: the address made now (five minutes) and the file's name */
      readonly url?: string
      readonly fileName?: string
      /** Results recorded: every item has its result and the run is complete */
      readonly completed?: boolean
    }
  | PayFailure

/** An action that got no answer (the connection dropped): not certain it was done; press the same button again */
export const PAY_NO_ANSWER: PayFailure = { ok: false, code: 'NO_ANSWER' }

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)

/** Picks the screen-safe parts of a service error */
export function toPayFailure(error: { code: string; details?: Readonly<Record<string, unknown>> }): PayFailure {
  const d = error.details ?? {}
  const pick = { reason: text(d.reason), field: text(d.field), supplier: text(d.supplier), flag: text(d.flag), number: text(d.number), checks: text(d.checks), rule: text(d.rule), requestId: text(d.requestId) }
  return { ok: false, code: error.code, ...Object.fromEntries(Object.entries(pick).filter(([, v]) => v !== undefined)) }
}

export const PAY_ERROR_KEYS = [
  'NO_ANSWER',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'MODULE_DISABLED',
  'NOT_FOUND',
  'STATE',
  'RESULTS_RECORDED',
  'CHANGED',
  'CONFLICT',
  'BUSY',
  'DATE_PAST',
  'DATE_NOT_BUSINESS_DAY',
  'NO_WORKING_DAY',
  'PAYER_NOT_ACTIVE',
  'DOCUMENT_NOT_PAYABLE',
  'PAYMENT_ITEM_NOT_POSITIVE',
  'BANK_ACCOUNT_NOT_APPROVED',
  'PAYMENT_FLAG_REASON_REQUIRED',
  'PAYMENT_FLAGS_CHANGED',
  'BANK_FILE_CHECK_FAILED',
  'TEMPLATE_NOT_BUILT',
  'EXPORT_CONFIRMATION_REQUIRED',
  'FILE_NOT_DOWNLOADED',
  'FILE_NOT_CURRENT',
  'PAID_ON_BEFORE_PAY_DATE',
  'PAID_ON_FUTURE',
  'ADVICE_EMAIL_OFF',
  'EMPTY',
  'NOTHING_CHOSEN',
  'REASON',
  'REFERENCE',
  'SOD',
  'DOA_NOT_CONFIGURED',
  'APPROVER_NOT_FOUND',
  'NO_HIGHER_AUTHORITY',
  'NO_DEPARTMENT',
  'INTERNAL',
  'FAILED',
] as const
export type PayErrorKey = (typeof PAY_ERROR_KEYS)[number]

const BY_REASON: Readonly<Record<string, PayErrorKey>> = {
  PAST: 'DATE_PAST',
  NOT_BUSINESS_DAY: 'DATE_NOT_BUSINESS_DAY',
  NO_WORKING_DAY: 'NO_WORKING_DAY',
  PAYER_NOT_ACTIVE: 'PAYER_NOT_ACTIVE',
  TEMPLATE_NOT_BUILT: 'TEMPLATE_NOT_BUILT',
  EXPORT_CONFIRMATION_REQUIRED: 'EXPORT_CONFIRMATION_REQUIRED',
  FILE_NOT_DOWNLOADED: 'FILE_NOT_DOWNLOADED',
  FILE_NOT_CURRENT: 'FILE_NOT_CURRENT',
  PAID_ON_BEFORE_PAY_DATE: 'PAID_ON_BEFORE_PAY_DATE',
  PAID_ON_FUTURE: 'PAID_ON_FUTURE',
  ADVICE_EMAIL_OFF: 'ADVICE_EMAIL_OFF',
  EMPTY: 'EMPTY',
  NO_DEPARTMENT: 'NO_DEPARTMENT',
  NOTHING_CHOSEN: 'NOTHING_CHOSEN',
}

/** By the last part of the field's path ("allPaidExcept.failed.0.reason" → reason) */
const BY_FIELD: Readonly<Record<string, PayErrorKey>> = { reason: 'REASON', bankReference: 'REFERENCE' }

const BY_CODE: Readonly<Record<string, PayErrorKey>> = {
  NO_ANSWER: 'NO_ANSWER',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  MODULE_DISABLED: 'MODULE_DISABLED',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT_VERSION: 'CHANGED',
  IDEMPOTENCY_CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'BUSY',
  DOCUMENT_NOT_PAYABLE: 'DOCUMENT_NOT_PAYABLE',
  PAYMENT_ITEM_NOT_POSITIVE: 'PAYMENT_ITEM_NOT_POSITIVE',
  BANK_ACCOUNT_NOT_APPROVED: 'BANK_ACCOUNT_NOT_APPROVED',
  PAYMENT_FLAG_REASON_REQUIRED: 'PAYMENT_FLAG_REASON_REQUIRED',
  PAYMENT_FLAGS_CHANGED: 'PAYMENT_FLAGS_CHANGED',
  BANK_FILE_CHECK_FAILED: 'BANK_FILE_CHECK_FAILED',
  SOD_VIOLATION: 'SOD',
  DOA_NOT_CONFIGURED: 'DOA_NOT_CONFIGURED',
  APPROVER_NOT_FOUND: 'APPROVER_NOT_FOUND',
  NO_HIGHER_AUTHORITY: 'NO_HIGHER_AUTHORITY',
  INTERNAL: 'INTERNAL',
}

/** Message key under payRun.errors */
export function payErrorKey(failure: PayFailure): PayErrorKey {
  const { code, reason, field } = failure
  if (code === 'INVALID_STATE_TRANSITION') return reason === 'RESULTS_RECORDED' ? 'RESULTS_RECORDED' : 'STATE'
  if (code === 'PAYMENT_DATE_INVALID') return reason === 'PAST' ? 'DATE_PAST' : 'DATE_NOT_BUSINESS_DAY'
  if (code === 'VALIDATION_FAILED') return (reason && BY_REASON[reason]) || (field && BY_FIELD[field.split('.').at(-1) ?? '']) || 'FAILED'
  return BY_CODE[code] ?? 'FAILED'
}
