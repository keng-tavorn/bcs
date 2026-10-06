import { createTranslator } from 'next-intl'
import { describe, expect, it } from 'vitest'
import { POOL_HREF, poolRow, type HomeT } from '@/app/(workspace)/_tracking/pool-row'
import type { PoolLineDto } from '@/server/services/procurement'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// §9.9 principle 1 ("งานของฉันก่อน") and §9.1 "/" (งานของฉัน): for procurement, the approved requests nobody has ordered
// yet are work waiting for them, so the home lists the pool beside the approval tasks instead of saying nothing waits.
// The row counts the requests and lines and says what the lines wait for, as the pool page counts them (poolCounts), and
// links to the pool. The home itself in a browser is demo scene 7 (tests/e2e/demo/07-consolidate-po.spec.ts).

const tTh = createTranslator({ locale: 'th', messages: th, namespace: 'home' }) as unknown as HomeT
const tEn = createTranslator({ locale: 'en', messages: en, namespace: 'home' }) as unknown as HomeT
const S1 = { id: 'sup-1', code: 'S1', nameTh: 'บริษัท วัสดุก่อสร้างทดสอบ จำกัด' }

function line(over: Partial<PoolLineDto> & Pick<PoolLineDto, 'requestLineId' | 'requestId'>): PoolLineDto {
  return {
    requestNo: `PR-2569-${over.requestId}`,
    requestTitle: 'ไม้อัดและตะปู',
    requesterName: 'สมชาย ใจดี',
    requesterNameEn: null,
    lineNo: 1,
    description: 'ไม้อัด 10 มม.',
    kind: 'GOODS',
    quantity: '20',
    uom: 'แผ่น',
    unitPriceSatang: 150_000n,
    amountSatang: 3_000_000n,
    priceIncludesVat: false,
    supplier: null,
    needsSupplier: true,
    draftBlock: null,
    suggestedSupplierId: null,
    deliverySite: { id: 'site-a', code: 'SITE-A', nameTh: 'ไซต์งานตัวอย่าง A' },
    urgency: 'NORMAL',
    approvedAt: '2026-10-06T03:00:00.000Z',
    ageDays: 0,
    ...over,
  }
}

describe('[FR-P2P-001/AC1] [FR-P2P-001/AC3] the home shows procurement the pool as work waiting for them', () => {
  it('an empty pool is no row, and the home says nothing waits', () => {
    expect(poolRow(tTh, [])).toBeNull()
  })

  it('the pool of the demo before a supplier is chosen: 4 requests, 5 lines, every one needing a supplier', () => {
    const lines = [line({ requestLineId: 'a', requestId: '00014' }), line({ requestLineId: 'b', requestId: '00016' }), line({ requestLineId: 'c', requestId: '00021' }), line({ requestLineId: 'd', requestId: '00021', lineNo: 2 }), line({ requestLineId: 'e', requestId: '00022' })]
    expect(poolRow(tTh, lines)).toEqual({
      id: 'procurement-pool',
      href: '/procurement/pool',
      title: 'คำขอรอจัดซื้อ 4 คำขอ (5 บรรทัด)',
      states: [{ kind: 'waiting', text: 'ต้องเลือกผู้ขาย 5 บรรทัด' }],
      tags: [],
    })
    expect(poolRow(tEn, lines)).toMatchObject({ title: 'Requests to purchase: 4 (5 lines)', states: [{ kind: 'waiting', text: '5 lines need a supplier' }] })
  })

  it('each kind of line says what it waits for: a supplier, the next round, or a decision on prices that include VAT', () => {
    const lines = [
      line({ requestLineId: 'a', requestId: 'r1' }),
      line({ requestLineId: 'b', requestId: 'r2', supplier: S1, needsSupplier: false }),
      line({ requestLineId: 'c', requestId: 'r2', lineNo: 2, supplier: S1, needsSupplier: false }),
      // A request whose prices include VAT is drafted by no round, with its supplier or without (NEW-50)
      line({ requestLineId: 'd', requestId: 'r3', priceIncludesVat: true, draftBlock: 'PRICE_INCLUDES_VAT' }),
    ]
    expect(poolRow(tTh, lines)).toMatchObject({
      href: POOL_HREF,
      title: 'คำขอรอจัดซื้อ 3 คำขอ (4 บรรทัด)',
      states: [
        { kind: 'waiting', text: 'ต้องเลือกผู้ขาย 1 บรรทัด' },
        { kind: 'draft', text: 'พร้อมรวมเป็นร่าง PO 2 บรรทัด' },
        { kind: 'closed', text: 'ราคารวม VAT ยังรวมเป็นร่าง PO ไม่ได้ 1 บรรทัด' },
      ],
    })
    expect(poolRow(tEn, lines)?.states.map((s) => s.text)).toEqual(['1 line needs a supplier', '2 lines are ready for a draft PO', '1 line has prices including VAT and cannot go on a draft PO yet'])
  })

  it('the pool’s list is named apart from the approval tasks, which keep their own name', () => {
    expect(th.home.pool.list).not.toBe(th.home.myTasks)
    expect(en.home.pool.list).not.toBe(en.home.myTasks)
  })
})
