// What a catalogue action returns to its screen (S6-10): success, or the error code with the parts of `details` the
// screen needs to say what happened and how to fix it (§9.9 rule 7, §14.2) — never the raw message. Pure, so the
// mapping is tested on its own (tests/unit/catalog-screens.test.ts).

export interface CatalogFailure {
  readonly ok: false
  readonly code: string
  readonly field?: string
  readonly reason?: string
  /** INTERNAL: the reference support finds in the logs */
  readonly requestId?: string
}

export type CatalogOutcome<T = object> = ({ readonly ok: true } & T) | CatalogFailure

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/** Picks the screen-safe parts of a service error */
export function toCatalogFailure(error: { code: string; details?: Readonly<Record<string, unknown>> }): CatalogFailure {
  const d = error.details ?? {}
  const out: Record<string, unknown> = { ok: false, code: error.code }
  const copy = { field: str(d.field), reason: str(d.reason), requestId: str(d.requestId) }
  for (const [k, v] of Object.entries(copy)) if (v !== undefined) out[k] = v
  return out as unknown as CatalogFailure
}

/** Message keys under catalog.errors */
export const CATALOG_ERROR_KEYS = [
  'CODE_EXISTS',
  'CODE',
  'NAME',
  'UOM',
  'CATEGORY',
  'PRICE',
  'PRICE_ZERO',
  'NO_CHANGE',
  'AGREEMENT_OVERLAP',
  'INVALID_PERIOD',
  'PERIOD_OVER',
  'SUPPLIER_UNKNOWN',
  'SUPPLIER',
  'DATE',
  'AGREEMENT_NOT_STARTED',
  'AGREEMENT_OVER',
  'FORBIDDEN',
  'NOT_FOUND',
  'UNAUTHENTICATED',
  'BUSY',
  'NO_ANSWER',
  'INTERNAL',
  'INPUT',
  'FAILED',
] as const
export type CatalogErrorKey = (typeof CATALOG_ERROR_KEYS)[number]

const BY_REASON: Readonly<Record<string, CatalogErrorKey>> = {
  CODE_EXISTS: 'CODE_EXISTS',
  NO_CHANGE: 'NO_CHANGE',
  AGREEMENT_OVERLAP: 'AGREEMENT_OVERLAP',
  INVALID_PERIOD: 'INVALID_PERIOD',
  PERIOD_OVER: 'PERIOD_OVER',
  AGREEMENT_NOT_STARTED: 'AGREEMENT_NOT_STARTED',
  AGREEMENT_OVER: 'AGREEMENT_OVER',
}

const BY_FIELD: Readonly<Record<string, CatalogErrorKey>> = {
  code: 'CODE',
  nameTh: 'NAME',
  uom: 'UOM',
  categoryCode: 'CATEGORY',
  refUnitPrice: 'PRICE',
  unitPrice: 'PRICE',
  supplierId: 'SUPPLIER',
  validFrom: 'DATE',
  validTo: 'DATE',
  lastDay: 'DATE',
}

/** Message key under catalog.errors for a failed catalogue action */
export function catalogErrorKey(f: CatalogFailure): CatalogErrorKey {
  const byReason = BY_REASON[f.reason ?? '']
  if (byReason) return byReason
  if (f.code === 'VALIDATION_FAILED') {
    if (f.field === 'supplierId' && f.reason === 'UNKNOWN') return 'SUPPLIER_UNKNOWN'
    return BY_FIELD[f.field ?? ''] ?? 'INPUT'
  }
  switch (f.code) {
    case 'FORBIDDEN':
    case 'NOT_FOUND':
    case 'UNAUTHENTICATED':
    case 'INTERNAL':
    case 'NO_ANSWER':
      return f.code
    case 'RATE_LIMITED':
    case 'IDEMPOTENCY_CONFLICT':
      return 'BUSY'
    default:
      return 'FAILED'
  }
}

/** The form field a failure is about, to say it beside that field ('lastDay' for the period's end); null: the form as a whole */
export function catalogErrorField(f: CatalogFailure): string | null {
  if (f.code !== 'VALIDATION_FAILED') return null
  if (f.reason === 'AGREEMENT_OVERLAP' || f.reason === 'NO_CHANGE') return null
  if (f.field === 'validTo') return 'lastDay'
  return f.field && f.field in BY_FIELD ? f.field : null
}
