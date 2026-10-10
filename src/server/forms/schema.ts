import { z } from 'zod'
import { markMoneyFields, type AttachmentRule, type Condition, type VisibilityRule } from '@/core/forms'
import { FieldDefSchema, type FieldDef } from '@/core/forms/fields'
import { FORM_TEXT_MAX_LENGTH } from '@/core/money/constants'

// FormVersion.schema as stored (spec §7.9): the field definitions, the conditions that show or hide fields and the
// attachment rules. Conditions are checked structurally here; core/forms evaluates them. A condition's value is left
// open so every stored version stays readable: an import checks that the amounts money is compared with are baht text
// (src/server/services/request-types/form-import.ts), and core/forms never matches an amount that is not (BR-MONEY-01).

const ConditionJson: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.strictObject({ all: z.array(ConditionJson) }),
    z.strictObject({ any: z.array(ConditionJson) }),
    z.strictObject({ field: z.string().min(1), op: z.enum(['eq', 'ne', 'in', 'gt', 'gte', 'lt', 'lte', 'empty', 'notEmpty']), value: z.unknown().optional() }),
  ]),
) as z.ZodType<Condition>

const RequirementJson: z.ZodType<AttachmentRule['require']> = z.lazy(() =>
  z.union([
    z.strictObject({ attachments: z.string().min(1), min: z.number().int().positive() }),
    z.strictObject({ all: z.array(RequirementJson) }),
    z.strictObject({ any: z.array(RequirementJson) }),
    z.strictObject({ field: z.string().min(1), op: z.enum(['eq', 'ne', 'in', 'gt', 'gte', 'lt', 'lte', 'empty', 'notEmpty']), value: z.unknown().optional() }),
  ]),
) as z.ZodType<AttachmentRule['require']>

/**
 * The keys of the screen's automatic steps (AUTO_STEPS in src/ui/request-form/form-steps.ts, kept equal by
 * tests/unit/request-form-steps.test.tsx): the screen finds a step by its key, so a form's own step may not take one.
 */
export const RESERVED_STEP_KEYS: readonly string[] = ['details', 'items', 'supplier', 'questions', 'documents', 'review']

/** One step of a form: its key, its title in both languages, the ids of its fields, and whether it may be skipped */
const FormStepJson = z.strictObject({
  key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
  titleTh: z.string().trim().min(1).max(FORM_TEXT_MAX_LENGTH),
  titleEn: z.string().trim().min(1).max(FORM_TEXT_MAX_LENGTH),
  fields: z.array(z.string().min(1)),
  optional: z.boolean().default(false),
})

export const FormSchemaJson = z.strictObject({
  fields: z.array(FieldDefSchema),
  visibility: z.array(z.strictObject({ field: z.string().min(1), when: ConditionJson })).default([]),
  rules: z.array(z.strictObject({ id: z.string().min(1), when: ConditionJson, require: RequirementJson })).default([]),
  /** What the lines carry besides the item: serviceEndDate is required when its condition holds (BR-FORM-05) */
  lines: z.strictObject({ serviceEndDate: z.strictObject({ when: ConditionJson }).optional() }).default({}),
  /**
   * The steps the form is filled in by, in order (FR-INT-011 AC2, §9.10): optional; without it the screen groups the
   * fields itself. Steps change no rule: the server checks the whole form on every save and submit (BR-FORM-01). An
   * import checks that each field is a field of the form and is in one step at most (form-import.ts).
   */
  steps: z.array(FormStepJson).optional(),
})

export interface FormDefinition {
  readonly fields: readonly FieldDef[]
  readonly visibility: readonly VisibilityRule[]
  readonly rules: readonly AttachmentRule[]
  readonly lines: { readonly serviceEndDate?: { readonly when: Condition } }
  readonly steps?: readonly FormStep[]
}

export interface FormStep {
  readonly key: string
  readonly titleTh: string
  readonly titleEn: string
  readonly fields: readonly string[]
  readonly optional: boolean
}

/** Ids of the form's fields of type money */
export function moneyFieldIds(fields: readonly Pick<FieldDef, 'id' | 'type'>[]): ReadonlySet<string> {
  return new Set(fields.filter((f) => f.type === 'money').map((f) => f.id))
}

/**
 * A stored form, ready to evaluate. Comparisons on fields of type money come marked (core/forms markMoneyFields), so
 * core/forms compares them as money, in satang and never with a number, on the server and on the screens the form is
 * sent to alike. The mark is not part of the stored JSON: only what this returns carries it.
 */
export function formDefinition(schema: unknown): FormDefinition {
  const form = FormSchemaJson.parse(schema) as FormDefinition
  const money = moneyFieldIds(form.fields)
  if (money.size === 0) return form
  const endDate = form.lines.serviceEndDate
  return {
    fields: form.fields,
    visibility: form.visibility.map((v) => ({ ...v, when: markMoneyFields(v.when, money) })),
    rules: form.rules.map((r) => ({ ...r, when: markMoneyFields(r.when, money), require: markMoneyFields(r.require, money) })),
    lines: endDate ? { ...form.lines, serviceEndDate: { ...endDate, when: markMoneyFields(endDate.when, money) } } : form.lines,
    ...(form.steps ? { steps: form.steps } : {}),
  }
}
