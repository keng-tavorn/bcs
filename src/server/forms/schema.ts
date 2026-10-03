import { z } from 'zod'
import type { AttachmentRule, Condition, VisibilityRule } from '@/core/forms'
import { FieldDefSchema, type FieldDef } from '@/core/forms/fields'

// FormVersion.schema as stored (spec §7.9): the field definitions, the conditions that show or hide fields and the
// attachment rules. Conditions are checked structurally here; core/forms evaluates them.

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

export const FormSchemaJson = z.strictObject({
  fields: z.array(FieldDefSchema),
  visibility: z.array(z.strictObject({ field: z.string().min(1), when: ConditionJson })).default([]),
  rules: z.array(z.strictObject({ id: z.string().min(1), when: ConditionJson, require: RequirementJson })).default([]),
  /** What the lines carry besides the item: serviceEndDate is required when its condition holds (BR-FORM-05) */
  lines: z.strictObject({ serviceEndDate: z.strictObject({ when: ConditionJson }).optional() }).default({}),
})

export interface FormDefinition {
  readonly fields: readonly FieldDef[]
  readonly visibility: readonly VisibilityRule[]
  readonly rules: readonly AttachmentRule[]
  readonly lines: { readonly serviceEndDate?: { readonly when: Condition } }
}

export function formDefinition(schema: unknown): FormDefinition {
  return FormSchemaJson.parse(schema) as FormDefinition
}
