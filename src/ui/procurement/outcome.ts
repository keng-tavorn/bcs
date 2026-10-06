// What a server action of the procurement pool returns to its form (spec §14.2, §9.9 rule 7): what happened — the lines
// that got their supplier, the draft POs a round or an urgent request made, the lines left in the pool and why — or the
// error code with the parts of `details` the screen needs. Never the raw message. Amounts arrive formatted.

export interface DraftView {
  readonly id: string
  readonly supplierName: string
  readonly siteName: string | null
  readonly kind: 'GOODS' | 'SERVICE'
  readonly lineCount: number
  /** Formatted with thousands separators and 2 decimals, before VAT */
  readonly net: string
  readonly requestNumbers: readonly string[]
}

export type PoolOutcome =
  | {
      readonly ok: true
      /** Lines whose supplier changed */
      readonly assigned?: number
      /** Draft POs made: by the round, or at once for urgent requests (BR-CONS-02) */
      readonly drafts?: readonly DraftView[]
      /** After a round: lines still in the pool because they need a supplier, and drafted once they have one (BR-CONS-03) */
      readonly left?: number
      /** After a round: lines that got a supplier while it ran, for the next round */
      readonly waiting?: number
      /** After a round: lines no round drafts yet, with a supplier or without, because their request's prices include VAT (NEW-50) */
      readonly blocked?: number
    }
  | PoolFailure

export interface PoolFailure {
  readonly ok: false
  readonly code: string
  readonly reason?: string
  readonly field?: string
  /** INTERNAL: the reference support finds in the logs */
  readonly requestId?: string
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)

/** Picks the screen-safe parts of a service error */
export function toPoolFailure(error: { code: string; details?: Readonly<Record<string, unknown>> }): PoolFailure {
  const d = error.details ?? {}
  const pick = { reason: text(d.reason), field: text(d.field), requestId: text(d.requestId) }
  return { ok: false, code: error.code, ...Object.fromEntries(Object.entries(pick).filter(([, v]) => v !== undefined)) }
}

export const POOL_ERROR_KEYS = [
  'LINE_NOT_IN_POOL',
  'SUPPLIER_INACTIVE',
  'SUPPLIER',
  'NO_CHANGE',
  'FORBIDDEN',
  'NOT_FOUND',
  'BUSY',
  'CONFLICT',
  'UNAUTHENTICATED',
  'INTERNAL',
  'FAILED',
  'NO_ANSWER_ASSIGN',
  'NO_ANSWER_CLEAR',
  'NO_ANSWER_ROUND',
] as const
export type PoolErrorKey = (typeof POOL_ERROR_KEYS)[number]

/**
 * What a part of the pool holds when its server action gave no answer — the call threw: the connection dropped. The
 * server never answers this code. The choice or the round may have been done before the answer was lost (an urgent
 * request may have got its draft PO), so its words never say it failed (§9.9 rule 7): they say it is not certain, and to
 * press the same button again without changing anything — the part keeps its idempotency key until an answer comes
 * (./use-outcome-action.ts), so that press is the same submission and is done once (spec §4.3)
 */
export const POOL_NO_ANSWER: PoolFailure = { ok: false, code: 'NO_ANSWER' }

/** The actions of the pool: choosing the supplier of the ticked lines, taking it off them, and a round run by hand */
export type PoolAction = 'assign' | 'clear' | 'round'

const NO_ANSWER_KEYS = { assign: 'NO_ANSWER_ASSIGN', clear: 'NO_ANSWER_CLEAR', round: 'NO_ANSWER_ROUND' } as const satisfies Record<PoolAction, PoolErrorKey>

/** Message key under procurement.pool.errors */
export function poolErrorKey(failure: PoolFailure): PoolErrorKey {
  const { code, reason } = failure
  if (code === 'VALIDATION_FAILED') {
    if (reason === 'LINE_NOT_IN_POOL' || reason === 'SUPPLIER_INACTIVE' || reason === 'SUPPLIER' || reason === 'NO_CHANGE') return reason
    return 'FAILED'
  }
  if (code === 'FORBIDDEN' || code === 'NOT_FOUND' || code === 'UNAUTHENTICATED' || code === 'INTERNAL') return code
  if (code === 'RATE_LIMITED') return 'BUSY'
  if (code === 'IDEMPOTENCY_CONFLICT') return 'CONFLICT'
  return 'FAILED'
}

/** Message key under procurement.pool.errors of an action that did not go through: no answer in the action's own words, a refusal as poolErrorKey */
export function poolActionErrorKey(failure: PoolFailure, action: PoolAction): PoolErrorKey {
  return failure.code === POOL_NO_ANSWER.code ? NO_ANSWER_KEYS[action] : poolErrorKey(failure)
}
