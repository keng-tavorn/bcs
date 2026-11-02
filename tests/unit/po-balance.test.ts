import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { poBalance, poBalanceShares } from '@/core/matching/po-balance'

// NEW-115: the bar of what a PO has left on the page of a tier-2 invoice. It reads the invoices and decides nothing.

const amount = fc.bigInt({ min: 0n, max: 10n ** 13n })

describe('[FR-AP-102/AC8] what the PO has left', () => {
  it('takes the other invoices and this one off the PO', () => {
    expect(poBalance({ poNetSatang: 100_000n, otherInvoicedSatang: 30_000n, thisNetSatang: 20_000n, thisCounts: true }).remainingSatang).toBe(50_000n)
  })

  it('takes nothing off for a rejected or cancelled invoice', () => {
    expect(poBalance({ poNetSatang: 100_000n, otherInvoicedSatang: 30_000n, thisNetSatang: 20_000n, thisCounts: false }).remainingSatang).toBe(70_000n)
  })

  it('goes below zero when an approved variance took the invoices past the PO', () => {
    expect(poBalance({ poNetSatang: 100_000n, otherInvoicedSatang: 0n, thisNetSatang: 110_000n, thisCounts: true }).remainingSatang).toBe(-10_000n)
  })

  it('the parts always add up to the PO', () => {
    fc.assert(
      fc.property(amount, amount, amount, fc.boolean(), (po, other, own, counts) => {
        const b = poBalance({ poNetSatang: po, otherInvoicedSatang: other, thisNetSatang: own, thisCounts: counts })
        expect(b.remainingSatang + other + (counts ? own : 0n)).toBe(po)
      }),
    )
  })
})

describe('[FR-AP-102/AC8] how the bar is drawn', () => {
  it('fills by the PO, and by what was taken when that is more', () => {
    expect(poBalanceShares(poBalance({ poNetSatang: 100_000n, otherInvoicedSatang: 25_000n, thisNetSatang: 50_000n, thisCounts: true }))).toEqual({ otherBp: 2500, thisBp: 5000 })
    expect(poBalanceShares(poBalance({ poNetSatang: 100_000n, otherInvoicedSatang: 100_000n, thisNetSatang: 100_000n, thisCounts: true }))).toEqual({ otherBp: 5000, thisBp: 5000 })
  })

  it('draws nothing of an invoice that does not count, and nothing at all of an empty PO', () => {
    expect(poBalanceShares(poBalance({ poNetSatang: 100_000n, otherInvoicedSatang: 0n, thisNetSatang: 50_000n, thisCounts: false }))).toEqual({ otherBp: 0, thisBp: 0 })
    expect(poBalanceShares(poBalance({ poNetSatang: 0n, otherInvoicedSatang: 0n, thisNetSatang: 0n, thisCounts: true }))).toEqual({ otherBp: 0, thisBp: 0 })
  })

  it('shows a part above zero however small, and never runs past the bar', () => {
    expect(poBalanceShares(poBalance({ poNetSatang: 10n ** 12n, otherInvoicedSatang: 1n, thisNetSatang: 0n, thisCounts: true })).otherBp).toBe(1)
    fc.assert(
      fc.property(amount, amount, amount, fc.boolean(), (po, other, own, counts) => {
        const { otherBp, thisBp } = poBalanceShares(poBalance({ poNetSatang: po, otherInvoicedSatang: other, thisNetSatang: own, thisCounts: counts }))
        // a part below 1 bp is drawn at 1 bp, so two tiny parts may pass by those 2 at most
        expect(otherBp + thisBp).toBeLessThanOrEqual(10_002)
      }),
    )
  })
})
