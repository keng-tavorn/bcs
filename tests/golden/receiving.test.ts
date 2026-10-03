import { describe, expect, it } from 'vitest'
import { amountToSatang, satangToAmount } from '@/core/money/dto'
import { formatQuantity, receive, type ExcessDisposition } from '@/core/receiving'
import { loadYaml, pick } from './doa-fixtures'

// tests/golden/receiving.yaml (spec §7.11): GC-GR-01 to GC-GR-05, the result once the variances that need approval are
// approved. The delta of the hold is signed baht text.

interface ReceivingSuite {
  cases: Array<{
    id: string
    title: string
    input: { ordered: string; unitPrice: string; received: string; tolerancePct: number; disposition?: ExcessDisposition; closeShort?: boolean }
    expect: Record<string, unknown>
  }>
}

const suite = loadYaml<ReceivingSuite>('receiving.yaml')
const signed = (v: bigint) => (v < 0n ? `-${satangToAmount(-v)}` : satangToAmount(v))

describe('[FR-P2P-007/AC1] golden receiving.yaml', () => {
  it('has cases', () => expect(suite.cases.length).toBeGreaterThan(0))
  for (const c of suite.cases) {
    it(`[${c.id}] ${c.title}`, () => {
      const r = receive({
        ordered: c.input.ordered,
        unitPriceSatang: amountToSatang(c.input.unitPrice),
        received: c.input.received,
        tolerancePct: c.input.tolerancePct,
        ...(c.input.disposition ? { disposition: c.input.disposition } : {}),
        ...(c.input.closeShort ? { closeShort: true } : {}),
      })
      const actual = {
        poStatus: r.poStatus,
        accepted: r.accepted,
        variances: r.variances.map((v) => ({ type: v.type, quantity: v.quantity, amount: satangToAmount(v.amountSatang), needsApproval: v.needsApproval })),
        commitDelta: signed(r.commitDeltaSatang),
      }
      expect(pick(actual, c.expect)).toEqual(c.expect)
    })
  }
})

describe('receiving beyond the golden cases', () => {
  it('a tolerance covers part of an excess: that part is held at once, the rest is the variance', () => {
    const r = receive({ ordered: '100', unitPriceSatang: 1_000n, received: '110', tolerancePct: 5, disposition: 'ACCEPT_EXCESS' })
    expect(r).toMatchObject({ accepted: '110', variances: [{ type: 'OVER', quantity: '5', amountSatang: 5_000n, needsApproval: true }], commitDeltaSatang: 10_000n })
    const back = receive({ ordered: '100', unitPriceSatang: 1_000n, received: '110', tolerancePct: 5, disposition: 'RETURN_EXCESS' })
    expect(back).toMatchObject({ accepted: '105', variances: [{ quantity: '5', needsApproval: false }], commitDeltaSatang: 5_000n })
  })

  it('decimal quantities round once (BR-MONEY-02), and a bad tolerance is refused', () => {
    expect(receive({ ordered: '2.5', unitPriceSatang: 1_001n, received: '1.25', tolerancePct: 0, closeShort: true })).toMatchObject({ accepted: '1.25', variances: [{ quantity: '1.25', amountSatang: 1_251n }], commitDeltaSatang: -1_251n })
    expect(() => receive({ ordered: '1', unitPriceSatang: 1n, received: '1', tolerancePct: -1 })).toThrow(RangeError)
    expect(formatQuantity(10_000n)).toBe('1')
    expect(formatQuantity(12_500n)).toBe('1.25')
  })
})
