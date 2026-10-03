import { ETAX_MAX_MIB } from './limits'
import type { EtaxPrefillView, EtaxProblemKey, InvoiceDoneView, InvoicePreviewView } from './types'

// What a finance server action or route returns to its form (spec §14.2, §9.9 rule 7): success with what happened, or
// the error code with the parts of `details` the screen needs to say what happened and how to fix it — never the raw
// message. Amounts arrive as decimal text (satang never leaves the server as a float).

export type FinanceFailure = {
  readonly ok: false
  readonly code: string
  readonly reason?: string
  readonly field?: string
  /** DUPLICATE_INVOICE: the number as compared (spaces removed, upper case) */
  readonly invoiceNo?: string
  /** INVOICE_EXCEEDS_COMMITTED: what the PO still holds, formatted */
  readonly remaining?: string
  /** NOTHING_TO_EXPORT: invoices kept out for a missing vendor code */
  readonly excluded?: number
  /** INTERNAL: the reference support finds in the logs */
  readonly requestId?: string
}

export type PreviewOutcome = { readonly ok: true; readonly preview: InvoicePreviewView } | FinanceFailure
export type RecordOutcome = { readonly ok: true; readonly done: InvoiceDoneView } | FinanceFailure
export type EtaxOutcome =
  | {
      readonly ok: true
      /** The stored file, to be kept with the invoice */
      readonly fileId: string
      readonly fileName: string
      readonly prefill: EtaxPrefillView | null
      readonly problems: readonly EtaxProblemKey[]
    }
  | FinanceFailure
export type ExportOutcome =
  | { readonly ok: true; readonly exportJobId: string; readonly fileId: string; readonly rowCount: number; readonly total: string; readonly checksum: string; readonly excluded: number }
  | FinanceFailure

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)

/** Picks the screen-safe parts of a service error; `remaining` is formatted by the caller */
export function toFinanceFailure(error: { code: string; details?: Readonly<Record<string, unknown>> }, remaining?: string): FinanceFailure {
  const d = error.details ?? {}
  const pick = {
    reason: text(d.reason),
    field: text(d.field),
    invoiceNo: text(d.invoiceNo),
    remaining,
    excluded: typeof d.excluded === 'number' ? d.excluded : undefined,
    requestId: text(d.requestId),
  }
  return { ok: false, code: error.code, ...Object.fromEntries(Object.entries(pick).filter(([, v]) => v !== undefined)) }
}

export const FINANCE_ERROR_KEYS = [
  'DUPLICATE_INVOICE',
  'EXCEEDS',
  'FINAL_RECORDED',
  'STATE',
  'INVOICE_NO',
  'INVOICE_DATE',
  'NET',
  'NET_NOT_POSITIVE',
  'VAT',
  'FILE',
  'FILE_OTHER_PO',
  'FILE_IN_USE',
  'FILE_SELLER',
  'FILE_TYPE',
  'FILE_EMPTY',
  'FILE_TOO_LARGE',
  'REASON',
  'CONFIRM',
  'PENDING_CHANGED',
  'MAPPING_NOT_SET',
  'NOTHING_TO_EXPORT',
  'NOTHING_TO_EXPORT_HELD',
  'ENCODING',
  'BUDGET',
  'FORBIDDEN',
  'NOT_FOUND',
  'BUSY',
  'CONFLICT',
  'UNAUTHENTICATED',
  'INVALID',
  'SERVER',
  'INTERNAL',
  'FAILED',
] as const
export type FinanceErrorKey = (typeof FINANCE_ERROR_KEYS)[number]

/** The code a page gives a call that got no answer at all (the network): "check the connection" */
export const NO_ANSWER = 'FAILED'
/** The code a page gives an answer it cannot read (not the app's JSON: a proxy's or the host's own error page) */
export const UNREADABLE_ANSWER = 'SERVER'

/** Message key under finance.errors for a failed preview, invoice, e-Tax reading or export */
export function financeErrorKey(failure: FinanceFailure): FinanceErrorKey {
  const { code, reason, field } = failure
  switch (code) {
    case 'DUPLICATE_INVOICE':
      return 'DUPLICATE_INVOICE'
    case 'INVOICE_EXCEEDS_COMMITTED':
      return 'EXCEEDS'
    case 'INVALID_STATE_TRANSITION':
      return reason === 'FINAL_RECORDED' ? 'FINAL_RECORDED' : 'STATE'
    case 'VALIDATION_FAILED':
      if (reason === 'AMOUNT_NOT_POSITIVE') return 'NET_NOT_POSITIVE'
      if (reason === 'TYPE_NOT_ALLOWED') return 'FILE_TYPE'
      if (reason === 'EMPTY') return 'FILE_EMPTY'
      if (reason === 'TOO_LARGE') return 'FILE_TOO_LARGE'
      if (reason === 'FILE_OTHER_PO') return 'FILE_OTHER_PO'
      if (reason === 'FILE_IN_USE') return 'FILE_IN_USE'
      if (reason === 'TAX_ID_MISMATCH') return 'FILE_SELLER'
      if (reason === 'FILE' || reason === 'NOT_AS_READ' || field === 'sourceFileId') return 'FILE'
      if (reason === 'REASON_REQUIRED' || field === 'reason') return 'REASON'
      if (reason === 'MAPPING_NOT_SET') return 'MAPPING_NOT_SET'
      if (reason === 'NOTHING_TO_EXPORT') return failure.excluded ? 'NOTHING_TO_EXPORT_HELD' : 'NOTHING_TO_EXPORT'
      if (reason === 'ENCODING') return 'ENCODING'
      if (field === 'confirm') return 'CONFIRM'
      if (field === 'invoiceNo') return 'INVOICE_NO'
      if (field === 'invoiceDate') return 'INVOICE_DATE'
      if (field === 'vat') return 'VAT'
      if (field === 'net') return 'NET'
      // Refused for something the form does not ask about (an export again of too many invoices, a changed page)
      return 'INVALID'
    case 'BUDGET_LINE_CLOSED':
    case 'BUDGET_INSUFFICIENT':
      return 'BUDGET'
    case 'FORBIDDEN':
    case 'NOT_FOUND':
    case 'UNAUTHENTICATED':
    case 'INTERNAL':
      return code
    case 'RATE_LIMITED':
      return 'BUSY'
    case 'CONFLICT_VERSION':
      return reason === 'PENDING_CHANGED' ? 'PENDING_CHANGED' : 'CONFLICT'
    case 'IDEMPOTENCY_CONFLICT':
      return 'CONFLICT'
    case NO_ANSWER:
      return 'FAILED'
    default:
      return 'SERVER'
  }
}

/** The values every finance.errors message may use */
export function financeErrorValues(failure: FinanceFailure): { invoiceNo: string; remaining: string; excluded: number; requestId: string; limit: number } {
  return { invoiceNo: failure.invoiceNo ?? '-', remaining: failure.remaining ?? '-', excluded: failure.excluded ?? 0, requestId: failure.requestId ?? '-', limit: ETAX_MAX_MIB }
}

/**
 * What the e-Tax route answered, from its status and its body read as JSON (undefined when it was not JSON): the
 * route's own answer, or the reason in the form's words when the host refused the body before the route saw it (413)
 * or something other than the app answered
 */
export function etaxOutcomeOf(status: number, body: unknown): EtaxOutcome {
  const TOO_LARGE_STATUS = 413
  if (status === TOO_LARGE_STATUS) return { ok: false, code: 'VALIDATION_FAILED', field: 'file', reason: 'TOO_LARGE' }
  if (body !== null && typeof body === 'object' && typeof (body as { ok?: unknown }).ok === 'boolean' && ((body as { ok: boolean }).ok || typeof (body as { code?: unknown }).code === 'string')) return body as EtaxOutcome
  return { ok: false, code: UNREADABLE_ANSWER }
}
