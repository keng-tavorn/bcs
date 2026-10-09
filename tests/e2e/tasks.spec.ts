import { spawnSync } from 'node:child_process'
import { type Page } from '@playwright/test'
import { formatThaiDate } from '../../src/core/thai/date'
import { E2E_PIN, e2eEnv } from '../support/e2e-env'
import { ATTACHMENT_PDF } from './tasks-attachment'
import { withoutScript } from './settings-line-scene'
import {
  castOf,
  expectNoBlockingAxe,
  expectNoPinBeforeScript,
  expectNoSideways,
  expectPageEndAboveBar,
  fixture,
  openAttachment,
  PIN_LABEL,
  rowWith,
  sessionCookie,
  sessionCookieOf,
  shot,
  signIn,
  stepUpFixture,
} from './tasks-support'
import { expect, test } from './fixtures'

// S2-12 approver side: the inbox, the decision page and the timeline as stamps (FR-DOA-004, FR-DOA-005 AC2,
// FR-PLT-003 AC3, FR-INT-009 AC3, BR-DOA-15). tests/e2e/seed-activity.ts gave vp_ops (desktop) and vp_sup (mobile) two
// tasks each, 45,000 and 50,000 baht; tasks-fixtures.ts and step-up-fixtures.ts add what a test needs through the
// services. Policy changes and amounts at or above the DOA version's stepUpThreshold are decided with the transaction PIN
// the e2e seed gave every demo approver (E2E_PIN, FR-AUTH-005 AC2); before the page's script runs, no PIN can be typed
// or sent (NFR-SEC-09). Screenshots at 1440 and 375 px go to the test output (§9.9 step 4); axe runs on every screen
// (§9.9 step 5).

type Created = { requestId: string; number: string; taskId: string; fileName?: string }
/** A six-digit PIN that is not the approvers' one */
const WRONG_PIN = '480263'

const inbox = (page: Page) => page.getByRole('list', { name: 'งานรออนุมัติของคุณ' })
const timeline = (page: Page) => page.getByRole('list', { name: 'ไทม์ไลน์ของคำขอ' })
/** The page's own heading block (the workspace shell has a header of its own) */
/** The request page's "ตอนนี้" block (S16-07): whom it waits for, and the DOA rule it was approved under */
const nowBlock = (page: Page) => page.locator('[data-doc-now]')
const approveButton = (page: Page) => page.getByRole('button', { name: 'อนุมัติ', exact: true })
const DOA_REF = 'DOA-DEMO ฉบับ 1 ข้อ PR-02'

/**
 * A plain member of the demo organization nobody else has touched, with no request and no task
 * (tests/e2e/fresh-member-scene.ts, a new one per run and viewport): its code, which signIn takes; it signs in with
 * SEED_DEV_PASSWORD and no second step
 */
function freshMember(project: string): string {
  const code = `e2e-inbox-${project}-${Date.now().toString(36)}`
  const r = spawnSync('pnpm exec tsx tests/e2e/fresh-member-scene.ts', { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv(), SCENE_MEMBER_CODE: code } })
  if (r.status !== 0) throw new Error(`fresh member scene failed:\n${r.stdout}\n${r.stderr}`)
  expect((JSON.parse(r.stdout.trim().split('\n').at(-1)!) as { email: string }).email).toBe(`${code}@demo.bcs.local`)
  return code
}

test('[FR-DOA-004/AC1] the approver’s inbox lists their tasks, the ones due first, with the business hours waited', async ({ page }, testInfo) => {
  const cast = castOf(testInfo)
  await signIn(page, cast.approver, true)

  // Home: work first — "รอฉันอนุมัติ" lists the tasks waiting for me, each a link to its decision page with the amount
  // the DOA counted (DOA-DEMO counts with VAT)
  await expect(page.getByRole('heading', { level: 2, name: 'รอฉันอนุมัติ' })).toBeVisible()
  const homeTasks = page.getByRole('list', { name: 'งานรอฉันอนุมัติทั้งหมด' })
  await expect(rowWith(homeTasks, '45,000.00').first().getByRole('link', { name: /PR-2569-\d{5} · วัสดุสำหรับงานทดสอบ/ })).toBeVisible()
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'home-approver')

  await page.getByRole('link', { name: /ดูงานรออนุมัติทั้งหมด/ }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('งานรออนุมัติ')
  const rows = inbox(page).getByRole('listitem')
  const texts = await rows.allInnerTexts()
  const first = texts.findIndex((t) => t.includes('45,000.00'))
  const second = texts.findIndex((t) => t.includes('50,000.00'))
  // Submitted first, due first: the 45,000 baht request comes before the 50,000 one
  expect(first).toBeGreaterThanOrEqual(0)
  expect(second).toBeGreaterThan(first)
  const row = rows.nth(first)
  await expect(row).toContainText(cast.seedRequesterName)
  await expect(row).toContainText('ยอดรวม VAT')
  await expect(row).toContainText(/ค้างมา/)
  await expect(row).toContainText(/ครบกำหนด|เกินกำหนด/)
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'inbox')
})

test('@demo [FR-DOA-005/AC2] [FR-PLT-003/AC3] [FR-DOA-004/AC2] the approver approves the 45,000 baht request on the web and the timeline shows DOA-DEMO ฉบับ 1 ข้อ PR-02', async ({ page, context }, testInfo) => {
  const cast = castOf(testInfo)
  await signIn(page, cast.approver, true)
  await page.goto('/tasks')
  await rowWith(inbox(page), '45,000.00').first().getByRole('link').click()
  await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/)
  const taskUrl = page.url()

  // Everything to decide on one screen (§9.9 principle 5)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('วัสดุสำหรับงานทดสอบ')
  const amounts = page.getByRole('region', { name: 'ยอดเงิน' })
  await expect(amounts).toContainText(/ยอดก่อน VAT\s*42,056\.07/)
  await expect(amounts).toContainText(/VAT 7%\s*2,943\.93/)
  await expect(amounts).toContainText(/ยอดรวม VAT\s*45,000\.00/)
  const budget = page.getByRole('region', { name: 'งบประมาณ' })
  await expect(budget).toContainText(`${cast.seedBudgetDepartment}-OPEX-`)
  await expect(budget).toContainText('จองงบแล้ว')
  // The DOA rule with why the route comes here; an approver may not open the admin page, so it is text, not a link
  const route = page.getByRole('region', { name: 'เส้นทางอนุมัติ' })
  await expect(route.getByText(DOA_REF, { exact: true })).toBeVisible()
  await expect(route.getByRole('link', { name: DOA_REF })).toHaveCount(0)
  await expect(route).toContainText('ทำไมไปทางนี้')
  await expect(route).toContainText('PR-02')
  await expect(timeline(page).getByRole('listitem').first()).toContainText(cast.seedRequesterName)
  await expect(timeline(page).locator('[aria-current="step"]')).toContainText(cast.approverName)
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'decision')

  // A second tab on the same task, left open while the first one decides
  const stale = await context.newPage()
  await stale.goto(taskUrl)
  await expect(approveButton(stale)).toBeVisible()

  await approveButton(page).click()
  await expect(page.getByText(/อนุมัติ PR-2569-\d{5} ยอดรวม VAT 45,000\.00 บาท/)).toBeVisible()
  await shot(page, testInfo, 'decision-confirm')
  await page.getByRole('button', { name: 'ยืนยันอนุมัติ' }).click()
  await expect(page.getByRole('status').filter({ hasText: `อนุมัติแล้วโดย ${cast.approverName} เมื่อ` })).toBeVisible()
  await expect(approveButton(page)).toHaveCount(0)
  // The stamp: decision, name, position, time, channel and the DOA rule (FR-DOA-005 AC2, FR-PLT-003 AC3)
  const stamp = timeline(page).getByRole('listitem').filter({ hasText: DOA_REF }).filter({ hasText: cast.approverName })
  await expect(stamp).toContainText('อนุมัติ')
  await expect(stamp).toContainText(cast.approverRole)
  await expect(stamp).toContainText(/\d{1,2} \S+ 25\d\d \d\d:\d\d น\. · เว็บ/)
  await expect(stamp.getByText(DOA_REF, { exact: true })).toBeVisible()
  await expect(stamp.getByRole('link', { name: DOA_REF })).toHaveCount(0)
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'decided')

  // FR-DOA-004 AC2: the tab left open says who decided it and when
  await approveButton(stale).click()
  await stale.getByRole('button', { name: 'ยืนยันอนุมัติ' }).click()
  await expect(stale.getByRole('alert').filter({ hasText: `ดำเนินการแล้วโดย ${cast.approverName} เมื่อ` })).toBeVisible()
  await shot(stale, testInfo, 'decided-twice')

  // The request page says under which DOA rule it was approved
  await page.getByRole('link', { name: /เปิดหน้าคำขอ PR-2569-\d{5}/ }).click()
  await expect(nowBlock(page)).toContainText('อนุมัติภายใต้')
  await expect(nowBlock(page).getByText(DOA_REF, { exact: true })).toBeVisible()
})

test('[FR-DOA-004/AC1] [FR-INT-009/AC3] the approver asks for information, the requester answers, then the approver returns it with a reason', async ({ page, browser }, testInfo) => {
  const cast = castOf(testInfo)
  await signIn(page, cast.approver, true)
  await page.goto('/tasks')
  await rowWith(inbox(page), '50,000.00').first().getByRole('link').click()
  await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/)
  const number = (await page.getByText(/^คำขอ PR-2569-\d{5}$/).innerText()).replace('คำขอ ', '')

  await page.getByRole('button', { name: 'ส่งคำถามถึงผู้ขอ' }).click()
  await expect(page.getByText('ใส่คำถามอย่างน้อย 3 ตัวอักษร')).toBeVisible()
  await page.getByLabel('คำถามถึงผู้ขอ').fill('ขอใบเสนอราคาเพิ่มเติมอีก 1 ใบ')
  // The message goes as soon as the field is being fixed
  await expect(page.getByText('ใส่คำถามอย่างน้อย 3 ตัวอักษร')).toHaveCount(0)
  await page.getByRole('button', { name: 'ส่งคำถามถึงผู้ขอ' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'ส่งคำถามถึงผู้ขอแล้ว' })).toBeVisible()
  await expect(page.getByText('รอผู้ขอตอบคำถาม: ขอใบเสนอราคาเพิ่มเติมอีก 1 ใบ')).toBeVisible()
  await expect(approveButton(page)).toHaveCount(0)
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'info-asked')

  // The inbox lists it after every task to decide, saying it waits for the requester's answer and for how long (§9.9
  // principles 1 and 4); its SLA has stopped, so it shows no due time
  const taskUrl = page.url()
  await page.goto('/tasks')
  const askedRow = rowWith(inbox(page), number)
  await expect(askedRow).toContainText('รอผู้ขอตอบคำถาม')
  await expect(askedRow).toContainText(/ค้างมา/)
  await expect(askedRow).not.toContainText(/ครบกำหนด|เกินกำหนด/)
  const listed = await inbox(page).getByRole('listitem').allInnerTexts()
  expect(listed.slice(listed.findIndex((t) => t.includes(number)) + 1).filter((t) => /ครบกำหนด|เกินกำหนด/.test(t))).toEqual([])
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'inbox-question')
  await page.goto(taskUrl)

  // The requester sees it waits for them, and answers (FR-INT-009 AC3)
  const requesterContext = await browser.newContext()
  const requester = await requesterContext.newPage()
  await signIn(requester, cast.seedRequester, cast.seedRequesterTotp)
  await requester.goto('/requests')
  const mine = requester.getByRole('list', { name: 'คำขอของฉัน' })
  await expect(rowWith(mine, number)).toContainText('รอคุณตอบคำถามของผู้อนุมัติ')
  await rowWith(mine, number).getByRole('link').click()
  await expect(requester.getByRole('heading', { level: 3, name: 'ผู้อนุมัติขอข้อมูลเพิ่ม' })).toBeVisible()
  await expect(requester.getByText('ขอใบเสนอราคาเพิ่มเติมอีก 1 ใบ').first()).toBeVisible()
  await requester.getByLabel('คำตอบของคุณ').fill('แนบใบเสนอราคาเพิ่มแล้ว')
  await expectNoBlockingAxe(requester)
  await shot(requester, testInfo, 'info-answer')
  await requester.getByRole('button', { name: 'ส่งคำตอบให้ผู้อนุมัติ' }).click()
  await expect(requester.getByRole('status').filter({ hasText: 'ส่งคำตอบให้ผู้อนุมัติแล้ว' })).toBeVisible()
  await expect(nowBlock(requester)).toContainText(`รอ ${cast.approverName}`)
  await requesterContext.close()

  // Back with the approver: a return needs a reason and a tick
  await page.reload()
  await expect(timeline(page)).toContainText('แนบใบเสนอราคาเพิ่มแล้ว')
  await expect(page.getByRole('radio', { name: /ตีกลับให้ผู้ขอแก้ไข/ })).toBeChecked()
  await page.getByRole('button', { name: 'ตีกลับให้ผู้ขอแก้ไข' }).click()
  await expect(page.getByText('ใส่เหตุผลอย่างน้อย 3 ตัวอักษร เพื่อให้ผู้ขอรู้ว่าต้องแก้อะไร')).toBeVisible()
  await expect(page.getByText('ติ๊กยืนยันก่อน เพราะเปลี่ยนการตัดสินภายหลังไม่ได้')).toBeVisible()
  await page.getByLabel('เหตุผล', { exact: true }).fill('แยกรายการวัสดุให้ชัดเจน')
  await page.getByLabel('ฉันตรวจเหตุผลแล้ว และเข้าใจว่าเปลี่ยนการตัดสินภายหลังไม่ได้').check()
  // Both messages went once their fields were fixed
  await expect(page.getByText('ใส่เหตุผลอย่างน้อย 3 ตัวอักษร เพื่อให้ผู้ขอรู้ว่าต้องแก้อะไร')).toHaveCount(0)
  await expect(page.getByText('ติ๊กยืนยันก่อน เพราะเปลี่ยนการตัดสินภายหลังไม่ได้')).toHaveCount(0)
  await page.getByRole('button', { name: 'ตีกลับให้ผู้ขอแก้ไข' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'ตีกลับให้ผู้ขอแก้ไขแล้ว' })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: `ตีกลับให้แก้ไขโดย ${cast.approverName} เมื่อ` })).toContainText('เหตุผล: แยกรายการวัสดุให้ชัดเจน')
  // The route says the step was returned (the same icon and words as the timeline)
  await expect(page.getByRole('region', { name: 'เส้นทางอนุมัติ' })).toContainText('ตีกลับ')
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'returned')
})

test('[FR-DOA-004/AC1] rejecting is a separate choice that needs a reason and a tick, never looks like approve, and the attachment opens', async ({ page }, testInfo) => {
  const cast = castOf(testInfo)
  const created = fixture<Created>('request', cast.requester, '21500.00', 'reject', 'attach')
  await signIn(page, cast.approver, true)
  await page.goto(`/tasks/${created.taskId}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('โต๊ะประชุม (ทดสอบไม่อนุมัติ)')

  // The attachment opens from the decision page through a short-lived address (§9.9 principle 5, FR-PLT-004 AC2)
  const files = page.getByRole('region', { name: 'ไฟล์แนบ' })
  await expect(files).toContainText(created.fileName!)
  await expect(files).toContainText('เอกสารประกอบเหตุผล')
  const href = await openAttachment(page, created.fileName!)
  expect(Number(new URL(href).searchParams.get('X-Amz-Expires'))).toBeLessThanOrEqual(300)
  const file = await page.request.get(href)
  expect(file.status()).toBe(200)
  expect(Buffer.from(await file.body()).equals(ATTACHMENT_PDF)).toBe(true)
  await expect(page).toHaveURL(new RegExp(`/tasks/${created.taskId}$`))

  await page.getByRole('radio', { name: /ไม่อนุมัติ/ }).check()
  const reject = page.getByRole('button', { name: 'ไม่อนุมัติคำขอนี้' })
  await expect(reject).toBeVisible()
  // Approve is the solid primary button; reject is outlined in danger, in another part of the page (§9.9)
  expect(await reject.evaluate((b) => getComputedStyle(b).backgroundColor)).not.toBe(await approveButton(page).evaluate((b) => getComputedStyle(b).backgroundColor))
  await page.getByLabel('เหตุผล', { exact: true }).fill('ซ้ำกับคำขอที่อนุมัติไปแล้ว')
  await page.getByLabel('ฉันตรวจเหตุผลแล้ว และเข้าใจว่าเปลี่ยนการตัดสินภายหลังไม่ได้').check()
  await shot(page, testInfo, 'reject-form')
  await reject.click()
  await expect(page.getByRole('status').filter({ hasText: 'ไม่อนุมัติคำขอนี้แล้ว' })).toBeVisible()
  const rejected = page.getByRole('status').filter({ hasText: `ไม่อนุมัติโดย ${cast.approverName} เมื่อ` })
  await expect(rejected).toBeVisible()
  // Not approved in --danger, as the timeline beside it draws the same decision (§9.9 tokens), still read politely as a status
  await expect(rejected).toHaveCSS('border-left-color', 'rgb(180, 35, 24)')
  const stamp = timeline(page).getByRole('listitem').filter({ hasText: 'ซ้ำกับคำขอที่อนุมัติไปแล้ว' })
  await expect(stamp).toContainText('ไม่อนุมัติ')
  await expect(stamp).toContainText(DOA_REF)
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'rejected')
})

test('[FR-DOA-010/AC2] [FR-DOA-002/AC2] [FR-AUTH-005/AC2] [NFR-SEC-09] a policy change shows what is approved and needs the PIN every time (BR-DOA-15), never sent before the page’s script runs', async ({ page, context, browser, clientIp }, testInfo) => {
  const cast = castOf(testInfo)
  const created = fixture<{ changeId: string; taskId: string; effectiveFrom: string }>('policy', cast.proposer, cast.appointee, cast.appointDepartment)
  const effective = formatThaiDate(new Date(created.effectiveFrom))
  await signIn(page, 'ceo', true)
  await page.goto('/tasks')
  const toTask = `a[href="/tasks/${created.taskId}"]`
  const row = inbox(page).getByRole('listitem').filter({ has: page.locator(toTask) })
  await expect(row.getByRole('link')).toHaveText('การเปลี่ยนโครงสร้างอำนาจ: แต่งตั้งผู้ดำรงตำแหน่ง')
  await expect(row).toContainText('ต้องยืนยันด้วย PIN')
  await expect(row).toContainText(`มีผล ${effective}`)
  await row.getByRole('link').click()

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`แต่งตั้ง ${cast.appointeeName} เป็นผู้จัดการฝ่าย ${cast.appointDepartmentName}`)
  const what = page.getByRole('region', { name: 'สิ่งที่ขออนุมัติ' })
  await expect(what).toContainText('แต่งตั้งตามคำสั่งบริษัท')
  await expect(what).toContainText(cast.proposerName)
  await expect(what).toContainText(effective)
  // The list of authority changes is an ORG_ADMIN page: the CEO decides from what this page shows
  await expect(page.getByRole('link', { name: 'ดูการเปลี่ยนโครงสร้างอำนาจทั้งหมด' })).toHaveCount(0)
  // Approve or reject only: a policy change is never returned
  await expect(page.getByRole('radio')).toHaveCount(0)
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'policy')
  // Before the page's script runs (a slow phone network), both forms hold a PIN field that takes nothing, and a form
  // forced to send goes by POST: the PIN never reaches an address (NFR-SEC-09)
  await expectNoPinBeforeScript(await withoutScript(browser, page, testInfo, clientIp), `/tasks/${created.taskId}`, 2, WRONG_PIN)

  const approve = page.getByRole('button', { name: 'อนุมัติการเปลี่ยนนี้', exact: true })
  const approveForm = page.locator('form').filter({ has: approve })
  // The PIN field: masked, a number keypad, a one-time code to the browser (never saved or filled as a password)
  const pin = approveForm.getByLabel(PIN_LABEL)
  await expect(pin).toHaveAttribute('type', 'password')
  await expect(pin).toHaveAttribute('inputmode', 'numeric')
  await expect(pin).toHaveAttribute('autocomplete', 'one-time-code')
  await expect(page.locator('form#reject-policy').getByLabel(PIN_LABEL)).toBeVisible()
  await expectNoSideways(page)
  await pin.fill(WRONG_PIN)
  await approve.click()
  // A wrong PIN is said at its field with the tries left; nothing is approved and the field is empty for the next try
  await expect(approveForm.getByText('PIN ไม่ถูกต้อง ใส่ผิดได้อีก 4 ครั้ง')).toBeVisible()
  await expect(pin).toHaveAttribute('aria-invalid', 'true')
  await expect(pin).toHaveValue('')
  // On phones the page still ends above the approve bar, now taller with the message
  await expectPageEndAboveBar(page)
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'policy-wrong-pin')
  const before = await sessionCookie(context)
  await pin.fill(E2E_PIN)
  await approve.click()
  await expect(page.getByRole('status').filter({ hasText: 'อนุมัติการเปลี่ยนนี้แล้ว' })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'อนุมัติแล้วโดย ศักดิ์ชัย ผู้นำ เมื่อ' })).toBeVisible()
  // NFR-SEC-04: the session id changed with the step-up, and the CEO is still signed in
  expect(await sessionCookie(context)).not.toBe(before)
  await page.reload()
  await expect(page.getByRole('status').filter({ hasText: 'อนุมัติแล้วโดย ศักดิ์ชัย ผู้นำ เมื่อ' })).toBeVisible()
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'policy-approved')
})

test('[FR-DOA-002/AC2] [FR-DOA-010/AC2] [FR-DOA-009/AC3] [FR-AUTH-005/AC2] a DOA version shows every rule and what differs from the version in effect, and is decided with the PIN (BR-DOA-15)', async ({ page }, testInfo) => {
  const cast = castOf(testInfo)
  const created = fixture<{ versionId: string; taskId: string; effectiveFrom: string }>('doa', cast.proposer, String(cast.doaVersionNo))
  const name = `DOA-DEMO ฉบับ ${cast.doaVersionNo}`
  await signIn(page, 'ceo', true)
  await page.goto('/tasks')
  const row = inbox(page).getByRole('listitem').filter({ has: page.locator(`a[href="/tasks/${created.taskId}"]`) })
  await expect(row.getByRole('link')).toHaveText(`อนุมัติเผยแพร่ ${name}`)
  await expect(row).toContainText('ต้องยืนยันด้วย PIN')
  await expect(row).toContainText(`มีผล ${formatThaiDate(new Date(created.effectiveFrom))}`)
  await row.getByRole('link').click()

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`เผยแพร่ ${name}`)
  const what = page.getByRole('region', { name: 'สิ่งที่ขออนุมัติ' })
  await expect(what).toContainText(cast.proposerName)
  await expect(what).toContainText('ขยายวงเงินผู้จัดการฝ่ายเป็น 30,000 บาท')
  await expect(what).toContainText('DOA-DEMO ฉบับ 1')
  // What differs from the version in effect, rule by rule (the same comparison as the version history)
  const diff = page.getByRole('region', { name: 'เปลี่ยนจาก DOA-DEMO ฉบับ 1 ที่มีผลอยู่' })
  await expect(diff.getByRole('listitem').filter({ hasText: 'แก้ข้อ PR-01' })).toContainText('ช่วงวงเงิน: เดิม ไม่เกิน 20,000.00 บาท · ใหม่ ไม่เกิน 30,000.00 บาท')
  await expect(diff.getByRole('listitem').filter({ hasText: 'แก้ข้อ PR-02' })).toContainText('ช่วงวงเงิน: เดิม มากกว่า 20,000.00 ถึงไม่เกิน 100,000.00 บาท · ใหม่ มากกว่า 30,000.00 ถึงไม่เกิน 100,000.00 บาท')
  // Who gains or loses authority, and the boundary table the approver ticks before approving (FR-DOA-009 AC3)
  await expect(page.getByRole('region', { name: 'ตำแหน่งที่ได้หรือเสียอำนาจ' }).getByRole('listitem').filter({ hasText: 'มากกว่า 20,000.00 ถึงไม่เกิน 30,000.00 บาท' })).toHaveCount(2)
  const edges = page.getByRole('region', { name: 'ตารางผลที่ขอบของช่วงวงเงิน' }).getByRole('list', { name: 'คำขอซื้อ (PR)' }).getByRole('listitem')
  await expect(edges.filter({ hasText: '30,000.00 บาท' })).toContainText('ผู้อนุมัติเปลี่ยน')
  const approveForm = page.locator('form').filter({ has: page.getByRole('button', { name: 'อนุมัติการเปลี่ยนนี้', exact: true }) })
  await expect(approveForm.getByRole('checkbox', { name: 'ฉันตรวจตารางผลที่ขอบแล้ว ทุกยอดที่ขอบของช่วงไปหาผู้อนุมัติที่ถูกต้อง' })).not.toBeChecked()
  // Every rule the version publishes: band, approver and SLA, the changed ones marked in words
  const rules = page.getByRole('list', { name: `ข้อของ ${name}` })
  await expect(rules.getByRole('listitem')).toHaveCount(8)
  const pr02 = rules.getByRole('listitem').filter({ hasText: 'ข้อ PR-02 ·' })
  await expect(pr02).toContainText('มากกว่า 30,000.00 ถึงไม่เกิน 100,000.00 บาท')
  await expect(pr02).toContainText('ของแผนกที่ตั้งเบิก · 8 ชั่วโมงทำการ')
  await expect(pr02).toContainText('เปลี่ยน: ช่วงวงเงิน')
  await expect(page.getByRole('region', { name: 'นโยบายของฉบับ' })).toContainText('รวม VAT')
  // The approver reads it all here; the admin page of DOA versions is for ORG_ADMIN
  await expect(page.getByRole('link', { name: 'ดูรายละเอียดและความต่างของฉบับนี้' })).toHaveCount(0)
  await expect(page.getByRole('radio')).toHaveCount(0)
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'doa-policy')

  // Rejected with a reason, the PIN and a tick (nothing is published for the other tests); rejecting asks for no tick of
  // the boundary table
  const rejectForm = page.locator('form#reject-policy')
  const reject = rejectForm.getByRole('button', { name: 'ไม่อนุมัติการเปลี่ยนนี้', exact: true })
  await reject.click()
  await expect(rejectForm.getByText('ใส่ PIN ตัวเลข 6 หลัก')).toBeVisible()
  await rejectForm.getByLabel('เหตุผล', { exact: true }).fill('ขอให้ทบทวนวงเงินกับฝ่ายบัญชีก่อน')
  await rejectForm.getByLabel(PIN_LABEL).fill(E2E_PIN)
  await rejectForm.getByLabel('ฉันตรวจเหตุผลแล้ว และเข้าใจว่าเปลี่ยนการตัดสินภายหลังไม่ได้').check()
  await expect(rejectForm.getByText('ใส่ PIN ตัวเลข 6 หลัก')).toHaveCount(0)
  await reject.click()
  await expect(page.getByRole('status').filter({ hasText: 'ไม่อนุมัติการเปลี่ยนนี้แล้ว' })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'ไม่อนุมัติโดย ศักดิ์ชัย ผู้นำ เมื่อ' })).toBeVisible()
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'doa-policy-rejected')
})

test('[FR-AUTH-005/AC2] [FR-AUTH-005/AC3] [NFR-SEC-04] [NFR-SEC-09] a request at the step-up threshold is approved with the PIN: never sent before the page’s script runs, no PIN, a wrong or a locked one passes nothing, and the session id changes at once', async ({ page, context, browser, clientIp }, testInfo) => {
  const cast = castOf(testInfo)
  const made = stepUpFixture<{ requestId: string; number: string; taskId: string; amount: string }>('at-threshold', cast.requester)
  await signIn(page, cast.approver, true)
  // The inbox says which tasks need the PIN
  await page.goto('/tasks')
  const row = inbox(page).getByRole('listitem').filter({ has: page.locator(`a[href="/tasks/${made.taskId}"]`) })
  await expect(row).toContainText('ต้องยืนยันด้วย PIN')
  await row.getByRole('link').click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('เครื่องปั่นไฟสำรองไซต์งาน')
  await expect(page.getByText('ยอดของงานนี้ถึงเกณฑ์ที่ต้องยืนยันด้วย PIN 6 หลัก ทั้งการอนุมัติ การตีกลับ และการไม่อนุมัติ')).toBeVisible()
  // Returning and rejecting ask for the PIN too; asking the requester does not
  await expect(page.locator('#other-decisions form').first().getByLabel(PIN_LABEL)).toBeVisible()
  await expect(page.locator('#other-decisions form').nth(1).getByLabel(PIN_LABEL)).toHaveCount(0)
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'step-up-decision')
  // Before the page's script runs (a slow phone network), the return-or-reject form's PIN field takes nothing, and the
  // form forced to send goes by POST: the PIN never reaches an address (NFR-SEC-09). The approve button waits too: a
  // press before the script would be lost
  await expectNoPinBeforeScript(await withoutScript(browser, page, testInfo, clientIp), `/tasks/${made.taskId}`, 1, WRONG_PIN, async (before) => {
    await expect(approveButton(before)).toBeDisabled()
  })

  // The second press of approve asks for the PIN: masked, a number keypad, a one-time code to the browser (never saved
  // or filled as a password)
  await approveButton(page).click()
  // The amount is the threshold of the DOA version in effect, as the fixture read it
  const confirm = page.getByRole('group', { name: new RegExp(`^อนุมัติ ${made.number} ยอดรวม VAT [0-9,]+\\.[0-9]{2} บาท`) })
  const pin = confirm.getByLabel(PIN_LABEL)
  const confirmButton = confirm.getByRole('button', { name: 'ยืนยันอนุมัติ' })
  // The second press is a form of its own, and posts like every form of the page
  await expect(page.locator('form').filter({ has: pin })).toHaveAttribute('method', 'post')
  await expect(pin).toHaveAttribute('type', 'password')
  await expect(pin).toHaveAttribute('inputmode', 'numeric')
  await expect(pin).toHaveAttribute('autocomplete', 'one-time-code')
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'step-up-confirm')
  // Not six digits: said at once, nothing is sent — Enter (Go on the phone's keypad) confirms like the button
  await pin.fill('1234')
  await pin.press('Enter')
  await expect(confirm.getByText('ใส่ PIN ตัวเลข 6 หลัก')).toBeVisible()

  // A member without a PIN is told to set one first, with the way to /settings/pin; nothing is approved
  stepUpFixture('pin-off', cast.approver)
  try {
    await pin.fill(WRONG_PIN)
    await confirmButton.click()
    const noPin = page.locator('[data-decision-bar]').getByText('คุณยังไม่ได้ตั้ง PIN ยืนยันธุรกรรม ตั้ง PIN ก่อนแล้วกลับมาตัดสินงานนี้')
    await expect(noPin).toBeVisible()
    await expect(page.getByRole('link', { name: 'ไปตั้ง PIN' })).toHaveAttribute('href', '/settings/pin')
    await expect(pin).toHaveValue('')
    await expect(approveButton(page)).toHaveCount(0)
    await expectPageEndAboveBar(page)
    await expectNoBlockingAxe(page)
    await expectNoSideways(page)
    await shot(page, testInfo, 'step-up-no-pin')
  } finally {
    stepUpFixture('pin-on', cast.approver)
  }

  // A wrong PIN: said at its field with the tries left, nothing approved, the field empty for the next try
  await pin.fill(WRONG_PIN)
  await confirmButton.click()
  await expect(confirm.getByText('PIN ไม่ถูกต้อง ใส่ผิดได้อีก 4 ครั้ง')).toBeVisible()
  await expect(pin).toHaveValue('')
  await expect(approveButton(page)).toHaveCount(0)
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'step-up-wrong-pin')

  // FR-AUTH-005 AC3: the fifth wrong PIN in a row locks it; the bar says until when, and the page still ends above it
  try {
    for (const left of [3, 2, 1]) {
      await pin.fill(WRONG_PIN)
      await pin.press('Enter')
      await expect(confirm.getByText(`PIN ไม่ถูกต้อง ใส่ผิดได้อีก ${left} ครั้ง`)).toBeVisible()
    }
    await pin.fill(WRONG_PIN)
    await confirmButton.click()
    await expect(page.locator('[data-decision-bar]').getByText(/^ใส่ PIN ผิด 5 ครั้งติดกัน PIN ถูกล็อกถึง .+ ลองใหม่หลังเวลานั้น$/)).toBeVisible()
    await expect(approveButton(page)).toHaveCount(0)
    await expectPageEndAboveBar(page)
    await expectNoBlockingAxe(page)
    await expectNoSideways(page)
    await shot(page, testInfo, 'step-up-locked')
  } finally {
    stepUpFixture('pin-unlock', cast.approver)
  }

  const before = await sessionCookieOf(context)
  await pin.fill(E2E_PIN)
  await confirmButton.click()
  await expect(page.getByRole('status').filter({ hasText: `อนุมัติแล้วโดย ${cast.approverName} เมื่อ` })).toBeVisible()
  // NFR-SEC-04: a new session id after the step-up; the approver stays signed in
  const after = await sessionCookie(context)
  expect(after).toBeTruthy()
  expect(after).not.toBe(before?.value)
  // …and the old one opens nothing from then on: a browser that still holds it is sent to the sign-in page
  const stale = await browser.newContext()
  try {
    await stale.addCookies([before!])
    const elsewhere = await stale.newPage()
    await elsewhere.goto(`/tasks/${made.taskId}`)
    await expect(elsewhere).toHaveURL(/\/login(\?.*)?$/)
  } finally {
    await stale.close()
  }
  await page.reload()
  await expect(page.getByRole('status').filter({ hasText: `อนุมัติแล้วโดย ${cast.approverName} เมื่อ` })).toBeVisible()
  const stamp = timeline(page).getByRole('listitem').filter({ hasText: cast.approverName }).filter({ hasText: 'DOA-DEMO ฉบับ 1 ข้อ PR-02' })
  await expect(stamp).toContainText('อนุมัติ')
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'step-up-approved')
})

test('[FR-DOA-004/AC1] an empty inbox offers a next step the member can take: their requests when they have some, a new request when they have none (§9.9 principle 8)', async ({ page }, testInfo) => {
  const cast = castOf(testInfo)
  const content = page.locator('#content')
  // A requester with a request of their own and nothing to decide follows their requests
  fixture<Created>('request', cast.requester, '5000.00', 'foreign')
  await signIn(page, cast.requester, false)
  await page.goto('/tasks')
  await expect(content.getByText('ยังไม่มีงานรออนุมัติ', { exact: true })).toBeVisible()
  await expect(content.getByText('เมื่อมีคำขอส่งถึงคุณ จะแสดงที่นี่และแจ้งในกระดิ่งแจ้งเตือน ระหว่างนี้ดูความคืบหน้าของคำขอของคุณได้', { exact: true })).toBeVisible()
  await expect(content.getByRole('link', { name: 'ไปที่คำขอของฉัน', exact: true })).toHaveAttribute('href', '/requests')
  await expect(content.getByRole('link', { name: 'เริ่มขอซื้อหรือขอจ้าง', exact: true })).toHaveCount(0)

  // A member with neither — like an auditor or an approver who never asked for anything — is never sent to an empty list
  // of requests, nor told to follow requests they do not have. A member no other test has touched: the demo users carry
  // what other specs did (on the phone, action-link.spec.ts makes the auditor a requester before this runs)
  const untouched = freshMember(testInfo.project.name)
  await page.context().clearCookies()
  await signIn(page, untouched, false)
  await page.goto('/tasks')
  await expect(content.getByText('ยังไม่มีงานรออนุมัติ', { exact: true })).toBeVisible()
  await expect(content.getByText('เมื่อมีคำขอส่งถึงคุณ จะแสดงที่นี่และแจ้งในกระดิ่งแจ้งเตือน', { exact: true })).toBeVisible()
  await expect(content).not.toContainText('ระหว่างนี้ดูความคืบหน้าของคำขอของคุณได้')
  await expect(content.getByRole('link', { name: 'ไปที่คำขอของฉัน', exact: true })).toHaveCount(0)
  await expect(content.getByRole('link', { name: 'เริ่มขอซื้อหรือขอจ้าง', exact: true })).toHaveAttribute('href', '/requests/new')
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'inbox-empty')
})

test('[FR-DOA-004/AC1] a member who is not the task’s approver cannot open its decision page', async ({ page }, testInfo) => {
  const cast = castOf(testInfo)
  const created = fixture<Created>('request', cast.requester, '5000.00', 'foreign')
  await signIn(page, cast.requester, false)
  await page.goto(`/tasks/${created.taskId}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('งานนี้ไม่ได้อยู่ในรายการของคุณ')
  await expect(approveButton(page)).toHaveCount(0)
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'not-yours')
})
