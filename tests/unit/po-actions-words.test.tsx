import { NextIntlClientProvider } from 'next-intl'
import { getTranslations } from 'next-intl/server'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PoRequests } from '@/app/(workspace)/procurement/pos/_parts/po-body'
import type { PoViewDto } from '@/server/queries/purchase-orders'
import { PO_NO_ANSWER, poActionErrorKey, toPoFailure, type PoAction } from '@/ui/purchase-order/outcome'
import { PoActions, SendConfirm, usePoFailureText, type SubmitPreviewView } from '@/ui/purchase-order/po-actions'
import { PoStatus, RejectedNotice } from '@/ui/purchase-order/status'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// The purchase-order page against §9.9 (D-05, src/ui/purchase-order): what each part says while its action runs, when no
// answer came back, and when the role changed meanwhile; the notice of a rejected PO in the token of "ไม่อนุมัติ"; and the
// sentences read before pressing — what a part does, who asked for a source request and whether it has files — at the
// body's size, never a 14 px caption. The hook every action runs through (src/ui/procurement/use-outcome-action.ts) is
// set by each test: whether its action is on its way and what came back; the presses themselves run in the browser
// (tests/e2e/purchase-order.spec.ts).

const hook = vi.hoisted(() => ({ pending: false, outcome: null as unknown }))
vi.mock('@/ui/procurement/use-outcome-action', () => ({
  useOutcomeAction: () => ({ pending: hook.pending, outcome: hook.outcome, run: async () => hook.outcome, clear: () => undefined }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }))
vi.mock('next-intl/server', async () => {
  const intl = await import('next-intl')
  const messages = (await import('../../messages/th.json')).default as Record<string, unknown>
  const translator = (namespace?: string) => intl.createTranslator({ locale: 'th', messages, ...(namespace ? { namespace } : {}) } as Parameters<typeof intl.createTranslator>[0])
  return { getLocale: async () => 'th', getTranslations: async (options?: string | { namespace?: string }) => translator(typeof options === 'string' ? options : options?.namespace) }
})

afterEach(() => {
  hook.pending = false
  hook.outcome = null
})

const render = (node: ReactNode, messages: typeof th = th) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={messages === th ? 'th' : 'en'} messages={messages} timeZone="Asia/Bangkok">
      {node}
    </NextIntlClientProvider>,
  )
const literally = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** A button with these words, shut */
const shutButton = (words: string) => new RegExp(`<button type="(button|submit)"[^>]*disabled=""[^>]*>${literally(words)}</button>`)

const ACTIONS = { submit: async () => ({ ok: true as const }), send: async () => ({ ok: true as const }), cancel: async () => ({ ok: true as const }), close: async () => ({ ok: true as const }) }
const PREVIEW: SubmitPreviewView = { route: null, blocked: null, budget: th.purchaseOrder.actions.submit.noExtra }
const page = (parts: { submit?: boolean; send?: boolean; resend?: boolean; cancel?: boolean; close?: boolean; closeWaits?: string }, messages: typeof th = th) =>
  render(
    <PoActions
      poId="po-1"
      label="PO-2569-00007"
      submit={parts.submit ? PREVIEW : null}
      send={parts.send ? { email: 'sales@supplier.demo.local' } : null}
      resend={parts.resend ? { email: 'sales@supplier.demo.local' } : null}
      cancel={parts.cancel ?? false}
      close={parts.close ?? false}
      closeWaits={parts.closeWaits ?? null}
      actions={ACTIONS}
    />,
    messages,
  )

const actions = { th: th.purchaseOrder.actions, en: en.purchaseOrder.actions }
const errors = { th: th.purchaseOrder.errors, en: en.purchaseOrder.errors }
const LOCALES = [
  ['th', th],
  ['en', en],
] as const

describe('[FR-P2P-004/AC1] [FR-P2P-005/AC1] [FR-P2P-010/AC1] while its action runs, each button says what it is doing in its own words (§9.9 principle 7)', () => {
  it('sending for approval, cancelling and closing each say their own "กำลัง…", never "กำลังบันทึก"', () => {
    hook.pending = true
    const html = page({ submit: true, cancel: true, close: true })
    expect(actions.th.submit.working).toBe('กำลังส่งขออนุมัติ')
    expect(actions.th.cancel.working).toBe('กำลังยกเลิก PO')
    expect(actions.th.close.working).toBe('กำลังปิด PO')
    for (const words of [actions.th.submit.working, actions.th.cancel.working, actions.th.close.working]) expect(html, words).toMatch(shutButton(words))
    expect(html).not.toContain(actions.th.working)
    const english = page({ submit: true, cancel: true, close: true }, en as unknown as typeof th)
    for (const words of ['Sending for approval', 'Cancelling the PO', 'Closing the PO']) expect(english, words).toMatch(shutButton(words))
  })

  it('the second press of a sending says it is sending the PO, or sending it again', () => {
    const confirm = (again: boolean, pending: boolean, messages: typeof th = th) =>
      render(<SendConfirm id="c" text="ส่ง PO-2569-00007 ทางอีเมล" again={again} pending={pending} onConfirm={() => undefined} onBack={() => undefined} />, messages)
    expect(confirm(false, false)).toMatch(/<button type="button"[^>]*>ยืนยันส่ง PO<\/button>/)
    expect(confirm(false, true)).toMatch(shutButton('กำลังส่ง PO'))
    expect(confirm(true, true)).toMatch(shutButton('กำลังส่ง PO อีกครั้ง'))
    // Not sending yet waits shut too, under its own words
    expect(confirm(true, true)).toMatch(shutButton(actions.th.send.back))
    expect(confirm(false, true, en as unknown as typeof th)).toMatch(shutButton('Sending the PO'))
    expect(confirm(true, true, en as unknown as typeof th)).toMatch(shutButton('Sending the PO again'))
  })
})

describe('an action that got no answer says it is not certain it was done, in its own words, and to press its button again (§9.9 principle 7)', () => {
  const ALL: readonly PoAction[] = ['submit', 'send', 'resend', 'cancel', 'close', 'saveLine', 'removeLine', 'saveTerms']

  it('every part of the page says its own words, never "not saved"', () => {
    hook.outcome = PO_NO_ANSWER
    const html = page({ submit: true, send: true, resend: true, cancel: true, close: true })
    for (const key of ['NO_ANSWER_SUBMIT', 'NO_ANSWER_SEND', 'NO_ANSWER_RESEND', 'NO_ANSWER_CANCEL', 'NO_ANSWER_CLOSE'] as const) expect(html, key).toContain(errors.th[key])
    expect(html).not.toContain(errors.th.FAILED)
    // The way to the receiving page belongs to the refusals it fixes, not to an unanswered cancel or close
    expect(html).not.toContain('/receiving/')
  })

  it('names the button to press again, in Thai and in English, and never says the action failed', () => {
    for (const [locale, messages] of LOCALES) {
      const a = messages.purchaseOrder.actions
      const e = messages.purchaseOrder.errors
      const named = [
        [e.NO_ANSWER_SUBMIT, a.submit.button],
        [e.NO_ANSWER_SEND, a.send.confirm],
        [e.NO_ANSWER_RESEND, a.send.confirm],
        [e.NO_ANSWER_CANCEL, a.cancel.button],
        [e.NO_ANSWER_CLOSE, a.close.button],
        [e.NO_ANSWER_LINE, a.edit.saveLine],
        [e.NO_ANSWER_REMOVE, a.edit.removeLine],
        [e.NO_ANSWER_TERMS, a.edit.saveTerms],
      ] as const
      for (const [words, button] of named) {
        expect(words, `${locale}: ${words}`).toContain(`“${button}”`)
        expect(words, locale).toMatch(locale === 'th' ? /^ไม่ได้รับคำตอบจากระบบ จึงไม่แน่ใจว่า.+ตรวจการเชื่อมต่อแล้วกด/ : /^No answer came back, so it is not certain .+Check your connection and press/)
        expect(words, locale).not.toMatch(/ไม่สำเร็จ|Not saved/)
      }
    }
    // An e-mail may have gone out: said, so nobody sends it again by other means
    expect(errors.th.NO_ANSWER_SEND).toContain('อีเมลอาจออกไปแล้ว')
    expect(errors.en.NO_ANSWER_SEND).toContain('the e-mail may have gone out')
  })

  it('a line of the draft is named by its number', () => {
    const Probe = ({ action, no }: { action: PoAction; no: number }) => <p>{usePoFailureText()(PO_NO_ANSWER, action, no)}</p>
    expect(render(<Probe action="saveLine" no={2} />)).toContain('ไม่ได้รับคำตอบจากระบบ จึงไม่แน่ใจว่าบันทึกบรรทัด 2 แล้วหรือยัง ตรวจการเชื่อมต่อแล้วกด “บันทึกบรรทัด 2” อีกครั้งโดยไม่แก้อะไร ระบบไม่บันทึกซ้ำ')
    expect(render(<Probe action="removeLine" no={3} />)).toContain('“เอาบรรทัด 3 ออก”')
  })

  it('maps no answer to the words of each action, and every answer as before', () => {
    for (const action of ALL) expect(poActionErrorKey(PO_NO_ANSWER, action), action).toMatch(/^NO_ANSWER_/)
    expect(new Set(ALL.map((action) => poActionErrorKey(PO_NO_ANSWER, action))).size).toBe(ALL.length)
    // A lack of budget at cancelling keeps the cancellation's words; other refusals are the page's
    expect(poActionErrorKey(toPoFailure({ code: 'BUDGET_INSUFFICIENT' }), 'cancel')).toBe('CANCEL_BUDGET_INSUFFICIENT')
    expect(poActionErrorKey(toPoFailure({ code: 'BUDGET_INSUFFICIENT' }), 'submit')).toBe('BUDGET_INSUFFICIENT')
    expect(poActionErrorKey(toPoFailure({ code: 'FORBIDDEN' }), 'send')).toBe('FORBIDDEN')
    // A code the screen does not know is an answer: nothing was saved, and it says so
    expect(poActionErrorKey(toPoFailure({ code: 'MODULE_DISABLED' }), 'close')).toBe('FAILED')
  })
})

describe('a refusal because the role changed meanwhile says what to do (§9.9 principle 7)', () => {
  it('FORBIDDEN: the rights may have just changed, reload the page, and ask the organization admin to check the roles — as the pool says it', () => {
    const tail = 'สิทธิ์อาจเพิ่งถูกเปลี่ยน โหลดหน้านี้ใหม่เพื่อดูสิทธิ์ล่าสุด ถ้ายังต้องทำงานนี้ ติดต่อผู้ดูแลองค์กรให้ตรวจบทบาทของบัญชี'
    expect(errors.th.FORBIDDEN).toBe(`ทำรายการนี้กับใบสั่งซื้อไม่ได้ เพราะบัญชีนี้ไม่มีสิทธิ์ของฝ่ายจัดซื้อแล้ว ${tail}`)
    expect(th.procurement.pool.errors.FORBIDDEN.endsWith(tail)).toBe(true)
    expect(errors.th.FORBIDDEN).toContain(th.admin.roles.ORG_ADMIN)
    const english = "Reload the page to see them, and if you still need to do this, ask your organization admin to check the account's roles."
    expect(errors.en.FORBIDDEN).toBe(`This account can no longer do this to a purchase order; its procurement rights may have just changed. ${english}`)
    expect(en.procurement.pool.errors.FORBIDDEN.endsWith(english)).toBe(true)
  })
})

describe('a rejected PO is said in the token of "ไม่อนุมัติ": --danger with a cross (§9.9 token table)', () => {
  it('the notice uses the icon and the colour of the rejected status, and is read out politely', () => {
    const notice = render(<RejectedNotice>{th.purchaseOrder.detail.rejectedState}</RejectedNotice>)
    expect(notice).toContain('role="status"')
    expect(notice).not.toContain('role="alert"')
    expect(notice.match(/^<div role="status" class="([^"]*)"/)?.[1]!.split(' ')).toContain('border-danger')
    expect(notice).not.toMatch(/warn/)
    const icon = (html: string) => html.match(/<svg[^>]*class="([^"]*)"/)?.[1]!.split(' ') ?? []
    expect(icon(notice)).toEqual(expect.arrayContaining(['lucide-circle-x', 'text-danger']))
    // The same icon and colour as the status above it
    const status = render(<PoStatus status="REJECTED" label={th.purchaseOrder.status.REJECTED} />)
    expect(icon(status)).toEqual(expect.arrayContaining(['lucide-circle-x', 'text-danger']))
    expect(notice).toContain(`<div>${th.purchaseOrder.detail.rejectedState}</div>`)
  })
})

describe('what is read before pressing or deciding is body text at the body size, never a 14 px caption (§9.9: 15 px on the web)', () => {
  it('the sentence under sending for approval, sending again, cancelling and closing, and why closing waits', () => {
    const html = page({ submit: true, resend: true, cancel: true, close: true, closeWaits: actions.th.close.needsShortfall })
    for (const sentence of [actions.th.submit.hint, actions.th.resend.hint, actions.th.cancel.hint, actions.th.close.hint, actions.th.close.needsShortfall]) {
      expect(new RegExp(`<p class="([^"]*)">${literally(sentence)}</p>`).exec(html)?.[1], sentence).toBe('text-ink-muted')
    }
  })

  it('under each source request — who asked, no files, or files the reader may not see — on the PO page and its decision page', async () => {
    const requester = { id: 'm-1', name: { th: 'สมชาย ใจดี', en: 'Somchai Jaidee' } }
    const po = {
      requests: [
        { id: 'r-open', number: 'PR-2569-00012', title: 'ไม้อัดและตะปู', requester, access: {}, attachments: [] },
        { id: 'r-closed', number: 'PR-2569-00013', title: 'ปูนซีเมนต์', requester, access: {}, attachments: [] },
      ],
    } as unknown as PoViewDto
    const t = await getTranslations('purchaseOrder')
    const element = await PoRequests({ po, locale: 'th', reader: { prices: false, supplierContact: false, requests: new Set(['r-open']) }, openFile: async () => null, requestHref: (id) => `/requests/${id}`, t })
    const html = render(element)
    for (const words of [th.purchaseOrder.requests.requester.replace('{name}', 'สมชาย ใจดี'), th.purchaseOrder.requests.noFiles, th.purchaseOrder.requests.closed]) {
      expect(new RegExp(`<p class="([^"]*)">${literally(words)}</p>`).exec(html)?.[1], words).toBe('text-ink-muted')
    }
    expect(html).not.toContain('text-sm')
  })
})
