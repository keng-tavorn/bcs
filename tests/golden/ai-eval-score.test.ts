import { describe, expect, it } from 'vitest'
import { fieldKind, fieldScore, matchField, normalizeAnswer, normalizeValue, type AnswerLine } from '@/core/ai-checks'
import { loadGolden } from './support'

// tests/golden/ai-eval-score.yaml (spec §12.6, BR-AI-26): GC-AI-12 to GC-AI-21. The runner only adapts shapes.

interface Case {
  id: string
  title?: string
  fn: 'matchField' | 'normalizeAnswer' | 'fieldScore'
  input: Record<string, unknown>
  expect: Record<string, unknown>
}

const suite = loadGolden('ai-eval-score') as unknown as { cases: Case[] }

function run(c: Case): Record<string, unknown> {
  const i = c.input as { field: string; expected: unknown; actual: unknown; lines: AnswerLine[] }
  if (c.fn === 'matchField') return { match: matchField(i.field, i.expected, i.actual) }
  if (c.fn === 'normalizeAnswer') {
    const r = normalizeAnswer({ lines: i.lines })
    return { lines: r.lines.length, discountTotal: r.discountTotal }
  }
  return fieldScore(c.input as never)
}

describe('[BR-AI-26] golden ai-eval-score.yaml', () => {
  it('has cases', () => expect(suite.cases.length).toBeGreaterThan(0))
  for (const c of suite.cases) {
    it(`[${c.id}] ${c.title ?? c.fn}`, () => {
      const got = run(c)
      for (const [k, v] of Object.entries(c.expect)) expect(got[k], k).toEqual(v)
    })
  }
})

describe('[BR-AI-26] every kind of field compares after its own normalization', () => {
  it('reads quantities, dates and text, and a value that cannot be read never matches', () => {
    expect(fieldKind('lines.0.qty')).toBe('QUANTITY')
    expect(matchField('lines.0.qty', '18', '18.0000')).toBe(true)
    expect(matchField('lines.0.qty', '18', 'สิบแปด')).toBe(false)
    expect(matchField('docDate', '2026-10-01', '2026-10-01')).toBe(true)
    expect(matchField('docDate', '2026-10-01', '01/10/2569')).toBe(false)
    expect(matchField('lines.0.description', 'ท่อ  PPR 1 นิ้ว', ' ท่อ PPR 1 นิ้ว')).toBe(true)
    expect(matchField('gross', 'abc', 'abc')).toBe(false)
    expect(normalizeValue('lines.0.unit', '')).toBeNull()
    expect(fieldScore({ correct: 0, total: 0, thresholdBp: 9800, missed: 0 })).toEqual({ scoreBp: 10000, pass: true })
  })
  it('keeps a discount already in discountTotal and adds negative lines to it', () => {
    expect(normalizeAnswer({ lines: [{ qty: '1', unitPrice: '100.00' }], discountTotal: '5.00' })).toMatchObject({ discountTotal: '5.00' })
    expect(normalizeAnswer({ lines: [{ amount: '-3.00' }, { qty: '1' }], discountTotal: '5.00' })).toMatchObject({ discountTotal: '8.00' })
    expect(normalizeAnswer({ lines: [{ qty: '1', unitPrice: '100.00' }] })).toMatchObject({ discountTotal: null })
  })
})
