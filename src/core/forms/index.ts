import { DECIMAL_COMPARE_SCALE } from '../money/constants'
import { vatFromGross, type Satang } from '../money/math'

// Dynamic forms (spec §7.9, BR-FORM-01 to BR-FORM-06): conditions decide which fields show and which attachments a
// request needs; hidden fields are dropped before saving and never checked. Quotations are data and the lowest
// price before VAT must be chosen unless a reason is given. Pure; results are structured so screens say it in Thai
// or English.

export const OPS = ['eq', 'ne', 'in', 'gt', 'gte', 'lt', 'lte', 'empty', 'notEmpty'] as const
export type Op = (typeof OPS)[number]

export type Condition =
  | { readonly all: readonly Condition[] }
  | { readonly any: readonly Condition[] }
  | { readonly field: string; readonly op: Op; readonly value?: unknown }

export type Requirement =
  | { readonly attachments: string; readonly min: number }
  | { readonly all: readonly Requirement[] }
  | { readonly any: readonly Requirement[] }
  | { readonly field: string; readonly op: Op; readonly value?: unknown }

export interface AttachmentRule {
  readonly id: string
  readonly when: Condition
  readonly require: Requirement
}

export interface VisibilityRule {
  readonly field: string
  readonly when: Condition
}

export interface FormInput {
  readonly fields: Readonly<Record<string, unknown>>
  /** Number of attachments per kind (QUOTATION, DPA, …) */
  readonly attachments: Readonly<Record<string, number>>
  /** Special variables: $amountGross and $amountNet in satang, $requestType */
  readonly variables: { readonly $amountGross: Satang; readonly $amountNet: Satang; readonly $requestType: string }
}

export type Missing = { readonly kind: 'ATTACHMENT'; readonly attachment: string; readonly need: number; readonly have: number } | { readonly kind: 'FIELD'; readonly field: string; readonly op: Op }

export type FormResult =
  | { readonly ok: true; readonly fields: Readonly<Record<string, unknown>>; readonly droppedFields: readonly string[] }
  | { readonly ok: false; readonly error: 'ATTACHMENT_RULE_FAILED'; readonly rule: string; readonly failures: readonly { rule: string; missing: readonly Missing[] }[] }

const DECIMAL = /^-?\d+(\.\d+)?$/

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '') || (Array.isArray(value) && value.length === 0)
}

/** Compares two numbers written as decimal strings (or bigint/number values) without floating point. */
function compareNumbers(a: unknown, b: unknown): number | null {
  const toScaled = (x: unknown): bigint | null => {
    if (typeof x === 'bigint') return x * DECIMAL_COMPARE_SCALE
    const s = typeof x === 'number' && Number.isFinite(x) ? String(x) : typeof x === 'string' ? x.trim() : null
    if (s === null || !DECIMAL.test(s)) return null
    const negative = s.startsWith('-')
    const [whole, fraction = ''] = (negative ? s.slice(1) : s).split('.')
    if (fraction.length > 18) return null
    const scaled = BigInt(whole!) * DECIMAL_COMPARE_SCALE + BigInt(fraction.padEnd(18, '0'))
    return negative ? -scaled : scaled
  }
  const x = toScaled(a)
  const y = toScaled(b)
  if (x === null || y === null) return null
  return x < y ? -1 : x > y ? 1 : 0
}

function valueOf(field: string, input: FormInput): unknown {
  if (field === '$amountGross') return input.variables.$amountGross
  if (field === '$amountNet') return input.variables.$amountNet
  if (field === '$requestType') return input.variables.$requestType
  return input.fields[field]
}

/** Money variables are satang; the condition writes baht ("100000.00"), so compare in satang. */
function comparable(field: string, value: unknown): unknown {
  if ((field === '$amountGross' || field === '$amountNet') && typeof value === 'string' && /^\d+(\.\d{1,2})?$/.test(value)) {
    const [whole, fraction = ''] = value.split('.')
    return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'))
  }
  return value
}

export function evaluateCondition(condition: Condition, input: FormInput): boolean {
  if ('all' in condition) return condition.all.every((c) => evaluateCondition(c, input))
  if ('any' in condition) return condition.any.some((c) => evaluateCondition(c, input))
  const actual = valueOf(condition.field, input)
  const expected = comparable(condition.field, condition.value)
  switch (condition.op) {
    case 'empty':
      return isEmpty(actual)
    case 'notEmpty':
      return !isEmpty(actual)
    case 'eq':
      return String(actual) === String(expected)
    case 'ne':
      return String(actual) !== String(expected)
    case 'in':
      return Array.isArray(expected) && expected.map(String).includes(String(actual))
    default: {
      const order = compareNumbers(actual, expected)
      if (order === null) return false
      if (condition.op === 'gt') return order > 0
      if (condition.op === 'gte') return order >= 0
      if (condition.op === 'lt') return order < 0
      return order <= 0
    }
  }
}

function unmet(requirement: Requirement, input: FormInput): Missing[] {
  if ('attachments' in requirement) {
    const have = input.attachments[requirement.attachments] ?? 0
    return have >= requirement.min ? [] : [{ kind: 'ATTACHMENT', attachment: requirement.attachments, need: requirement.min, have }]
  }
  if ('all' in requirement) return requirement.all.flatMap((r) => unmet(r, input))
  if ('any' in requirement) {
    const options = requirement.any.map((r) => unmet(r, input))
    return options.some((m) => m.length === 0) ? [] : (options[0] ?? [])
  }
  return evaluateCondition(requirement, input) ? [] : [{ kind: 'FIELD', field: requirement.field, op: requirement.op }]
}

/** BR-FORM-01 then BR-FORM-03: drop hidden fields (they are not checked), then check every attachment rule that applies. */
export function evaluateForm(form: { readonly visibility: readonly VisibilityRule[]; readonly rules: readonly AttachmentRule[] }, input: FormInput): FormResult {
  const dropped = form.visibility.filter((v) => v.field in input.fields && !evaluateCondition(v.when, input)).map((v) => v.field)
  const fields = Object.fromEntries(Object.entries(input.fields).filter(([key]) => !dropped.includes(key)))
  const visible: FormInput = { ...input, fields }
  const failures = form.rules
    .filter((rule) => evaluateCondition(rule.when, visible))
    .map((rule) => ({ rule: rule.id, missing: unmet(rule.require, visible) }))
    .filter((f) => f.missing.length > 0)
  if (failures.length > 0) return { ok: false, error: 'ATTACHMENT_RULE_FAILED', rule: failures[0]!.rule, failures }
  return { ok: true, fields, droppedFields: dropped }
}

export interface QuoteInput {
  readonly ref: string
  readonly amountSatang: Satang
  readonly includesVat: boolean
}

export type QuoteResult =
  | { readonly ok: true; readonly nets: Readonly<Record<string, Satang>>; readonly lowest: readonly string[] }
  | { readonly ok: false; readonly error: 'VALIDATION_FAILED'; readonly rule: 'QUOTE-LOWEST' | 'QUOTE-SELECTED'; readonly nets: Readonly<Record<string, Satang>>; readonly lowest: readonly string[] }

/**
 * BR-FORM-06: every quote's price before VAT with the rate in effect; equal prices share the lowest place. Choosing a
 * quote that is not among the lowest needs a reason (rule QUOTE-LOWEST); exactly one existing quote must be chosen.
 */
export function compareQuotations(quotes: readonly QuoteInput[], selectedRef: string | null, rateBp: number, nonLowestReason?: string | null): QuoteResult {
  const nets: Record<string, Satang> = {}
  for (const q of quotes) nets[q.ref] = q.includesVat ? vatFromGross(q.amountSatang, rateBp).net : q.amountSatang
  const values = Object.values(nets)
  const min = values.reduce<Satang | null>((m, v) => (m === null || v < m ? v : m), null)
  const lowest = quotes.filter((q) => nets[q.ref] === min).map((q) => q.ref)
  if (selectedRef === null || !(selectedRef in nets)) return { ok: false, error: 'VALIDATION_FAILED', rule: 'QUOTE-SELECTED', nets, lowest }
  if (!lowest.includes(selectedRef) && isEmpty(nonLowestReason)) return { ok: false, error: 'VALIDATION_FAILED', rule: 'QUOTE-LOWEST', nets, lowest }
  return { ok: true, nets, lowest }
}
