import { createTranslator } from 'next-intl'
import { describe, expect, it } from 'vitest'
import { day } from '@/app/(workspace)/_tracking/present'
import { poolCounts, requestsOf, type PoolT } from '@/app/(workspace)/procurement/pool/present'
import type { PoolLineDto } from '@/server/services/procurement'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// The pool page's presenter (spec FR-P2P-001, FR-P2P-002, NEW-50): what /procurement/pool hands to its board and its round
// panel, from the pool's read model. A request whose prices include VAT keeps its own prices — the amount is the service's
// quantity × unit price formatted, nothing converted to before VAT — and says why no round drafts it; the panel and the
// round's result count its lines apart from those that need a supplier and those a round drafts now. The board and the
// panel themselves are tests/unit/procurement-pool-vat.test.tsx; the page in a browser is tests/e2e/procurement.spec.ts.

const tTh = createTranslator({ locale: 'th', messages: th, namespace: 'procurement.pool' }) as unknown as PoolT
const tEn = createTranslator({ locale: 'en', messages: en, namespace: 'procurement.pool' }) as unknown as PoolT
const APPROVED = '2026-10-03T03:00:00.000Z'
const S1 = { id: 'sup-1', code: 'S1', nameTh: 'บริษัท วัสดุก่อสร้างทดสอบ จำกัด' }

function dto(over: Partial<PoolLineDto> & Pick<PoolLineDto, 'requestLineId' | 'requestId' | 'requestNo'>): PoolLineDto {
  return {
    requestTitle: 'ปูนซีเมนต์',
    requesterName: 'สมชาย ขอซื้อ',
    requesterNameEn: 'Somchai Kho-sue',
    lineNo: 1,
    description: 'ปูนซีเมนต์ 50 กก.',
    kind: 'GOODS',
    quantity: '3',
    uom: 'ถุง',
    unitPriceSatang: 10_000n,
    amountSatang: 30_000n,
    priceIncludesVat: false,
    supplier: null,
    needsSupplier: true,
    draftBlock: null,
    suggestedSupplierId: null,
    deliverySite: { id: 'site-a', code: 'SITE-A', nameTh: 'ไซต์งานตัวอย่าง A' },
    urgency: 'NORMAL',
    approvedAt: APPROVED,
    ageDays: 1,
    ...over,
  }
}

// 3 × 100.00 including VAT (approved at 300.00) and 1 × 1,234.56 including VAT, urgent, no supplier yet; then a request
// priced before VAT, 2.5 × 10.01 = 25.03 (BR-MONEY-02 (1)), with its supplier
const vatLines = [
  dto({ requestLineId: 'l-1', requestId: 'r-vat', requestNo: 'PR-2569-00031', urgency: 'URGENT', priceIncludesVat: true, draftBlock: 'PRICE_INCLUDES_VAT' }),
  dto({
    requestLineId: 'l-2',
    requestId: 'r-vat',
    requestNo: 'PR-2569-00031',
    lineNo: 2,
    description: 'ทรายหยาบ',
    quantity: '1',
    uom: 'คิว',
    unitPriceSatang: 123_456n,
    amountSatang: 123_456n,
    urgency: 'URGENT',
    priceIncludesVat: true,
    draftBlock: 'PRICE_INCLUDES_VAT',
  }),
]
const beforeVat = dto({
  requestLineId: 'l-3',
  requestId: 'r-net',
  requestNo: 'PR-2569-00032',
  requestTitle: 'ตะปู',
  description: 'ตะปูตอกไม้',
  quantity: '2.5',
  uom: 'กล่อง',
  unitPriceSatang: 1_001n,
  amountSatang: 2_503n,
  supplier: S1,
  needsSupplier: false,
  suggestedSupplierId: S1.id,
  deliverySite: null,
  ageDays: 0,
})
const supplierName = (id: string | null) => (id === S1.id ? S1.nameTh : null)

describe('[FR-P2P-001/AC1] [FR-P2P-001/AC3] [FR-PLT-002/AC3] the pool page lists each request with its lines at the prices it states', () => {
  it('a request priced with VAT: blocked for NEW-50, each line marked as including VAT, its amount the service’s own figure', () => {
    const [vat, net] = requestsOf(tTh, 'th', [...vatLines, beforeVat], supplierName)
    expect(vat).toEqual({
      id: 'r-vat',
      number: 'PR-2569-00031',
      title: 'PR-2569-00031 · ปูนซีเมนต์',
      href: '/requests/r-vat',
      meta: ['ผู้ขอ สมชาย ขอซื้อ', 'ส่งที่ ไซต์งานตัวอย่าง A', `อนุมัติเมื่อ ${day('th', APPROVED)} · อนุมัติมาแล้ว 1 วัน`],
      urgent: true,
      suggested: null,
      blocked: 'PRICE_INCLUDES_VAT',
      lines: [
        { id: 'l-1', no: 1, description: 'ปูนซีเมนต์ 50 กก.', kind: 'สินค้า', quantity: '3 ถุง', unitPrice: '100.00', amount: '300.00', includesVat: true, supplierName: null },
        { id: 'l-2', no: 2, description: 'ทรายหยาบ', kind: 'สินค้า', quantity: '1 คิว', unitPrice: '1,234.56', amount: '1,234.56', includesVat: true, supplierName: null },
      ],
    })
    // Priced before VAT: nothing blocks it, and it keeps the labels and figures it always had
    expect(net).toMatchObject({
      id: 'r-net',
      urgent: false,
      suggested: S1.nameTh,
      blocked: null,
      meta: ['ผู้ขอ สมชาย ขอซื้อ', 'ยังไม่ระบุสถานที่ส่ง', `อนุมัติเมื่อ ${day('th', APPROVED)} · อนุมัติวันนี้`],
      lines: [{ id: 'l-3', quantity: '2.5 กล่อง', unitPrice: '10.01', amount: '25.03', includesVat: false, supplierName: S1.nameTh }],
    })
  })

  it('keeps the pool’s order and the request’s lines together, in English with the English name', () => {
    const views = requestsOf(tEn, 'en', [vatLines[0]!, beforeVat, vatLines[1]!], supplierName)
    expect(views.map((v) => [v.id, v.lines.map((l) => l.id)])).toEqual([
      ['r-vat', ['l-1', 'l-2']],
      ['r-net', ['l-3']],
    ])
    expect(views[0]!.meta.slice(0, 2)).toEqual(['Requested by Somchai Kho-sue', 'Deliver to ไซต์งานตัวอย่าง A'])
    expect(views[0]!.lines[0]).toMatchObject({ kind: 'Goods', quantity: '3 ถุง', amount: '300.00', includesVat: true })
  })
})

describe('[FR-P2P-002/AC3] the round panel and the round’s result count the pool by what keeps each line from a draft', () => {
  it('a line priced with VAT counts as blocked with or without its supplier, never as ready or as needing a supplier', () => {
    const lines = [
      dto({ requestLineId: 'a', requestId: 'r1', requestNo: 'PR-1', supplier: S1, needsSupplier: false }),
      dto({ requestLineId: 'b', requestId: 'r1', requestNo: 'PR-1' }),
      dto({ requestLineId: 'c', requestId: 'r2', requestNo: 'PR-2' }),
      dto({ requestLineId: 'd', requestId: 'r3', requestNo: 'PR-3', priceIncludesVat: true, draftBlock: 'PRICE_INCLUDES_VAT', supplier: S1, needsSupplier: false }),
      dto({ requestLineId: 'e', requestId: 'r3', requestNo: 'PR-3', priceIncludesVat: true, draftBlock: 'PRICE_INCLUDES_VAT' }),
    ]
    expect(poolCounts(lines)).toEqual({ ready: 1, needSupplier: 2, blocked: 2 })
    expect(poolCounts([...vatLines, beforeVat])).toEqual({ ready: 1, needSupplier: 0, blocked: 2 })
    expect(poolCounts([])).toEqual({ ready: 0, needSupplier: 0, blocked: 0 })
  })
})
