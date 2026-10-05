import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { BrowserContext, Page, TestInfo } from '@playwright/test'
import { E2E_BASE_URL, E2E_PIN, e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'
import {
  BUDGET_DOCUMENT_LINES,
  checkScreen,
  expectFirstLoadsWithinBudget,
  expectFirstLoadWithinBudget,
  liffBudgetScene,
  newLineUserId,
  openAsLineUser,
  sessionCookie,
  weighFirstLoad,
  type LiffBudgetScreen,
} from './liff-support'
import { withoutScript } from './settings-line-scene'
import { ATTACHMENT_PDF } from './tasks-attachment'
import { expectNoPinBeforeScript, openAttachment } from './tasks-support'

// S5-06 · the LIFF task pages (§9.4 /liff/tasks and /liff/tasks/[id], §9.3, §9.9 principle 5, FR-LINE-003 AC1 AC2,
// FR-AUTH-005 AC2, FR-DOA-009 AC3, NEW-41) at 375 px in the mobile project (liff-* specs run on the phone only), each
// screen also checked and photographed at 1440 px (checkScreen: axe, no sideways scroll, 44 px targets). LIFF_MOCK stands
// in for the LINE app: the mock cookie names the LINE user, the fake LINE server of the run issues and verifies its ID
// token, and the sign-in, the session and everything after are the real path. The people are those of a twin of the demo
// organization built for this run (liff-tasks-scene.ts) and linked to LINE through a link code, so nothing here touches a
// record another spec reads: its VP of the operations division decides purchase requests (PR-02, below and at the
// stepUpThreshold of 100,000 baht), its COO a PO at the threshold (PO-01), its DM of construction a damaged-goods variance
// at the threshold (GRV-01), its CEO the DOA version that moves the DM band to 30,000 baht, its VP of the support division
// a request while holding no PIN, and a construction assistant has no task at all.

interface Twin {
  readonly orgCode: string
  readonly organizationName: string
  readonly approver: string
  readonly ceo: string
  readonly coo: string
  readonly dm: string
  readonly vpSup: string
  readonly requester: string
  readonly itRequester: string
  readonly lineVp: string
  readonly lineCeo: string
  readonly lineCoo: string
  readonly lineDm: string
  readonly lineVpSup: string
  readonly lineIdle: string
}
interface Made {
  readonly requestId: string
  readonly number: string
  readonly taskId: string
  readonly title: string
  readonly fileName?: string
}
interface PoMade {
  readonly poId: string
  readonly number: string
  readonly requestNumber: string
  readonly fileName: string
  readonly taskId: string
}
interface VarianceMade {
  readonly varianceId: string
  readonly poNumber: string
  readonly grNumber: string
  readonly photoName: string
  readonly taskId: string
}
interface Decided {
  readonly channel: string | null
  readonly decision: string | null
  readonly stepUp: boolean
}

// Every test builds what it needs through the services (a scene run is a few seconds each) and checks its screens with
// axe at two widths: more than Playwright's default 30 seconds
test.describe.configure({ timeout: 180_000 })

/** After a decision the page is rendered again with the task as it is now: a little longer than an assertion's default */
const AFTER_DECISION = { timeout: 15_000 }

/** A six-digit PIN that is not the approvers' one */
const WRONG_PIN = '480263'
const PIN_LABEL = 'PIN 6 หลัก'
const DOA_REF = 'DOA-DEMO ฉบับ 1 ข้อ PR-02'
/** The amounts of the PO and the variance of the scene: two pumps of 46,728.97 baht, 7% VAT */
const PUMPS = { net: '93,457.94', vat: '6,542.06', gross: '100,000.00', line: 'ปั๊มสูบน้ำเสียแบบจุ่ม' }

/** Runs tests/e2e/liff-tasks-scene.ts against the e2e database and returns the JSON of its last line */
function scene<T>(...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/liff-tasks-scene.ts ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`LIFF tasks scene ${args[0]} failed:\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}

/** The twin of this run, made once: a worker that restarts after a failed test reuses it (kept by the runner's process id) */
function twinOf(testInfo: TestInfo): Twin {
  const file = path.join(testInfo.project.outputDir, `.liff-tasks-twin-${process.ppid}.json`)
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as Twin
  const lines = { lineVp: newLineUserId(), lineCeo: newLineUserId(), lineCoo: newLineUserId(), lineDm: newLineUserId(), lineVpSup: newLineUserId(), lineIdle: newLineUserId() }
  const made = scene<Omit<Twin, keyof typeof lines>>('twin', lines.lineVp, lines.lineCeo, lines.lineCoo, lines.lineDm, lines.lineVpSup, lines.lineIdle)
  const twin: Twin = { ...made, ...lines }
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(twin))
  return twin
}

const request = (twin: Twin, gross: string, title: string, ...more: string[]) => scene<Made>('request', twin.orgCode, gross, title, ...more)
const decidedOf = (twin: Twin, taskId: string) => scene<Decided>('decided', twin.orgCode, taskId)

const inbox = (page: Page) => page.getByRole('list', { name: 'งานรออนุมัติของคุณ' })
const decisionBar = (page: Page) => page.getByRole('region', { name: 'ตัดสินงานนี้' })
const timeline = (page: Page, name = 'ไทม์ไลน์ของคำขอ') => page.getByRole('list', { name })
/** The stamp of a decision in a timeline: who, the DOA rule (§9.9) */
const stampOf = (page: Page, who: string, doa = DOA_REF, list?: string) => timeline(page, list).getByRole('listitem').filter({ hasText: doa }).filter({ hasText: who })
const region = (page: Page, name: string) => page.getByRole('region', { name, exact: true })

/** The bar sits at the bottom of the phone's screen (§9.4: แถบปุ่มตัดสินติดล่างจอ) */
async function expectAtTheBottom(page: Page, bar: ReturnType<Page['getByRole']>) {
  const box = (await bar.boundingBox())!
  expect(box.y + box.height).toBeGreaterThan(page.viewportSize()!.height - 2)
}

/** A file of the task's document opens through an address of the run's storage valid at most 5 minutes (FR-PLT-004 AC2): its bytes */
async function openedFile(page: Page, name: string): Promise<Buffer> {
  const href = await openAttachment(page, name)
  expect(Number(new URL(href).searchParams.get('X-Amz-Expires'))).toBeLessThanOrEqual(300)
  const file = await page.request.get(href)
  expect(file.status()).toBe(200)
  return Buffer.from(await file.body())
}

/** Second press of approve in the bar, with the PIN when the task needs one; then the page says who approved it */
async function approveInBar(page: Page, confirmText: string, approver: string, pin?: string) {
  const bar = decisionBar(page)
  await bar.getByRole('button', { name: 'อนุมัติ', exact: true }).click()
  const confirm = bar.getByRole('group', { name: confirmText })
  await expect(confirm).toBeVisible()
  if (pin) await confirm.getByLabel(PIN_LABEL).fill(pin)
  await confirm.getByRole('button', { name: 'ยืนยันอนุมัติ' }).click()
  await expect(page.getByRole('status').filter({ hasText: `อนุมัติแล้วโดย ${approver} เมื่อ` })).toBeVisible(AFTER_DECISION)
  await expect(decisionBar(page)).toHaveCount(0)
}

/** Loads a LIFF page from scratch as a LINE app would (the gate signs in), waits for its first screen, and weighs it */
async function firstLoad(page: Page, context: BrowserContext, lineUserId: string, pagePath: string, ready: () => Promise<void>) {
  await openAsLineUser(context, lineUserId)
  return weighFirstLoad(page, pagePath, ready)
}

test.describe('[FR-LINE-003/AC1] the approver’s tasks in the LINE app', () => {
  test('[FR-PLT-004/AC2] /liff/tasks lists the tasks due first with the overdue one marked; one below the threshold opens its file and is approved in LIFF without a PIN, and its stamp says LINE (LIFF)', async ({ page, context }, testInfo) => {
    const twin = twinOf(testInfo)
    const first = request(twin, '45000.00', 'drill', 'attach')
    const second = request(twin, '61500.00', 'cutter')
    // The task sent later was due two hours ago: it comes first, marked overdue in words
    scene('overdue', twin.orgCode, second.taskId)
    await openAsLineUser(context, twin.lineVp)
    await page.goto('/liff/tasks')
    // The gate signs in with LINE, then the list: the approver's own tasks, the ones due first at the top
    await expect(page.getByRole('heading', { level: 1, name: 'งานรออนุมัติ' })).toBeVisible()
    const rows = inbox(page).getByRole('listitem')
    await expect(rows.filter({ hasText: first.number })).toBeVisible()
    const texts = await rows.allInnerTexts()
    expect(texts.findIndex((t) => t.includes(second.number))).toBeLessThan(texts.findIndex((t) => t.includes(first.number)))
    await expect(rows.filter({ hasText: second.number })).toContainText('เกินกำหนด')
    const row = rows.filter({ hasText: first.number })
    await expect(row.getByRole('link', { name: `${first.number} · ${first.title}` })).toHaveAttribute('href', `/liff/tasks/${first.taskId}`)
    await expect(row).toContainText(`${twin.requester} · ฝ่ายก่อสร้าง`)
    await expect(row).toContainText(/ยอดรวม VAT\s*45,000\.00/)
    await expect(row).toContainText('ครบกำหนด')
    await expect(row).not.toContainText('เกินกำหนด')
    await expect(row).not.toContainText('ต้องยืนยันด้วย PIN')
    expect(await sessionCookie(context)).toMatch(/^liff_/)
    expect(await page.locator('main p').first().evaluate((el) => getComputedStyle(el).fontSize)).toBe('16px')
    await checkScreen(page, testInfo, 'liff-tasks-list')

    await row.getByRole('link').click()
    await expect(page).toHaveURL(new RegExp(`/liff/tasks/${first.taskId}$`))
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(first.title)
    // What a decider needs on the phone's first screen: the amount, the budget line and what is left, the DOA rule
    const summary = page.getByRole('region', { name: 'สรุปงานนี้' })
    await expect(summary).toContainText(/ยอดรวม VAT\s*45,000\.00 บาท/)
    await expect(summary).toContainText('CON-CAPEX-2569')
    await expect(summary).toContainText('จองงบแล้ว')
    await expect(summary).toContainText(/งบคงเหลือในบรรทัดนี้\s*[\d,]+\.\d\d บาท/)
    await expect(summary.getByText(DOA_REF, { exact: true })).toBeVisible()
    // …then the route so far, with why it comes here, and the timeline; below the threshold nothing asks for a PIN
    await expect(region(page, 'เส้นทางอนุมัติ')).toContainText('ทำไมไปทางนี้')
    await expect(timeline(page).locator('[aria-current="step"]')).toContainText(twin.approver)
    await expect(page.getByLabel(PIN_LABEL)).toHaveCount(0)
    const bar = decisionBar(page)
    await expectAtTheBottom(page, bar)
    await checkScreen(page, testInfo, 'liff-task-below-threshold')

    // FR-PLT-004 AC2 with a LINE sign-in: the request's file opens from the decision page, through a short-lived address
    await expect(region(page, 'ไฟล์แนบ')).toContainText(first.fileName!)
    expect((await openedFile(page, first.fileName!)).equals(ATTACHMENT_PDF)).toBe(true)
    await expect(page.getByText(`เปิดไฟล์ ${first.fileName} ไม่สำเร็จ`)).toHaveCount(0)
    await expect(page).toHaveURL(new RegExp(`/liff/tasks/${first.taskId}$`))

    // Approve asks for a second press that names the document and the amount
    await approveInBar(page, `อนุมัติ ${first.number} ยอดรวม VAT 45,000.00 บาท เปลี่ยนการตัดสินภายหลังไม่ได้`, twin.approver)
    // One notice says what was decided: who, when — not a second one of this visit
    await expect(page.getByRole('status').filter({ hasText: /^อนุมัติแล้ว$/ })).toHaveCount(0)
    // The stamp of the decision: who, when, through which channel, under which DOA rule (FR-DOA-005 AC2)
    await expect(stampOf(page, twin.approver)).toContainText(/\d\d:\d\d น\. · LINE \(LIFF\)/)
    expect(decidedOf(twin, first.taskId)).toEqual({ channel: 'LIFF', decision: 'APPROVE', stepUp: false })
    await checkScreen(page, testInfo, 'liff-task-approved')

    // Back to the list: the decided task is gone, the other one still waits
    await page.getByRole('link', { name: 'กลับไปที่งานรออนุมัติ' }).click()
    await expect(page).toHaveURL(/\/liff\/tasks$/)
    await expect(inbox(page).getByRole('listitem').filter({ hasText: second.number })).toBeVisible()
    await expect(inbox(page).getByRole('listitem').filter({ hasText: first.number })).toHaveCount(0)
  })

  test('/liff sends a linked approver to their tasks, which open (the rich menu’s งานรออนุมัติ)', async ({ page, context }, testInfo) => {
    const twin = twinOf(testInfo)
    await openAsLineUser(context, twin.lineVp)
    await page.goto('/liff')
    await expect(page).toHaveURL(/\/liff\/tasks$/)
    await expect(page.getByRole('heading', { level: 1, name: 'งานรออนุมัติ' })).toBeVisible()
  })

  test('[§9.9] a member with no task sees the empty list and the way to their own requests', async ({ page, context }, testInfo) => {
    const twin = twinOf(testInfo)
    await openAsLineUser(context, twin.lineIdle)
    await page.goto('/liff/tasks')
    await expect(page.getByRole('heading', { level: 1, name: 'งานรออนุมัติ' })).toBeVisible()
    await expect(page.getByText('ยังไม่มีงานรออนุมัติ')).toBeVisible()
    await expect(page.getByText('เมื่อมีงานส่งถึงคุณ จะแสดงที่นี่และส่งการ์ดอนุมัติมาทาง LINE ระหว่างนี้ติดตามคำขอของคุณได้')).toBeVisible()
    await expect(page.getByRole('link', { name: 'ติดตามคำขอของฉัน' })).toHaveAttribute('href', '/liff/track')
    await expect(page.getByRole('list', { name: 'งานรออนุมัติของคุณ' })).toHaveCount(0)
    await checkScreen(page, testInfo, 'liff-tasks-empty')
  })

  test('[BR-AUTH-05] a member who does not decide the task cannot open its decision page, nor its files', async ({ page, context }, testInfo) => {
    const twin = twinOf(testInfo)
    const made = request(twin, '30500.00', 'mixer', 'attach')
    // The CEO's LINE account: the task is the VP's
    await openAsLineUser(context, twin.lineCeo)
    await page.goto(`/liff/tasks/${made.taskId}`)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('งานนี้ไม่ได้อยู่ในรายการของคุณ')
    await expect(page.getByText(made.title)).toHaveCount(0)
    await expect(page.getByText(made.fileName!)).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^เปิดไฟล์/ })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'อนุมัติ', exact: true })).toHaveCount(0)
    await checkScreen(page, testInfo, 'liff-task-not-yours')
  })
})

test.describe('[FR-LINE-003/AC2] [FR-AUTH-005/AC2] a task at or above the threshold is decided in LIFF with the PIN', () => {
  test('[NFR-SEC-04] from a card’s ?action=approve: refused without the PIN, a wrong one says the tries left, the right one approves on channel LIFF with a new session id', async ({ page, context, browser }, testInfo) => {
    const twin = twinOf(testInfo)
    scene('pin-reset', twin.orgCode, 'vp_ops')
    const made = request(twin, '100000.00', 'pump')
    await openAsLineUser(context, twin.lineVp)
    const sent: string[] = []
    page.on('request', (r) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname.startsWith('/liff/tasks/')) sent.push(r.url())
    })
    // The card's "อนุมัติ (ยืนยัน PIN)" opens the page with the second press ready (§9.3); nothing is decided by opening it
    await page.goto(`/liff/tasks/${made.taskId}?action=approve`)
    await expect(page.getByText('ยอดของงานนี้ถึงเกณฑ์ที่ต้องยืนยันด้วย PIN 6 หลัก ทั้งการอนุมัติ การตีกลับ และการไม่อนุมัติ')).toBeVisible()
    const bar = decisionBar(page)
    const confirm = bar.getByRole('group', { name: `อนุมัติ ${made.number} ยอดรวม VAT 100,000.00 บาท เปลี่ยนการตัดสินภายหลังไม่ได้` })
    await expect(confirm).toBeVisible()
    const pin = confirm.getByLabel(PIN_LABEL)
    const confirmButton = confirm.getByRole('button', { name: 'ยืนยันอนุมัติ' })
    // Masked, on the number keypad, a one-time code to the browser (never saved or filled as a password)
    await expect(pin).toHaveAttribute('type', 'password')
    await expect(pin).toHaveAttribute('inputmode', 'numeric')
    await expect(pin).toHaveAttribute('autocomplete', 'one-time-code')
    // Returning and rejecting ask for the PIN too
    await expect(page.getByRole('region', { name: 'ตีกลับหรือไม่อนุมัติ' }).getByLabel(PIN_LABEL)).toBeVisible()
    await expectAtTheBottom(page, bar)
    await page.waitForLoadState('networkidle')
    expect(sent).toEqual([])
    expect(decidedOf(twin, made.taskId)).toMatchObject({ channel: null })
    await checkScreen(page, testInfo, 'liff-task-step-up')

    // No PIN: said at the field at once, and nothing is sent
    await confirmButton.click()
    await expect(confirm.getByText('ใส่ PIN ตัวเลข 6 หลัก')).toBeVisible()
    await page.waitForLoadState('networkidle')
    expect(sent).toEqual([])
    await checkScreen(page, testInfo, 'liff-task-step-up-no-pin')

    // A wrong PIN: the tries left at the field, the field empty for the next try, nothing decided
    await pin.fill(WRONG_PIN)
    await confirmButton.click()
    await expect(confirm.getByText('PIN ไม่ถูกต้อง ใส่ผิดได้อีก 4 ครั้ง')).toBeVisible()
    await expect(pin).toHaveValue('')
    await expect(pin).toHaveAttribute('aria-invalid', 'true')
    expect(sent).toHaveLength(1)
    expect(sent[0]).not.toContain(WRONG_PIN)
    expect(decidedOf(twin, made.taskId)).toMatchObject({ channel: null })
    await checkScreen(page, testInfo, 'liff-task-step-up-wrong-pin')

    // The right PIN approves; NFR-SEC-04: the LINE sign-in's session id changes at once, still a LIFF session
    const cookies = await context.cookies(E2E_BASE_URL)
    const before = cookies.find((c) => c.name.endsWith('bcs.session_token'))!
    await pin.fill(E2E_PIN)
    await confirmButton.click()
    await expect(page.getByRole('status').filter({ hasText: `อนุมัติแล้วโดย ${twin.approver} เมื่อ` })).toBeVisible(AFTER_DECISION)
    const after = await sessionCookie(context)
    expect(after).toMatch(/^liff_/)
    expect(after).not.toBe(before.value)
    // The request's timeline stamps the decision with channel LIFF, and the decision used the PIN step-up
    await expect(stampOf(page, twin.approver)).toContainText('LINE (LIFF)')
    expect(decidedOf(twin, made.taskId)).toEqual({ channel: 'LIFF', decision: 'APPROVE', stepUp: true })
    await checkScreen(page, testInfo, 'liff-task-step-up-approved')
    // …and the old session id opens nothing from then on: a phone that still holds it gets the gate, not the task
    const stale = await browser.newContext({ baseURL: E2E_BASE_URL })
    try {
      await stale.addCookies([before])
      const html = await (await stale.request.get(`/liff/tasks/${made.taskId}`)).text()
      expect(html).not.toContain(made.title)
      expect(html).not.toContain(made.number)
    } finally {
      await stale.close()
    }
    // The page reloads as the same approver, with the new session id
    await page.reload()
    await expect(page.getByRole('status').filter({ hasText: `อนุมัติแล้วโดย ${twin.approver} เมื่อ` })).toBeVisible(AFTER_DECISION)
    expect(await sessionCookie(context)).toBe(after)
  })

  test('[NFR-SEC-09] before the page’s script runs, a LIFF decision page takes no PIN and sends none', async ({ page, context, browser, clientIp }, testInfo) => {
    const twin = twinOf(testInfo)
    const made = request(twin, '100000.00', 'generator')
    await openAsLineUser(context, twin.lineVp)
    await page.goto(`/liff/tasks/${made.taskId}`)
    await expect(decisionBar(page).getByRole('button', { name: 'อนุมัติ', exact: true })).toBeEnabled()
    // The same LINE sign-in in a browser with JavaScript off (a slow phone, a script that did not load): the return-or-
    // reject form holds the PIN field; it posts, and its field and button wait for the script — forced on, it posts to the
    // page's own address and no address carries the PIN. The approve button waits too.
    await expectNoPinBeforeScript(await withoutScript(browser, page, testInfo, clientIp), `/liff/tasks/${made.taskId}`, 1, WRONG_PIN, async (bare) => {
      await expect(bare.getByRole('button', { name: 'อนุมัติ', exact: true })).toBeDisabled()
    })
    expect(decidedOf(twin, made.taskId)).toMatchObject({ channel: null })
  })

  test('an approver who has no PIN yet is told so, with where to set one, and nothing is decided', async ({ page, context }, testInfo) => {
    const twin = twinOf(testInfo)
    // The VP of the support division holds no PIN (FR-AUTH-005 AC1: it is set on the web); IT's request goes to them
    scene('pin-off', twin.orgCode, 'vp_sup')
    const made = request(twin, '100000.00', 'server', 'plain', 'it')
    await openAsLineUser(context, twin.lineVpSup)
    await page.goto(`/liff/tasks/${made.taskId}?action=approve`)
    const bar = decisionBar(page)
    const confirm = bar.getByRole('group', { name: `อนุมัติ ${made.number} ยอดรวม VAT 100,000.00 บาท เปลี่ยนการตัดสินภายหลังไม่ได้` })
    await confirm.getByLabel(PIN_LABEL).fill(E2E_PIN)
    await confirm.getByRole('button', { name: 'ยืนยันอนุมัติ' }).click()
    const refusal = bar.getByRole('alert').filter({ hasText: 'คุณยังไม่ได้ตั้ง PIN ยืนยันธุรกรรม ตั้ง PIN ก่อนแล้วกลับมาตัดสินงานนี้' })
    await expect(refusal).toBeVisible(AFTER_DECISION)
    // Where to set it: the web's PIN settings (a password sign-in), and how the PIN works in LINE
    await expect(refusal.getByRole('link', { name: 'ตั้ง PIN บนเว็บ' })).toHaveAttribute('href', '/settings/pin')
    await expect(refusal.getByRole('link', { name: 'วิธีใช้ PIN ใน LINE' })).toHaveAttribute('href', '/liff/help')
    // The second press stays for the next try; nothing decided
    await expect(confirm.getByRole('button', { name: 'ยืนยันอนุมัติ' })).toBeVisible()
    expect(decidedOf(twin, made.taskId)).toMatchObject({ channel: null })
    await checkScreen(page, testInfo, 'liff-task-pin-not-set')
  })
})

test.describe('[FR-DOA-004/AC1] returning, rejecting and asking from LIFF', () => {
  test('[FR-LINE-003/AC1] a card’s ?action=reject opens with reject chosen; it needs a reason and a tick, and the stamp carries the reason — on a WebView without crypto.randomUUID', async ({ page, context }, testInfo) => {
    const twin = twinOf(testInfo)
    const made = request(twin, '52000.00', 'scaffold')
    // The LINE app's WebView of an older phone (iOS before 15.4, Android System WebView before 92) has no
    // crypto.randomUUID: the decision's key is still a uuid the commands take (src/ui/liff/submission-key.ts)
    await context.addInitScript(() => {
      Reflect.deleteProperty(Crypto.prototype, 'randomUUID')
    })
    await openAsLineUser(context, twin.lineVp)
    await page.goto(`/liff/tasks/${made.taskId}?action=reject`)
    expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe('undefined')
    const section = page.getByRole('region', { name: 'ตีกลับหรือไม่อนุมัติ' })
    await expect(section.getByRole('radio', { name: /^ไม่อนุมัติ/ })).toBeChecked()
    // The reason box is where the page opens (the card's button is "ตีกลับ / ไม่อนุมัติ", §9.3)
    await expect(section.getByLabel('เหตุผล', { exact: true })).toBeFocused()
    const reject = section.getByRole('button', { name: 'ไม่อนุมัติคำขอนี้' })
    // Reject is outlined in danger, apart from approve, which is the solid button in the bar (§9.9)
    const approve = decisionBar(page).getByRole('button', { name: 'อนุมัติ', exact: true })
    expect(await reject.evaluate((b) => getComputedStyle(b).backgroundColor)).not.toBe(await approve.evaluate((b) => getComputedStyle(b).backgroundColor))
    await reject.click()
    await expect(section.getByText('ใส่เหตุผลอย่างน้อย 3 ตัวอักษร เพื่อให้ผู้ขอรู้ว่าต้องแก้อะไร')).toBeVisible()
    await expect(section.getByText('ติ๊กยืนยันก่อน เพราะเปลี่ยนการตัดสินภายหลังไม่ได้')).toBeVisible()
    expect(decidedOf(twin, made.taskId)).toMatchObject({ channel: null })
    await checkScreen(page, testInfo, 'liff-task-reject-needs-reason')

    await section.getByLabel('เหตุผล', { exact: true }).fill('ซื้อซ้ำกับรายการที่อนุมัติแล้ว')
    await section.getByLabel('ฉันตรวจเหตุผลแล้ว และเข้าใจว่าเปลี่ยนการตัดสินภายหลังไม่ได้').check()
    await expect(section.getByText('ใส่เหตุผลอย่างน้อย 3 ตัวอักษร เพื่อให้ผู้ขอรู้ว่าต้องแก้อะไร')).toHaveCount(0)
    await reject.click()
    await expect(page.getByRole('status').filter({ hasText: `ไม่อนุมัติโดย ${twin.approver} เมื่อ` })).toContainText('เหตุผล: ซื้อซ้ำกับรายการที่อนุมัติแล้ว', AFTER_DECISION)
    const stamp = timeline(page).getByRole('listitem').filter({ hasText: 'ซื้อซ้ำกับรายการที่อนุมัติแล้ว' })
    await expect(stamp).toContainText('ไม่อนุมัติ')
    await expect(stamp).toContainText('LINE (LIFF)')
    expect(decidedOf(twin, made.taskId)).toEqual({ channel: 'LIFF', decision: 'REJECT', stepUp: false })
    await checkScreen(page, testInfo, 'liff-task-rejected')
  })

  test('[FR-INT-009/AC3] (the approver’s half) the approver asks the requester for information; the decision waits for the answer', async ({ page, context }, testInfo) => {
    const twin = twinOf(testInfo)
    const made = request(twin, '24800.00', 'drill')
    await openAsLineUser(context, twin.lineVp)
    await page.goto(`/liff/tasks/${made.taskId}`)
    const ask = page.getByRole('region', { name: 'ขอข้อมูลเพิ่ม' })
    await ask.getByLabel('คำถามถึงผู้ขอ').fill('ขอใบเสนอราคาอีก 1 ใบ')
    await ask.getByRole('button', { name: 'ส่งคำถามถึงผู้ขอ' }).click()
    // The page rendered again says it: the question waits for the requester, and the bar has gone
    await expect(page.getByText('รอผู้ขอตอบคำถาม: ขอใบเสนอราคาอีก 1 ใบ')).toBeVisible(AFTER_DECISION)
    await expect(decisionBar(page)).toHaveCount(0)
    await checkScreen(page, testInfo, 'liff-task-asked')
  })
})

test.describe('[FR-DOA-004/AC2] a task decided elsewhere while its LIFF page was open', () => {
  test('approving it from the page decides nothing more: the page shows who decided it and when, in one notice, and the bar goes', async ({ page, context }, testInfo) => {
    const twin = twinOf(testInfo)
    const made = request(twin, '38000.00', 'mixer')
    await openAsLineUser(context, twin.lineVp)
    await page.goto(`/liff/tasks/${made.taskId}`)
    const bar = decisionBar(page)
    await bar.getByRole('button', { name: 'อนุมัติ', exact: true }).click()
    const confirm = bar.getByRole('group', { name: `อนุมัติ ${made.number} ยอดรวม VAT 38,000.00 บาท เปลี่ยนการตัดสินภายหลังไม่ได้` })
    await expect(confirm).toBeVisible()
    // Meanwhile the approver decides it on the web, from another device
    scene('approve', twin.orgCode, made.taskId)
    // Every message the page announces from now on, as it appears (it stays only until the page has rendered again)
    await page.evaluate(() => {
      const said: string[] = []
      Object.assign(window, { liffSaid: said })
      new MutationObserver(() => {
        for (const message of document.querySelectorAll('[role="alert"], [role="status"]')) {
          const text = message.textContent ?? ''
          if (text && !said.includes(text)) said.push(text)
        }
      }).observe(document.body, { subtree: true, childList: true, characterData: true })
    })
    await confirm.getByRole('button', { name: 'ยืนยันอนุมัติ' }).click()
    // The page renders again as the task is now: one notice says who approved it and when, and the bar has gone…
    await expect(page.getByRole('status').filter({ hasText: `อนุมัติแล้วโดย ${twin.approver} เมื่อ` })).toBeVisible(AFTER_DECISION)
    await expect(decisionBar(page)).toHaveCount(0)
    await expect(page.getByText(`ดำเนินการแล้วโดย ${twin.approver} เมื่อ`)).toHaveCount(0)
    await expect(page.getByRole('status').filter({ hasText: /^อนุมัติแล้ว$/ })).toHaveCount(0)
    // …after the press was answered, at once, with who had decided it and when (FR-DOA-004 AC2: "ดำเนินการแล้วโดย … เมื่อ …")
    const said = await page.evaluate(() => (window as unknown as { liffSaid: string[] }).liffSaid)
    expect(said.some((text) => text.includes(`ดำเนินการแล้วโดย ${twin.approver} เมื่อ`))).toBe(true)
    // Decided once, on the web: the press in LIFF decided nothing
    expect(decidedOf(twin, made.taskId)).toEqual({ channel: 'WEB', decision: 'APPROVE', stepUp: false })
    await checkScreen(page, testInfo, 'liff-task-closed-meanwhile')
  })
})

test.describe('[FR-P2P-004/AC1] [FR-P2P-007/AC2] [FR-LINE-003/AC2] [FR-AUTH-005/AC2] a PO and a variance decided in LIFF, everything on one screen', () => {
  test('[FR-PLT-004/AC2] a PO at the threshold: its amounts, budget, lines with the prices paid before, source request with its file, facts and route; approved with the PIN on channel LIFF', async ({ page, context }, testInfo) => {
    const twin = twinOf(testInfo)
    const made = scene<PoMade>('po', twin.orgCode)
    // The COO's phone, nothing cached: the page's first JavaScript is within the budget of §9.4
    expectFirstLoadWithinBudget(testInfo, '/liff/tasks/[id], a PO at the threshold', await firstLoad(page, context, twin.lineCoo, `/liff/tasks/${made.taskId}`, () => expect(decisionBar(page)).toBeVisible()))
    await expect(page.getByText(`ใบสั่งซื้อ ${made.number}`, { exact: true })).toBeVisible()
    await expect(page.getByText('ยอดของงานนี้ถึงเกณฑ์ที่ต้องยืนยันด้วย PIN 6 หลัก ทั้งการอนุมัติ การตีกลับ และการไม่อนุมัติ')).toBeVisible()
    const summary = page.getByRole('region', { name: 'สรุปงานนี้' })
    await expect(summary).toContainText(/ยอดรวม VAT\s*100,000\.00 บาท/)
    await expect(summary.getByText('DOA-DEMO ฉบับ 1 ข้อ PO-01', { exact: true })).toBeVisible()
    // §9.9 principle 5: the amounts, the state of the budget, the lines and the prices paid before, the files
    const amounts = region(page, 'ยอดเงิน')
    for (const figure of [PUMPS.net, PUMPS.vat, PUMPS.gross]) await expect(amounts).toContainText(figure)
    const budget = region(page, 'งบประมาณ')
    await expect(budget).toContainText('CON-CAPEX-2569')
    await expect(budget).toContainText('จองไว้แล้ว รอผู้อนุมัติตัดสิน')
    const lines = page.getByRole('list', { name: 'รายการของใบสั่งซื้อ' })
    await expect(lines).toContainText(PUMPS.line)
    await expect(lines).toContainText('ราคาที่เคยซื้อรายการนี้')
    await expect(lines).toContainText(made.requestNumber)
    const sources = page.getByRole('list', { name: 'คำขอต้นทางของใบสั่งซื้อ' })
    await expect(sources).toContainText(made.requestNumber)
    await expect(sources).toContainText(twin.requester)
    await expect(region(page, 'รายละเอียดใบสั่งซื้อ')).toContainText('ผู้ขาย')
    await expect(region(page, 'เส้นทางอนุมัติ')).toContainText('ทำไมไปทางนี้')
    await expect(region(page, 'เส้นทางอนุมัติ')).toContainText(twin.coo)
    // Nothing leads out to a workspace page a LINE sign-in cannot open
    await expect(page.locator('main a[href^="/requests/"], main a[href^="/procurement/"], main a[href^="/tasks/"], main a[href^="/admin/"]')).toHaveCount(0)
    await expectAtTheBottom(page, decisionBar(page))
    await checkScreen(page, testInfo, 'liff-po-task')

    // The source request's file opens with the LINE sign-in (FR-PLT-004 AC2)
    expect((await openedFile(page, made.fileName)).equals(ATTACHMENT_PDF)).toBe(true)

    // Approved with the PIN: on channel LIFF with the step-up, and the LINE sign-in's session id changes (NFR-SEC-04)
    const before = await sessionCookie(context)
    await approveInBar(page, `อนุมัติ ${made.number} ยอดรวม VAT ${PUMPS.gross} บาท เปลี่ยนการตัดสินภายหลังไม่ได้`, twin.coo, E2E_PIN)
    expect(await sessionCookie(context)).not.toBe(before)
    await expect(stampOf(page, twin.coo, 'DOA-DEMO ฉบับ 1 ข้อ PO-01', 'ไทม์ไลน์ของใบสั่งซื้อ')).toContainText('LINE (LIFF)')
    expect(decidedOf(twin, made.taskId)).toEqual({ channel: 'LIFF', decision: 'APPROVE', stepUp: true })
    await checkScreen(page, testInfo, 'liff-po-task-approved')
  })

  test('[FR-PLT-004/AC2] [NFR-SEC-04] a damaged-goods variance at the threshold: its amounts, the budget the PO holds, the goods receipt and its photo, the route; approved with the PIN on channel LIFF with a new session id', async ({ page, context }, testInfo) => {
    const twin = twinOf(testInfo)
    const made = scene<VarianceMade>('variance', twin.orgCode)
    expectFirstLoadWithinBudget(testInfo, '/liff/tasks/[id], a variance at the threshold', await firstLoad(page, context, twin.lineDm, `/liff/tasks/${made.taskId}`, () => expect(decisionBar(page)).toBeVisible()))
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`ของเสียหาย: ${PUMPS.line}`)
    await expect(page.getByText(`ผลต่างจากการตรวจรับ · ${made.poNumber}`, { exact: true })).toBeVisible()
    await expect(page.getByText('ยอดของงานนี้ถึงเกณฑ์ที่ต้องยืนยันด้วย PIN 6 หลัก ทั้งการอนุมัติและการไม่อนุมัติ')).toBeVisible()
    await expect(page.getByRole('region', { name: 'สรุปงานนี้' }).getByText('DOA-DEMO ฉบับ 1 ข้อ GRV-01', { exact: true })).toBeVisible()
    const amounts = region(page, 'มูลค่าของผลต่าง')
    for (const figure of [PUMPS.net, PUMPS.vat, PUMPS.gross]) await expect(amounts).toContainText(figure)
    await expect(amounts).toContainText('เส้นทางอนุมัติใช้มูลค่ารวม VAT ตามอัตราของ PO')
    const budget = region(page, 'งบประมาณ')
    await expect(budget).toContainText('CON-CAPEX-2569')
    await expect(budget).toContainText('PO ถือไว้สำหรับรายการนี้')
    const facts = region(page, 'ผลต่างที่ขออนุมัติ')
    await expect(facts).toContainText('รับของที่เสียหายไว้')
    await expect(facts).toContainText(made.grNumber)
    await expect(facts).toContainText('DN-6618')
    await expect(facts).toContainText(twin.requester)
    // The PO is named, not linked: its workspace page is not for a LINE sign-in
    await expect(facts).toContainText(made.poNumber)
    await expect(page.locator('main a[href^="/procurement/"], main a[href^="/requests/"], main a[href^="/tasks/"]')).toHaveCount(0)
    await expect(region(page, 'รูปถ่ายและเอกสารจากการตรวจรับ')).toContainText(made.photoName)
    await expect(region(page, 'เส้นทางอนุมัติ')).toContainText(twin.dm)
    // A variance is approved or rejected, never returned (BR-GR-03)
    await expect(page.getByRole('radio')).toHaveCount(0)
    await expectAtTheBottom(page, decisionBar(page))
    await checkScreen(page, testInfo, 'liff-variance-task')

    // The receiver's photo opens with the LINE sign-in: the evidence the approver decides on (BR-GR-05, FR-PLT-004 AC2)
    expect((await openedFile(page, made.photoName)).subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true)

    // Approved with the PIN: on channel LIFF with the step-up, and the LINE sign-in's session id changes (NFR-SEC-04)
    const before = await sessionCookie(context)
    await approveInBar(page, `อนุมัติผลต่าง ${made.poNumber} · ${PUMPS.line} มูลค่า ${PUMPS.net} บาท (ก่อน VAT) เปลี่ยนการตัดสินภายหลังไม่ได้`, twin.dm, E2E_PIN)
    const after = await sessionCookie(context)
    expect(after).toMatch(/^liff_/)
    expect(after).not.toBe(before)
    await expect(stampOf(page, twin.dm, 'DOA-DEMO ฉบับ 1 ข้อ GRV-01', 'ไทม์ไลน์ของผลต่าง')).toContainText('LINE (LIFF)')
    expect(decidedOf(twin, made.taskId)).toEqual({ channel: 'LIFF', decision: 'APPROVE', stepUp: true })
    await checkScreen(page, testInfo, 'liff-variance-task-approved')
  })
})

test.describe('[FR-DOA-009/AC3] [BR-DOA-15] [FR-AUTH-005/AC2] a DOA version decided in LIFF (NEW-41)', () => {
  test('shows who gains or loses authority and the boundary table; not approved before the tick, approved after it with the PIN and a new session id', async ({ page, context }, testInfo) => {
    const twin = twinOf(testInfo)
    scene('pin-reset', twin.orgCode, 'ceo')
    const made = scene<{ versionId: string; versionNo: number; taskId: string }>('doa', twin.orgCode)
    const name = `DOA-DEMO ฉบับ ${made.versionNo}`
    await openAsLineUser(context, twin.lineCeo)
    await page.goto('/liff/tasks')
    const row = inbox(page).getByRole('listitem').filter({ has: page.locator(`a[href="/liff/tasks/${made.taskId}"]`) })
    await expect(row.getByRole('link')).toHaveText(`อนุมัติเผยแพร่ ${name}`)
    await expect(row).toContainText('ต้องยืนยันด้วย PIN')
    await row.getByRole('link').click()

    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`เผยแพร่ ${name}`)
    // What differs from the version in effect, who gains or loses authority, and the boundary table (FR-DOA-009 AC1, AC3)
    await expect(page.getByRole('region', { name: 'เปลี่ยนจาก DOA-DEMO ฉบับ 1 ที่มีผลอยู่' }).getByRole('listitem').filter({ hasText: 'แก้ข้อ PR-01' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'ตำแหน่งที่ได้หรือเสียอำนาจ' }).getByRole('listitem').filter({ hasText: 'มากกว่า 20,000.00 ถึงไม่เกิน 30,000.00 บาท' })).toHaveCount(2)
    const edges = page.getByRole('region', { name: 'ตารางผลที่ขอบของช่วงวงเงิน' }).getByRole('list', { name: 'คำขอซื้อ (PR)' }).getByRole('listitem')
    await expect(edges.filter({ hasText: '30,000.00 บาท' })).toContainText('ผู้อนุมัติเปลี่ยน')
    // Approve or reject only, each with the PIN; the bar holds the tick above the PIN
    await expect(page.getByRole('radio')).toHaveCount(0)
    const bar = page.getByRole('region', { name: 'ตัดสินการเปลี่ยนนโยบาย' })
    const tick = bar.getByRole('checkbox', { name: 'ฉันตรวจตารางผลที่ขอบแล้ว ทุกยอดที่ขอบของช่วงไปหาผู้อนุมัติที่ถูกต้อง' })
    await expect(tick).not.toBeChecked()
    await expectAtTheBottom(page, bar)
    await checkScreen(page, testInfo, 'liff-doa-version')

    // Not before the tick: said at the tick, nothing is sent, nothing decided
    const pin = bar.getByLabel(PIN_LABEL)
    await pin.fill(E2E_PIN)
    await bar.getByRole('button', { name: 'อนุมัติการเปลี่ยนนี้' }).click()
    await expect(bar.getByText('ติ๊กยืนยันว่าตรวจตารางผลที่ขอบแล้วก่อนอนุมัติ')).toBeVisible()
    expect(decidedOf(twin, made.taskId)).toMatchObject({ channel: null })
    await checkScreen(page, testInfo, 'liff-doa-version-untick')

    // With the tick and the PIN: published, decided on channel LIFF with the step-up; NFR-SEC-04: a new session id
    const before = await sessionCookie(context)
    await tick.check()
    await bar.getByRole('button', { name: 'อนุมัติการเปลี่ยนนี้' }).click()
    await expect(page.getByRole('status').filter({ hasText: `อนุมัติแล้วโดย ${twin.ceo} เมื่อ` })).toBeVisible(AFTER_DECISION)
    await expect(page.getByRole('region', { name: 'ตัดสินการเปลี่ยนนโยบาย' })).toHaveCount(0)
    const after = await sessionCookie(context)
    expect(after).toMatch(/^liff_/)
    expect(after).not.toBe(before)
    expect(decidedOf(twin, made.taskId)).toEqual({ channel: 'LIFF', decision: 'APPROVE', stepUp: true })
    await checkScreen(page, testInfo, 'liff-doa-version-approved')
  })
})

test.describe('[§9.4] the first JavaScript of the task pages: their script files with the LINE SDK, and the page data in their HTML, are at most 200 KB gzip', () => {
  // Every page is opened twice and signed in once, each in a LINE app of its own, after scenes that build a PO
  test.describe.configure({ timeout: 360_000 })

  test('/liff/tasks, a request and a PO of 40 lines at the threshold, a variance and a DOA version task — each opened from LINE and again with the LIFF session, in a fresh LINE app', async ({
    browser,
  }, testInfo) => {
    const twin = twinOf(testInfo)
    const lines = String(BUDGET_DOCUMENT_LINES)
    const made = liffBudgetScene<{ taskId: string; number: string }>('twin-request', twin.orgCode, lines)
    const po = liffBudgetScene<{ taskId: string; number: string; assignee: string }>('twin-po', twin.orgCode, lines)
    const variance = scene<VarianceMade>('variance', twin.orgCode)
    const doa = scene<{ taskId: string }>('doa', twin.orgCode)
    /** The twin's LINE users by the demo code of the member they are linked to */
    const lineOf: Readonly<Record<string, string>> = { vp_ops: twin.lineVp, ceo: twin.lineCeo, coo: twin.lineCoo, dm_con: twin.lineDm, vp_sup: twin.lineVpSup }
    const poLine = lineOf[po.assignee]
    if (!poLine) throw new Error(`the PO went to ${po.assignee}, who has no LINE app in the twin`)
    const decision = (p: Page) => expect(decisionBar(p)).toBeVisible()
    const screens: readonly LiffBudgetScreen[] = [
      { name: '/liff/tasks', lineUserId: twin.lineVp, path: '/liff/tasks', ready: (p) => expect(inbox(p)).toBeVisible() },
      { name: `/liff/tasks/[id], a request of ${lines} lines at the threshold`, lineUserId: twin.lineVp, path: `/liff/tasks/${made.taskId}`, ready: decision },
      { name: `/liff/tasks/[id], a PO of ${lines} lines`, lineUserId: poLine, path: `/liff/tasks/${po.taskId}`, ready: decision },
      { name: '/liff/tasks/[id], a variance at the threshold', lineUserId: twin.lineDm, path: `/liff/tasks/${variance.taskId}`, ready: decision },
      { name: '/liff/tasks/[id], a DOA version', lineUserId: twin.lineCeo, path: `/liff/tasks/${doa.taskId}`, ready: (p) => expect(p.getByRole('region', { name: 'ตัดสินการเปลี่ยนนโยบาย' })).toBeVisible() },
    ]
    for (const screen of screens) await expectFirstLoadsWithinBudget(browser, testInfo, screen)
  })
})
