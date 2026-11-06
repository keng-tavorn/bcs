import { describe, expect, it } from 'vitest'
import type { BusinessCalendar } from '@/core/sla'
import {
  awardAmount,
  businessDayMinutes,
  compareBids,
  confirmedNetPriceCap,
  criterionScoreBp,
  cycleMedianDays,
  earliestCloseAt,
  formatScore,
  formatTenths,
  priceAnomaly,
  priceScoreBp,
  rankBids,
  savings,
  savingsTotal,
  scorecardReveal,
  validateScorecard,
  type CriterionInput,
} from '@/core/sourcing'

// S10-03: the edges of src/core/sourcing the golden files (rfx-scoring.yaml, rfx-award.yaml) do not reach — refused
// inputs, empty sets and the last tie-breaks — so every branch of the engine has a test (spec §7.0 item 4).

const cal: BusinessCalendar = { timezone: 'Asia/Bangkok', workdays: ['MON', 'TUE', 'WED', 'THU', 'FRI'], start: '08:30', end: '17:30', holidays: [] }
const PRICE_ONLY: CriterionInput[] = [{ code: 'PRICE', kind: 'PRICE', weightBp: 10000 }]

describe('compareBids (BR-RFX-08) edges', () => {
  it('has no lowest without a complete bid, and leaves out a line nobody offers', () => {
    const r = compareBids([{ ref: 'L1', quantity: '1' }, { ref: 'L2', quantity: '1' }], [{ ref: 'A', priceIncludesVat: false, vatRateBp: 700, unitPrices: { L1: 100n } }])
    expect(r.lowest).toEqual([])
    expect(r.lowestNet).toBeNull()
    expect(r.lineLowest).toEqual([['L1', 'A']])
  })
})

describe('scores (BR-RFX-09 BR-RFX-10) edges', () => {
  it('refuses a price score above the bid or of nothing', () => {
    expect(() => priceScoreBp(0n, 100n)).toThrow(RangeError)
    expect(() => priceScoreBp(200n, 100n)).toThrow(RangeError)
  })
  it('refuses no score, a fraction and a score outside 0–100', () => {
    expect(() => criterionScoreBp([])).toThrow(RangeError)
    expect(() => criterionScoreBp([80.5])).toThrow(RangeError)
    expect(() => criterionScoreBp([101])).toThrow(RangeError)
    expect(() => criterionScoreBp([-1])).toThrow(RangeError)
  })
  it('wants exactly one price criterion and whole weights from 0 to 10000', () => {
    const noPrice = validateScorecard([{ code: 'Q', kind: 'QUALITY', weightBp: 10000 }])
    expect(noPrice.ok || noPrice.error.details).toEqual({ reason: 'PRICE_CRITERION' })
    const twoPrices = validateScorecard([...PRICE_ONLY, { code: 'P2', kind: 'PRICE', weightBp: 0 }])
    expect(twoPrices.ok || twoPrices.error.details).toEqual({ reason: 'PRICE_CRITERION' })
    for (const weightBp of [-1, 10001, 0.5]) {
      const r = validateScorecard([{ code: 'PRICE', kind: 'PRICE', weightBp }])
      expect(r.ok || r.error.details).toEqual({ reason: 'WEIGHT_INVALID' })
    }
    expect(validateScorecard(PRICE_ONLY).ok).toBe(true)
  })
  it('reveals once everyone not recused submitted, at least the minimum', () => {
    expect(scorecardReveal(2, [{ memberId: 'a', status: 'SUBMITTED' }, { memberId: 'b', status: 'SUBMITTED' }, { memberId: 'c', status: 'RECUSED' }])).toEqual({ revealed: true, missing: [], counted: 2 })
    expect(scorecardReveal(0, [])).toEqual({ revealed: true, missing: [], counted: 0 })
  })
  it('refuses to rank on an invalid scorecard or a bid without a quality score', () => {
    expect(() => rankBids([{ code: 'PRICE', kind: 'PRICE', weightBp: 9000 }], 100n, [])).toThrow(/WEIGHTS_SUM/)
    const criteria: CriterionInput[] = [{ code: 'PRICE', kind: 'PRICE', weightBp: 5000 }, { code: 'Q', kind: 'QUALITY', weightBp: 5000 }]
    expect(() => rankBids(criteria, 100n, [{ ref: 'A', net: 100n, submittedAt: new Date(0), supplierId: 's', scores: {} }])).toThrow(/no score for Q/)
  })
  it('breaks a full tie by supplier id, and has no top without a bid', () => {
    const at = new Date('2026-11-04T07:00:00Z')
    const bid = (ref: string, supplierId: string) => ({ ref, net: 100n, submittedAt: at, supplierId, scores: {} })
    expect(rankBids(PRICE_ONLY, 100n, [bid('B', 's2'), bid('A', 's1'), bid('C', 's2')]).ranking).toEqual(['A', 'B', 'C'])
    expect(rankBids(PRICE_ONLY, 100n, [])).toEqual({ totals: [], ranking: [], topIsLowest: false })
  })
  it('ranks the lower amount before VAT first on an equal total, whichever order the bids come in', () => {
    const bid = (ref: string, net: bigint) => ({ ref, net, submittedAt: new Date(0), supplierId: ref, scores: {} })
    // 10000000 ÷ 10000001 → 9999.999 bp → 10000: both totals are 10000
    expect(rankBids(PRICE_ONLY, 10000000n, [bid('X', 10000000n), bid('Z', 10000001n)]).ranking).toEqual(['X', 'Z'])
    expect(rankBids(PRICE_ONLY, 10000000n, [bid('Z', 10000001n), bid('X', 10000000n)]).ranking).toEqual(['X', 'Z'])
  })
  it('writes a score with two decimals and refuses anything else', () => {
    expect(formatScore(9205)).toBe('92.05')
    expect(() => formatScore(-1)).toThrow(RangeError)
    expect(() => formatScore(1.5)).toThrow(RangeError)
  })
})

describe('timing (BR-RFX-02) edges', () => {
  it('takes the business day from the calendar and refuses an invalid one', () => {
    expect(businessDayMinutes({ ...cal, start: '09:00', end: '12:00' })).toBe(180)
    expect(() => businessDayMinutes({ ...cal, start: '9:00' })).toThrow(RangeError)
    expect(() => businessDayMinutes({ ...cal, start: '17:30', end: '08:30' })).toThrow(RangeError)
  })
  it('refuses days that are not a whole number ≥ 0', () => {
    expect(() => earliestCloseAt(new Date('2026-11-02T02:00:00Z'), -1, cal)).toThrow(RangeError)
    expect(() => earliestCloseAt(new Date('2026-11-02T02:00:00Z'), 1.5, cal)).toThrow(RangeError)
  })
})

describe('award amount and price checks (BR-RFX-11 to BR-RFX-13) edges', () => {
  it('refuses one supplier at two VAT rates', () => {
    expect(() =>
      awardAmount([
        { ref: 'L1', supplierId: 's', quantity: '1', unitPriceSatang: 100n, vatRateBp: 700 },
        { ref: 'L2', supplierId: 's', quantity: '1', unitPriceSatang: 100n, vatRateBp: 0 },
      ]),
    ).toThrow(RangeError)
  })
  it('refuses an invalid rate for the cap', () => {
    expect(() => confirmedNetPriceCap(-1, 100n, 90n)).toThrow(RangeError)
    expect(() => confirmedNetPriceCap(1.5, 100n, 90n)).toThrow(RangeError)
  })
  it('has no flag without a reference and refuses an invalid share or reference', () => {
    expect(priceAnomaly({ unitPriceSatang: 100n }, null, 2000)).toEqual({ deviationBp: null, flag: null })
    expect(() => priceAnomaly({ unitPriceSatang: 100n }, null, -1)).toThrow(RangeError)
    expect(() => priceAnomaly({ unitPriceSatang: 100n }, { unitPriceSatang: 0n, source: 'CATALOG' }, 2000)).toThrow(RangeError)
  })
  it('flags a bid with VAT through its line before VAT over the quantity, without rounding', () => {
    const ref = { unitPriceSatang: 10000n, source: 'CATALOG' } as const
    // 3 units for 360.01 before VAT: 120.0033… per unit, 2000.33 bp above 100.00 → HIGH; 360.00 is exactly 20 % → none
    expect(priceAnomaly({ lineNetSatang: 36001n, quantity: '3' }, ref, 2000)).toEqual({ deviationBp: 2000, flag: 'HIGH' })
    expect(priceAnomaly({ lineNetSatang: 36000n, quantity: '3' }, ref, 2000)).toEqual({ deviationBp: 2000, flag: null })
    expect(() => priceAnomaly({ lineNetSatang: 100n, quantity: '0' }, ref, 2000)).toThrow(RangeError)
  })
  it('flags LOW below the bidder’s own agreed price', () => {
    expect(priceAnomaly({ unitPriceSatang: 7000n }, { unitPriceSatang: 10000n, source: 'AGREEMENT' }, 2000)).toEqual({ deviationBp: -3000, flag: 'LOW' })
  })
})

describe('G-8 (BR-RFX-15) edges', () => {
  it('needs a source line, and has no share of a zero baseline', () => {
    expect(() => savings([], 0n, 700)).toThrow(RangeError)
    expect(savings([{ kind: 'ESTIMATE', netSatang: 0n }], 0n, 700).savingsBp).toBeNull()
    expect(savingsTotal([])).toEqual({ baselineNet: 0n, savings: 0n, savingsBp: null })
  })
  it('has no median without an award, and writes tenths of a day', () => {
    expect(cycleMedianDays([], cal)).toEqual({ days: [], median: null })
    expect(formatTenths(137)).toBe('13.7')
    expect(() => formatTenths(-1)).toThrow(RangeError)
    expect(() => formatTenths(0.5)).toThrow(RangeError)
  })
})
