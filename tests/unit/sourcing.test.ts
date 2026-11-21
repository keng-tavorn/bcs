import { describe, expect, it } from 'vitest'
import type { BusinessCalendar } from '@/core/sla'
import { awardDecisionSodExtra, checkSod } from '@/core/sod'
import { OrgSettingsSchema, sourcingSettingsOf } from '@/lib/org-settings'
import {
  AWARD_REASON_CODES,
  awardAmount,
  awardTotals,
  businessDayMinutes,
  compareBids,
  confirmedNetPriceCap,
  criterionScoreBp,
  cycleMedianDays,
  earliestCloseAt,
  formatScore,
  formatTenths,
  netUnitPriceCeiling,
  orderReasonCodes,
  priceAnomaly,
  priceScoreBp,
  rankBids,
  riskCleared,
  savings,
  quotationShare,
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

describe('[BR-RFX-12] S10-10: the award from the amounts of the comparison, the price held for a bid with VAT, the reasons and the risk', () => {
  it('awardTotals takes the line amounts as given, VAT once per supplier, and refuses a negative line or two rates of one supplier', () => {
    // GC-SRC-23 from its line amounts: 185,200 → 12,964.00 and 117,500 → 8,225.00
    expect(
      awardTotals([
        { ref: 'L1', supplierId: 'a', lineNetSatang: 18_520_000n, vatRateBp: 700 },
        { ref: 'L2', supplierId: 'b', lineNetSatang: 11_750_000n, vatRateBp: 700 },
      ]),
    ).toMatchObject({ net: 30_270_000n, vat: 2_118_900n, gross: 32_388_900n, isSplit: true })
    // a bid with VAT shared over two lines (303,738.32): VAT of the supplier's total, not of each line
    expect(awardTotals([{ ref: 'L1', supplierId: 'c', lineNetSatang: 18_691_589n, vatRateBp: 700 }, { ref: 'L2', supplierId: 'c', lineNetSatang: 11_682_243n, vatRateBp: 700 }])).toMatchObject({ net: 30_373_832n, vat: 2_126_168n, isSplit: false })
    expect(() => awardTotals([{ ref: 'L1', supplierId: 'a', lineNetSatang: -1n, vatRateBp: 700 }])).toThrow(RangeError)
    expect(() => awardTotals([{ ref: 'L1', supplierId: 'a', lineNetSatang: 1n, vatRateBp: 700 }, { ref: 'L2', supplierId: 'a', lineNetSatang: 1n, vatRateBp: 0 }])).toThrow(RangeError)
    expect(awardTotals([])).toMatchObject({ net: 0n, vat: 0n, gross: 0n, isSplit: false })
  })
  it('netUnitPriceCeiling is the highest price before VAT a winner may confirm (GC-SRC-41) and refuses an invalid rate or price', () => {
    expect(netUnitPriceCeiling(700, 2_500_000n)).toBe(2_336_448n)
    expect(confirmedNetPriceCap(700, 2_500_000n, netUnitPriceCeiling(700, 2_500_000n))).toBe(true)
    expect(confirmedNetPriceCap(700, 2_500_000n, netUnitPriceCeiling(700, 2_500_000n) + 1n)).toBe(false)
    expect(netUnitPriceCeiling(0, 100n)).toBe(100n)
    expect(() => netUnitPriceCeiling(-1, 100n)).toThrow(RangeError)
    expect(() => netUnitPriceCeiling(1.5, 100n)).toThrow(RangeError)
    expect(() => netUnitPriceCeiling(700, -1n)).toThrow(RangeError)
  })
  it('orderReasonCodes keeps the fixed order of AWARD_REASON_CODES, each once', () => {
    expect(orderReasonCodes(['RISK_NOT_CLEARED', 'SPLIT', 'NOT_TOP_SCORE', 'SPLIT'])).toEqual(['NOT_TOP_SCORE', 'SPLIT', 'RISK_NOT_CLEARED'])
    expect(orderReasonCodes([])).toEqual([])
    expect(AWARD_REASON_CODES).toHaveLength(8)
  })
  it('riskCleared: below HIGH always; HIGH when CURRENT, EXPIRING or overridden; not when overdue, to reassess, or of no status', () => {
    expect(riskCleared({ tier: 'LOW' })).toBe(true)
    expect(riskCleared({ tier: null })).toBe(true)
    expect(riskCleared({ tier: 'HIGH', status: 'CURRENT' })).toBe(true)
    expect(riskCleared({ tier: 'HIGH', status: 'EXPIRING' })).toBe(true)
    expect(riskCleared({ tier: 'HIGH', status: 'OVERDUE', openOverrideId: 'o-1' })).toBe(true)
    expect(riskCleared({ tier: 'HIGH', status: 'OVERDUE', openOverrideId: null })).toBe(false)
    expect(riskCleared({ tier: 'HIGH', status: 'REASSESS_REQUIRED' })).toBe(false)
    expect(riskCleared({ tier: 'HIGH' })).toBe(false)
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

describe('[BR-SOD-14] an evaluator never created the RFx nor requested a source line', () => {
  const policy = { approverMayReceive: false, requesterMayReceive: true }
  const action = (actorMemberId: string) => ({ kind: 'SCORE_RFX' as const, actorMemberId, rfxCreatorMemberIds: ['creator', 'opener'], sourceRequesterMemberIds: ['req-1', 'req-2'] })
  it('the creator or the opener → SOD_VIOLATION BR-SOD-14', () => {
    expect(checkSod(action('creator'), policy)).toEqual({ ok: false, error: 'SOD_VIOLATION', rule: 'BR-SOD-14' })
    expect(checkSod(action('opener'), policy)).toEqual({ ok: false, error: 'SOD_VIOLATION', rule: 'BR-SOD-14' })
  })
  it('a requester of a source line → SOD_VIOLATION BR-SOD-14; anyone else may score', () => {
    expect(checkSod(action('req-2'), policy)).toEqual({ ok: false, error: 'SOD_VIOLATION', rule: 'BR-SOD-14' })
    expect(checkSod(action('evaluator'), policy)).toEqual({ ok: true })
  })
})

describe('[BR-SOD-13] the people of an award besides its submitter', () => {
  it('one BR-SOD-13 list of the creators, evaluators (recused too), source requesters and on-behalf recorders, each once', () => {
    expect(
      awardDecisionSodExtra({
        rfxCreatorMemberIds: ['creator', 'creator'],
        evaluatorMemberIds: ['eval-1', 'eval-recused'],
        sourceRequesterMemberIds: ['req-1', 'eval-1'],
        recordedOnBehalfMemberIds: ['creator', 'recorder'],
      }),
    ).toEqual([{ rule: 'BR-SOD-13', memberIds: ['creator', 'eval-1', 'eval-recused', 'req-1', 'recorder'] }])
  })
  it('an RFx from a need has no source requester and no bid recorded on behalf: the list is the creators and evaluators', () => {
    expect(awardDecisionSodExtra({ rfxCreatorMemberIds: ['creator'], evaluatorMemberIds: [], sourceRequesterMemberIds: [], recordedOnBehalfMemberIds: [] })).toEqual([{ rule: 'BR-SOD-13', memberIds: ['creator'] }])
  })
})

describe('[FR-PLT-001/AC2] the sourcing settings of S10: every key optional, missing reads as its OQ default', () => {
  it('an organization saved before S10 parses as it is and reads the defaults', () => {
    expect(OrgSettingsSchema.shape.sourcing.safeParse(undefined).success).toBe(true)
    expect(sourcingSettingsOf({})).toEqual({
      minOpenBusinessDays: { RFQ: 3, RFP: 10, RFI: 5 },
      questionCutoffBusinessDays: 2,
      bidValidityDays: 30,
      sealedBids: true,
      allowVatInclusiveBids: false,
      minInvitesThresholdGross: '100000.00',
      minInvitesAboveThreshold: 3,
      minEvaluators: 2,
      priceAnomalyBp: 2000,
      preferredSupplierDays: 365,
      agreementFromAwardDays: 365,
      aiAssist: true,
      defaultWeightsBp: { RFQ: { PRICE: 7000, DELIVERY: 2000, QUALITY: 1000 }, RFP: { PRICE: 4000, TECHNICAL: 4000, SUPPORT: 2000 } },
    })
  })
  it('a set key wins, the days of the other kinds and the weights of the other kind keep their defaults', () => {
    const s = sourcingSettingsOf({ sourcing: { minOpenBusinessDays: { RFP: 7 }, sealedBids: false, defaultWeightsBp: { RFQ: { PRICE: 10000 } } } })
    expect(s.minOpenBusinessDays).toEqual({ RFQ: 3, RFP: 7, RFI: 5 })
    expect(s.sealedBids).toBe(false)
    expect(s.defaultWeightsBp).toEqual({ RFQ: { PRICE: 10000 }, RFP: { PRICE: 4000, TECHNICAL: 4000, SUPPORT: 2000 } })
  })
  it('refuses weights that do not add up to 10000, weights without PRICE, an unknown key and a money amount that is not baht', () => {
    const parse = (sourcing: unknown) => OrgSettingsSchema.shape.sourcing.safeParse(sourcing).success
    expect(parse({ defaultWeightsBp: { RFQ: { PRICE: 7000, QUALITY: 2000 } } })).toBe(false)
    expect(parse({ defaultWeightsBp: { RFP: { TECHNICAL: 10000 } } })).toBe(false)
    expect(parse({ quoteThresholdGross: '100000.00' })).toBe(false)
    expect(parse({ minInvitesThresholdGross: '100000' })).toBe(false)
    expect(parse({ minInvitesThresholdGross: '250000.00', priceAnomalyBp: 1500, minEvaluators: 3 })).toBe(true)
    // a malformed block reads as the defaults rather than failing the page that reads it
    expect(sourcingSettingsOf({ sourcing: { minEvaluators: 0 } }).minEvaluators).toBe(2)
  })
})

describe('[BR-SOD-13] who may not approve an award, at decide time (checkSod DECIDE_APPROVAL of AWARD_DECISION)', () => {
  const policy = { approverMayReceive: false, requesterMayReceive: true }
  const people = { rfxCreatorMemberIds: ['creator'], evaluatorMemberIds: ['eval', 'recused'], sourceRequesterMemberIds: ['req'], recordedOnBehalfMemberIds: ['recorder'] }
  const decide = (actorMemberId: string, keys: Partial<typeof people> = people) => checkSod({ kind: 'DECIDE_APPROVAL', subject: 'AWARD_DECISION', actorMemberId, requesterMemberIds: ['submitter'], ...keys }, policy)
  it('the submitter → BR-SOD-01 first, even when also in the lists', () => {
    expect(decide('submitter')).toEqual({ ok: false, error: 'SOD_VIOLATION', rule: 'BR-SOD-01' })
    expect(decide('submitter', { ...people, evaluatorMemberIds: ['submitter'] })).toEqual({ ok: false, error: 'SOD_VIOLATION', rule: 'BR-SOD-01' })
  })
  it('the creator, an evaluator (recused too), a requester of a source line or the on-behalf recorder → BR-SOD-13', () => {
    for (const who of ['creator', 'eval', 'recused', 'req', 'recorder']) expect(decide(who), who).toEqual({ ok: false, error: 'SOD_VIOLATION', rule: 'BR-SOD-13' })
  })
  it('anyone else may approve; without the lists only the submitter is refused', () => {
    expect(decide('manager')).toEqual({ ok: true })
    expect(decide('creator', {})).toEqual({ ok: true })
  })
})


describe('[FR-SRC-204/AC8] G-8 baseline from a selected quotation (BR-RFX-15 · BR-FORM-06)', () => {
  it('a one-line request brings its whole quotation; part of the quantity brings its part, half up', () => {
    expect(quotationShare(12_000_000n, [11_900_000n], 0, '5', '5')).toBe(12_000_000n)
    expect(quotationShare(12_000_000n, [11_900_000n], 0, '2', '3')).toBe(8_000_000n)
    expect(quotationShare(10_000_001n, [1n], 0, '1', '2')).toBe(5_000_001n)
  })
  it('a quotation of several lines is shared by their amounts, largest remainder, and adds up exactly', () => {
    const lines = [100n, 100n, 100n]
    const parts = lines.map((_, i) => quotationShare(1_000n, lines, i, '1', '1'))
    expect(parts).toEqual([334n, 333n, 333n])
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(1_000n)
    expect(quotationShare(9_000n, [20_000n, 10_000n], 1, '1', '1')).toBe(3_000n)
  })
  it('lines of no amount share it evenly; a line the request does not have is refused', () => {
    expect(quotationShare(1_000n, [0n, 0n], 0, '1', '1')).toBe(500n)
    // a line of no amount beside one with an amount takes none; a line of no quantity keeps its whole share
    expect(quotationShare(1_000n, [100n, 0n], 1, '1', '1')).toBe(0n)
    expect(quotationShare(1_000n, [100n, 0n], 0, '1', '0')).toBe(1_000n)
    expect(() => quotationShare(1_000n, [100n], 1, '1', '1')).toThrow(RangeError)
  })
})
