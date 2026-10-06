import { type Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { checkScreen, exportedFile, pickDay, scene, settleNoticesAfterEachTest, sha256, sheetRows, shownChecksum, signInAs, type DecisionsScene } from './insight-support'

settleNoticesAfterEachTest(test)

// S4-11 · FR-VIS-002 AC1 AC3 (spec §11.3): the report framework — the reports the system offers (the KPI view of §11.4
// for now; R-01 to R-07 wait for the customer's list, OQ-09), their filters, the result in the reader's scope, the
// Excel file with its checksum, and e-mails on a schedule for FINANCE and EXECUTIVE. tests/e2e/insight-scene.ts makes
// three purchase requests the DM approved in LINE chat, in LIFF and on the web, and counts G-5 from the events.

/** The KPI report's row of a measure: a table row on wide screens, a list item on phones */
const reportRow = (page: Page, measure: string) => page.locator('table:visible tbody tr, ul[aria-label^="ผลของรายงาน"]:visible > li').filter({ hasText: measure })

test('[FR-VIS-002/AC1] finance runs the KPI report for a period, exports it to Excel with its checksum, and schedules it by e-mail', async ({ page }, testInfo) => {
  // a scene of its own (a separate process through the services) and axe on several screens
  test.slow()
  const s = scene<DecisionsScene>('decisions', testInfo.project.name)
  await signInAs(page, 'fin_officer')
  await page.goto('/reports')
  await expect(page.getByRole('heading', { level: 1, name: 'รายงาน' })).toBeVisible()
  await expect(page.getByText('รายงานอ่านข้อมูลทั้งองค์กร')).toBeVisible()
  await expect(page.getByRole('link', { name: 'ตัวชี้วัด (KPI) G-1 ถึง G-5' })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByText(/R-01 ถึง R-07\) จะเพิ่มเข้ามาเมื่อลูกค้ายืนยันรายชื่อและนิยาม/)).toBeVisible()

  // The report's filters: the period of the scene's decisions
  await pickDay(page, 'ตั้งแต่วันที่', s.kpi.from)
  await pickDay(page, 'ถึงวันที่', s.kpi.to)
  await page.getByRole('button', { name: 'ดูรายงานช่วงนี้' }).click()
  await expect(page).toHaveURL(new RegExp(`from=${s.kpi.from}&to=${s.kpi.to}`))
  await expect(page.getByText(/^ช่วง .+ ถึง .+ · ทั้งองค์กร · อ่านเมื่อ .+$/)).toBeVisible()
  const pr = reportRow(page, 'การตัดสินใน LINE ของคำขอซื้อ')
  await expect(pr).toHaveCount(1)
  await expect(pr).toContainText(String(s.kpi.pr.denominator))
  await expect(pr).toContainText(/\d+\.\d%/)
  await expect(reportRow(page, 'การอนุมัติที่ผิด DOA')).toContainText('G-2')
  // G-1 has no denominator yet: the value reads as not computable, not as a number
  await expect(reportRow(page, 'PO ที่อนุมัติ ÷ เอกสารซื้อในระบบบัญชี')).toContainText('ยังคำนวณไม่ได้')
  // times read as on the KPI page: business hours with one decimal
  await expect(reportRow(page, 'มัธยฐานเวลาตัดสินต่อขั้น')).toContainText(/\d+\.\d ชั่วโมงทำการ/)
  // the columns in the reader's words; the file's unit and code columns stay in the file
  await expect(page.getByRole('columnheader', { name: 'รหัส' })).toHaveCount(0)
  await checkScreen(page, testInfo, 'reports')

  // Excel of the same period and scope, with its checksum: each measure named in Thai, with its unit and its code
  const bytes = await exportedFile(page, 'ส่งออก Excel')
  expect(sha256(bytes)).toBe(await shownChecksum(page))
  const [header, ...rows] = await sheetRows(bytes, 7)
  expect(header).toEqual(['ตัวชี้วัด', 'สิ่งที่วัด', 'ค่า', 'หน่วย', 'ตัวตั้ง', 'ตัวหาร', 'รหัส'])
  const prRow = rows.find((r) => r[6] === 'DECISIONS_ON_LINE_PURCHASE_REQUEST')!
  expect([prRow[1], ...prRow.slice(3, 6)]).toEqual(['การตัดสินใน LINE ของคำขอซื้อ', '%', String(s.kpi.pr.numerator), String(s.kpi.pr.denominator)])

  // E-mail on a schedule: every Monday, as Excel, to finance herself (the recipients who may read the whole organization)
  const schedule = page.getByRole('region', { name: 'ส่งรายงานทางอีเมลตามรอบ' })
  await expect(schedule.getByRole('checkbox', { name: 'ฟ้าใส บัญชี (คุณ)' })).toBeChecked()
  await expect(schedule.getByRole('checkbox', { name: 'ศักดิ์ชัย ผู้นำ' })).not.toBeChecked()
  await expect(schedule.getByText('สมชาย ใจดี')).toHaveCount(0)
  await schedule.getByRole('radio', { name: 'ทุกวันจันทร์ 08:00 น.' }).check()
  await schedule.getByRole('radio', { name: 'Excel' }).check()
  await schedule.getByRole('button', { name: 'ตั้งส่งรายงานทางอีเมล' }).click()
  await expect(schedule.getByRole('status')).toHaveText('ตั้งส่งรายงานแล้ว: ทุกวันจันทร์ 08:00 น. ถึงผู้รับ 1 คน')
  const listed = schedule.getByRole('list', { name: 'รอบส่งรายงานที่ตั้งไว้' }).getByRole('listitem').first()
  await expect(listed).toContainText('ตัวชี้วัด (KPI) G-1 ถึง G-5 · ทุกวันจันทร์ 08:00 น. · ไฟล์ Excel')
  await expect(listed).toContainText('ผู้รับ 1 คน · ตั้งโดย ฟ้าใส บัญชี')
  await checkScreen(page, testInfo, 'reports-scheduled')

  // No recipient: said next to the form, nothing is sent
  await schedule.getByRole('checkbox', { name: 'ฟ้าใส บัญชี (คุณ)' }).uncheck()
  await schedule.getByRole('button', { name: 'ตั้งส่งรายงานทางอีเมล' }).click()
  await expect(schedule.getByRole('alert')).toHaveText('เลือกผู้รับอย่างน้อย 1 คนที่ยังใช้งานอยู่')
})

test('[FR-VIS-002/AC3] a department head’s reports read the departments they head and schedule nothing; a requester is refused', async ({ page }, testInfo) => {
  // a scene of its own (a separate process through the services) and axe on several screens
  test.slow()
  const head = testInfo.project.name === 'mobile' ? 'dm_it' : 'dm_con'
  await signInAs(page, head)
  await page.goto('/reports')
  await expect(page.getByText('รายงานอ่านเฉพาะแผนกที่คุณดูแล')).toBeVisible()
  await expect(page.getByText(/^ช่วง .+ ถึง .+ · แผนกที่คุณดูแล · อ่านเมื่อ .+$/)).toBeVisible()
  await expect(reportRow(page, 'การตัดสินใน LINE ทุกชนิดเอกสาร')).toHaveCount(1)
  await expect(page.getByRole('region', { name: 'ส่งรายงานทางอีเมลตามรอบ' })).toHaveCount(0)
  // the head's report opens no organization-wide KPI page
  await expect(page.getByRole('link', { name: 'เปิดหน้า KPI ของช่วงนี้' })).toHaveCount(0)
  await checkScreen(page, testInfo, 'reports-head')

  await page.context().clearCookies()
  await signInAs(page, testInfo.project.name === 'mobile' ? 'req_it' : 'req_con2', false)
  await page.goto('/reports')
  await expect(page.getByText('หน้ารายงานสำหรับฝ่ายบัญชีและการเงิน ฝ่ายจัดซื้อ ผู้บริหาร ผู้ตรวจสอบ และหัวหน้าแผนก', { exact: false })).toBeVisible()
  await expect(page.getByRole('table')).toHaveCount(0)
  await checkScreen(page, testInfo, 'reports-refused')
})
