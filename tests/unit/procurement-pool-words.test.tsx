import { NextIntlClientProvider } from 'next-intl'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ConsolidatePanel, RoundResultList } from '@/ui/procurement/consolidate-panel'
import type { DraftView } from '@/ui/procurement/outcome'
import { PoolBoard, type PoolRequestView } from '@/ui/procurement/pool-board'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// The procurement pool against §9.9 (src/ui/procurement): the notice after choosing a supplier says it with the words of
// the button that did it (principle 7: "ส่งขออนุมัติ" → "ส่งขออนุมัติแล้ว"), in Thai and English; and what a round does
// and why some lines wait are sentences of body text — 16 px on phones, 15 px on the web — not 14 px captions.

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }))

const render = (node: ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="th" messages={th} timeZone="Asia/Bangkok">
      {node}
    </NextIntlClientProvider>,
  )

describe('[FR-P2P-001/AC2] the notice of a supplier choice says it with the button’s words (§9.9 principle 7)', () => {
  it('"ใช้ผู้ขายนี้…" is confirmed "ใช้ผู้ขาย … แล้ว", and "Use this supplier…" "… is now used…"', () => {
    const tha = th.procurement.pool.assign
    expect(tha.submit).toBe('ใช้ผู้ขายนี้กับบรรทัดที่เลือก')
    expect(tha.urgentConfirmButton).toBe('ยืนยันใช้ผู้ขายนี้และร่าง PO ทันที')
    expect(tha.done).toBe('ใช้ผู้ขาย {supplier} กับ {count} บรรทัดแล้ว')
    const eng = en.procurement.pool.assign
    expect(eng.submit).toBe('Use this supplier for the selected lines')
    expect(eng.done).toBe('{supplier} is now used for {count} lines')
    // Taking the supplier off already said it the same way
    expect(tha.clear.startsWith('เอาผู้ขายออกจาก')).toBe(true)
    expect(tha.cleared.startsWith('เอาผู้ขายออกจาก')).toBe(true)
  })
})

describe('[FR-P2P-002/AC3] a round’s explanation and the lines priced with VAT are body text, not captions (§9.9)', () => {
  it('nothing the round panel shows is drawn at the caption size', () => {
    const html = render(<ConsolidatePanel next="รอบอัตโนมัติถัดไป" ready={2} blocked={3} consolidate={async () => ({ ok: true })} />)
    expect(html).toContain(th.procurement.pool.round.hint)
    expect(html).toContain('3 บรรทัดในกองมาจากคำขอที่ราคารวม VAT')
    expect(html).not.toContain('text-sm')
  })

  it('nor anything of a round’s result: each draft’s lines, requests and amount at the body size', () => {
    const draft: DraftView = { id: 'po-1', supplierName: 'บริษัท วัสดุก่อสร้างทดสอบ จำกัด', siteName: 'ไซต์งานตัวอย่าง B', kind: 'GOODS', lineCount: 3, net: '54,000.00', requestNumbers: ['PR-2569-00016', 'PR-2569-00021'] }
    const html = render(<RoundResultList drafts={[draft]} />)
    expect(html.replace(/<[^>]+>/g, '')).toContain('3 บรรทัด · คำขอ PR-2569-00016, PR-2569-00021')
    expect(html).toContain('54,000.00')
    expect(html).toContain('href="/procurement/pos/po-1"')
    expect(html).not.toContain('text-sm')
  })

  it('the reason a request priced with VAT waits is drawn at the body size, under its request', () => {
    const request: PoolRequestView = {
      id: 'r-vat',
      title: 'PR-2569-00031 · ปูนซีเมนต์',
      number: 'PR-2569-00031',
      href: '/requests/r-vat',
      meta: ['ผู้ขอ สมชาย'],
      urgent: false,
      suggested: null,
      blocked: 'PRICE_INCLUDES_VAT',
      lines: [{ id: 'l-vat', no: 1, description: 'ปูน', kind: 'สินค้า', quantity: '3 ถุง', unitPrice: '100.00', amount: '300.00', includesVat: true, supplierName: null }],
    }
    const html = render(<PoolBoard requests={[request]} suppliers={[]} assign={async () => ({ ok: true })} />)
    const reason = th.procurement.pool.blocked.PRICE_INCLUDES_VAT
    const box = new RegExp(`<span class="([^"]*)"><svg[^>]*>.*?</svg><span class="break-words">${reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</span></span>`).exec(html)
    expect(box, 'the reason with its icon').not.toBeNull()
    expect(box![1]).toContain('text-warn')
    expect(box![1]).not.toMatch(/text-(sm|base)/)
  })
})
