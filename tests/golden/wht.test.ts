import { describe, expect, it } from 'vitest'
import { amountToSatang, satangToAmount } from '@/core/money/dto'
import { withholding } from '@/core/wht'
import { loadYaml, pick } from './doa-fixtures'

// tests/golden/wht.yaml (spec §7.14, BR-WHT-01, a tier 2 preview): GC-WHT-01.

interface WhtSuite {
  cases: Array<{ id: string; title: string; input: { net: string; vatRateBp: number; whtRateBp: number }; expect: Record<string, unknown> }>
}

const suite = loadYaml<WhtSuite>('wht.yaml')

describe('golden wht.yaml', () => {
  it('has cases', () => expect(suite.cases.length).toBeGreaterThan(0))
  for (const c of suite.cases) {
    it(`[${c.id}] ${c.title}`, () => {
      const r = withholding(amountToSatang(c.input.net), c.input.vatRateBp, c.input.whtRateBp)
      const actual = { vat: satangToAmount(r.vatSatang), wht: satangToAmount(r.whtSatang), payable: satangToAmount(r.payableSatang) }
      expect(pick(actual, c.expect)).toEqual(c.expect)
    })
  }
})

describe('withholding beyond the golden case', () => {
  it('rounds the tax half up once, and refuses a negative base or a bad rate', () => {
    // 1,234.50 × 3% = 37.035 → 37.04; VAT 86.415 → 86.42
    expect(withholding(123_450n, 700, 300)).toEqual({ vatSatang: 8_642n, whtSatang: 3_704n, payableSatang: 128_388n })
    expect(() => withholding(-1n, 700, 300)).toThrow(RangeError)
    expect(() => withholding(100n, 700, 1.5)).toThrow(RangeError)
    expect(() => withholding(100n, 700, -300)).toThrow(RangeError)
  })
})
