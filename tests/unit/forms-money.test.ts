import { describe, expect, it } from 'vitest'
import { evaluateForm, type FormInput } from '@/core/forms'
import { formDefinition, moneyFieldIds } from '@/server/forms/schema'
import { parseFormJson } from '@/server/services/request-types/form-import'

// Amounts in a form's conditions are baht text, never JSON numbers (BR-MONEY-01, §7.0 (3), §7.9). An import refuses an
// amount that is not (FR-ADM-005 AC1), and the server marks the comparisons on fields of type money as it reads a form,
// so the screens and the server compare them in satang alike (FR-INT-002 AC1).

const FORM = {
  fields: [
    { id: 'budget', type: 'money' },
    { id: 'qty', type: 'number' },
    { id: 'note', type: 'text' },
  ],
  visibility: [{ field: 'note', when: { field: 'budget', op: 'gt', value: '50000.00' } }],
  rules: [
    { id: 'R1', when: { field: '$amountGross', op: 'gt', value: '100000.00' }, require: { any: [{ attachments: 'QUOTATION', min: 3 }, { field: 'budget', op: 'lte', value: '5000' }] } },
    { id: 'R2', when: { all: [{ field: '$amountNet', op: 'in', value: ['5000.00', '1.5'] }, { field: 'budget', op: 'notEmpty' }] }, require: { attachments: 'JUSTIFICATION', min: 1 } },
    // qty is a number, not money: its value is no amount
    { id: 'R3', when: { field: 'qty', op: 'gt', value: 5 }, require: { attachments: 'PHOTO', min: 1 } },
  ],
  lines: { serviceEndDate: { when: { field: 'budget', op: 'gte', value: '1.00' } } },
}

const input = (fields: Record<string, unknown>, gross = 0n): FormInput => ({ fields, attachments: {}, variables: { $amountGross: gross, $amountNet: gross, $requestType: 'BUY_GOODS' } })

describe('[FR-ADM-005/AC1] an imported form compares money with baht text only', () => {
  it('accepts amounts written as baht text, and conditions on money that take no value', () => {
    expect(parseFormJson(JSON.stringify(FORM))).toMatchObject({ ok: true })
  })

  it('refuses each amount that is a number, other text, missing, not a list for "in" or an empty list, with its place', () => {
    const bad = {
      ...FORM,
      visibility: [{ field: 'note', when: { field: 'budget', op: 'gt', value: 50000 } }],
      rules: [
        { id: 'R1', when: { field: '$amountGross', op: 'gt', value: 100000 }, require: { any: [{ attachments: 'QUOTATION', min: 3 }, { field: 'budget', op: 'lte', value: '5,000.00' }] } },
        { id: 'R2', when: { all: [{ field: '$amountNet', op: 'in', value: ['5000.00', 5000, '1.005'] }, { field: 'budget', op: 'notEmpty' }] }, require: { attachments: 'JUSTIFICATION', min: 1 } },
        { id: 'R3', when: { any: [{ field: '$amountGross', op: 'in', value: '5000.00' }, { field: '$amountNet', op: 'in', value: [] }] }, require: { field: 'budget', op: 'ne', value: '-1.00' } },
      ],
      lines: { serviceEndDate: { when: { field: 'budget', op: 'gte' } } },
    }
    expect(parseFormJson(JSON.stringify(bad))).toEqual({
      ok: false,
      problems: [
        { reason: 'SCHEMA', issue: 'TYPE', path: 'visibility[0].when.value' },
        { reason: 'SCHEMA', issue: 'TYPE', path: 'rules[0].when.value' },
        { reason: 'SCHEMA', issue: 'FORMAT', path: 'rules[0].require.any[1].value' },
        { reason: 'SCHEMA', issue: 'TYPE', path: 'rules[1].when.all[0].value[1]' },
        { reason: 'SCHEMA', issue: 'FORMAT', path: 'rules[1].when.all[0].value[2]' },
        { reason: 'SCHEMA', issue: 'TYPE', path: 'rules[2].when.any[0].value' },
        { reason: 'SCHEMA', issue: 'SIZE', path: 'rules[2].when.any[1].value' },
        { reason: 'SCHEMA', issue: 'FORMAT', path: 'rules[2].require.value' },
        { reason: 'SCHEMA', issue: 'TYPE', path: 'lines.serviceEndDate.when.value' },
      ],
    })
  })

  it('lists amount problems after the other problems of the form', () => {
    const json = JSON.stringify({ fields: [{ id: 'a', type: 'text' }], rules: [{ id: 'R1', when: { field: '$amountGross', op: 'gte', value: 1 }, require: { field: 'missing', op: 'notEmpty' } }] })
    expect(parseFormJson(json)).toEqual({
      ok: false,
      problems: [
        { reason: 'UNKNOWN_FIELD', field: 'missing', path: 'rules[0].require.field' },
        { reason: 'SCHEMA', issue: 'TYPE', path: 'rules[0].when.value' },
      ],
    })
  })

  it('takes no mark of money from the JSON: the server sets it from the field types', () => {
    const marked = { ...FORM, visibility: [{ field: 'note', when: { field: 'budget', op: 'gt', value: '1.00', money: true } }] }
    expect(parseFormJson(JSON.stringify(marked))).toMatchObject({ ok: false, problems: [{ reason: 'SCHEMA', path: 'visibility[0].when' }] })
  })
})

describe('[FR-INT-002/AC1] a stored form is read with its money fields marked, so the screens and the server compare alike', () => {
  it('marks every comparison on a field of type money and nothing else', () => {
    const form = formDefinition(FORM)
    expect(moneyFieldIds(form.fields)).toEqual(new Set(['budget']))
    expect(form.fields).toEqual(FORM.fields)
    expect(form.visibility).toEqual([{ field: 'note', when: { field: 'budget', op: 'gt', value: '50000.00', money: true } }])
    expect(form.rules.map((r) => [r.when, r.require])).toEqual([
      [
        { field: '$amountGross', op: 'gt', value: '100000.00' },
        { any: [{ attachments: 'QUOTATION', min: 3 }, { field: 'budget', op: 'lte', value: '5000', money: true }] },
      ],
      [
        { all: [{ field: '$amountNet', op: 'in', value: ['5000.00', '1.5'] }, { field: 'budget', op: 'notEmpty', money: true }] },
        { attachments: 'JUSTIFICATION', min: 1 },
      ],
      [{ field: 'qty', op: 'gt', value: 5 }, { attachments: 'PHOTO', min: 1 }],
    ])
    expect(form.lines).toEqual({ serviceEndDate: { when: { field: 'budget', op: 'gte', value: '1.00', money: true } } })
    // A form without fields of type money is read as stored
    const plain = { fields: [{ id: 'note', type: 'text' }], visibility: [], rules: [], lines: { serviceEndDate: { when: { field: 'note', op: 'notEmpty' } } } }
    expect(formDefinition(plain)).toEqual(plain)
    expect(formDefinition({ fields: [{ id: 'budget', type: 'money' }] })).toEqual({ fields: [{ id: 'budget', type: 'money' }], visibility: [], rules: [], lines: {} })
  })

  it('compares the marked field in satang: "5000" in the rule is the answer "5000.00", and a number answer matches nothing', () => {
    const form = formDefinition(FORM)
    // R1 applies above 100,000.00; its second option holds when the budget is at most 5,000.00
    expect(evaluateForm(form, input({ budget: '5000.00' }, 10_000_001n))).toMatchObject({ ok: true })
    expect(evaluateForm(form, input({ budget: '5000.01' }, 10_000_001n))).toMatchObject({ ok: false, rule: 'R1' })
    expect(evaluateForm(form, input({ budget: 5000 }, 10_000_001n))).toMatchObject({ ok: false, rule: 'R1' })
    // The note shows above 50,000.00 of budget only, and is dropped otherwise (BR-FORM-01)
    expect(evaluateForm(form, input({ budget: '50000.01', note: 'x' }))).toMatchObject({ ok: true, droppedFields: [] })
    expect(evaluateForm(form, input({ budget: '50000', note: 'x' }))).toMatchObject({ ok: true, droppedFields: ['note'] })
    expect(evaluateForm(form, input({ budget: 60000, note: 'x' }))).toMatchObject({ ok: true, droppedFields: ['note'] })
  })

  it('reads a version stored with a number as an amount, and its rule never applies', () => {
    // Versions are checked when they are imported; one stored before the amount check stays readable
    const stored = { fields: [], rules: [{ id: 'ATT-QUOTES', when: { field: '$amountGross', op: 'gt', value: 100000 }, require: { attachments: 'QUOTATION', min: 3 } }] }
    const form = formDefinition(stored)
    expect(evaluateForm(form, input({}, 15_000_000n))).toMatchObject({ ok: true })
    expect(parseFormJson(JSON.stringify(stored))).toEqual({ ok: false, problems: [{ reason: 'SCHEMA', issue: 'TYPE', path: 'rules[0].when.value' }] })
  })
})
