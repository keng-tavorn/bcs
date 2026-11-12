// The workflow editor's model (FR-WF-103 AC1 AC2, BR-WF-07 BR-WF-11): pure functions between what the service sends
// (rules, test cases, conditions of §7.9 with anyIn) and what the screen edits (a rule's form, a condition as rows of
// field · op · value joined by all or any, a document of the dry-run or of a test case). Money stays a baht string with
// two decimals (§7.0 (3)); the service checks every value again.
// S11-06 (BR-RSK-07 · FR-RSK-202 AC2): a rule is of one of two scopes. REQUEST picks the reviewers of a request (S6);
// RISK_ASSESSMENT picks the reviewers of a supplier risk assessment from its screening answers, tier, categories and
// payee type, names no request type, has one reviewer who must pass, and names the parts of the assessment that
// reviewer sees (riskDomains). A rule read without a scope is a REQUEST rule, as every rule saved before S11.

export type Mode = 'ALL' | 'ANY' | 'COUNT'
export const MODES: readonly Mode[] = ['ALL', 'ANY', 'COUNT']

export type RuleScope = 'REQUEST' | 'RISK_ASSESSMENT'

// The values of supplier risk the screens may name. src/ui may not import src/core/risk (eslint boundaries), so these
// repeat src/core/risk/types.ts (RISK_DOMAINS RISK_TIER_CODES SCREENING_FIELDS RISK_REVIEW_VARIABLES) and the payee
// types of the dry-run's input; the service and the lint (WF_LINT_RISK_*) check every value again.

/** The parts of an assessment (BR-RSK-08): every reviewer sees GENERAL; a rule names the parts its reviewer checks */
export const RISK_DOMAIN_CODES = ['GENERAL', 'PRIVACY', 'INFOSEC', 'PREMISES', 'FINANCE'] as const
export type RiskDomainCode = (typeof RISK_DOMAIN_CODES)[number]
export const RISK_TIERS = ['LOW', 'MEDIUM', 'HIGH'] as const
export type RiskTier = (typeof RISK_TIERS)[number]
/** The three screening questions of BR-RSK-01, answered Y or N */
export const SCREENING_FIELDS = ['processesPersonalData', 'accessesSystems', 'accessesPremises'] as const
export type ScreeningField = (typeof SCREENING_FIELDS)[number]
export const PAYEE_TYPES = ['JURISTIC', 'INDIVIDUAL', 'FOREIGN'] as const
export type PayeeType = (typeof PAYEE_TYPES)[number]
/** What a RISK rule's condition may name besides the screening answers (WF_LINT_RISK_FIELD) */
export const RISK_VARIABLES: readonly string[] = ['$tier', '$inherentTier', '$category', '$payeeType']
export const RISK_FIELDS: readonly string[] = [...SCREENING_FIELDS, ...RISK_VARIABLES]

/** The scope of a rule; absent = REQUEST */
export const scopeOf = (r: { readonly scope?: RuleScope }): RuleScope => r.scope ?? 'REQUEST'

export type ReviewerValue = { readonly kind: 'POSITION_AT'; readonly position: string; readonly department: string } | { readonly kind: 'MEMBER'; readonly memberId: string }

/** A condition of §7.9 with anyIn; {} holds for every request of the rule's types */
export type ConditionValue =
  | { readonly all: readonly ConditionValue[] }
  | { readonly any: readonly ConditionValue[] }
  | { readonly field: string; readonly op: string; readonly value?: unknown }
  | Readonly<Record<string, never>>

export interface RuleValue {
  readonly code: string
  /** REQUEST when absent (a rule read before S11) */
  readonly scope?: RuleScope
  /** RISK_ASSESSMENT: the parts of the assessment its reviewer sees (BR-RSK-08); none for a REQUEST rule */
  readonly riskDomains?: readonly string[]
  /** REQUEST: one at least; RISK_ASSESSMENT: none */
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

/** fixed: a value of a risk assessment that always has one of a few values (a screening answer, a tier, a payee type) */
export type FieldKind = 'money' | 'requestType' | 'set' | 'choice' | 'text' | 'fixed'

/** What a field is, for the operators and the value it takes: a variable, or a form field with or without options */
export function fieldKind(field: string, formField?: { readonly options: readonly unknown[] }): FieldKind {
  if (MONEY_VARIABLES.includes(field)) return 'money'
  if (field === '$requestType') return 'requestType'
  if (SET_VARIABLES.includes(field)) return 'set'
  return formField && formField.options.length ? 'choice' : 'text'
}

/**
 * What a field of a RISK rule is (BR-RSK-07): $category is the supplier's categories, a list read with anyIn; the
 * screening answers, $tier, $inherentTier and $payeeType always hold one of their values. Anything else is no field
 * of a risk assessment (text, which checkRule refuses as RISK_FIELD).
 */
export function riskFieldKind(field: string): FieldKind {
  if (field === '$category') return 'set'
  return RISK_FIELDS.includes(field) ? 'fixed' : 'text'
}

/** The values a RISK rule's field takes, in order; [] for $category, whose codes are typed */
export function riskFieldValues(field: string): readonly string[] {
  if ((SCREENING_FIELDS as readonly string[]).includes(field)) return ['Y', 'N']
  if (field === '$tier' || field === '$inherentTier') return RISK_TIERS
  if (field === '$payeeType') return PAYEE_TYPES
  return []
}

export const OPS_BY_KIND: Readonly<Record<FieldKind, readonly Op[]>> = {
  money: ['gt', 'gte', 'lt', 'lte', 'eq', 'ne'],
  requestType: ['eq', 'ne', 'in'],
  set: ['anyIn', 'empty', 'notEmpty'],
  choice: ['eq', 'ne', 'in', 'anyIn', 'empty', 'notEmpty'],
  text: ['eq', 'ne', 'empty', 'notEmpty'],
  // Never empty, and a tier is a word, not a number: more or less than it would match nothing (§7.9)
  fixed: ['eq', 'ne', 'in'],
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

/** RISK_FIELD: a row of a RISK rule names what an assessment does not have (WF_LINT_RISK_FIELD) */
export type RowError = 'FIELD' | 'OP' | 'VALUE' | 'MONEY' | 'VALUES' | 'RISK_FIELD'

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
  readonly scope: RuleScope
  readonly requestTypeCodes: readonly string[]
  /** RISK_ASSESSMENT only */
  readonly riskDomains: readonly string[]
  readonly condition: ConditionDraft
  readonly reviewers: readonly ReviewerValue[]
  readonly fallback: ReviewerValue | null
  readonly mode: Mode
  readonly quorumCount: string
  readonly slaHours: string
  readonly descriptionTh: string
}

export type RuleField = 'code' | 'requestTypes' | 'riskDomains' | 'condition' | 'reviewers' | 'fallback' | 'quorumCount' | 'slaHours' | 'descriptionTh'
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

/** The prefix of a new rule's code: RV for a request's reviewers, RR for a risk assessment's (as SIMEC's RR-01 to RR-04) */
export const codePrefixOf = (scope: RuleScope) => (scope === 'RISK_ASSESSMENT' ? 'RR' : 'RV')

/** The next free code after the rules' own: RV-01 … RV-10 → RV-11 (codes are unique across both scopes) */
export function nextRuleCode(rules: readonly { readonly code: string }[], prefix = 'RV'): string {
  const own = new RegExp(`^${prefix}-(\\d+)$`)
  const numbers = rules.map((r) => own.exec(r.code)?.[1]).filter((n): n is string => n !== undefined).map(Number)
  const next = (numbers.length ? Math.max(...numbers) : 0) + 1
  return `${prefix}-${String(next).padStart(2, '0')}`
}

/** A rule as its form; `scope` is the scope of a new rule (an existing rule keeps its own) */
export function ruleDraftOf(rule: RuleValue | null, rules: readonly RuleValue[], defaultSlaHours: string, scope: RuleScope = 'REQUEST'): RuleDraft {
  if (!rule) {
    return {
      code: nextRuleCode(rules, codePrefixOf(scope)),
      scope,
      requestTypeCodes: [],
      riskDomains: [],
      condition: { join: 'all', rows: [], nested: null },
      reviewers: [{ kind: 'POSITION_AT', position: '', department: '' }],
      fallback: null,
      mode: 'ALL',
      quorumCount: '',
      slaHours: defaultSlaHours,
      descriptionTh: '',
    }
  }
  return {
    code: rule.code,
    scope: scopeOf(rule),
    requestTypeCodes: rule.requestTypeCodes,
    riskDomains: rule.riskDomains ?? [],
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
 * A RISK_ASSESSMENT rule as the lint will (WF_LINT_RISK_*): no request type, one part of the assessment at least,
 * rows on the fields of an assessment only, and one reviewer who must pass (ALL, whatever the form held).
 */
export function checkRule(draft: RuleDraft, rules: readonly RuleValue[], editing: string | null, kindOf: (field: string) => FieldKind, slaMaxHours: number): RuleCheck {
  const errors: Partial<Record<RuleField, RuleError>> = {}
  const risk = draft.scope === 'RISK_ASSESSMENT'
  const mode: Mode = risk ? 'ALL' : draft.mode
  const code = draft.code.trim().toUpperCase()
  if (!CODE.test(code)) errors.code = 'CODE'
  else if (rules.some((r) => r.code === code && r.code !== editing)) errors.code = 'DUPLICATE'
  if (!risk && draft.requestTypeCodes.length === 0) errors.requestTypes = 'REQUIRED'
  const riskDomains = RISK_DOMAIN_CODES.filter((d) => draft.riskDomains.includes(d))
  if (risk && riskDomains.length === 0) errors.riskDomains = 'REQUIRED'
  const rowErrors: Record<number, RowError> = {}
  if (!draft.condition.nested) {
    draft.condition.rows.forEach((row, i) => {
      const e = risk && row.field !== '' && !RISK_FIELDS.includes(row.field) ? 'RISK_FIELD' : rowError(row, kindOf)
      if (e) rowErrors[i] = e
    })
    if (Object.keys(rowErrors).length) errors.condition = 'ROWS'
  }
  const reviewers = draft.reviewers
  if (reviewers.length === 0) errors.reviewers = 'REQUIRED'
  else if (!reviewers.every(reviewerComplete)) errors.reviewers = 'INCOMPLETE'
  else if (mode !== 'COUNT' && reviewers.length !== 1) errors.reviewers = 'ONE_REVIEWER'
  else if (mode === 'COUNT' && reviewers.length < 2) errors.reviewers = 'TWO_REVIEWERS'
  else if (reviewers.length > MAX_REVIEWERS) errors.reviewers = 'TOO_MANY'
  if (draft.fallback && !reviewerComplete(draft.fallback)) errors.fallback = 'INCOMPLETE'
  let quorumCount: number | null = null
  if (mode === 'COUNT') {
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
      // A REQUEST rule stays as it was before S11, without the two keys (the service reads them as REQUEST and none)
      ...(risk ? { scope: 'RISK_ASSESSMENT' as const, riskDomains } : {}),
      requestTypeCodes: risk ? [] : [...draft.requestTypeCodes],
      when: conditionOf(draft.condition, kindOf),
      reviewers: [...reviewers],
      fallback: draft.fallback,
      mode,
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

/**
 * Moves a rule one place up or down among the rules of its own scope (the order the slots are numbered in, BR-WF-06;
 * each scope is a list of its own on screen); no dragging (NG-4)
 */
export function moveRule(rules: readonly RuleValue[], code: string, by: -1 | 1): RuleValue[] {
  const i = rules.findIndex((r) => r.code === code)
  if (i < 0) return [...rules]
  const scope = scopeOf(rules[i]!)
  let j = i + by
  while (j >= 0 && j < rules.length && scopeOf(rules[j]!) !== scope) j += by
  if (j < 0 || j >= rules.length) return [...rules]
  const next = [...rules]
  ;[next[i], next[j]] = [next[j]!, next[i]!]
  return next
}

// ---------- what changed against the saved version ----------

/** scope and riskDomains as the service's comparison names them (WorkflowRuleField, S11-06) */
export type RulePart = 'requestTypes' | 'when' | 'reviewers' | 'fallback' | 'mode' | 'sla' | 'description' | 'scope' | 'riskDomains'

const domainsKey = (r: RuleValue) => canonical([...(r.riskDomains ?? [])].sort())

/** A rule with its scope and parts written out, so a rule read with them and the same rule without compare equal */
const withScope = (r: RuleValue): RuleValue => ({ ...r, scope: scopeOf(r), riskDomains: [...(r.riskDomains ?? [])].sort() })

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
    scope: scopeOf(r),
    riskDomains: domainsKey(r),
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
  return canonical(saved.rules.map(withScope)) !== canonical(now.rules.map(withScope)) || canonical(saved.testCases) !== canonical(now.testCases) || saved.effectiveDate !== now.effectiveDate
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

// ---------- an assessment of the dry-run of the risk rules (S11-06 · BR-RSK-07) ----------

/** What the service's dry-run reads of a supplier risk assessment (riskCases) */
export interface RiskCaseValue {
  readonly screening: Readonly<Record<ScreeningField, 'Y' | 'N'>>
  /** The tier frozen at the send */
  readonly tier: RiskTier
  /** The tier before the answers; the service takes the tier when it is left out */
  readonly inherentTier?: RiskTier
  readonly categoryCodes: readonly string[]
  readonly payeeType: PayeeType
  /** The member who opened it: never its reviewer (BR-SOD-16), so the fallback stands in */
  readonly openedById: string
}

export interface RiskCaseDraft {
  readonly screening: Readonly<Record<ScreeningField, 'Y' | 'N'>>
  readonly tier: RiskTier
  /** '' = the same as the tier */
  readonly inherentTier: RiskTier | ''
  /** Codes typed with commas */
  readonly categoryCodes: string
  readonly payeeType: PayeeType
  readonly openedById: string
}

export const MAX_RISK_CASES = 20

/** A new assessment to try: nothing screened in, the lowest tier, a juristic person, opened by the given member */
export function riskCaseDraftOf(openedById: string | null): RiskCaseDraft {
  return { screening: { processesPersonalData: 'N', accessesSystems: 'N', accessesPremises: 'N' }, tier: 'LOW', inherentTier: '', categoryCodes: '', payeeType: 'JURISTIC', openedById: openedById ?? '' }
}

/** The form as the dry-run's input; who opened it is the one thing to choose */
export function riskCaseOf(d: RiskCaseDraft): { readonly ok: true; readonly value: RiskCaseValue } | { readonly ok: false; readonly errors: { readonly openedById: 'REQUIRED' } } {
  if (d.openedById === '') return { ok: false, errors: { openedById: 'REQUIRED' } }
  return {
    ok: true,
    value: { screening: { ...d.screening }, tier: d.tier, ...(d.inherentTier !== '' ? { inherentTier: d.inherentTier } : {}), categoryCodes: codesOf(d.categoryCodes), payeeType: d.payeeType, openedById: d.openedById },
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

/**
 * What the save sends: the draft as the service's update reads it (quorumCount only for COUNT). A RISK_ASSESSMENT rule
 * carries its scope and parts, no request type, and ALL; a REQUEST rule goes without the two keys, which the service
 * reads as REQUEST and none (S11-06).
 */
export function saveInput(versionId: string, lock: number, effectiveDate: string, changeReason: string, rules: readonly RuleValue[], testCases: readonly TestCaseValue[]): SaveInput {
  const ruleOf = ({ scope, riskDomains, ...r }: RuleValue) =>
    scope === 'RISK_ASSESSMENT'
      ? { ...r, scope, riskDomains: RISK_DOMAIN_CODES.filter((d) => (riskDomains ?? []).includes(d)), requestTypeCodes: [], reviewers: [...r.reviewers], mode: 'ALL' as const, quorumCount: null }
      : { ...r, requestTypeCodes: [...r.requestTypeCodes], reviewers: [...r.reviewers], quorumCount: r.mode === 'COUNT' ? r.quorumCount : null }
  return {
    versionId,
    version: lock,
    effectiveDate,
    changeReason: changeReason.trim(),
    rules: rules.map(ruleOf),
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
