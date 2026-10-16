import { describe, expect, it } from 'vitest'
import { lineKey } from '@/core/duplicates'
import { cardBadge, priceReference, quoteRange } from '@/core/pricing'

// BR-PRC-01 to BR-PRC-04 and BR-DUP-01 beyond the golden cases: no samples, a LOW alert, a free item (median 0), a
// quotation range without a choice, and the line key of a catalogue item and of a typed line.

const AT = new Date('2026-10-06T03:00:00Z')
const SETTINGS = { windowDays: 365, minSamples: 3, alertBp: 1000 }
const at = (d: string) => new Date(d)
const s = (unitPriceSatang: bigint, approvedAt = '2026-09-01T03:00:00Z') => ({ unitPriceSatang, approvedAt: at(approvedAt), priceIncludesVat: false })

describe('[FR-DOA-101/AC1] the price reference', () => {
  it('without samples: nothing to compare, few samples', () => {
    expect(priceReference([], 100n, false, AT, SETTINGS)).toEqual({ count: 0, excludedVatIncluded: 0, min: null, median: null, max: null, last: null, status: 'FEW_SAMPLES', deviationBp: null, alert: null })
  })

  it('a price further below the median than the threshold is LOW; the latest sample is last whatever its price', () => {
    const r = priceReference([s(24_000n, '2026-08-01T03:00:00Z'), s(25_000n, '2026-09-20T03:00:00Z'), s(24_000n, '2026-09-01T03:00:00Z')], 21_000n, false, AT, SETTINGS)
    expect(r).toMatchObject({ median: 24_000n, last: 25_000n, deviationBp: -1250, alert: 'LOW', status: 'OK' })
  })

  it('a median of zero (free items) has no deviation', () => {
    expect(priceReference([s(0n), s(0n), s(0n)], 100n, false, AT, SETTINGS)).toMatchObject({ median: 0n, deviationBp: null, alert: null })
  })
})

describe('[FR-DOA-101/AC1] the quotation range', () => {
  it('without a choice, or with an unknown one, nothing is selected', () => {
    const quotes = [{ ref: 'A', amountSatang: 10_000n, includesVat: false }]
    expect(quoteRange(quotes, null, 700)).toEqual({ count: 1, lowest: 10_000n, highest: 10_000n, selected: null, selectedIsLowest: false })
    expect(quoteRange(quotes, 'Z', 700).selected).toBeNull()
    expect(quoteRange([], null, 700)).toEqual({ count: 0, lowest: null, highest: null, selected: null, selectedIsLowest: false })
  })
})

describe('[FR-INT-103/AC1] the line key (BR-DUP-01)', () => {
  it('a catalogue item is its own key; a typed line is its description in NFC, trimmed, collapsed and lower case, with its unit', () => {
    expect(lineKey({ catalogItemId: 'c1', description: 'x', uom: 'ถุง' })).toBe('item:c1')
    expect(lineKey({ description: '  Cement   50 KG ', uom: 'ถุง' })).toBe('cement 50 kg|ถุง')
    expect(lineKey({ catalogItemId: null, description: 'é', uom: 'ea' })).toBe('é|ea')
  })
})

describe('[FR-DOA-101/AC2] the one price badge of a LINE card (BR-PRC-05)', () => {
  it('counts the HIGH and LOW lines with the furthest deviation in whole percent; none without an alert', () => {
    expect(cardBadge([{ deviationBp: 833, alert: null }])).toBeNull()
    expect(cardBadge([{ deviationBp: 1250, alert: 'HIGH' }, { deviationBp: 1099, alert: 'HIGH' }, { deviationBp: null, alert: null }])).toEqual({ high: { lines: 2, maxPct: 12 }, low: null })
    expect(cardBadge([{ deviationBp: -1050, alert: 'LOW' }])).toEqual({ high: null, low: { lines: 1, minPct: -10 } })
    expect(cardBadge([{ deviationBp: -1599, alert: 'LOW' }, { deviationBp: 2000, alert: 'HIGH' }])).toEqual({ high: { lines: 1, maxPct: 20 }, low: { lines: 1, minPct: -15 } })
  })
})
