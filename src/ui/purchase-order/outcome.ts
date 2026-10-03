// What a server action of the purchase-order page returns to its form (spec §14.2, §9.9 rule 7): success with the status
// the PO is in now — and for a sending, the code of a bounce (FR-P2P-005 AC2) — or the error code with the parts of
// `details` the screen needs to say what happened and how to fix it. Never the raw message; amounts as decimal text.

export type PoOutcome =
  | {
      readonly ok: true
      readonly status?: string
      /** po.send: the refusal's code when the e-mail bounced ("SMTP_550"); the PO keeps its status */
      readonly bounce?: string
    }
  | PoFailure

export interface PoFailure {
  readonly ok: false
  readonly code: string
  readonly reason?: string
  readonly field?: string
  /** QUANTITY_OVER_REQUEST: what the request line has left, decimal text */
  readonly left?: string
  /**
   * BUDGET_INSUFFICIENT: what is missing, decimal text (satang never leaves the server as a float) — present only when the
   * member may view the budget line (§2.4 budget.view); the service leaves it out for everyone else
   */
  readonly shortfall?: string
  /** INTERNAL: the reference support finds in the logs */
  readonly requestId?: string
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)

/** Picks the screen-safe parts of a service error */
export function toPoFailure(error: { code: string; details?: Readonly<Record<string, unknown>> }): PoFailure {
  const d = error.details ?? {}
  const pick = { reason: text(d.reason), field: text(d.field), left: text(d.left), shortfall: text(d.shortfall), requestId: text(d.requestId) }
  return { ok: false, code: error.code, ...Object.fromEntries(Object.entries(pick).filter(([, v]) => v !== undefined)) }
}

export const PO_ERROR_KEYS = [
  'STATE',
  'GR_POSTED',
  'SHORT_NOT_APPROVED',
  'CONFLICT_VERSION',
  'NO_CHANGE',
  'QUANTITY_OVER_REQUEST',
  'QUANTITY',
  'MERGED_LINE',
  'NO_LINES',
  'LINE',
  'SUPPLIER_INACTIVE',
  'NO_SOURCE_REQUEST',
  'EMAIL_MISSING',
  'REASON',
  'PAYMENT_DAYS',
  'NOTE',
  'LINES',
  'DISPOSITION',
  'BUDGET_INSUFFICIENT',
  'BUDGET_SHORTFALL',
  'CANCEL_BUDGET_INSUFFICIENT',
  'CANCEL_BUDGET_SHORTFALL',
  'BUDGET_LINE_CLOSED',
  'DOA_NOT_CONFIGURED',
  'APPROVER_NOT_FOUND',
  'NO_HIGHER_AUTHORITY',
  'TAX_RATE',
  'EMAIL_SERVICE',
  'FORBIDDEN',
  'NOT_FOUND',
  'BUSY',
  'CONFLICT',
  'UNAUTHENTICATED',
  'INTERNAL',
  'FAILED',
] as const
export type PoErrorKey = (typeof PO_ERROR_KEYS)[number]

const VALIDATION_REASONS: readonly PoErrorKey[] = ['NO_CHANGE', 'QUANTITY_OVER_REQUEST', 'QUANTITY', 'MERGED_LINE', 'NO_LINES', 'LINE', 'SUPPLIER_INACTIVE', 'NO_SOURCE_REQUEST']

/** Message key under purchaseOrder.errors */
export function poErrorKey(failure: PoFailure): PoErrorKey {
  const { code, reason, field } = failure
  switch (code) {
    case 'INVALID_STATE_TRANSITION':
      return reason === 'GR_POSTED' || reason === 'SHORT_NOT_APPROVED' ? reason : 'STATE'
    case 'VALIDATION_FAILED': {
      const byReason = VALIDATION_REASONS.find((k) => k === reason)
      if (byReason) return byReason
      // The field the input was refused for says what to fix
      if (field === 'supplierEmail') return 'EMAIL_MISSING'
      if (field === 'reason') return 'REASON'
      if (field === 'paymentTermDays') return 'PAYMENT_DAYS'
      if (field === 'notesToSupplier') return 'NOTE'
      if (field === 'disposition') return 'DISPOSITION'
      if (field?.startsWith('lines') || field === 'removeLineIds') return 'LINES'
      // A page that sent a malformed PO or version is out of date: reload it
      if (field === 'poId') return 'NOT_FOUND'
      if (field === 'expectedVersion') return 'CONFLICT_VERSION'
      return 'FAILED'
    }
    // How much is missing only for whoever may view the budget line; everyone else is told without amounts
    case 'BUDGET_INSUFFICIENT':
      return failure.shortfall ? 'BUDGET_SHORTFALL' : 'BUDGET_INSUFFICIENT'
    case 'CONFLICT_VERSION':
    case 'BUDGET_LINE_CLOSED':
    case 'DOA_NOT_CONFIGURED':
    case 'APPROVER_NOT_FOUND':
    case 'NO_HIGHER_AUTHORITY':
    case 'FORBIDDEN':
    case 'NOT_FOUND':
    case 'UNAUTHENTICATED':
    case 'INTERNAL':
      return code
    case 'TAX_RATE_NOT_CONFIGURED':
      return 'TAX_RATE'
    case 'EXTERNAL_SERVICE_ERROR':
      return 'EMAIL_SERVICE'
    case 'RATE_LIMITED':
      return 'BUSY'
    case 'IDEMPOTENCY_CONFLICT':
      return 'CONFLICT'
    default:
      return 'FAILED'
  }
}

/**
 * Message key of a failed cancellation: a lack of budget there means the request lines could not be reserved again for
 * the pool (RETURN_TO_POOL), so the message offers the other choice
 */
export function poCancelErrorKey(failure: PoFailure): PoErrorKey {
  const key = poErrorKey(failure)
  if (key === 'BUDGET_INSUFFICIENT') return 'CANCEL_BUDGET_INSUFFICIENT'
  if (key === 'BUDGET_SHORTFALL') return 'CANCEL_BUDGET_SHORTFALL'
  return key
}
