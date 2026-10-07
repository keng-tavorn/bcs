import AxeBuilder from '@axe-core/playwright'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { devices, type Browser, type BrowserContext, type Page, type Response, type TestInfo } from '@playwright/test'
import { deriveSeedTotpSecret, totp } from '../../src/lib/totp'
import { LIFF_MOCK_USER_COOKIE } from '../../src/app/liff/_lib/mock-cookie'
import { E2E_BASE_URL, E2E_FAKE_LINE_URL, e2eEnv } from '../support/e2e-env'
import { expect } from './fixtures'

// Shared steps of the LIFF e2e specs (liff-shell.spec.ts, liff-link.spec.ts; S5-06, §9.4): which LINE user a LIFF page
// stands for (LIFF_MOCK: the mock cookie; the ID token then comes from the fake LINE server of the run and the sign-in is
// the real one), another phone in the same test, the scene that builds members and link codes through the services
// (liff-scene.ts), what the fake LINE server received, the §9.9 checks of one screen (axe, no sideways scroll, 44 px
// touch targets, screenshots at the project's width and at 1440 px) and the first JavaScript a LIFF page loads (§9.4: at
// most 200 KB gzip, the page data written into its HTML included).

export interface SceneMember {
  readonly id: string
  readonly email: string
  readonly employeeCode: string
  readonly nameTh: string
  readonly nameEn: string
  readonly organizationName: string
}

/** A LINE user id as LINE makes them: U and 32 hexadecimal digits, new for every test */
export const newLineUserId = () => `U${randomBytes(16).toString('hex')}`

/** A tag of its own for every scene a test asks for (the members of a run never meet) */
export const sceneTag = (what: string) => `${what}-${randomBytes(3).toString('hex')}`

/** The LIFF pages of this browser stand for this LINE user, as if opened in their LINE app (LIFF_MOCK) */
export async function openAsLineUser(context: BrowserContext, lineUserId: string): Promise<void> {
  await context.addCookies([{ name: LIFF_MOCK_USER_COOKIE, value: lineUserId, url: E2E_BASE_URL }])
}

/**
 * Another phone in the same test (the old phone of someone who moved their link, say): a browser of its own with the
 * mobile project's settings and a client address of its own (fixtures.ts gives every test's own browser one), so sign-in
 * limits counted per address never meet. The test closes it.
 */
export async function anotherPhone(browser: Browser): Promise<BrowserContext> {
  const [a, b] = randomBytes(2)
  return browser.newContext({
    ...devices['Pixel 7'],
    viewport: { width: 375, height: 812 },
    baseURL: E2E_BASE_URL,
    locale: 'th-TH',
    timezoneId: 'Asia/Bangkok',
    extraHTTPHeaders: { 'x-forwarded-for': `198.19.${a!}.${(b! % 254) + 1}` },
  })
}

/** The LINE user the mock cookie of this browser names, or null (a browser outside LINE) */
export async function mockLineUserOf(context: BrowserContext): Promise<string | null> {
  return (await context.cookies(E2E_BASE_URL)).find((c) => c.name === LIFF_MOCK_USER_COOKIE)?.value ?? null
}

/** Runs tests/e2e/liff-scene.ts against the e2e database and returns the JSON of its last line */
export function liffScene<T>(...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/liff-scene.ts ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  // Its output holds link codes (secrets of this test database): on failure only what went wrong is shown
  if (r.status !== 0) throw new Error(`LIFF scene ${args[0]} failed:\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}

/** What the fake LINE server of the run answers on one of its test routes */
export async function fakeLine<T>(path: string): Promise<T> {
  const response = await fetch(`${E2E_FAKE_LINE_URL}${path}`)
  if (!response.ok) throw new Error(`fake LINE ${path}: ${response.status}`)
  return (await response.json()) as T
}

/** The rich menu linked to this LINE user (not the default one); null when none */
export async function richMenuOf(lineUserId: string): Promise<string | null> {
  return (await fakeLine<{ richMenuId: string | null }>(`/__fake/users/${encodeURIComponent(lineUserId)}/richmenu`)).richMenuId
}

/** The pushes LINE accepted for this LINE user */
export async function pushesTo(lineUserId: string): Promise<ReadonlyArray<{ readonly messages: ReadonlyArray<Record<string, unknown>> }>> {
  const { messages } = await fakeLine<{ messages: Array<{ kind: string; to: string | null; messages: Array<Record<string, unknown>> }> }>('/__fake/messages')
  return messages.filter((m) => m.kind === 'push' && m.to === lineUserId)
}

/** The current authenticator code of a scene member with TOTP (derived from SEED_TOTP_KEY, as the seed does) */
export const totpOf = (employeeCode: string) => totp(deriveSeedTotpSecret(process.env.SEED_TOTP_KEY!, employeeCode))

export async function expectNoBlockingAxe(page: Page) {
  // Next streams the <title> after the first HTML: let it arrive before axe reads the page (a page without one still fails)
  await page.waitForFunction(() => document.title !== '', undefined, { timeout: 5_000 }).catch(() => undefined)
  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(blocking.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)).toEqual([])
}

/** Every link and button a person can tap on the screen is at least 44 px high (§9.4, NFR-A11Y-02) */
export async function expectTouchTargets(page: Page) {
  const small = await page.locator('header a, main a, main button').evaluateAll((elements) =>
    elements
      .filter((el) => (el as HTMLElement).offsetParent !== null && el.getBoundingClientRect().height > 0)
      .filter((el) => el.getBoundingClientRect().height < 44)
      .map((el) => `${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim()}" ${Math.round(el.getBoundingClientRect().height)}px`),
  )
  expect(small).toEqual([])
}

/** §9.9 step 4: the wide screen — LINE on a computer, or a LIFF page opened in a desktop browser (§9.4) */
const WIDE = { width: 1440, height: 900 }

/**
 * A bar that stays at the bottom of the screen — a LIFF page's action bar (sticky), a task's decision bar and the pool's
 * bar on a phone (fixed) — is drawn by a full-page screenshot where the screen ended, over the page. For the record of
 * §9.9 step 4 the screenshot draws it in its own place, at the end of what it belongs to, so nothing of the page is hidden.
 */
export const BARS_IN_PLACE = '.sticky.bottom-0, .fixed.bottom-0 { position: static !important; }'

async function noSidewaysScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
}

/**
 * The pointer away from the page's controls, to the corner of the screen: a tap or a click leaves it where it pressed,
 * and the link or button that appears there next (the sent request's "ดูคำขอ …") would be drawn pointed at, not at rest
 */
export async function pointerAway(page: Page) {
  await page.mouse.move(0, 0)
}

/**
 * The §9.9 checks of one screen: axe, no sideways scroll, 44 px touch targets and a full-page screenshot at the
 * project's width (375 px), then the same at 1440 px (`<name>-1440.png`) and back to the phone. The screenshots draw the
 * action bar in its place (BARS_IN_PLACE) and every control at rest (pointerAway).
 */
export async function checkScreen(page: Page, testInfo: TestInfo, name: string) {
  // First, so that axe reads and the pictures draw the screen at rest, any change of colour on leaving it long done
  await pointerAway(page)
  await expectNoBlockingAxe(page)
  await noSidewaysScroll(page)
  await expectTouchTargets(page)
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true, style: BARS_IN_PLACE })
  const phone = page.viewportSize()
  if (phone && phone.width < WIDE.width) {
    await page.setViewportSize(WIDE)
    await expectNoBlockingAxe(page)
    await noSidewaysScroll(page)
    await page.screenshot({ path: testInfo.outputPath(`${name}-1440.png`), fullPage: true, style: BARS_IN_PLACE })
    await page.setViewportSize(phone)
  }
}

/** The session cookie of this browser (Better Auth's, with the bcs prefix) */
export async function sessionCookie(context: BrowserContext): Promise<string | null> {
  const cookies = await context.cookies(E2E_BASE_URL)
  return cookies.find((c) => c.name.endsWith('bcs.session_token'))?.value ?? null
}

/**
 * §9.4 "JavaScript เริ่มต้นไม่เกิน 200 KB (gzip)", read strictly: all the JavaScript a LIFF page loads before the person
 * does anything. That is every script file from the navigation until the network is quiet — the HTML's own scripts, the
 * ones a screen loads lazily for what it shows first (the e-mail sign-in of an unlinked LINE account, a task's decision)
 * and the LINE SDK, which the bootstrap imports before anything else (with LIFF_MOCK it imports it too, without
 * liff.init, so a test measures what the LINE app loads) — as bytes over the wire with gzip, plus the page data Next.js
 * writes into the HTML as inline scripts (the RSC payload, with the messages the page's client components read:
 * src/i18n/client-messages.ts), gzip as the server compresses the page. KB read strictly (1000). A page is weighed both
 * ways LINE opens it (expectFirstLoadsWithinBudget): with no LIFF session yet, when the HTML is the gate's, and with the
 * LIFF session, when the page's content — a document of realistic size — is in the HTML too.
 */
export const FIRST_LOAD_JS_BUDGET_BYTES = 200 * 1000

/** The scripts written into a document (no src): Next.js's page data (the RSC payload) and its small bootstrap */
export function inlineScriptsOf(html: string): string[] {
  return [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1] ?? '')
}

/** Bytes of a text compressed as the server compresses a page (gzip, level 6) */
export const gzipBytes = (text: string): number => gzipSync(Buffer.from(text, 'utf8'), { level: 6 }).length

/** A plain message (no placeholder or markup) of a namespace, to find it in a page */
function plainMessageOf(value: unknown): string | null {
  if (typeof value === 'string') return value.length > 20 && !/[{}<>"\\]/.test(value) ? value : null
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) {
      const found = plainMessageOf(inner)
      if (found) return found
    }
  }
  return null
}

/** Messages of workspace screens no LIFF page shows: finding them in a LIFF page means the whole catalogue came along */
export function workspaceOnlyMessages(): string[] {
  const th = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../messages/th.json'), 'utf8')) as Record<string, unknown>
  return ['procurement', 'budgets', 'adminDoa', 'finance'].map((namespace) => plainMessageOf(th[namespace])).filter((message): message is string => message !== null)
}

/** A string only the LINE SDK carries: its CDN host (src/ui/liff/sdk.ts loads @line/liff/core) */
const LIFF_SDK_MARKER = 'liffsdk.line-scdn.net'
/**
 * A string only tailwind-merge carries (the name of a part of its configuration, which minifying keeps): the workspace's
 * class merger, src/ui/cn.ts, some 8.6 KB gzip that LIFF pages do without (src/ui/liff/cn.ts). The sign-in page loads it
 * (TAILWIND_MERGE_PAGE), and liff-requests.spec.ts finds it there: a new tailwind-merge without this string fails that
 * test, not every LIFF page quietly
 */
const TAILWIND_MERGE_MARKER = 'conflictingClassGroups'

/** A page of the workspace whose first load has tailwind-merge: the sign-in form's button joins its classes with src/ui/cn.ts */
export const TAILWIND_MERGE_PAGE = '/login'

export interface ScriptLoad {
  readonly url: string
  /** Bytes as they came over the wire (the encoded body) */
  readonly transferred: number
  readonly encoding: string | null
  /** The chunk of the LINE SDK */
  readonly sdk: boolean
  /** The chunk of tailwind-merge (src/ui/cn.ts), which a component of the workspace would bring */
  readonly merge: boolean
}

/**
 * Every script the page loads from now on (the document's own and those it loads later, lazily or not), with the bytes
 * that came over the wire: Playwright's encoded body size, i.e. gzip when the server compressed it.
 */
export function watchScripts(page: Page): () => Promise<ScriptLoad[]> {
  const seen: Response[] = []
  page.on('response', (response) => {
    if (response.request().resourceType() === 'script') seen.push(response)
  })
  return async () =>
    Promise.all(
      seen.map(async (response) => {
        await response.finished()
        const sizes = await response.request().sizes()
        const body = await response.text().catch(() => '')
        return {
          url: response.url(),
          transferred: sizes.responseBodySize,
          encoding: (await response.headerValue('content-encoding')) ?? null,
          sdk: body.includes(LIFF_SDK_MARKER),
          merge: body.includes(TAILWIND_MERGE_MARKER),
        }
      }),
    )
}

/** The first JavaScript of one LIFF page load, as §9.4 counts it (FIRST_LOAD_JS_BUDGET_BYTES) */
export interface FirstLoad {
  readonly loads: readonly ScriptLoad[]
  /** The script files' bytes over the wire (gzip) */
  readonly scripts: number
  /** The page data written into the first HTML as inline scripts, gzip */
  readonly inline: number
  /** What the budget counts: the script files and the inline page data together */
  readonly total: number
  /** The first HTML, to look for what should not be in it */
  readonly html: string
  /** The weights in one line, for the test's annotations */
  readonly note: string
}

/** File name of a script with its weight, and (LINE SDK) or (tailwind-merge) for those chunks */
const describeLoad = (l: ScriptLoad) => `${new URL(l.url).pathname.split('/').at(-1)}${l.sdk ? ' (LINE SDK)' : ''}${l.merge ? ' (tailwind-merge)' : ''} ${l.transferred}`

/**
 * Loads a LIFF page as a person would (in a browser with nothing cached: the caller opens it in a context of its own),
 * waits until its first screen is up and the network is quiet, and weighs its first JavaScript
 */
export async function weighFirstLoad(page: Page, path: string, ready: () => Promise<void>): Promise<FirstLoad> {
  const scripts = watchScripts(page)
  const document = await page.goto(path)
  await ready()
  await page.waitForLoadState('networkidle')
  const loads = await scripts()
  const scriptBytes = loads.reduce((sum, load) => sum + load.transferred, 0)
  const html = (await document?.text()) ?? ''
  const inline = gzipBytes(inlineScriptsOf(html).join('\n'))
  const largest = [...loads]
    .sort((a, b) => b.transferred - a.transferred)
    .slice(0, 8)
    .map(describeLoad)
  const total = scriptBytes + inline
  const merge = loads.filter((l) => l.merge).map((l) => `${new URL(l.url).pathname.split('/').at(-1)} ${l.transferred}`)
  const note = `${total} bytes of ${FIRST_LOAD_JS_BUDGET_BYTES}: ${loads.length} script files ${scriptBytes} bytes over the wire and inline page data ${inline} bytes gzip; largest ${largest.join(', ')}${merge.length > 0 ? `; tailwind-merge in ${merge.join(', ')}` : '; no tailwind-merge'}`
  return { loads, scripts: scriptBytes, inline, total, html, note }
}

/**
 * §9.4 on one first load, noted on the test (annotation first-load-js): the LINE SDK is part of it, as in the LINE app
 * (with LIFF_MOCK the bootstrap loads it without liff.init); what came over the wire was compressed, so the bytes are
 * the gzip size; none of it is tailwind-merge — the LIFF components and the workspace's that LIFF pages draw join their
 * classes without it (src/ui/liff/cn.ts; tests/unit/liff-classes.test.tsx follows the imports), and one component that
 * brought it would add some 8.6 KB; and the script files with the inline page data are at most 200 KB
 */
export function expectFirstLoadWithinBudget(testInfo: TestInfo, name: string, load: FirstLoad) {
  testInfo.annotations.push({ type: 'first-load-js', description: `${name}: ${load.note}` })
  expect(load.loads.filter((l) => l.sdk), name).toHaveLength(1)
  expect(load.loads.filter((l) => l.transferred > 1024 && l.encoding !== 'gzip' && l.encoding !== 'br').map(describeLoad), name).toEqual([])
  // Soft: a test that weighs several pages weighs them all, and fails at its end with every page over the budget
  expect.soft(load.loads.filter((l) => l.merge).map(describeLoad), `${name}: no tailwind-merge in the first load`).toEqual([])
  expect.soft(load.total, `${name}: ${load.note}`).toBeLessThanOrEqual(FIRST_LOAD_JS_BUDGET_BYTES)
}

/**
 * The lines of a document of realistic size on a page weighed with its LIFF session, whose content is in the HTML: a big
 * request of a construction site for its materials (each line adds some 50 bytes gzip to the page data of a request's
 * form, more to a PO's decision page)
 */
export const BUDGET_DOCUMENT_LINES = 40

/** Runs tests/e2e/liff-budget-scene.ts (documents of realistic size) against the e2e database: the JSON of its last line */
export function liffBudgetScene<T>(...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/liff-budget-scene.ts ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`LIFF budget scene ${args[0]} failed:\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}

/** A browser's cookies, as Playwright gives and takes them */
export type BrowserCookies = Awaited<ReturnType<BrowserContext['cookies']>>

/** Where the LIFF bootstrap signs in with the LINE ID token (src/ui/liff/bootstrap.ts LIFF_SESSION_ENDPOINT) */
const LIFF_SESSION_ENDPOINT = '/api/liff/session'

/**
 * The LIFF session of this LINE user as LINE keeps it between two taps (§9.4: a session of channel LIFF, idle 15
 * minutes): the cookies of a LINE app of its own once the gate of `path` signed in with the ID token
 */
export async function liffSessionOf(browser: Browser, lineUserId: string, path: string, ready: (page: Page) => Promise<void>): Promise<BrowserCookies> {
  const phone = await anotherPhone(browser)
  try {
    await openAsLineUser(phone, lineUserId)
    const page = await phone.newPage()
    await page.goto(path)
    await ready(page)
    await page.waitForLoadState('networkidle')
    expect(await sessionCookie(phone), `${path}: the gate signed in with LINE`).toMatch(/^liff_/)
    return await phone.cookies(E2E_BASE_URL)
  } finally {
    await phone.close()
  }
}

/** One LIFF page as a budget test opens it: for which LINE user, and when its first screen is up */
export interface LiffBudgetScreen {
  readonly name: string
  readonly lineUserId: string
  readonly path: string
  readonly ready: (page: Page) => Promise<void>
}

/**
 * The first load of a LIFF page as LINE opens it with no LIFF session yet, in a LINE app of its own with nothing cached:
 * the HTML is the gate's, which signs in with the ID token and then fetches the page's content
 */
export async function weighOpenedFromLine(browser: Browser, screen: LiffBudgetScreen): Promise<FirstLoad> {
  const phone = await anotherPhone(browser)
  try {
    await openAsLineUser(phone, screen.lineUserId)
    const page = await phone.newPage()
    return await weighFirstLoad(page, screen.path, () => screen.ready(page))
  } finally {
    await phone.close()
  }
}

/**
 * The first load of a LIFF page within the LIFF session of the last 15 minutes (a second card or rich-menu tap), in a
 * LINE app with nothing cached (the first visit after a deploy changed the scripts, a cleared cache): the server writes
 * the page's content into the HTML, as big as the scene made the document, and nothing signs in again
 */
export async function weighWithLiffSession(browser: Browser, screen: LiffBudgetScreen): Promise<FirstLoad> {
  const cookies = await liffSessionOf(browser, screen.lineUserId, screen.path, screen.ready)
  const phone = await anotherPhone(browser)
  try {
    await phone.addCookies(cookies)
    const page = await phone.newPage()
    const signIns: string[] = []
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === LIFF_SESSION_ENDPOINT) signIns.push(request.url())
    })
    const load = await weighFirstLoad(page, screen.path, () => screen.ready(page))
    expect(signIns, `${screen.name}: opened with its LIFF session, the page's content in its HTML`).toEqual([])
    return load
  } finally {
    await phone.close()
  }
}

/**
 * §9.4 on a LIFF page both ways LINE opens it (weighOpenedFromLine, weighWithLiffSession), each noted on the test and at
 * most 200 KB with the page data in its HTML; returns both loads
 */
export async function expectFirstLoadsWithinBudget(browser: Browser, testInfo: TestInfo, screen: LiffBudgetScreen): Promise<readonly FirstLoad[]> {
  const opened = await weighOpenedFromLine(browser, screen)
  expectFirstLoadWithinBudget(testInfo, `${screen.name}, opened from LINE`, opened)
  const again = await weighWithLiffSession(browser, screen)
  expectFirstLoadWithinBudget(testInfo, `${screen.name}, with the LIFF session`, again)
  return [opened, again]
}
