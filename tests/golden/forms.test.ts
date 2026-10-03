import { describe, expect, it } from 'vitest'
import { amountToSatang, satangToAmount } from '@/core/money/dto'
import { compareQuotations, evaluateForm, type AttachmentRule, type VisibilityRule } from '@/core/forms'
import { loadYaml, pick } from './doa-fixtures'

// tests/golden/forms.yaml and quotations.yaml (spec §7.9): GC-FORM-01 to GC-FORM-11.

interface FormsSuite {
  rules: AttachmentRule[]
  visibility: VisibilityRule[]
  cases: Array<{ id: string; title?: string; input: { amountGross: string; attachments: Record<string, number>; fields?: Record<string, unknown> }; expect: Record<string, unknown> }>
}

const forms = loadYaml<FormsSuite>('forms.yaml')

describe('golden forms.yaml', () => {
  it('has cases', () => expect(forms.cases.length).toBeGreaterThan(0))
  for (const c of forms.cases) {
    it(`[${c.id}] ${c.title ?? ''}`.trim(), () => {
      const gross = amountToSatang(c.input.amountGross)
      const result = evaluateForm(
        { rules: forms.rules, visibility: forms.visibility },
        { fields: c.input.fields ?? {}, attachments: c.input.attachments, variables: { $amountGross: gross, $amountNet: gross, $requestType: 'BUY_GOODS' } },
      )
      const actual = result.ok ? { ok: true, droppedFields: result.droppedFields } : { error: result.error, rule: result.rule }
      expect(pick(actual, c.expect)).toEqual(c.expect)
    })
  }
})

interface QuotesSuite {
  vatRateBp: number
  cases: Array<{
    id: string
    title?: string
    input: { quotes: Array<{ ref: string; amount: string; includesVat: boolean }>; selected: string; nonLowestQuoteReason?: string }
    expect: Record<string, unknown>
  }>
}

const quotes = loadYaml<QuotesSuite>('quotations.yaml')

describe('golden quotations.yaml', () => {
  it('has cases', () => expect(quotes.cases.length).toBeGreaterThan(0))
  for (const c of quotes.cases) {
    it(`[${c.id}] ${c.title ?? ''}`.trim(), () => {
      const result = compareQuotations(
        c.input.quotes.map((q) => ({ ref: q.ref, amountSatang: amountToSatang(q.amount), includesVat: q.includesVat })),
        c.input.selected,
        quotes.vatRateBp,
        c.input.nonLowestQuoteReason,
      )
      const nets = Object.fromEntries(Object.entries(result.nets).map(([ref, v]) => [ref, satangToAmount(v)]))
      const actual = result.ok ? { ok: true, nets, lowest: result.lowest } : { error: result.error, rule: result.rule, lowest: result.lowest }
      expect(pick(actual, c.expect)).toEqual(c.expect)
    })
  }
})
