// What a decision or a requester action returns to its form (spec §14.2, §9.9 rule 7): success, or the error code with
// the parts of `details` the screen needs to say what happened and how to fix it — never the raw message. The server
// action builds it with toActionFailure(); the form turns it into a message key and its values.

export type ActionOutcome =
  | { readonly ok: true; readonly documentStatus?: string }
  | {
      readonly ok: false
      readonly code: string
      readonly reason?: string
      readonly field?: string
      /** INVALID_STATE_TRANSITION of a decided task: who decided it and when (FR-DOA-004 AC2) */
      readonly name?: string
      readonly time?: string
      /** SOD_VIOLATION: the rule; ATTACHMENT_RULE_FAILED: the attachment rule */
      readonly rule?: string
      /** BUDGET_INSUFFICIENT: amounts as decimal text (satang never leaves the server as a float) */
      readonly available?: string
      readonly shortfall?: string
      /** INTERNAL: the reference support finds in the logs */
      readonly requestId?: string
    }

export type ActionFailure = Extract<ActionOutcome, { ok: false }>

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)

/** Picks the screen-safe parts of a service error. */
export function toActionFailure(error: { code: string; details?: Record<string, unknown> }): ActionFailure {
  const d = error.details ?? {}
  const pick = { reason: text(d.reason), field: text(d.field), name: text(d.name), time: text(d.time), rule: text(d.rule), available: text(d.available), shortfall: text(d.shortfall), requestId: text(d.requestId) }
  return { ok: false, code: error.code, ...Object.fromEntries(Object.entries(pick).filter(([, v]) => v !== undefined)) }
}

// ---------- decisions (tasks.errors) ----------

export const TASK_ERROR_KEYS = [
  'DECIDED',
  'STATE',
  'REASON',
  'QUESTION',
  'CONFIRM',
  'CHOICE',
  'CODE',
  'CODE_INVALID',
  'CODE_LOCKED',
  'NO_SECOND_FACTOR',
  'STEP_UP',
  'FORBIDDEN',
  'SOD',
  'APPROVER_NOT_FOUND',
  'LATER_VERSION',
  'SUBJECT',
  'CHANNEL',
  'NOT_FOUND',
  'BUSY',
  'CONFLICT',
  'UNAUTHENTICATED',
  'INTERNAL',
  'FAILED',
] as const
export type TaskErrorKey = (typeof TASK_ERROR_KEYS)[number]

/** Message key under tasks.errors for a failed decision, question or step-up. */
export function taskErrorKey(failure: ActionFailure): TaskErrorKey {
  const { code, reason, field } = failure
  if (code === 'INVALID_STATE_TRANSITION') return failure.name && failure.time ? 'DECIDED' : 'STATE'
  if (code === 'STEP_UP') return reason === 'LOCKED' ? 'CODE_LOCKED' : reason === 'NO_SECOND_FACTOR' ? 'NO_SECOND_FACTOR' : 'CODE_INVALID'
  if (code === 'STEP_UP_REQUIRED' || code === 'STEP_UP_LOCKED') return code === 'STEP_UP_LOCKED' ? 'CODE_LOCKED' : 'STEP_UP'
  if (code === 'VALIDATION_FAILED') {
    if (field === 'reason') return 'REASON'
    if (field === 'question') return 'QUESTION'
    if (field === 'code') return 'CODE'
    if (field === 'confirm') return 'CONFIRM'
    if (field === 'decision' && reason !== 'RETURN_NOT_ALLOWED') return 'CHOICE'
    if (reason === 'LATER_VERSION_SCHEDULED') return 'LATER_VERSION'
    if (reason === 'SUBJECT') return 'SUBJECT'
    return 'FAILED'
  }
  if (code === 'FORBIDDEN') return reason === 'CHANNEL' ? 'CHANNEL' : 'FORBIDDEN'
  if (code === 'SOD_VIOLATION') return 'SOD'
  if (code === 'APPROVER_NOT_FOUND') return 'APPROVER_NOT_FOUND'
  if (code === 'NOT_FOUND') return 'NOT_FOUND'
  if (code === 'RATE_LIMITED') return 'BUSY'
  if (code === 'IDEMPOTENCY_CONFLICT') return 'CONFLICT'
  if (code === 'UNAUTHENTICATED') return 'UNAUTHENTICATED'
  if (code === 'INTERNAL') return 'INTERNAL'
  return 'FAILED'
}

// ---------- requester actions (requestView.errors) ----------

export const REQUEST_ERROR_KEYS = [
  'STATE',
  'REASON',
  'ANSWER',
  'CONFIRM',
  'FORBIDDEN',
  'BUDGET_INSUFFICIENT',
  'BUDGET_LINE_CLOSED',
  'BUDGET_LINE',
  'ATTACHMENT',
  'FORM',
  'DOA_NOT_CONFIGURED',
  'APPROVER_NOT_FOUND',
  'NO_HIGHER_AUTHORITY',
  'TAX_RATE',
  'NOT_FOUND',
  'BUSY',
  'CONFLICT',
  'UNAUTHENTICATED',
  'INTERNAL',
  'FAILED',
] as const
export type RequestErrorKey = (typeof REQUEST_ERROR_KEYS)[number]

/** Message key under requestView.errors for a failed resubmit, cancel or answer. */
export function requestErrorKey(failure: ActionFailure): RequestErrorKey {
  const { code, field, reason } = failure
  switch (code) {
    case 'INVALID_STATE_TRANSITION':
      return 'STATE'
    case 'VALIDATION_FAILED':
      if (field === 'reason') return 'REASON'
      if (field === 'answer') return 'ANSWER'
      if (field === 'confirm') return 'CONFIRM'
      if (field === 'budgetLineId' || reason === 'CHOOSE_BUDGET_LINE' || reason === 'NO_BUDGET_LINE') return 'BUDGET_LINE'
      return field?.startsWith('formData') || field?.startsWith('lines') || reason === 'FORM' ? 'FORM' : 'FAILED'
    case 'ATTACHMENT_RULE_FAILED':
      return 'ATTACHMENT'
    case 'BUDGET_INSUFFICIENT':
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
    case 'RATE_LIMITED':
      return 'BUSY'
    case 'IDEMPOTENCY_CONFLICT':
      return 'CONFLICT'
    default:
      return 'FAILED'
  }
}
