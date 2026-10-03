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
      /** After a round: lines still in the pool because they need a supplier (BR-CONS-03) */
      readonly left?: number
      /** After a round: lines that got a supplier while it ran, for the next round */
      readonly waiting?: number
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

export const POOL_ERROR_KEYS = ['LINE_NOT_IN_POOL', 'SUPPLIER_INACTIVE', 'SUPPLIER', 'NO_CHANGE', 'FORBIDDEN', 'NOT_FOUND', 'BUSY', 'CONFLICT', 'UNAUTHENTICATED', 'INTERNAL', 'FAILED'] as const
export type PoolErrorKey = (typeof POOL_ERROR_KEYS)[number]

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
