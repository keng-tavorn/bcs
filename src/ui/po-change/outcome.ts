import { BASIS_POINTS_WHOLE, BP_PER_PERCENT } from '@/lib/constants'

// What the server actions of S8's purchase-order parts return to their forms (spec §14.2, §9.9 rule 7): success, or
// the error code with the parts of `details` the screen needs to say what happened and how to fix it — never the raw
// message. Amounts arrive formatted as text (satang never leaves the server as a float).

export interface PoS8Failure {
  readonly ok: false
  readonly code: string
  readonly reason?: string
  readonly field?: string
  /** PO_CHANGE_EXCEEDS_REQUEST: what the request line has left */
  readonly left?: string
  /** The PO line the refusal is about */
  readonly lineNo?: number
  /** BUDGET_INSUFFICIENT: what is missing, when the member may see it */
  readonly shortfall?: string
  /** INTERNAL: the reference support finds in the logs */
  readonly requestId?: string
}

export type PoS8Outcome = { readonly ok: true; readonly status?: string } | PoS8Failure

export interface ChangeTotalsView {
  readonly oldNet: string
  readonly oldVat: string
  readonly oldGross: string
  readonly newNet: string
  readonly newVat: string
  readonly newGross: string
}

export type ChangePreviewOutcome = { readonly ok: true; readonly totals: ChangeTotalsView } | PoS8Failure

/** No answer came back (the network failed): the form says it is not certain, and the same press sends the same submission */
export const PO_S8_NO_ANSWER: PoS8Failure = { ok: false, code: 'NO_ANSWER' }

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)

/** Picks the screen-safe parts of a service error */
export function toPoS8Failure(error: { code: string; details?: Readonly<Record<string, unknown>> }): PoS8Failure {
  const d = error.details ?? {}
  const pick = { reason: text(d.reason), field: text(d.field), left: text(d.left), shortfall: text(d.shortfall), requestId: text(d.requestId) }
  return {
    ok: false,
    code: error.code,
    ...Object.fromEntries(Object.entries(pick).filter(([, v]) => v !== undefined)),
    ...(typeof d.lineNo === 'number' ? { lineNo: d.lineNo } : {}),
  }
}

/** The words of a refusal, as the key under poChange.errors (each with its fix) */
export function failureKey(failure: PoS8Failure): string {
  switch (failure.code) {
    case 'PO_CHANGE_OPEN':
    case 'PO_CHANGE_EXCEEDS_REQUEST':
    case 'DOA_NOT_CONFIGURED':
    case 'BUDGET_INSUFFICIENT':
    case 'FORBIDDEN':
    case 'MODULE_DISABLED':
    case 'CONFLICT_VERSION':
    case 'INVALID_STATE_TRANSITION':
    case 'NOT_FOUND':
    case 'NO_ANSWER':
    case 'UNAUTHENTICATED':
    case 'APPROVER_NOT_FOUND':
    case 'NO_HIGHER_AUTHORITY':
    case 'SOD_VIOLATION':
    case 'EXTERNAL_SERVICE_ERROR':
    case 'INTERNAL':
      return failure.code
    case 'PO_CHANGE_BELOW_PROGRESS':
      return failure.reason === 'INVOICED' || failure.reason === 'LINE_INVOICED' || failure.reason === 'RECEIVED_IN_FULL' || failure.reason === 'CLOSE_SHORT_INSTEAD' ? `PO_CHANGE_BELOW_PROGRESS_${failure.reason}` : 'PO_CHANGE_BELOW_PROGRESS_RECEIVED'
    case 'VALIDATION_FAILED':
      switch (failure.reason) {
        case 'NO_CHANGE':
        case 'MERGED_LINE':
        case 'QUANTITY':
        case 'SHARES':
        case 'NOT_SERVICE':
        case 'ALREADY_SPLIT':
        case 'MISSING':
          return `VALIDATION_${failure.reason}`
        default:
          return failure.field === 'reason' ? 'VALIDATION_REASON' : 'VALIDATION_FAILED'
      }
    default:
      return 'other'
  }
}

/** "30" or "33.33" (a percent with up to 2 decimals) → basis points 3000 or 3333; anything else → null. No floats. */
export function percentToBp(value: string): number | null {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(value.trim())
  if (!m) return null
  const bp = Number(m[1]) * BP_PER_PERCENT + Number((m[2] ?? '').padEnd(2, '0'))
  return bp <= BASIS_POINTS_WHOLE ? bp : null
}

/** 3333 → "33.33", 3000 → "30" */
export function bpToPercent(bp: number): string {
  const whole = Math.trunc(bp / BP_PER_PERCENT)
  const part = bp % BP_PER_PERCENT
  return part === 0 ? String(whole) : `${whole}.${String(part).padStart(2, '0').replace(/0$/, '')}`
}
