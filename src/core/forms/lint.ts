import type { AttachmentRule, Condition, Requirement, VisibilityRule } from './index'
import type { FieldDef } from './fields'

// The lint of a form version (spec §7.17, BR-FORM-09 · FR-INT-104 · S6-14). Pure: the caller gives the version in use,
// the draft and the fields the workflow versions in effect or still to come read for this request type. A field the
// draft removes, or whose type, options or own visibility it changes, while an attachment rule, a visibility condition
// or a workflow rule reads it, is an error — or one admin could switch off reviewers that passed 4-eyes (ADR-102).

export interface LintForm {
  readonly fields: readonly FieldDef[]
  readonly visibility: readonly VisibilityRule[]
  readonly rules: readonly AttachmentRule[]
}

export interface FormLintIssue {
  readonly code: 'FORM_LINT_REFERENCED_FIELD'
  readonly field: string
  /** The attachment rules (their ids), visibility conditions (`visibility:<field>`) and workflow rules (their codes) that read it */
  readonly by: readonly string[]
}

/** The answer fields a condition reads (special variables such as $amountGross are not fields) */
export function conditionFields(c: Condition): string[] {
  if ('all' in c) return c.all.flatMap(conditionFields)
  if ('any' in c) return c.any.flatMap(conditionFields)
  return c.field.startsWith('$') ? [] : [c.field]
}

function requirementFields(r: Requirement): string[] {
  if ('all' in r) return r.all.flatMap(requirementFields)
  if ('any' in r) return r.any.flatMap(requirementFields)
  return 'attachments' in r ? [] : conditionFields(r)
}

const sameList = (a: readonly string[] | undefined, b: readonly string[] | undefined) => (a ?? []).join('\u0000') === (b ?? []).join('\u0000')
const visibilityOf = (form: LintForm, field: string) => JSON.stringify(form.visibility.filter((v) => v.field === field).map((v) => v.when))

export function lintFormVersion(before: LintForm | null, after: LintForm, workflowRules: ReadonlyArray<{ readonly code: string; readonly fields: readonly string[] }>): { errors: FormLintIssue[] } {
  if (!before) return { errors: [] }
  const readers = (field: string) => [
    ...after.rules.filter((r) => conditionFields(r.when).includes(field) || requirementFields(r.require).includes(field)).map((r) => r.id),
    ...after.visibility.filter((v) => v.field !== field && conditionFields(v.when).includes(field)).map((v) => `visibility:${v.field}`),
    ...workflowRules.filter((w) => w.fields.includes(field)).map((w) => w.code),
  ]
  const errors: FormLintIssue[] = []
  for (const old of before.fields) {
    const now = after.fields.find((f) => f.id === old.id)
    const changed = !now || now.type !== old.type || !sameList(now.options, old.options) || visibilityOf(before, old.id) !== visibilityOf(after, old.id)
    if (!changed) continue
    const by = readers(old.id)
    if (by.length) errors.push({ code: 'FORM_LINT_REFERENCED_FIELD', field: old.id, by })
  }
  return { errors }
}
