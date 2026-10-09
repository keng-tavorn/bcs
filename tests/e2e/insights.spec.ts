import { expect, test } from './fixtures'
import { checkScreen, scene, settleNoticesAfterEachTest, signInAs, type DecisionsScene } from './insight-support'

settleNoticesAfterEachTest(test)

// S16-08 · the executive summary /insights (FR-VIS-007, spec §9.10, §11.5): the CEO opens it, sees the four cards, opens
// a number's list with the same filters, changes the period in the address and comes back to the same view; the chart
// has a table view; a department head sees only what their lists open; /kpi leads here. tests/e2e/insight-scene.ts makes
// three purchase requests the DM approved in LINE chat, in LIFF and on the web, so the control card has decisions.

const CARDS = ['การใช้จ่าย', 'งบประมาณ', 'ความเร็ว', 'การควบคุม']

test('@demo [FR-VIS-007/AC2] [FR-VIS-007/AC3] the CEO sees spending, budget, speed and control, and a number opens the list it counts with the same filters', async ({ page }, testInfo) => {
  // a scene of its own (a separate process through the services) and axe on several screens
  test.slow()
  scene<DecisionsScene>('decisions', testInfo.project.name)
  await signInAs(page, 'ceo')
  await page.goto('/insights')
  await expect(page.getByRole('heading', { level: 1, name: 'สรุปผู้บริหาร' })).toBeVisible()
  for (const card of CARDS) await expect(page.getByRole('heading', { level: 2, name: card })).toBeVisible()
  await expect(page.getByText(/^.+ ถึง .+ \(30 วัน\)$/)).toBeVisible()
  // each card says what needs attention, or that nothing does
  await expect(page.getByRole('heading', { level: 3, name: 'ต้องดูแล' })).toHaveCount(4)
  // AC2 AC5: the charts load after the page and draw their marks — the channels' bar and the week of the scene's decisions
  await expect(page.locator('[aria-labelledby="insights-control"] .recharts-bar-rectangle path').first()).toBeVisible()
  const dot = page.locator('[aria-labelledby="insights-speed"] .recharts-line-dots circle').first()
  await expect(dot).toBeVisible()
  // the point wears the series colour (§9.10 --chart-1 #0F8A6F), not a white dot on a white card
  expect(await dot.evaluate((e) => getComputedStyle(e).fill)).toBe('rgb(15, 138, 111)')
  await page.locator('[aria-labelledby="insights-speed"] figure').screenshot({ path: testInfo.outputPath('insights-speed-chart.png') })
  await checkScreen(page, testInfo, 'insights')

  // AC3: the share of decisions citing the DOA opens those decisions; the list is as long as the figure says
  const control = page.getByRole('region', { name: 'การควบคุม' }).or(page.locator('[aria-labelledby="insights-control"]'))
  const figure = control.getByRole('link', { name: /จาก \d+ การตัดสิน/ })
  const counted = Number(/(\d+) จาก \d+ การตัดสิน/.exec(await figure.innerText())![1])
  expect(counted).toBeGreaterThan(0)
  await figure.click()
  await expect(page).toHaveURL(/\/insights\/doa-ref$/)
  await expect(page.getByRole('heading', { level: 1, name: 'การตัดสินที่อ้าง DOA ครบ' })).toBeVisible()
  await expect(page.getByText(`${counted} รายการ`, { exact: true })).toBeVisible()
  await expect(page.getByRole('list', { name: 'การตัดสินที่อ้าง DOA ครบ' }).getByRole('listitem')).toHaveCount(Math.min(counted, 200))
  await checkScreen(page, testInfo, 'insights-list')
  await page.getByRole('link', { name: 'กลับสรุปผู้บริหาร' }).click()
  await expect(page).toHaveURL(/\/insights$/)

  // AC2 AC5: the chart comes with a table where each channel's count opens its decisions
  await control.getByRole('button', { name: 'ดูเป็นตาราง' }).click()
  const table = control.getByRole('table')
  await expect(table.getByRole('columnheader', { name: 'ช่องทาง' })).toBeVisible()
  const web = table.getByRole('row').filter({ hasText: 'เว็บ' }).getByRole('link').first()
  await expect(web).toHaveAttribute('href', '/insights/channel?channel=WEB')
  await control.getByRole('button', { name: 'ดูเป็นกราฟ' }).click()
  await expect(control.getByRole('table')).toHaveCount(0)
})

test('[FR-VIS-007/AC1] the filters live in the address: 90 days and a department, kept on reload and carried into a list', async ({ page }, testInfo) => {
  await signInAs(page, 'ceo')
  await page.goto('/insights')
  await page.getByLabel('ช่วงเวลา').selectOption('90d')
  await expect(page).toHaveURL(/\/insights\?range=90d$/)
  await expect(page.getByText(/^.+ ถึง .+ \(90 วัน\)$/)).toBeVisible()
  const dept = page.getByLabel('แผนก', { exact: true })
  const option = await dept.locator('option').nth(1).getAttribute('value')
  await dept.selectOption(option!)
  await expect(page).toHaveURL(new RegExp(`range=90d&dept=${option}$`))
  await page.reload()
  await expect(page.getByLabel('ช่วงเวลา')).toHaveValue('90d')
  await expect(page.getByLabel('แผนก', { exact: true })).toHaveValue(option!)
  await page.getByRole('link', { name: /^งานเกินกำหนดตอนนี้: \d+ งาน$/ }).click()
  await expect(page).toHaveURL(new RegExp(`/insights/overdue\\?range=90d&dept=${option}$`))
  // a list with nothing in it repeats the way back in its empty state, to the same place
  await page.getByRole('link', { name: 'กลับสรุปผู้บริหาร' }).first().click()
  await expect(page.getByLabel('ช่วงเวลา')).toHaveValue('90d')
  await page.getByLabel('ช่วงเวลา').selectOption('custom')
  await expect(page.getByRole('button', { name: 'แสดงช่วงนี้' })).toBeVisible()
  await checkScreen(page, testInfo, 'insights-filtered')
  await page.getByRole('link', { name: 'ล้างตัวกรอง' }).click()
  await expect(page).toHaveURL(/\/insights$/)
  await expect(page.getByLabel('ช่วงเวลา')).toHaveValue('30d')
})

test('[FR-VIS-007/AC4] a department head sees the cards of their departments without spending; a requester is refused; /kpi leads here', async ({ page }, testInfo) => {
  const head = testInfo.project.name === 'mobile' ? 'dm_it' : 'dm_con'
  await signInAs(page, head)
  await page.goto('/insights')
  await expect(page.getByText(/^แสดงเฉพาะแผนกที่คุณเป็นหัวหน้า/)).toBeVisible()
  for (const card of ['งบประมาณ', 'ความเร็ว', 'การควบคุม']) await expect(page.getByRole('heading', { level: 2, name: card })).toBeVisible()
  // spending and idle POs are lists of POs: a head may not open every PO, so neither is shown
  await expect(page.getByRole('heading', { level: 2, name: 'การใช้จ่าย' })).toHaveCount(0)
  await expect(page.getByText(/PO ไม่มีความเคลื่อนไหว/)).toHaveCount(0)
  await checkScreen(page, testInfo, 'insights-head')
  await page.goto('/insights/spend')
  await expect(page.getByText('รายการนี้เปิดได้เฉพาะผู้ที่ดูเอกสารทั้งหมดของรายการได้')).toBeVisible()

  await page.context().clearCookies()
  await signInAs(page, testInfo.project.name === 'mobile' ? 'req_it' : 'req_con2', false)
  await page.goto('/insights')
  await expect(page.getByText('หน้านี้สำหรับผู้ที่ดูรายงานได้', { exact: false })).toBeVisible()

  await page.context().clearCookies()
  await signInAs(page, 'ceo')
  await page.goto('/kpi')
  await page.getByRole('link', { name: 'ดูสรุปผู้บริหาร: การใช้จ่าย งบประมาณ ความเร็ว และการควบคุม' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'สรุปผู้บริหาร' })).toBeVisible()
})
