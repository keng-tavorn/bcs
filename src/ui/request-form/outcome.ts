// What a request form action returns to the screen: success, or the error code with the parts of `details` the screen
// needs to say what happened and how to fix it (§9.9 rule 7, §14.2) — never the raw message. Pure, so the mapping is
// tested on its own (tests/unit/request-form.test.ts).

export type MissingView = { readonly kind: 'ATTACHMENT'; readonly attachment: string; readonly need: number; readonly have: number } | { readonly kind: 'FIELD'; readonly field: string; readonly op: string }

export interface FormFailure {
  readonly ok: false
  readonly code: string
  readonly field?: string
  readonly reason?: string
  readonly rule?: string
  /** BUDGET_INSUFFICIENT: baht text */
  readonly available?: string
  readonly shortfall?: string
  /** ATTACHMENT_RULE_FAILED: every rule that is not met and what it misses */
  readonly failures?: ReadonlyArray<{ readonly rule: string; readonly missing: readonly MissingView[] }>
  /** QUOTE-LOWEST: positions of the lowest quotations */
  readonly lowest?: readonly number[]
  /** APPROVER_NOT_FOUND / NO_HIGHER_AUTHORITY */
  readonly position?: string
  readonly ruleCode?: string
  readonly departments?: readonly string[]
  /** INVALID_STATE_TRANSITION */
  readonly status?: string
  /** TAX_RATE_NOT_CONFIGURED */
  readonly date?: string
  /** INTERNAL: the reference support finds in the logs */
  readonly requestId?: string
  /** DOA gaps (FR-DOA-003 AC3): how many of the organization's administrators were told; absent when the report failed */
  readonly adminsNotified?: number
  /** DUPLICATE_UNACKNOWLEDGED (S6-13 · BR-DUP-05): the requester's requests this one looks like */
  readonly matched?: readonly DuplicateMatch[]
}

/** A request the one being sent looks like (S6-13): its number once sent, and its title */
export interface DuplicateMatch {
  readonly id: string
  readonly number: string | null
  readonly title: string
}

export type FormSuccess<T> = { readonly ok: true } & T
export type FormOutcome<T = object> = FormSuccess<T> | FormFailure

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const strings = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined)
const numbers = (v: unknown): number[] | undefined => (Array.isArray(v) && v.every((x) => typeof x === 'number') ? (v as number[]) : undefined)

function matchedOf(value: unknown): DuplicateMatch[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.flatMap((m): DuplicateMatch[] => {
    const x = m as Record<string, unknown>
    return typeof x.id === 'string' && typeof x.title === 'string' ? [{ id: x.id, number: typeof x.number === 'string' ? x.number : null, title: x.title }] : []
  })
}

function missingOf(value: unknown): MissingView[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((m): MissingView[] => {
    const x = m as Record<string, unknown>
    if (x.kind === 'ATTACHMENT' && typeof x.attachment === 'string') return [{ kind: 'ATTACHMENT', attachment: x.attachment, need: Number(x.need) || 0, have: Number(x.have) || 0 }]
    if (x.kind === 'FIELD' && typeof x.field === 'string') return [{ kind: 'FIELD', field: x.field, op: str(x.op) ?? '' }]
    return []
  })
}

/** Picks the screen-safe parts of a service error. */
export function toFormFailure(error: { code: string; details?: Readonly<Record<string, unknown>> }): FormFailure {
  const d = error.details ?? {}
  const failures = Array.isArray(d.failures)
    ? (d.failures as Array<Record<string, unknown>>).filter((f) => typeof f.rule === 'string').map((f) => ({ rule: f.rule as string, missing: missingOf(f.missing) }))
    : undefined
  const out: Record<string, unknown> = { ok: false, code: error.code }
  const copy = { field: str(d.field), reason: str(d.reason), rule: str(d.rule), available: str(d.available), shortfall: str(d.shortfall), position: str(d.position), ruleCode: str(d.ruleCode), status: str(d.status) ?? str(d.from), date: str(d.date), requestId: str(d.requestId) }
  for (const [k, v] of Object.entries(copy)) if (v !== undefined) out[k] = v
  if (failures) out.failures = failures
  const lowest = numbers(d.lowest)
  if (lowest) out.lowest = lowest
  // REVIEWER_NOT_FOUND names the one department of the reviewer's position (S6 · BR-WF-08)
  const departments = strings(d.departments) ?? (typeof d.department === 'string' && d.department ? [d.department] : undefined)
  if (departments) out.departments = departments
  if (typeof d.adminsNotified === 'number') out.adminsNotified = d.adminsNotified
  const matched = matchedOf(d.matched)
  if (matched) out.matched = matched
  return out as unknown as FormFailure
}

/** A DOA gap that the organization's administrators were told about (the screen says so only then) */
export const adminsWereTold = (f: FormFailure): boolean => (f.adminsNotified ?? 0) > 0

/**
 * Why this page can no longer save or send the request, from the refusal that stopped it (§9.9 rule 7: the real cause,
 * never a guess between two): sent elsewhere, or cancelled — the request's status the server names with the refusal
 * (INVALID_STATE_TRANSITION, details.from) — no longer found, or no longer this account's to change. ELSEWHERE: the
 * server named no status, so the page can only say it was sent or cancelled elsewhere.
 */
export type ClosedWhy = 'SENT' | 'CANCELLED' | 'NOT_FOUND' | 'FORBIDDEN' | 'ELSEWHERE'

export function closedWhy(f: Pick<FormFailure, 'code' | 'status'>): ClosedWhy {
  if (f.code === 'NOT_FOUND') return 'NOT_FOUND'
  if (f.code === 'FORBIDDEN') return 'FORBIDDEN'
  if (f.status === 'CANCELLED') return 'CANCELLED'
  return f.status ? 'SENT' : 'ELSEWHERE'
}

/** The steps of the form (real steps of filling it in, §9.9) */
export const STEP_IDS = ['details', 'items', 'documents', 'review'] as const
export type StepId = (typeof STEP_IDS)[number]

/** Message keys under requestForm.errors */
export const FAILURE_KEYS = [
  'BUDGET_INSUFFICIENT',
  'BUDGET_LINE_CLOSED',
  'ATTACHMENT_RULE_FAILED',
  'QUOTE_LOWEST',
  'QUOTE_SELECTED',
  'QUOTE_FILE',
  'QUOTE_MORE_THAN_ONE',
  'FORM_FIELD',
  'NO_LINES',
  'SERVICE_END_DATE',
  'CHOOSE_BUDGET_LINE',
  'NO_BUDGET_LINE',
  'BUDGET_LINE_YEAR',
  'BUDGET_LINE_NOT_ALLOWED',
  'LINE_BUDGET_LINE_NOT_ALLOWED',
  'LINE_BUDGET_LINE_YEAR',
  'LINE_BUDGET_LINE',
  'DOA_NOT_CONFIGURED',
  'APPROVER_NOT_FOUND',
  'NO_HIGHER_AUTHORITY',
  'REVIEWER_NOT_FOUND',
  'DOA_AMBIGUOUS',
  'SOD_VIOLATION',
  'TAX_RATE_NOT_CONFIGURED',
  'CONFLICT_VERSION',
  'STATE',
  'FORBIDDEN',
  'NOT_FOUND',
  'FILE_NOT_FOUND',
  'UNAUTHENTICATED',
  'BUSY',
  'FILE',
  'KIND',
  'ALREADY_ATTACHED',
  'TOO_MANY',
  'INPUT',
  'INTERNAL',
  'DRAFT_NOT_SAVED',
  'NO_DEPARTMENT',
  'TOO_LARGE',
  'NO_FORM',
  'LINE_ID',
  'SITE_UNKNOWN',
  'SUPPLIER_UNKNOWN',
  'AGREEMENT_PRICE_LOCKED',
  'AGREEMENT_PRICE_BEFORE_VAT',
  'AGREEMENT_OFF',
  'CATALOG_UNKNOWN',
  'DUPLICATE_UNACKNOWLEDGED',
  'OVERRUN_PENDING',
  'FAILED',
] as const
export type FailureKey = (typeof FAILURE_KEYS)[number]

const BUDGET_LINE_REASONS: readonly FailureKey[] = ['CHOOSE_BUDGET_LINE', 'NO_BUDGET_LINE', 'BUDGET_LINE_YEAR', 'BUDGET_LINE_NOT_ALLOWED']
const FILE_REASONS: readonly FailureKey[] = ['ALREADY_ATTACHED', 'TOO_MANY', 'KIND']
/** Codes whose message key is the code itself */
const BY_CODE: readonly FailureKey[] = [
  'BUDGET_INSUFFICIENT',
  'BUDGET_LINE_CLOSED',
  'ATTACHMENT_RULE_FAILED',
  'DOA_NOT_CONFIGURED',
  'APPROVER_NOT_FOUND',
  'NO_HIGHER_AUTHORITY',
  'REVIEWER_NOT_FOUND',
  'DOA_AMBIGUOUS',
  'SOD_VIOLATION',
  'TAX_RATE_NOT_CONFIGURED',
  'CONFLICT_VERSION',
  'FORBIDDEN',
  'NOT_FOUND',
  'UNAUTHENTICATED',
  'INTERNAL',
  // The screen's own: the latest edits could not be saved, so nothing was sent
  'DRAFT_NOT_SAVED',
]

function validationKey(f: FormFailure): FailureKey {
  const reason = f.reason ?? ''
  if (f.rule === 'QUOTE-LOWEST' || reason === 'QUOTE-LOWEST') return 'QUOTE_LOWEST'
  if (f.rule === 'QUOTE-SELECTED' || reason === 'QUOTE-SELECTED') return 'QUOTE_SELECTED'
  if (reason === 'FILE_REQUIRED') return 'QUOTE_FILE'
  if (reason === 'MORE_THAN_ONE_SELECTED') return 'QUOTE_MORE_THAN_ONE'
  if (reason === 'FORM') return 'FORM_FIELD'
  if (reason === 'NO_LINES') return 'NO_LINES'
  if (reason === 'SERVICE_END_DATE') return 'SERVICE_END_DATE'
  if (reason === 'BUDGET_LINE') return 'NO_BUDGET_LINE'
  if (reason === 'NO_DEPARTMENT') return 'NO_DEPARTMENT'
  if (reason === 'TOO_LARGE') return 'TOO_LARGE'
  if (reason === 'NO_PUBLISHED_FORM') return 'NO_FORM'
  if (reason === 'LINE_ID') return 'LINE_ID'
  // S6-13: like a request sent before — the review step asks for the reason (duplicateRefusal)
  if (reason === 'DUPLICATE_UNACKNOWLEDGED') return 'DUPLICATE_UNACKNOWLEDGED'
  // The catalogue's agreed prices (S6-10, BR-PRC-06)
  if (reason === 'AGREEMENT_PRICE_LOCKED' || reason === 'AGREEMENT_PRICE_BEFORE_VAT' || reason === 'AGREEMENT_OFF') return reason
  if (/^lines\.\d+\.catalogItemId$/.test(f.field ?? '')) return 'CATALOG_UNKNOWN'
  // A delivery site closed or a supplier deactivated since the form opened (S4-02)
  if (f.field === 'deliverySiteId') return 'SITE_UNKNOWN'
  if (f.field === 'suggestedSupplierId') return 'SUPPLIER_UNKNOWN'
  const byReason = [...BUDGET_LINE_REASONS, ...FILE_REASONS].find((k) => k === reason)
  if (byReason) return byReason
  if (reason === 'FILE' || f.field === 'fileId') return 'FILE'
  return 'INPUT'
}

/**
 * S6-17 (BR-BUD-16): a line's own budget line refused at submit (`lines.N.budgetLineId`) — another department's not
 * granted, of another fiscal year, or not found — said of that line, not of the request's budget line
 */
function lineBudgetKey(f: FormFailure): FailureKey | null {
  if (!/^lines\.\d+\.budgetLineId$/.test(f.field ?? '')) return null
  if (f.reason === 'BUDGET_LINE_NOT_ALLOWED') return 'LINE_BUDGET_LINE_NOT_ALLOWED'
  if (f.reason === 'BUDGET_LINE_YEAR') return 'LINE_BUDGET_LINE_YEAR'
  return 'LINE_BUDGET_LINE'
}

/** Message key under requestForm.errors for a failed request form action. */
export function failureKey(f: FormFailure): FailureKey {
  const line = lineBudgetKey(f)
  if (line) return line
  if (f.code === 'FORBIDDEN' && f.reason === 'BUDGET_LINE_NOT_ALLOWED') return 'BUDGET_LINE_NOT_ALLOWED'
  if (f.code === 'VALIDATION_FAILED') return validationKey(f)
  // S6-16 (§6.4): an over-budget approval of the request still waits — its amount and budget line are locked, and it is
  // not sent until the approval is decided or cancelled; the request itself is still the requester's to change
  if (f.code === 'INVALID_STATE_TRANSITION' && f.reason === 'OVERRUN_PENDING') return 'OVERRUN_PENDING'
  if (f.code === 'INVALID_STATE_TRANSITION') return 'STATE'
  if (f.code === 'RATE_LIMITED') return 'BUSY'
  // A file the request no longer holds is not the request missing: each gets its own words, neither guesses why
  if (f.code === 'NOT_FOUND' && f.field === 'fileId') return 'FILE_NOT_FOUND'
  return BY_CODE.find((k) => k === f.code) ?? 'FAILED'
}

/** No field of the form is asked beside the documents */
const NO_DOCUMENT_FIELDS: ReadonlySet<string> = new Set()

/**
 * The step where the requester fixes what a failure is about; null when nothing in the form can fix it. A field the
 * attachment rules ask to be filled is asked beside the documents (`documentFields`, ./document-fields.ts), every other
 * field of the form with the request's details.
 */
export function failureStep(f: FormFailure, documentFields: ReadonlySet<string> = NO_DOCUMENT_FIELDS): StepId | null {
  const key = failureKey(f)
  const field = f.field ?? ''
  const fieldId = failureTarget(f).fieldId
  if (fieldId && documentFields.has(fieldId)) return 'documents'
  if (key === 'FORM_FIELD' || field.startsWith('formData.') || field === 'title') return 'details'
  if (BUDGET_LINE_REASONS.includes(key) || key === 'BUDGET_LINE_CLOSED') return 'details'
  if (key === 'NO_LINES' || key === 'SERVICE_END_DATE' || key === 'BUDGET_INSUFFICIENT' || key === 'SITE_UNKNOWN' || field.startsWith('lines') || field === 'offAgreementReason' || field === 'priceIncludesVat') return 'items'
  if (key === 'ATTACHMENT_RULE_FAILED' || key === 'SUPPLIER_UNKNOWN' || key.startsWith('QUOTE_') || field.startsWith('quotations') || field === 'nonLowestQuoteReason') return 'documents'
  return null
}

/** The visible field a FORM_FIELD failure names ("formData.scopeOfWork" → "scopeOfWork"), or the line number of a lines failure */
export function failureTarget(f: FormFailure): { readonly fieldId?: string; readonly lineNo?: number } {
  const field = f.field ?? ''
  const form = /^formData\.([A-Za-z][A-Za-z0-9_]*)/.exec(field)
  if (form) return { fieldId: form[1]! }
  const line = /^lines\.(\d+)/.exec(field)
  if (line) return { lineNo: Number(line[1]) + 1 }
  return {}
}
