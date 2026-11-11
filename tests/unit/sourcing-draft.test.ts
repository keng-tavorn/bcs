import { describe, expect, it } from 'vitest'
import { rfxDraftFromLines } from '@/core/sourcing'

// S10-16 (BR-AI-31 · GC-AI-99's rule): what code decides of a draft RFx — goods without a reference price, or with a price
// of zero, are asked for a proposal (RFP) and count nothing in the estimate.

const settings = { thresholdGrossSatang: 10_000_000n, minInvitesAboveThreshold: 3 }

describe('[FR-AI-305/AC1] [BR-AI-31] rfxDraftFromLines', () => {
  it('goods with no reference price: RFP, estimate 0, one invite', () => {
    expect(rfxDraftFromLines([{ ref: 'A', category: 'TOOL', isService: false, quantity: '2', refUnitPriceSatang: null }], 700, settings)).toEqual([
      { category: 'TOOL', kind: 'RFP', lines: ['A'], estimatedNetSatang: 0n, estimatedGrossSatang: 0n, minInvites: 1 },
    ])
  })
  it('goods with a reference of zero beside a priced one: RFP, only the priced one counts', () => {
    const [d] = rfxDraftFromLines(
      [
        { ref: 'A', category: 'TOOL', isService: false, quantity: '2', refUnitPriceSatang: 0n },
        { ref: 'B', category: 'TOOL', isService: false, quantity: '1', refUnitPriceSatang: 15_000_000n },
      ],
      700,
      settings,
    )
    expect(d).toMatchObject({ kind: 'RFP', estimatedNetSatang: 15_000_000n, estimatedGrossSatang: 16_050_000n, minInvites: 3 })
  })
  it('no lines: no draft', () => expect(rfxDraftFromLines([], 700, settings)).toEqual([]))
})
