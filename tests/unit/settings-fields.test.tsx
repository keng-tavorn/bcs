import { NextIntlClientProvider } from 'next-intl'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { LineChannelPanel } from '@/ui/admin-line/line-channel-panel'
import type { LineChannelView } from '@/ui/admin-line/types'
import { LineLinkPanel, type LineLinkStatusView } from '@/ui/settings-line/line-link-panel'
import { NewPinField } from '@/ui/settings-pin/new-pin-field'
import { PinSetup } from '@/ui/settings-pin/pin-setup'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// The fields and states of the wave-4 settings screens, as the server renders them (no DOM here; the pages run with axe
// in tests/e2e/settings-*.spec.ts and admin-line.spec.ts):
//  - the new PIN (/settings/pin) and the LINE channel secret and access token (/admin/line) are never offered to the
//    browser's password manager: not "new-password" (which offers a generated password, and to save the value as the
//    account's password) but a one-time code with the opt-outs of 1Password, LastPass, Bitwarden and Dashlane; the PIN
//    field has no maxLength, which would cut a pasted PIN before its digits are picked out;
//  - nothing is sent before the page's script runs: the forms that carry a password or a secret post, and their submit
//    button is disabled in the server's HTML (src/ui/form/hydrated.ts), so a native submission can never write them
//    into the page's address (NFR-SEC-09);
//  - /admin/line says under the test and the rich-menu buttons why each waits, in that button's own words;
//  - /settings/line lets a linked member unlink from the web whatever the state of the organization's LINE, says that
//    e-mail is used meanwhile only while LINE is switched off (LINE on but not set up here still delivers), and links to
//    "ลืมรหัสผ่าน" as the LINE_LINKED notice says;
//  - /settings/pin offers only the ways of proving who you are that work for the member (PinStatusDto.proofMethods).

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined, replace: () => undefined }) }))

const html = (node: ReactNode, locale: 'th' | 'en' = 'th') =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === 'th' ? th : en} timeZone="Asia/Bangkok">
      {node}
    </NextIntlClientProvider>,
  )
const messagesOf = (locale: 'th' | 'en') => (locale === 'th' ? th : en)

/** The opening tag of the input with this id */
function inputTag(markup: string, id: string): string {
  const tag = markup.match(new RegExp(`<input[^>]*\\bid="${id}"[^>]*>`))?.[0]
  expect(tag, id).toBeDefined()
  return tag!
}

/** An attribute's value in an opening tag; HTML attribute names are case-insensitive (React writes autoComplete as is) */
function attr(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`\\s${name}="([^"]*)"`, 'i'))?.[1]
}

/** Masked, and kept away from password managers: a one-time code, with the opt-outs of 1Password, LastPass, Bitwarden and Dashlane */
function expectNoPasswordManager(tag: string) {
  expect(attr(tag, 'type')).toBe('password')
  expect(attr(tag, 'autocomplete')).toBe('one-time-code')
  expect(attr(tag, 'data-1p-ignore')).toBe('')
  expect(attr(tag, 'data-lpignore')).toBe('true')
  expect(attr(tag, 'data-bwignore')).toBe('true')
  expect(attr(tag, 'data-form-type')).toBe('other')
  expect(tag).not.toContain('new-password')
  expect(tag).not.toContain('current-password')
}

/** The opening tag of the form whose submit sends the page's secrets, its submit button's opening tag, and that button's words */
function formAndSubmit(markup: string, formStart: RegExp): { readonly form: string; readonly submit: string; readonly submitText: string } {
  const at = markup.search(formStart)
  expect(at, String(formStart)).toBeGreaterThanOrEqual(0)
  const rest = markup.slice(at)
  const form = rest.match(/^<form[^>]*>/)![0]
  const inside = rest.slice(0, rest.indexOf('</form>'))
  const button = inside.match(/(<button[^>]*\stype="submit"[^>]*>)([\s\S]*?)<\/button>/)
  expect(button, 'the submit button').not.toBeNull()
  return { form, submit: button![1]!, submitText: button![2]! }
}

const VIEW: LineChannelView = {
  configured: true,
  webhookUrl: 'https://bcs.example/api/webhooks/line/AbCdEfGhIjKlMnOpQrStUvWx',
  providerId: '1650000021',
  messagingChannelId: '1650000022',
  channelSecret: { set: true, readable: true },
  channelAccessToken: { set: true, readable: true },
  liffId: '1650000023-AbCdEfGh',
  liffChannelId: '1650000023',
  active: true,
  richMenus: true,
  version: 3,
}
const NOT_SAVED: LineChannelView = {
  configured: false,
  webhookUrl: null,
  providerId: '',
  messagingChannelId: '',
  channelSecret: { set: false, readable: false },
  channelAccessToken: { set: false, readable: false },
  liffId: '',
  liffChannelId: '',
  active: false,
  richMenus: false,
  version: null,
}
/** An action that never answers: only the first render is looked at */
const never = () => new Promise<never>(() => undefined)
const channelPanel = (view: LineChannelView, locale: 'th' | 'en' = 'th') =>
  html(<LineChannelPanel initial={view} testSeconds={10} save={never} test={never} replaceMenus={never} />, locale)

describe('[FR-AUTH-005/AC1] the new PIN is never offered to the browser as a password', () => {
  it('is a masked field on the number keypad that password managers leave alone, with no maxLength to cut a pasted PIN short', () => {
    const tag = inputTag(html(<NewPinField id="pin-new" name="pin" label="PIN" value="" onChange={() => undefined} />), 'pin-new')
    expectNoPasswordManager(tag)
    expect(attr(tag, 'inputmode')).toBe('numeric')
    // newPinDigits keeps six digits as each change comes in; a maxLength would cut "582 931" to "582 93" first
    expect(attr(tag, 'maxlength')).toBeUndefined()
  })

})

describe('[FR-AUTH-005/AC1] step 1 of /settings/pin offers only the ways of proving who you are that work for the member', () => {
  const setup = (proofMethods: ReadonlyArray<'PASSWORD' | 'TOTP'>, locale: 'th' | 'en' = 'th', hasPin = false) =>
    html(<PinSetup hasPin={hasPin} proofMethods={proofMethods} prove={never} setPin={never} />, locale)
  const radios = (markup: string) => [...markup.matchAll(/<input[^>]*\btype="radio"[^>]*>/g)].map((m) => attr(m[0], 'value'))

  it('with a password and an authenticator app: the choice of both, the password first', () => {
    for (const locale of ['th', 'en'] as const) {
      const m = messagesOf(locale).pinSettings.prove
      // In either order from the server, the screen offers them in its own
      const markup = setup(['TOTP', 'PASSWORD'], locale)
      expect(markup).toContain(m.intro)
      expect(markup).toMatch(/<fieldset[^>]*><legend[^>]*>/)
      expect(radios(markup)).toEqual(['PASSWORD', 'TOTP'])
      expect(attr(markup.match(/<input[^>]*\bvalue="PASSWORD"[^>]*>/)![0], 'checked')).toBe('')
      // The account password itself is still the browser's to fill in
      expect(attr(inputTag(markup, 'pin-password'), 'autocomplete')).toBe('current-password')
      expect(markup).not.toContain('id="pin-code"')
    }
  })

  it('with a password only: no choice and no word of an authenticator app, the password field alone', () => {
    for (const locale of ['th', 'en'] as const) {
      const m = messagesOf(locale).pinSettings.prove
      const markup = setup(['PASSWORD'], locale)
      expect(markup).toContain(m.introOnly.PASSWORD)
      expect(markup).not.toContain(m.intro)
      expect(markup).not.toContain('<fieldset')
      expect(radios(markup)).toEqual([])
      expect(markup).not.toContain(m.TOTP)
      expect(attr(inputTag(markup, 'pin-password'), 'type')).toBe('password')
      expect(markup).not.toContain('id="pin-code"')
    }
  })

  it('with an authenticator app only: the code field alone', () => {
    for (const locale of ['th', 'en'] as const) {
      const m = messagesOf(locale).pinSettings.prove
      const markup = setup(['TOTP'], locale)
      expect(markup).toContain(m.introOnly.TOTP)
      expect(radios(markup)).toEqual([])
      expect(attr(inputTag(markup, 'pin-code'), 'autocomplete')).toBe('one-time-code')
      expect(markup).not.toContain('id="pin-password"')
    }
  })

  it('with neither: says so and what to do, and offers no step that would be refused — with or without a PIN', () => {
    for (const locale of ['th', 'en'] as const) {
      for (const hasPin of [false, true]) {
        const markup = setup([], locale, hasPin)
        expect(markup).toContain(messagesOf(locale).pinSettings.prove.noMethod)
        expect(markup).not.toContain('<form')
        expect(markup).not.toContain('<input')
        expect(markup).not.toContain('<button')
      }
    }
  })
})

describe('[FR-AUTH-005/AC1][NFR-SEC-09] /settings/pin sends nothing before the page runs its script', () => {
  it('step 1, in the server HTML a member without a PIN gets, posts and keeps its button disabled: the password never goes into the address', () => {
    for (const proofMethods of [['PASSWORD', 'TOTP'], ['PASSWORD'], ['TOTP']] as const) {
      const markup = html(<PinSetup hasPin={false} proofMethods={proofMethods} prove={never} setPin={never} />)
      const { form, submit, submitText } = formAndSubmit(markup, /<form[^>]*aria-labelledby="pin-prove"/)
      expect(attr(form, 'method')).toBe('post')
      // A disabled default button also stops pressing Enter in the password field from submitting the form
      expect(attr(submit, 'disabled')).toBe('')
      expect(submitText).toBe(th.pinSettings.prove.submit)
    }
  })
})

describe('[FR-ADM-006/AC2] the LINE channel secret and access token are write-only and never offered to a password manager', () => {
  it('starts both fields empty, masked and kept away from password managers', () => {
    const markup = channelPanel(VIEW)
    for (const id of ['line-channel-secret', 'line-access-token']) {
      const tag = inputTag(markup, id)
      expectNoPasswordManager(tag)
      expect(attr(tag, 'value')).toBe('')
    }
    expect(markup).not.toContain('new-password')
  })
})

describe('[FR-ADM-006/AC2][NFR-SEC-09] /admin/line sends nothing before the page runs its script', () => {
  it('the channel form posts and Save stays disabled in the server HTML: the secret and the token never go into the address', () => {
    for (const view of [VIEW, NOT_SAVED]) {
      const markup = channelPanel(view)
      const { form, submit, submitText } = formAndSubmit(markup, /<form[^>]*>(?=[\s\S]*?id="line-channel-secret")/)
      expect(attr(form, 'method')).toBe('post')
      expect(attr(submit, 'disabled')).toBe('')
      expect(submitText).toBe(th.lineSettings.save)
      // Both secret fields belong to that form
      const inside = markup.slice(markup.indexOf(form), markup.indexOf('</form>', markup.indexOf(form)))
      expect(inside).toContain('id="line-channel-secret"')
      expect(inside).toContain('id="line-access-token"')
    }
  })
})

describe('[FR-ADM-006/AC3] the connection test of /admin/line runs on saved values only, and says why it waits', () => {
  it('waits before the first save, with its reason read out with the button', () => {
    for (const locale of ['th', 'en'] as const) {
      const m = messagesOf(locale).lineSettings
      const markup = channelPanel(NOT_SAVED, locale)
      expect(markup).toContain(`<p id="line-test-blocked" class="text-base text-ink-muted md:text-sm">${m.test.notConfigured}</p>`)
      expect(markup).toMatch(/<button[^>]*disabled=""[^>]*aria-describedby="line-test-blocked"/)
    }
  })

  it('runs once the settings are saved and nothing is changed', () => {
    expect(channelPanel(VIEW)).not.toContain('line-test-blocked')
  })
})

describe('[FR-LINE-004/AC1] the rich-menu button of /admin/line makes the menus from saved values only, and says why it waits', () => {
  it('waits before the first save, in its own words read out with the button', () => {
    for (const locale of ['th', 'en'] as const) {
      const m = messagesOf(locale).lineSettings
      const markup = channelPanel(NOT_SAVED, locale)
      expect(markup).toContain(`<p id="line-menus-blocked" class="text-base text-ink-muted md:text-sm">${m.richMenus.errors.NOT_CONFIGURED}</p>`)
      expect(markup).toMatch(/<button[^>]*disabled=""[^>]*aria-describedby="line-menus-blocked"/)
    }
  })

  it('runs once the settings are saved and nothing is changed', () => {
    expect(channelPanel(VIEW)).not.toContain('line-menus-blocked')
  })
})

describe('[FR-LINE-001/AC3] a linked member can unlink from the web whatever the state of the organization LINE', () => {
  const status = (s: Partial<LineLinkStatusView>): LineLinkStatusView => ({
    available: true,
    delivering: true,
    linked: true,
    linkedAtText: '4 Oct 2026 09:15',
    reachable: true,
    canManageChannel: false,
    ...s,
  })
  const panel = (s: LineLinkStatusView, locale: 'th' | 'en' = 'th') => html(<LineLinkPanel status={s} issue={never} linkStatus={never} unlink={never} />, locale)
  const notices = (m: (typeof th)['lineLink']) => [m.status.unavailable, m.status.unavailableLinked, m.status.off, m.status.offLinked]
  /** A message as React writes it into the HTML (the English ones carry apostrophes) */
  const asHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')

  it('while LINE can be linked: the unlink is offered, LINE is said to deliver, no notice', () => {
    const markup = panel(status({}))
    expect(markup).toContain(th.lineLink.unlink.button)
    expect(markup).toContain(th.lineLink.unlink.intro)
    expect(markup).toContain(th.lineLink.status.reachable)
    for (const notice of notices(th.lineLink)) expect(markup).not.toContain(notice)
  })

  it('while the organization switched LINE off: the unlink is still offered, linking again waits for LINE, and e-mail is said to be used meanwhile — nothing of how LINE delivers', () => {
    for (const locale of ['th', 'en'] as const) {
      const m = messagesOf(locale).lineLink
      for (const reachable of [true, false]) {
        const markup = panel(status({ available: false, delivering: false, reachable }), locale)
        expect(markup).toContain(m.status.linked)
        expect(markup).toContain(m.unlink.button)
        expect(markup).toContain(m.unlink.introUnavailable)
        expect(markup).not.toContain(m.unlink.intro)
        expect(markup).toContain(m.status.offLinked)
        expect(markup).not.toContain(asHtml(m.status.reachable))
        expect(markup).not.toContain(asHtml(m.status.unreachable))
        for (const notice of notices(m).filter((n) => n !== m.status.offLinked)) expect(markup).not.toContain(notice)
      }
      expect(m.status.offLinked).toMatch(/อีเมล|e-mail/)
    }
  })

  it('while LINE is on but not set up for this system: linking waits, LINE still delivers as it did, and nothing says e-mail replaces it', () => {
    for (const locale of ['th', 'en'] as const) {
      const m = messagesOf(locale).lineLink
      for (const reachable of [true, false]) {
        const markup = panel(status({ available: false, delivering: true, reachable }), locale)
        expect(markup).toContain(m.unlink.button)
        expect(markup).toContain(m.unlink.introUnavailable)
        expect(markup).toContain(m.status.unavailableLinked)
        expect(markup).toContain(asHtml(reachable ? m.status.reachable : m.status.unreachable))
        for (const notice of notices(m).filter((n) => n !== m.status.unavailableLinked)) expect(markup).not.toContain(notice)
      }
      expect(m.status.unavailableLinked).not.toMatch(/อีเมล|e-mail/)
    }
  })

  it('a member who is not linked while LINE cannot be linked: told why — switched off, or not set up — and no code to ask for', () => {
    for (const [delivering, notice] of [
      [false, th.lineLink.status.off],
      [true, th.lineLink.status.unavailable],
    ] as const) {
      const markup = panel(status({ available: false, delivering, linked: false }))
      expect(markup).toContain(notice)
      for (const other of notices(th.lineLink).filter((n) => n !== notice)) expect(markup).not.toContain(other)
      expect(markup).not.toContain('id="line-link"')
    }
  })

  it('beside the unlink, the page a LINE_LINKED notice opens links to ลืมรหัสผ่าน, as the notice says', () => {
    for (const locale of ['th', 'en'] as const) {
      const m = messagesOf(locale)
      const markup = panel(status({}), locale)
      expect(markup).toContain(m.lineLink.unlink.notYou)
      const link = markup.match(/<a[^>]*href="\/forgot-password"[^>]*>([^<]*)<\/a>/)
      expect(link?.[1]).toBe(m.lineLink.unlink.forgotLink)
      expect(link?.[1]).toContain(m.auth.forgot.title)
    }
  })
})
