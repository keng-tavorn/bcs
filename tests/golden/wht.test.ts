import { describe, expect, it } from 'vitest'
import { amountToSatang, satangToAmount } from '@/core/money/dto'
import { paymentWithholding, whtForPayment, withholding, type PayeeType, type WhtTypeForm } from '@/core/wht'
import { loadYaml, pick } from './doa-fixtures'

// tests/golden/wht.yaml (spec §7.14, BR-WHT-01 and BR-WHT-03 to BR-WHT-10): every case, counted from the file. A case
// with no fn is the tax of one amount; whtForPayment is the form and tax of one payment (minimum base "1000.00", the
// OQ-122 default the file names); paymentWithholding groups a payment's documents by income type and rate.

type Raw = Record<string, unknown>
interface WhtCase { id: string; title: string; fn?: 'whtForPayment' | 'paymentWithholding'; input: Raw; expect: Raw }
interface PaymentInput { payeeType: PayeeType; incomeType: string | null; rateBp: number; typeForm: WhtTypeForm | null; poNet: string; base: string }
interface LineInput { doc: string; incomeType: string; rateBp: number; base: string }

const suite = loadYaml<{ cases: WhtCase[] }>('wht.yaml')

const baht = satangToAmount
const MINIMUM_BASE = '1000.00' // settings.wht.minimumBase, the OQ-122 default the yaml comment states

function runAmount(c: WhtCase): Raw {
  const i = c.input as { net: string; vatRateBp: number; whtRateBp: number }
  const r = withholding(amountToSatang(i.net), i.vatRateBp, i.whtRateBp)
  return { vat: baht(r.vatSatang), wht: baht(r.whtSatang), payable: baht(r.payableSatang) }
}

function runPayment(c: WhtCase): Raw {
  const i = c.input as unknown as PaymentInput
  const r = whtForPayment({
    payeeType: i.payeeType,
    incomeType: i.incomeType,
    rateBp: i.rateBp,
    typeForm: i.typeForm,
    poNetSatang: amountToSatang(i.poNet),
    baseSatang: amountToSatang(i.base),
    minimumBaseSatang: amountToSatang(MINIMUM_BASE),
  })
  if (!r.ok) return { error: r.code, ...(r.reason !== null ? { reason: r.reason } : {}) }
  return { form: r.form, wht: baht(r.whtSatang), ...(r.reason !== null ? { reason: r.reason } : {}) }
}

function runLines(c: WhtCase): Raw {
  const i = c.input as { lines: LineInput[] }
  const r = paymentWithholding(i.lines.map((l) => ({ doc: l.doc, incomeType: l.incomeType, rateBp: l.rateBp, baseSatang: amountToSatang(l.base) })))
  if (!r.ok) return { error: r.code, reason: r.reason }
  return {
    groups: r.groups.map((g) => ({
      incomeType: g.incomeType,
      rateBp: g.rateBp,
      base: baht(g.baseSatang),
      wht: baht(g.whtSatang),
      docs: g.docs.map((d) => ({ doc: d.doc, wht: baht(d.whtSatang) })),
    })),
    wht: baht(r.whtSatang),
  }
}

describe('[FR-AP-104/AC1] golden wht.yaml', () => {
  it('has cases', () => expect(suite.cases.length).toBeGreaterThan(0))
  for (const c of suite.cases) {
    it(`[${c.id}] ${c.title}`, () => {
      const run = c.fn === 'whtForPayment' ? runPayment : c.fn === 'paymentWithholding' ? runLines : runAmount
      const actual = run(c)
      expect(pick(actual, c.expect)).toEqual(c.expect)
      // no field the case does not name: a reason on a case that expects none is a failure
      expect(Object.keys(actual).sort()).toEqual(Object.keys(c.expect).sort())
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
