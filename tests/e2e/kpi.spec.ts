import { expect, test } from './fixtures'
import { checkScreen, csvRows, exportedFile, percent, scene, settleNoticesAfterEachTest, sha256, shownChecksum, signInAs, type DecisionsScene } from './insight-support'

settleNoticesAfterEachTest(test)

// S5-12 · FR-VIS-003 AC2 AC3 (spec §11.4, demo scene 9): the KPI page for executives — G-1 to G-5 of the organization
// for the 60 days of the review, each with its formula in words, its value next to the Phase 0 baseline (none is recorded
// yet, and the page says so) and the proposed target; every value opens the documents it counts; G-5 in all and per kind
// of document; a CSV of the period for the 60-day review. tests/e2e/insight-scene.ts makes three purchase requests the
// DM approved in LINE chat, in LIFF and on the web, and counts G-5 from the events the way §11.4 defines it.

const LINE_PR = 'การตัดสินใน LINE ของคำขอซื้อ'

test('[FR-VIS-003/AC2] the executive sees the current values of G-1 to G-5 with their formulas and targets — the share of purchase-request decisions on LINE opens the decisions it counts, and "x จาก y ขั้น" of the steps past due every step it divides by — and no invented baseline while none is recorded', async ({ page }, testInfo) => {
  // a scene of its own (a separate process through the services) and axe on several screens
  test.slow()
  const s = scene<DecisionsScene>('decisions', testInfo.project.name)
  await signInAs(page, 'ceo')
  await page.goto('/kpi')
  await expect(page.getByRole('heading', { level: 1, name: 'ตัวชี้วัด (KPI)' })).toBeVisible()
  await expect(page.getByText(/^ช่วง .+ ถึง .+ \(60 วัน\)$/)).toBeVisible()
  // No baseline is invented: where it is kept waits for the user (NEW-36), so the page says none is recorded, in a notice
  // and for every measure (the comparison with a recorded one is in tests/unit/insight-kpi-present.test.ts)
  await expect(page.getByRole('status').filter({ hasText: 'ยังไม่มีค่าตั้งต้นให้เทียบ' })).toBeVisible()
  await expect(page.getByText('ยังไม่ได้บันทึก', { exact: true }).filter({ visible: true }).first()).toBeVisible()
  for (const goal of ['G-1 · ประตูเดียว', 'G-2 · อนุมัติถูกคน', 'G-3 · เร็วขึ้น', 'G-4 · คุมงบ', 'G-5 · อนุมัติบนมือถือ']) await expect(page.getByText(goal, { exact: true }).filter({ visible: true })).toBeVisible()
  await expect(page.getByText('การตัดสินในแชท LINE หรือหน้าจอใน LINE ÷ การตัดสินทั้งหมดในช่วงนี้ แสดงทั้งรวมและแยกตามชนิดเอกสาร').filter({ visible: true }).first()).toBeVisible()
  await expect(page.getByText('อย่างน้อย 60%').filter({ visible: true }).first()).toBeVisible()

  // G-5 of purchase requests, as the events count it
  const pr = `${percent(s.kpi.pr.numerator, s.kpi.pr.denominator)}%`
  const prLink = page.getByRole('link', { name: `ดูรายการที่นับ: ${LINE_PR} ${pr} (${s.kpi.pr.numerator} จาก ${s.kpi.pr.denominator} การตัดสิน)` })
  await expect(prLink).toBeVisible()
  await expect(prLink).toHaveText(pr)
  const all = `${percent(s.kpi.all.numerator, s.kpi.all.denominator)}%`
  await expect(page.getByRole('link', { name: `ดูรายการที่นับ: การตัดสินใน LINE ${all} (${s.kpi.all.numerator} จาก ${s.kpi.all.denominator} การตัดสิน)` })).toBeVisible()
  await checkScreen(page, testInfo, 'kpi')

  // Every number leads to its list: the purchase-request decisions, each counted or not with its channel and DOA rule
  await prLink.click()
  await expect(page).toHaveURL(new RegExp(`/kpi/g5\\?from=${s.kpi.from}&to=${s.kpi.to}&kind=PURCHASE_REQUEST$`))
  await expect(page.getByRole('heading', { level: 1, name: LINE_PR })).toBeVisible()
  await expect(page.getByText(`นับ ${s.kpi.pr.numerator} จาก ${s.kpi.pr.denominator} รายการ`)).toBeVisible()
  const list = page.getByRole('list', { name: `รายการที่นับใน${LINE_PR}` })
  const marks = { LINE_CHAT: 'นับ: ตัดสินผ่านช่องทาง แชท LINE', LIFF: 'นับ: ตัดสินผ่านช่องทาง หน้าจอใน LINE', WEB: 'ไม่นับ: ตัดสินผ่านช่องทาง เว็บ' } as const
  for (const r of s.requests) {
    const item = list.getByRole('listitem').filter({ hasText: r.number })
    await expect(item.getByRole('link', { name: `คำขอ ${r.number} ${r.title}` })).toHaveAttribute('href', `/requests/${r.id}`)
    await expect(item).toContainText(`อนุมัติโดย ${r.approver.name}`)
    await expect(item).toContainText(`${s.doa.code} ฉบับ ${s.doa.versionNo} ข้อ ${s.doa.ruleCode}`)
    await expect(item).toContainText(marks[r.channel])
  }
  await checkScreen(page, testInfo, 'kpi-items')
  await page.getByRole('link', { name: 'กลับไปหน้า KPI' }).click()
  await expect(page).toHaveURL(new RegExp(`/kpi\\?from=${s.kpi.from}&to=${s.kpi.to}$`))

  // A count is a number like the others: G-4's opens its list whatever it is, "0 รายการ" too, and the list says the same
  // count and shows what it counts or that none is in the period (§9.9: every number opens its list)
  const g4 = page.getByRole('link', { name: /^ดูรายการที่นับ: คำขอเกินงบที่หลุดถึงผู้อนุมัติ \d+ รายการ$/ })
  await expect(g4).toHaveAttribute('href', `/kpi/g4?from=${s.kpi.from}&to=${s.kpi.to}`)
  const count = (await g4.innerText()).trim()
  expect(count).toMatch(/^\d+ รายการ$/)
  await g4.click()
  await expect(page.getByRole('heading', { level: 1, name: 'คำขอเกินงบที่หลุดถึงผู้อนุมัติ' })).toBeVisible()
  await expect(page.getByText(count, { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('list', { name: 'รายการที่นับในคำขอเกินงบที่หลุดถึงผู้อนุมัติ' }).or(page.getByText('ไม่มีรายการในช่วงนี้', { exact: true }))).toBeVisible()

  // G-3 (c): its value opens the steps past due, and "x จาก y ขั้น" under it every step it divides by, in the same period
  // — the past-due ones counted and first, each saying whether it is counted and why (§9.9: every number opens its list).
  // Back at the top of the page: a list with nothing in the period repeats the link in its empty state, to the same place
  await page.getByRole('link', { name: 'กลับไปหน้า KPI' }).first().click()
  const late = page.getByRole('link', { name: /^ดูรายการที่นับ: ขั้นที่เกินกำหนด \(SLA\) \d+\.\d% \(\d+ จาก \d+ ขั้น\)$/ })
  await expect(late).toHaveAttribute('href', `/kpi/g3c?from=${s.kpi.from}&to=${s.kpi.to}`)
  const steps = page.getByRole('link', { name: /^ดูทุกขั้นที่มอบในช่วงนี้: ขั้นที่เกินกำหนด \(SLA\) \d+ จาก \d+ ขั้น$/ })
  await expect(steps).toHaveAttribute('href', `/kpi/g3c-steps?from=${s.kpi.from}&to=${s.kpi.to}`)
  await expect(steps).toHaveText(/^\d+ จาก \d+ ขั้น$/)
  const total = Number(/จาก (\d+) ขั้น/.exec(await steps.innerText())![1])
  expect(total).toBeGreaterThanOrEqual(s.requests.length)
  await steps.click()
  await expect(page).toHaveURL(new RegExp(`/kpi/g3c-steps\\?from=${s.kpi.from}&to=${s.kpi.to}$`))
  await expect(page.getByRole('heading', { level: 1, name: 'ขั้นที่มอบในช่วงนี้' })).toBeVisible()
  await expect(page.getByText(new RegExp(`^นับ \\d+ จาก ${total} รายการ$`))).toBeVisible()
  const stepMarks = (await page.getByRole('list', { name: 'รายการที่นับในขั้นที่มอบในช่วงนี้' }).getByRole('listitem').allInnerTexts()).map((text) =>
    /ไม่นับ: /.test(text) ? 'not counted' : /นับ: /.test(text) ? 'counted' : 'unmarked',
  )
  expect(stepMarks).toHaveLength(Math.min(total, 200))
  expect(stepMarks).not.toContain('unmarked')
  // the counted ones come first
  expect(stepMarks.indexOf('not counted') === -1 || stepMarks.lastIndexOf('counted') < stepMarks.indexOf('not counted')).toBe(true)
  await checkScreen(page, testInfo, 'kpi-steps')
})

test('[FR-VIS-003/AC2] the KPI page is the organization’s: a department head is sent to the report of their departments, a requester is refused', async ({ page }, testInfo) => {
  // a scene of its own (a separate process through the services) and axe on several screens
  test.slow()
  const head = testInfo.project.name === 'mobile' ? 'dm_it' : 'dm_con'
  await signInAs(page, head)
  await page.goto('/kpi')
  await expect(page.getByText('หน้า KPI แสดงตัวเลขทั้งองค์กร หัวหน้าแผนกดูรายงาน KPI ของแผนกที่ตัวเองดูแลได้ที่หน้ารายงาน')).toBeVisible()
  await expect(page.getByRole('table')).toHaveCount(0)
  await checkScreen(page, testInfo, 'kpi-head')
  await page.getByRole('link', { name: 'ไปที่หน้ารายงาน' }).click()
  await expect(page.getByText('รายงานอ่านเฉพาะแผนกที่คุณดูแล')).toBeVisible()

  await page.context().clearCookies()
  await signInAs(page, testInfo.project.name === 'mobile' ? 'req_it' : 'req_con2', false)
  await page.goto('/kpi')
  await expect(page.getByText('หน้า KPI สำหรับผู้บริหาร ฝ่ายบัญชีและการเงิน ฝ่ายจัดซื้อ และผู้ตรวจสอบ', { exact: false })).toBeVisible()
})

test('[FR-VIS-003/AC3] the CSV of the 60-day review holds every measure with its value, numerator and denominator, and the file’s checksum', async ({ page }, testInfo) => {
  // a scene of its own (a separate process through the services) and axe on several screens
  test.slow()
  const s = scene<DecisionsScene>('decisions', testInfo.project.name)
  await signInAs(page, 'ceo')
  await page.goto('/kpi')
  await expect(page.getByRole('heading', { level: 2, name: 'ส่งออกสำหรับรอบรีวิว 60 วัน' })).toBeVisible()
  const bytes = await exportedFile(page, 'ส่งออก CSV')
  expect(sha256(bytes)).toBe(await shownChecksum(page))
  const [header, ...rows] = csvRows(bytes)
  // each measure in Thai as the page says it, its value, unit, numerator and denominator, and its code for machines
  expect(header).toEqual(['ตัวชี้วัด', 'สิ่งที่วัด', 'ค่า', 'หน่วย', 'ตัวตั้ง', 'ตัวหาร', 'รหัส'])
  expect(rows.map((r) => r[0])).toEqual(expect.arrayContaining(['G-1', 'G-2', 'G-3', 'G-4', 'G-5']))
  expect(rows.find((r) => r[6] === 'DECISIONS_ON_LINE_PURCHASE_REQUEST')).toEqual([
    'G-5',
    LINE_PR,
    percent(s.kpi.pr.numerator, s.kpi.pr.denominator),
    '%',
    String(s.kpi.pr.numerator),
    String(s.kpi.pr.denominator),
    'DECISIONS_ON_LINE_PURCHASE_REQUEST',
  ])
  expect(rows.find((r) => r[6] === 'DECISIONS_ON_LINE_ALL')).toEqual([
    'G-5',
    'การตัดสินใน LINE ทุกชนิดเอกสาร',
    percent(s.kpi.all.numerator, s.kpi.all.denominator),
    '%',
    String(s.kpi.all.numerator),
    String(s.kpi.all.denominator),
    'DECISIONS_ON_LINE_ALL',
  ])
  // times in business hours with one decimal, as on the page
  expect(rows.find((r) => r[6] === 'MEDIAN_DECISION_HOURS')!.slice(1, 4)).toEqual(['มัธยฐานเวลาตัดสินต่อขั้น', expect.stringMatching(/^\d+\.\d$/), 'ชั่วโมงทำการ'])
  await checkScreen(page, testInfo, 'kpi-exported')
})
