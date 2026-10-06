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
      /** A wrong PIN (FR-AUTH-005 AC3): wrong PINs still allowed before the PIN locks; STEP_UP_LOCKED says when in `time` */
      readonly attemptsLeft?: number
    }

export type ActionFailure = Extract<ActionOutcome, { ok: false }>

/**
 * What a form holds when its server action gave no answer (the call threw: the connection dropped). The server never
 * answers this code. The action may have been done before the answer was lost; the form keeps its idempotency key, so
 * pressing the same button again runs it only once (spec §4.3).
 */
export const NO_ANSWER: ActionFailure = { ok: false, code: 'NO_ANSWER' }

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)
const count = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined)

/** Picks the screen-safe parts of a service error (never a PIN: the step-up's details hold none, NFR-SEC-09). */
export function toActionFailure(error: { code: string; details?: Record<string, unknown> }): ActionFailure {
  const d = error.details ?? {}
  const pick = {
    reason: text(d.reason),
    field: text(d.field),
    name: text(d.name),
    time: text(d.time),
    rule: text(d.rule),
    available: text(d.available),
    shortfall: text(d.shortfall),
    requestId: text(d.requestId),
    attemptsLeft: count(d.attemptsLeft),
  }
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
  'PIN',
  'PIN_INVALID',
  'PIN_LOCKED',
  'PIN_NOT_SET',
  'STEP_UP',
  'FORBIDDEN',
  'SOD',
  'APPROVER_NOT_FOUND',
  'BUDGET',
  'BUDGET_LINE_CLOSED',
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

/** Refusals said at the PIN field itself: not six digits, or wrong (with the tries left) */
export const PIN_FIELD_KEYS: readonly TaskErrorKey[] = ['PIN', 'PIN_INVALID']
/**
 * The task was decided, moved or closed while the page was open: the page says so and shows the task as it is now. Kept
 * here, apart from the forms, so the server actions of the LIFF decision page tell them apart the same way.
 */
export const CLOSED_TASK_KEYS: readonly TaskErrorKey[] = ['DECIDED', 'STATE', 'NOT_FOUND']

/**
 * Message key under tasks.errors for a failed decision, question or step-up. The PIN (FR-AUTH-005): PIN when it is not
 * six digits or was not sent, PIN_INVALID {attemptsLeft} when it is wrong, PIN_LOCKED {time} after five wrong in a row,
 * PIN_NOT_SET when the member has none yet (the message links to /settings/pin), STEP_UP when the decision found no step-up.
 */
export function taskErrorKey(failure: ActionFailure): TaskErrorKey {
  const { code, reason, field } = failure
  if (code === 'INVALID_STATE_TRANSITION') return failure.name && failure.time ? 'DECIDED' : 'STATE'
  if (code === 'STEP_UP_LOCKED') return 'PIN_LOCKED'
  if (code === 'STEP_UP_REQUIRED') return reason === 'PIN_NOT_SET' ? 'PIN_NOT_SET' : 'STEP_UP'
  if (code === 'VALIDATION_FAILED') {
    if (field === 'reason') return 'REASON'
    if (field === 'question') return 'QUESTION'
    if (field === 'pin') return reason === 'WRONG' ? 'PIN_INVALID' : 'PIN'
    if (field === 'confirm') return 'CONFIRM'
    if (field === 'decision' && reason !== 'RETURN_NOT_ALLOWED') return 'CHOICE'
    if (reason === 'LATER_VERSION_SCHEDULED') return 'LATER_VERSION'
    if (reason === 'SUBJECT') return 'SUBJECT'
    return 'FAILED'
  }
  if (code === 'FORBIDDEN') return reason === 'CHANNEL' ? 'CHANNEL' : 'FORBIDDEN'
  if (code === 'SOD_VIOLATION') return 'SOD'
  if (code === 'APPROVER_NOT_FOUND') return 'APPROVER_NOT_FOUND'
  // Approving a PO holds its budget, and approving an excess holds more: told without amounts (budget.view, §2.4)
  if (code === 'BUDGET_INSUFFICIENT') return 'BUDGET'
  if (code === 'BUDGET_LINE_CLOSED') return 'BUDGET_LINE_CLOSED'
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
  'NO_ANSWER',
  'FAILED',
] as const
export type RequestErrorKey = (typeof REQUEST_ERROR_KEYS)[number]

/**
 * Message key under requestView.errors for a failed resubmit, cancel or answer. No answer from the server (NO_ANSWER)
 * says so — the connection, and that pressing the same button again does it only once — never "not saved", which it
 * cannot know.
 */
export function requestErrorKey(failure: ActionFailure): RequestErrorKey {
  const { code, field, reason } = failure
  switch (code) {
    case NO_ANSWER.code:
      return 'NO_ANSWER'
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
