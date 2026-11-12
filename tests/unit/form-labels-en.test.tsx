import { NextIntlClientProvider } from 'next-intl'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AttachmentRule } from '@/core/forms'
import type { FieldDef } from '@/core/forms/fields'
import { formDefinition, FormSchemaJson } from '@/server/forms/schema'
import { loadSeedForms } from '@/server/seed/forms'
import { formChanges, parseFormJson } from '@/server/services/request-types/form-import'
import { checkRuleDraft, emptyRuleDraft, formJson, ruleDraftOf, type BuilderForm } from '@/ui/admin-settings/form-builder-model'
import { FormPreview } from '@/ui/admin-settings/form-builder-preview'
import { FieldInput } from '@/ui/request-form/field-input'
import { applicableRules } from '@/ui/request-form/model'
import { ruleLabel } from '@/ui/request-form/rule-text'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// FR-INT-201 AC1 (BR-FORM-10): a form's English words use the FormText it already has — label.en, help.en and
// optionLabels[option].en — and an attachment rule may carry a name in both languages (label, optional). Forms stored
// before stay valid, nothing is translated for the admin, the builder edits both languages and previews either, and a
// member whose locale is en sees the English words on the request form.

const render = (node: ReactNode, locale: 'th' | 'en') =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === 'th' ? th : en} timeZone="Asia/Bangkok">
      {node}
    </NextIntlClientProvider>,
  )

const category: FieldDef = {
  id: 'category',
  type: 'select',
  required: true,
  options: ['HARDWARE', 'SOFTWARE'],
  label: { th: 'หมวด', en: 'Category' },
  help: { th: 'เลือกหมวดของที่ซื้อ', en: 'Choose what you are buying' },
  optionLabels: { HARDWARE: { th: 'ฮาร์ดแวร์', en: 'Hardware' }, SOFTWARE: { th: 'ซอฟต์แวร์', en: 'Software' } },
}
const dpa: AttachmentRule = {
  id: 'ATT-DPA',
  when: { field: 'category', op: 'eq', value: 'SOFTWARE' },
  require: { attachments: 'DPA', min: 1 },
  label: { th: 'ข้อตกลงประมวลผลข้อมูล', en: 'Data processing agreement' },
}
const form: BuilderForm = { fields: [category], visibility: [], rules: [dpa], lines: {} }

describe('[FR-INT-201/AC1] a form stores its English words in the FormText it has, and a rule may be named', () => {
  it('every form of the seed still parses with the strict schema', () => {
    const forms = loadSeedForms()
    expect(forms.size).toBeGreaterThan(0)
    for (const [, seeded] of forms) expect(FormSchemaJson.safeParse(seeded).success).toBe(true)
  })

  it('a rule with a name in both languages parses and keeps it; one without parses as before', () => {
    const parsed = FormSchemaJson.parse({ fields: [category], rules: [dpa, { id: 'ATT-X', when: { all: [] }, require: { attachments: 'OTHER', min: 1 } }] })
    expect(parsed.rules[0]!.label).toEqual(dpa.label)
    expect(parsed.rules[1]).not.toHaveProperty('label')
    expect(formDefinition(parsed).rules[0]!.label).toEqual(dpa.label)
  })

  it.each([
    ['without English', { th: 'ข้อตกลง' }],
    ['with English blank', { th: 'ข้อตกลง', en: '  ' }],
    ['with a key of its own', { th: 'ข้อตกลง', en: 'Agreement', fr: 'Accord' }],
  ])('a rule named %s is refused (nothing is translated)', (_, label) => {
    expect(FormSchemaJson.safeParse({ fields: [category], rules: [{ ...dpa, label }] }).success).toBe(false)
  })

  it('a field keeps the keys it had: English is label.en, help.en and optionLabels[option].en', () => {
    expect(FormSchemaJson.safeParse({ fields: [{ ...category, labelEn: 'Category' }] }).success).toBe(false)
  })

  it('the name survives the JSON a builder save sends, and renaming a rule shows as a changed rule', () => {
    const parsed = parseFormJson(formJson(form))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.form.rules[0]!.label).toEqual(dpa.label)
    const renamed = { ...parsed.form, rules: [{ ...parsed.form.rules[0]!, label: { th: 'DPA', en: 'DPA' } }] }
    expect(formChanges(parsed.form, renamed).changedRules).toEqual(['ATT-DPA'])
  })
})

describe('[FR-INT-201/AC1] the form builder edits a rule name in Thai and English', () => {
  it('a rule opened with a name saves it back unchanged; a new rule takes both languages', () => {
    expect(ruleDraftOf(dpa)).toMatchObject({ labelTh: dpa.label!.th, labelEn: dpa.label!.en })
    expect(checkRuleDraft(ruleDraftOf(dpa), [], form.fields)).toEqual({ ok: true, rule: dpa })
    const draft = { ...emptyRuleDraft(), id: 'ATT-PHOTO', require: [{ kind: 'PHOTO', min: '1' }], labelTh: ' รูปถ่ายหน้างาน ', labelEn: 'Site photos' }
    expect(checkRuleDraft(draft, [], form.fields)).toEqual({ ok: true, rule: { id: 'ATT-PHOTO', when: { all: [] }, require: { attachments: 'PHOTO', min: 1 }, label: { th: 'รูปถ่ายหน้างาน', en: 'Site photos' } } })
  })

  it('no name is no label; a name in one language only is an error', () => {
    const draft = { ...emptyRuleDraft(), id: 'ATT-PHOTO', require: [{ kind: 'PHOTO', min: '1' }] }
    const none = checkRuleDraft(draft, [], form.fields)
    expect(none.ok && none.rule).not.toHaveProperty('label')
    expect(checkRuleDraft({ ...draft, labelTh: 'รูปถ่าย' }, [], form.fields)).toEqual({ ok: false, errors: { label: 'LABEL_BOTH' } })
    expect(checkRuleDraft({ ...draft, labelEn: 'Photos', labelTh: '   ' }, [], form.fields)).toEqual({ ok: false, errors: { label: 'LABEL_BOTH' } })
  })

  it('the preview shows the form in the language chosen, from the screen language at first', () => {
    const english = render(<FormPreview form={form} requestTypeCode="IT_SOFTWARE" />, 'en')
    expect(english).toContain('Category')
    expect(english).toContain('Choose what you are buying')
    expect(english).toContain('Preview in')
    expect(english).not.toContain('หมวด')
    const thai = render(<FormPreview form={form} requestTypeCode="IT_SOFTWARE" />, 'th')
    expect(thai).toContain('หมวด')
    expect(thai).toContain('ดูตัวอย่างเป็นภาษา')
  })
})

describe('[FR-INT-201/AC1] a member whose locale is en sees the English words of the form', () => {
  const noop = () => undefined

  it('a question shows label.en, help.en and the English option text', () => {
    const html = render(<FieldInput def={category} value={undefined} onChange={noop} locale="en" />, 'en')
    expect(html).toContain('Category')
    expect(html).toContain('Choose what you are buying')
    expect(html).toContain('Hardware')
    expect(html).not.toContain('หมวด')
  })

  it("a rule that applies carries its name, said in the reader's language; one without is shown by its id", () => {
    const definition = formDefinition({ fields: [category], rules: [dpa, { id: 'ATT-X', when: { all: [] }, require: { attachments: 'OTHER', min: 1 } }] })
    const input = { fields: { category: 'SOFTWARE' }, attachments: {}, variables: { $amountGross: 0n, $amountNet: 0n, $requestType: 'IT_SOFTWARE' } }
    const [named, plain] = applicableRules(definition, input)
    expect(ruleLabel(named!, 'en')).toBe('Data processing agreement')
    expect(ruleLabel(named!, 'th')).toBe('ข้อตกลงประมวลผลข้อมูล')
    expect(ruleLabel(plain!, 'en')).toBeNull()
  })
})
