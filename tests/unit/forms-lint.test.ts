import { describe, expect, it } from 'vitest'
import { conditionFields, lintFormVersion, type LintForm } from '@/core/forms'

// BR-FORM-09 beyond GC-FORM-22: a change of type, options or own visibility counts as much as removing the field;
// visibility conditions and requirement comparisons read fields too; a field nothing reads changes freely; a first
// version has nothing to compare with.

const pd = { id: 'pd', type: 'select' as const, options: ['Y', 'N'] }
const note = { id: 'note', type: 'text' as const }
const base: LintForm = {
  fields: [pd, note],
  visibility: [{ field: 'note', when: { field: 'pd', op: 'eq', value: 'Y' } }],
  rules: [{ id: 'ATT-X', when: { field: '$amountGross', op: 'gt', value: '100.00' }, require: { any: [{ attachments: 'DPA', min: 1 }, { field: 'note', op: 'notEmpty' }] } }],
}

describe('[FR-INT-104/AC2] the lint of a form version', () => {
  it('a first version and a draft that changes nothing read pass', () => {
    expect(lintFormVersion(null, base, [])).toEqual({ errors: [] })
    expect(lintFormVersion(base, { ...base, fields: [pd, { ...note, label: { th: 'หมายเหตุ', en: 'Note' } }] }, [])).toEqual({ errors: [] })
  })

  it('another type or other options of a field a visibility condition reads is an error', () => {
    expect(lintFormVersion(base, { ...base, fields: [{ ...pd, options: ['Y', 'N', 'X'] }, note] }, []).errors).toEqual([{ code: 'FORM_LINT_REFERENCED_FIELD', field: 'pd', by: ['visibility:note'] }])
    expect(lintFormVersion(base, { ...base, fields: [{ id: 'pd', type: 'text' as const }, note] }, [{ code: 'RV-1', fields: ['pd'] }]).errors[0]!.by).toEqual(['visibility:note', 'RV-1'])
  })

  it('another visibility of a field a requirement reads is an error; the special variables are no fields', () => {
    const shown = { ...base, visibility: [{ field: 'note', when: { all: [{ field: 'pd', op: 'eq' as const, value: 'N' }] } }] }
    expect(lintFormVersion(base, shown, []).errors).toEqual([{ code: 'FORM_LINT_REFERENCED_FIELD', field: 'note', by: ['ATT-X'] }])
    expect(conditionFields({ any: [{ field: '$amountNet', op: 'gt', value: '1' }, { field: 'a', op: 'empty' }] })).toEqual(['a'])
  })
})
