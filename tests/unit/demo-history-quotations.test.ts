import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { amountToSatang, satangToAmount } from '@/core/money/dto'
import { parseDemoHistory } from '@/server/seed/sheets'
import { loadInputWorkbook } from '@/server/seed/workbook'
import { DemoHistoryNetError, quotationAmounts } from '@/server/services/demo-history/quotations'

// D-01 (FR-PLT-001 AC1): a row of sheet Demo_History whose form asks for quotations (ATT-QUOTES above its amount,
// BR-FORM-04) is sent with three: the chosen one at the row's net, and two comparisons at exactly 104 % and 107 % of it.
// BR-MONEY-02 rounds nowhere here, so a comparison that is not a whole satang is refused, never rounded; the seed checks
// every row this way before it writes anything. No database: the rule is pure, and the sheet is read from the file.

/** Satang in a baht, and a net of at most 13 digits of baht as the sheet allows */
const SATANG_PER_BAHT = 100n
const MAX_BAHT = 10n ** 13n - 1n

describe('[FR-PLT-001/AC1] D-01 the quotations of a demo-history row: its net and exactly 104 % and 107 % of it, never rounded (BR-MONEY-02)', () => {
  it('gives the net and exactly 104 % and 107 % of it for a net in whole baht', () => {
    expect(quotationAmounts({ ref: 'H99', net: '120000' })).toEqual([12_000_000n, 12_480_000n, 12_840_000n])
    expect(quotationAmounts({ ref: 'H99', net: '1.00' })).toEqual([100n, 104n, 107n])
    expect(quotationAmounts({ ref: 'H99', net: '0' })).toEqual([0n, 0n, 0n])
  })

  it('refuses a comparison that is not a whole satang, naming the row, rather than round it', () => {
    // 104 % of 1,000.01 is 1,040.0104
    expect(() => quotationAmounts({ ref: 'H99', net: '1000.01' })).toThrow('Demo_History H99: a comparison quotation of 104% of 1000.01 is not a whole satang and is never rounded (BR-MONEY-02): give the net in whole baht')
    // 104 % of 1,000.25 is 1,040.26 exactly, but 107 % is 1,070.2675
    expect(() => quotationAmounts({ ref: 'H99', net: '1000.25' })).toThrow('Demo_History H99: a comparison quotation of 107% of 1000.25 is not a whole satang')
    // A refusal of its own kind, with the row, the net and the comparison, so the seed can explain it
    const refusal = (() => {
      try {
        return quotationAmounts({ ref: 'H42', net: '1000.25' })
      } catch (error) {
        return error
      }
    })()
    expect(refusal).toBeInstanceOf(DemoHistoryNetError)
    expect(refusal).toMatchObject({ name: 'DemoHistoryNetError', ref: 'H42', net: '1000.25', percent: 107n })
  })

  it('makes the quotations of exactly the nets in whole baht (1,000 random nets)', () => {
    // half of the nets whole baht, half with satang
    const net = fc.tuple(fc.bigInt({ min: 0n, max: MAX_BAHT }), fc.oneof(fc.constant(0n), fc.bigInt({ min: 1n, max: SATANG_PER_BAHT - 1n })))
    fc.assert(
      fc.property(net, ([baht, satang]) => {
        const row = { ref: 'H99', net: satangToAmount(baht * SATANG_PER_BAHT + satang) }
        if (satang !== 0n) {
          expect(() => quotationAmounts(row)).toThrow(`Demo_History H99: a comparison quotation of`)
          return
        }
        // exact: 104 and 107 baht for every 100 baht, never a satang more or less
        expect(quotationAmounts(row)).toEqual([baht * SATANG_PER_BAHT, baht * 104n, baht * 107n])
      }),
      { numRuns: 1000 },
    )
  })

  it('makes the quotations of every row of sheet Demo_History, so the seed refuses none of them', async () => {
    const rows = parseDemoHistory(await loadInputWorkbook())
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      // the sheet's nets are whole baht: 104 and 107 baht for every 100 baht of them
      const net = amountToSatang(row.net)
      expect(net % SATANG_PER_BAHT, row.ref).toBe(0n)
      const baht = net / SATANG_PER_BAHT
      expect(quotationAmounts(row), row.ref).toEqual([baht * SATANG_PER_BAHT, baht * 104n, baht * 107n])
    }
  })
})
