import { randomUUID } from 'node:crypto'
import { type Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { checkScreen, csvRows, exportedFile, scene, settleNoticesAfterEachTest, sha256, sheetRows, shownChecksum, signInAs, type DecisionsScene } from './insight-support'

settleNoticesAfterEachTest(test)

// S4-10 · FR-VIS-004, FR-DOA-005 AC3 (spec §4.5, demo scene 9 with the auditor — ADR-038 ข้อ 5): the AUDITOR searches
// the events by document, actor, period, type and channel; every decision names its DOA version and rule, the channel,
// the actor and on whose behalf; only the AUDITOR exports the search as Excel or CSV, with those columns in every row
// and the file's checksum, and the export is an event of its own. tests/e2e/insight-scene.ts makes three requests the
// DM approved in the past, in LINE chat, in LIFF and on the web.

const COLUMNS = ['seq', 'occurredAt', 'type', 'aggregateType', 'aggregateId', 'actorType', 'actor', 'onBehalfOf', 'channel', 'doaVersionId', 'doaRuleCode', 'data']
const results = (page: Page) => page.locator('table:visible tbody tr, ul[aria-label="เหตุการณ์ตามเงื่อนไขที่ค้น เรียงจากใหม่ไปเก่า"]:visible > li')
const doaText = (s: DecisionsScene) => `${s.doa.code} ฉบับ ${s.doa.versionNo} ข้อ ${s.doa.ruleCode}`

async function searchDocument(page: Page, number: string) {
  await page.getByLabel('เลขที่เอกสาร').fill(number)
  await page.getByRole('button', { name: 'ค้นหาบันทึก' }).click()
  await expect(page).toHaveURL(new RegExp(`document=${number}`))
}

test('[FR-VIS-004/AC1] the auditor finds a document’s trail by its number, and searches by actor, period, type and channel', async ({ page }, testInfo) => {
  // a scene of its own (a separate process through the services) and axe on several screens
  test.slow()
  const s = scene<DecisionsScene>('decisions', testInfo.project.name)
  const [line, liff] = s.requests
  await signInAs(page, 'auditor')
  await page.goto('/audit')
  await expect(page.getByRole('heading', { level: 1, name: 'บันทึกการตรวจสอบ' })).toBeVisible()
  await checkScreen(page, testInfo, 'audit')

  // By document: the request's own events and its decision, with the DOA version and rule, the channel and the actor
  await searchDocument(page, line!.number)
  const decided = results(page).filter({ hasText: 'ตัดสินงานอนุมัติ: อนุมัติ' })
  await expect(decided).toHaveCount(1)
  await expect(decided).toContainText(line!.approver.name)
  await expect(decided).toContainText('แชท LINE')
  await expect(decided).toContainText(doaText(s))
  await expect(decided).toContainText(`คำขอ ${line!.number} ${line!.title}`)
  await expect(results(page).filter({ hasText: 'ส่งคำขอ' }).filter({ hasText: s.requester.name })).toHaveCount(1)
  // …and the budget the request reserved, on its budget line
  const reserved = results(page).filter({ hasText: 'จองงบ' })
  await expect(reserved).toHaveCount(1)
  await expect(reserved).toContainText('บรรทัดงบ')
  await expect(page.getByText(/^\d+ รายการล่าสุด เรียงจากใหม่ไปเก่า/)).toBeVisible()
  await checkScreen(page, testInfo, 'audit-document')

  // By actor, type, channel and period: the DM's decisions in LIFF today and the days before
  await page.getByRole('link', { name: 'ล้างเงื่อนไข' }).first().click()
  await expect(page).toHaveURL(/\/audit$/)
  await expect(page.getByLabel('เลขที่เอกสาร')).toHaveValue('')
  await page.getByLabel('ผู้กระทำ').selectOption({ label: liff!.approver.name })
  await page.getByLabel('ประเภทเหตุการณ์').selectOption({ label: 'ตัดสินงานอนุมัติ' })
  await page.getByLabel('ช่องทาง').selectOption({ label: 'LINE (LIFF)' })
  await page.getByLabel('ตั้งแต่วันที่').fill(s.kpi.from)
  await page.getByLabel('ถึงวันที่').fill(s.kpi.to)
  await page.getByRole('button', { name: 'ค้นหาบันทึก' }).click()
  await expect(page).toHaveURL(/channel=LIFF/)
  // the date fields may show Christian-era years: the period searched is said again in Buddhist-era days
  await expect(page.getByText(/^ช่วง \d{1,2} \S+ 25\d\d ถึง \d{1,2} \S+ 25\d\d$/)).toBeVisible()
  await expect(results(page).filter({ hasText: liff!.number })).toHaveCount(1)
  await expect(results(page).filter({ hasText: line!.number })).toHaveCount(0)
  const rows = await results(page).count()
  expect(rows).toBeGreaterThanOrEqual(1)
  for (let i = 0; i < rows; i++) {
    await expect(results(page).nth(i)).toContainText('LINE (LIFF)')
    await expect(results(page).nth(i)).toContainText(liff!.approver.name)
  }
  await checkScreen(page, testInfo, 'audit-filtered')

  // A number nobody has: nothing, and how to go on
  await page.goto('/audit?document=PR-2569-99999')
  await expect(page.getByText('ไม่พบบันทึกของเอกสาร PR-2569-99999')).toBeVisible()
  await checkScreen(page, testInfo, 'audit-none')
})

test('[FR-VIS-004/AC2] [FR-VIS-004/AC3] [FR-DOA-005/AC3] the auditor exports the search as Excel and CSV with the DOA version, rule, channel, actor and on-behalf-of in every row and the file’s checksum; the export is an event', async ({ page }, testInfo) => {
  // a scene of its own (a separate process through the services) and axe on several screens
  test.slow()
  const s = scene<DecisionsScene>('decisions', testInfo.project.name)
  const line = s.requests[0]!
  await signInAs(page, 'auditor')
  await page.goto(`/audit?document=${line.number}`)
  await expect(page.getByRole('heading', { level: 2, name: 'ส่งออกผลการค้นหานี้' })).toBeVisible()

  for (const [format, button] of [
    ['xlsx', 'ส่งออก Excel'],
    ['csv', 'ส่งออก CSV'],
  ] as const) {
    const bytes = await exportedFile(page, button)
    await expect(page.getByRole('status').filter({ hasText: /^ส่งออกแล้ว \d+ แถว และเริ่มดาวน์โหลดไฟล์ให้แล้ว/ })).toBeVisible()
    expect(sha256(bytes), format).toBe(await shownChecksum(page))
    const [header, ...body] = format === 'xlsx' ? await sheetRows(bytes, COLUMNS.length) : csvRows(bytes)
    expect(header, format).toEqual(COLUMNS)
    const shown = Number((await page.getByText(/^ส่งออกแล้ว \d+ แถว/).innerText()).match(/\d+/)![0])
    expect(body, format).toHaveLength(shown)
    // every row has every column, the decision with its DOA reference
    for (const row of body) expect(row, format).toHaveLength(COLUMNS.length)
    const decision = body.find((r) => r[COLUMNS.indexOf('type')] === 'approval_task.decided')!
    const cell = (r: string[], c: string) => r[COLUMNS.indexOf(c)]
    expect(['doaVersionId', 'doaRuleCode', 'channel', 'actor', 'onBehalfOf'].map((c) => cell(decision, c)), format).toEqual([s.doa.versionId, s.doa.ruleCode, 'LINE_CHAT', line.approver.name, ''])
    expect(cell(decision, 'aggregateId')).toBe(line.taskId)
    await checkScreen(page, testInfo, `audit-exported-${format}`)
  }

  // The export is in the trail itself (FR-VIS-004 AC3): the auditor's own export, the newest of its kind
  await page.goto('/audit')
  await page.getByLabel('ประเภทเหตุการณ์').selectOption({ label: 'ส่งออกบันทึกการตรวจสอบ' })
  await page.getByLabel('ผู้กระทำ').selectOption({ label: 'อรุณ ตรวจสอบ' })
  await page.getByRole('button', { name: 'ค้นหาบันทึก' }).click()
  await expect(results(page).first()).toContainText('ส่งออกบันทึกการตรวจสอบ')
  await expect(results(page).first()).toContainText('ไฟล์ส่งออกบันทึกการตรวจสอบ')
  expect(await results(page).count()).toBeGreaterThanOrEqual(2)
})

test('[FR-VIS-004/AC2] only the auditor exports: the organization admin may look but gets no file, and the CEO is refused the page and the export', async ({ page }, testInfo) => {
  // a scene of its own (a separate process through the services) and axe on several screens
  test.slow()
  const s = scene<DecisionsScene>('decisions', testInfo.project.name)
  const body = { idempotencyKey: randomUUID(), format: 'xlsx', filter: { document: s.requests[0]!.number } }
  await signInAs(page, 'admin')
  await page.goto(`/audit?document=${s.requests[0]!.number}`)
  await expect(page.getByText('ส่งออกไฟล์ได้เฉพาะผู้ตรวจสอบขององค์กร ผู้ดูแลองค์กรค้นและดูบันทึกได้อย่างเดียว')).toBeVisible()
  await expect(page.getByRole('button', { name: 'ส่งออก Excel' })).toHaveCount(0)
  await expect(results(page).filter({ hasText: 'ตัดสินงานอนุมัติ: อนุมัติ' })).toHaveCount(1)
  const adminTry = await page.request.post('/audit/export', { data: body })
  expect(adminTry.status()).toBe(403)
  expect(await adminTry.json()).toMatchObject({ ok: false, code: 'FORBIDDEN' })
  await checkScreen(page, testInfo, 'audit-admin')

  await page.context().clearCookies()
  await signInAs(page, 'ceo')
  await page.goto('/audit')
  await expect(page.getByText('หน้าบันทึกการตรวจสอบเปิดได้เฉพาะผู้ตรวจสอบและผู้ดูแลองค์กร', { exact: false })).toBeVisible()
  await expect(page.getByRole('button', { name: 'ค้นหาบันทึก' })).toHaveCount(0)
  const ceoTry = await page.request.post('/audit/export', { data: { ...body, idempotencyKey: randomUUID() } })
  expect(ceoTry.status()).toBe(403)
  expect(await ceoTry.json()).toMatchObject({ ok: false, code: 'FORBIDDEN' })
  await checkScreen(page, testInfo, 'audit-ceo-refused')
})
