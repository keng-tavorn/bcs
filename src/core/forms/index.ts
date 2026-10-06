import { DECIMAL_COMPARE_SCALE } from '../money/constants'
import { vatFromGross, type Satang } from '../money/math'
import { satangOf } from './money-text'

// Dynamic forms (spec §7.9, BR-FORM-01 to BR-FORM-06): conditions decide which fields show and which attachments a
// request needs; hidden fields are dropped before saving and never checked. Quotations are data and the lowest
// price before VAT must be chosen unless a reason is given. Pure; results are structured so screens say it in Thai
// or English.

export const OPS = ['eq', 'ne', 'in', 'gt', 'gte', 'lt', 'lte', 'empty', 'notEmpty'] as const
export type Op = (typeof OPS)[number]

/** A field or special variable compared with a value (empty and notEmpty take none) */
export interface Comparison {
  readonly field: string
  readonly op: Op
  readonly value?: unknown
  /**
   * The field is of type money, so it is compared as money (BR-MONEY-01). A form's JSON never carries this: the server
   * sets it from the field definitions when it reads a form (markMoneyFields), and the screens get the form so marked.
   */
  readonly money?: boolean
}

export type Condition = { readonly all: readonly Condition[] } | { readonly any: readonly Condition[] } | Comparison

export type Requirement =
  | { readonly attachments: string; readonly min: number }
  | { readonly all: readonly Requirement[] }
  | { readonly any: readonly Requirement[] }
  | Comparison

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
  /** Answers by field id; a field of type money holds baht text such as "12345.50" (BR-MONEY-01) */
  readonly fields: Readonly<Record<string, unknown>>
  /** Number of attachments per kind (QUOTATION, DPA, …) */
  readonly attachments: Readonly<Record<string, number>>
  /** Special variables: $amountGross and $amountNet in satang, $requestType */
  readonly variables: { readonly $amountGross: Satang; readonly $amountNet: Satang; readonly $requestType: string }
}

export type Missing =
  | { readonly kind: 'ATTACHMENT'; readonly attachment: string; readonly need: number; readonly have: number }
  | { readonly kind: 'FIELD'; readonly field: string; readonly op: Op }
  /** An `any` requirement with no option: nothing can meet it */
  | { readonly kind: 'NO_OPTION' }

export type FormResult =
  | { readonly ok: true; readonly fields: Readonly<Record<string, unknown>>; readonly droppedFields: readonly string[] }
  | { readonly ok: false; readonly error: 'ATTACHMENT_RULE_FAILED'; readonly rule: string; readonly failures: readonly { rule: string; missing: readonly Missing[] }[] }

const DECIMAL = /^-?\d+(\.\d+)?$/

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '') || (Array.isArray(value) && value.length === 0)
}

/**
 * Orders two plain numbers (never money, see compareMoney), written as decimal text or given as bigint or number values,
 * exactly: as integers scaled by 10^18, without floating-point arithmetic.
 */
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

/** The special variables that hold money, in satang ($requestType is text) */
export const MONEY_VARIABLES: readonly string[] = ['$amountGross', '$amountNet']

type ValueOp = Exclude<Op, 'empty' | 'notEmpty'>

/**
 * A comparison of money ($amountGross, $amountNet, and fields of type money once marked) in satang. A rule writes the
 * amount as baht text ("100000.00", §7.0 (3)); code may pass bigint satang. A number, or any other text, is no amount
 * and never matches, so the condition is false, "ne" included (BR-MONEY-01); an answer that is not money matches
 * nothing either. No answer is no amount: it equals none and is neither more nor less than one, so only "ne" holds.
 */
function compareMoney(op: ValueOp, actual: unknown, value: unknown): boolean {
  const amount = satangOf(actual)
  // each listed amount is read like the value of eq; what is not an amount matches nothing
  if (op === 'in') return amount !== null && Array.isArray(value) && value.some((v) => satangOf(v) === amount)
  const expected = satangOf(value)
  if (expected === null) return false
  if (amount === null) return op === 'ne' && isEmpty(actual)
  if (op === 'eq') return amount === expected
  if (op === 'ne') return amount !== expected
  if (op === 'gt') return amount > expected
  if (op === 'gte') return amount >= expected
  if (op === 'lt') return amount < expected
  return amount <= expected
}

/** A missing or null answer is "no value": it equals only another missing value, never the text "undefined" or "null" */
function same(actual: unknown, expected: unknown): boolean {
  const a = actual ?? null
  const e = expected ?? null
  if (a === null || e === null) return a === e
  return String(a) === String(e)
}

export function evaluateCondition(condition: Condition, input: FormInput): boolean {
  if ('all' in condition) return condition.all.every((c) => evaluateCondition(c, input))
  if ('any' in condition) return condition.any.some((c) => evaluateCondition(c, input))
  const actual = valueOf(condition.field, input)
  const op = condition.op
  if (op === 'empty') return isEmpty(actual)
  if (op === 'notEmpty') return !isEmpty(actual)
  if (condition.money === true || MONEY_VARIABLES.includes(condition.field)) return compareMoney(op, actual, condition.value)
  switch (op) {
    case 'eq':
      return same(actual, condition.value)
    case 'ne':
      return !same(actual, condition.value)
    case 'in':
      // each listed value is read like the value of eq
      return Array.isArray(condition.value) && condition.value.some((v) => same(actual, v))
    default: {
      const order = compareNumbers(actual, condition.value)
      if (order === null) return false
      if (op === 'gt') return order > 0
      if (op === 'gte') return order >= 0
      if (op === 'lt') return order < 0
      return order <= 0
    }
  }
}

/**
 * The condition or requirement with each comparison on one of `moneyFields` (ids of the form's fields of type money)
 * marked as money, at any depth. The server marks a form as it reads it, so the screens and the server compare those
 * fields alike; the special variables need no mark.
 */
export function markMoneyFields(node: Condition, moneyFields: ReadonlySet<string>): Condition
export function markMoneyFields(node: Requirement, moneyFields: ReadonlySet<string>): Requirement
export function markMoneyFields(node: Requirement, moneyFields: ReadonlySet<string>): Requirement {
  if ('attachments' in node) return node
  if ('all' in node) return { all: node.all.map((n) => markMoneyFields(n, moneyFields)) }
  if ('any' in node) return { any: node.any.map((n) => markMoneyFields(n, moneyFields)) }
  return moneyFields.has(node.field) ? { ...node, money: true } : node
}

function unmet(requirement: Requirement, input: FormInput): Missing[] {
  if ('attachments' in requirement) {
    const have = input.attachments[requirement.attachments] ?? 0
    return have >= requirement.min ? [] : [{ kind: 'ATTACHMENT', attachment: requirement.attachments, need: requirement.min, have }]
  }
  if ('all' in requirement) return requirement.all.flatMap((r) => unmet(r, input))
  if ('any' in requirement) {
    const options = requirement.any.map((r) => unmet(r, input))
    return options.some((m) => m.length === 0) ? [] : (options[0] ?? [{ kind: 'NO_OPTION' }])
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
