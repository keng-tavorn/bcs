import { NextIntlClientProvider } from 'next-intl'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LinkRefusal } from '@/ui/approvals/action-link-form'
import { linkRefusal, type ActionLinkFailure } from '@/ui/approvals/action-link-outcome'
import { formatDateTime } from '@/ui/format'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// An e-mail link pressed after its task was decided (spec §9.3 "ดำเนินการแล้วโดย … เมื่อ …", §14.2 TOKEN_USED, FR-DOA-004
// AC2, FR-NOTI-002 AC2): the service answers TOKEN_USED with the decider's Thai and English names and the time; the page's
// action passes on the time, and the name in the reader's language only to a member signed in as the one the link was
// sent to (src/ui/approvals/action-link-outcome.ts) — a decision through the link alone names nobody (ADR-050 item 4).
// The form says it with the words of §14.2. tests/integration/closing-decision.test.ts runs the service itself.

const DECIDED_AT = '2026-10-06T09:30:00.000Z'
const TOKEN_USED = { code: 'TOKEN_USED', message: 'the task was decided already', details: { name: 'ดำรง ก่อสร้างไทย', nameEn: 'Damrong Construction', time: DECIDED_AT } }

const html = (node: ReactNode, locale: 'th' | 'en') =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === 'th' ? th : en} timeZone="Asia/Bangkok">
      {node}
    </NextIntlClientProvider>,
  )
/** The words of the notice: its markup without tags (the icon is decorative and has none) */
const words = (failure: ActionLinkFailure, locale: 'th' | 'en') => html(<LinkRefusal failure={failure} />, locale).replace(/<[^>]+>/g, '')

describe('[FR-DOA-004/AC2] [FR-NOTI-002/AC2] a decision link pressed after its task was decided says who decided it and when', () => {
  it('a member signed in as the link’s is told the decider in their own language, and when', () => {
    expect(linkRefusal(TOKEN_USED, { signedIn: true, locale: 'th' })).toEqual({ ok: false, code: 'TOKEN_USED', name: 'ดำรง ก่อสร้างไทย', time: DECIDED_AT })
    expect(linkRefusal(TOKEN_USED, { signedIn: true, locale: 'en' })).toEqual({ ok: false, code: 'TOKEN_USED', name: 'Damrong Construction', time: DECIDED_AT })
    // No English name stored: the service gives the Thai one in its place; a Thai name alone still reaches an English reader
    expect(linkRefusal({ code: 'TOKEN_USED', details: { name: 'ดำรง ก่อสร้างไทย', time: DECIDED_AT } }, { signedIn: true, locale: 'en' })).toMatchObject({ name: 'ดำรง ก่อสร้างไทย' })
  })

  it('a decision through the link alone (no sign-in) is told when, never who', () => {
    for (const locale of ['th', 'en']) expect(linkRefusal(TOKEN_USED, { signedIn: false, locale })).toEqual({ ok: false, code: 'TOKEN_USED', time: DECIDED_AT })
  })

  it('every other refusal passes on its code alone, whatever its details hold', () => {
    for (const code of ['TOKEN_INVALID', 'TOKEN_EXPIRED', 'STEP_UP_REQUIRED', 'INVALID_STATE_TRANSITION', 'FORBIDDEN']) {
      expect(linkRefusal({ code, details: TOKEN_USED.details }, { signedIn: true, locale: 'th' })).toEqual({ ok: false, code })
    }
    expect(linkRefusal({ code: 'TOKEN_USED' }, { signedIn: true, locale: 'th' })).toEqual({ ok: false, code: 'TOKEN_USED' })
  })

  it('the form says it in the words of §14.2 TOKEN_USED, in Thai and in English, as an alert', () => {
    const named = linkRefusal(TOKEN_USED, { signedIn: true, locale: 'th' })
    expect(words(named, 'th')).toBe(`รายการนี้ดำเนินการแล้วโดย ดำรง ก่อสร้างไทย เมื่อ ${formatDateTime('th', DECIDED_AT)}`)
    expect(html(<LinkRefusal failure={named} />, 'th')).toContain('role="alert"')
    expect(words(linkRefusal(TOKEN_USED, { signedIn: true, locale: 'en' }), 'en')).toBe(`Already decided by Damrong Construction ${formatDateTime('en', DECIDED_AT)}`)
  })

  it('without a name it says when and where to see the result; without either, that the link works once', () => {
    const unnamed = linkRefusal(TOKEN_USED, { signedIn: false, locale: 'th' })
    expect(words(unnamed, 'th')).toBe(`รายการนี้ดำเนินการแล้วเมื่อ ${formatDateTime('th', DECIDED_AT)} ดูผลได้ในระบบ`)
    expect(words(linkRefusal(TOKEN_USED, { signedIn: false, locale: 'en' }), 'en')).toBe(`Already decided ${formatDateTime('en', DECIDED_AT)}. See the result in BCS`)
    expect(words({ ok: false, code: 'TOKEN_USED' }, 'th')).toBe(th.actionLink.usedBody)
    expect(words({ ok: false, code: 'TOKEN_INVALID' }, 'en')).toBe(en.actionLink.invalidBody)
  })
})
