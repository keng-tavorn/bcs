import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { compareQuotations, evaluateCondition, evaluateForm, type FormInput } from '@/core/forms'
import { formatDocumentNumber, patternProblems, scopeKey } from '@/core/numbering'
import { bahtText, integerText } from '@/core/thai/baht-text'
import { isValidThaiTaxId, normalizeTaxId } from '@/core/thai/taxid'
import { rateFor, taxDateOf } from '@/core/vat'

// Branches of core/forms, core/numbering, core/thai and core/vat that the golden cases do not reach (spec §7.0 rule 4).

const input = (fields: Record<string, unknown> = {}, attachments: Record<string, number> = {}, gross = 0n): FormInput => ({
  fields,
  attachments,
  variables: { $amountGross: gross, $amountNet: gross, $requestType: 'BUY_GOODS' },
})

describe('[FR-INT-002/AC1] form conditions (§7.9)', () => {
  it('evaluates every operator, numbers without floating point, and money variables in satang', () => {
    const i = input({ qty: '10', tag: 'A', list: [], blank: '  ', none: null, odd: 'x', n: 5, big: 3n })
    expect(evaluateCondition({ field: 'tag', op: 'eq', value: 'A' }, i)).toBe(true)
    expect(evaluateCondition({ field: 'tag', op: 'ne', value: 'A' }, i)).toBe(false)
    expect(evaluateCondition({ field: 'tag', op: 'in', value: ['A', 'B'] }, i)).toBe(true)
    expect(evaluateCondition({ field: 'tag', op: 'in', value: 'A' }, i)).toBe(false)
    expect(evaluateCondition({ field: 'qty', op: 'gt', value: '9.999' }, i)).toBe(true)
    expect(evaluateCondition({ field: 'qty', op: 'gte', value: '10.000' }, i)).toBe(true)
    expect(evaluateCondition({ field: 'qty', op: 'lt', value: '10' }, i)).toBe(false)
    expect(evaluateCondition({ field: 'qty', op: 'lte', value: '10' }, i)).toBe(true)
    expect(evaluateCondition({ field: 'qty', op: 'gt', value: '-3.5' }, i)).toBe(true)
    expect(evaluateCondition({ field: 'n', op: 'gte', value: 5 }, i)).toBe(true)
    expect(evaluateCondition({ field: 'big', op: 'lt', value: 4n }, i)).toBe(true)
    expect(evaluateCondition({ field: 'odd', op: 'gt', value: '1' }, i)).toBe(false)
    expect(evaluateCondition({ field: 'qty', op: 'gt', value: '0.' + '1'.repeat(19) }, i)).toBe(false)
    expect(evaluateCondition({ field: 'qty', op: 'gt', value: Number.NaN }, i)).toBe(false)
    for (const field of ['list', 'blank', 'none', 'missing']) expect(evaluateCondition({ field, op: 'empty' }, i)).toBe(true)
    expect(evaluateCondition({ field: 'tag', op: 'notEmpty' }, i)).toBe(true)
    expect(evaluateCondition({ all: [{ field: 'tag', op: 'eq', value: 'A' }, { field: 'qty', op: 'gt', value: '1' }] }, i)).toBe(true)
    expect(evaluateCondition({ any: [{ field: 'tag', op: 'eq', value: 'Z' }, { field: 'qty', op: 'gt', value: '100' }] }, i)).toBe(false)
    const money = input({}, {}, 10_000_001n)
    expect(evaluateCondition({ field: '$amountGross', op: 'gt', value: '100000.00' }, money)).toBe(true)
    expect(evaluateCondition({ field: '$amountNet', op: 'lte', value: '100000.01' }, money)).toBe(true)
    expect(evaluateCondition({ field: '$amountGross', op: 'gt', value: 'abc' }, money)).toBe(false)
    expect(evaluateCondition({ field: '$requestType', op: 'eq', value: 'BUY_GOODS' }, money)).toBe(true)
  })

  it('reports every failing rule with what is missing, the first one as the main rule', () => {
    const rules = [
      { id: 'R1', when: { field: 'a', op: 'eq' as const, value: 'Y' }, require: { attachments: 'DPA', min: 1 } },
      { id: 'R2', when: { field: 'a', op: 'eq' as const, value: 'Y' }, require: { all: [{ attachments: 'QUOTATION', min: 2 }, { field: 'why', op: 'notEmpty' as const }] } },
      { id: 'R3', when: { field: 'a', op: 'eq' as const, value: 'Y' }, require: { any: [] } },
    ]
    const result = evaluateForm({ rules, visibility: [] }, input({ a: 'Y' }, { QUOTATION: 1 }))
    expect(result).toEqual({
      ok: false,
      error: 'ATTACHMENT_RULE_FAILED',
      rule: 'R1',
      failures: [
        { rule: 'R1', missing: [{ kind: 'ATTACHMENT', attachment: 'DPA', need: 1, have: 0 }] },
        {
          rule: 'R2',
          missing: [
            { kind: 'ATTACHMENT', attachment: 'QUOTATION', need: 2, have: 1 },
            { kind: 'FIELD', field: 'why', op: 'notEmpty' },
          ],
        },
      ],
    })
  })

  it('needs exactly one existing quote, and treats equal prices before VAT as lowest together', () => {
    const quotes = [
      { ref: 'A', amountSatang: 10_700n, includesVat: true },
      { ref: 'B', amountSatang: 10_000n, includesVat: false },
    ]
    expect(compareQuotations(quotes, 'A', 700)).toMatchObject({ ok: true, lowest: ['A', 'B'] })
    expect(compareQuotations(quotes, null, 700)).toMatchObject({ ok: false, rule: 'QUOTE-SELECTED' })
    expect(compareQuotations(quotes, 'Z', 700)).toMatchObject({ ok: false, rule: 'QUOTE-SELECTED' })
    expect(compareQuotations([], null, 700)).toMatchObject({ ok: false, rule: 'QUOTE-SELECTED', lowest: [] })
    expect(compareQuotations([...quotes, { ref: 'C', amountSatang: 1n, includesVat: false }], 'A', 700, '   ')).toMatchObject({ ok: false, rule: 'QUOTE-LOWEST' })
  })
})

describe('[FR-DOA-008/AC1] document numbers (BR-NUM-02, BR-NUM-03)', () => {
  const at = new Date('2026-10-02T03:00:00Z')
  it('fills CE and NEVER scopes, and refuses bad patterns, sequence values and a missing department', () => {
    expect(formatDocumentNumber('X-{CE}-{SEQ1}', { at, seq: 3 })).toBe('X-2026-3')
    expect(scopeKey('X', 'X-{SEQ3}', 'NEVER', { at })).toBe('X:NEVER')
    expect(patternProblems('X-{BE}-{FOO}-{SEQ2}')).toEqual(['unknown token {FOO}'])
    expect(patternProblems('X-{BE}')).toEqual(['the pattern needs exactly one {SEQn}'])
    expect(patternProblems('X-{SEQ0}')).toEqual(['{SEQn} needs a width of at least 1'])
    expect(() => formatDocumentNumber('X-{BE}', { at, seq: 1 })).toThrow(RangeError)
    expect(() => formatDocumentNumber('X-{SEQ3}', { at, seq: 0 })).toThrow(RangeError)
    expect(() => formatDocumentNumber('X-{DEPT}-{SEQ3}', { at, seq: 1 })).toThrow(RangeError)
    expect(() => scopeKey('X', 'X-{DEPT}-{SEQ3}', 'YEARLY', { at })).toThrow(RangeError)
  })
})

describe('[FR-PLT-009/AC1] Thai amount text and tax IDs beyond the golden cases (BR-THAI-01, BR-TAXID-01)', () => {
  it('refuses negative amounts and reads every digit and group', () => {
    expect(() => bahtText(-1n)).toThrow(RangeError)
    expect(() => integerText(-1n)).toThrow(RangeError)
    expect(integerText(0n)).toBe('ศูนย์')
    expect(integerText(2_002_000_000n)).toBe('สองพันสองล้าน')
    expect(integerText(345_678n)).toBe('สามแสนสี่หมื่นห้าพันหกร้อยเจ็ดสิบแปด')
    expect(integerText(91n)).toBe('เก้าสิบเอ็ด')
  })

  it('strips spaces and dashes before checking, and its check digit agrees with the rule for any 12 digits (1,000 samples)', () => {
    expect(normalizeTaxId(' 1-2345 67890-12-1 ')).toBe('1234567890121')
    fc.assert(
      fc.property(fc.stringMatching(/^\d{12}$/), (twelve) => {
        let sum = 0
        for (let i = 0; i < 12; i++) sum += Number(twelve[i]) * (13 - i)
        const check = (11 - (sum % 11)) % 10
        expect(isValidThaiTaxId(twelve + String(check))).toBe(true)
        expect(isValidThaiTaxId(twelve + String((check + 1) % 10))).toBe(false)
      }),
      { numRuns: 1000 },
    )
  })
})

describe('[FR-INT-003/AC1] VAT rate lookup (BR-VAT-01)', () => {
  const rates = [
    { code: 'VAT_STANDARD', rateBp: 700, effectiveFrom: '2025-10-01', effectiveTo: '2026-09-30' },
    { code: 'VAT_STANDARD', rateBp: 1000, effectiveFrom: '2026-10-01', effectiveTo: null },
    { code: 'OTHER', rateBp: 0, effectiveFrom: '2000-01-01', effectiveTo: null },
  ]
  it('takes open-ended periods and other codes, and refuses a malformed date', () => {
    expect(rateFor('2030-01-01', rates)).toEqual({ ok: true, rateBp: 1000 })
    expect(rateFor('2030-01-01', rates, 'OTHER')).toEqual({ ok: true, rateBp: 0 })
    expect(rateFor('2025-09-30', rates)).toEqual({ ok: false, error: 'TAX_RATE_NOT_CONFIGURED', date: '2025-09-30' })
    expect(() => rateFor('2026/10/01', rates)).toThrow(RangeError)
    expect(taxDateOf(new Date('2026-10-01T16:59:59Z'))).toBe('2026-10-01')
  })
})
