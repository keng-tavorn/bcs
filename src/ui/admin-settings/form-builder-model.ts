import type { AttachmentRule, Comparison, Condition, Op, Requirement, VisibilityRule } from '@/core/forms'
import { FIELD_TYPES, type FieldDef, type FieldType, type FormText } from '@/core/forms/fields'
import { stableStringify } from '@/lib/json'
import { normalizeBaht } from '../admin-workflow/model'

// The no-code form builder's model (S6-14 · FR-INT-104 · BR-FORM-09): pure functions over the whole draft form of a
// request type (spec §7.9, the JSON the service stores) — fields added, edited, removed and moved up or down with buttons
// (no dragging), the condition that shows a field, and the attachment rules — and the drafts the dialogs edit, checked as
// the form schema will check them so most mistakes are said next to the input. The service checks and lints the whole
// form again on every save and publish. Conditions are edited as rows joined by "all"; a stored condition with "any" or
// groups inside groups, and a requirement with either/or or fields, are kept as they are and shown in words.

export { FIELD_TYPES }
export type { FieldType }

/** The draft form as the service sends and takes it (FormVersion.schema) */
export interface BuilderForm {
  readonly fields: readonly FieldDef[]
  readonly visibility: readonly VisibilityRule[]
  readonly rules: readonly AttachmentRule[]
  readonly lines: { readonly serviceEndDate?: { readonly when: Condition } }
  readonly steps?: ReadonlyArray<{ readonly key: string; readonly titleTh: string; readonly titleEn: string; readonly fields: readonly string[]; readonly optional: boolean }>
}

/** FileLink kinds an attachment rule may ask for (the service's ATTACHMENT_KINDS; tests/unit/form-builder-model.test.ts compares them) */
// the service's list (request-types/form-import.ts): a 50 ทวิ (WHT_CERT) and a bank proof (BANK_PROOF) are finance files a
// request never carries (S9-01)
export const ATTACHMENT_KINDS = ['QUOTATION', 'DELIVERY_NOTE', 'PHOTO', 'JUSTIFICATION', 'INVOICE', 'PO_PDF', 'DPA', 'ETAX', 'REGISTRY_PROOF', 'OTHER'] as const

/** Values of the request a condition may read besides the form's own fields */
export const SPECIAL_FIELDS = ['$amountGross', '$amountNet', '$requestType'] as const
const MONEY_SPECIAL = ['$amountGross', '$amountNet']

const FIELD_ID = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const RULE_ID_MAX = 64

export const isChoiceType = (type: FieldType) => type === 'select' || type === 'multiselect'

/** The JSON a save sends: the whole form */
export const formJson = (form: BuilderForm) => JSON.stringify(form)

/** Two forms say the same, whatever the order of their keys */
export const sameBuilderForm = (a: BuilderForm, b: BuilderForm) => stableStringify(a) === stableStringify(b)

// ---------- the list of fields ----------

/** The item moved one place up or down; at an end it stays */
export function moveItem<T>(list: readonly T[], index: number, direction: 'UP' | 'DOWN'): T[] {
  const to = direction === 'UP' ? index - 1 : index + 1
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return [...list]
  const next = [...list]
  ;[next[index], next[to]] = [next[to]!, next[index]!]
  return next
}

export const addField = (form: BuilderForm, def: FieldDef): BuilderForm => ({ ...form, fields: [...form.fields, def] })

/** The field `oldId` replaced; a new id carries its own visibility condition and its place in a step with it */
export function replaceField(form: BuilderForm, oldId: string, def: FieldDef): BuilderForm {
  const fields = form.fields.map((f) => (f.id === oldId ? def : f))
  if (def.id === oldId) return { ...form, fields }
  return {
    ...form,
    fields,
    visibility: form.visibility.map((v) => (v.field === oldId ? { ...v, field: def.id } : v)),
    ...(form.steps ? { steps: form.steps.map((s) => ({ ...s, fields: s.fields.map((f) => (f === oldId ? def.id : f)) })) } : {}),
  }
}

/** The field gone with its own visibility condition and its place in a step; rules that read it are the lint's to name */
export function removeField(form: BuilderForm, id: string): BuilderForm {
  return {
    ...form,
    fields: form.fields.filter((f) => f.id !== id),
    visibility: form.visibility.filter((v) => v.field !== id),
    ...(form.steps ? { steps: form.steps.map((s) => ({ ...s, fields: s.fields.filter((f) => f !== id) })) } : {}),
  }
}

export function moveField(form: BuilderForm, id: string, direction: 'UP' | 'DOWN'): BuilderForm {
  return { ...form, fields: moveItem(form.fields, form.fields.findIndex((f) => f.id === id), direction) }
}

/** The condition that shows the field, or null when it always shows */
export const visibilityOf = (form: BuilderForm, field: string): Condition | null => form.visibility.find((v) => v.field === field)?.when ?? null

/** The field shown under `when` (one entry, where its first one was), or always (null) */
export function setVisibility(form: BuilderForm, field: string, when: Condition | null): BuilderForm {
  const at = form.visibility.findIndex((v) => v.field === field)
  const others = form.visibility.filter((v) => v.field !== field)
  if (!when) return { ...form, visibility: others }
  const entry = { field, when }
  if (at === -1) return { ...form, visibility: [...others, entry] }
  const before = form.visibility.slice(0, at).filter((v) => v.field !== field).length
  return { ...form, visibility: [...others.slice(0, before), entry, ...others.slice(before)] }
}

// ---------- attachment rules ----------

export const addRule = (form: BuilderForm, rule: AttachmentRule): BuilderForm => ({ ...form, rules: [...form.rules, rule] })
export const replaceRule = (form: BuilderForm, oldId: string, rule: AttachmentRule): BuilderForm => ({ ...form, rules: form.rules.map((r) => (r.id === oldId ? rule : r)) })
export const removeRule = (form: BuilderForm, id: string): BuilderForm => ({ ...form, rules: form.rules.filter((r) => r.id !== id) })
export const moveRule = (form: BuilderForm, id: string, direction: 'UP' | 'DOWN'): BuilderForm => ({ ...form, rules: moveItem(form.rules, form.rules.findIndex((r) => r.id === id), direction) })

// ---------- one field as the dialog edits it ----------

export interface OptionDraft {
  readonly value: string
  readonly th: string
  readonly en: string
}

export interface FieldDraft {
  readonly id: string
  readonly type: FieldType
  readonly required: boolean
  readonly labelTh: string
  readonly labelEn: string
  readonly helpTh: string
  readonly helpEn: string
  /** select and multiselect only */
  readonly options: readonly OptionDraft[]
}

export const emptyFieldDraft = (): FieldDraft => ({ id: '', type: 'text', required: false, labelTh: '', labelEn: '', helpTh: '', helpEn: '', options: [] })
export const emptyOption = (): OptionDraft => ({ value: '', th: '', en: '' })

export function fieldDraftOf(def: FieldDef): FieldDraft {
  return {
    id: def.id,
    type: def.type,
    required: def.required === true,
    labelTh: def.label?.th ?? '',
    labelEn: def.label?.en ?? '',
    helpTh: def.help?.th ?? '',
    helpEn: def.help?.en ?? '',
    options: (def.options ?? []).map((value) => ({ value, th: def.optionLabels?.[value]?.th ?? '', en: def.optionLabels?.[value]?.en ?? '' })),
  }
}

export type FieldDraftKey = 'id' | 'label' | 'help' | 'options'
export type FieldDraftError = 'ID_REQUIRED' | 'ID_FORMAT' | 'ID_TAKEN' | 'LABEL_REQUIRED' | 'HELP_BOTH' | 'OPTIONS_REQUIRED' | 'OPTION_VALUE' | 'OPTION_DUPLICATE' | 'OPTION_LABEL_BOTH'

/** Thai and English together, or neither (FormText needs both) */
function textPair(th: string, en: string): FormText | null | 'HALF' {
  const [a, b] = [th.trim(), en.trim()]
  if (!a && !b) return null
  return a && b ? { th: a, en: b } : 'HALF'
}

/**
 * The field the draft makes, or what is wrong with it. `takenIds`: the ids of the form's other fields. `original`: the
 * field edited, so what the dialog does not edit (maxLength, a required: false written out) stays as it was and an
 * unchanged field saves exactly as stored.
 */
export function checkFieldDraft(draft: FieldDraft, takenIds: readonly string[], original: FieldDef | null): { ok: true; def: FieldDef } | { ok: false; errors: Partial<Record<FieldDraftKey, FieldDraftError>> } {
  const errors: Partial<Record<FieldDraftKey, FieldDraftError>> = {}
  const id = draft.id.trim()
  if (!id) errors.id = 'ID_REQUIRED'
  else if (!FIELD_ID.test(id)) errors.id = 'ID_FORMAT'
  else if (takenIds.includes(id)) errors.id = 'ID_TAKEN'
  const label = textPair(draft.labelTh, draft.labelEn)
  // A question without words would show its id to requesters: a new one needs them; one stored without keeps none
  if (label === 'HALF' || (label === null && !(original && !original.label))) errors.label = 'LABEL_REQUIRED'
  const help = textPair(draft.helpTh, draft.helpEn)
  if (help === 'HALF') errors.help = 'HELP_BOTH'
  const choice = isChoiceType(draft.type)
  const optionLabels: Record<string, FormText> = {}
  if (choice) {
    const values = draft.options.map((o) => o.value.trim())
    if (values.length === 0) errors.options = 'OPTIONS_REQUIRED'
    else if (values.some((v) => v === '')) errors.options = 'OPTION_VALUE'
    else if (new Set(values).size !== values.length) errors.options = 'OPTION_DUPLICATE'
    else
      for (const o of draft.options) {
        const pair = textPair(o.th, o.en)
        if (pair === 'HALF') errors.options = 'OPTION_LABEL_BOTH'
        else if (pair) optionLabels[o.value.trim()] = pair
      }
  }
  if (Object.keys(errors).length) return { ok: false, errors }
  const keepMaxLength = original?.maxLength !== undefined && (draft.type === 'text' || draft.type === 'textarea')
  const def: FieldDef = {
    id,
    type: draft.type,
    ...(draft.required ? { required: true } : original?.required === false ? { required: false } : {}),
    ...(choice ? { options: draft.options.map((o) => o.value.trim()) } : {}),
    ...(keepMaxLength ? { maxLength: original.maxLength } : {}),
    ...(label && label !== 'HALF' ? { label } : {}),
    ...(help && help !== 'HALF' ? { help } : {}),
    ...(choice && Object.keys(optionLabels).length ? { optionLabels } : {}),
  }
  return { ok: true, def }
}

// ---------- a condition as rows joined by "all" ----------

export interface ConditionRow {
  readonly field: string
  readonly op: Op | ''
  /** The value as typed; "in" takes values split by commas */
  readonly value: string
}

export const emptyRow = (): ConditionRow => ({ field: '', op: '', value: '' })

const isComparison = (c: Condition): c is Comparison => 'field' in c

function rowOf(c: Comparison): ConditionRow {
  const value = Array.isArray(c.value) ? c.value.map(String).join(', ') : c.value === undefined || c.value === null ? '' : String(c.value)
  return { field: c.field, op: c.op, value }
}

/** The rows of a condition the builder can edit, or null when it has "any" or groups inside groups (kept as stored) */
export function rowsOf(condition: Condition): ConditionRow[] | null {
  if ('any' in condition) return null
  if ('all' in condition) return condition.all.every(isComparison) ? condition.all.map((c) => rowOf(c as Comparison)) : null
  return [rowOf(condition)]
}

export type FieldKind = 'money' | 'number' | 'choice' | 'text' | 'requestType'

/** What a field is for the operators and the value a row takes */
export function fieldKind(field: string, fields: readonly FieldDef[]): FieldKind {
  if (MONEY_SPECIAL.includes(field)) return 'money'
  if (field === '$requestType') return 'requestType'
  const def = fields.find((f) => f.id === field)
  if (!def) return 'text'
  if (def.type === 'money') return 'money'
  if (def.type === 'number' || def.type === 'date') return 'number'
  if (isChoiceType(def.type) || def.type === 'checkbox') return 'choice'
  return 'text'
}

export const OPS_BY_KIND: Readonly<Record<FieldKind, readonly Op[]>> = {
  money: ['gt', 'gte', 'lt', 'lte', 'eq', 'ne'],
  number: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'empty', 'notEmpty'],
  choice: ['eq', 'ne', 'in', 'empty', 'notEmpty'],
  text: ['eq', 'ne', 'in', 'empty', 'notEmpty'],
  requestType: ['eq', 'ne', 'in'],
}

export const takesValue = (op: Op | '') => op !== '' && op !== 'empty' && op !== 'notEmpty'

/** The values a choice row picks from: the options of a select, yes or no of a checkbox */
export function choicesOf(field: string, fields: readonly FieldDef[]): readonly string[] {
  const def = fields.find((f) => f.id === field)
  if (!def) return []
  if (def.type === 'checkbox') return ['true', 'false']
  return def.options ?? []
}

export type RowError = 'FIELD' | 'OP' | 'VALUE' | 'MONEY'

const splitList = (text: string) => [...new Set(text.split(',').map((v) => v.trim()).filter((v) => v !== ''))]

/** One row as a comparison of §7.9 (money as baht text with two decimals, BR-MONEY-01), or what is wrong with it */
export function comparisonOf(row: ConditionRow, fields: readonly FieldDef[]): { ok: true; comparison: Comparison } | { ok: false; error: RowError } {
  const known = (SPECIAL_FIELDS as readonly string[]).includes(row.field) || fields.some((f) => f.id === row.field)
  if (!row.field || !known) return { ok: false, error: 'FIELD' }
  const kind = fieldKind(row.field, fields)
  if (!row.op || !OPS_BY_KIND[kind].includes(row.op)) return { ok: false, error: 'OP' }
  if (!takesValue(row.op)) return { ok: true, comparison: { field: row.field, op: row.op } }
  if (row.op === 'in') {
    const values = splitList(row.value)
    if (!values.length) return { ok: false, error: 'VALUE' }
    if (kind !== 'money') return { ok: true, comparison: { field: row.field, op: 'in', value: values } }
    const amounts = values.map(normalizeBaht)
    return amounts.every((a) => a !== null) ? { ok: true, comparison: { field: row.field, op: 'in', value: amounts } } : { ok: false, error: 'MONEY' }
  }
  const text = row.value.trim()
  if (!text) return { ok: false, error: 'VALUE' }
  if (kind !== 'money') return { ok: true, comparison: { field: row.field, op: row.op, value: text } }
  const amount = normalizeBaht(text)
  return amount === null ? { ok: false, error: 'MONEY' } : { ok: true, comparison: { field: row.field, op: row.op, value: amount } }
}

/** The rows as comparisons, or the error of each row that has one */
export function checkRows(rows: readonly ConditionRow[], fields: readonly FieldDef[]): { ok: true; comparisons: Comparison[] } | { ok: false; errors: Record<number, RowError> } {
  const errors: Record<number, RowError> = {}
  const comparisons: Comparison[] = []
  rows.forEach((row, i) => {
    const c = comparisonOf(row, fields)
    if (c.ok) comparisons.push(c.comparison)
    else errors[i] = c.error
  })
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, comparisons }
}

/** Comparisons joined by "all": none holds always ({ all: [] }), one stands alone */
export function conditionOf(comparisons: readonly Comparison[]): Condition {
  return comparisons.length === 1 ? comparisons[0]! : { all: [...comparisons] }
}

// ---------- what an attachment rule asks for ----------

export interface RequirementRow {
  readonly kind: string
  /** At least this many files, as typed */
  readonly min: string
}

export const emptyRequirementRow = (): RequirementRow => ({ kind: '', min: '1' })

/** The kinds and counts of a requirement the builder can edit (one kind, or several all needed), or null (kept as stored) */
export function requirementRowsOf(requirement: Requirement): RequirementRow[] | null {
  if ('attachments' in requirement) return [{ kind: requirement.attachments, min: String(requirement.min) }]
  if ('all' in requirement && requirement.all.length > 0 && requirement.all.every((r) => 'attachments' in r)) {
    return requirement.all.map((r) => {
      const one = r as { attachments: string; min: number }
      return { kind: one.attachments, min: String(one.min) }
    })
  }
  return null
}

export type RequirementError = 'KIND' | 'MIN'
const COUNT = /^[1-9]\d{0,2}$/

export function checkRequirementRows(rows: readonly RequirementRow[]): { ok: true; requirement: Requirement } | { ok: false; empty: boolean; errors: Record<number, RequirementError> } {
  if (!rows.length) return { ok: false, empty: true, errors: {} }
  const errors: Record<number, RequirementError> = {}
  rows.forEach((row, i) => {
    if (!(ATTACHMENT_KINDS as readonly string[]).includes(row.kind)) errors[i] = 'KIND'
    else if (!COUNT.test(row.min.trim())) errors[i] = 'MIN'
  })
  if (Object.keys(errors).length) return { ok: false, empty: false, errors }
  const parts = rows.map((r) => ({ attachments: r.kind, min: Number(r.min.trim()) }))
  return { ok: true, requirement: parts.length === 1 ? parts[0]! : { all: parts } }
}

// ---------- one attachment rule as the dialog edits it ----------

export interface RuleDraft {
  readonly id: string
  /** The condition as rows, or null while a stored condition the rows cannot show is kept */
  readonly when: readonly ConditionRow[] | null
  readonly storedWhen: Condition | null
  readonly require: readonly RequirementRow[] | null
  readonly storedRequire: Requirement | null
}

export const emptyRuleDraft = (): RuleDraft => ({ id: '', when: [], storedWhen: null, require: [emptyRequirementRow()], storedRequire: null })

export function ruleDraftOf(rule: AttachmentRule): RuleDraft {
  return { id: rule.id, when: rowsOf(rule.when), storedWhen: rule.when, require: requirementRowsOf(rule.require), storedRequire: rule.require }
}

export interface RuleDraftErrors {
  readonly id?: 'ID_REQUIRED' | 'ID_FORMAT' | 'ID_TAKEN'
  readonly when?: Record<number, RowError>
  readonly require?: Record<number, RequirementError>
  readonly requireEmpty?: boolean
}

export function checkRuleDraft(draft: RuleDraft, takenIds: readonly string[], fields: readonly FieldDef[]): { ok: true; rule: AttachmentRule } | { ok: false; errors: RuleDraftErrors } {
  const errors: { -readonly [K in keyof RuleDraftErrors]: RuleDraftErrors[K] } = {}
  const id = draft.id.trim()
  if (!id) errors.id = 'ID_REQUIRED'
  else if (id.length > RULE_ID_MAX || /\s/.test(id)) errors.id = 'ID_FORMAT'
  else if (takenIds.includes(id)) errors.id = 'ID_TAKEN'
  let when: Condition | null = draft.storedWhen
  if (draft.when) {
    const rows = checkRows(draft.when, fields)
    if (rows.ok) when = conditionOf(rows.comparisons)
    else errors.when = rows.errors
  }
  let require: Requirement | null = draft.storedRequire
  if (draft.require) {
    const rows = checkRequirementRows(draft.require)
    if (rows.ok) require = rows.requirement
    else if (rows.empty) errors.requireEmpty = true
    else errors.require = rows.errors
  }
  if (Object.keys(errors).length || !when || !require) return { ok: false, errors }
  return { ok: true, rule: { id, when, require } }
}

// ---------- the lint of BR-FORM-09 ----------

/** A reader named by the lint: an attachment rule's id, `visibility:<field>`, or a workflow rule's code */
export function readerOf(by: string): { kind: 'VISIBILITY'; field: string } | { kind: 'RULE'; id: string } {
  return by.startsWith('visibility:') ? { kind: 'VISIBILITY', field: by.slice('visibility:'.length) } : { kind: 'RULE', id: by }
}
