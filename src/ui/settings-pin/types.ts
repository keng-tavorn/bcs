// What the server actions of /settings/pin answer the page (FR-AUTH-005 AC1): success with what the page needs next, or
// the error code with the parts of `details` the page explains in its own words (§9.9 rule 7). Never the raw message,
// never the PIN or the password back.

export type IdentityMethodView = 'PASSWORD' | 'TOTP'

export type ProveIdentityInputView = { readonly method: 'PASSWORD'; readonly password: string } | { readonly method: 'TOTP'; readonly code: string }

export interface PinFailure {
  readonly ok: false
  readonly code: string
  readonly field?: string
  readonly reason?: string
  /** When a lock ends, in the reader's language */
  readonly timeText?: string
  readonly requestId?: string
}

export interface PinProofView {
  /**
   * The proof of step 1, good for a few minutes and one PIN change. The page keeps it in its memory only and hands it
   * back with the new PIN: never in a URL, a cookie or storage.
   */
  readonly proofToken: string
  /** When the proof stops working, in the reader's language */
  readonly expiresAtText: string
}

export type ProveIdentityOutcome = ({ readonly ok: true } & PinProofView) | PinFailure
export type SetPinOutcome = { readonly ok: true; readonly replaced: boolean } | PinFailure

export type ProveIdentityAction = (input: ProveIdentityInputView) => Promise<ProveIdentityOutcome>
export type SetPinAction = (input: { readonly pin: string; readonly proofToken: string }, idempotencyKey: string) => Promise<SetPinOutcome>

export function toPinFailure(error: { code: string; details?: Readonly<Record<string, unknown>> }, timeText?: string): PinFailure {
  const d = error.details ?? {}
  return {
    ok: false,
    code: error.code,
    ...(typeof d.field === 'string' ? { field: d.field } : {}),
    ...(typeof d.reason === 'string' ? { reason: d.reason } : {}),
    ...(timeText ? { timeText } : {}),
    ...(typeof d.requestId === 'string' ? { requestId: d.requestId } : {}),
  }
}

type CommonKey = 'UNAUTHENTICATED' | 'FORBIDDEN' | 'BUSY' | 'INTERNAL' | 'FAILED'

function commonKey(failure: PinFailure): CommonKey {
  switch (failure.code) {
    case 'UNAUTHENTICATED':
    case 'FORBIDDEN':
    case 'INTERNAL':
      return failure.code
    case 'RATE_LIMITED':
      return 'BUSY'
    default:
      return 'FAILED'
  }
}

export type ProveErrorKey = 'PASSWORD_REQUIRED' | 'PASSWORD_WRONG' | 'CODE_FORMAT' | 'CODE_WRONG' | 'TOTP_NOT_AVAILABLE' | 'NOT_AVAILABLE' | 'ACCOUNT_LOCKED' | CommonKey

/** Message key under pinSettings.errors for a refused proof (confirmIdentityForPin); the field it belongs under, if any */
export function proveError(failure: PinFailure, method: IdentityMethodView): { readonly key: ProveErrorKey; readonly field: 'password' | 'code' | null } {
  if (failure.code === 'RATE_LIMITED' && failure.reason === 'ACCOUNT_LOCKED') return { key: 'ACCOUNT_LOCKED', field: null }
  if (failure.code === 'VALIDATION_FAILED') {
    if (failure.field === 'method' && failure.reason === 'NOT_AVAILABLE') return { key: method === 'TOTP' ? 'TOTP_NOT_AVAILABLE' : 'NOT_AVAILABLE', field: null }
    if (failure.field === 'password') return { key: failure.reason === 'WRONG' ? 'PASSWORD_WRONG' : 'PASSWORD_REQUIRED', field: 'password' }
    if (failure.field === 'code') return { key: failure.reason === 'WRONG' ? 'CODE_WRONG' : 'CODE_FORMAT', field: 'code' }
  }
  return { key: commonKey(failure), field: null }
}

/** Why the PIN itself was refused (src/core/pin), as the screen says it */
const PIN_PROBLEMS = { FORMAT: 'PIN_FORMAT', ALL_SAME: 'ALL_SAME', SEQUENCE: 'SEQUENCE', COMMON: 'COMMON' } as const

export type SetPinErrorKey = (typeof PIN_PROBLEMS)[keyof typeof PIN_PROBLEMS] | 'PROOF_EXPIRED' | CommonKey

/** Message key under pinSettings.errors for a refused PIN (setOwnPin); `proof` sends the member back to step 1 */
export function setPinError(failure: PinFailure): { readonly key: SetPinErrorKey; readonly field: 'pin' | null; readonly proof: boolean } {
  if (failure.code === 'STEP_UP_REQUIRED' || (failure.code === 'VALIDATION_FAILED' && failure.field === 'proofToken')) return { key: 'PROOF_EXPIRED', field: null, proof: true }
  if (failure.code === 'VALIDATION_FAILED' && failure.field === 'pin') {
    const problem = failure.reason && failure.reason in PIN_PROBLEMS ? PIN_PROBLEMS[failure.reason as keyof typeof PIN_PROBLEMS] : 'PIN_FORMAT'
    return { key: problem, field: 'pin', proof: false }
  }
  return { key: commonKey(failure), field: null, proof: false }
}
