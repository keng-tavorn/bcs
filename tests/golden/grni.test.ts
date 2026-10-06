import { describe, expect, it } from 'vitest'
import { amountToSatang, satangToAmount } from '@/core/money/dto'
import { grniReport } from '@/core/grni'
import { loadYaml, pick } from './doa-fixtures'

// tests/golden/grni.yaml (spec §7.16, BR-RPT-01): GC-RPT-01 to GC-RPT-05.

interface GrniSuite {
  cases: Array<{
    id: string
    title: string
    input: { lines: Array<{ costCenter: string; accepted: string; unitPrice: string; invoiced: string }> }
    expect: Record<string, unknown>
  }>
}

const suite = loadYaml<GrniSuite>('grni.yaml')

describe('[FR-VIS-005/AC1] golden grni.yaml', () => {
  it('has cases', () => expect(suite.cases.length).toBeGreaterThan(0))
  for (const c of suite.cases) {
    it(`[${c.id}] ${c.title}`, () => {
      const r = grniReport(
        c.input.lines.map((l) => ({ costCenter: l.costCenter, accepted: l.accepted, unitPriceSatang: amountToSatang(l.unitPrice), invoicedSatang: amountToSatang(l.invoiced) })),
      )
      const actual = {
        lines: r.lines.map((l) => ({ grni: satangToAmount(l.grniSatang), invoicedNotReceived: satangToAmount(l.invoicedNotReceivedSatang) })),
        byCostCenter: Object.fromEntries([...r.byCostCenter].map(([cc, v]) => [cc, satangToAmount(v)])),
      }
      expect(pick(actual, c.expect)).toEqual(c.expect)
    })
  }
})

describe('[FR-VIS-005/AC3] the report total equals the sum of its lines', () => {
  it('totals per budget line too, and refuses negative amounts', () => {
    const r = grniReport([
      { costCenter: 'CC-A', budgetLineId: 'L1', accepted: '3', unitPriceSatang: 10_000n, invoicedSatang: 5_000n },
      { costCenter: 'CC-B', budgetLineId: 'L1', accepted: '1', unitPriceSatang: 20_000n, invoicedSatang: 0n },
      { costCenter: 'CC-B', budgetLineId: null, accepted: '1', unitPriceSatang: 1_000n, invoicedSatang: 4_000n },
    ])
    expect(r.lines.map((l) => l.grniSatang)).toEqual([25_000n, 20_000n, 0n])
    expect(r.lines[2]).toMatchObject({ receivedSatang: 1_000n, invoicedNotReceivedSatang: 3_000n })
    expect(r.totalSatang).toBe(r.lines.reduce((a, l) => a + l.grniSatang, 0n))
    expect([...r.byBudgetLine]).toEqual([['L1', 45_000n]])
    expect([...r.byCostCenter]).toEqual([
      ['CC-A', 25_000n],
      ['CC-B', 20_000n],
    ])
    expect(() => grniReport([{ costCenter: 'CC-A', accepted: '1', unitPriceSatang: 1n, invoicedSatang: -1n }])).toThrow(RangeError)
    expect(() => grniReport([{ costCenter: 'CC-A', accepted: '1', unitPriceSatang: -1n, invoicedSatang: 0n }])).toThrow(RangeError)
  })
})
