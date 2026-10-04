import { NextIntlClientProvider } from 'next-intl'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ConsolidatePanel, roundHeading, roundLeftovers } from '@/ui/procurement/consolidate-panel'
import { blockedPicked, PoolBoard, urgentDraftedAtOnce, type PoolRequestView } from '@/ui/procurement/pool-board'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// NEW-50 on the pool screen (spec FR-P2P-001, FR-P2P-002, §9.9): a request whose prices include VAT is listed at the
// prices it states, each marked as including VAT, with why no round drafts it under its name — in words beside an icon,
// never colour alone (NFR-A11Y-03) — in Thai and in English (FR-PLT-002 AC2). While it is listed the amount column names
// no VAT basis and every line states its own. Choosing the supplier of such an urgent request does not ask "draft at
// once?", because nothing is drafted, and the notice of the choice says those lines wait. The round panel says how many
// lines wait for the decision, and a round's result never asks for a supplier when that would not help. The service side
// is tests/integration/procurement-pool-vat.test.ts; the page's presenter tests/unit/procurement-pool-present.test.ts.

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }))

const withVat: PoolRequestView = {
  id: 'r-vat',
  title: 'PR-2569-00031 · ปูนซีเมนต์',
  number: 'PR-2569-00031',
  href: '/requests/r-vat',
  meta: ['ผู้ขอ สมชาย'],
  urgent: true,
  suggested: null,
  blocked: 'PRICE_INCLUDES_VAT',
  lines: [{ id: 'l-vat', no: 1, description: 'ปูน', kind: 'สินค้า', quantity: '3 ถุง', unitPrice: '100.00', amount: '300.00', includesVat: true, supplierName: null }],
}
const beforeVat: PoolRequestView = {
  id: 'r-net',
  title: 'PR-2569-00032 · ตะปู',
  number: 'PR-2569-00032',
  href: '/requests/r-net',
  meta: ['ผู้ขอ สมหญิง'],
  urgent: true,
  suggested: null,
  blocked: null,
  lines: [{ id: 'l-net', no: 1, description: 'ตะปู', kind: 'สินค้า', quantity: '4 กล่อง', unitPrice: '25.00', amount: '100.00', includesVat: false, supplierName: null }],
}

const render = (messages: typeof th, node: ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={messages === th ? 'th' : 'en'} messages={messages} timeZone="Asia/Bangkok">
      {node}
    </NextIntlClientProvider>,
  )
const board = (messages: typeof th, requests: readonly PoolRequestView[] = [withVat, beforeVat]) =>
  render(messages, <PoolBoard requests={requests} suppliers={[]} assign={async () => ({ ok: true })} />)
const count = (html: string, text: string) => html.split(text).length - 1

describe('[FR-P2P-001/AC1] [FR-PLT-002/AC2] the pool says why a request priced with VAT is not drafted, at the prices it states', () => {
  it('in Thai: the reason once, under that request only, and every figure says its VAT basis while it is listed', () => {
    const html = board(th)
    const reason = th.procurement.pool.blocked.PRICE_INCLUDES_VAT
    expect(reason).toBe('ราคารวม VAT: คำขอนี้ยังรวมเป็นร่าง PO ไม่ได้ รอการตัดสินใจเรื่องการแปลงราคารวม VAT เป็นราคาในใบสั่งซื้อ')
    expect(count(html, reason)).toBe(1)
    // The reason sits with the request priced with VAT, before the one priced before VAT
    expect(html.indexOf(reason)).toBeGreaterThan(html.indexOf('PR-2569-00031'))
    expect(html.indexOf(reason)).toBeLessThan(html.indexOf('PR-2569-00032'))
    // The column heading over the amounts names no basis: one amount includes VAT, the other does not
    expect(count(html, '>ยอด<')).toBe(1)
    // Each line's labels (read on a phone and by screen readers) and the notes under its values on wide screens
    expect(count(html, '>ราคาต่อหน่วย (รวม VAT)<')).toBe(1)
    expect(count(html, '>ยอดรวม VAT<')).toBe(1)
    expect(count(html, '>รวม VAT<')).toBe(2)
    expect(count(html, '>ราคาต่อหน่วย (ก่อน VAT)<')).toBe(1)
    expect(count(html, '>ยอดก่อน VAT<')).toBe(1)
    expect(count(html, '>ก่อน VAT<')).toBe(2)
    expect(html).toContain('>300.00<')
  })

  it('in English, the same', () => {
    const html = board(en as unknown as typeof th)
    expect(count(html, en.procurement.pool.blocked.PRICE_INCLUDES_VAT)).toBe(1)
    expect(en.procurement.pool.blocked.PRICE_INCLUDES_VAT).toMatch(/^Prices include VAT: this request cannot go on a draft PO yet/)
    expect(count(html, '>Amount<')).toBe(1)
    expect(count(html, '>Unit price (incl. VAT)<')).toBe(1)
    expect(count(html, '>Total incl. VAT<')).toBe(1)
    expect(count(html, '>incl. VAT<')).toBe(2)
    expect(count(html, '>Unit price (before VAT)<')).toBe(1)
    expect(count(html, '>before VAT<')).toBe(2)
  })

  it('a pool with no request priced with VAT looks as it always did: the heading says before VAT, no line repeats it', () => {
    const html = board(th, [beforeVat])
    expect(count(html, '>ยอดก่อน VAT<')).toBe(2)
    expect(count(html, '>ราคาต่อหน่วย<')).toBe(2)
    for (const text of ['>ยอด<', '>ก่อน VAT<', '>รวม VAT<', 'ราคาต่อหน่วย (', th.procurement.pool.blocked.PRICE_INCLUDES_VAT]) expect(html).not.toContain(text)
  })
})

describe('[FR-P2P-002/AC1] choosing the supplier of an urgent request priced with VAT drafts nothing, so it is not asked about (BR-CONS-02)', () => {
  it('counts only the urgent requests priced before VAT among the ticked lines', () => {
    expect(urgentDraftedAtOnce([withVat, beforeVat], new Set(['l-vat']))).toBe(0)
    expect(urgentDraftedAtOnce([withVat, beforeVat], new Set(['l-vat', 'l-net']))).toBe(1)
    expect(urgentDraftedAtOnce([withVat, beforeVat], new Set())).toBe(0)
  })

  it('the notice of the choice counts the ticked lines that stay in the pool, in Thai and English', () => {
    expect(blockedPicked([withVat, beforeVat], new Set(['l-vat', 'l-net']))).toBe(1)
    expect(blockedPicked([withVat, beforeVat], new Set(['l-net']))).toBe(0)
    // A line no longer listed is not counted
    expect(blockedPicked([beforeVat], new Set(['l-vat']))).toBe(0)
    // Counted among the ticked lines, not among those whose supplier changed: all of them stay, changed or not
    expect(th.procurement.pool.assign.blocked).toBe('{count} บรรทัดที่เลือกมาจากคำขอที่ราคารวม VAT จึงยังรอในกองและยังไม่ถูกรวมเป็นร่าง PO')
    expect(en.procurement.pool.assign.blocked).toMatch(/^\{count\} of the ticked lines come from requests whose prices include VAT/)
  })
})

describe('[FR-P2P-002/AC3] [FR-PLT-002/AC2] the round says how many lines wait for the decision on prices that include VAT', () => {
  const panel = (messages: typeof th, blocked?: number) =>
    render(messages, <ConsolidatePanel next="รอบอัตโนมัติถัดไป" ready={2} {...(blocked === undefined ? {} : { blocked })} consolidate={async () => ({ ok: true })} />)

  it('names the number in Thai and English beside the round, and says nothing when no line waits', () => {
    expect(panel(th, 3)).toContain('3 บรรทัดในกองมาจากคำขอที่ราคารวม VAT จึงยังไม่ถูกรวมเป็นร่าง PO')
    expect(panel(en as unknown as typeof th, 3)).toContain('3 lines in the pool come from requests whose prices include VAT')
    for (const html of [panel(th, 0), panel(th)]) expect(html).not.toContain('บรรทัดในกองมาจากคำขอที่ราคารวม VAT')
  })

  it('the hint above the button no longer promises a draft at once to an urgent request priced with VAT', () => {
    expect(panel(th)).toContain('คำขอด่วนได้ร่าง PO ทันทีเมื่อเลือกผู้ขาย ส่วนคำขอที่ราคารวม VAT ยังไม่ถูกรวมเป็นร่าง PO แม้เป็นคำขอด่วน')
    expect(panel(en as unknown as typeof th)).toContain('Requests whose prices include VAT are not put on draft POs yet, urgent or not.')
  })

  it('a round that drafted nothing asks for a supplier only when some line waits for one', () => {
    // Only lines priced with VAT are left (one of them without a supplier): choosing suppliers would not help
    expect(roundHeading({ drafts: [], left: 0, waiting: 0, blocked: 5 })).toBe('madeNoneBlocked')
    // A line priced before VAT needs its supplier: the advice helps it
    expect(roundHeading({ drafts: [], left: 1, waiting: 0, blocked: 5 })).toBe('madeNone')
    expect(roundHeading({ drafts: [], left: 0, waiting: 0, blocked: 0 })).toBe('madeNone')
    expect(roundHeading({ drafts: [{ id: 'po', supplierName: 'S1', siteName: null, kind: 'GOODS', lineCount: 1, net: '10.00', requestNumbers: [] }], left: 0, blocked: 2 })).toBe('made')
    expect(th.procurement.pool.round.madeNoneBlocked).toBe('รอบนี้ไม่มีบรรทัดที่พร้อมรวม')
    expect(en.procurement.pool.round.madeNoneBlocked).toBe('No line was ready this round.')
  })

  it('tells the lines left by why: a supplier first, prices that include VAT, the next round; "none left" only when none is', () => {
    expect(roundLeftovers({ drafts: [], left: 2, waiting: 1, blocked: 3 })).toEqual([
      { key: 'left', count: 2 },
      { key: 'leftBlocked', count: 3 },
      { key: 'leftWaiting', count: 1 },
    ])
    expect(roundLeftovers({ drafts: [], left: 0, waiting: 0, blocked: 3 })).toEqual([{ key: 'leftBlocked', count: 3 }])
    expect(roundLeftovers({ drafts: [], left: 0, waiting: 0, blocked: 0 })).toEqual([{ key: 'leftNone', count: 0 }])
    expect(th.procurement.pool.round.leftBlocked).toBe('เหลือในกอง {count} บรรทัด เพราะมาจากคำขอที่ราคารวม VAT ซึ่งยังรวมเป็นร่าง PO ไม่ได้ รอการตัดสินใจเรื่องการแปลงราคารวม VAT เป็นราคาในใบสั่งซื้อ')
    expect(en.procurement.pool.round.leftBlocked).toMatch(/^\{count\} lines stay in the pool because their requests' prices include VAT/)
  })

  it('has the words of every new message in both languages', () => {
    for (const messages of [th, en]) {
      const pool = messages.procurement.pool
      for (const text of [
        pool.blocked.PRICE_INCLUDES_VAT,
        pool.line.unitPriceIncludingVat,
        pool.line.unitPriceBeforeVat,
        pool.line.amountIncludingVat,
        pool.line.amountColumn,
        pool.line.includingVat,
        pool.line.beforeVat,
        pool.assign.blocked,
        pool.round.madeNoneBlocked,
        pool.round.leftBlocked,
        pool.round.blockedInPool,
      ]) {
        expect(text).toEqual(expect.any(String))
        expect(text.length).toBeGreaterThan(0)
      }
      for (const text of [pool.assign.blocked, pool.round.leftBlocked, pool.round.blockedInPool]) expect(text).toContain('{count}')
    }
  })
})
