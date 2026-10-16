// What a server action of the bank-account screens (S9-09) returns to its form (spec §14.2, §9.9 rule 7): success with
// what the screen needs next, or the error code with the parts of `details` the screen needs to say what happened and
// how to fix it — never the raw message. NO_ANSWER is the form's own code when the call threw. A number opened whole
// travels only in RevealOutcome, to the one member who asked (every opening is logged by the service, NFR-PRIV-03).

export type BankFailure = {
  readonly ok: false
  readonly code: string
  readonly reason?: string
  readonly field?: string
  /** CHANGE_OPEN: the request already open for the supplier or the account */
  readonly changeId?: string
}

export type BankOutcome =
  | {
      readonly ok: true
      readonly changeId?: string
      readonly version?: number
      readonly number?: string
      /** SHARED_BANK_ACCOUNT: the same account is the account in force of a supplier with another tax id (BR-PAY-06) */
      readonly warnings?: readonly string[]
    }
  | BankFailure

export type RevealOutcome = { readonly ok: true; readonly accountNo: string | null; readonly targetAccountNo: string | null } | BankFailure

export const BANK_NO_ANSWER: BankFailure = { ok: false, code: 'NO_ANSWER' }

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)

/** Picks the screen-safe parts of a service error */
export function toBankFailure(error: { code: string; details?: Readonly<Record<string, unknown>> }): BankFailure {
  const d = error.details ?? {}
  const reason = text(d.reason)
  const field = text(d.field)
  const changeId = text(d.changeId)
  return { ok: false, code: error.code, ...(reason ? { reason } : {}), ...(field ? { field } : {}), ...(changeId ? { changeId } : {}) }
}

/** The reasons of VALIDATION_FAILED the screens put in words (src/server/services/bank-accounts/index.ts, BR-SUP-07) */
export const BANK_REASONS = [
  'REQUIRED',
  'OWNER',
  'TARGET',
  'CLOSE_HAS_ACCOUNT',
  'CHANGE_OPEN',
  'ACCOUNT_EXISTS',
  'TARGET_NOT_FOUND',
  'TARGET_NOT_ACTIVE',
  'NOTE_HAS_ACCOUNT_NO',
  'NOTHING',
  'FILE',
  'TYPE_NOT_ALLOWED',
  'ALREADY_ATTACHED',
  'TOO_MANY',
  'PROOF_REQUIRED',
  'CALL_VERIFICATION_REQUIRED',
  'NO_DEPARTMENT',
  'ACCOUNT_NO_FORMAT',
  'ACCOUNT_NO_LENGTH',
  'BANK_CODE_UNKNOWN',
  'ACCOUNT_NAME_FORMAT',
  'REASON_SHORT',
  'NOTE_SHORT',
  'NOTE_LONG',
] as const

/** The error codes the screens put in words; any other is said as "something went wrong" with what to do */
export const BANK_CODES = [
  'NO_ANSWER',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'MODULE_DISABLED',
  'CONFLICT_VERSION',
  'IDEMPOTENCY_CONFLICT',
  'INVALID_STATE_TRANSITION',
  'DOA_NOT_CONFIGURED',
  'DOA_AMBIGUOUS',
  'APPROVER_NOT_FOUND',
  'NO_HIGHER_AUTHORITY',
  'RATE_LIMITED',
] as const

export type BankErrorKey = `reason.${(typeof BANK_REASONS)[number]}` | `code.${(typeof BANK_CODES)[number]}` | 'code.OTHER' | 'reason.OTHER'

/** The key of a failure's words under bankAccount.errors */
export function bankErrorKey(failure: BankFailure): BankErrorKey {
  if (failure.code === 'VALIDATION_FAILED') {
    return failure.reason && (BANK_REASONS as readonly string[]).includes(failure.reason) ? (`reason.${failure.reason}` as BankErrorKey) : 'reason.OTHER'
  }
  return (BANK_CODES as readonly string[]).includes(failure.code) ? (`code.${failure.code}` as BankErrorKey) : 'code.OTHER'
}
