import { randomUUID } from 'node:crypto'
import { expect, test } from './fixtures'
import { checkScreen, exportedFile, percent, scene, settleNoticesAfterEachTest, sha256, sheetRows, shownChecksum, signInAs, type BoardScene, type DecisionsScene } from './insight-support'

settleNoticesAfterEachTest(test)

// Demo scene 9 "ผู้บริหารเห็นทุกอย่าง" (sheet Demo_Script, spec §16.10 "ฉากที่ปรับ", D.md): the CEO opens the board and
// sees a request waiting past its SLA at a VP (Demo_History H12: 18 business hours at the VP, SLA 8), then the KPI share
// of purchase-request decisions made on LINE; the audit export with the DOA reference is made by the AUDITOR, because
// audit.export is the AUDITOR's (§2.4, ADR-038 ข้อ 5) — the CEO's export is refused with FORBIDDEN. The e2e database
// has no demo history, so tests/e2e/insight-scene.ts makes the same situations through the services with the clock set
// back. (The budget dashboard step of the scene is tested with the budget screens.)

const COLUMNS = ['seq', 'occurredAt', 'type', 'aggregateType', 'aggregateId', 'actorType', 'actor', 'onBehalfOf', 'channel', 'doaVersionId', 'doaRuleCode', 'data']

test('@demo [FR-VIS-001/AC1] [FR-VIS-003/AC2] [FR-VIS-004/AC2] [FR-DOA-005/AC3] scene 9: the CEO sees the request past its SLA at a VP and the share of purchase-request decisions on LINE; the auditor exports the audit with the DOA reference; the CEO’s export is refused', async ({ page }, testInfo) => {
  // a scene of its own (a separate process through the services) and axe on several screens
  test.slow()
  const board = scene<BoardScene>('board', testInfo.project.name)
  const decided = scene<DecisionsScene>('decisions', testInfo.project.name)
  const vp = board.overdue.approver
  const onLine = decided.requests.find((r) => r.channel === 'LINE_CHAT')!

  // The CEO: who holds what — the VP holds the request past its SLA
  await signInAs(page, 'ceo')
  await page.goto('/board/pending')
  const row = page.locator('tr:visible, li:visible').filter({ has: page.getByRole('link', { name: `ดูเอกสารที่ค้างที่ ${vp.name}`, exact: true }) })
  await expect(row.getByRole('link', { name: new RegExp(`^เกินกำหนด [1-9]\\d* ฉบับที่ ${vp.name}: ดูเอกสาร$`) })).toBeVisible()
  await row.getByRole('link', { name: `ดูเอกสารที่ค้างที่ ${vp.name}`, exact: true }).click()
  const item = page.getByRole('list', { name: `เอกสารที่ค้างที่ ${vp.name}` }).getByRole('listitem').filter({ hasText: board.overdue.number })
  await expect(item).toContainText(/ค้างมา 1[89]\.\d ชั่วโมงทำการ/)
  await expect(item).toContainText('เกินกำหนดตั้งแต่')
  await checkScreen(page, testInfo, 'scene9-board')

  // The KPI: decisions of purchase requests made on LINE
  await page.goto('/kpi')
  const pr = `${percent(decided.kpi.pr.numerator, decided.kpi.pr.denominator)}%`
  await expect(page.getByRole('link', { name: `ดูรายการที่นับ: การตัดสินใน LINE ของคำขอซื้อ ${pr} (${decided.kpi.pr.numerator} จาก ${decided.kpi.pr.denominator} การตัดสิน)` })).toBeVisible()
  await checkScreen(page, testInfo, 'scene9-kpi')

  // The CEO may not export the audit trail (ADR-038 ข้อ 5)
  const refused = await page.request.post('/audit/export', { data: { idempotencyKey: randomUUID(), format: 'xlsx', filter: { document: onLine.number } } })
  expect(refused.status()).toBe(403)
  expect(await refused.json()).toMatchObject({ ok: false, code: 'FORBIDDEN' })

  // The auditor exports the decision with its DOA reference
  await page.context().clearCookies()
  await signInAs(page, 'auditor')
  await page.goto(`/audit?document=${onLine.number}`)
  const decision = page.locator('table:visible tbody tr, ul[aria-label="เหตุการณ์ตามเงื่อนไขที่ค้น เรียงจากใหม่ไปเก่า"]:visible > li').filter({ hasText: 'ตัดสินงานอนุมัติ: อนุมัติ' })
  await expect(decision).toContainText('แชท LINE')
  await expect(decision).toContainText(`${decided.doa.code} ฉบับ ${decided.doa.versionNo} ข้อ ${decided.doa.ruleCode}`)
  const bytes = await exportedFile(page, 'ส่งออก Excel')
  expect(sha256(bytes)).toBe(await shownChecksum(page))
  const [header, ...rows] = await sheetRows(bytes, COLUMNS.length)
  expect(header).toEqual(COLUMNS)
  const exported = rows.find((r) => r[COLUMNS.indexOf('type')] === 'approval_task.decided')!
  expect(['doaVersionId', 'doaRuleCode', 'channel', 'actor'].map((c) => exported[COLUMNS.indexOf(c)])).toEqual([decided.doa.versionId, decided.doa.ruleCode, 'LINE_CHAT', onLine.approver.name])
  await checkScreen(page, testInfo, 'scene9-audit-export')
})
