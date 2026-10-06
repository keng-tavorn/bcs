import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { BrowserContext, Locator, Page, TestInfo } from '@playwright/test'
import { localeCookieName } from '../../src/i18n/locales'
import { E2E_BASE_URL, e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'
import { anotherPhone, liffBudgetScene, liffScene, newLineUserId, openAsLineUser, sceneTag, type SceneMember } from './liff-support'

// NFR-I18N-01 · FR-PLT-002 AC2 · §9.4: a LIFF page passes its client components only the messages they read
// (src/i18n/client-messages.ts), and the browser formats messages compiled when the app was built (next.config.ts). A
// namespace a page's provider does not pass shows its key instead of the words (next-intl's fallback, `namespace.key`)
// and logs MISSING_MESSAGE; a provider that passed the other language's words would show those. This spec opens the
// LIFF pages a LINE account reaches — not linked; linked as a requester, with a request and a draft; an approver with a
// task; a receiver with a PO — in Thai and in English, finds no key, finds words of the page's own client components in
// the language asked for and not in the other, and keeps a screenshot of each (tests/unit/client-messages.test.ts
// checks the messages of every client component without a browser).

type Catalogue = Record<string, unknown>
const CATALOGUES: Readonly<Record<'th' | 'en', Catalogue>> = {
  th: JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../messages/th.json'), 'utf8')) as Catalogue,
  en: JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../messages/en.json'), 'utf8')) as Catalogue,
}
const NAMESPACES = Object.keys(CATALOGUES.th)
/** A message key where words should be: a namespace of the catalogue, then dot-separated names */
const KEY = new RegExp(`(?<![\\w.@/:-])(?:${NAMESPACES.join('|')})\\.[A-Za-z][\\w]*(?:\\.[\\w]+)*`, 'g')

/** The words of a message without arguments in one language */
function say(locale: 'th' | 'en', key: string): string {
  const words = key.split('.').reduce<unknown>((node, name) => (node && typeof node === 'object' ? (node as Catalogue)[name] : undefined), CATALOGUES[locale])
  if (typeof words !== 'string' || words.includes('{')) throw new Error(`${key} is not a message without arguments in ${locale}`)
  return words
}

type Ready = (page: Page, locale: 'th' | 'en') => Locator

interface Screen {
  readonly name: string
  readonly path: string
  readonly ready: Ready
  /** Messages the page shows, of its client components where it has any: in the language asked for, never the other */
  readonly words: readonly string[]
}

/** The pages of a LINE account that is not linked, each with something on it that shows the page is up */
const UNLINKED: readonly Screen[] = [
  { name: 'help', path: '/liff/help', ready: (page) => page.locator('#help-menu'), words: ['liff.help.title'] },
  { name: 'link-sign-in', path: '/liff/link', ready: (page) => page.locator('input[type="email"]'), words: ['auth.login.email', 'auth.login.submit'] },
]

/** The pages of a linked requester: the request and the draft are theirs (requesterScreens) */
const LINKED: readonly Screen[] = [
  { name: 'help-member', path: '/liff/help', ready: (page) => page.locator('section[aria-labelledby="help-contact"] li').first(), words: ['liff.help.title'] },
  { name: 'link-linked', path: '/liff/link', ready: (page) => page.locator('main button').first(), words: ['liff.link.linked.unlink'] },
  { name: 'tasks-empty', path: '/liff/tasks', ready: (page) => page.locator('main a[href="/liff/track"]'), words: ['tasks.empty'] },
  { name: 'track', path: '/liff/track', ready: (page) => page.locator('main a[href="/liff/requests/new"]').first(), words: ['liffRequests.track.newRequest'] },
  { name: 'catalog', path: '/liff/requests/new', ready: (page) => page.locator('a[href="/liff/requests/new/BUY_GOODS"]'), words: ['request.catalog.search'] },
  { name: 'form', path: '/liff/requests/new/BUY_GOODS', ready: (page) => page.locator('main input').first(), words: ['requestForm.details.title', 'requestForm.steps.details'] },
  { name: 'delegation', path: '/liff/delegation', ready: (page) => page.locator('#liff-delegation-received'), words: ['delegation.receivedTitle'] },
]

/** The requester's own request waiting for approval, and their draft at the address its first save gave it */
const requesterScreens = (sent: { requestId: string; number: string }, draft: { requestId: string }): readonly Screen[] => [
  {
    name: 'request',
    path: `/liff/requests/${sent.requestId}`,
    ready: (page) => page.locator('main summary'),
    words: ['requestView.actions.cancelTitle'],
  },
  { name: 'edit', path: `/liff/requests/${draft.requestId}/edit`, ready: (page) => page.locator('main input').first(), words: ['requestForm.details.title'] },
]

async function inLocale(context: BrowserContext, locale: 'th' | 'en') {
  await context.addCookies([{ name: localeCookieName, value: locale, url: E2E_BASE_URL }])
}

/** next-intl's errors in the browser's console: a message the page's provider does not have */
function watchMissing(page: Page): string[] {
  const missing: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error' && /MISSING_MESSAGE|INSUFFICIENT_PATH|INVALID_MESSAGE/.test(message.text())) missing.push(message.text())
  })
  return missing
}

/** The page shows words, no message key, in the language asked for and not in the other; a full-page screenshot is kept */
async function expectWords(page: Page, testInfo: TestInfo, locale: 'th' | 'en', screen: Screen, missing: string[]) {
  await page.goto(screen.path)
  await expect(screen.ready(page, locale)).toBeVisible()
  await page.waitForLoadState('networkidle')
  await expect(page.locator('html')).toHaveAttribute('lang', locale)
  const text = await page.locator('body').innerText()
  expect(text.match(KEY) ?? [], `${locale} ${screen.path}`).toEqual([])
  // Thai pages are in Thai script; both carry the page's own words in their language
  if (locale === 'th') expect(text, `${locale} ${screen.path}`).toMatch(/[฀-๿]/)
  const other = locale === 'th' ? 'en' : 'th'
  for (const key of screen.words) {
    expect(text, `${locale} ${screen.path}: ${key}`).toContain(say(locale, key))
    // A short word may also be part of a name of the organization: the other language is looked for in longer ones
    if (say(other, key).length >= 10) expect(text, `${locale} ${screen.path}: ${key} in ${other}`).not.toContain(say(other, key))
  }
  expect(missing, `${locale} ${screen.path}`).toEqual([])
  await page.screenshot({ path: testInfo.outputPath(`liff-${locale}-${screen.name}.png`), fullPage: true })
}

/** Runs a scene script of tests/e2e against the e2e database: the JSON of its last line (on failure only its errors) */
function scene<T>(script: string, args: readonly string[], env: Record<string, string> = {}): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/${script} ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv(), ...env } })
  if (r.status !== 0) throw new Error(`${script} ${args[0] ?? ''} failed:\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}

for (const locale of ['th', 'en'] as const) {
  test.describe(`[NFR-I18N-01] [FR-PLT-002/AC2] [§9.4] the LIFF pages in ${locale === 'th' ? 'Thai' : 'English'}: their own words, never a message key`, () => {
    test('a LINE account that is not linked: help and the e-mail sign-in', async ({ page, context }, testInfo) => {
      await inLocale(context, locale)
      await openAsLineUser(context, newLineUserId())
      const missing = watchMissing(page)
      for (const screen of UNLINKED) await expectWords(page, testInfo, locale, screen, missing)
    })

    test('a linked requester: help, the link, tasks, the list, the catalogue, the form, the delegation, their request and their draft', async ({ page, context }, testInfo) => {
      test.setTimeout(180_000)
      const lineUserId = newLineUserId()
      const tag = sceneTag(`words-${locale}`)
      const { member } = liffScene<{ member: SceneMember }>('linked', tag, lineUserId)
      const sent = liffBudgetScene<{ requestId: string; number: string }>('sent', member.id, '3', tag)
      const draft = liffBudgetScene<{ requestId: string }>('draft', member.id, '3', tag)
      await inLocale(context, locale)
      await openAsLineUser(context, lineUserId)
      const missing = watchMissing(page)
      for (const screen of [...LINKED, ...requesterScreens(sent, draft)]) await expectWords(page, testInfo, locale, screen, missing)
    })

    test('an approver with a task to decide, and a receiver with a PO to receive', async ({ page, context, browser }, testInfo) => {
      test.setTimeout(300_000)
      // The approver: the VP of the operations division of a twin of the demo organization, linked to the first LINE user
      const lines = Array.from({ length: 6 }, () => newLineUserId())
      const twin = scene<{ orgCode: string }>('liff-tasks-scene.ts', ['twin', ...lines])
      const task = scene<{ taskId: string }>('liff-tasks-scene.ts', ['request', twin.orgCode, '100000.00', 'generator'])
      await inLocale(context, locale)
      await openAsLineUser(context, lines[0]!)
      const missing = watchMissing(page)
      await expectWords(
        page,
        testInfo,
        locale,
        { name: 'task', path: `/liff/tasks/${task.taskId}`, ready: (p, l) => p.getByRole('region', { name: say(l, 'tasks.decide.title') }), words: ['tasks.decide.approve', 'tasks.decide.otherTitle'] },
        missing,
      )
      // The receiver of a sent PO, in a LINE app of its own
      const receiving = scene<{ poId: string; receiver: string }>('receiving-scene.ts', [], { SCENE_MODE: 'demo', SCENE_RUN: `w${Date.now().toString(36)}${randomBytes(2).toString('hex')}` })
      const receiverLine = newLineUserId()
      scene('liff-gr-scene.ts', ['link', receiving.receiver, receiverLine])
      const phone = await anotherPhone(browser)
      try {
        await inLocale(phone, locale)
        await openAsLineUser(phone, receiverLine)
        const gr = await phone.newPage()
        const grMissing = watchMissing(gr)
        await expectWords(
          gr,
          testInfo,
          locale,
          { name: 'gr', path: `/liff/gr/${receiving.poId}`, ready: (p, l) => p.getByRole('button', { name: say(l, 'receiving.form.toReview') }), words: ['receiving.form.toReview'] },
          grMissing,
        )
      } finally {
        await phone.close()
      }
    })
  })
}
