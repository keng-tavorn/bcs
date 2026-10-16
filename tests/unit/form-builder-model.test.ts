import { describe, expect, it } from 'vitest'
import type { FieldDef } from '@/core/forms/fields'
import { parseFormJson, ATTACHMENT_KINDS as SERVICE_KINDS } from '@/server/services/request-types/form-import'
import {
  ATTACHMENT_KINDS,
  addField,
  addRule,
  checkFieldDraft,
  checkRows,
  checkRuleDraft,
  conditionOf,
  emptyFieldDraft,
  emptyRuleDraft,
  fieldDraftOf,
  formJson,
  moveField,
  moveItem,
  moveRule,
  removeField,
  removeRule,
  replaceField,
  requirementRowsOf,
  rowsOf,
  ruleDraftOf,
  sameBuilderForm,
  setVisibility,
  visibilityOf,
  type BuilderForm,
} from '@/ui/admin-settings/form-builder-model'

// The no-code form builder's model (S6-14 · FR-INT-104 AC1): questions added, edited, removed and moved with buttons,
// the condition that shows a question, attachment rules, and the JSON a save sends — which the service's form schema
// reads back as the same form.

const category: FieldDef = {
  id: 'category',
  type: 'select',
  required: true,
  options: ['HARDWARE', 'SOFTWARE'],
  label: { th: 'หมวด', en: 'Category' },
  optionLabels: { HARDWARE: { th: 'ฮาร์ดแวร์', en: 'Hardware' }, SOFTWARE: { th: 'ซอฟต์แวร์', en: 'Software' } },
}
const assetTag: FieldDef = { id: 'assetTag', type: 'text', maxLength: 40, label: { th: 'เลขทะเบียนทรัพย์สิน', en: 'Asset tag' } }
const reason: FieldDef = { id: 'reason', type: 'textarea', label: { th: 'เหตุผล', en: 'Reason' } }

const form: BuilderForm = {
  fields: [category, assetTag, reason],
  visibility: [{ field: 'assetTag', when: { field: 'category', op: 'eq', value: 'HARDWARE' } }],
  rules: [
    {
      id: 'ATT-QUOTES',
      when: { field: '$amountGross', op: 'gt', value: '100000.00' },
      require: { any: [{ attachments: 'QUOTATION', min: 3 }, { all: [{ attachments: 'QUOTATION', min: 1 }, { field: 'reason', op: 'notEmpty' }] }] },
    },
    { id: 'ATT-DPA', when: { field: 'category', op: 'eq', value: 'SOFTWARE' }, require: { attachments: 'DPA', min: 1 } },
  ],
  lines: {},
  steps: [{ key: 'about', titleTh: 'เกี่ยวกับ', titleEn: 'About', fields: ['category', 'assetTag'], optional: false }],
}

const ids = (f: BuilderForm) => f.fields.map((d) => d.id)

describe('[FR-INT-104/AC1] the form builder edits the fields of a draft', () => {
  it('adds a question at the end and removes one with its own visibility and its place in a step', () => {
    const added = addField(form, { id: 'siteContact', type: 'text', label: { th: 'ผู้ติดต่อ', en: 'Contact' } })
    expect(ids(added)).toEqual(['category', 'assetTag', 'reason', 'siteContact'])
    const removed = removeField(form, 'assetTag')
    expect(ids(removed)).toEqual(['category', 'reason'])
    expect(removed.visibility).toEqual([])
    expect(removed.steps![0]!.fields).toEqual(['category'])
    // The rules that read a removed field stay: the service's lint names them (BR-FORM-09)
    expect(removed.rules).toBe(form.rules)
  })

  it('moves a question up and down with buttons, and stays put at either end', () => {
    expect(ids(moveField(form, 'reason', 'UP'))).toEqual(['category', 'reason', 'assetTag'])
    expect(ids(moveField(form, 'category', 'DOWN'))).toEqual(['assetTag', 'category', 'reason'])
    expect(ids(moveField(form, 'category', 'UP'))).toEqual(ids(form))
    expect(ids(moveField(form, 'reason', 'DOWN'))).toEqual(ids(form))
    expect(moveItem(['a', 'b'], 5, 'UP')).toEqual(['a', 'b'])
  })

  it('edits a question in place; a new id carries its visibility and step with it', () => {
    const renamed = replaceField(form, 'assetTag', { ...assetTag, id: 'assetNo' })
    expect(ids(renamed)).toEqual(['category', 'assetNo', 'reason'])
    expect(renamed.visibility[0]!.field).toBe('assetNo')
    expect(renamed.steps![0]!.fields).toEqual(['category', 'assetNo'])
  })

  it('a question opened and saved without a change is the same field it was', () => {
    for (const def of [category, assetTag, reason, { id: 'ok', type: 'checkbox', required: false } satisfies FieldDef]) {
      const checked = checkFieldDraft(fieldDraftOf(def), [], def)
      expect(checked).toEqual({ ok: true, def })
    }
  })

  it('a new question needs an id of the schema not taken, words in both languages, and options for a choice', () => {
    expect(checkFieldDraft(emptyFieldDraft(), [], null)).toEqual({ ok: false, errors: { id: 'ID_REQUIRED', label: 'LABEL_REQUIRED' } })
    expect(checkFieldDraft({ ...emptyFieldDraft(), id: '1x', labelTh: 'ก', labelEn: 'A' }, [], null)).toEqual({ ok: false, errors: { id: 'ID_FORMAT' } })
    expect(checkFieldDraft({ ...emptyFieldDraft(), id: 'reason', labelTh: 'ก', labelEn: '' }, ['reason'], null)).toEqual({ ok: false, errors: { id: 'ID_TAKEN', label: 'LABEL_REQUIRED' } })
    expect(checkFieldDraft({ ...emptyFieldDraft(), id: 'pick', type: 'select', labelTh: 'ก', labelEn: 'A', helpTh: 'x' }, [], null)).toEqual({ ok: false, errors: { help: 'HELP_BOTH', options: 'OPTIONS_REQUIRED' } })
    const options = [
      { value: 'Y', th: 'ใช่', en: 'Yes' },
      { value: 'Y', th: '', en: '' },
    ]
    expect(checkFieldDraft({ ...emptyFieldDraft(), id: 'pick', type: 'select', labelTh: 'ก', labelEn: 'A', options }, [], null)).toEqual({ ok: false, errors: { options: 'OPTION_DUPLICATE' } })
    const made = checkFieldDraft({ ...emptyFieldDraft(), id: ' pick ', type: 'select', required: true, labelTh: ' เลือก ', labelEn: 'Pick', options: [options[0]!, { value: 'N', th: '', en: '' }] }, [], null)
    expect(made).toEqual({ ok: true, def: { id: 'pick', type: 'select', required: true, options: ['Y', 'N'], label: { th: 'เลือก', en: 'Pick' }, optionLabels: { Y: { th: 'ใช่', en: 'Yes' } } } })
  })

  it('a type changed away from a choice drops its options; maxLength stays on text only', () => {
    const asText = checkFieldDraft({ ...fieldDraftOf(category), type: 'text' }, [], category)
    expect(asText.ok && asText.def).toEqual({ id: 'category', type: 'text', required: true, label: category.label })
    const asNumber = checkFieldDraft({ ...fieldDraftOf(assetTag), type: 'number' }, [], assetTag)
    expect(asNumber.ok && asNumber.def).toEqual({ id: 'assetTag', type: 'number', label: assetTag.label })
  })
})

describe('[FR-INT-104/AC1] the form builder edits conditions and attachment rules', () => {
  it('reads a condition as rows joined by all, or keeps one with any or nested groups', () => {
    expect(rowsOf({ field: 'category', op: 'eq', value: 'HARDWARE' })).toEqual([{ field: 'category', op: 'eq', value: 'HARDWARE' }])
    expect(rowsOf({ all: [] })).toEqual([])
    expect(rowsOf({ all: [{ field: 'category', op: 'in', value: ['HARDWARE', 'SOFTWARE'] }, { field: 'reason', op: 'notEmpty' }] })).toEqual([
      { field: 'category', op: 'in', value: 'HARDWARE, SOFTWARE' },
      { field: 'reason', op: 'notEmpty', value: '' },
    ])
    expect(rowsOf({ any: [{ field: 'reason', op: 'empty' }] })).toBeNull()
    expect(rowsOf({ all: [{ any: [] }] })).toBeNull()
  })

  it('writes rows as comparisons: money as baht text, lists split at commas, wrong rows named', () => {
    const fields = form.fields
    const rows = checkRows(
      [
        { field: '$amountGross', op: 'gte', value: '100,000' },
        { field: 'category', op: 'in', value: 'HARDWARE, SOFTWARE,' },
        { field: 'reason', op: 'empty', value: 'ignored' },
      ],
      fields,
    )
    expect(rows).toEqual({
      ok: true,
      comparisons: [
        { field: '$amountGross', op: 'gte', value: '100000.00' },
        { field: 'category', op: 'in', value: ['HARDWARE', 'SOFTWARE'] },
        { field: 'reason', op: 'empty' },
      ],
    })
    expect(checkRows([{ field: '', op: '', value: '' }, { field: 'category', op: 'gt', value: '1' }, { field: '$amountNet', op: 'gt', value: '1.234' }, { field: 'reason', op: 'eq', value: ' ' }], fields)).toEqual({
      ok: false,
      errors: { 0: 'FIELD', 1: 'OP', 2: 'MONEY', 3: 'VALUE' },
    })
    expect(conditionOf([])).toEqual({ all: [] })
    expect(conditionOf([{ field: 'reason', op: 'notEmpty' }])).toEqual({ field: 'reason', op: 'notEmpty' })
  })

  it('sets, replaces and clears the condition that shows a question', () => {
    const shown = setVisibility(form, 'reason', { field: 'category', op: 'eq', value: 'SOFTWARE' })
    expect(visibilityOf(shown, 'reason')).toEqual({ field: 'category', op: 'eq', value: 'SOFTWARE' })
    const replaced = setVisibility(shown, 'assetTag', { field: 'category', op: 'ne', value: 'SOFTWARE' })
    expect(replaced.visibility.map((v) => v.field)).toEqual(['assetTag', 'reason'])
    expect(visibilityOf(setVisibility(replaced, 'assetTag', null), 'assetTag')).toBeNull()
  })

  it('adds, edits, moves and removes attachment rules; an either-or requirement is kept as stored', () => {
    expect(requirementRowsOf(form.rules[0]!.require)).toBeNull()
    expect(requirementRowsOf(form.rules[1]!.require)).toEqual([{ kind: 'DPA', min: '1' }])
    // Opened and saved unchanged: the same rule
    for (const rule of form.rules) expect(checkRuleDraft(ruleDraftOf(rule), [], form.fields)).toEqual({ ok: true, rule })
    const draft = { ...emptyRuleDraft(), id: 'ATT-PHOTO', require: [{ kind: 'PHOTO', min: '2' }, { kind: 'OTHER', min: '1' }] }
    const made = checkRuleDraft(draft, ['ATT-DPA'], form.fields)
    expect(made).toEqual({ ok: true, rule: { id: 'ATT-PHOTO', when: { all: [] }, require: { all: [{ attachments: 'PHOTO', min: 2 }, { attachments: 'OTHER', min: 1 }] } } })
    expect(checkRuleDraft({ ...draft, id: 'ATT-DPA', require: [{ kind: '', min: '0' }] }, ['ATT-DPA'], form.fields)).toEqual({ ok: false, errors: { id: 'ID_TAKEN', require: { 0: 'KIND' } } })
    expect(checkRuleDraft({ ...draft, id: 'A B', require: [] }, [], form.fields)).toEqual({ ok: false, errors: { id: 'ID_FORMAT', requireEmpty: true } })
    const withRule = made.ok ? addRule(form, made.rule) : form
    expect(moveRule(withRule, 'ATT-PHOTO', 'UP').rules.map((r) => r.id)).toEqual(['ATT-QUOTES', 'ATT-PHOTO', 'ATT-DPA'])
    expect(removeRule(withRule, 'ATT-QUOTES').rules.map((r) => r.id)).toEqual(['ATT-DPA', 'ATT-PHOTO'])
  })

  it('asks only for the kinds of file the service accepts', () => {
    expect([...ATTACHMENT_KINDS]).toEqual([...SERVICE_KINDS])
  })
})

describe('[FR-INT-104/AC1] the JSON a save sends', () => {
  it('is the whole form, which the service schema reads back as the same form', () => {
    const edited = setVisibility(addField(moveField(form, 'reason', 'UP'), { id: 'siteContact', type: 'text', label: { th: 'ผู้ติดต่อ', en: 'Contact' } }), 'siteContact', { field: 'category', op: 'eq', value: 'HARDWARE' })
    const parsed = parseFormJson(formJson(edited))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(sameBuilderForm(parsed.form, edited)).toBe(true)
  })

  it('compares forms whatever the order of their keys', () => {
    const reordered: BuilderForm = { lines: {}, rules: form.rules, visibility: form.visibility, fields: form.fields, steps: form.steps }
    expect(sameBuilderForm(reordered, form)).toBe(true)
    expect(sameBuilderForm(moveField(form, 'reason', 'UP'), form)).toBe(false)
  })
})
