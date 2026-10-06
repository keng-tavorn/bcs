import { NextIntlClientProvider } from 'next-intl'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SignOutButton, SignOutFailure, signOutWith } from '@/ui/auth/sign-out-button'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// §9.9 rule 7 (the same defect the sign-in, 2FA, forgot, reset and security forms had, D-05 /login item 3): "ออกจากระบบ"
// goes to /login only once Better Auth signed the member out. A request that gets no answer (it throws in Better Auth's
// client) and an answer that refuses (a limit on requests, a server failure) leave the member signed in: the button can
// be pressed again, and the words beside it say what happened and what to do — check the connection, or reload the page —
// never the sign-in page that would send a member still signed in straight back home. A press that signs out runs in the
// browser in tests/e2e/liff-another-user.spec.ts.

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }))

const html = (node: ReactNode, locale: 'th' | 'en' = 'th') =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : th} timeZone="Asia/Bangkok">
      {node}
    </NextIntlClientProvider>,
  )
const words = (markup: string) => markup.replace(/<[^>]+>/g, '')

describe('[§9.9] signing out goes to the sign-in page only once signed out, and says why not otherwise', () => {
  it('signed out: done', async () => {
    expect(await signOutWith(async () => ({ error: null }))).toBe('done')
  })

  it('no answer (the call throws: the connection dropped): not signed out, and the connection is what to check', async () => {
    expect(await signOutWith(() => Promise.reject(new TypeError('Failed to fetch')))).toBe('noAnswer')
  })

  it.each([429, 500, 503])('an answer that refuses (%i): not signed out, and the page is what to reload', async (status) => {
    expect(await signOutWith(async () => ({ error: { status } }))).toBe('refused')
  })

  it('says why beside the button, with an icon, in Thai and in English, as an alert', () => {
    const noAnswer = html(<SignOutFailure id="m-sign-out" result="noAnswer" />)
    expect(noAnswer).toContain('role="alert"')
    expect(noAnswer).toContain('id="m-sign-out"')
    expect(noAnswer).toContain('<svg')
    expect(words(noAnswer)).toBe('ออกจากระบบไม่สำเร็จ ตรวจการเชื่อมต่อแล้วกดออกจากระบบอีกครั้ง')
    expect(words(html(<SignOutFailure id="m" result="refused" />))).toBe('ออกจากระบบไม่สำเร็จ โหลดหน้านี้ใหม่แล้วกดออกจากระบบอีกครั้ง')
    expect(words(html(<SignOutFailure id="m" result="noAnswer" />, 'en'))).toBe('Not signed out. Check your connection, then press Sign out again.')
    expect(words(html(<SignOutFailure id="m" result="refused" />, 'en'))).toBe('Not signed out. Reload this page, then press Sign out again.')
    // Each names the button it asks to press again
    for (const m of [th, en]) for (const key of ['signOutNoAnswer', 'signOutRefused'] as const) expect(m.auth.security[key]).toContain(m.auth.security.signOut)
  })

  it('the page loads with the button only, which can be pressed', () => {
    const page = html(<SignOutButton />)
    expect(page).toMatch(/<button[^>]*>ออกจากระบบ<\/button>/)
    expect(page).not.toContain('disabled=""')
    expect(page).not.toContain('role="alert"')
  })
})
