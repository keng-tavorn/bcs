import { describe, expect, it } from 'vitest'
import { rateFor, taxDateOf } from '@/core/vat'
import { loadYaml, pick } from './doa-fixtures'

// tests/golden/vat-rate.yaml (spec §7.1, BR-VAT-01, GC-VAT-01..04): the rate of a tax date from dated TaxRate rows.

type Case<I, E> = { id: string; title?: string; fn?: string; input: I; expect: E }

describe('golden vat-rate.yaml', () => {
  const suite = loadYaml<{ fixture: { rates: Array<{ code: string; rateBp: number; effectiveFrom: string; effectiveTo: string }> }; cases: Case<{ date?: string; at?: string }, Record<string, unknown>>[] }>('vat-rate.yaml')
  for (const c of suite.cases) {
    it(`[${c.id}] ${c.title ?? ''}`.trim(), () => {
      const date = c.input.date ?? taxDateOf(new Date(c.input.at!))
      const r = rateFor(date, suite.fixture.rates)
      const actual = { date, ...(r.ok ? { rateBp: r.rateBp } : { error: r.error }) }
      expect(pick(actual, c.expect)).toEqual(c.expect)
    })
  }
})

