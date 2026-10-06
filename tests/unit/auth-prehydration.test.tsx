import { NextIntlClientProvider } from 'next-intl'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@/lib/constants'
import { ForgotForm } from '@/ui/auth/forgot-form'
import { InviteForm } from '@/ui/auth/invite-form'
import { LoginForm } from '@/ui/auth/login-form'
import { ResetForm } from '@/ui/auth/reset-form'
import { TwoFactorForm } from '@/ui/auth/two-factor-form'
import { TwoFactorSetup } from '@/ui/auth/two-factor-setup'
import { LiffSignIn } from '@/ui/liff/liff-sign-in'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// FR-AUTH-001 · FR-AUTH-002 · FR-LINE-001 AC2 · NFR-SEC-09: the forms that carry a password, a sign-in code or the e-mail
// of a password reset, as the server sends them — what a slow phone shows before the page's script runs. A form with no
// method is submitted natively as a GET to the page's own address: what was typed would land in the address bar, the
// browser's history, request logs and Referer headers. So each of these forms posts, and its submit button — the default
// button, whose being disabled also stops Enter in a field from submitting — is disabled until the script runs
// (src/ui/form/hydrated.ts); any other button waits too, as a press before the script runs would be lost. The fields take
// typing meanwhile. tests/e2e/auth-prehydration.spec.ts submits these pages with JavaScript off.

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined, replace: () => undefined, push: () => undefined }) }))

const html = (node: ReactNode, locale: 'th' | 'en' = 'th') =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === 'th' ? th : en} timeZone="Asia/Bangkok">
      {node}
    </NextIntlClientProvider>,
  )

/** An attribute's value in an opening tag; HTML attribute names are case-insensitive (React writes autoComplete as is) */
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`, 'i'))?.[1]
/** Each form of the markup: its opening tag and what it holds (the forms of these screens are never nested) */
const formsOf = (markup: string) => [...markup.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)].map((m) => ({ tag: `<form${m[1]}>`, body: m[2]! }))
const tagsOf = (markup: string, pattern: RegExp) => [...markup.matchAll(pattern)].map((m) => m[0])
const isDisabled = (tag: string) => /\sdisabled=""/.test(tag)

/** An action that never answers: only the first render is looked at */
const never = () => new Promise<never>(() => undefined)

type Screen = readonly [name: string, markup: (locale: 'th' | 'en') => string, fields: readonly string[], submit: (m: typeof th) => string]

/** Each screen: its server HTML, the fields whose values must never reach an address, and its submit button's words */
const SCREENS: readonly Screen[] = [
  ['/login', (l) => html(<LoginForm />, l), ['email', 'password'], (m) => m.auth.login.submit],
  ['/login?next= (back to an e-mailed link after signing in)', (l) => html(<LoginForm next="/tasks/00000000-0000-4000-8000-000000000001" />, l), ['email', 'password'], (m) => m.auth.login.submit],
  ['/login/2fa', (l) => html(<TwoFactorForm />, l), ['code'], (m) => m.auth.twoFactor.submit],
  ['/forgot-password', (l) => html(<ForgotForm />, l), ['email'], (m) => m.auth.forgot.submit],
  ['/reset-password?token=', (l) => html(<ResetForm token="e2e-not-a-token" min={PASSWORD_MIN_LENGTH} max={PASSWORD_MAX_LENGTH} />, l), ['password', 'confirm'], (m) => m.auth.reset.submit],
  ['/invite/[token]', (l) => html(<InviteForm token="e2e-not-a-token" min={PASSWORD_MIN_LENGTH} accept={never} />, l), ['password', 'confirm'], (m) => m.auth.invite.submit],
  ['the authenticator setup of the workspace', (l) => html(<TwoFactorSetup />, l), ['password'], (m) => m.auth.security.start],
  ['/liff/link (the sign-in inside LIFF)', (l) => html(<LiffSignIn />, l), ['email', 'password'], (m) => m.auth.login.submit],
]

describe('[FR-AUTH-001/AC1] [FR-AUTH-002/AC1] [NFR-SEC-09] in the server’s HTML, no sign-in form can send what was typed', () => {
  it.each(SCREENS)('%s: the form posts to its own address, and its submit button waits for the script', (_, markup, fields, submit) => {
    for (const locale of ['th', 'en'] as const) {
      const page = markup(locale)
      const forms = formsOf(page)
      expect(forms).toHaveLength(1)
      const [form] = forms
      expect(attr(form!.tag, 'method')).toBe('post')
      expect(attr(form!.tag, 'action')).toBeUndefined()
      const submits = tagsOf(form!.body, /<button[^>]*\btype="submit"[^>]*>[^<]*<\/button>/g)
      expect(submits).toHaveLength(1)
      expect(isDisabled(submits[0]!), submits[0]).toBe(true)
      expect(submits[0]).toContain(`>${submit(locale === 'th' ? th : (en as unknown as typeof th))}</button>`)
      // Every field whose value must stay out of an address is in that form, and takes typing while the page loads
      for (const name of fields) {
        const inputs = tagsOf(page, new RegExp(`<input[^>]*\\bname="${name}"[^>]*>`, 'g'))
        expect(inputs, name).toHaveLength(1)
        expect(form!.body).toContain(inputs[0])
        expect(isDisabled(inputs[0]!), name).toBe(false)
      }
      // Any other button waits for the script too (the switch to a backup code): a press before it runs would be lost
      for (const button of tagsOf(page, /<button\b[^>]*>/g)) expect(isDisabled(button), button).toBe(true)
    }
  })

  it('the second step of the sign-in offers its switch to a backup code only once the script runs', () => {
    const page = html(<TwoFactorForm />)
    const toggle = page.match(/<button[^>]*\btype="button"[^>]*>([^<]*)<\/button>/)
    expect(toggle?.[1]).toBe(th.auth.twoFactor.useBackup)
    expect(isDisabled(toggle![0])).toBe(true)
  })
})
