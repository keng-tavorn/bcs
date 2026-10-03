// What a supplier action returns to its screen: success, or the error code with the parts of `details` the screen needs
// to say what happened and how to fix it (§9.9 rule 7, §14.2) — never the raw message. Pure, so the mapping is tested
// on its own (tests/unit/suppliers-screens.test.ts).

export interface SupplierFailure {
  readonly ok: false
  readonly code: string
  readonly field?: string
  readonly reason?: string
  /** SUPPLIER_EXISTS: the supplier that already has the tax id and branch */
  readonly supplierId?: string
  readonly existingCode?: string
  /** REGISTRY_PROOF_REQUIRED: what the registries answered at the save */
  readonly outcome?: string
  /** INTERNAL: the reference support finds in the logs */
  readonly requestId?: string
}

export type SupplierOutcome<T = object> = ({ readonly ok: true } & T) | SupplierFailure

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/** Picks the screen-safe parts of a service error */
export function toSupplierFailure(error: { code: string; details?: Readonly<Record<string, unknown>> }): SupplierFailure {
  const d = error.details ?? {}
  const out: Record<string, unknown> = { ok: false, code: error.code }
  const copy = { field: str(d.field), reason: str(d.reason), supplierId: str(d.supplierId), existingCode: str(d.code), outcome: str(d.outcome), requestId: str(d.requestId) }
  for (const [k, v] of Object.entries(copy)) if (v !== undefined) out[k] = v
  return out as unknown as SupplierFailure
}

/** Message keys under suppliers.errors */
export const SUPPLIER_ERROR_KEYS = [
  'TAX_ID_INVALID',
  'BRANCH',
  'SUPPLIER_EXISTS',
  'CODE_EXISTS',
  'CODE',
  'NAME',
  'EMAIL',
  'REGISTRY_CHECK_REQUIRED',
  'REGISTRY_PROOF_REQUIRED',
  'FILE',
  'NO_CHANGE',
  'CONFLICT_VERSION',
  'FORBIDDEN',
  'NOT_FOUND',
  'UNAUTHENTICATED',
  'SERVICE',
  'INPUT',
  'BUSY',
  'INTERNAL',
  'FAILED',
] as const
export type SupplierErrorKey = (typeof SUPPLIER_ERROR_KEYS)[number]

const BY_REASON: Readonly<Record<string, SupplierErrorKey>> = {
  TAX_ID_INVALID: 'TAX_ID_INVALID',
  BRANCH: 'BRANCH',
  SUPPLIER_EXISTS: 'SUPPLIER_EXISTS',
  CODE_EXISTS: 'CODE_EXISTS',
  REGISTRY_CHECK_REQUIRED: 'REGISTRY_CHECK_REQUIRED',
  REGISTRY_PROOF_REQUIRED: 'REGISTRY_PROOF_REQUIRED',
  FILE: 'FILE',
  NO_CHANGE: 'NO_CHANGE',
}

const BY_FIELD: Readonly<Record<string, SupplierErrorKey>> = {
  taxId: 'TAX_ID_INVALID',
  branchCode: 'BRANCH',
  code: 'CODE',
  nameTh: 'NAME',
  email: 'EMAIL',
}

/** Message key under suppliers.errors for a failed supplier action */
export function supplierErrorKey(f: SupplierFailure): SupplierErrorKey {
  if (f.code === 'VALIDATION_FAILED') return BY_REASON[f.reason ?? ''] ?? BY_FIELD[f.field ?? ''] ?? 'INPUT'
  switch (f.code) {
    case 'CONFLICT_VERSION':
    case 'FORBIDDEN':
    case 'NOT_FOUND':
    case 'UNAUTHENTICATED':
    case 'INTERNAL':
      return f.code
    case 'EXTERNAL_SERVICE_ERROR':
      return 'SERVICE'
    case 'RATE_LIMITED':
    case 'IDEMPOTENCY_CONFLICT':
      return 'BUSY'
    default:
      return 'FAILED'
  }
}

/** The steps of the new-supplier form (real steps of filling it in, §9.9) */
export const NEW_SUPPLIER_STEPS = ['identity', 'details', 'codes'] as const
export type NewSupplierStep = (typeof NEW_SUPPLIER_STEPS)[number]

/** The step where the user fixes what a failure is about */
export function supplierFailureStep(key: SupplierErrorKey): NewSupplierStep | null {
  switch (key) {
    case 'TAX_ID_INVALID':
    case 'BRANCH':
    case 'SUPPLIER_EXISTS':
    case 'REGISTRY_CHECK_REQUIRED':
    case 'REGISTRY_PROOF_REQUIRED':
    case 'FILE':
      return 'identity'
    case 'NAME':
      return 'details'
    case 'CODE':
    case 'CODE_EXISTS':
    case 'EMAIL':
      return 'codes'
    default:
      return null
  }
}
