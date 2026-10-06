import { z } from 'zod'
import { FORM_TEXTAREA_MAX_LENGTH, FORM_TEXT_MAX_LENGTH } from '../money/constants'
import { MONEY_TEXT } from './money-text'

// Field definitions of a request form (spec §7.9, FormVersion.schema) and the Zod schema the server checks every save
// and submit with (BR-FORM-01). Hidden fields are dropped before this check (evaluateForm), so the schema is built
// for the visible fields only and any other key is refused. Money and numbers stay decimal text (no floating point).

export const FIELD_TYPES = [
  'text',
  'textarea',
  'number',
  'money',
  'date',
  'select',
  'multiselect',
  'checkbox',
  'member',
  'department',
  'costCenter',
  'budgetLine',
  'supplier',
  'deliverySite',
  'lineItems',
  'attachment',
] as const
export type FieldType = (typeof FIELD_TYPES)[number]

/** Screen text of a form in both languages: forms are data the organization imports (FR-ADM-005), not messages */
export interface FormText {
  readonly th: string
  readonly en: string
}

export interface FieldDef {
  /** Key in Request.formData */
  readonly id: string
  readonly type: FieldType
  readonly required?: boolean
  /** Allowed values of select and multiselect */
  readonly options?: readonly string[]
  /** text and textarea; capped at the FORM_*_MAX_LENGTH limits */
  readonly maxLength?: number
  /** The label or question shown with the field */
  readonly label?: FormText
  /** A short hint under the field */
  readonly help?: FormText
  /** The text of each option of a select or multiselect */
  readonly optionLabels?: Readonly<Record<string, FormText>>
}

const FormTextSchema = z.strictObject({ th: z.string().trim().min(1).max(FORM_TEXT_MAX_LENGTH), en: z.string().trim().min(1).max(FORM_TEXT_MAX_LENGTH) })

/** A field definition as stored in FormVersion.schema; checked when a form version is saved. */
export const FieldDefSchema = z
  .strictObject({
    id: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
    type: z.enum(FIELD_TYPES),
    required: z.boolean().optional(),
    options: z.array(z.string().min(1)).min(1).optional(),
    maxLength: z.number().int().positive().optional(),
    label: FormTextSchema.optional(),
    help: FormTextSchema.optional(),
    optionLabels: z.record(z.string(), FormTextSchema).optional(),
  })
  .refine((f) => (f.type === 'select' || f.type === 'multiselect') === (f.options !== undefined), {
    message: 'options are given exactly for select and multiselect',
    path: ['options'],
  })
  .refine((f) => Object.keys(f.optionLabels ?? {}).every((k) => f.options?.includes(k)), { message: 'optionLabels name options of the field', path: ['optionLabels'] })

const DECIMAL_TEXT = /^-?\d{1,14}(\.\d{1,4})?$/
const DATE_TEXT = /^(\d{4})-(\d{2})-(\d{2})$/

function isCalendarDate(text: string): boolean {
  const m = DATE_TEXT.exec(text)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(Date.UTC(y, mo - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d
}

const LineItem = z.strictObject({
  description: z.string().trim().min(1).max(FORM_TEXT_MAX_LENGTH),
  quantity: z.string().regex(DECIMAL_TEXT),
  unitPrice: z.string().regex(MONEY_TEXT),
})

/** The value schema of one field, before required/optional is applied. */
function valueSchema(def: FieldDef): z.ZodType {
  const textMax = (limit: number) => Math.min(def.maxLength ?? limit, limit)
  switch (def.type) {
    case 'text':
      return z.string().trim().max(textMax(FORM_TEXT_MAX_LENGTH))
    case 'textarea':
      return z.string().trim().max(textMax(FORM_TEXTAREA_MAX_LENGTH))
    case 'number':
      return z.string().regex(DECIMAL_TEXT)
    case 'money':
      return z.string().regex(MONEY_TEXT)
    case 'date':
      return z.string().refine(isCalendarDate, 'not a calendar date (YYYY-MM-DD)')
    case 'select':
      return z.enum(def.options as [string, ...string[]])
    case 'multiselect':
      return z.array(z.enum(def.options as [string, ...string[]]))
    case 'checkbox':
      return z.boolean()
    case 'lineItems':
      return z.array(LineItem)
    case 'attachment':
      return z.array(z.uuid())
    // member department costCenter budgetLine supplier deliverySite: the id of a row of this organization; the service
    // checks that it exists and may be used
    default:
      return z.uuid()
  }
}

const isBlank = (value: unknown) => value === undefined || value === null || (typeof value === 'string' && value.trim() === '') || (Array.isArray(value) && value.length === 0)

/**
 * The Zod schema of a form's visible fields (BR-FORM-01). A required field must have a value that is not blank; an
 * optional field may be absent or blank. Keys that are not visible fields are refused, so hidden fields must already
 * have been dropped.
 */
export function formDataSchema(fields: readonly FieldDef[]): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodType> = {}
  for (const def of fields) {
    const value = valueSchema(def)
    shape[def.id] = def.required
      ? z.unknown().refine((v) => !isBlank(v), 'required').pipe(value)
      : z
          .unknown()
          .transform((v) => (isBlank(v) ? undefined : v))
          .pipe(value.optional())
          .optional()
  }
  return z.strictObject(shape) as unknown as z.ZodType<Record<string, unknown>>
}
