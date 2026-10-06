import { NextIntlClientProvider, useTranslations } from 'next-intl'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import GlobalError from '@/app/global-error'
import { LiffActionBar } from '@/ui/liff/action-bar'
import { LiffContent, LiffFrame, LiffSection } from '@/ui/liff/frame'
import { LiffLanguageSwitch } from '@/ui/liff/language-switch'
import { LiffLink } from '@/ui/liff/liff-link'
import { LiffProvider, type LiffConfig } from '@/ui/liff/liff-provider'
import { SignInField } from '@/ui/liff/liff-sign-in'
import { LinkRefused } from '@/ui/liff/link-flow'
import { LinkedMember } from '@/ui/liff/link-member'
import { LiffNotice } from '@/ui/liff/notice'
import { PinInput, pinDigits } from '@/ui/liff/pin-input'
import { LiffRefusal } from '@/ui/liff/refusal'
import { LIFF_RICH } from '@/ui/liff/rich'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// S5-06 · the LIFF toolkit the next wave's pages are built from (src/ui/liff): the frame (one column, 16 px text, a
// title and a back link, safe-area insets), the bottom action bar, the message block, the PIN field, the refusal block,
// and the screens of /liff/link that must not claim more than the server checked. Static markup only (no DOM here); how
// they behave in the LINE-sized browser runs in tests/e2e/liff-*.spec.ts with axe.

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined, replace: () => undefined, push: () => undefined }) }))

const html = (node: ReactNode, locale: 'th' | 'en' = 'th') =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === 'th' ? th : en} timeZone="Asia/Bangkok">
      {node}
    </NextIntlClientProvider>,
  )

/** The LIFF bootstrap of a page: LIFF_MOCK with this LINE user (null: a browser outside LINE) */
const inLiff = (node: ReactNode, lineUserId: string | null, session: LiffConfig['session'] = 'web') => (
  <LiffProvider config={{ liffId: null, mock: { lineUserId, cookie: 'bcs-liff-mock-user' }, session }}>{node}</LiffProvider>
)

describe('[NFR-A11Y-02] the LIFF frame is one column for a phone in LINE: 16 px text and 44 px targets', () => {
  it('has the page title as the only h1, a back link where given, 16 px text and keeps clear of the safe area', () => {
    const page = html(
      <LiffFrame title="งานรออนุมัติ" back={{ href: '/liff/tasks', label: 'กลับ' }}>
        <LiffContent>
          <LiffSection id="s1" title="รายละเอียด">
            <p>เนื้อหา</p>
          </LiffSection>
        </LiffContent>
      </LiffFrame>,
    )
    expect(page.match(/<h1/g)).toHaveLength(1)
    expect(page).toContain('งานรออนุมัติ</h1>')
    expect(page).toMatch(/<a href="\/liff\/tasks" class="[^"]*min-h-11[^"]*">.*กลับ/)
    // The back arrow is drawn without lucide's client code, and is not read out
    expect(page).toMatch(/<svg[^>]*aria-hidden="true"/)
    expect(page).toContain('<main id="content"')
    // 16 px whatever the width (the workspace body drops to 15 px on wide screens), the column at most 36rem wide
    expect(page).toContain('text-base')
    expect(page).toContain('max-w-xl')
    expect(page).toContain('env(safe-area-inset-left)')
    expect(page).toContain('env(safe-area-inset-top)')
    expect(page).toMatch(/<section aria-labelledby="s1"[^>]*><h2 id="s1"/)
  })

  it('shows no back link when none is given', () => {
    expect(html(<LiffFrame title="ช่วยเหลือ">x</LiffFrame>)).not.toContain('<a ')
  })

  it('keeps the action bar at the bottom of the screen above the home indicator, with the buttons inside', () => {
    const bar = html(
      <LiffActionBar label="การตัดสิน">
        <button type="button">อนุมัติ</button>
      </LiffActionBar>,
    )
    expect(bar).toMatch(/^<section aria-label="การตัดสิน" class="[^"]*sticky bottom-0/)
    expect(bar).toContain('env(safe-area-inset-bottom)')
    expect(bar).toContain('<button type="button">อนุมัติ</button>')
  })

  it('switches the language with buttons of at least 44 px', () => {
    const form = html(<LiffLanguageSwitch current="th" label="ภาษา" options={[{ value: 'th', name: 'ไทย' }, { value: 'en', name: 'English' }]} action={async () => undefined} />)
    expect(form.match(/min-h-11/g)).toHaveLength(2)
    expect(form).toContain('aria-pressed="true"')
  })

  it('links between LIFF pages with a plain link at least 44 px high', () => {
    const link = html(<LiffLink href="/liff/help">ช่วยเหลือ</LiffLink>)
    expect(link).toMatch(/^<a href="\/liff\/help" class="[^"]*min-h-11[^"]*">ช่วยเหลือ<\/a>$/)
  })
})

describe('[NFR-A11Y-03] a LIFF message says what happened with an icon and words, never colour alone', () => {
  it('announces a refusal at once and the rest politely', () => {
    const danger = html(<LiffNotice tone="danger">ผูกบัญชีไม่ได้</LiffNotice>)
    expect(danger).toMatch(/^<div role="alert" class="[^"]*border-danger[^"]*"><svg[^>]*aria-hidden="true"/)
    expect(danger).toContain('ผูกบัญชีไม่ได้')
    for (const tone of ['info', 'success', 'warning'] as const) expect(html(<LiffNotice tone={tone}>x</LiffNotice>)).toMatch(/^<div role="status"/)
  })

  it('states how something stands in danger’s colour politely, as a status: a task not approved, drawn as its timeline draws it (D-05 round 5)', () => {
    const rejected = html(
      <LiffNotice tone="danger" role="status">
        ไม่อนุมัติโดย วีระ ปฏิบัติการ
      </LiffNotice>,
    )
    expect(rejected).toMatch(/^<div role="status" class="[^"]*border-danger[^"]*"><svg[^>]*class="[^"]*text-danger[^"]*"[^>]*aria-hidden="true"/)
    expect(rejected).toContain('ไม่อนุมัติโดย วีระ ปฏิบัติการ')
  })
})

describe('[§9.4] the last-resort error page needs the app messages only, not the whole catalogue in every page’s JavaScript', () => {
  it('still says what happened from the app messages alone, in Thai first', () => {
    const page = renderToStaticMarkup(<GlobalError error={Object.assign(new Error('x'), { digest: 'abc123' })} reset={() => undefined} />)
    expect(page).toContain(th.app.error.title)
    expect(page).toContain(th.app.error.reference.replace('{reference}', 'abc123'))
    expect(page).toContain(th.app.error.retry)
  })
})

describe('[FR-AUTH-005] [§9.4] the PIN field of the next wave’s decision bar: six digits, masked, the numeric keypad', () => {
  it('is masked, opens the numeric keypad, takes six digits and never submits on its own', () => {
    const field = html(<PinInput id="pin" label="PIN 6 หลัก" hint="ใส่ตัวเลข 6 หลัก" length={6} value="" onChange={() => undefined} error="PIN ไม่ถูกต้อง" />)
    expect(field).toContain('type="password"')
    expect(field).toContain('inputMode="numeric"')
    expect(field).toContain('autoComplete="one-time-code"')
    // Never offered to a password manager as the account password (the web's PIN fields say the same)
    expect(field).toContain('data-1p-ignore=""')
    expect(field).toContain('data-lpignore="true"')
    expect(field).toContain('data-bwignore="true"')
    expect(field).toContain('data-form-type="other"')
    // Six digits are kept as each change comes in: a maxLength would cut a pasted "582 931" first (tests/unit/pin-paste.test.tsx)
    expect(field).not.toMatch(/maxlength=/i)
    expect(field).toContain('pattern="[0-9]{6}"')
    expect(field).toContain('<label for="pin"')
    expect(field).toContain('aria-describedby="pin-hint pin-error"')
    expect(field).toContain('aria-invalid="true"')
    // No form and no submit button of its own: the page's button says what happens
    expect(field).not.toContain('<form')
    expect(field).not.toContain('type="submit"')
  })

  it('keeps digits only and at most the PIN length, whatever is typed or pasted', () => {
    expect(pinDigits('739164', 6)).toBe('739164')
    expect(pinDigits('73 91-64', 6)).toBe('739164')
    expect(pinDigits('7391645', 6)).toBe('739164')
    expect(pinDigits('pin: 12a3', 6)).toBe('123')
    expect(pinDigits('', 6)).toBe('')
  })
})

describe('[FR-LINE-001/AC1] a refused link code says what happened and how to get a new one', () => {
  it('names an expired code with how long codes last, and links to the web settings for a new code', () => {
    const block = html(<LinkRefused refusal={{ code: 'TOKEN_EXPIRED' }} codeMinutes={10} />)
    expect(block).toContain('role="alert"')
    expect(block).toContain('ผูกบัญชีไม่ได้')
    expect(block).toContain('หมดอายุแล้ว (ใช้ได้ 10 นาที)')
    expect(block).toContain('href="/settings/line"')
  })

  it('names a used code, and a code someone else’s LINE is linked with, in English too', () => {
    expect(html(<LinkRefused refusal={{ code: 'TOKEN_USED' }} codeMinutes={10} />)).toContain('ถูกใช้ไปแล้ว')
    const other = html(<LinkRefused refusal={{ code: 'INVALID_STATE_TRANSITION', reason: 'ACCOUNT_LINKED_TO_ANOTHER_MEMBER' }} codeMinutes={10} />, 'en')
    expect(other).toContain('linked to another member')
    // A new code does not help when LINE is off here
    expect(html(<LinkRefused refusal={{ code: 'INVALID_STATE_TRANSITION', reason: 'LINE_NOT_ENABLED' }} codeMinutes={10} />)).not.toContain('href=')
  })

  it('says when to try again in the page’s own time zone', () => {
    const block = html(<LinkRefused refusal={{ code: 'RATE_LIMITED', reason: 'LINK_ATTEMPTS', time: '2026-10-04T03:05:00.000Z' }} codeMinutes={10} />)
    expect(block).toContain('ลองใหม่ได้หลังเวลา 10:05 น.')
  })

  it('shows a refusal block with its action', () => {
    const block = html(
      <LiffRefusal title="ผูกบัญชีไม่ได้" action={<a href="/settings/line">ตั้งค่า</a>}>
        ขอรหัสใหม่
      </LiffRefusal>,
    )
    expect(block).toMatch(/role="alert".*ผูกบัญชีไม่ได้.*ขอรหัสใหม่.*href="\/settings\/line"/)
  })
})

describe('[FR-LINE-001/AC3] the linked screen tells this LINE account from another only after the server checked the token', () => {
  const props = {
    memberName: 'สมใจ ทดสอบ',
    organizationName: 'DEMO',
    since: '4 ต.ค. 2569 07:01 น.',
    codeMinutes: 10,
    check: async () => ({ ok: true as const, link: 'this' as const }),
    unlink: async () => ({ ok: true as const }),
    link: async () => ({ ok: true as const }),
  }

  it('in LINE, says nothing about "this LINE" and offers no unlinking until the check answered', () => {
    const page = html(inLiff(<LinkedMember {...props} session="web" />, 'U0123456789abcdef0123456789abcdef'))
    expect(page).toContain(th.liff.link.checking)
    expect(page).not.toContain(th.liff.link.linked.heading)
    expect(page).not.toContain(th.liff.link.linked.unlink)
    expect(page).not.toContain(th.liff.link.other.unlink)
  })

  it('outside the LINE app, says the account is linked and points to the web settings, with no unlinking here', () => {
    const page = html(inLiff(<LinkedMember {...props} session="web" />, null))
    expect(page).toContain(th.liff.link.outsideLinked.heading)
    expect(page).toContain('สมใจ ทดสอบ')
    expect(page).toContain('href="/settings/line"')
    expect(page).not.toContain(th.liff.link.linked.heading)
    expect(page).not.toContain('<button')
  })
})

describe('[FR-LINE-001/AC2] [NFR-A11Y-03] a field of the sign-in inside LIFF says what is wrong with it, announced with the field', () => {
  it('the error is read with the input after its hint, and drawn as an icon and the words, never colour alone', () => {
    const page = html(<SignInField id="e" name="email" type="email" label={th.auth.login.email} hint="ช่วย" error={th.auth.login.emailInvalid} />)
    const input = page.match(/<input[^>]*>/)![0]
    expect(input).toContain('aria-invalid="true"')
    expect(input).toContain('aria-describedby="e-hint e-error"')
    expect(page).toMatch(/<p id="e-error" class="[^"]*text-danger[^"]*"><svg[^>]*aria-hidden="true"[\s\S]*?<\/svg><span>[^<]*<\/span><\/p>/)
    expect(page).toContain(`<span>${th.auth.login.emailInvalid}</span></p>`)
    expect(page).toMatch(/<label for="e"[^>]*>อีเมลบริษัท<\/label>/)
  })

  it('without an error the field is not marked invalid, and is described by nothing it does not show', () => {
    const input = html(<SignInField id="p" name="password" type="password" label={th.auth.login.password} />).match(/<input[^>]*>/)![0]
    expect(input).not.toContain('aria-invalid')
    expect(input).not.toContain('aria-describedby')
  })
})

describe('[NFR-I18N-01] Thai words the browser would split at a line end stay whole', () => {
  function Body() {
    const t = useTranslations('liff.link.linked')
    return <p>{t.rich('unlinkBody', LIFF_RICH)}</p>
  }

  it('keeps the word for "chat" on one line in Thai, and leaves English as it is', () => {
    expect(html(<Body />)).toContain('<span class="whitespace-nowrap">แชท</span>')
    expect(html(<Body />, 'en')).toBe(`<p>${en.liff.link.linked.unlinkBody}</p>`)
  })
})
