import { NextIntlClientProvider } from 'next-intl'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { LiffProvider } from '@/ui/liff/liff-provider'
import { LiffTaskDecision, type LiffDecisionKind } from '@/ui/liff/tasks/decision'
import { LiffPolicyDecision } from '@/ui/liff/tasks/policy-decision'
import type { LiffTaskResult } from '@/ui/liff/tasks/result'
import type { LiffTaskAction } from '@/ui/liff/tasks/shared'
import { LiffTaskList } from '@/ui/liff/tasks/task-list'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// S5-06 · the LIFF task pages as markup (FR-LINE-003 AC1 AC2, FR-AUTH-005 AC2, FR-DOA-009 AC3, NFR-SEC-09, §9.3, §9.4):
// the server's HTML, which a phone in the LINE app shows before the page's script runs. Every form posts, and its button
// and PIN field wait for the script — no PIN can be typed or sent into an address (src/ui/form/hydrated.ts). A task below
// the stepUpThreshold asks for no PIN; at or above it both the second press of approve and the return-or-reject form do;
// a DOA version's bar holds the tick of its boundary table above the PIN. A LINE card's ?action= opens with its choice
// ready and decides nothing. The pages themselves run with axe and screenshots in tests/e2e/liff-tasks.spec.ts.

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined, replace: () => undefined, push: () => undefined }) }))

const MESSAGES = { th, en } as const
type Locale = keyof typeof MESSAGES
const TASK = '00000000-0000-4000-8000-000000000001'

const html = (node: ReactNode, locale: Locale = 'th') =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]} timeZone="Asia/Bangkok">
      <LiffProvider config={{ liffId: null, mock: null, session: 'liff' }}>{node}</LiffProvider>
    </NextIntlClientProvider>,
  )

/** An action that never answers: only the first render is looked at */
const never = () => new Promise<LiffTaskResult>(() => undefined)

const decision = (options: { kind?: LiffDecisionKind; stepUp?: boolean; open?: boolean; initial?: LiffTaskAction | null; locale?: Locale } = {}) =>
  html(
    <LiffTaskDecision
      taskId={TASK}
      open={options.open ?? true}
      kind={options.kind ?? 'REQUEST'}
      label="PR-2569-00012"
      amount="100,000.00"
      stepUp={options.stepUp ?? false}
      pinLength={6}
      initial={options.initial ?? null}
      pinSettingsHref="/settings/pin"
      helpHref="/liff/help"
      decide={never}
      {...((options.kind ?? 'REQUEST') === 'REQUEST' ? { ask: never } : {})}
    >
      <p>รายละเอียดของงาน</p>
    </LiffTaskDecision>,
    options.locale,
  )

const policy = (boundary: { tableId: string; baselineId: string | null } | null, initial: LiffTaskAction | null = null) =>
  html(
    <LiffPolicyDecision taskId={TASK} open boundary={boundary} pinLength={6} initial={initial} pinSettingsHref="/settings/pin" helpHref="/liff/help" decide={never}>
      <p>รายละเอียดของงาน</p>
    </LiffPolicyDecision>,
  )

const forms = (markup: string) => [...markup.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)].map((m) => m[0])
const openingTag = (form: string) => form.match(/^<form\b[^>]*>/)![0]
const pinFields = (markup: string) => [...markup.matchAll(/<input[^>]*\bname="pin"[^>]*>/g)].map((m) => m[0])
const buttons = (markup: string) => [...markup.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map((m) => m[0])
const disabled = (tag: string) => /\sdisabled=""/.test(tag)
/** The value of the decision radio that is chosen */
const checkedChoice = (markup: string) =>
  [...markup.matchAll(/<input[^>]*type="radio"[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => /\schecked=""/.test(tag))
    .map((tag) => tag.match(/value="([^"]*)"/)?.[1])

describe('[NFR-SEC-09] [FR-AUTH-005/AC2] before the page’s script runs, no PIN can be typed or sent', () => {
  it.each([
    ['a request at the threshold, opened from a card to approve', () => decision({ stepUp: true, initial: 'approve' }), 2],
    ['a request at the threshold', () => decision({ stepUp: true }), 1],
    ['a purchase order at the threshold', () => decision({ kind: 'PURCHASE_ORDER', stepUp: true, initial: 'approve' }), 2],
    ['a DOA version with its boundary table', () => policy({ tableId: 'doa-boundaries', baselineId: '00000000-0000-4000-8000-0000000000aa' }), 2],
    ['an authority change', () => policy(null), 2],
  ])('%s: every form posts to the page, its PIN field and its buttons are off', (_name, render, pins) => {
    const markup = render()
    expect(pinFields(markup)).toHaveLength(pins)
    for (const field of pinFields(markup)) {
      expect(disabled(field), field).toBe(true)
      expect(field).toMatch(/type="password"/)
      expect(field).toMatch(/autocomplete="one-time-code"/i)
    }
    const all = forms(markup)
    expect(all.length).toBeGreaterThan(0)
    for (const form of all) {
      expect(openingTag(form)).toMatch(/method="post"/)
      expect(openingTag(form)).not.toMatch(/\saction=/)
      for (const button of buttons(form).filter((b) => /type="submit"/.test(b))) expect(disabled(button), button).toBe(true)
    }
  })

  it('the approve button waits for the script too: a press before it would be lost', () => {
    const approve = buttons(decision({ stepUp: true })).find((b) => b.includes(`>${th.tasks.decide.approve}<`))
    expect(approve).toBeDefined()
    expect(disabled(approve!)).toBe(true)
  })
})

describe('[FR-LINE-003/AC1] [FR-DOA-004/AC1] the decision of a task on its LIFF page', () => {
  it('below the threshold: approve in the bar asks no PIN; return or reject with a reason and a tick; asking the requester', () => {
    const markup = decision()
    expect(pinFields(markup)).toEqual([])
    expect(markup).not.toContain(th.tasks.decide.stepUpHint)
    // The bar at the bottom of the screen: approve, and the way to the other decisions
    expect(markup).toMatch(/<section aria-label="ตัดสินงานนี้" class="sticky bottom-0/)
    expect(markup).toContain(`href="#other-decisions"`)
    expect(markup).toContain(th.tasks.decide.otherLink)
    // Return or reject: a choice, a reason, a tick; return is the default, as on the web
    expect(markup).toContain(`id="other-decisions"`)
    expect(checkedChoice(markup)).toEqual(['RETURN'])
    expect(markup).toContain(th.tasks.decide.reason)
    expect(markup).toContain(th.tasks.decide.confirmDecision)
    // Asking the requester, apart from deciding
    expect(markup).toContain(th.tasks.decide.askTitle)
    expect(markup).toContain(th.tasks.decide.askSubmit)
  })

  it('[FR-LINE-003/AC2] at or above the threshold: the hint, and the PIN in the second press and in the return-or-reject form', () => {
    const markup = decision({ stepUp: true, initial: 'approve' })
    expect(markup).toContain(th.tasks.decide.stepUpHint)
    expect(markup).toContain('อนุมัติ PR-2569-00012 ยอดรวม VAT 100,000.00 บาท เปลี่ยนการตัดสินภายหลังไม่ได้')
    expect(markup).toContain(th.tasks.decide.confirm)
    expect(pinFields(markup)).toHaveLength(2)
  })

  it('[§9.3] a card’s ?action=reject opens with reject chosen; approve opens the second press — and neither decides by itself', () => {
    expect(checkedChoice(decision({ initial: 'reject' }))).toEqual(['REJECT'])
    // Without ?action=approve the bar shows approve, not the confirmation
    expect(decision()).not.toContain(th.tasks.decide.confirm)
    expect(decision({ initial: 'approve' })).toContain(th.tasks.decide.confirm)
  })

  it('a variance is approved or rejected, never returned, and not asked about; a PO is not asked about', () => {
    const variance = decision({ kind: 'VARIANCE', stepUp: true })
    expect(variance).not.toMatch(/value="RETURN"/)
    expect(variance).toContain(th.tasks.decide.variance.noReturn)
    expect(variance).toContain(th.tasks.decide.variance.stepUpHint)
    expect(variance).not.toContain(th.tasks.decide.askTitle)
    expect(decision({ kind: 'PURCHASE_ORDER' })).not.toContain(th.tasks.decide.askTitle)
  })

  it('a task that no longer waits for this member shows its details only: no bar, no form', () => {
    const markup = decision({ open: false, stepUp: true })
    expect(markup).toContain('รายละเอียดของงาน')
    expect(forms(markup)).toEqual([])
    expect(markup).not.toContain('sticky bottom-0')
  })

  it('speaks English to an English reader', () => {
    expect(decision({ locale: 'en' })).toContain(en.tasks.decide.otherLink)
  })

  it.each(['th', 'en'] as const)('[§9.9] the return-or-reject section names its choice once on screen: its heading says it, the group keeps its name for screen readers only, as on the web (%s)', (locale) => {
    const decide = MESSAGES[locale].tasks.decide
    for (const [kind, title] of [
      ['REQUEST', decide.otherTitle],
      ['PURCHASE_ORDER', decide.po.otherTitle],
    ] as const) {
      const markup = decision({ kind, locale })
      expect(markup, kind).toMatch(new RegExp(`<h2 id="other-decisions" [^>]*>${title}</h2>`))
      expect(markup, kind).toMatch(new RegExp(`<fieldset [^>]*><legend class="sr-only">${decide.choice}</legend><label`))
    }
    // A variance is rejected or approved: no choice, no group
    expect(decision({ kind: 'VARIANCE', locale })).not.toContain('<fieldset')
  })
})

describe('[FR-DOA-009/AC3] [BR-DOA-15] a DOA version’s bar holds the tick of its boundary table above the PIN', () => {
  it('shows the tick when the page shows the table, and none for an authority change', () => {
    const doa = policy({ tableId: 'doa-boundaries', baselineId: null })
    expect(doa).toContain(th.tasks.policy.boundaryConfirm)
    expect(doa).toContain('href="#doa-boundaries"')
    expect(doa.indexOf(th.tasks.policy.boundaryConfirm)).toBeLessThan(doa.lastIndexOf('name="pin"'))
    expect(policy(null)).not.toContain(th.tasks.policy.boundaryConfirm)
  })

  it('approve or reject only, each with the PIN; reject in its own section, outlined in danger', () => {
    const markup = policy(null)
    expect(markup).toContain(th.tasks.policy.stepUpHint)
    expect(markup).not.toMatch(/type="radio"/)
    expect(markup).toContain(`id="reject-policy"`)
    const reject = buttons(markup).find((b) => b.includes(`>${th.tasks.policy.reject}<`))
    expect(reject).toMatch(/border-danger/)
  })
})

describe('[FR-LINE-003/AC1] [§9.4] the task list on a phone', () => {
  it('each row links to its LIFF decision page with a 44 px target, the amount in tabular digits and the overdue mark in words', () => {
    const markup = html(
      <LiffTaskList
        label={th.tasks.listLabel}
        rows={[
          {
            id: TASK,
            href: `/liff/tasks/${TASK}`,
            title: 'PR-2569-00012 · วัสดุก่อสร้าง',
            meta: 'สมชาย ใจดี · ฝ่ายก่อสร้าง',
            amount: '45,000.00',
            amountLabel: th.tasks.item.amountLabel,
            amountUnit: 'บาท',
            states: [{ kind: 'overdue', text: 'เกินกำหนดแล้ว ครบกำหนดเมื่อ 5 ต.ค. 2569 17:00 น.' }],
            tags: [th.tasks.item.stepUp],
          },
        ]}
      />,
    )
    expect(markup).toMatch(new RegExp(`<a href="/liff/tasks/${TASK}" class="[^"]*min-h-11`))
    expect(markup).toMatch(/class="money[^"]*">45,000\.00<span class="sr-only"> บาท<\/span>/)
    expect(markup).toContain('เกินกำหนดแล้ว ครบกำหนดเมื่อ')
    expect(markup).toContain(th.tasks.item.stepUp)
    // Rows separated by rules, not cards
    expect(markup).toMatch(/<ul aria-label="งานรออนุมัติของคุณ" class="flex flex-col divide-y divide-line border-y border-line"/)
  })
})
