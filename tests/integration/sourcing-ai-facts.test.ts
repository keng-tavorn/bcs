import { describe, expect, it } from 'vitest'
import { renderValue } from '@/core/ai-checks'
import { sourcingFacts } from '@/server/services/ai/agents/sourcing-facts'
import { bidSpread, type ComparisonFacts } from '@/server/services/sourcing'

// S10-16 (BR-AI-32 · FR-AI-305 AC2 AC3): the distances of the bids in bp of the lowest complete one, and the facts the
// Sourcing Agent writes about — scene 9: SP0023 300,950.00 (lowest) · SP0029 the incumbent 305,500.00 · SP0024 with VAT.

const bid = (supplierCode: string, supplier: string, net: string, extra: Partial<ComparisonFacts['bids'][number]> = {}): ComparisonFacts['bids'][number] => ({
  supplierCode,
  supplier,
  net,
  vat: '0.00',
  gross: net,
  partial: false,
  lowest: false,
  tags: [],
  risk: null,
  lines: [],
  ...extra,
})
const scene9: ComparisonFacts = {
  sealed: false,
  priceAnomalyBp: 2000,
  lines: [
    { lineNo: 1, quantity: '8', uom: 'ตัน' },
    { lineNo: 2, quantity: '5', uom: 'ตัน' },
  ],
  bids: [
    bid('SP0023', 'บริษัท ชลบุรีภัณฑ์สตีล จำกัด', '300950.00', { lowest: true }),
    bid('SP0029', 'บริษัท สหมิตรเหล็ก จำกัด', '305500.00', { tags: ['INCUMBENT'] }),
    bid('SP0024', 'ผู้ขายบุคคลธรรมดา SP0024', '303738.32', {
      tags: ['VAT_INCLUDED'],
      lines: [{ lineNo: 2, quotedUnitPrice: '25000.00', lineNet: '116822.43', referenceSource: 'AGREEMENT_OTHER', referenceUnitPrice: '22560.00', deviationBp: 3570, flag: 'HIGH' }],
    }),
    bid('SP0031', 'บริษัท ไม่ครบ จำกัด', '100000.00', { partial: true }),
  ],
}

describe('[FR-AI-305/AC3] [BR-AI-32] spreadBp and gapBp in bp of the lowest complete bid', () => {
  it('scene 9: (305,500 − 300,950) × 10000 ÷ 300,950 = 151.19 → 151 for both; a partial bid is neither lowest nor highest', () => {
    expect(bidSpread(scene9)).toEqual({ spreadBp: 151, incumbent: { supplierCode: 'SP0029', gapBp: 151 } })
  })
  it('no incumbent, or the incumbent is the lowest: no gap; no complete bid: nothing', () => {
    expect(bidSpread({ ...scene9, bids: scene9.bids.map((b) => ({ ...b, tags: b.tags.filter((t) => t !== 'INCUMBENT') })) }).incumbent).toBeNull()
    expect(bidSpread({ ...scene9, bids: [bid('A', 'a', '100.00', { tags: ['INCUMBENT'] }), bid('B', 'b', '110.00')] })).toEqual({ spreadBp: 1000, incumbent: null })
    expect(bidSpread({ ...scene9, bids: [bid('A', 'a', '100.00', { partial: true })] })).toEqual({ spreadBp: null, incumbent: null })
  })
})

describe('[FR-AI-305/AC2] [BR-AI-32] the facts of the bids: numbers, codes and names only', () => {
  it('counts, the lowest and highest, the incumbent\'s gap in money and bp, each flag with its reference — bp as integers', () => {
    const facts = sourcingFacts({ rfxEventId: 'x', number: 'RFX-2569-00003', status: 'CLOSED', table: scene9, ...bidSpread(scene9), scores: [{ supplierCode: 'SP0029', rank: 1, total: '91.20', criteria: { DELIVERY: '95.00' } }] })
    const shown = Object.fromEntries(Object.entries(facts).map(([k, v]) => [k, renderValue(v)]))
    expect(shown).toMatchObject({
      'rfx.number': 'RFX-2569-00003',
      bidCount: '4',
      partialCount: '1',
      vatInclusiveCount: '1',
      'lowest.supplierName': 'บริษัท ชลบุรีภัณฑ์สตีล จำกัด',
      'lowest.net': '300,950.00',
      'highest.supplierName': 'บริษัท สหมิตรเหล็ก จำกัด',
      'highest.net': '305,500.00',
      spreadBp: '151',
      'incumbent.supplierCode': 'SP0029',
      'incumbent.gap': '4,550.00',
      gapBp: '151',
      flagCount: '1',
      'flags.1.supplierName': 'ผู้ขายบุคคลธรรมดา SP0024',
      'flags.1.lineNo': '2',
      'flags.1.flag': 'HIGH',
      'flags.1.deviationBp': '3570',
      'flags.1.reference': '22,560.00',
      'score.1.supplierName': 'บริษัท สหมิตรเหล็ก จำกัด',
      'score.1.total': '91.20',
      'score.1.DELIVERY': '95.00',
    })
    expect(facts.spreadBp).toEqual({ kind: 'integer', value: 151 })
  })
})
