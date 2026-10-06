import { createTranslator, NextIntlClientProvider } from 'next-intl'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ClosedWhy } from '@/ui/request-form/outcome'
import { failureText } from '@/ui/request-form/review-step'
import { closedLinksToRequest, closedNoticeKey, SaveLine } from '@/ui/request-form/request-form'
import type { SaveState } from '@/ui/request-form/use-autosave'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// The workspace's request form when saving goes wrong or has nothing to do (FR-INT-006, §9.9 rule 7, D-05 round 5):
//  - "บันทึกร่างตอนนี้" on a new form with nothing typed yet cannot be pressed — pressed, it saved nothing and said
//    nothing — and names the line beside it, which says the draft saves itself once the requester starts;
//  - a draft closed to the form says, above it, in words of its own for each cause the server names: that it happened
//    elsewhere (or for the account signed in now), that what was changed since the last save is not saved, and what to
//    do next — never a guess (a request not found is not said to be deleted) and never the words of the link under it;
//  - a refusal because this account may not (FORBIDDEN) says what to do next;
//  - a file attached on a form whose first save failed says that it is not in the request and to attach it again.
// The form in a browser: tests/e2e/request-form.spec.ts (both states of the button).

type Locale = 'th' | 'en'
const MESSAGES = { th, en } as const

const html = (node: ReactNode, locale: Locale = 'th') =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]} timeZone="Asia/Bangkok">
      {node}
    </NextIntlClientProvider>,
  )

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The save line with its button, for a state */
const saveLine = (state: SaveState, isNew: boolean, locale: Locale = 'th') => html(<SaveLine state={state} errorText="บันทึกร่างไม่สำเร็จ" isNew={isNew} locale={locale} onSaveNow={() => undefined} />, locale)
/** The "save the draft now" button of the line */
const saveButton = (markup: string, locale: Locale = 'th') => new RegExp(`<button[^>]*>${escape(MESSAGES[locale].requestForm.save.saveNow)}</button>`).exec(markup)?.[0] ?? ''

describe('[FR-INT-006/AC1] [§9.9] "บันทึกร่างตอนนี้" can be pressed only when there is something to save', () => {
  it('a new form with nothing typed yet: it cannot be pressed, and names the line that says the draft saves itself once the requester starts', () => {
    for (const locale of ['th', 'en'] as const) {
      const line = saveLine({ kind: 'idle' }, true, locale)
      const button = saveButton(line, locale)
      expect(button, locale).toContain('disabled=""')
      const described = /aria-describedby="([^"]+)"/.exec(button)?.[1]
      expect(described, locale).toBeTruthy()
      expect(line, locale).toMatch(new RegExp(`<p id="${escape(described!)}" role="status"[^>]*><span>${escape(MESSAGES[locale].requestForm.save.idleNew)}</span></p>`))
    }
  })

  it('once the requester starts typing, after a save that failed, and on a draft that exists, it can be pressed', () => {
    const cases: Array<[SaveState, boolean]> = [
      [{ kind: 'dirty' }, true],
      [{ kind: 'error', failure: null }, true],
      [{ kind: 'idle' }, false],
      [{ kind: 'dirty' }, false],
      [{ kind: 'saved', at: '2026-10-06T05:00:00.000Z' }, false],
    ]
    for (const [state, isNew] of cases) {
      const button = saveButton(saveLine(state, isNew))
      expect(button, `${state.kind} new=${isNew}`).toContain(th.requestForm.save.saveNow)
      expect(button, `${state.kind} new=${isNew}`).not.toMatch(/\sdisabled=""/)
      expect(button, `${state.kind} new=${isNew}`).not.toContain('aria-describedby')
    }
  })

  it('while a save runs it cannot be pressed again', () => {
    expect(saveButton(saveLine({ kind: 'saving' }, false))).toContain('disabled=""')
  })
})

describe('[FR-INT-006/AC2] [§9.9] a draft closed to the form: the notice says what closed it, where, what was not saved and what to do next', () => {
  const CAUSES: readonly ClosedWhy[] = ['SENT', 'CANCELLED', 'NOT_FOUND', 'FORBIDDEN', 'ELSEWHERE']
  const notice = (locale: Locale, why: ClosedWhy) => MESSAGES[locale].requestForm.save.closedBy[why]

  it('each cause the server names has words of its own, the form’s own — not the edit page’s, nor a refusal’s', () => {
    expect(CAUSES.map(closedNoticeKey)).toEqual(CAUSES.map((why) => `save.closedBy.${why}`))
    for (const locale of ['th', 'en'] as const) expect(new Set(CAUSES.map((why) => notice(locale, why))).size, locale).toBe(CAUSES.length)
  })

  it('every one says that what was changed on the page since the draft was last saved is not saved, and none guesses', () => {
    for (const why of CAUSES) {
      expect(notice('th', why), why).toContain('สิ่งที่แก้ในหน้านี้หลังบันทึกร่างครั้งล่าสุดไม่ได้บันทึก')
      expect(notice('en', why), why).toContain('what you changed here since the draft was last saved is not saved')
      // No service deletes a draft: a request that is not found is never said to be removed, nor to "maybe" be anything
      expect(notice('th', why), why).not.toMatch(/ลบ|อาจ/)
      expect(notice('en', why).toLowerCase(), why).not.toMatch(/remove|delete|may have/)
    }
  })

  it('sent or cancelled from elsewhere: it says so, and the request’s page is linked under it — words the notice never repeats', () => {
    expect(notice('th', 'SENT')).toMatch(/^คำขอนี้ส่งจากที่อื่นไปแล้ว /)
    expect(notice('th', 'CANCELLED')).toMatch(/^คำขอนี้ถูกยกเลิกจากที่อื่นไปแล้ว /)
    expect(notice('en', 'SENT')).toMatch(/^This request was sent from elsewhere, /)
    expect(notice('en', 'CANCELLED')).toMatch(/^This request was cancelled from elsewhere, /)
    for (const why of ['SENT', 'CANCELLED', 'ELSEWHERE'] as const) {
      expect(closedLinksToRequest(why), why).toBe(true)
      expect(notice('th', why), why).not.toContain(th.requestForm.save.openRequest)
      expect(notice('en', why).toLowerCase(), why).not.toContain(en.requestForm.save.openRequest.toLowerCase())
    }
    // What to do next: a request sent with what must change is cancelled on its page; one cancelled is started again
    expect(notice('th', 'SENT')).toContain('ยกเลิกคำขอที่หน้าคำขอแล้วเริ่มคำขอใหม่')
    expect(notice('th', 'CANCELLED')).toContain('เริ่มคำขอใหม่จากหน้าขอซื้อ / ขอจ้าง')
  })

  it('not found, or not this account’s: no link to a page that would refuse, and the way on — your own account again, or the administrator', () => {
    for (const why of ['NOT_FOUND', 'FORBIDDEN'] as const) {
      expect(closedLinksToRequest(why), why).toBe(false)
      expect(notice('th', why), why).toContain('บัญชีที่เข้าระบบอยู่ตอนนี้')
      expect(notice('th', why), why).toContain('ถ้าเพิ่งเข้าระบบด้วยบัญชีอื่น ให้เข้าระบบด้วยบัญชีของคุณแล้วโหลดหน้านี้ใหม่')
      expect(notice('th', why), why).toContain('ติดต่อผู้ดูแลระบบขององค์กร')
      expect(notice('en', why), why).toContain('If you just signed in with another account, sign in with yours and reload this page')
    }
  })
})

describe('[§9.9] refusals of the form say what to do next', () => {
  const tOf = (locale: Locale) => createTranslator({ locale, messages: MESSAGES[locale], namespace: 'requestForm' }) as unknown as Parameters<typeof failureText>[0]
  const refusal = (locale: Locale, code: string) => failureText(tOf(locale), { ok: false, code }, [], locale, (kind) => kind)

  it('FORBIDDEN — of a send, an attachment or a file taken off — says who may, then how the requester goes on', () => {
    expect(refusal('th', 'FORBIDDEN')).toBe(
      'ทำรายการนี้ได้เฉพาะผู้ขอที่เป็นเจ้าของคำขอ ถ้าเพิ่งเข้าระบบด้วยบัญชีอื่น ให้เข้าระบบด้วยบัญชีของคุณแล้วโหลดหน้านี้ใหม่ ถ้าไม่ใช่ ติดต่อผู้ดูแลระบบขององค์กรให้ตรวจบทบาทของบัญชี',
    )
    expect(refusal('en', 'FORBIDDEN')).toContain("if not, ask your organization's administrator to check the account's roles")
  })

  it('a file attached while the draft could not be created yet: it is not in the request, why is at the top, and it is attached again', () => {
    const tTh = tOf('th')
    const tEn = tOf('en')
    expect(tTh('attachments.notAttachedDraft', { name: 'ใบเสนอราคา.pdf' })).toBe(
      'ไฟล์ ใบเสนอราคา.pdf ยังไม่อยู่ในคำขอ เพราะบันทึกร่างไม่สำเร็จ ดูสาเหตุที่บรรทัดบันทึกร่างด้านบนของหน้า แก้แล้วแนบไฟล์นี้อีกครั้ง',
    )
    expect(tEn('attachments.notAttachedDraft', { name: 'quote.pdf' })).toBe(
      "The file quote.pdf is not in the request yet, because the draft could not be saved. See why on the draft's line at the top of the page, fix it, then attach this file again",
    )
    // Not the send button's words, which say nothing was sent
    expect(tTh('attachments.notAttachedDraft', { name: 'x' })).not.toContain('ยังไม่ได้ส่ง')
  })
})
