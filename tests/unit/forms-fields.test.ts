import { describe, expect, it } from 'vitest'
import { evaluateForm, type FormInput } from '@/core/forms'
import { FieldDefSchema, formDataSchema, type FieldDef } from '@/core/forms/fields'

// BR-FORM-01: the server checks every save with a Zod schema built from the form version; hidden fields are dropped
// first and never checked.

const FIELDS: FieldDef[] = [
  { id: 'title', type: 'text', required: true, maxLength: 20 },
  { id: 'note', type: 'textarea' },
  { id: 'qty', type: 'number', required: true },
  { id: 'budget', type: 'money' },
  { id: 'neededBy', type: 'date' },
  { id: 'category', type: 'select', required: true, options: ['HARDWARE', 'SOFTWARE'] },
  { id: 'tags', type: 'multiselect', options: ['A', 'B'] },
  { id: 'urgent', type: 'checkbox' },
  { id: 'supplier', type: 'supplier' },
  { id: 'lines', type: 'lineItems' },
  { id: 'files', type: 'attachment', required: true },
  { id: 'assetTag', type: 'text' },
]
const fileId = '01994f2e-0000-7000-8000-000000000001'
const good = { title: 'โน้ตบุ๊ก', qty: '2', category: 'HARDWARE', files: [fileId] }

describe('[FR-INT-002/AC1] the server checks form data with a schema built from the form version', () => {
  const schema = formDataSchema(FIELDS)

  it('accepts a complete form, and blank optional fields', () => {
    expect(schema.safeParse(good).success).toBe(true)
    expect(schema.safeParse({ ...good, note: '', budget: '', tags: [], neededBy: '2026-10-31', urgent: true }).success).toBe(true)
    expect(schema.safeParse({ ...good, budget: '1500.50', lines: [{ description: 'จอ', quantity: '1.5', unitPrice: '3000' }], supplier: fileId }).success).toBe(true)
  })

  it.each([
    ['a required field is missing', { ...good, title: undefined }, 'title'],
    ['a required field is blank', { ...good, title: '   ' }, 'title'],
    ['text is longer than its limit', { ...good, title: 'x'.repeat(21) }, 'title'],
    ['a number is not decimal text', { ...good, qty: '1e3' }, 'qty'],
    ['money has three decimals', { ...good, budget: '10.001' }, 'budget'],
    ['money is negative', { ...good, budget: '-5' }, 'budget'],
    ['a date does not exist', { ...good, neededBy: '2026-02-30' }, 'neededBy'],
    ['a select value is not an option', { ...good, category: 'FOOD' }, 'category'],
    ['a multiselect value is not an option', { ...good, tags: ['C'] }, 'tags'],
    ['a checkbox is not a boolean', { ...good, urgent: 'yes' }, 'urgent'],
    ['a reference is not an id', { ...good, supplier: 'ACME' }, 'supplier'],
    ['a line has no description', { ...good, lines: [{ description: '', quantity: '1', unitPrice: '1' }] }, 'lines'],
    ['a required attachment list is empty', { ...good, files: [] }, 'files'],
    ['an unknown key is sent', { ...good, approvedBy: 'me' }, ''],
  ])('refuses the form when %s', (_label, data, field) => {
    const r = schema.safeParse(data)
    expect(r.success).toBe(false)
    if (!r.success && field) expect(r.error.issues.map((i) => i.path[0])).toContain(field)
  })

  it('a field hidden by its condition is dropped before the check, so its value is never validated', () => {
    const form = { visibility: [{ field: 'assetTag', when: { field: 'category', op: 'eq' as const, value: 'HARDWARE' } }], rules: [] }
    const input: FormInput = { fields: { ...good, category: 'SOFTWARE', assetTag: 'X'.repeat(5000) }, attachments: {}, variables: { $amountGross: 0n, $amountNet: 0n, $requestType: 'BUY_GOODS' } }
    const evaluated = evaluateForm(form, input)
    expect(evaluated).toMatchObject({ ok: true, droppedFields: ['assetTag'] })
    if (!evaluated.ok) return
    const visible = FIELDS.filter((f) => !evaluated.droppedFields.includes(f.id))
    expect(formDataSchema(visible).safeParse(evaluated.fields).success).toBe(true)
  })

  it('checks stored field definitions: options exactly for select and multiselect, ids usable as keys', () => {
    expect(FieldDefSchema.safeParse({ id: 'category', type: 'select', options: ['A'] }).success).toBe(true)
    expect(FieldDefSchema.safeParse({ id: 'category', type: 'select' }).success).toBe(false)
    expect(FieldDefSchema.safeParse({ id: 'note', type: 'text', options: ['A'] }).success).toBe(false)
    expect(FieldDefSchema.safeParse({ id: '1bad', type: 'text' }).success).toBe(false)
    expect(FieldDefSchema.safeParse({ id: 'x', type: 'colour' }).success).toBe(false)
  })
})
