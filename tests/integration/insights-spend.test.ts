import { describe, expect, it } from 'vitest'
import { spendOfPo, type PricesOf } from '@/server/queries/insights'
import { itemKey } from '@/server/queries/purchase-orders'

// S16-08 · FR-VIS-007 AC3 with a department filter (no database: it sits with the integration tests because the query
// module it tests imports the tenant client): a PO's spending and its price alert come from its lines in the
// scope only (§11.5 การใช้จ่าย, FR-P2P-003 AC1). Written out by hand: one PO, a line of department A at last time's
// price and a line of department B 30 % above it, against a 10 % alert.

const A = 'dept-a'
const B = 'dept-b'
const APPROVED = new Date('2026-09-20T03:00:00Z')
const BEFORE = new Date('2026-08-01T03:00:00Z')
const ALERT_BP = 1000

const po = {
  poId: 'po-new',
  approvedAt: APPROVED,
  lines: [
    { departmentId: A, netSatang: 100_000n, unitPriceSatang: 10_000n, categoryCode: 'PAPER', description: 'กระดาษ A4' },
    { departmentId: B, netSatang: 260_000n, unitPriceSatang: 13_000n, categoryCode: 'TONER', description: 'หมึกพิมพ์' },
  ],
}
const prices: PricesOf = new Map([
  [itemKey('PAPER', 'กระดาษ A4'), [{ poId: 'po-old', at: BEFORE, price: 10_000n }]],
  [itemKey('TONER', 'หมึกพิมพ์'), [{ poId: 'po-old', at: BEFORE, price: 10_000n }]],
])

describe('[FR-VIS-007/AC3] spending and price alerts under a department filter', () => {
  it('the whole organization: both lines, and the toner line 30 % above its last price makes the PO an alert', () => {
    const { po: spent, byDepartment } = spendOfPo(po, null, prices, ALERT_BP)
    expect(spent).toEqual({ poId: 'po-new', approvedAt: APPROVED, netSatang: 360_000n, priceAlert: true })
    expect(byDepartment).toEqual(new Map([[A, 100_000n], [B, 260_000n]]))
  })

  it('department A: its paper line only, at last time’s price — no alert borrowed from department B’s toner', () => {
    const { po: spent, byDepartment } = spendOfPo(po, new Set([A]), prices, ALERT_BP)
    expect(spent).toEqual({ poId: 'po-new', approvedAt: APPROVED, netSatang: 100_000n, priceAlert: false })
    expect(byDepartment).toEqual(new Map([[A, 100_000n]]))
  })

  it('department B: its toner line and its alert', () => {
    expect(spendOfPo(po, new Set([B]), prices, ALERT_BP).po).toMatchObject({ netSatang: 260_000n, priceAlert: true })
  })

  it('a price approved after this PO, or on this PO itself, is not "the last time"', () => {
    const later: PricesOf = new Map([
      [itemKey('TONER', 'หมึกพิมพ์'), [{ poId: 'po-later', at: new Date('2026-09-25T03:00:00Z'), price: 10_000n }, { poId: 'po-new', at: APPROVED, price: 10_000n }]],
    ])
    expect(spendOfPo(po, null, later, ALERT_BP).po.priceAlert).toBe(false)
  })
})
