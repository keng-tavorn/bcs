import { type Page } from '@playwright/test'
import { scene, tagOf, type MadePo } from './procurement-support'
import { castOf, expectNoBlockingAxe, expectNoSideways, fixture, shot, signIn } from './tasks-support'
import { expect, test } from './fixtures'

// S16-07: the tabbed document page (FR-INT-012, §9.10 "หน้าเอกสาร"). The approver opens a request waiting for them: the
// header with its number, title, badges, menu and summary row (AC1), the tabs and the right column (AC2), the route as
// step cards whose panel tells the step's history without any decision button (AC3), and the decision bar with the amount
// on the DOA basis, the budget and the DOA reference — approve, and the card turns into the stamp (AC4); the history tab
// is a table from the Events that a link opens directly (AC5). The PO page has the same frame and its approver decides
// there too; /tasks/[id] still opens (AC6). tasks-fixtures.ts and procurement-scene.ts make the documents through the
// services; screenshots at 1440 and 375 px and axe on every screen (§9.9 steps 4–5).

type Created = { requestId: string; number: string; taskId: string; fileName?: string }
const DOA_REF = 'DOA-DEMO ฉบับ 1 ข้อ PR-02'
const TITLE = 'เครื่องพิมพ์สำนักงาน (หน้าเอกสาร)'

const header = (page: Page) => page.locator('#content header')
const bar = (page: Page) => page.getByRole('region', { name: 'ตัดสินงานนี้' })
const steps = (page: Page) => page.getByRole('list', { name: 'ขั้นอนุมัติ' })
const tabs = (page: Page) => page.getByRole('tablist', { name: 'ส่วนของเอกสาร' })

test('@demo [FR-INT-012/AC1] [FR-INT-012/AC2] [FR-INT-012/AC3] [FR-INT-012/AC4] [FR-INT-012/AC5] [FR-INT-012/AC6] the approver reads the request in tabs, opens its step, approves from the decision bar and the step becomes a stamp', async ({ page }, testInfo) => {
  test.slow()
  const cast = castOf(testInfo)
  const created = fixture<Created>('request', cast.requester, '21500.00', 'tabbed', 'attach')
  await signIn(page, cast.approver, true)
  await page.goto(`/requests/${created.requestId}`)

  // AC1: number, title, status and urgency badges, the menu and the summary row
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(TITLE)
  await expect(header(page)).toContainText(created.number)
  await expect(header(page)).toContainText('รออนุมัติ')
  await expect(header(page)).toContainText('ปกติ')
  const summaryRow = header(page).locator('dl')
  await expect(summaryRow).toContainText(/ยอดรวม\s*21,500\.00 บาท/)
  await expect(summaryRow).toContainText(/ส่งเมื่อ\s*\d{1,2} \S+ 25\d\d/)
  await expect(summaryRow).toContainText(/ใช้เวลา\s*[\d.,]+ วันทำการ/)
  await header(page).getByRole('button', { name: 'เพิ่มเติม' }).click()
  await expect(page.getByRole('menuitem', { name: 'พิมพ์ PDF' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'คัดลอกลิงก์' })).toBeVisible()
  // Only the requester cancels (FR-INT-009 AC1)
  await expect(page.getByRole('menuitem', { name: 'ยกเลิกคำขอ' })).toHaveCount(0)
  await page.keyboard.press('Escape')

  // AC2: the tabs of a request without a PO, and the right column's summary with the attachment
  await expect(tabs(page).getByRole('tab')).toHaveText(['ภาพรวม', 'รายการและงบ', 'เอกสาร', 'ประวัติ'])
  // The chosen tab is marked by a 2 px rule of --primary, not by colour of its words alone
  const chosen = await tabs(page)
    .getByRole('tab', { selected: true })
    .evaluate((el) => ({ width: getComputedStyle(el).borderBottomWidth, color: getComputedStyle(el).borderBottomColor }))
  expect(chosen.width).toBe('2px')
  expect(chosen.color).toBe('rgb(11, 110, 95)')
  const summary = page.getByRole('term').filter({ hasText: 'ไฟล์แนบ' }).locator('xpath=..')
  await expect(summary).toContainText(created.fileName!)
  await expect(page.getByRole('tab', { name: /^ความเห็น \(\d+\)$/ })).toBeVisible()

  // AC3: the current step is a card with its approver, its state and the business time used
  const current = steps(page).locator('[aria-current="step"]')
  await expect(current).toContainText(cast.approverName)
  await expect(current).toContainText(/รอตัดสิน/)
  await expect(current).toContainText(/ใช้ไป [\d.,]+ (จาก [\d.,]+ )?ชม\.ทำการ/)
  await current.getByRole('button').click()
  const panel = page.getByRole('dialog')
  await expect(panel.getByRole('heading', { name: /^ขั้นที่ 1/ })).toBeVisible()
  await expect(panel).toContainText(`มอบงานให้ ${cast.approverName}`)
  await expect(panel).toContainText('ทำไมเส้นทางไปทางนี้')
  await expect(panel).toContainText('PR-02')
  // No decision inside the panel: deciding happens in the decision bar only (§9.10)
  await expect(panel.getByRole('button', { name: 'อนุมัติ', exact: true })).toHaveCount(0)
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'document-step-panel')
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)

  // AC4: the decision bar says what the decision rests on; on phones it is fixed to the bottom of the screen
  await expect(bar(page)).toContainText(/ยอดตามฐาน DOA\s*21,500\.00 บาท \(รวม VAT\)/)
  await expect(bar(page)).toContainText('จองงบแล้ว')
  await expect(bar(page)).toContainText(DOA_REF)
  const position = await bar(page).evaluate((el) => getComputedStyle(el).position)
  expect(position).toBe(testInfo.project.name === 'mobile' ? 'fixed' : 'static')
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'document-request')

  // Not approving is set apart, outlined in danger, and asks for a reason in an Alert Dialog before anything happens
  await bar(page).getByRole('button', { name: 'ไม่อนุมัติ', exact: true }).click()
  const confirm = page.getByRole('alertdialog')
  await expect(confirm.getByRole('heading', { name: 'ไม่อนุมัติ' })).toBeVisible()
  await confirm.getByRole('button', { name: 'ไม่อนุมัติคำขอนี้' }).click()
  await expect(confirm).toContainText('ใส่เหตุผลอย่างน้อย 3 ตัวอักษร')
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'document-reject-dialog')
  await confirm.getByRole('button', { name: 'กลับไปตรวจก่อน' }).click()
  await expect(confirm).toHaveCount(0)

  // Approve: a second press names the document and the amount; the same service as the task page decides
  await bar(page).getByRole('button', { name: 'อนุมัติ', exact: true }).click()
  await expect(bar(page)).toContainText(`อนุมัติ ${created.number} ยอดรวม VAT 21,500.00 บาท`)
  await bar(page).getByRole('button', { name: 'ยืนยันอนุมัติ' }).click()
  await expect(page.getByText('อนุมัติแล้ว', { exact: true }).first()).toBeVisible()
  await expect(bar(page)).toHaveCount(0)
  // The card is a stamp now: decision, name, position, time, channel and the DOA rule (§9.9 signature element)
  const stamp = steps(page).getByRole('listitem').first()
  await expect(stamp).toContainText('อนุมัติแล้ว')
  await expect(stamp).toContainText(cast.approverName)
  await expect(stamp).toContainText(cast.approverRole)
  await expect(stamp).toContainText(/\d{1,2} \S+ 25\d\d \d\d:\d\d น\. · เว็บ/)
  await expect(stamp.getByText(DOA_REF, { exact: true })).toBeVisible()
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'document-stamped')

  // AC5: the history tab, from the Events: date, who, what (with the DOA reference) and the channel, filtered by kind
  await tabs(page).getByRole('tab', { name: 'ประวัติ' }).click()
  await expect(page).toHaveURL(/[?&]tab=history/)
  const history = page.getByRole(testInfo.project.name === 'mobile' ? 'list' : 'table', { name: 'ประวัติของเอกสาร' })
  await expect(history).toContainText(`ส่งขออนุมัติ ได้เลขที่ ${created.number}`)
  await expect(history).toContainText(`อนุมัติ · ${DOA_REF}`)
  await expect(history).toContainText('เว็บ')
  await page.getByRole('radio', { name: 'การตัดสิน' }).click()
  await expect(history).not.toContainText('ส่งขออนุมัติ ได้เลขที่')
  await expect(history).toContainText(`อนุมัติ · ${DOA_REF}`)
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'document-history')
  // A link to the tab opens the page on it
  await page.reload()
  await expect(tabs(page).getByRole('tab', { name: 'ประวัติ' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole(testInfo.project.name === 'mobile' ? 'list' : 'table', { name: 'ประวัติของเอกสาร' })).toBeVisible()

  // AC6: the task page still opens, and says the task was decided
  await page.goto(`/tasks/${created.taskId}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(TITLE)
  await expect(page.getByRole('status').filter({ hasText: `อนุมัติแล้วโดย ${cast.approverName} เมื่อ` })).toBeVisible()
})

test('[FR-INT-012/AC6] the PO page has the same header, tabs, right column and route, and its approver decides there', async ({ page }, testInfo) => {
  test.slow()
  const made = scene<MadePo & { file: string }>('pending', tagOf(testInfo))
  await signIn(page, 'coo', true)
  await page.goto(`/procurement/pos/${made.poId}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('บริษัท บริการทำความสะอาดทดสอบ จำกัด')
  await expect(header(page)).toContainText(made.number)
  await expect(header(page)).toContainText('รออนุมัติ')
  await expect(header(page).locator('dl')).toContainText(/ยอดรวม\s*1,070\.00 บาท/)
  await expect(tabs(page).getByRole('tab')).toHaveText(['ภาพรวม', 'รายการ', 'การรับของ', 'ใบกำกับ', 'เอกสาร', 'ประวัติ'])
  await expect(steps(page).locator('[aria-current="step"]')).toContainText('ชัยวัฒน์ ปฏิบัติการใหญ่')
  await expect(bar(page)).toContainText('ยอดตามฐาน DOA')
  await expect(bar(page).getByRole('button', { name: 'ตีกลับให้จัดซื้อแก้' })).toBeVisible()
  await expect(bar(page).getByRole('button', { name: 'ขอข้อมูลเพิ่ม' })).toHaveCount(0)
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'document-po')

  await bar(page).getByRole('button', { name: 'อนุมัติ', exact: true }).click()
  await bar(page).getByRole('button', { name: 'ยืนยันอนุมัติ' }).click()
  await expect(bar(page)).toHaveCount(0)
  await expect(header(page)).toContainText('อนุมัติแล้ว · ยังไม่ส่ง')
  await expect(steps(page).getByRole('listitem').first()).toContainText('อนุมัติแล้ว')
  // The documents tab lists its source request
  await tabs(page).getByRole('tab', { name: 'เอกสาร' }).click()
  await expect(page.getByRole('region', { name: 'คำขอต้นทางและเอกสารแนบ' })).toContainText(made.request.number)
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'document-po-approved')
})
