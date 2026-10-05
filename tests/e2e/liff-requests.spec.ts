import { spawnSync } from 'node:child_process'
import { randomInt } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { devices, type BrowserContext, type Locator, type Page, type TestInfo } from '@playwright/test'
import { localeCookieName } from '../../src/i18n/locales'
import { E2E_BASE_URL, e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'
import {
  anotherPhone,
  BUDGET_DOCUMENT_LINES,
  checkScreen,
  expectFirstLoadsWithinBudget,
  expectFirstLoadWithinBudget,
  liffBudgetScene,
  newLineUserId,
  openAsLineUser,
  sceneTag,
  sessionCookie,
  TAILWIND_MERGE_PAGE,
  watchScripts,
  weighOpenedFromLine,
  weighWithLiffSession,
  type LiffBudgetScreen,
} from './liff-support'

// S5-06 · the request pages of LIFF (§9.4: /liff/requests/new, /liff/requests/[id], /liff/track), at 375 px in the
// mobile project (playwright.config.ts runs liff-* specs on the phone only); every screen is also photographed and
// checked at 1440 px (checkScreen), as LIFF opens in LINE on a computer and in desktop browsers too. LIFF_MOCK stands
// in for the LINE app: the mock cookie says which LINE user the page is opened by, the ID token comes from the fake LINE
// server of the run, and everything after it — the LIFF session, the services, the Events — is the real path. Each test
// has requesters of its own, linked to a LINE account of their own (tests/e2e/liff-requests-scene.ts), so nothing here
// meets another spec's people. Scenes 1, 2 and 4 of the Demo_Script sheet: req_con's plywood and nails in LIFF (the
// form fills department, budget line and site; the budget left and the route to the VP of operations under PR-02
// before sending), the approval in the LINE chat seen on the request page, and req_it's backup server over budget.

interface SceneMember {
  readonly id: string
  readonly email: string
  readonly nameTh: string
  readonly departmentName: string
}

interface SceneRequest {
  readonly requestId: string
  readonly number: string
}

interface SceneDraft {
  readonly id: string
  readonly title: string
  readonly channels: readonly string[]
}

/** Runs tests/e2e/liff-requests-scene.ts against the e2e database and returns the JSON of its last line */
function liffRequestsScene<T>(...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/liff-requests-scene.ts ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  // Its work spends link codes (secrets of this test database): on failure only what went wrong is shown
  if (r.status !== 0) throw new Error(`LIFF requests scene ${args[0]} failed:\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}

/**
 * The budget line has at least `baht` left before the test asks for that much on it (tests/e2e/budget-room-scene.ts):
 * both projects and many specs spend the same lines in one database, and when they have left less, a budget admin tops
 * the line up through the budget import, as an administrator does
 */
function roomOn(code: string, baht: string): void {
  const r = spawnSync(`pnpm exec tsx tests/e2e/budget-room-scene.ts ${code} ${baht}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`budget room scene failed:\n${r.stdout}\n${r.stderr}`)
}

/** A photo as a phone's camera hands it over, at its smallest: one pixel of PNG */
const PHOTO_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

/** Satang of a money text on screen ("300,000.00 บาท" → 30000000n) */
const satangOf = (text: string) => BigInt(text.replace(/[^\d]/g, ''))
/** Satang as the screens write money: thousands separators and two decimals */
const shown = (satang: bigint) => `${(satang / 100n).toLocaleString('en-US')}.${String(satang % 100n).padStart(2, '0')}`

const stepHeading = (page: Page, n: number, name: string, total = 3) => page.getByRole('heading', { level: 2, name: `ขั้นที่ ${n} จาก ${total}: ${name}` })
const nextStep = (page: Page, name: string) => page.getByRole('button', { name: `ไปขั้นถัดไป: ${name}` }).click()
const remainingOf = (page: Page) => page.locator('div[aria-live="polite"]').filter({ hasText: 'งบคงเหลือของบรรทัดนี้' })

async function fillLine(group: Locator, item: { description: string; quantity: string; uom: string; price: string }) {
  await group.getByLabel('สิ่งที่ขอ').fill(item.description)
  await group.getByLabel(/^จำนวน/).fill(item.quantity)
  await group.getByLabel(/^หน่วย/).fill(item.uom)
  await group.getByLabel(/^ราคาต่อหน่วย/).fill(item.price)
}

const timeline = (page: Page) => page.getByRole('list', { name: 'ไทม์ไลน์ของคำขอ' })
/** The line of a request page that says where it is now (the same on the web and in LIFF) */
const nowLine = (page: Page) => page.locator('p').filter({ hasText: /^ตอนนี้: / })
/** What the requester has to do on their request page, under its heading */
const toDo = (page: Page) => page.getByRole('region', { name: 'สิ่งที่ต้องทำ' })
/** The bar at the bottom of the requester's page with the one main action (§9.9: LIFF's main button at the bottom) */
const requesterBar = (page: Page) => page.getByRole('region', { name: 'สิ่งที่ทำได้กับคำขอนี้' })

/**
 * What the phone shows — the viewport, not the whole page — with the bar at the bottom of the screen where a person sees
 * it (`<name>-screen.png`): a full-page screenshot draws a sticky bar where the first screen ends, over the content
 */
async function firstScreen(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ path: testInfo.outputPath(`${name}-screen.png`) })
}

/**
 * A browser where the PWA's service worker is in place, as on a phone where BCS was opened before: the sign-in page
 * registers it (src/ui/pwa/pwa-registration.tsx, production builds) and it takes the pages of the site (scope /), the
 * LIFF pages included, from the next page load on
 */
async function withPwaWorker(context: BrowserContext) {
  const signIn = await context.newPage()
  try {
    await signIn.goto('/login')
    await expect.poll(() => controlledByWorker(signIn), { timeout: 20_000 }).toBe(true)
  } finally {
    await signIn.close()
  }
}

/** The page is controlled by the PWA's service worker */
const controlledByWorker = (page: Page) => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL.endsWith('/sw.js') ?? false)

/** A scene walks through several screens, each checked with axe and photographed at two widths */
const SCENE_TIMEOUT_MS = 120_000

test.describe('[FR-LINE-003/AC1] [§9.4] the request pages in the LINE app', () => {
  test.describe.configure({ timeout: SCENE_TIMEOUT_MS })

  test('[FR-LINE-003/AC1] [FR-INT-001/AC3] [FR-INT-003/AC1] [FR-INT-004/AC1] [FR-DOA-003/AC2] scene 1: a linked requester asks for plywood and nails in LIFF, sees the budget left and the route to the VP before sending, and follows it on /liff/track and /liff/requests/[id]', async ({
    page,
    context,
  }, testInfo) => {
    const lineUserId = newLineUserId()
    const tag = sceneTag('scene1')
    liffRequestsScene<{ member: SceneMember }>('requester', tag, lineUserId, 'CON', 'history')
    // The line the form fills has room for the 42,000.00 before VAT asked below
    roomOn('CON-OPEX-2569', '42000.00')
    await openAsLineUser(context, lineUserId)
    const title = `ไม้อัดและตะปู ไซต์ A ${tag}`

    // The rich menu's "ขอซื้อ" opens the catalogue (§9.5); the gate signs in with the LINE ID token, no password
    await page.goto('/liff/requests/new')
    await expect(page.getByRole('heading', { level: 1, name: 'ขอซื้อ / ขอจ้าง' })).toBeVisible()
    const starts = page.getByRole('link', { name: /เริ่มคำขอ / })
    await expect(starts).toHaveCount(5)
    expect(await sessionCookie(context)).toMatch(/^liff_/)
    await expect(page.getByRole('link', { name: /เริ่มคำขอ ซื้อของ$/ })).toContainText('ใช้เมื่อ: วัสดุ อุปกรณ์ สินค้าทั่วไป')
    // FR-INT-001 AC2: a keyword finds a type
    const search = page.getByLabel('ค้นหาประเภทคำขอ')
    await search.fill('ไอที')
    await expect(starts).toHaveCount(1)
    await expect(starts).toContainText('ซื้ออุปกรณ์/ซอฟต์แวร์ไอที')
    await search.fill('')
    await expect(starts).toHaveCount(5)
    // The text of a LIFF page is 16 px (§9.4)
    expect(await page.locator('main p').first().evaluate((el) => getComputedStyle(el).fontSize)).toBe('16px')
    await checkScreen(page, testInfo, 'liff-requests-catalog')

    await page.getByRole('link', { name: /เริ่มคำขอ ซื้อของ$/ }).click()
    await expect(page).toHaveURL(/\/liff\/requests\/new\/BUY_GOODS$/)
    await expect(page.getByRole('heading', { level: 1, name: 'คำขอใหม่: ซื้อของ' })).toBeVisible()
    await expect(stepHeading(page, 1, 'รายละเอียดคำขอ')).toBeVisible()
    // BR-FORM-02: the budget line the requester used last for this type, and the department that pays for it
    await expect(page.getByLabel('บรรทัดงบที่ใช้').locator('option:checked')).toHaveText(/^CON-OPEX-2569 · /)
    await expect(page.getByText('ฝ่ายก่อสร้าง', { exact: true })).toBeVisible()
    // FR-INT-004 AC1: what is left on the chosen line, before anything is typed
    await expect(remainingOf(page)).toContainText(/[\d,]+\.\d{2} บาท/)
    await page.getByLabel('ชื่อคำขอ').fill(title)
    await checkScreen(page, testInfo, 'liff-request-form-details')
    await firstScreen(page, testInfo, 'liff-request-form-details')

    await nextStep(page, 'รายการที่ขอ')
    await expect(stepHeading(page, 2, 'รายการที่ขอ')).toBeVisible()
    // BR-FORM-02 "สถานที่ส่งล่าสุด": the site of the requester's latest request
    await expect(page.getByLabel('สถานที่ส่ง').locator('option:checked')).toHaveText('SITE-A · ไซต์งานตัวอย่าง A')
    await fillLine(page.getByRole('group', { name: 'รายการที่ 1' }), { description: 'ไม้อัด 10 มม.', quantity: '20', uom: 'แผ่น', price: '1500' })
    await page.getByRole('button', { name: 'เพิ่มรายการ' }).click()
    await fillLine(page.getByRole('group', { name: 'รายการที่ 2' }), { description: 'ตะปู 2 นิ้ว', quantity: '100', uom: 'กล่อง', price: '120' })
    // 42,000.00 before VAT, VAT 7% 2,940.00, 44,940.00 with it (scene 1 of the Demo_Script sheet)
    await expect(page.getByText('42,000.00 บาท').first()).toBeVisible()
    await expect(page.getByText('2,940.00 บาท').first()).toBeVisible()
    await expect(page.getByText('44,940.00 บาท').first()).toBeVisible()
    await expect(page.getByText('งบพอ', { exact: true })).toBeVisible()
    await checkScreen(page, testInfo, 'liff-request-form-items')

    await nextStep(page, 'ตรวจและส่ง')
    await expect(stepHeading(page, 3, 'ตรวจและส่ง')).toBeVisible()
    // FR-DOA-003 AC2: the approver the DOA expects, and under which rule, before sending
    const route = page.getByRole('region', { name: 'เส้นทางอนุมัติที่คาดไว้' })
    await expect(route.getByText('วีระ ปฏิบัติการ')).toBeVisible()
    await expect(route.getByText('รองประธานสายงาน ของสายปฏิบัติการ')).toBeVisible()
    await expect(route).toContainText('DOA-DEMO ฉบับ 1 ข้อ PR-02')
    await expect(page.getByText('ข้อมูลที่ตรวจได้บนหน้านี้ครบแล้ว กดส่งได้')).toBeVisible()
    await checkScreen(page, testInfo, 'liff-request-form-review')
    await firstScreen(page, testInfo, 'liff-request-form-review')

    await page.getByRole('button', { name: 'ส่งขออนุมัติ', exact: true }).click()
    // §9.9 rule 7: the confirmation repeats the button's words, with the number and who decides it now
    const sent = page.getByRole('status').filter({ hasText: 'ส่งขออนุมัติแล้ว' })
    await expect(sent).toContainText('ส่งขออนุมัติแล้ว รอ วีระ ปฏิบัติการ พิจารณา')
    await expect(sent).toContainText(/เลขที่คำขอ PR-\d{4}-\d{5}/)
    const number = (/PR-\d{4}-\d{5}/.exec((await sent.textContent()) ?? '') ?? [''])[0]
    await checkScreen(page, testInfo, 'liff-request-sent')

    await page.getByRole('link', { name: `ดูคำขอ ${number} และติดตามสถานะ` }).click()
    await expect(page).toHaveURL(/\/liff\/requests\/[0-9a-f-]{36}$/)
    const requestId = new URL(page.url()).pathname.split('/').at(-1)!
    await expect(page.getByRole('heading', { level: 1, name: number })).toBeVisible()
    await expect(page.getByRole('heading', { level: 2, name: title })).toBeVisible()
    await expect(page.getByText('รออนุมัติ', { exact: true }).first()).toBeVisible()
    await expect(nowLine(page)).toContainText('ตอนนี้: รอ วีระ ปฏิบัติการ')
    // Nothing for the requester to do while it waits for the approver: no bar
    await expect(requesterBar(page)).toHaveCount(0)
    // The timeline stamps the send with its channel: LINE (LIFF) (FR-LINE-003 AC1, FR-PLT-003 AC3)
    await expect(timeline(page).getByRole('listitem').filter({ hasText: `ส่งขออนุมัติ ได้เลขที่ ${number}` })).toContainText('LINE (LIFF)')
    // …and so do the Events themselves: the draft saved from LIFF and the submit
    expect(liffRequestsScene<{ drafted: string[]; submitted: string[] }>('channels', requestId)).toMatchObject({ drafted: ['LIFF'], submitted: ['LIFF'] })
    await checkScreen(page, testInfo, 'liff-request-view-pending')

    // /liff/track: the request with its status and whom it waits for, opening its LIFF page
    await page.goto('/liff/track')
    await expect(page.getByRole('heading', { level: 1, name: 'คำขอของฉัน' })).toBeVisible()
    const row = page.getByRole('list', { name: 'คำขอของฉัน' }).getByRole('listitem').filter({ hasText: number })
    await expect(row).toContainText('รออนุมัติ')
    await expect(row).toContainText('รอ วีระ ปฏิบัติการ')
    await expect(row).toContainText('44,940.00')
    await checkScreen(page, testInfo, 'liff-track')
    await row.getByRole('link', { name: `${number} · ${title}` }).click()
    await expect(page).toHaveURL(new RegExp(`/liff/requests/${requestId}$`))

    // Scene 2: the VP approves from the card in the LINE chat; the request page in LIFF stamps it with the channel and
    // the DOA rule (FR-DOA-005 AC2)
    liffRequestsScene('approve-in-chat', requestId)
    await page.reload()
    await expect(page.getByText('อนุมัติแล้ว', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('อนุมัติภายใต้')).toBeVisible()
    const stamp = timeline(page).getByRole('listitem').filter({ hasText: 'แชท LINE' })
    await expect(stamp).toContainText('อนุมัติ')
    await expect(stamp).toContainText('วีระ ปฏิบัติการ')
    await expect(stamp).toContainText('DOA-DEMO ฉบับ 1 ข้อ PR-02')
    await checkScreen(page, testInfo, 'liff-request-view-approved')
  })

  test('[FR-LINE-003/AC1] [FR-INT-008/AC2] the requester sees the same status of a request in LIFF and on the web', async ({ page, context, browser }, testInfo) => {
    // AC2 names the requester and the followers; followers cannot be added until the follower service exists (NEW-29)
    testInfo.annotations.push({ type: 'covers', description: 'FR-INT-008 AC2 for the requester only; the followers wait for NEW-29' })
    const lineUserId = newLineUserId()
    const { member, requestId, number } = liffRequestsScene<{ member: SceneMember } & SceneRequest>('approved', sceneTag('same'), lineUserId)
    await openAsLineUser(context, lineUserId)
    await page.goto(`/liff/requests/${requestId}`)
    await expect(page.getByRole('heading', { level: 1, name: number })).toBeVisible()
    const liffNow = (await nowLine(page).textContent())?.trim()
    await expect(page.getByText('อนุมัติแล้ว', { exact: true }).first()).toBeVisible()

    // The same phone's browser, outside LINE: the web sign-in with the password, then the workspace's request page
    const web = await anotherPhone(browser)
    try {
      const webPage = await web.newPage()
      await webPage.goto('/login')
      await webPage.getByLabel('อีเมลบริษัท').fill(member.email)
      await webPage.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
      await webPage.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
      await expect(webPage.getByRole('heading', { level: 1 })).toContainText('สวัสดี')
      await webPage.goto(`/requests/${requestId}`)
      await expect(webPage.getByText('อนุมัติแล้ว', { exact: true }).first()).toBeVisible()
      expect((await nowLine(webPage).textContent())?.trim()).toBe(liffNow)
      await expect(webPage.getByRole('list', { name: 'ไทม์ไลน์ของคำขอ' }).getByRole('listitem').filter({ hasText: 'แชท LINE' })).toContainText('DOA-DEMO ฉบับ 1 ข้อ PR-02')
    } finally {
      await web.close()
    }
  })

  test('[FR-LINE-003/AC1] a member who may not view a request is refused in LIFF and is sent nothing of it', async ({ page, context }, testInfo) => {
    const { requestId, number } = liffRequestsScene<SceneRequest>('approved', sceneTag('owner'), newLineUserId())
    const stranger = newLineUserId()
    liffRequestsScene('requester', sceneTag('stranger'), stranger, 'IT')
    await openAsLineUser(context, stranger)
    await page.goto(`/liff/requests/${requestId}`)
    // request.view: neither the requester nor a follower, no task on it, no organization-wide role
    await expect(page.getByRole('heading', { level: 1, name: 'คุณไม่มีสิทธิ์ดูคำขอนี้' })).toBeVisible()
    await expect(page.getByText(number)).toHaveCount(0)
    const html = await (await page.request.get(`/liff/requests/${requestId}`)).text()
    expect(html).not.toContain(number)
    expect(html).not.toContain('ไม้อัดและตะปู')
    await checkScreen(page, testInfo, 'liff-request-forbidden')
  })

  test('[FR-LINE-003/AC1] [FR-INT-009/AC3] [FR-INT-009/AC1] the requester answers the approver’s question from the bar at the bottom and cancels the request from LIFF; the budget goes back at once', async ({
    page,
    context,
  }, testInfo) => {
    // AC3 names the requester being told, the hand-back to the approver who asked and the SLA going on from the time left
    testInfo.annotations.push({ type: 'covers', description: 'FR-INT-009 AC3 in part: the answer from LIFF goes back to the approver who asked; the SLA (GC-SLA-06) is S5-07’s' })
    const lineUserId = newLineUserId()
    const { requestId, number } = liffRequestsScene<SceneRequest>('asked', sceneTag('asked'), lineUserId)
    await openAsLineUser(context, lineUserId)
    // The LINE message about the question opens the request's LIFF page: the question, and where to answer it
    await page.goto(`/liff/requests/${requestId}`)
    await expect(page.getByRole('heading', { level: 1, name: number })).toBeVisible()
    await expect(nowLine(page)).toContainText('รอคุณตอบคำถามของผู้อนุมัติ')
    await expect(toDo(page)).toContainText('ขอใบเสนอราคาไม้อัดจากผู้ขายอีกราย')
    // §9.9: one column, the main button at the bottom of the screen while the page scrolls
    const send = requesterBar(page).getByRole('button', { name: 'ส่งคำตอบให้ผู้อนุมัติ' })
    await expect(send).toBeVisible()
    await expect(requesterBar(page)).toBeInViewport()
    await checkScreen(page, testInfo, 'liff-request-question')
    await firstScreen(page, testInfo, 'liff-request-question')
    // An empty answer is not sent: the field says what to do and takes the focus
    await send.click()
    await expect(toDo(page).getByText('ใส่คำตอบก่อนส่ง')).toBeVisible()
    const answer = toDo(page).getByLabel('คำตอบของคุณ')
    await expect(answer).toBeFocused()
    await answer.fill('ขอราคาจากผู้ขายรายที่สองแล้ว สูงกว่ารายแรก 5%')
    await send.click()
    await expect(toDo(page).getByRole('status').filter({ hasText: 'ส่งคำตอบให้ผู้อนุมัติแล้ว' })).toBeVisible()
    // The answer is stamped with its channel, and the task is back with the approver who asked; nothing is left to do
    await expect(timeline(page).getByRole('listitem').filter({ hasText: 'ตอบข้อมูลเพิ่ม' })).toContainText('LINE (LIFF)')
    await expect(nowLine(page)).toContainText('รอ วีระ ปฏิบัติการ')
    await expect(requesterBar(page)).toHaveCount(0)

    // FR-INT-009 AC1: a reason and a tick first, as it cannot be undone (§9.9)
    await page.locator('summary').filter({ hasText: 'ยกเลิกคำขอ' }).click()
    const cancel = page.getByRole('button', { name: 'ยกเลิกคำขอนี้' })
    await expect(cancel).toBeVisible()
    await checkScreen(page, testInfo, 'liff-request-cancel-form')
    await cancel.click()
    await expect(page.getByText('ใส่เหตุผลอย่างน้อย 3 ตัวอักษร')).toBeVisible()
    await expect(page.getByText('ติ๊กยืนยันก่อน เพราะย้อนกลับไม่ได้')).toBeVisible()
    await checkScreen(page, testInfo, 'liff-request-cancel-errors')
    await page.getByLabel('เหตุผลที่ยกเลิก').fill('ใช้งบโครงการอื่นแทน')
    await page.getByLabel('ฉันต้องการยกเลิกคำขอนี้ และเข้าใจว่าย้อนกลับไม่ได้').check()
    await cancel.click()
    await expect(page.getByRole('status').filter({ hasText: 'ยกเลิกคำขอแล้ว' })).toBeVisible()
    await expect(page.getByText('ยกเลิกแล้ว', { exact: true }).first()).toBeVisible()
    // The budget the request held went back at once
    await expect(page.getByText('คืนงบแล้ว')).toBeVisible()
    await expect(timeline(page).getByRole('listitem').filter({ hasText: 'ยกเลิกคำขอ' })).toContainText('LINE (LIFF)')
    // The answer's confirmation stays after the page rendered again
    await expect(toDo(page).getByRole('status').filter({ hasText: 'ส่งคำตอบให้ผู้อนุมัติแล้ว' })).toBeVisible()
    await checkScreen(page, testInfo, 'liff-request-cancelled')
  })

  test('[FR-LINE-003/AC1] [FR-INT-009/AC2] a returned request shows the approver’s reason and is sent again from the bar in LIFF, on a new route', async ({ page, context }, testInfo) => {
    const lineUserId = newLineUserId()
    const { requestId, number } = liffRequestsScene<SceneRequest>('returned', sceneTag('returned'), lineUserId)
    await openAsLineUser(context, lineUserId)
    // The LINE message about the return opens the request's LIFF page
    await page.goto(`/liff/requests/${requestId}`)
    await expect(page.getByRole('heading', { level: 1, name: number })).toBeVisible()
    await expect(page.getByText('ตีกลับให้แก้ไข', { exact: true }).first()).toBeVisible()
    await expect(nowLine(page)).toContainText('รอคุณแก้ไขแล้วส่งอีกครั้ง')
    await expect(toDo(page)).toContainText('ผู้อนุมัติตีกลับให้แก้ไข')
    await expect(toDo(page)).toContainText('เหตุผล: แยกรายการไม้อัดตามความหนาก่อนส่งอีกครั้ง')
    // The bar: change it first in the LIFF form, or send it again as it is
    await expect(requesterBar(page).getByRole('link', { name: 'แก้ไขคำขอ' })).toHaveAttribute('href', `/liff/requests/${requestId}/edit`)
    const resend = requesterBar(page).getByRole('button', { name: 'ส่งขออนุมัติอีกครั้ง' })
    await expect(requesterBar(page)).toBeInViewport()
    await checkScreen(page, testInfo, 'liff-request-returned')
    await firstScreen(page, testInfo, 'liff-request-returned')

    await resend.click()
    // §9.9 rule 7: the confirmation repeats the button's words; the request waits for its approver again
    await expect(toDo(page).getByRole('status').filter({ hasText: 'ส่งขออนุมัติอีกครั้งแล้ว' })).toBeVisible()
    await expect(page.getByText('รออนุมัติ', { exact: true }).first()).toBeVisible()
    await expect(nowLine(page)).toContainText('รอ วีระ ปฏิบัติการ')
    await expect(requesterBar(page)).toHaveCount(0)
    // BR-DOA-09: the route is worked out again; the resend is stamped with its channel, in the timeline and the Event
    await expect(timeline(page).getByRole('listitem').filter({ hasText: 'ส่งขออนุมัติอีกครั้ง' }).first()).toContainText('LINE (LIFF)')
    expect(liffRequestsScene<{ resubmitted: string[] }>('channels', requestId).resubmitted).toEqual(['LIFF'])
    await checkScreen(page, testInfo, 'liff-request-resubmitted')
  })

  test('[FR-LINE-003/AC1] [FR-INT-004/AC2] [FR-INT-002/AC1] [FR-INT-006/AC1] [FR-INT-005/AC3] scene 4: a request beyond the budget cannot be sent from LIFF and says by how much; the draft saves itself, takes a photo with the camera, and once cancelled from its page leaves nothing to do', async ({
    page,
    context,
  }, testInfo) => {
    const lineUserId = newLineUserId()
    // An IT requester whose last IT purchase went on IT-OPEX-2569 (sent and cancelled): other specs of the run add budget
    // lines to IT, so the line this form fills is the requester's own history, not IT's only line
    liffRequestsScene('requester', sceneTag('scene4'), lineUserId, 'IT', 'history')
    await openAsLineUser(context, lineUserId)

    // A link from LINE straight to the type's form: the gate signs in first, then the form shows
    await page.goto('/liff/requests/new/IT_PURCHASE')
    await expect(page.getByRole('heading', { level: 1, name: 'คำขอใหม่: ซื้ออุปกรณ์/ซอฟต์แวร์ไอที' })).toBeVisible()
    // BR-FORM-02: the line the requester used last for this type, with what is left on it
    await expect(page.getByLabel('บรรทัดงบที่ใช้').locator('option:checked')).toHaveText(/^IT-OPEX-2569 · /)
    await expect(remainingOf(page)).toContainText(/[\d,]+\.\d{2} บาท/)
    const available = satangOf((await remainingOf(page).textContent())!.replace('งบคงเหลือของบรรทัดนี้', ''))
    await page.getByLabel('ชื่อคำขอ').fill('เซิร์ฟเวอร์สำรองข้อมูล')
    // FR-INT-002 AC1: the asset tag is asked for hardware only, as soon as it is chosen
    await expect(page.getByLabel(/^เลขทะเบียนทรัพย์สิน/)).toHaveCount(0)
    await page.getByRole('radio', { name: 'ฮาร์ดแวร์' }).check()
    await expect(page.getByLabel(/^เลขทะเบียนทรัพย์สิน/)).toBeVisible()
    for (const question of [/ประมวลผลข้อมูลส่วนบุคคล/, /เข้าถึงระบบหรือข้อมูลภายใน/, /เข้าพื้นที่ทำงาน/]) {
      await page.getByRole('group', { name: question }).getByRole('radio', { name: 'ไม่ใช่' }).check()
    }
    await checkScreen(page, testInfo, 'liff-request-it-details')

    await nextStep(page, 'รายการที่ขอ')
    // Scene 4 asks 60,000 of a line with 25,000 left; here the line has what the run left on it, and the server is asked
    // for 35,000.00 more than that
    const shortfall = 3_500_000n
    const price = available + shortfall
    await fillLine(page.getByRole('group', { name: 'รายการที่ 1' }), { description: 'เซิร์ฟเวอร์สำรองข้อมูล', quantity: '1', uom: 'เครื่อง', price: `${price / 100n}.${String(price % 100n).padStart(2, '0')}` })
    await expect(page.getByText(`งบไม่พอ ขาด ${shown(shortfall)} บาท ลดยอดหรือเลือกบรรทัดงบอื่น`)).toBeVisible()
    await checkScreen(page, testInfo, 'liff-request-over-budget-items')

    await nextStep(page, 'ตรวจและส่ง')
    // FR-INT-004 AC2: the button says why and by how much, and cannot send
    const send = page.getByRole('button', { name: 'ส่งขออนุมัติ', exact: true })
    await expect(send).toBeDisabled()
    await expect(page.getByText(`ส่งไม่ได้เพราะงบไม่พอ: คงเหลือ ${shown(available)} บาท ขาด ${shown(shortfall)} บาท ลดยอดหรือเลือกบรรทัดงบอื่น`)).toBeVisible()
    // §9.9 principle 3: "ตรวจก่อนส่ง" leads with the same reason and figures, and never says the request can be sent. Once
    // what the run left on the line and 35,000.00 more is above 100,000.00 baht with VAT, the quotation rule (ATT-QUOTES)
    // is listed too, which kept the ready line away even when the step left the budget out: the budget point is the check
    // that tells the two apart. Over budget with nothing else to fix: demo scene 4 (tests/e2e/demo/04-budget-blocks.spec.ts)
    // and tests/unit/request-form-review.test.tsx
    const beforeSending = page.getByRole('region', { name: 'ตรวจก่อนส่ง' })
    await expect(beforeSending).toContainText(`งบไม่พอ: คงเหลือ ${shown(available)} บาท ขาด ${shown(shortfall)} บาท ลดยอดหรือเลือกบรรทัดงบอื่น (ต้องแก้ก่อนส่ง)`)
    await expect(beforeSending).not.toContainText('ข้อมูลที่ตรวจได้บนหน้านี้ครบแล้ว กดส่งได้')
    await checkScreen(page, testInfo, 'liff-request-over-budget')
    await firstScreen(page, testInfo, 'liff-request-over-budget')

    // FR-INT-006 AC1: the draft saved itself 10 seconds after the last change, and the page's address became the draft's;
    // opened again, the form goes on from it
    await expect(page.getByText(/^บันทึกร่างแล้วเมื่อ /)).toBeVisible({ timeout: 25_000 })
    await expect(page).toHaveURL(/\/liff\/requests\/[0-9a-f-]{36}\/edit$/)
    await page.reload()
    await expect(page.getByRole('heading', { level: 1, name: 'ร่างคำขอ: ซื้ออุปกรณ์/ซอฟต์แวร์ไอที' })).toBeVisible()
    await expect(page.getByLabel('ชื่อคำขอ')).toHaveValue('เซิร์ฟเวอร์สำรองข้อมูล')
    await expect(page.getByRole('radio', { name: 'ฮาร์ดแวร์' })).toBeChecked()
    await expect(page.getByText('ร่างนี้บันทึกไว้แล้ว การแก้ไขจะบันทึกให้อัตโนมัติ')).toBeVisible()

    // FR-INT-005 AC3: the phone's camera, one tap away in LIFF (§9.4: accept="image/*" capture="environment"); the photo
    // is made smaller and a JPEG in the browser (FR-PLT-004 AC3), then attached as รูปถ่าย. Above 100,000 baht with VAT
    // the rule asks for quotations, so the documents show, with the general picker that takes a PDF quotation too
    await nextStep(page, 'รายการที่ขอ')
    await nextStep(page, 'ตรวจและส่ง')
    const camera = page.getByLabel('ถ่ายรูปแนบคำขอ')
    await expect(camera).toHaveAttribute('accept', 'image/*')
    await expect(camera).toHaveAttribute('capture', 'environment')
    const files = page.getByRole('region', { name: 'ไฟล์แนบอื่น' })
    await expect(files.locator('input[type="file"]')).toHaveAttribute('accept', /application\/pdf/)
    await camera.setInputFiles({ name: 'server-room.png', mimeType: 'image/png', buffer: PHOTO_PNG })
    await expect(page.getByRole('status').filter({ hasText: 'แนบรูป server-room.jpg แล้ว' })).toBeVisible()
    await expect(files.getByRole('listitem').filter({ hasText: 'server-room.jpg' })).toContainText('รูปถ่าย')
    const draftId = /\/liff\/requests\/([0-9a-f-]{36})\/edit$/.exec(page.url())![1]!
    expect(liffRequestsScene<{ drafted: string[] }>('channels', draftId).drafted).toEqual(['LIFF'])
    await checkScreen(page, testInfo, 'liff-request-photo')

    // The draft's own page: what it needs, and the way back to the form in the bar at the bottom
    await page.goto(`/liff/requests/${draftId}`)
    await expect(page.getByRole('heading', { level: 1, name: 'ร่างคำขอ' })).toBeVisible()
    await expect(toDo(page)).toContainText('คำขอนี้ยังเป็นร่าง')
    await expect(requesterBar(page).getByRole('link', { name: 'แก้ไขร่างแล้วส่งขออนุมัติ' })).toHaveAttribute('href', `/liff/requests/${draftId}/edit`)
    await expect(requesterBar(page)).toBeInViewport()
    await checkScreen(page, testInfo, 'liff-request-draft')
    await firstScreen(page, testInfo, 'liff-request-draft')

    // Cancelled from its own page, with nothing else done first: the confirmation where it was cancelled, and no empty
    // "สิ่งที่ต้องทำ" or bar left over a request that has nothing more to do
    await page.locator('summary').filter({ hasText: 'ยกเลิกคำขอ' }).click()
    await page.getByLabel('เหตุผลที่ยกเลิก').fill('ซื้อผ่านโครงการอื่นแล้ว')
    await page.getByLabel('ฉันต้องการยกเลิกคำขอนี้ และเข้าใจว่าย้อนกลับไม่ได้').check()
    await page.getByRole('button', { name: 'ยกเลิกคำขอนี้' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'ยกเลิกคำขอแล้ว' })).toBeVisible()
    await expect(page.getByText('ยกเลิกแล้ว', { exact: true }).first()).toBeVisible()
    await expect(toDo(page)).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'สิ่งที่ต้องทำ' })).toHaveCount(0)
    await expect(requesterBar(page)).toHaveCount(0)
    await checkScreen(page, testInfo, 'liff-request-draft-cancelled')
  })

  test('[FR-LINE-003/AC1] [FR-INT-006/AC1] what the requester typed in LIFF is saved when they leave the page — also before the form’s rules and autosave have arrived, and the autosave goes on from that draft', async ({
    page,
    context,
    browser,
  }) => {
    // Parts 5 and 6 leave a page for real, another page loading in its place, in a LINE app where the PWA's service
    // worker controls the LIFF pages: Chromium drops the keepalive save of a page that another page replaces when the
    // worker controls it, so the worker sends every POST straight to the network (the Static Routing API, src/app/sw.js)
    // and the saves arrive with it in place
    const lineUserId = newLineUserId()
    const tag = sceneTag('leave')
    liffRequestsScene('requester', tag, lineUserId, 'CON')
    await openAsLineUser(context, lineUserId)
    const draftsOf = () => liffRequestsScene<SceneDraft[]>('drafts', tag)
    const titleOf = (id: string) => draftsOf().find((d) => d.id === id)?.title ?? null
    const titleField = page.getByLabel('ชื่อคำขอ')
    const catalog = page.getByRole('heading', { level: 1, name: 'ขอซื้อ / ขอจ้าง' })
    const toCatalog = page.getByRole('link', { name: 'ประเภทคำขอ' })

    // 1. LINE's window goes away (its pagehide) before the engine arrived. A slow mobile network: the form's engine — its
    //    rules and the autosave, fetched on the first touch — takes 4 seconds
    await page.goto('/liff/requests/new/BUY_GOODS')
    await expect(stepHeading(page, 1, 'รายละเอียดคำขอ')).toBeVisible()
    await page.waitForLoadState('networkidle')
    await page.route('**/_next/static/**', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 4_000))
      await route.continue()
    })
    const typed = `ร่างก่อนกฎมาถึง ${tag}`
    await titleField.fill(typed)
    // Without the engine the form has not saved or counted anything yet
    await expect(page.getByText('ร่างจะถูกบันทึกให้อัตโนมัติเมื่อคุณเริ่มกรอก')).toBeVisible()
    // What was typed goes as a keepalive request, which the browser sends on after the page is gone; here the page stays,
    // so the test reads the answer
    const saved = page.waitForResponse((r) => new URL(r.url()).pathname === '/liff/requests/new/autosave' && r.request().method() === 'POST')
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })))
    const response = await saved
    expect(response.status()).toBe(200)
    // The first screen's save: what step 1 changed, under the names of the workspace's autosave (the engine's would carry
    // the lines too), creating the draft
    const body = response.request().postDataJSON() as { requestId: string | null; draft: Record<string, unknown> }
    expect(body.requestId).toBeNull()
    expect(body.draft).toMatchObject({ title: typed, priceIncludesVat: false, formData: {} })
    expect(body.draft).not.toHaveProperty('lines')
    await expect(page).toHaveURL(/\/liff\/requests\/[0-9a-f-]{36}\/edit$/)
    await expect(page.getByText('ร่างนี้บันทึกไว้แล้ว การแก้ไขจะบันทึกให้อัตโนมัติ')).toBeVisible()
    const [early] = draftsOf()
    expect(early).toMatchObject({ title: typed, channels: ['LIFF'] })
    const draftId = early!.id
    expect(page.url()).toContain(draftId)

    // 2. The engine arrives and its autosave goes on from that draft and its version: one draft, never a second
    const second = `ร่างต่อจากที่บันทึกไว้ ${tag}`
    await titleField.fill(second)
    await expect(page.getByText(/^มีการแก้ไขที่ยังไม่บันทึก/)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(/^บันทึกร่างแล้วเมื่อ /)).toBeVisible({ timeout: 25_000 })
    expect(draftsOf().map((d) => ({ id: d.id, title: d.title }))).toEqual([{ id: draftId, title: second }])

    // 3. Another page of the LIFF app before the engine arrived: the catalogue and the form are loaded, then the engine is
    //    held for good; the title typed goes when the requester taps back to the request types
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    await page.goto('/liff/requests/new')
    await page.getByRole('link', { name: /เริ่มคำขอ ซื้อของ$/ }).click()
    await expect(stepHeading(page, 1, 'รายละเอียดคำขอ')).toBeVisible()
    await page.waitForLoadState('networkidle')
    await page.route('**/_next/static/**', () => {
      // Never answered, as a script still on its way
    })
    const other = `ร่างที่ออกไปหน้าอื่นก่อนกฎมาถึง ${tag}`
    await titleField.fill(other)
    await expect(page.getByText('ร่างจะถูกบันทึกให้อัตโนมัติเมื่อคุณเริ่มกรอก')).toBeVisible()
    await toCatalog.click()
    await expect(catalog).toBeVisible()
    await expect.poll(async () => draftsOf().map((d) => d.title).sort(), { timeout: 20_000 }).toEqual([second, other].sort())
    // The page left keeps its own address
    expect(new URL(page.url()).pathname).toBe('/liff/requests/new')

    // 4. With the engine there, an edit and going back at once — before the 10 seconds of idle: the autosave saves it
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    await page.goto(`/liff/requests/${draftId}/edit`)
    await expect(titleField).toHaveValue(second)
    const third = `ร่างแก้แล้วกลับไปหน้าประเภท ${tag}`
    await titleField.fill(third)
    await expect(page.getByText(/^มีการแก้ไขที่ยังไม่บันทึก/)).toBeVisible()
    await toCatalog.click()
    await expect(catalog).toBeVisible()
    await expect.poll(async () => titleOf(draftId), { timeout: 20_000 }).toBe(third)

    // 5. The page itself goes, another page loading in its place: the autosave's keepalive request carries the edit. In a
    //    LINE app of its own, where the PWA's service worker controls the LIFF pages (the case where Chromium dropped it)
    const phone = await browser.newContext({
      ...devices['Pixel 7'],
      viewport: { width: 375, height: 812 },
      baseURL: E2E_BASE_URL,
      locale: 'th-TH',
      timezoneId: 'Asia/Bangkok',
      extraHTTPHeaders: { 'x-forwarded-for': `198.19.${randomInt(1, 250)}.${randomInt(1, 250)}` },
    })
    try {
      await withPwaWorker(phone)
      await openAsLineUser(phone, lineUserId)
      const closing = await phone.newPage()
      await closing.goto(`/liff/requests/${draftId}/edit`)
      await expect(closing.getByLabel('ชื่อคำขอ')).toHaveValue(third)
      expect(await controlledByWorker(closing)).toBe(true)
      const fourth = `ร่างแก้แล้วปิดหน้า ${tag}`
      await closing.getByLabel('ชื่อคำขอ').fill(fourth)
      await expect(closing.getByText(/^มีการแก้ไขที่ยังไม่บันทึก/)).toBeVisible()
      await closing.goto('/liff/track')
      await expect.poll(async () => titleOf(draftId), { timeout: 20_000 }).toBe(fourth)

      // 6. The page goes for real before the engine arrived: the early save's keepalive request carries the title. The
      //    engine's script is held by the browser's own request interception, for script files only, so the save is not
      //    touched (a Playwright route holds every request of the page)
      const early = await phone.newPage()
      await early.goto('/liff/requests/new/BUY_GOODS')
      await expect(stepHeading(early, 1, 'รายละเอียดคำขอ')).toBeVisible()
      await early.waitForLoadState('networkidle')
      expect(await controlledByWorker(early)).toBe(true)
      const browserSide = await phone.newCDPSession(early)
      // Never answered, as a script still on its way when LINE's window closes
      browserSide.on('Fetch.requestPaused', () => undefined)
      await browserSide.send('Fetch.enable', { patterns: [{ urlPattern: '*/_next/static/chunks/*', requestStage: 'Request' }] })
      const closed = `ร่างที่ปิดหน้าก่อนกฎมาถึง ${tag}`
      await early.getByLabel('ชื่อคำขอ').fill(closed)
      await expect(early.getByText('ร่างจะถูกบันทึกให้อัตโนมัติเมื่อคุณเริ่มกรอก')).toBeVisible()
      // The next page's scripts are held too: the address is enough
      await early.goto('/liff/track', { waitUntil: 'commit' })
      await expect.poll(async () => draftsOf().find((d) => d.title === closed)?.channels ?? null, { timeout: 20_000 }).toEqual(['LIFF'])
    } finally {
      await phone.close()
    }
  })
})

type Catalogue = Record<string, unknown>
const CATALOGUES: Readonly<Record<'th' | 'en', Catalogue>> = {
  th: JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../messages/th.json'), 'utf8')) as Catalogue,
  en: JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../messages/en.json'), 'utf8')) as Catalogue,
}

/** The words of a message in one language, with its arguments filled in */
function say(locale: 'th' | 'en', key: string, values: Readonly<Record<string, string>> = {}): string {
  const words = key.split('.').reduce<unknown>((node, name) => (node && typeof node === 'object' ? (node as Catalogue)[name] : undefined), CATALOGUES[locale])
  if (typeof words !== 'string') throw new Error(`${key} is not a message in ${locale}`)
  return words.replace(/\{(\w+)\}/g, (all, name: string) => values[name] ?? all)
}

/** A message key where words should be: a namespace of the catalogue, then dot-separated names */
const KEY = new RegExp(`(?<![\\w.@/:-])(?:${Object.keys(CATALOGUES.th).join('|')})\\.[A-Za-z][\\w]*(?:\\.[\\w]+)*`, 'g')

test.describe('[NFR-I18N-01] [§9.4] steps 2 and 3 of the LIFF form bring their own words', () => {
  test.describe.configure({ timeout: SCENE_TIMEOUT_MS })

  // The form's page passes its shell and step 1 only the words they read (src/i18n/client-messages.ts liffRequestForm):
  // steps 2 and 3 are loaded when the requester gets there, with the rest of the form's words in their own chunk
  // (src/ui/liff/requests/step-words.tsx). In Thai and in English: the steps say their words in the page's language,
  // never a key, next-intl logs no missing message, and the form's HTML carries none of the words of steps 2 and 3.
  for (const locale of ['th', 'en'] as const) {
    test(`[FR-LINE-003/AC1] [FR-PLT-002/AC2] in ${locale === 'th' ? 'Thai' : 'English'}: the words of steps 2 and 3 come with the steps, and the form’s HTML has only those of step 1`, async ({
      page,
      context,
    }, testInfo) => {
      const lineUserId = newLineUserId()
      const tag = sceneTag(`steps-${locale}`)
      liffRequestsScene<{ member: SceneMember }>('requester', tag, lineUserId, 'CON', 'history')
      await context.addCookies([{ name: localeCookieName, value: locale, url: E2E_BASE_URL }])
      await openAsLineUser(context, lineUserId)
      const missing: string[] = []
      page.on('console', (message) => {
        if (message.type() === 'error' && /MISSING_MESSAGE|INSUFFICIENT_PATH|INVALID_MESSAGE/.test(message.text())) missing.push(message.text())
      })
      const other = locale === 'th' ? 'en' : 'th'
      const heading = (n: number, step: string) => page.getByRole('heading', { level: 2, name: say(locale, 'requestForm.steps.heading', { n: String(n), total: '3', name: say(locale, `requestForm.steps.${step}`) }) })
      const next = (step: string) => page.getByRole('button', { name: say(locale, 'requestForm.steps.next', { name: say(locale, `requestForm.steps.${step}`) }) })
      /** Words of steps 2 and 3 only: the review, the route, adding a line, the documents */
      const later = ['requestForm.review.summary', 'requestForm.route.title', 'requestForm.lines.add', 'liffRequests.form.documentsOpen'] as const

      // The gate signs in with LINE first; the form opened again has its LIFF session and its content in the HTML
      await page.goto('/liff/requests/new/BUY_GOODS')
      await expect(heading(1, 'details')).toBeVisible()
      const opened = await page.goto('/liff/requests/new/BUY_GOODS')
      const html = (await opened?.text()) ?? ''
      await expect(heading(1, 'details')).toBeVisible()
      expect(html).toContain(say(locale, 'requestForm.details.title'))
      for (const key of later) expect(html, `${key} in the form's HTML`).not.toContain(say(locale, key))
      await page.getByLabel(say(locale, 'requestForm.details.title')).fill(`ไม้อัด ${tag}`)

      await next('items').click()
      await expect(heading(2, 'items')).toBeVisible()
      await expect(page.getByRole('button', { name: say(locale, 'requestForm.lines.add') })).toBeVisible()
      await expect(page.getByLabel(say(locale, 'requestForm.site.label'))).toBeVisible()
      await page.screenshot({ path: testInfo.outputPath(`liff-request-form-items-${locale}.png`), fullPage: true })

      await next('review').click()
      await expect(heading(3, 'review')).toBeVisible()
      await expect(page.getByRole('heading', { level: 2, name: say(locale, 'requestForm.review.summary') })).toBeVisible()
      await expect(page.getByRole('heading', { level: 2, name: say(locale, 'requestForm.route.title') })).toBeVisible()
      await expect(page.getByRole('button', { name: say(locale, 'liffRequests.form.documentsOpen') })).toBeVisible()
      await page.waitForLoadState('networkidle')
      await page.screenshot({ path: testInfo.outputPath(`liff-request-form-review-${locale}.png`), fullPage: true })

      const text = await page.locator('body').innerText()
      expect(text.match(KEY) ?? []).toEqual([])
      for (const key of later) expect(text, `${key} in ${other}`).not.toContain(say(other, key))
      expect(missing).toEqual([])
    })
  }
})

interface SceneStates {
  readonly member: { readonly id: string }
  readonly approved: SceneRequest
  readonly asked: SceneRequest
  readonly returned: SceneRequest
  readonly draft: { readonly requestId: string }
}

/** Every page is opened twice and signed in once, each in a LINE app of its own: more time than a scene's */
const BUDGET_TIMEOUT_MS = 300_000

test.describe('[§9.4] the first JavaScript of the LIFF request pages: their script files with the LINE SDK, and the page data in their HTML, are at most 200 KB gzip', () => {
  test.describe.configure({ timeout: BUDGET_TIMEOUT_MS })

  /** A requester's pages in every state a LINE message opens them in, and a draft and a sent request of realistic size */
  function requesterScene(lineUserId: string) {
    const tag = sceneTag('size')
    const states = liffRequestsScene<SceneStates>('states', tag, lineUserId)
    const draft = liffBudgetScene<{ requestId: string; title: string }>('draft', states.member.id, String(BUDGET_DOCUMENT_LINES), tag)
    const sent = liffBudgetScene<SceneRequest>('sent', states.member.id, String(BUDGET_DOCUMENT_LINES), tag)
    return { states, draft, sent }
  }
  const numbered = (request: SceneRequest) => (page: Page) => expect(page.getByRole('heading', { level: 1, name: request.number })).toBeVisible()
  const formReady = (page: Page) => expect(stepHeading(page, 1, 'รายละเอียดคำขอ')).toBeVisible()

  // Every first load weighed here is also held to having no tailwind-merge (expectFirstLoadWithinBudget): the check looks
  // for a string of tailwind-merge in the scripts, and finds it where the workspace loads it
  test('the check for tailwind-merge in a first load finds it where it is: the sign-in page, whose form joins its classes with src/ui/cn.ts', async ({ page }) => {
    const scripts = watchScripts(page)
    await page.goto(TAILWIND_MERGE_PAGE)
    // Enabled once the page's script runs (src/ui/form/hydrated.ts)
    await expect(page.getByRole('button', { name: 'เข้าสู่ระบบ' })).toBeEnabled()
    await page.waitForLoadState('networkidle')
    expect((await scripts()).filter((l) => l.merge).length, `${TAILWIND_MERGE_PAGE}: a script with tailwind-merge`).toBeGreaterThan(0)
  })

  test('the catalogue, the request page in every state a LINE message opens it in, a request of 40 lines, and the list — each opened from LINE and again with the LIFF session, in a fresh LINE app', async ({
    browser,
  }, testInfo) => {
    const lineUserId = newLineUserId()
    const { states, sent } = requesterScene(lineUserId)
    /** The page with what the requester does now: the main button in the bar at the bottom (a part loaded with the page) */
    const withBar = (request: SceneRequest) => async (page: Page) => {
      await numbered(request)(page)
      await expect(requesterBar(page).getByRole('button').first()).toBeVisible()
    }
    const screens: ReadonlyArray<Omit<LiffBudgetScreen, 'lineUserId'>> = [
      { name: '/liff/requests/new', path: '/liff/requests/new', ready: (page) => expect(page.getByRole('link', { name: /เริ่มคำขอ ซื้อของ$/ })).toBeVisible() },
      { name: '/liff/requests/[id] approved', path: `/liff/requests/${states.approved.requestId}`, ready: numbered(states.approved) },
      { name: '/liff/requests/[id] with a question', path: `/liff/requests/${states.asked.requestId}`, ready: withBar(states.asked) },
      { name: '/liff/requests/[id] returned', path: `/liff/requests/${states.returned.requestId}`, ready: withBar(states.returned) },
      {
        name: '/liff/requests/[id] draft',
        path: `/liff/requests/${states.draft.requestId}`,
        ready: async (page) => {
          await expect(page.getByRole('heading', { level: 1, name: 'ร่างคำขอ' })).toBeVisible()
          await expect(requesterBar(page).getByRole('link', { name: 'แก้ไขร่างแล้วส่งขออนุมัติ' })).toBeVisible()
        },
      },
      { name: `/liff/requests/[id] waiting for approval, ${BUDGET_DOCUMENT_LINES} lines`, path: `/liff/requests/${sent.requestId}`, ready: numbered(sent) },
      { name: '/liff/track', path: '/liff/track', ready: (page) => expect(page.getByRole('link', { name: new RegExp(`^${states.approved.number} · `) })).toBeVisible() },
    ]
    for (const screen of screens) await expectFirstLoadsWithinBudget(browser, testInfo, { ...screen, lineUserId })
  })

  /** The form: new, a draft of realistic size at the address its first save gave it, and a returned request */
  function formScreens(lineUserId: string): readonly LiffBudgetScreen[] {
    const { states, draft } = requesterScene(lineUserId)
    return [
      { name: '/liff/requests/new/BUY_GOODS', lineUserId, path: '/liff/requests/new/BUY_GOODS', ready: formReady },
      // The form at the address a draft gets after its first save, opened again (a reload in LINE, the draft's link), and
      // the form of a returned request (its "แก้ไขคำขอ" link): the same form with the draft's own values
      {
        name: `/liff/requests/[id]/edit draft, ${BUDGET_DOCUMENT_LINES} lines`,
        lineUserId,
        path: `/liff/requests/${draft.requestId}/edit`,
        ready: async (page) => {
          await formReady(page)
          await expect(page.getByLabel('ชื่อคำขอ')).toHaveValue(draft.title)
        },
      },
      {
        name: '/liff/requests/[id]/edit returned',
        lineUserId,
        path: `/liff/requests/${states.returned.requestId}/edit`,
        ready: async (page) => {
          await formReady(page)
          await expect(page.getByText('แยกรายการไม้อัดตามความหนาก่อนส่งอีกครั้ง')).toBeVisible()
        },
      },
    ]
  }

  // The form is weighed in two tests, one per way LINE opens it, so that each shows on its own. Opened from LINE the HTML
  // is the gate's, without the form's words (src/app/liff/_lib/part-messages.tsx). Opened with its LIFF session the form
  // carries its data and the words of its shell and step 1 in the HTML; what keeps that within the budget is the form's
  // own — the words of steps 2 and 3 loaded with those steps (src/ui/liff/requests/step-words.tsx), neither the request
  // page's words nor the catalogue's on it (route groups of their own), the draft's lines written once
  // (src/ui/liff/requests/lines.ts), and no tailwind-merge in the LIFF components — not the weighing
  test('the form opened from LINE: new, a draft of 40 lines at the address its first save gave it, and a returned request, each in a fresh LINE app', async ({ browser }, testInfo) => {
    for (const screen of formScreens(newLineUserId())) {
      expectFirstLoadWithinBudget(testInfo, `${screen.name}, opened from LINE`, await weighOpenedFromLine(browser, screen))
    }
  })

  test('the form with the LIFF session: new, a draft of 40 lines at the address its first save gave it, and a returned request, each in a fresh LINE app', async ({ browser }, testInfo) => {
    for (const screen of formScreens(newLineUserId())) {
      expectFirstLoadWithinBudget(testInfo, `${screen.name}, with the LIFF session`, await weighWithLiffSession(browser, screen))
    }
  })
})
