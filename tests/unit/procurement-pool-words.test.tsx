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

describe('[FR-P2P-002/AC2] a round run by hand is kept under what was pressed, never the button’s "now" (§9.9 principle 7)', () => {
  it('"กดรวมเป็นร่าง PO โดย {name} {time}" in Thai, "Run by {name} {time}" in English', () => {
    const tha = th.procurement.pool.rounds
    const eng = en.procurement.pool.rounds
    expect(tha.MANUAL).toBe('กดรวมเป็นร่าง PO โดย {name} {time}')
    expect(tha.MANUAL_UNKNOWN).toBe('กดรวมเป็นร่าง PO {time}')
    expect(eng.MANUAL).toBe('Run by {name} {time}')
    expect(eng.MANUAL_UNKNOWN).toBe('Run by hand {time}')
    // A record of a round run weeks ago: the button's "ตอนนี้" / "now" is not the record's
    for (const words of [tha.MANUAL, tha.MANUAL_UNKNOWN]) expect(words).not.toContain('ตอนนี้')
    for (const words of [eng.MANUAL, eng.MANUAL_UNKNOWN]) expect(words.toLowerCase()).not.toMatch(/\bnow\b/)
    // It names what was pressed: the round's button, without its "now"
    expect(tha.MANUAL.startsWith(`กด${th.procurement.pool.round.submit.replace(' ตอนนี้', '')} `)).toBe(true)
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

  it('what procurement reads under a request and its lines before choosing a supplier is body text; only the column headings stay smaller on the web', () => {
    const request: PoolRequestView = {
      id: 'r-net',
      title: 'PR-2569-00014 · อุปกรณ์เครือข่ายไซต์งาน',
      number: 'PR-2569-00014',
      href: '/requests/r-net',
      meta: ['ผู้ขอ ไอยรา ระบบงาน', 'ส่งที่ ไซต์งานตัวอย่าง B', 'อนุมัติเมื่อ 24 ก.ย. 2569 · อนุมัติมาแล้ว 12 วัน'],
      urgent: true,
      suggested: 'บริษัท ไอทีทดสอบ จำกัด',
      blocked: null,
      lines: [
        { id: 'l-1', no: 1, description: 'อุปกรณ์เครือข่ายไซต์งาน', kind: 'สินค้า', quantity: '1 รายการ', unitPrice: '45,000.00', amount: '45,000.00', includesVat: false, supplierName: null },
        { id: 'l-2', no: 2, description: 'สายแลน', kind: 'บริการ', quantity: '10 ม้วน', unitPrice: '1,200.00', amount: '12,000.00', includesVat: false, supplierName: 'บริษัท ไอทีทดสอบ จำกัด' },
      ],
    }
    const html = render(<PoolBoard requests={[request]} suppliers={[]} assign={async () => ({ ok: true })} />)
    const pool = th.procurement.pool
    // Who asked, where it goes, since when it was approved, and the supplier the requester suggests
    for (const m of request.meta) expect(html).toContain(`<span class="text-ink-muted">${m}</span>`)
    expect(html).toContain(`<span class="text-ink">${pool.request.suggested.replace('{name}', 'บริษัท ไอทีทดสอบ จำกัด')}</span>`)
    // Each line's kind, and its supplier or that it needs one, each with its icon
    expect(html).toContain('<span class="text-ink-muted">สินค้า</span>')
    expect(html).toContain('<span class="text-ink-muted">บริการ</span>')
    expect(html).toMatch(new RegExp(`<span class="inline-flex items-start gap-1\\.5 font-medium text-warn"><svg[^>]*>(?:(?!</svg>)[\\s\\S])*</svg><span>${pool.line.needsSupplier}</span></span>`))
    const supplier = new RegExp(`<span class="inline-flex items-start gap-1\\.5 text-ink"><svg([^>]*)>(?:(?!</svg>)[\\s\\S])*</svg><span class="break-words">${pool.line.supplier.replace('{name}', 'บริษัท ไอทีทดสอบ จำกัด')}</span></span>`).exec(html)
    expect(supplier, 'the line’s supplier with its icon').not.toBeNull()
    // A supplier chosen for a line is not an approval: its store is --info, not --primary (§9.9 tokens)
    expect(supplier![1]).toContain('lucide-store')
    expect(supplier![1]).toContain('text-info')
    expect(supplier![1]).not.toContain('text-primary')
    // The urgent tag beside the title reads at the title's size: the urgency badge of §9.10, its icon and its word
    expect(html).toMatch(new RegExp(`<span data-slot="badge" data-variant="warn" class="[^"]* text-base" data-tone="warn"><svg[^>]*data-icon="Zap"[^>]*>(?:(?!</svg>)[\\s\\S])*</svg>${pool.urgency.URGENT}</span>`))
    // Nothing is smaller on the web but the column headings over the lines
    expect(html.match(/text-sm/g)).toHaveLength(1)
    expect(html).toMatch(/<div class="mt-2 hidden border-b border-line pb-2 text-sm text-ink-muted md:ml-8 md:grid /)
  })
})
