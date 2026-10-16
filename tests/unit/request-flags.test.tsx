import { createTranslator, NextIntlClientProvider } from 'next-intl'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { requestFlagsView, type RequestFlagsT } from '@/app/(workspace)/_tracking/request-flags'
import type { RequestFlagDto } from '@/server/services/requests/duplicates'
import { FLAG_BADGES } from '@/ui/document/badge-looks'
import { StatusBadge } from '@/ui/document/badges'
import { LiffStatusBadge } from '@/ui/liff/status-badge'
import { DuplicatePanel } from '@/ui/request-form/duplicate-panel'
import { duplicateLabel, duplicateReasonOf, duplicateRefusal } from '@/ui/request-form/duplicate'
import { failureKey, failureStep, toFormFailure } from '@/ui/request-form/outcome'
import { RequestFlagList } from '@/ui/request-flags/list'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// S6-13 on screen (FR-INT-103 AC2 AC3 · BR-DUP-05): the send refused as like a request the requester sent before
// (DUPLICATE_UNACKNOWLEDGED) becomes the review step's panel with the requests it matched and the reason the next send
// carries; and listRequestFlags' DTO becomes the approver's section — the DUPLICATE badge with the requester's reason,
// the SPLIT badge with the amount together written from satang text and the DOA rules alone and together.

const REFUSAL = {
  code: 'VALIDATION_FAILED',
  details: {
    field: 'duplicateReason',
    reason: 'DUPLICATE_UNACKNOWLEDGED',
    matched: [
      { id: 'r1', number: 'PR-2569-000123', title: 'ไม้อัดรอบก่อน' },
      { id: 'r2', number: null, title: 'ตะปูรอบก่อน' },
      { id: 42, title: 'not a request' },
    ],
  },
}

const tTh = createTranslator({ locale: 'th', messages: th, namespace: 'requestFlags' }) as unknown as RequestFlagsT
const tEn = createTranslator({ locale: 'en', messages: en, namespace: 'requestFlags' }) as unknown as RequestFlagsT

const DUPLICATE: RequestFlagDto = { kind: 'DUPLICATE', routeNo: 1, matched: [{ id: 'r1', label: 'PR-2569-000123' }], combinedSatang: null, individualRule: null, combinedRule: null, reason: 'ของรอบก่อนใช้หมดแล้ว' }
const SPLIT: RequestFlagDto = {
  kind: 'SPLIT',
  routeNo: 1,
  matched: [
    { id: 'r3', label: 'PR-2569-000200' },
    { id: 'r4', label: 'งานทาสี' },
  ],
  combinedSatang: '123456789',
  individualRule: 'PR-01',
  combinedRule: 'PR-02',
  reason: null,
}

const words = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

describe('[FR-INT-103/AC2] the send refused as like a request sent before asks for the reason', () => {
  it('the refusal keeps the requests it matched and is told apart from every other refusal', () => {
    const f = toFormFailure(REFUSAL)
    expect(f).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', reason: 'DUPLICATE_UNACKNOWLEDGED', field: 'duplicateReason' })
    // Only well-formed matches cross to the screen
    expect(duplicateRefusal(f)).toEqual([
      { id: 'r1', number: 'PR-2569-000123', title: 'ไม้อัดรอบก่อน' },
      { id: 'r2', number: null, title: 'ตะปูรอบก่อน' },
    ])
    expect(failureKey(f)).toBe('DUPLICATE_UNACKNOWLEDGED')
    // Nothing in another step fixes it: the review step itself asks for the reason
    expect(failureStep(f)).toBeNull()
    expect(duplicateRefusal(toFormFailure({ code: 'VALIDATION_FAILED', details: { reason: 'FORM', field: 'formData.x' } }))).toBeNull()
    expect(duplicateRefusal(toFormFailure({ code: 'CONFLICT_VERSION' }))).toBeNull()
    expect(duplicateRefusal(null)).toBeNull()
  })

  it('a matched request is named by its number, or by its title before it has one', () => {
    expect(duplicateLabel({ id: 'r1', number: 'PR-2569-000123', title: 'ไม้อัด' })).toBe('PR-2569-000123')
    expect(duplicateLabel({ id: 'r2', number: null, title: 'ตะปู' })).toBe('ตะปู')
  })

  it('once asked, a send goes only with a reason, trimmed; before that it carries none', () => {
    expect(duplicateReasonOf(false, '')).toEqual({ ok: true })
    expect(duplicateReasonOf(false, 'ignored')).toEqual({ ok: true })
    expect(duplicateReasonOf(true, '')).toEqual({ ok: false })
    expect(duplicateReasonOf(true, '   \n ')).toEqual({ ok: false })
    expect(duplicateReasonOf(true, '  ของรอบก่อนใช้หมดแล้ว ')).toEqual({ ok: true, duplicateReason: 'ของรอบก่อนใช้หมดแล้ว' })
  })

  it('the panel links each matched request to its page and asks for the reason, saying why when it is empty', () => {
    const html = (node: ReactNode, locale: 'th' | 'en' = 'th') =>
      renderToStaticMarkup(
        <NextIntlClientProvider locale={locale} messages={locale === 'th' ? th : en} timeZone="Asia/Bangkok">
          {node}
        </NextIntlClientProvider>,
      )
    const matched = duplicateRefusal(toFormFailure(REFUSAL))!
    const ask = { matched, reason: '', onReason: () => undefined, missing: false, stops: 0 }
    const shown = html(<DuplicatePanel ask={ask} />)
    expect(shown).toContain(th.requestForm.duplicate.title)
    expect(shown).toContain('href="/requests/r1"')
    expect(shown).toContain('>PR-2569-000123</a>')
    expect(shown).toContain('href="/requests/r2"')
    expect(shown).toContain('>ตะปูรอบก่อน</a>')
    expect(shown).toContain(`aria-label="${th.requestForm.duplicate.matched}"`)
    expect(shown).toMatch(/<textarea[^>]*required=""/)
    expect(shown).not.toContain(th.requestForm.duplicate.reasonMissing)
    // An inline status, never a dialog (NG-13)
    expect(shown).toContain('role="status"')
    expect(shown).not.toContain('role="dialog"')
    const missing = html(<DuplicatePanel ask={{ ...ask, missing: true, stops: 1 }} />)
    expect(missing).toContain(th.requestForm.duplicate.reasonMissing)
    expect(missing).toContain('aria-invalid="true"')
    expect(html(<DuplicatePanel ask={{ ...ask, reason: 'ใช้หมดแล้ว', missing: true, stops: 1 }} />)).not.toContain(th.requestForm.duplicate.reasonMissing)
    expect(html(<DuplicatePanel ask={ask} />, 'en')).toContain(en.requestForm.duplicate.title)
  })
})

describe('[FR-INT-103/AC3] the approver sees the request’s flags', () => {
  it('no flag: no section', () => {
    expect(requestFlagsView(tTh, [], (id) => `/requests/${id}`)).toBeNull()
  })

  it('DUPLICATE: its badge, what it means, the requester’s reason and the matched request as a link', () => {
    const view = requestFlagsView(tTh, [DUPLICATE], (id) => `/requests/${id}`)!
    expect(view.title).toBe(th.requestFlags.title)
    expect(view.flags).toEqual([
      {
        key: '1-DUPLICATE',
        kind: 'DUPLICATE',
        badge: 'คล้ายคำขอที่ส่งไปแล้ว',
        detail: th.requestFlags.duplicate.detail,
        note: { label: th.requestFlags.duplicate.reasonLabel, value: 'ของรอบก่อนใช้หมดแล้ว' },
        matched: [{ href: '/requests/r1', label: 'PR-2569-000123' }],
      },
    ])
    // A flag kept without a reason still says so in words
    expect(requestFlagsView(tTh, [{ ...DUPLICATE, reason: null }], (id) => id)!.flags[0]!.note!.value).toBe(th.requestFlags.duplicate.noReason)
  })

  it('SPLIT: the amount together from satang text with 2 decimals, and the rules alone and together', () => {
    const view = requestFlagsView(tTh, [SPLIT], (id) => `/liff/requests/${id}`)!
    const [flag] = view.flags
    expect(flag!.badge).toBe('อาจแตกยอดเลี่ยงวงเงิน')
    expect(flag!.detail).toContain('1,234,567.89 บาท')
    expect(flag!.note).toEqual({ label: 'ข้อ DOA', value: 'แยกกัน PR-01 → รวมกัน PR-02' })
    expect(flag!.matched).toEqual([
      { href: '/liff/requests/r3', label: 'PR-2569-000200' },
      { href: '/liff/requests/r4', label: 'งานทาสี' },
    ])
    // No rule for the largest alone
    expect(requestFlagsView(tTh, [{ ...SPLIT, individualRule: null }], (id) => id)!.flags[0]!.note!.value).toBe(`แยกกัน ${th.requestFlags.split.noRule} → รวมกัน PR-02`)
    const english = requestFlagsView(tEn, [SPLIT], (id) => id)!.flags[0]!
    expect(english.badge).toBe('May split to avoid a limit')
    expect(english.detail).toContain('1,234,567.89 baht')
  })

  it('the list draws each flag as a warn badge with its icon and words, on the web and on LIFF alike', () => {
    const view = requestFlagsView(tTh, [DUPLICATE, SPLIT], (id) => `/requests/${id}`)!
    const link = (to: { href: string; label: string }) => <a href={to.href}>{to.label}</a>
    const web = renderToStaticMarkup(<RequestFlagList view={view} badge={(f) => <StatusBadge look={FLAG_BADGES[f.kind]} label={f.label} />} link={link} />)
    const liff = renderToStaticMarkup(<RequestFlagList view={view} badge={(f) => <LiffStatusBadge look={FLAG_BADGES[f.kind]} label={f.label} />} link={link} />)
    for (const markup of [web, liff]) {
      expect(markup.match(/data-tone="warn"/g)).toHaveLength(2)
      expect(markup).toContain('data-icon="Copy"')
      expect(markup).toContain('data-icon="Split"')
      expect(words(markup)).toContain('เหตุผลของผู้ขอ: ของรอบก่อนใช้หมดแล้ว')
      expect(markup).toContain('href="/requests/r1"')
      expect(markup).toContain('href="/requests/r4"')
    }
  })
})
