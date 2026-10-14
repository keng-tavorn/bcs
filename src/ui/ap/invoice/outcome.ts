// What a server action of the tier-2 invoice screens returns to its part of the page (spec §14.2, §9.9 rule 7): what
// happened — the invoice's status after it, its number once submitted — or the error code with the parts of `details`
// the screen needs to say what happened and how to fix it. Never the raw message.

export type ApOutcome = { readonly ok: true; readonly status?: string; readonly number?: string } | ApFailure

export interface ApFailure {
  readonly ok: false
  readonly code: string
  readonly reason?: string
  readonly field?: string
  /** CODING_NOT_CONFIRMED: the line numbers still to confirm */
  readonly lines?: string
  /** VARIANCE_NOT_ACCEPTABLE: the kind of difference that is not approved */
  readonly type?: string
  /** WHT_TYPE_NOT_CONFIGURED, WHT_FORM_PAYEE_MISMATCH: the income type */
  readonly incomeType?: string
  /** INTERNAL: the reference support finds in the logs */
  readonly requestId?: string
}

/** The actions of the page, each a server action taking the raw input and one submission's idempotency key */
export interface ApInvoiceActions {
  readonly update: (input: unknown, idempotencyKey: string) => Promise<ApOutcome>
  readonly confirmCoding: (input: unknown, idempotencyKey: string) => Promise<ApOutcome>
  readonly submit: (input: unknown, idempotencyKey: string) => Promise<ApOutcome>
  readonly cancel: (input: unknown, idempotencyKey: string) => Promise<ApOutcome>
  readonly recheck: (input: unknown, idempotencyKey: string) => Promise<ApOutcome>
  readonly reopen: (input: unknown, idempotencyKey: string) => Promise<ApOutcome>
  readonly reject: (input: unknown, idempotencyKey: string) => Promise<ApOutcome>
  readonly dismiss: (input: unknown, idempotencyKey: string) => Promise<ApOutcome>
  readonly variance: (input: unknown, idempotencyKey: string) => Promise<ApOutcome>
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)

/** Picks the screen-safe parts of a service error */
export function toApFailure(error: { code: string; details?: Readonly<Record<string, unknown>> }): ApFailure {
  const d = error.details ?? {}
  const pick = { reason: text(d.reason), field: text(d.field), lines: text(d.lines), type: text(d.type), incomeType: text(d.code), requestId: text(d.requestId) }
  return { ok: false, code: error.code, ...Object.fromEntries(Object.entries(pick).filter(([, v]) => v !== undefined)) }
}

/** An action that got no answer (the connection dropped): not certain it was done; press the same button again */
export const AP_NO_ANSWER: ApFailure = { ok: false, code: 'NO_ANSWER' }

export const AP_ERROR_KEYS = [
  'NO_ANSWER',
  'FORBIDDEN',
  'MODULE_DISABLED',
  'NOT_FOUND',
  'CONFLICT_VERSION',
  'INVALID_STATE_TRANSITION',
  'SOD_VIOLATION',
  'DUPLICATE_INVOICE',
  'AI_REVIEW_PENDING',
  'CODING_NOT_CONFIRMED',
  'VARIANCE_NOT_ACCEPTABLE',
  'WHT_TYPE_NOT_CONFIGURED',
  'WHT_FORM_PAYEE_MISMATCH',
  'TAX_RATE_NOT_CONFIGURED',
  'DOA_NOT_CONFIGURED',
  'APPROVER_NOT_FOUND',
  'BUDGET_INSUFFICIENT',
  'REQUIRED',
  'IN_THE_FUTURE',
  'ACCOUNT_CODE_UNKNOWN',
  'COST_CENTER_UNKNOWN',
  'COST_CENTER_REASON_REQUIRED',
  'DISCOUNT_ABOVE_AMOUNT',
  'QUANTITY_NOT_POSITIVE',
  'AMOUNT_NOT_POSITIVE',
  'NO_CHANGE',
  'REASON_REQUIRED',
  'AMOUNT',
  'BUSY',
  'CONFLICT',
  'UNAUTHENTICATED',
  'INTERNAL',
  'FAILED',
] as const
export type ApErrorKey = (typeof AP_ERROR_KEYS)[number]

const REASONS: ReadonlySet<string> = new Set(['REQUIRED', 'IN_THE_FUTURE', 'ACCOUNT_CODE_UNKNOWN', 'COST_CENTER_UNKNOWN', 'COST_CENTER_REASON_REQUIRED', 'DISCOUNT_ABOVE_AMOUNT', 'QUANTITY_NOT_POSITIVE', 'AMOUNT_NOT_POSITIVE', 'NO_CHANGE', 'REASON_REQUIRED', 'AMOUNT'])

/** Message key under apInvoice.errors */
export function apErrorKey(failure: ApFailure): ApErrorKey {
  const { code, reason } = failure
  if (code === 'VALIDATION_FAILED') return reason && REASONS.has(reason) ? (reason as ApErrorKey) : 'FAILED'
  if (code === 'RATE_LIMITED') return 'BUSY'
  if (code === 'IDEMPOTENCY_CONFLICT') return 'CONFLICT'
  return (AP_ERROR_KEYS as readonly string[]).includes(code) ? (code as ApErrorKey) : 'FAILED'
}
