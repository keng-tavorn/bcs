import type { z } from 'zod'
import type { Condition, Requirement } from '@/core/forms'
import type { FormText } from '@/core/forms/fields'
import { BYTES_PER_KIB } from '@/lib/constants'
import { stableStringify } from '@/lib/json'
import { FormSchemaJson } from '@/server/forms/schema'

// A request form imported as JSON (FR-ADM-005 AC1, spec §7.9): the shape is checked with the same schema the server
// reads forms with (src/server/forms/schema.ts), then what the shape cannot say: field and rule ids are unique, every
// condition names a field of the form or a special variable, and every attachment rule asks for a kind of file that
// can be attached. Problems carry a reason and the place in the JSON, so the screen can say each one in Thai or English.

/** Forms are a few kilobytes; the text arrives through a server action (1 MB body limit) */
export const FORM_JSON_MAX_CHARS = 200 * BYTES_PER_KIB
/**
 * Arrays and objects nested deeper than this are no form: a real one nests its conditions a few levels, and a text of
 * thousands of nested conditions would exhaust the call stack of the schema check instead of being reported.
 */
export const FORM_JSON_MAX_DEPTH = 32
/** Problems listed at most, so a wrong file does not flood the screen */
const MAX_PROBLEMS = 20

/** FileLink kinds (prisma enum FileLinkKind); tests/integration/admin-settings-request-types.test.ts compares them */
export const ATTACHMENT_KINDS = ['QUOTATION', 'DELIVERY_NOTE', 'PHOTO', 'JUSTIFICATION', 'INVOICE', 'PO_PDF', 'DPA', 'ETAX', 'REGISTRY_PROOF', 'OTHER'] as const
const SPECIAL_VARIABLES = ['$amountGross', '$amountNet', '$requestType']

export type FormJson = z.output<typeof FormSchemaJson>

export type SchemaIssue = 'TYPE' | 'UNKNOWN_KEY' | 'VALUE' | 'FORMAT' | 'SIZE' | 'SHAPE' | 'OTHER'

export type FormProblem =
  | { readonly reason: 'EMPTY' | 'TOO_LARGE' | 'JSON_SYNTAX' | 'TOO_DEEP' }
  | { readonly reason: 'SCHEMA'; readonly issue: SchemaIssue; readonly path: string; readonly keys?: readonly string[] }
  | { readonly reason: 'DUPLICATE_FIELD'; readonly field: string; readonly path: string }
  | { readonly reason: 'DUPLICATE_RULE'; readonly rule: string; readonly path: string }
  | { readonly reason: 'UNKNOWN_FIELD'; readonly field: string; readonly path: string }
  | { readonly reason: 'UNKNOWN_ATTACHMENT'; readonly attachment: string; readonly path: string }

/** "fields[2].options" from ['fields', 2, 'options'] */
function pathText(path: ReadonlyArray<PropertyKey>): string {
  return path.reduce<string>((s, p) => (typeof p === 'number' ? `${s}[${p}]` : s ? `${s}.${String(p)}` : String(p)), '') || '(form)'
}

const ISSUES: Readonly<Record<string, SchemaIssue>> = {
  invalid_type: 'TYPE',
  unrecognized_keys: 'UNKNOWN_KEY',
  invalid_value: 'VALUE',
  invalid_format: 'FORMAT',
  too_small: 'SIZE',
  too_big: 'SIZE',
  invalid_union: 'SHAPE',
}

function schemaProblems(error: z.ZodError): FormProblem[] {
  return error.issues.map((i) => ({
    reason: 'SCHEMA' as const,
    issue: ISSUES[i.code] ?? 'OTHER',
    path: pathText(i.path),
    ...(i.code === 'unrecognized_keys' ? { keys: i.keys } : {}),
  }))
}

type ConditionNode = Condition | Requirement

/** Field names a condition reads, with where they are. */
function conditionFields(condition: ConditionNode, path: string): Array<{ field: string; path: string }> {
  if ('all' in condition) return (condition.all as readonly ConditionNode[]).flatMap((c, i) => conditionFields(c, `${path}.all[${i}]`))
  if ('any' in condition) return (condition.any as readonly ConditionNode[]).flatMap((c, i) => conditionFields(c, `${path}.any[${i}]`))
  if ('attachments' in condition) return []
  return [{ field: condition.field, path: `${path}.field` }]
}

function attachmentKinds(requirement: Requirement, path: string): Array<{ attachment: string; path: string }> {
  if ('all' in requirement) return requirement.all.flatMap((r, i) => attachmentKinds(r, `${path}.all[${i}]`))
  if ('any' in requirement) return requirement.any.flatMap((r, i) => attachmentKinds(r, `${path}.any[${i}]`))
  if ('attachments' in requirement) return [{ attachment: requirement.attachments, path: `${path}.attachments` }]
  return []
}

function meaningProblems(form: FormJson): FormProblem[] {
  const problems: FormProblem[] = []
  const ids = new Set<string>()
  form.fields.forEach((f, i) => {
    if (ids.has(f.id)) problems.push({ reason: 'DUPLICATE_FIELD', field: f.id, path: `fields[${i}].id` })
    ids.add(f.id)
  })
  const ruleIds = new Set<string>()
  form.rules.forEach((r, i) => {
    if (ruleIds.has(r.id)) problems.push({ reason: 'DUPLICATE_RULE', rule: r.id, path: `rules[${i}].id` })
    ruleIds.add(r.id)
  })
  const known = (field: string) => ids.has(field) || SPECIAL_VARIABLES.includes(field)
  const reads = [
    ...form.visibility.flatMap((v, i) => [{ field: v.field, path: `visibility[${i}].field` }, ...conditionFields(v.when, `visibility[${i}].when`)]),
    ...form.rules.flatMap((r, i) => [...conditionFields(r.when, `rules[${i}].when`), ...conditionFields(r.require, `rules[${i}].require`)]),
    ...(form.lines.serviceEndDate ? conditionFields(form.lines.serviceEndDate.when, 'lines.serviceEndDate.when') : []),
  ]
  for (const read of reads) if (!known(read.field)) problems.push({ reason: 'UNKNOWN_FIELD', field: read.field, path: read.path })
  for (const [i, r] of form.rules.entries()) {
    for (const a of attachmentKinds(r.require, `rules[${i}].require`)) {
      if (!(ATTACHMENT_KINDS as readonly string[]).includes(a.attachment)) problems.push({ reason: 'UNKNOWN_ATTACHMENT', attachment: a.attachment, path: a.path })
    }
  }
  return problems
}

/** Whether arrays and objects nest deeper than `limit` (walked with its own stack, so it cannot overflow itself). */
function nestsDeeperThan(value: unknown, limit: number): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }]
  for (let item = stack.pop(); item; item = stack.pop()) {
    if (item.value === null || typeof item.value !== 'object') continue
    if (item.depth > limit) return true
    for (const child of Array.isArray(item.value) ? item.value : Object.values(item.value)) stack.push({ value: child, depth: item.depth + 1 })
  }
  return false
}

const tooDeep = (): { ok: false; problems: FormProblem[] } => ({ ok: false, problems: [{ reason: 'TOO_DEEP' }] })

/** The form of a JSON text, or every problem found (at most MAX_PROBLEMS). Never throws on any text. */
export function parseFormJson(text: string): { ok: true; form: FormJson } | { ok: false; problems: FormProblem[] } {
  if (!text.trim()) return { ok: false, problems: [{ reason: 'EMPTY' }] }
  if (text.length > FORM_JSON_MAX_CHARS) return { ok: false, problems: [{ reason: 'TOO_LARGE' }] }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return error instanceof RangeError ? tooDeep() : { ok: false, problems: [{ reason: 'JSON_SYNTAX' }] }
  }
  if (nestsDeeperThan(raw, FORM_JSON_MAX_DEPTH)) return tooDeep()
  try {
    const parsed = FormSchemaJson.safeParse(raw)
    if (!parsed.success) return { ok: false, problems: schemaProblems(parsed.error).slice(0, MAX_PROBLEMS) }
    const problems = meaningProblems(parsed.data)
    return problems.length ? { ok: false, problems: problems.slice(0, MAX_PROBLEMS) } : { ok: true, form: parsed.data }
  } catch (error) {
    // The depth limit keeps the checks within the stack; should a shape still exhaust it, it is reported, not thrown
    if (error instanceof RangeError) return tooDeep()
    throw error
  }
}

export interface FormFieldSummary {
  readonly id: string
  readonly type: string
  readonly required: boolean
  readonly label: FormText | null
}

export interface FormSummaryDto {
  readonly fields: readonly FormFieldSummary[]
  /** Ids of the attachment rules */
  readonly rules: readonly string[]
  /** Fields that show only under a condition */
  readonly conditionalFields: readonly string[]
  /** Lines must carry the day the service ends under a condition (BR-FORM-05) */
  readonly serviceEndDate: boolean
}

export function summarizeForm(form: FormJson): FormSummaryDto {
  return {
    fields: form.fields.map((f) => ({ id: f.id, type: f.type, required: f.required === true, label: f.label ?? null })),
    rules: form.rules.map((r) => r.id),
    conditionalFields: form.visibility.map((v) => v.field),
    serviceEndDate: form.lines.serviceEndDate !== undefined,
  }
}

export interface FormChangesDto {
  readonly addedFields: readonly string[]
  readonly removedFields: readonly string[]
  readonly changedFields: readonly string[]
  readonly addedRules: readonly string[]
  readonly removedRules: readonly string[]
  readonly changedRules: readonly string[]
  readonly visibilityChanged: boolean
  readonly linesChanged: boolean
}

function byId<T extends { id: string }>(items: readonly T[]): Map<string, string> {
  return new Map(items.map((item) => [item.id, stableStringify(item)]))
}

/** What the new form changes against the one in use (everything is new when there is none). */
export function formChanges(current: FormJson | null, next: FormJson): FormChangesDto {
  const [oldFields, newFields] = [byId(current?.fields ?? []), byId(next.fields)]
  const [oldRules, newRules] = [byId(current?.rules ?? []), byId(next.rules)]
  const added = (before: Map<string, string>, after: Map<string, string>) => [...after.keys()].filter((k) => !before.has(k))
  const changed = (before: Map<string, string>, after: Map<string, string>) => [...after.keys()].filter((k) => before.has(k) && before.get(k) !== after.get(k))
  return {
    addedFields: added(oldFields, newFields),
    removedFields: added(newFields, oldFields),
    changedFields: changed(oldFields, newFields),
    addedRules: added(oldRules, newRules),
    removedRules: added(newRules, oldRules),
    changedRules: changed(oldRules, newRules),
    visibilityChanged: stableStringify(current?.visibility ?? []) !== stableStringify(next.visibility),
    linesChanged: stableStringify(current?.lines ?? {}) !== stableStringify(next.lines),
  }
}

/** The stored schema of a form version read back as a form (versions are checked when they are saved). */
export function storedForm(schema: unknown): FormJson | null {
  const parsed = FormSchemaJson.safeParse(schema)
  return parsed.success ? parsed.data : null
}

export const sameForm = (a: FormJson | null, b: FormJson) => a !== null && stableStringify(a) === stableStringify(b)
