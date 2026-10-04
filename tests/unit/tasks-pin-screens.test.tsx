import { NextIntlClientProvider } from 'next-intl'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DecisionPanel, PIN_SETTINGS_HREF, TaskFailure, type DecisionKind } from '@/ui/tasks/decision-panel'
import type { ActionOutcome } from '@/ui/tasks/outcome'
import { PinField } from '@/ui/tasks/pin-field'
import { PolicyDecision } from '@/ui/tasks/policy-decision'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// S5-05 on the decision page (FR-AUTH-005 AC2 AC3), as markup (no DOM here; the page runs with axe and screenshots in
// tests/e2e/tasks.spec.ts): the PIN field is masked, on the number keypad and kept away from password managers; the
// hint over a decision that needs the PIN names only the decisions the task has (a variance is never returned,
// BR-GR-03); a locked PIN says until when and a member without a PIN is shown the way to set one; the decision bar is
// the one the page keeps room for on phones (useBarSpace). The markup is the server's HTML, which a phone shows before
// the page's script runs: no PIN can be typed or sent in it (NFR-SEC-09).

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined, replace: () => undefined }) }))

type Locale = 'th' | 'en'
const MESSAGES = { th, en } as const

const html = (node: ReactNode, locale: Locale = 'th') =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]} timeZone="Asia/Bangkok">
      {node}
    </NextIntlClientProvider>,
  )

/** The opening tag of the input with this id */
function inputTag(markup: string, id: string): string {
  const tag = markup.match(new RegExp(`<input[^>]*\\bid="${id}"[^>]*>`))?.[0]
  expect(tag, id).toBeDefined()
  return tag!
}

/** An attribute's value in an opening tag; HTML attribute names are case-insensitive (React writes autoComplete as is) */
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`, 'i'))?.[1]

/** An action that never answers: only the first render is looked at */
const never = () => new Promise<ActionOutcome>(() => undefined)

const panel = (kind: DecisionKind, stepUp: boolean, locale: Locale = 'th') =>
  html(<DecisionPanel taskId="00000000-0000-4000-8000-000000000001" open label="PR-2569-00001" amount="100,000.00" locale={locale} kind={kind} stepUp={stepUp} actions={{ decide: never }} />, locale)

describe('[FR-AUTH-005/AC2] the PIN field of a decision is masked and never offered to the browser as a password', () => {
  it('is a six-digit field on the number keypad that says it holds a one-time code, with the password managers’ opt-outs', () => {
    const tag = inputTag(html(<PinField id="pin" label="PIN" value="" onChange={() => undefined} />), 'pin')
    expect(attr(tag, 'type')).toBe('password')
    expect(attr(tag, 'inputmode')).toBe('numeric')
    expect(attr(tag, 'maxlength')).toBe('6')
    expect(attr(tag, 'autocomplete')).toBe('one-time-code')
    expect(attr(tag, 'data-1p-ignore')).toBe('')
    expect(attr(tag, 'data-lpignore')).toBe('true')
    expect(attr(tag, 'data-bwignore')).toBe('')
    expect(attr(tag, 'data-form-type')).toBe('other')
    expect(tag).not.toMatch(/new-password|current-password|autocomplete="off"/i)
  })

  it('the policy decision asks for it in both forms, the same way', () => {
    const markup = html(<PolicyDecision taskId="00000000-0000-4000-8000-000000000002" open locale="th" decide={never} />)
    const fields = [...markup.matchAll(/<input[^>]*\bname="pin"[^>]*>/g)].map((m) => m[0])
    expect(fields).toHaveLength(2)
    for (const tag of fields) expect([attr(tag, 'type'), attr(tag, 'autocomplete'), attr(tag, 'data-lpignore')]).toEqual(['password', 'one-time-code', 'true'])
  })
})

describe('[FR-AUTH-005/AC2] the hint over a decision that needs the PIN names the decisions the task has', () => {
  it.each(['th', 'en'] as const)('a variance is approved or rejected with the PIN, never returned (%s)', (locale) => {
    const variance = panel('VARIANCE', true, locale)
    expect(variance).toContain(MESSAGES[locale].tasks.decide.variance.stepUpHint)
    expect(variance).not.toContain(MESSAGES[locale].tasks.decide.stepUpHint)
    // A request and a purchase order are approved, returned or rejected with it
    for (const kind of ['REQUEST', 'PURCHASE_ORDER'] as const) {
      const markup = panel(kind, true, locale)
      expect(markup, kind).toContain(MESSAGES[locale].tasks.decide.stepUpHint)
      expect(markup, kind).not.toContain(MESSAGES[locale].tasks.decide.variance.stepUpHint)
    }
  })

  it('says nothing of the PIN below the threshold, and its decision bar is the one the page keeps room for on phones', () => {
    const below = panel('VARIANCE', false)
    expect(below).not.toContain(th.tasks.decide.variance.stepUpHint)
    expect(below).not.toContain('name="pin"')
    expect(below.match(/data-decision-bar=""/g)).toHaveLength(1)
    expect(html(<PolicyDecision taskId="00000000-0000-4000-8000-000000000002" open locale="th" decide={never} />).match(/data-decision-bar=""/g)).toHaveLength(1)
  })
})

/** Each form of the markup: its opening tag and what it holds (the forms of these screens are never nested) */
const formsOf = (markup: string) => [...markup.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)].map((m) => ({ tag: `<form${m[1]}>`, body: m[2]! }))
const tagsOf = (markup: string, pattern: RegExp) => [...markup.matchAll(pattern)].map((m) => m[0])
const isDisabled = (tag: string) => /\sdisabled=""/.test(tag)

describe('[FR-AUTH-005/AC2] [NFR-SEC-09] in the server’s HTML, before the page’s script runs, no PIN can be typed or sent', () => {
  // A form with no method is sent natively with GET to the page's address: a PIN typed and sent before the script runs
  // would land in the address bar, the browser's history, request logs and Referer headers
  const screens: ReadonlyArray<readonly [string, string]> = [
    ['a request at the threshold', panel('REQUEST', true)],
    ['a purchase order at the threshold', panel('PURCHASE_ORDER', true)],
    ['a variance at the threshold', panel('VARIANCE', true)],
    ['an authority change', html(<PolicyDecision taskId="00000000-0000-4000-8000-000000000002" open locale="th" decide={never} />)],
    ['a DOA version with a boundary table', html(<PolicyDecision taskId="00000000-0000-4000-8000-000000000003" open locale="th" boundary={{ tableId: 'boundary-table', baselineId: null }} decide={never} />)],
    ['a request below the threshold (no PIN)', panel('REQUEST', false)],
  ]

  it.each(screens)('%s: every form posts, and its submit button waits for the script', (_, markup) => {
    const forms = formsOf(markup)
    expect(forms.length).toBeGreaterThan(0)
    for (const form of forms) {
      expect(attr(form.tag, 'method'), form.tag).toBe('post')
      expect(attr(form.tag, 'action'), form.tag).toBeUndefined()
      const submits = tagsOf(form.body, /<button[^>]*\btype="submit"[^>]*>/g)
      expect(submits.length, form.tag).toBeGreaterThan(0)
      // A disabled default button also stops Enter in a field from sending the form (implicit submission)
      for (const button of submits) expect(isDisabled(button), button).toBe(true)
    }
    // No other button either: a press before the script runs would be lost (the second press of approve is drawn by it)
    for (const button of tagsOf(markup, /<button\b[^>]*>/g)) expect(isDisabled(button), button).toBe(true)
  })

  it.each(screens.filter(([name]) => !name.includes('no PIN')))('%s: the PIN field takes nothing until the script runs, in a form that posts', (_, markup) => {
    const pins = tagsOf(markup, /<input[^>]*\bname="pin"[^>]*>/g)
    expect(pins.length).toBeGreaterThan(0)
    for (const tag of pins) expect(isDisabled(tag), tag).toBe(true)
    const withPin = formsOf(markup).filter((form) => /\bname="pin"/.test(form.body))
    expect(withPin).toHaveLength(pins.length)
    for (const form of withPin) expect(attr(form.tag, 'method')).toBe('post')
    // Nothing outside a form holds a PIN
    expect(formsOf(markup).reduce((n, form) => n + tagsOf(form.body, /<input[^>]*\bname="pin"[^>]*>/g).length, 0)).toBe(pins.length)
  })
})

describe('[FR-AUTH-005/AC2] [FR-AUTH-005/AC3] a refused PIN says what happened and what to do', () => {
  it.each(['th', 'en'] as const)('no PIN yet: the message and the way to /settings/pin (%s)', (locale) => {
    const markup = html(<TaskFailure failure={{ ok: false, code: 'STEP_UP_REQUIRED', reason: 'PIN_NOT_SET' }} text={MESSAGES[locale].tasks.errors.PIN_NOT_SET} />, locale)
    expect(markup).toContain(MESSAGES[locale].tasks.errors.PIN_NOT_SET)
    expect(markup).toMatch(new RegExp(`<a[^>]*href="${PIN_SETTINGS_HREF}"[^>]*>${MESSAGES[locale].tasks.errors.PIN_NOT_SET_LINK}</a>`))
    expect(PIN_SETTINGS_HREF).toBe('/settings/pin')
  })

  it('a locked PIN says until when, and offers no link (the lock ends by itself, or with a new PIN)', () => {
    const text = th.tasks.errors.PIN_LOCKED.replace('{time}', '14:15')
    const markup = html(<TaskFailure failure={{ ok: false, code: 'STEP_UP_LOCKED', time: '2026-10-05T07:15:00.000Z' }} text={text} />)
    expect(markup).toContain('ใส่ PIN ผิด 5 ครั้งติดกัน PIN ถูกล็อกถึง 14:15')
    expect(markup).not.toContain('<a')
  })
})
