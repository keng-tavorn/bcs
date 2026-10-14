import { expect, test } from './fixtures'
import { checkScreen, exportedFile, scene, settleNoticesAfterEachTest, sha256, sheetRows, shownChecksum, signInAs, type DecisionsScene } from './insight-support'

settleNoticesAfterEachTest(test)

// S6-20 · FR-VIS-101 AC1–AC3 (BR-RPT-03 to BR-RPT-06): /reports/workflow — cycle time, bottlenecks, decisions outside
// the DOA and the heatmaps, over the last 30 days within the reader's report.view scope. tests/e2e/insight-scene.ts makes
// three purchase requests the DM approved 1, 2 and 3 business hours after they were sent, so the period has requests,
// decisions and their times. Every chart has its table view (AC3); one tab exports its report as Excel with a checksum.

test('[FR-VIS-101/AC1] [FR-VIS-101/AC3] finance reads the four workflow tabs with a table view of every chart, opens the requests, and exports a tab to Excel with its checksum', async ({ page }, testInfo) => {
  // a scene of its own (a separate process through the services) and axe on several screens
  test.slow()
  const s = scene<DecisionsScene>('decisions', testInfo.project.name)
  await signInAs(page, 'fin_officer')

  // Reached from the reports catalogue, opening on its tab
  await page.goto('/reports')
  await page.getByRole('link', { name: 'เวลาอนุมัติของคำขอ' }).click()
  await expect(page).toHaveURL(/\/reports\/workflow\?tab=cycle$/)
  await expect(page.getByRole('heading', { level: 1, name: 'เวลาและคอขวดของการอนุมัติ' })).toBeVisible()
  await expect(page.getByText(/^ช่วง .+ ถึง .+ · ทั้งองค์กร · อ่านเมื่อ .+$/)).toBeVisible()

  // Cycle time: the three medians in business hours, and every request of the scene opening its page
  const medians = page.locator('dl[aria-label="ค่ากลางของช่วงนี้"] dd')
  await expect(medians).toHaveCount(3)
  await expect(medians.first()).toHaveText(/^\d+\.\d ชั่วโมงทำการ$/)
  for (const r of s.requests) await expect(page.getByRole('link', { name: r.number, exact: true }).filter({ visible: true })).toHaveAttribute('href', `/requests/${r.id}`)
  // the chart loads lazily and has its table view
  await expect(page.getByText(/^คำขอที่ใช้เวลาจากส่งถึงอนุมัติครบนานที่สุด \d+ รายการ$/)).toBeVisible()
  await page.getByRole('button', { name: 'ดูเป็นตาราง' }).click()
  await expect(page.getByRole('columnheader', { name: 'ส่งถึงอนุมัติครบ' }).filter({ visible: true }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'ดูเป็นกราฟ' })).toHaveAttribute('aria-pressed', 'true')
  await checkScreen(page, testInfo, 'workflow-cycle')

  // The tab's Excel: the requests of the same period and scope, with the checksum the page shows
  const bytes = await exportedFile(page, 'ส่งออก Excel')
  expect(sha256(bytes)).toBe(await shownChecksum(page))
  const [header, ...rows] = await sheetRows(bytes, 5)
  expect(header).toEqual(['เลขที่คำขอ', 'ส่งเมื่อ', 'อนุมัติครบเมื่อ', 'ส่งถึงอนุมัติครบ (ชั่วโมงทำการ)', 'ส่งถึง PO แรกอนุมัติ (ชั่วโมงทำการ)'])
  for (const r of s.requests) expect(rows.map((row) => row[0])).toContain(r.number)

  // Bottlenecks: by position and by person, the chart with its table; the tab is in the address
  await page.getByRole('tab', { name: 'คอขวด' }).click()
  await expect(page).toHaveURL(/tab=bottlenecks/)
  await expect(page.getByRole('heading', { name: 'ตามตำแหน่งที่งานรอ' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'ตามผู้ได้รับงาน' })).toBeVisible()
  await page.getByRole('button', { name: 'ดูเป็นตาราง' }).click()
  await expect(page.getByRole('columnheader', { name: 'ค่ากลางเวลาตัดสิน' }).filter({ visible: true }).first()).toBeVisible()
  await checkScreen(page, testInfo, 'workflow-bottlenecks')

  // Outside DOA: the items with their reasons, or that there are none in the period — never a bare "no data"
  await page.getByRole('tab', { name: 'ผิด DOA' }).click()
  await expect(page).toHaveURL(/tab=wrongDoa/)
  await expect(page.getByText(/^\d+ รายการ · ผู้ตัดสินไม่ใช่ผู้ที่ DOA กำหนด \d+ · ไม่อ้าง DOA \d+ · อาจแตกยอด \d+$/).or(page.getByText('ไม่พบการตัดสินที่ไม่เป็นไปตาม DOA ในช่วงนี้'))).toBeVisible()
  await checkScreen(page, testInfo, 'workflow-wrong-doa')

  // Heatmap: decisions by weekday and hour, and the tasks waiting now by department and age, each with its table view
  await page.getByRole('tab', { name: 'ความหนาแน่นของงาน' }).click()
  await expect(page).toHaveURL(/tab=heatmap/)
  await expect(page.getByText('จำนวนการตัดสินตามวันและชั่วโมง (เวลาไทย)')).toBeVisible()
  await expect(page.getByRole('list', { name: 'ระดับสี' }).first()).toBeVisible()
  await checkScreen(page, testInfo, 'workflow-heatmap')
  await page.getByRole('button', { name: 'ดูเป็นตาราง' }).first().click()
  await expect(page.getByRole('columnheader', { name: 'วันและเวลา' })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'การตัดสิน (ครั้ง)' })).toBeVisible()
  await checkScreen(page, testInfo, 'workflow-heatmap-table')

  // A new period keeps the tab the reader is on
  await page.getByRole('button', { name: 'ดูช่วงนี้' }).click()
  await expect(page).toHaveURL(/\/reports\/workflow\?.*tab=heatmap/)
  await expect(page.getByRole('tab', { name: 'ความหนาแน่นของงาน' })).toHaveAttribute('aria-selected', 'true')
})

test('[FR-VIS-101/AC1] a requester without report.view is refused the workflow reports', async ({ page }, testInfo) => {
  await signInAs(page, testInfo.project.name === 'mobile' ? 'req_it' : 'req_con2', false)
  await page.goto('/reports/workflow')
  await expect(page.getByText('หน้ารายงานสำหรับฝ่ายบัญชีและการเงิน ฝ่ายจัดซื้อ ผู้บริหาร ผู้ตรวจสอบ และหัวหน้าแผนก', { exact: false })).toBeVisible()
  await expect(page.getByRole('tab')).toHaveCount(0)
  await expect(page.getByRole('table')).toHaveCount(0)
})
