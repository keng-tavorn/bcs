// The workflow editor's model (FR-WF-103 AC1 AC2, BR-WF-07 BR-WF-11): pure functions between what the service sends
// (rules, test cases, conditions of §7.9 with anyIn) and what the screen edits (a rule's form, a condition as rows of
// field · op · value joined by all or any, a document of the dry-run or of a test case). Money stays a baht string with
// two decimals (§7.0 (3)); the service checks every value again.

export type Mode = 'ALL' | 'ANY' | 'COUNT'
export const MODES: readonly Mode[] = ['ALL', 'ANY', 'COUNT']

export type ReviewerValue = { readonly kind: 'POSITION_AT'; readonly position: string; readonly department: string } | { readonly kind: 'MEMBER'; readonly memberId: string }

/** A condition of §7.9 with anyIn; {} holds for every request of the rule's types */
export type ConditionValue =
  | { readonly all: readonly ConditionValue[] }
  | { readonly any: readonly ConditionValue[] }
  | { readonly field: string; readonly op: string; readonly value?: unknown }
  | Readonly<Record<string, never>>

export interface RuleValue {
  readonly code: string
  readonly requestTypeCodes: readonly string[]
  readonly when: ConditionValue
  readonly reviewers: readonly ReviewerValue[]
  readonly fallback: ReviewerValue | null
  readonly mode: Mode
  readonly quorumCount: number | null
  readonly slaMinutes: number
  readonly descriptionTh: string | null
}

export interface DocumentValue {
  readonly requestType: string
  /** Baht with VAT, two decimals */
  readonly amountGross: string
  readonly amountNet?: string
  readonly lineCategories: readonly string[]
  readonly budgetAccountCodes: readonly string[]
  readonly fields: Readonly<Record<string, unknown>>
}

export interface TestCaseValue {
  readonly name: string
  readonly input: DocumentValue
  readonly expected: { readonly ruleCodes: readonly string[] }
}

// ---------- the variables and operators a condition may use (BR-WF-07) ----------

export const MONEY_VARIABLES: readonly string[] = ['$amountGross', '$amountNet']
export const SET_VARIABLES: readonly string[] = ['$lineCategories', '$budgetAccountCodes']
export const VARIABLES: readonly string[] = [...MONEY_VARIABLES, '$requestType', ...SET_VARIABLES]

export type Op = 'eq' | 'ne' | 'in' | 'gt' | 'gte' | 'lt' | 'lte' | 'empty' | 'notEmpty' | 'anyIn'
export const OPS: readonly Op[] = ['eq', 'ne', 'in', 'gt', 'gte', 'lt', 'lte', 'empty', 'notEmpty', 'anyIn']

export type FieldKind = 'money' | 'requestType' | 'set' | 'choice' | 'text'

/** What a field is, for the operators and the value it takes: a variable, or a form field with or without options */
export function fieldKind(field: string, formField?: { readonly options: readonly unknown[] }): FieldKind {
  if (MONEY_VARIABLES.includes(field)) return 'money'
  if (field === '$requestType') return 'requestType'
  if (SET_VARIABLES.includes(field)) return 'set'
  return formField && formField.options.length ? 'choice' : 'text'
}

export const OPS_BY_KIND: Readonly<Record<FieldKind, readonly Op[]>> = {
  money: ['gt', 'gte', 'lt', 'lte', 'eq', 'ne'],
  requestType: ['eq', 'ne', 'in'],
  set: ['anyIn', 'empty', 'notEmpty'],
  choice: ['eq', 'ne', 'in', 'anyIn', 'empty', 'notEmpty'],
  text: ['eq', 'ne', 'empty', 'notEmpty'],
}

/** in and anyIn take a list; empty and notEmpty take nothing */
export const isListOp = (op: string) => op === 'in' || op === 'anyIn'
export const takesValue = (op: string) => op !== 'empty' && op !== 'notEmpty'

// ---------- money and codes as typed ----------

const BAHT = /^(\d{1,13})(?:\.(\d{1,2}))?$/

/** "1,000,000" → "1000000.00"; null when it is not baht with at most two decimals */
export function normalizeBaht(text: string): string | null {
  const m = BAHT.exec(text.replace(/[,\s]/g, ''))
  if (!m) return null
  return `${BigInt(m[1]!).toString()}.${(m[2] ?? '').padEnd(2, '0')}`
}

/** "SAFETY, FUEL" → ["SAFETY", "FUEL"]: codes split at commas or spaces, each once */
export function codesOf(text: string): string[] {
  return [...new Set(text.split(/[,\s]+/).map((c) => c.trim()).filter((c) => c !== ''))]
}

// ---------- a condition as rows ----------

export interface ConditionRow {
  readonly field: string
  readonly op: Op | ''
  /** The value of a comparison */
  readonly value: string
  /** The values of in and anyIn */
  readonly values: readonly string[]
}

export interface ConditionDraft {
  readonly join: 'all' | 'any'
  readonly rows: readonly ConditionRow[]
  /** The stored condition has groups inside groups, which rows cannot show: it is kept as it is until replaced */
  readonly nested: ConditionValue | null
}

export const emptyRow = (): ConditionRow => ({ field: '', op: '', value: '', values: [] })

const isLeaf = (c: ConditionValue): c is { readonly field: string; readonly op: string; readonly value?: unknown } => 'field' in c
const childrenOf = (c: ConditionValue): readonly ConditionValue[] | null => ('all' in c ? (c.all as readonly ConditionValue[]) : 'any' in c ? (c.any as readonly ConditionValue[]) : null)

function rowOf(leaf: { readonly field: string; readonly op: string; readonly value?: unknown }): ConditionRow {
  const op = (OPS as readonly string[]).includes(leaf.op) ? (leaf.op as Op) : ''
  if (Array.isArray(leaf.value)) return { field: leaf.field, op, value: '', values: leaf.value.map(String) }
  return { field: leaf.field, op, value: leaf.value === undefined || leaf.value === null ? '' : String(leaf.value), values: [] }
}

/** A stored condition as the rows the builder edits */
export function conditionDraftOf(when: ConditionValue): ConditionDraft {
  if (isLeaf(when)) return { join: 'all', rows: [rowOf(when)], nested: null }
  const children = childrenOf(when)
  if (!children) return { join: 'all', rows: [], nested: null }
  const join = 'any' in when ? 'any' : 'all'
  if (children.every(isLeaf)) return { join, rows: children.map((c) => rowOf(c as { field: string; op: string; value?: unknown })), nested: null }
  return { join, rows: [], nested: when }
}

export type RowError = 'FIELD' | 'OP' | 'VALUE' | 'MONEY' | 'VALUES'

/** What is wrong with one row, or null */
export function rowError(row: ConditionRow, kindOf: (field: string) => FieldKind): RowError | null {
  if (!row.field) return 'FIELD'
  if (!row.op || !OPS_BY_KIND[kindOf(row.field)].includes(row.op)) return 'OP'
  if (!takesValue(row.op)) return null
  if (isListOp(row.op)) return row.values.length ? null : 'VALUES'
  if (row.value.trim() === '') return 'VALUE'
  if (kindOf(row.field) === 'money' && normalizeBaht(row.value) === null) return 'MONEY'
  return null
}

function leafOf(row: ConditionRow, kindOf: (field: string) => FieldKind): ConditionValue {
  if (!takesValue(row.op)) return { field: row.field, op: row.op }
  if (isListOp(row.op)) return { field: row.field, op: row.op, value: [...row.values] }
  return { field: row.field, op: row.op, value: kindOf(row.field) === 'money' ? normalizeBaht(row.value)! : row.value.trim() }
}

/** The rows as the condition the service stores: {} without rows, one row alone, several under all or any */
export function conditionOf(draft: ConditionDraft, kindOf: (field: string) => FieldKind): ConditionValue {
  if (draft.nested) return draft.nested
  const leaves = draft.rows.map((r) => leafOf(r, kindOf))
  if (leaves.length === 0) return {}
  if (leaves.length === 1) return leaves[0]!
  return draft.join === 'any' ? { any: leaves } : { all: leaves }
}

// ---------- a rule as its form ----------

export interface RuleDraft {
  readonly code: string
  readonly requestTypeCodes: readonly string[]
  readonly condition: ConditionDraft
  readonly reviewers: readonly ReviewerValue[]
  readonly fallback: ReviewerValue | null
  readonly mode: Mode
  readonly quorumCount: string
  readonly slaHours: string
  readonly descriptionTh: string
}

export type RuleField = 'code' | 'requestTypes' | 'condition' | 'reviewers' | 'fallback' | 'quorumCount' | 'slaHours' | 'descriptionTh'
export type RuleError = 'CODE' | 'DUPLICATE' | 'REQUIRED' | 'ONE_REVIEWER' | 'TWO_REVIEWERS' | 'INCOMPLETE' | 'QUORUM' | 'SLA' | 'TOO_LONG' | 'ROWS' | 'TOO_MANY'

const MINUTES_PER_HOUR = 60
const CODE = /^[A-Z0-9][A-Z0-9_-]{0,39}$/
export const DESCRIPTION_MAX = 500
export const MAX_REVIEWERS = 20

/** 480 → "8"; 450 → "7.5" */
export function hoursText(minutes: number): string {
  if (minutes % MINUTES_PER_HOUR === 0) return String(minutes / MINUTES_PER_HOUR)
  return String(Math.round((minutes / MINUTES_PER_HOUR) * 100) / 100)
}

/** "8" → 480; null when it is not a positive number of hours (two decimals at most) within the bound */
export function slaMinutesOf(text: string, maxHours: number): number | null {
  const t = text.trim()
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(t)) return null
  const minutes = Math.round(Number(t) * MINUTES_PER_HOUR)
  return minutes >= 1 && minutes <= maxHours * MINUTES_PER_HOUR ? minutes : null
}

/** The next free code after the rules' own: RV-01 … RV-10 → RV-11 */
export function nextRuleCode(rules: readonly { readonly code: string }[]): string {
  const numbers = rules.map((r) => /^RV-(\d+)$/.exec(r.code)?.[1]).filter((n): n is string => n !== undefined).map(Number)
  const next = (numbers.length ? Math.max(...numbers) : 0) + 1
  return `RV-${String(next).padStart(2, '0')}`
}

export function ruleDraftOf(rule: RuleValue | null, rules: readonly RuleValue[], defaultSlaHours: string): RuleDraft {
  if (!rule) {
    return { code: nextRuleCode(rules), requestTypeCodes: [], condition: { join: 'all', rows: [], nested: null }, reviewers: [{ kind: 'POSITION_AT', position: '', department: '' }], fallback: null, mode: 'ALL', quorumCount: '', slaHours: defaultSlaHours, descriptionTh: '' }
  }
  return {
    code: rule.code,
    requestTypeCodes: rule.requestTypeCodes,
    condition: conditionDraftOf(rule.when),
    reviewers: rule.reviewers,
    fallback: rule.fallback,
    mode: rule.mode,
    quorumCount: rule.quorumCount === null ? '' : String(rule.quorumCount),
    slaHours: hoursText(rule.slaMinutes),
    descriptionTh: rule.descriptionTh ?? '',
  }
}

const reviewerComplete = (r: ReviewerValue) => (r.kind === 'MEMBER' ? r.memberId !== '' : r.position !== '' && r.department !== '')

export type RuleCheck =
  | { readonly ok: true; readonly rule: RuleValue }
  | { readonly ok: false; readonly errors: Partial<Record<RuleField, RuleError>>; readonly rowErrors: Readonly<Record<number, RowError>> }

/**
 * The form checked as BR-WF-11 and the service will: a code of capitals, digits, - and _ used once; at least one
 * request type; complete rows; ALL and ANY with one reviewer, COUNT with two or more and a count from 1 to them; the
 * time under the SLA in hours. `editing` is the code of the rule being edited, null for a new one.
 */
export function checkRule(draft: RuleDraft, rules: readonly RuleValue[], editing: string | null, kindOf: (field: string) => FieldKind, slaMaxHours: number): RuleCheck {
  const errors: Partial<Record<RuleField, RuleError>> = {}
  const code = draft.code.trim().toUpperCase()
  if (!CODE.test(code)) errors.code = 'CODE'
  else if (rules.some((r) => r.code === code && r.code !== editing)) errors.code = 'DUPLICATE'
  if (draft.requestTypeCodes.length === 0) errors.requestTypes = 'REQUIRED'
  const rowErrors: Record<number, RowError> = {}
  if (!draft.condition.nested) {
    draft.condition.rows.forEach((row, i) => {
      const e = rowError(row, kindOf)
      if (e) rowErrors[i] = e
    })
    if (Object.keys(rowErrors).length) errors.condition = 'ROWS'
  }
  const reviewers = draft.reviewers
  if (reviewers.length === 0) errors.reviewers = 'REQUIRED'
  else if (!reviewers.every(reviewerComplete)) errors.reviewers = 'INCOMPLETE'
  else if (draft.mode !== 'COUNT' && reviewers.length !== 1) errors.reviewers = 'ONE_REVIEWER'
  else if (draft.mode === 'COUNT' && reviewers.length < 2) errors.reviewers = 'TWO_REVIEWERS'
  else if (reviewers.length > MAX_REVIEWERS) errors.reviewers = 'TOO_MANY'
  if (draft.fallback && !reviewerComplete(draft.fallback)) errors.fallback = 'INCOMPLETE'
  let quorumCount: number | null = null
  if (draft.mode === 'COUNT') {
    const n = /^\d{1,2}$/.test(draft.quorumCount.trim()) ? Number(draft.quorumCount.trim()) : NaN
    if (!Number.isInteger(n) || n < 1 || n > Math.max(reviewers.length, 1)) errors.quorumCount = 'QUORUM'
    else quorumCount = n
  }
  const slaMinutes = slaMinutesOf(draft.slaHours, slaMaxHours)
  if (slaMinutes === null) errors.slaHours = 'SLA'
  const description = draft.descriptionTh.trim()
  if (description.length > DESCRIPTION_MAX) errors.descriptionTh = 'TOO_LONG'
  if (Object.keys(errors).length || slaMinutes === null) return { ok: false, errors, rowErrors }
  return {
    ok: true,
    rule: {
      code,
      requestTypeCodes: [...draft.requestTypeCodes],
      when: conditionOf(draft.condition, kindOf),
      reviewers: [...reviewers],
      fallback: draft.fallback,
      mode: draft.mode,
      quorumCount,
      slaMinutes,
      descriptionTh: description === '' ? null : description,
    },
  }
}

/** Puts a checked rule in the list: in place of the rule it edits, or at the end */
export function putRule(rules: readonly RuleValue[], rule: RuleValue, editing: string | null): RuleValue[] {
  if (editing === null) return [...rules, rule]
  return rules.map((r) => (r.code === editing ? rule : r))
}

/** Moves a rule one place up or down (the order the slots are numbered in, BR-WF-06); no dragging (NG-4) */
export function moveRule(rules: readonly RuleValue[], code: string, by: -1 | 1): RuleValue[] {
  const i = rules.findIndex((r) => r.code === code)
  const j = i + by
  if (i < 0 || j < 0 || j >= rules.length) return [...rules]
  const next = [...rules]
  ;[next[i], next[j]] = [next[j]!, next[i]!]
  return next
}

// ---------- what changed against the saved version ----------

export type RulePart = 'requestTypes' | 'when' | 'reviewers' | 'fallback' | 'mode' | 'sla' | 'description'

/** JSON with its keys in order, so the same value compares equal however its keys came */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/** The parts of a rule that differ from the same rule before */
export function changedParts(before: RuleValue | undefined, after: RuleValue): RulePart[] {
  if (!before) return []
  const parts = (r: RuleValue): Record<RulePart, string> => ({
    requestTypes: canonical([...r.requestTypeCodes].sort()),
    when: canonical(r.when),
    reviewers: canonical(r.reviewers),
    fallback: canonical(r.fallback),
    mode: canonical([r.mode, r.mode === 'COUNT' ? r.quorumCount : null]),
    sla: String(r.slaMinutes),
    description: r.descriptionTh ?? '',
  })
  const a = parts(before)
  const b = parts(after)
  return (Object.keys(b) as RulePart[]).filter((k) => a[k] !== b[k])
}

/** Anything unsaved: the rules, their order, the test cases or the date */
export interface DraftState {
  readonly rules: readonly RuleValue[]
  readonly testCases: readonly TestCaseValue[]
  readonly effectiveDate: string
}

export function isDirty(saved: DraftState, now: DraftState): boolean {
  return canonical(saved.rules) !== canonical(now.rules) || canonical(saved.testCases) !== canonical(now.testCases) || saved.effectiveDate !== now.effectiveDate
}

// ---------- a document of the dry-run or of a test case ----------

export interface DocumentDraft {
  readonly requestType: string
  readonly amountGross: string
  /** Empty: the same as the amount with VAT */
  readonly amountNet: string
  readonly lineCategories: string
  readonly budgetAccountCodes: string
  /** Answers of the form's fields with options, by field id; '' = not answered */
  readonly fields: Readonly<Record<string, string>>
}

export type DocumentField = 'requestType' | 'amountGross' | 'amountNet'

export function documentDraftOf(d: DocumentValue | null, requestType = ''): DocumentDraft {
  if (!d) return { requestType, amountGross: '', amountNet: '', lineCategories: '', budgetAccountCodes: '', fields: {} }
  return {
    requestType: d.requestType,
    amountGross: d.amountGross,
    amountNet: d.amountNet ?? '',
    lineCategories: d.lineCategories.join(', '),
    budgetAccountCodes: d.budgetAccountCodes.join(', '),
    fields: Object.fromEntries(Object.entries(d.fields).map(([k, v]) => [k, Array.isArray(v) ? v.map(String).join(', ') : String(v ?? '')])),
  }
}

export function documentOf(d: DocumentDraft): { readonly ok: true; readonly value: DocumentValue } | { readonly ok: false; readonly errors: Partial<Record<DocumentField, 'REQUIRED' | 'MONEY' | 'NET_ABOVE_GROSS'>> } {
  const errors: Partial<Record<DocumentField, 'REQUIRED' | 'MONEY' | 'NET_ABOVE_GROSS'>> = {}
  if (!d.requestType) errors.requestType = 'REQUIRED'
  const gross = normalizeBaht(d.amountGross)
  if (d.amountGross.trim() === '') errors.amountGross = 'REQUIRED'
  else if (gross === null) errors.amountGross = 'MONEY'
  const net = d.amountNet.trim() === '' ? null : normalizeBaht(d.amountNet)
  if (d.amountNet.trim() !== '' && net === null) errors.amountNet = 'MONEY'
  // Satang compared as whole numbers, never as floating point (§7.0)
  else if (net !== null && gross !== null && BigInt(net.replace('.', '')) > BigInt(gross.replace('.', ''))) errors.amountNet = 'NET_ABOVE_GROSS'
  if (Object.keys(errors).length) return { ok: false, errors }
  const fields = Object.fromEntries(Object.entries(d.fields).filter(([, v]) => v !== ''))
  return {
    ok: true,
    value: { requestType: d.requestType, amountGross: gross!, ...(net !== null ? { amountNet: net } : {}), lineCategories: codesOf(d.lineCategories), budgetAccountCodes: codesOf(d.budgetAccountCodes), fields },
  }
}

// ---------- the save ----------

export interface SaveInput {
  readonly versionId: string
  readonly version: number
  readonly effectiveDate: string
  readonly changeReason: string
  readonly rules: ReadonlyArray<Omit<RuleValue, 'descriptionTh'> & { readonly descriptionTh: string | null }>
  readonly testCases: readonly TestCaseValue[]
}

/** What the save sends: the draft as the service's update reads it (quorumCount only for COUNT) */
export function saveInput(versionId: string, lock: number, effectiveDate: string, changeReason: string, rules: readonly RuleValue[], testCases: readonly TestCaseValue[]): SaveInput {
  return {
    versionId,
    version: lock,
    effectiveDate,
    changeReason: changeReason.trim(),
    rules: rules.map((r) => ({ ...r, requestTypeCodes: [...r.requestTypeCodes], reviewers: [...r.reviewers], quorumCount: r.mode === 'COUNT' ? r.quorumCount : null })),
    testCases: testCases.map((t) => ({ ...t, expected: { ruleCodes: [...t.expected.ruleCodes] } })),
  }
}

/** A warning as the sender ticks it: "WF_LINT_NO_FALLBACK:RV-03" (the submit's own key) */
export const warningKey = (w: { readonly code: string; readonly rule: string }) => `${w.code}:${w.rule}`

/** The first index of a rule a refusal names (field "rules.3.code" → 3), or null */
export function ruleIndexOf(field: string | undefined): number | null {
  const m = /^rules\.(\d+)/.exec(field ?? '')
  return m ? Number(m[1]) : null
}
