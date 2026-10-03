import { describe, expect, it } from 'vitest'
import { amountToSatang, satangToAmount } from '@/core/money/dto'
import { allocateLargestRemainder, documentTotals, lineNet, parseQuantity, roundHalfUpDiv, vatFromGross, vatFromNet } from '@/core/money/math'
import { loadYaml, pick } from './doa-fixtures'

// tests/golden/money.yaml (spec §7.1, BR-MONEY-01/02, BR-VAT-02..04): the runner reads the file, makes one test per case
// with its id, and only converts amounts between baht text and satang.

type Case<I, E> = { id: string; title?: string; fn?: string; input: I; expect: E }

describe('golden money.yaml', () => {
  const suite = loadYaml<{ cases: Case<Record<string, unknown>, Record<string, string>>[] }>('money.yaml')
  for (const c of suite.cases) {
    it(`[${c.id}] ${c.title ?? ''}`.trim(), () => {
      const i = c.input as { net?: string; gross?: string; rateBp?: number; qty?: string; unitPrice?: string; priceIncludesVat?: boolean; lines?: Array<{ qty: string; unitPrice: string; vatable?: boolean }> }
      const out = (o: Record<string, bigint>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, satangToAmount(v)]))
      const actual =
        c.fn === 'vatFromNet'
          ? out(vatFromNet(amountToSatang(i.net!), i.rateBp!))
          : c.fn === 'vatFromGross'
            ? out(vatFromGross(amountToSatang(i.gross!), i.rateBp!))
            : c.fn === 'lineNet'
              ? out({ net: lineNet(i.qty!, amountToSatang(i.unitPrice!)) })
              : out(documentTotals(i.lines!.map((l) => ({ quantity: l.qty, unitPriceSatang: amountToSatang(l.unitPrice), ...(l.vatable === undefined ? {} : { vatable: l.vatable }) })), i.rateBp!, i.priceIncludesVat ?? false))
      expect(pick(actual, c.expect)).toEqual(c.expect)
    })
  }
})


describe('money arithmetic beyond the golden cases', () => {
  it('rounds half away from zero for negatives, and refuses what it cannot compute', () => {
    expect(roundHalfUpDiv(-5n, 2n)).toBe(-3n)
    expect(roundHalfUpDiv(-4n, 3n)).toBe(-1n)
    expect(() => roundHalfUpDiv(1n, 0n)).toThrow(RangeError)
    for (const bad of ['-1', 'abc', '1.23456', '']) expect(() => parseQuantity(bad), bad).toThrow(RangeError)
    for (const bad of [-1, 1.5]) expect(() => vatFromNet(100n, bad), String(bad)).toThrow(RangeError)
  })

  it('allocates zero over zero weights, and refuses negatives or a total over zero weights', () => {
    expect(allocateLargestRemainder(0n, [0n, 0n])).toEqual([0n, 0n])
    expect(() => allocateLargestRemainder(1n, [0n, 0n])).toThrow(RangeError)
    expect(() => allocateLargestRemainder(-1n, [1n])).toThrow(RangeError)
    expect(() => allocateLargestRemainder(1n, [1n, -1n])).toThrow(RangeError)
  })
})
