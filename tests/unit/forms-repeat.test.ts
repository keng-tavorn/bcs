import { describe, expect, it } from 'vitest'
import { daysLeft, renewalMilestoneDue, reorderDraft } from '@/core/forms'

// BR-FORM-07 and BR-FORM-08 beyond the golden cases.

describe('[FR-INT-101/AC2] renewal milestones', () => {
  it('a day beyond every milestone is not due; the end day itself still is', () => {
    expect(renewalMilestoneDue(0, [60], [60, 30])).toBe(30)
    expect(renewalMilestoneDue(90, [], [60, 30])).toBeNull()
    expect(daysLeft(new Date('2026-12-10T17:00:00Z'), '2026-12-11')).toBe(0)
  })
})

describe('[FR-INT-101/AC1] reorder', () => {
  it('prices that include VAT keep the old price; another supplier keeps it too; a line without an item keeps it', () => {
    const line = { description: 'ปูน', categoryCode: 'MAT', quantity: '1', uom: 'ถุง', unitPriceSatang: 18_500n, catalogItemId: 'i1' }
    const agreements = [{ catalogItemId: 'i1', supplierId: 's1', unitPriceSatang: 17_700n }]
    const base = { currentFields: [], fields: {}, lines: [line], agreements }
    expect(reorderDraft({ ...base, supplierId: 's1', priceIncludesVat: true }).lines[0]).toMatchObject({ unitPriceSatang: 18_500n, priceSource: 'SOURCE_REQUEST' })
    expect(reorderDraft({ ...base, supplierId: 's2', priceIncludesVat: false }).lines[0]).toMatchObject({ unitPriceSatang: 18_500n, priceSource: 'SOURCE_REQUEST' })
    expect(reorderDraft({ ...base, lines: [{ ...line, catalogItemId: null }], supplierId: 's1', priceIncludesVat: false }).lines[0]!.priceSource).toBe('SOURCE_REQUEST')
  })
})
