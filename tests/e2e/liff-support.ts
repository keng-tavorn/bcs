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
// most 200 KB gzip), with the page data written into its HTML weighed apart.

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

async function noSidewaysScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
}

/**
 * The §9.9 checks of one screen: axe, no sideways scroll, 44 px touch targets and a full-page screenshot at the
 * project's width (375 px), then the same at 1440 px (`<name>-1440.png`) and back to the phone.
 */
export async function checkScreen(page: Page, testInfo: TestInfo, name: string) {
  await expectNoBlockingAxe(page)
  await noSidewaysScroll(page)
  await expectTouchTargets(page)
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })
  const phone = page.viewportSize()
  if (phone && phone.width < WIDE.width) {
    await page.setViewportSize(WIDE)
    await expectNoBlockingAxe(page)
    await noSidewaysScroll(page)
    await page.screenshot({ path: testInfo.outputPath(`${name}-1440.png`), fullPage: true })
    await page.setViewportSize(phone)
  }
}

/** The session cookie of this browser (Better Auth's, with the bcs prefix) */
export async function sessionCookie(context: BrowserContext): Promise<string | null> {
  const cookies = await context.cookies(E2E_BASE_URL)
  return cookies.find((c) => c.name.endsWith('bcs.session_token'))?.value ?? null
}

/**
 * §9.4 "JavaScript เริ่มต้นไม่เกิน 200 KB (gzip)", read as the script files a LIFF page loads: every script file from the
 * navigation until the network is quiet, before the person does anything — the HTML's own scripts, the ones a screen
 * loads lazily for what it shows first (the e-mail sign-in of an unlinked LINE account, the member's link) and the LINE
 * SDK, which the bootstrap imports before anything else (with LIFF_MOCK it imports it too, without liff.init, so a test
 * measures what the LINE app loads) — as bytes over the wire with gzip. KB read strictly (1000). The page data Next.js
 * writes into the HTML as inline scripts (the RSC payload) is weighed apart (inlineScriptsOf): whether the budget counts
 * it too is the spec owner's to say, and today it carries the whole message catalogue of the root layout.
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

export interface ScriptLoad {
  readonly url: string
  /** Bytes as they came over the wire (the encoded body) */
  readonly transferred: number
  readonly encoding: string | null
  /** The chunk of the LINE SDK */
  readonly sdk: boolean
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
        }
      }),
    )
}
