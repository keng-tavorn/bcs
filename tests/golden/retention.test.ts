import { describe, expect, it } from 'vitest'
import { amountToSatang, satangToAmount } from '@/core/money/dto'
import { invoicePayment, retentionOf, retentionRelease, splitMilestones } from '@/core/retention'
import { loadYaml, pick } from './doa-fixtures'

// tests/golden/retention.yaml (spec BR-RET-01, BR-RET-03, BR-WHT-05, ADR-124): milestones of a service line, an invoice
// with its retention and the tax withheld at payment, and a released retention paid alone.

type Raw = Record<string, unknown>
interface RetentionCase { id: string; title: string; fn: 'splitMilestones' | 'invoicePayment' | 'retentionRelease'; input: Raw; expect: Raw }

const suite = loadYaml<{ cases: RetentionCase[] }>('retention.yaml')
const baht = satangToAmount

function run(c: RetentionCase): Raw {
  if (c.fn === 'splitMilestones') {
    const i = c.input as { qty: string; unitPrice: string; sharesBp: number[] }
    const r = splitMilestones(i.qty, amountToSatang(i.unitPrice), i.sharesBp)
    if (!r.ok) return { error: r.code }
    return { lines: r.lines.map((l) => ({ qty: l.qty, net: baht(l.netSatang) })), total: baht(r.totalSatang), driftFromSingleLine: baht(r.driftSatang) }
  }
  if (c.fn === 'invoicePayment') {
    const i = c.input as { net: string; vatRateBp: number; retentionBp: number; whtRateBp: number }
    const r = invoicePayment(amountToSatang(i.net), i.vatRateBp, i.retentionBp, i.whtRateBp)
    return { vat: baht(r.vatSatang), gross: baht(r.grossSatang), retention: baht(r.retentionSatang), payable: baht(r.payableSatang), whtBase: baht(r.whtBaseSatang), wht: baht(r.whtSatang), transfer: baht(r.transferSatang) }
  }
  const i = c.input as { retention: string; whtRateBp: number }
  const r = retentionRelease(amountToSatang(i.retention), i.whtRateBp)
  return { payable: baht(r.payableSatang), wht: baht(r.whtSatang), transfer: baht(r.transferSatang) }
}

describe('[FR-AP-106/AC1] [FR-AP-106/AC3] golden retention.yaml', () => {
  it('has cases', () => expect(suite.cases.length).toBeGreaterThan(0))
  for (const c of suite.cases) {
    it(`[${c.id}] ${c.title}`, () => {
      const actual = run(c)
      expect(pick(actual, c.expect)).toEqual(c.expect)
      expect(Object.keys(actual).sort()).toEqual(Object.keys(c.expect).sort())
    })
  }
})

describe('retention beyond the golden cases', () => {
  it('refuses shares that are not 2–12 whole parts above zero, a quantity too small to split, and bad rates', () => {
    expect(splitMilestones('1', 100n, [10_000])).toEqual({ ok: false, code: 'VALIDATION_FAILED', reason: 'SHARES' })
    expect(splitMilestones('1', 100n, Array(13).fill(769).concat([3]) as number[])).toMatchObject({ ok: false, reason: 'SHARES' })
    expect(splitMilestones('1', 100n, [5000, 4999.5, 0.5])).toMatchObject({ ok: false, reason: 'SHARES' })
    expect(splitMilestones('1', 100n, [10_001, -1])).toMatchObject({ ok: false, reason: 'SHARES' })
    expect(splitMilestones('0.0001', 100n, [5000, 5000])).toEqual({ ok: false, code: 'VALIDATION_FAILED', reason: 'QUANTITY' })
    expect(() => retentionOf(100n, -1)).toThrow(RangeError)
    expect(() => retentionOf(100n, 10_001)).toThrow(RangeError)
    expect(() => retentionOf(100n, 2.5)).toThrow(RangeError)
    expect(() => invoicePayment(-1n, 700, 500, 300)).toThrow(RangeError)
    expect(() => invoicePayment(100n, 700, 500, -1)).toThrow(RangeError)
    expect(() => retentionRelease(-1n, 300)).toThrow(RangeError)
    expect(() => retentionRelease(100n, 1.5)).toThrow(RangeError)
  })
})
