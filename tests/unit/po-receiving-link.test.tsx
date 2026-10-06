import { NextIntlClientProvider } from 'next-intl'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { PartRefusal, PoActions } from '@/ui/purchase-order/po-actions'
import { toPoFailure } from '@/ui/purchase-order/outcome'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// FR-P2P-010 AC2 on the purchase-order page (§9.9 rules 7 and 8): goods that will not come are settled on the PO's
// receiving page ("ปิดใบสั่งซื้อทั้งที่รับไม่ครบ"), which procurement's menu does not list (the receiving entry needs
// gr.post). Every text of the PO page that sends procurement there carries the way: the refusal of a cancel because goods
// came (GR_POSTED), the refusal of a close because some did not come (SHORT_NOT_APPROVED), and the sentence that says
// why closing waits. Other refusals keep their words alone. Static markup; the close-short itself runs in
// tests/e2e/receiving.spec.ts and tests/integration/receiving.test.ts.

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }))

const RECEIVING = { href: '/receiving/po-1', label: 'PO-2569-00007' }
const LINK_TH = 'เปิดหน้าตรวจรับของ PO-2569-00007'

const html = (node: ReactNode, messages: typeof th = th) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={messages === th ? 'th' : 'en'} messages={messages} timeZone="Asia/Bangkok">
      {node}
    </NextIntlClientProvider>,
  )

/** The receiving page's link in some markup, by its words (next/link writes the address last) */
const linkTo = (markup: string, words: string) => new RegExp(`<a [^>]*href="/receiving/po-1"[^>]*>${words}</a>`).test(markup)

const GR_POSTED = toPoFailure({ code: 'INVALID_STATE_TRANSITION', details: { from: 'SENT', command: 'po.cancel', reason: 'GR_POSTED' } })
const SHORT_NOT_APPROVED = toPoFailure({ code: 'INVALID_STATE_TRANSITION', details: { from: 'PARTIALLY_RECEIVED', command: 'po.close', reason: 'SHORT_NOT_APPROVED' } })
const STATE = toPoFailure({ code: 'INVALID_STATE_TRANSITION', details: { from: 'CLOSED', command: 'po.close' } })

const ACTIONS = { submit: async () => ({ ok: true as const }), send: async () => ({ ok: true as const }), cancel: async () => ({ ok: true as const }), close: async () => ({ ok: true as const }) }

describe('[FR-P2P-010/AC2] the PO page leads procurement to the receiving page wherever it names it', () => {
  it('a cancel refused because goods came: the refusal, then the way to the receiving page of the PO', () => {
    const notice = html(<PartRefusal part="cancel" failure={GR_POSTED} receiving={RECEIVING} />)
    expect(notice).toContain('role="alert"')
    expect(notice).toContain(th.purchaseOrder.errors.GR_POSTED)
    expect(linkTo(notice, LINK_TH)).toBe(true)
    expect(linkTo(html(<PartRefusal part="cancel" failure={GR_POSTED} receiving={RECEIVING} />, en), 'Open the receiving page of PO-2569-00007')).toBe(true)
  })

  it('a close refused because some goods did not come: the refusal, then the same way', () => {
    const notice = html(<PartRefusal part="close" failure={SHORT_NOT_APPROVED} receiving={RECEIVING} />)
    expect(notice).toContain(th.purchaseOrder.errors.SHORT_NOT_APPROVED)
    expect(linkTo(notice, LINK_TH)).toBe(true)
  })

  it('other refusals are words alone, and so are these before the PO went to its supplier (no receiving page yet)', () => {
    for (const [part, failure] of [
      ['cancel', STATE],
      ['close', STATE],
      // the receiving page fixes these two only on their own part
      ['close', GR_POSTED],
      ['cancel', SHORT_NOT_APPROVED],
    ] as const) {
      expect(html(<PartRefusal part={part} failure={failure} receiving={RECEIVING} />), `${part} ${failure.reason ?? failure.code}`).not.toContain('/receiving/')
    }
    expect(html(<PartRefusal part="cancel" failure={GR_POSTED} receiving={null} />)).not.toContain('<a ')
  })

  it('why closing waits: the sentence, then the way to the receiving page', () => {
    const page = html(<PoActions poId="po-1" label={RECEIVING.label} submit={null} send={null} resend={null} cancel={false} close={false} closeWaits={th.purchaseOrder.actions.close.needsShortfall} receivingHref={RECEIVING.href} actions={ACTIONS} />)
    expect(page).toContain(th.purchaseOrder.actions.close.needsShortfall)
    expect(linkTo(page, LINK_TH)).toBe(true)
    expect(page.indexOf(th.purchaseOrder.actions.close.needsShortfall)).toBeLessThan(page.indexOf(LINK_TH))
    // nothing to wait for: no sentence and no link
    const sent = html(<PoActions poId="po-1" label={RECEIVING.label} submit={null} send={null} resend={null} cancel={false} close={false} closeWaits={null} receivingHref={RECEIVING.href} actions={ACTIONS} />)
    expect(sent).not.toContain('/receiving/')
  })

  it('the words that send procurement there name the receiving page’s own part, in Thai and in English', () => {
    for (const text of [th.purchaseOrder.actions.close.needsShortfall, th.purchaseOrder.errors.SHORT_NOT_APPROVED, th.purchaseOrder.errors.GR_POSTED]) expect(text).toContain(th.receiving.closeShort.title)
    for (const text of [en.purchaseOrder.actions.close.needsShortfall, en.purchaseOrder.errors.SHORT_NOT_APPROVED, en.purchaseOrder.errors.GR_POSTED]) expect(text).toContain(en.receiving.closeShort.title.toLowerCase())
  })
})
