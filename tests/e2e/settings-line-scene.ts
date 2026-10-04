import { randomBytes } from 'node:crypto'
import type { APIRequestContext, Browser, BrowserContextOptions, Page, TestInfo } from '@playwright/test'
import { E2E_BASE_URL, E2E_FAKE_LINE_URL, E2E_LINE } from '../support/e2e-env'
import { expect } from './fixtures'
import { signInAs } from './insight-support'

// Shared steps of the wave-4 settings specs (admin-line, settings-line, settings-pin, settings-notifications): who each
// Playwright project signs in as — desktop and mobile never touch the same member, and no spec of the four shares one
// that it changes — the fake LINE server of the run standing in for LINE (its controls under /__fake/*), a second
// browser of a signed-in member with JavaScript off (the page as the server sends it, before React runs), and the
// organization's administrator switching LINE off and on at /admin/line.

/** A seeded member of the demo organization: those with a role or a DOA position sign in with the authenticator */
export interface Person {
  readonly code: string
  readonly name: string
  readonly totp: boolean
}

const person = (code: string, name: string, totp: boolean): Person => ({ code, name, totp })
const byProject = (testInfo: TestInfo, desktop: Person, mobile: Person) => (testInfo.project.name === 'mobile' ? mobile : desktop)

/** The organization's two administrators (/admin/line) */
export const adminOf = (testInfo: TestInfo) => byProject(testInfo, person('admin', 'แอดมิน ดูแลระบบ', true), person('admin2', 'สมศักดิ์ ดูแลร่วม', true))
/** A member who is not an administrator (only reads /admin/line) */
export const notAdminOf = (testInfo: TestInfo) => byProject(testInfo, person('req_con', 'สมชาย ใจดี', false), person('req_con2', 'วิศวะ หน้างาน', false))
/** The member who links LINE from /settings/line */
export const linkerOf = (testInfo: TestInfo) => byProject(testInfo, person('req_con', 'สมชาย ใจดี', false), person('req_con2', 'วิศวะ หน้างาน', false))
/** The member who links and then unlinks LINE from the web */
export const unlinkerOf = (testInfo: TestInfo) => byProject(testInfo, person('asst_con', 'สมหญิง รักงาน', false), person('req_it', 'ไอยรา ระบบงาน', false))
/** Members without a PIN who set one: desktop proves with the password, mobile with the authenticator code */
export const pinSetterOf = (testInfo: TestInfo) => byProject(testInfo, person('fin_officer', 'ฟ้าใส บัญชี', true), person('auditor', 'อรุณ ตรวจสอบ', true))
/** Approvers who have the seed's PIN, change it and change it back (other specs of a full run decide with it) */
export const pinChangerOf = (testInfo: TestInfo) => byProject(testInfo, person('dm_it', 'ไอศูรย์ ระบบดี', true), person('dm_fin', 'ธนา การเงิน', true))
/** The member who switches the daily summary off and on */
export const digestMemberOf = (testInfo: TestInfo) => byProject(testInfo, person('receiver_con', 'ประเสริฐ ตรวจดี', true), person('proc_officer', 'พิมพ์ใจ จัดหา', true))
/**
 * Requesters, who hold no DOA position and so never get a PIN (the seed gives one to approvers only, and no spec sets
 * theirs): /settings/pin shows them step 1 at once. Only read there.
 */
export const noPinMemberOf = (testInfo: TestInfo) => byProject(testInfo, person('req_con', 'สมชาย ใจดี', false), person('req_con2', 'วิศวะ หน้างาน', false))

/** A new browser context like the test's own: the project's width and device, the run's site, the test's client address */
function contextLike(testInfo: TestInfo, clientIp: string): BrowserContextOptions {
  const use = testInfo.project.use
  return {
    baseURL: E2E_BASE_URL,
    locale: 'th-TH',
    timezoneId: 'Asia/Bangkok',
    ...(use.viewport ? { viewport: use.viewport } : {}),
    ...(use.userAgent ? { userAgent: use.userAgent } : {}),
    ...(use.deviceScaleFactor ? { deviceScaleFactor: use.deviceScaleFactor } : {}),
    isMobile: use.isMobile ?? false,
    hasTouch: use.hasTouch ?? false,
    // fixtures.ts: sign-in limits counted per client address never carry over between tests
    extraHTTPHeaders: { 'x-forwarded-for': clientIp },
  }
}

/**
 * The member signed in on `signedIn`, in a second browser with JavaScript off: each page as the server sends it, before
 * React hydrates it — what a slow phone shows, or a page whose script did not load. Every address it asks for is kept.
 */
export async function withoutScript(browser: Browser, signedIn: Page, testInfo: TestInfo, clientIp: string): Promise<{ readonly page: Page; readonly requested: readonly string[] }> {
  const context = await browser.newContext({ ...contextLike(testInfo, clientIp), javaScriptEnabled: false, storageState: await signedIn.context().storageState() })
  const page = await context.newPage()
  const requested: string[] = []
  page.on('request', (r) => requested.push(r.url()))
  return { page, requested }
}

/**
 * Submits the form around `field` the two ways a browser could before the page's script runs, and checks that neither
 * puts a typed value in an address: Enter in the field (the submit button is disabled, so nothing is sent), and the
 * submit button forced back on as a browser extension could — then the browser submits natively, by POST (method="post").
 */
export async function expectNoValueInAddresses(page: Page, requested: readonly string[], field: ReturnType<Page['getByLabel']>, submitName: string, values: readonly string[], names: readonly string[]) {
  const before = page.url()
  const form = page.locator('form').filter({ has: field })
  await expect(form).toHaveAttribute('method', 'post')
  const submit = form.getByRole('button', { name: submitName, exact: true })
  await expect(submit).toBeDisabled()
  await field.press('Enter')
  await page.waitForLoadState('networkidle')
  expect(page.url()).toBe(before)
  // The browser submits by itself once the button is on: by POST, to the page's own address, without a query
  await submit.evaluate((button) => button.removeAttribute('disabled'))
  await field.press('Enter')
  await page.waitForLoadState('networkidle')
  expect(new URL(page.url()).search).toBe('')
  expect(new URL(page.url()).pathname).toBe(new URL(before).pathname)
  for (const url of requested) {
    for (const value of values) expect(url, url).not.toContain(encodeURIComponent(value))
    for (const name of names) expect(url, url).not.toContain(`${name}=`)
  }
}

/** A browser of the organization's administrator of this project (adminOf), signed in */
export async function signedInAdmin(browser: Browser, testInfo: TestInfo, clientIp: string): Promise<Page> {
  const context = await browser.newContext(contextLike(testInfo, clientIp))
  const page = await context.newPage()
  const admin = adminOf(testInfo)
  await signInAs(page, admin.code, admin.totp)
  return page
}

/** The administrator switches LINE on or off for the organization at /admin/line (saved with the version shown) */
export async function setLineActive(admin: Page, on: boolean): Promise<void> {
  await admin.goto('/admin/line')
  const save = admin.getByRole('button', { name: 'บันทึกค่า LINE' })
  // Save is enabled once the page runs its script: the switch is the page's state from then on
  await expect(save).toBeEnabled()
  const active = admin.getByRole('switch', { name: 'ใช้ LINE กับองค์กรนี้' })
  if ((await active.isChecked()) === on) return
  await admin.getByText('ใช้ LINE กับองค์กรนี้', { exact: true }).click()
  await expect(active).toBeChecked({ checked: on })
  await save.click()
  await expect(admin.getByRole('status').filter({ hasText: 'บันทึกค่า LINE แล้ว' })).toBeVisible()
}

/** A LINE user id as LINE gives one (U + 32 hexadecimal characters) */
export const newLineUserId = () => `U${randomBytes(16).toString('hex')}`

/** An ID token of the run's LIFF app for this LINE user, as liff.getIDToken() gives in the LINE app (BR-LINE-01) */
export async function liffIdToken(request: APIRequestContext, lineUserId: string): Promise<string> {
  const answer = await request.post(`${E2E_FAKE_LINE_URL}/__fake/id-token`, { data: { sub: lineUserId, aud: E2E_LINE.LINE_LIFF_CHANNEL_ID } })
  expect(answer.status()).toBe(200)
  return ((await answer.json()) as { idToken: string }).idToken
}

/** What the organization's administrator set at LINE Developers Console → Messaging API → Webhook settings */
export async function setWebhookAtLine(request: APIRequestContext, endpoint: string): Promise<void> {
  const answer = await request.post(`${E2E_FAKE_LINE_URL}/__fake/webhook`, { data: { endpoint, active: true } })
  expect(answer.status()).toBe(200)
}

/**
 * Presses "ผูกบัญชี LINE" on /settings/line and returns the code of the LIFF link the page shows (the QR's content). The
 * code is read from the link on the page, as a phone camera reads it from the QR.
 */
export async function issueCodeOnPage(page: Page): Promise<{ readonly url: string; readonly code: string }> {
  await page.getByRole('button', { name: 'ผูกบัญชี LINE', exact: true }).click()
  const shown = page.getByText(/^https:\/\/liff\.line\.me\//)
  await expect(shown).toBeVisible()
  const url = await shown.innerText()
  const code = new URL(url).searchParams.get('code')
  expect(code).toMatch(/^l1\./)
  return { url, code: code! }
}

/** What the LIFF page /liff/link does once the person confirmed: POST /api/liff/link { code, idToken } from this site */
export async function linkInLine(page: Page, request: APIRequestContext, code: string, lineUserId: string = newLineUserId()): Promise<string> {
  const idToken = await liffIdToken(request, lineUserId)
  const answer = await page.request.post('/api/liff/link', { data: { code, idToken } })
  expect(await answer.json()).toEqual({ ok: true })
  return lineUserId
}

/** The bell that shows at this width (the phone header and the wide-screen bar each have one) */
export const bellOf = (page: Page) => page.locator('details:has(> summary[aria-label^="แจ้งเตือน"])').filter({ visible: true })
