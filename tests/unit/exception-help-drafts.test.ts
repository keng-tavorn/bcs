import { describe, expect, it } from 'vitest'
import { checkAiText, type TextValue } from '@/core/ai-checks'
import { DECISION_ADVICE_WORDS } from '@/lib/ai-config'
import { HELP_MESSAGE_MAX } from '@/lib/exception-help'
import en from '../../messages/src/en/exceptionHelp.json'
import th from '../../messages/src/th/exceptionHelp.json'

// NEW-126 (FR-AP-103 AC7, ADR-081): the helper of a difference drafts its question and e-mail from these templates, not
// with an AI. Each one still passes the checker of BR-AI-27 the way an AI's text would: every value a placeholder filled
// by code (no digit written in the words), no advice to decide, and within the length of a message — so what a person
// reads and sends never carries a number nobody computed or a word telling them to approve or reject.

/** Each {name} of a message as a placeholder of the checker */
const asChecked = (template: string) => template.replace(/\{(\w+)\}/g, (_, name: string) => `{{v:${name}}}`)

/** A long value for every name a draft fills in, so the length is checked against what a draft can become */
const values: Record<string, TextValue> = Object.fromEntries(
  ['name', 'invoice', 'supplierInvoiceNo', 'po', 'line', 'description', 'uom', 'invoiced', 'ordered', 'received', 'elsewhere', 'quantity', 'price', 'poPrice', 'stated'].map((k) => [k, { kind: 'text', value: 'x'.repeat(40) }]),
)

const drafts = (messages: typeof th) =>
  [
    ...Object.entries(messages.draft).flatMap(([kind, byType]) => Object.entries(byType as Record<string, string>).map(([type, template]) => ({ key: `${kind}.${type}`, template }))),
    // The clause a quantity draft adds when other invoices billed part of the line
    { key: 'draftElsewhere', template: messages.draftElsewhere },
  ]

describe('[FR-AP-103/AC7] the helper’s drafts pass the text checker of BR-AI-27', () => {
  for (const [lang, messages] of [['th', th], ['en', en]] as const) {
    it(`every ${lang} draft: values from code only, no advice to decide, within a message`, () => {
      const all = drafts(messages)
      expect(all.length).toBe(11)
      for (const { key, template } of all) {
        const checked = checkAiText([asChecked(template)], values, { maxSentences: 1, maxChars: HELP_MESSAGE_MAX }, DECISION_ADVICE_WORDS)
        expect(checked, `${lang} ${key}`).toEqual({ ok: true, rendered: [expect.any(String)] })
      }
    })
  }

  it('drafts the same kinds in both languages', () => {
    expect(drafts(en).map((d) => d.key)).toEqual(drafts(th).map((d) => d.key))
  })

  it('the checker would refuse a template that wrote a number or advised a decision', () => {
    expect(checkAiText([asChecked('ราคา 1,100 บาท {po}')], values, { maxSentences: 1, maxChars: HELP_MESSAGE_MAX }, DECISION_ADVICE_WORDS)).toMatchObject({ ok: false, reason: 'DIGIT_OUTSIDE_PLACEHOLDER' })
    expect(checkAiText([asChecked('ควรอนุมัติส่วนต่าง {po}')], values, { maxSentences: 1, maxChars: HELP_MESSAGE_MAX }, DECISION_ADVICE_WORDS)).toMatchObject({ ok: false, reason: 'DECISION_ADVICE' })
  })
})
