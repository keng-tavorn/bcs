// Result type and the complete error-code catalogue of spec §14.2 (pure data; shared by core, services,
// channels and screens). User-facing text lives in messages/src/{th,en}/errors.json under the same codes.

export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'ATTACHMENT_RULE_FAILED',
  'TOKEN_INVALID',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'SOD_VIOLATION',
  'MODULE_DISABLED',
  'NOT_FOUND',
  'CONFLICT_VERSION',
  'IDEMPOTENCY_CONFLICT',
  'INVALID_STATE_TRANSITION',
  'MODULE_IN_USE',
  'TOKEN_USED',
  'DUPLICATE_INVOICE',
  'AI_REVIEW_PENDING',
  'TOKEN_EXPIRED',
  'DOA_NOT_CONFIGURED',
  'DOA_AMBIGUOUS',
  'DOA_LINT_FAILED',
  'WORKFLOW_LINT_FAILED',
  'APPROVER_NOT_FOUND',
  'REVIEWER_NOT_FOUND',
  'NO_HIGHER_AUTHORITY',
  'BUDGET_INSUFFICIENT',
  'BUDGET_LINE_CLOSED',
  'TAX_RATE_NOT_CONFIGURED',
  'INVOICE_EXCEEDS_COMMITTED',
  'STEP_UP_LOCKED',
  'STEP_UP_REQUIRED',
  'RATE_LIMITED',
  'EXTERNAL_SERVICE_ERROR',
  'INTERNAL',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export const HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  ATTACHMENT_RULE_FAILED: 400,
  TOKEN_INVALID: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  SOD_VIOLATION: 403,
  MODULE_DISABLED: 403,
  NOT_FOUND: 404,
  CONFLICT_VERSION: 409,
  IDEMPOTENCY_CONFLICT: 409,
  INVALID_STATE_TRANSITION: 409,
  MODULE_IN_USE: 409,
  TOKEN_USED: 409,
  DUPLICATE_INVOICE: 409,
  AI_REVIEW_PENDING: 409,
  TOKEN_EXPIRED: 410,
  DOA_NOT_CONFIGURED: 422,
  DOA_AMBIGUOUS: 422,
  DOA_LINT_FAILED: 422,
  WORKFLOW_LINT_FAILED: 422,
  APPROVER_NOT_FOUND: 422,
  REVIEWER_NOT_FOUND: 422,
  NO_HIGHER_AUTHORITY: 422,
  BUDGET_INSUFFICIENT: 422,
  BUDGET_LINE_CLOSED: 422,
  TAX_RATE_NOT_CONFIGURED: 422,
  INVOICE_EXCEEDS_COMMITTED: 422,
  STEP_UP_LOCKED: 423,
  STEP_UP_REQUIRED: 428,
  RATE_LIMITED: 429,
  EXTERNAL_SERVICE_ERROR: 502,
  INTERNAL: 500,
}

/**
 * `message` is a short developer-facing description for logs and API problem details. Screens and LINE
 * replies never show it: screens render `errors.<code>` from next-intl messages with `details` as ICU params, and
 * LINE replies use the Thai and English templates of src/channels/line/flex (§4.7 rule 5) with the same details.
 */
export interface AppError {
  readonly code: ErrorCode
  readonly message: string
  readonly details?: Readonly<Record<string, unknown>>
}

export type Result<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: AppError }

export function ok<T>(data: T): Result<T> {
  return { ok: true, data }
}

export function err<T = never>(code: ErrorCode, message?: string, details?: Record<string, unknown>): Result<T> {
  return { ok: false, error: details ? { code, message: message ?? code, details } : { code, message: message ?? code } }
}

export function isErrorCode(value: string): value is ErrorCode {
  return (ERROR_CODES as readonly string[]).includes(value)
}
