import { expect, test } from './fixtures'
import {
  actions,
  budgetRegion,
  chooseSupplier,
  consolidateNow,
  expectPdfLink,
  expectPoMail,
  header,
  poNumberOf,
  poTimeline,
  poolGroup,
  poolList,
  requestsRegion,
  S1,
  S2,
  scene,
  tagOf,
  type Made,
  topShot,
} from './procurement-support'
import { expectNoBlockingAxe, rowWith, signIn } from './tasks-support'

// Unit e, the procurement pool (S4-03 · spec §9.1 /procurement/pool, FR-P2P-001, FR-P2P-002) and demo scene 7
// (Demo_Script: จัดซื้อรวม PR เป็น PO). tests/e2e/procurement-scene.ts makes the approved requests through the
// services; procurement (proc_officer) works the pool in the browser. Screenshots at 1440 and 375 px go to the test
// output (§9.9 step 4); axe runs on every screen (§9.9 step 5). These scenes cross several pages and two members, so
// they get more time than a single screen (a loaded machine stretches every step). A request whose prices include VAT
// stays in the pool until NEW-50 is decided, so a round may leave lines for that reason too.

type PoolScene = { a: Made; b: Made; c: Made }
type DemoScene = { scene1: Made; h11: Made; budgetLine: string }

const VAT_REASON = 'ราคารวม VAT: คำขอนี้ยังรวมเป็นร่าง PO ไม่ได้ รอการตัดสินใจเรื่องการแปลงราคารวม VAT เป็นราคาในใบสั่งซื้อ'

test('[FR-P2P-001/AC1] [FR-P2P-001/AC2] [FR-P2P-001/AC3] [FR-P2P-002/AC2] [FR-P2P-002/AC3] procurement filters the pool, chooses a supplier for several lines at once and makes draft POs now', async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  const made = scene<PoolScene>('pool', tagOf(testInfo))
  await signIn(page, 'proc_officer', true)
  await page.goto('/procurement/pool')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('กองรอจัดซื้อ')

  // AC1 and AC3: the approved lines grouped by request, each needing a supplier, with what the requester suggests
  const a = poolGroup(page, made.a.number)
  await expect(a).toContainText('ไซต์งานตัวอย่าง A')
  await expect(a).toContainText('ผู้ขอแนะนำผู้ขาย บริษัท วัสดุก่อสร้างทดสอบ จำกัด')
  await expect(a).toContainText('อนุมัติวันนี้')
  await expect(a.getByText('ต้องเลือกผู้ขาย')).toHaveCount(2)
  await expect(a).toContainText('3,000.00')
  await expect(poolGroup(page, made.c.number)).toContainText('ด่วน')
  await expect(page.getByText(/รอบอัตโนมัติถัดไป \d{1,2} \S+ 25\d\d \d\d:\d\d น\./)).toBeVisible()
  await expectNoBlockingAxe(page)
  await topShot(page, testInfo, 'pool')

  // AC1: by delivery site, urgency, the lines that still need a supplier, and age
  await page.getByLabel('สถานที่ส่ง').selectOption({ label: 'ไซต์งานตัวอย่าง B' })
  await page.getByRole('button', { name: 'กรองรายการ' }).click()
  await expect(page).toHaveURL(/site=/)
  await expect(poolGroup(page, made.b.number)).toBeVisible()
  await expect(poolList(page)).not.toContainText(made.a.number)
  await page.getByLabel('สถานที่ส่ง').selectOption({ label: 'ทุกสถานที่ส่ง' })
  await page.getByLabel('ความด่วน').selectOption({ label: 'ด่วน' })
  await page.getByRole('button', { name: 'กรองรายการ' }).click()
  await expect(poolGroup(page, made.c.number)).toBeVisible()
  await expect(poolList(page)).not.toContainText(made.b.number)
  await page.getByLabel('ความด่วน').selectOption({ label: 'ทุกความด่วน' })
  await page.getByLabel('ผู้ขาย', { exact: true }).selectOption({ label: 'ต้องเลือกผู้ขาย' })
  await page.getByLabel('อายุนับจากอนุมัติ').selectOption({ label: 'ตั้งแต่ 1 วันขึ้นไป' })
  await page.getByRole('button', { name: 'กรองรายการ' }).click()
  // Approved today: none of them is a day old yet
  await expect(page.getByText(made.a.number)).toHaveCount(0)
  await topShot(page, testInfo, 'pool-filtered', { whole: false })
  await page.getByRole('link', { name: 'ล้างตัวกรอง' }).first().click()
  await expect(poolGroup(page, made.a.number)).toBeVisible()

  // AC2: one supplier for the lines of two requests at once — another than the one suggested (the demo scene uses S1)
  await chooseSupplier(page, [made.a.number, made.b.number], S2, 3)
  await expect(a.getByText('ต้องเลือกผู้ขาย')).toHaveCount(0)
  await expect(a.getByText('ผู้ขาย บริษัท ไอทีทดสอบ จำกัด', { exact: true })).toHaveCount(2)
  await expectNoBlockingAxe(page)
  await topShot(page, testInfo, 'pool-assigned', { whole: false })

  // BR-CONS-02: the urgent request is drafted as soon as it has its supplier — and a draft cannot be thrown away yet,
  // so the choice asks a second time first
  await page.getByRole('checkbox', { name: `เลือกทุกบรรทัดของ ${made.c.number}` }).check()
  await page.getByLabel('ผู้ขายสำหรับบรรทัดที่เลือก').selectOption({ label: S2 })
  await page.getByRole('button', { name: 'ใช้ผู้ขายนี้กับบรรทัดที่เลือก' }).click()
  await expect(page.getByText(`บรรทัดที่เลือกมีคำขอด่วน 1 ใบ เลือก ${S2} แล้วระบบจะร่าง PO ของคำขอด่วนทันที`)).toBeVisible()
  await expect(poolGroup(page, made.c.number)).toBeVisible()
  // The bar that asks, at both widths (on a phone it sits below the filters)
  await page.getByRole('region', { name: 'เลือกผู้ขายให้บรรทัดที่เลือก' }).screenshot({ path: testInfo.outputPath('pool-urgent-confirm.png') })
  await page.getByRole('button', { name: 'ยืนยันใช้ผู้ขายนี้และร่าง PO ทันที' }).click()
  const urgent = page.getByRole('status').filter({ hasText: 'คำขอด่วนได้ร่าง PO ทันที 1 ใบ' })
  await expect(urgent).toBeVisible()
  await expect(urgent.getByRole('link', { name: 'เปิดร่าง PO ของ บริษัท ไอทีทดสอบ จำกัด · คลังสำนักงานใหญ่ · สินค้า' })).toBeVisible()
  await expect(poolList(page)).not.toContainText(made.c.number)

  // FR-P2P-002 AC3: "รวมเป็นร่าง PO ตอนนี้" — asked a second time — one draft per site (BR-CONS-01), and what stays in
  // the pool and why; the notice of the supplier choice gives way to the round's
  await consolidateNow(page, { testInfo, name: 'pool-round-confirm' })
  const result = page.getByRole('status').filter({ hasText: /รวมแล้ว ได้ร่าง PO \d+ ใบ/ })
  await expect(result).toBeVisible()
  await expect(urgent).toHaveCount(0)
  const draftA = result.getByRole('listitem').filter({ hasText: made.a.number })
  await expect(draftA.getByRole('link')).toHaveText('เปิดร่าง PO ของ บริษัท ไอทีทดสอบ จำกัด · ไซต์งานตัวอย่าง A · สินค้า')
  await expect(draftA).toContainText('2 บรรทัด')
  await expect(draftA).toContainText(/ยอดก่อน VAT\s*4,000\.00 บาท/)
  await expect(result.getByRole('listitem').filter({ hasText: made.b.number }).getByRole('link')).toHaveText('เปิดร่าง PO ของ บริษัท ไอทีทดสอบ จำกัด · ไซต์งานตัวอย่าง B · สินค้า')
  await expect(result).toContainText(/เหลือในกอง \d+ บรรทัด เพราะ(ยังไม่ได้เลือกผู้ขาย|มาจากคำขอที่ราคารวม VAT)|ไม่มีบรรทัดค้างในกอง/)
  await expect(poolGroup(page, made.a.number)).toHaveCount(0)
  // FR-P2P-002 AC2: the round is kept, with who ran it and the drafts it made
  const rounds = page.getByRole('list', { name: 'รอบรวมคำขอที่ผ่านมา' })
  await expect(rounds.getByRole('listitem').first()).toContainText('รวมตอนนี้โดย พิมพ์ใจ จัดหา')
  await expectNoBlockingAxe(page)
  await topShot(page, testInfo, 'pool-consolidated')

  // The draft of the first request opens with its lines and their source request
  await draftA.getByRole('link').click()
  await expect(page).toHaveURL(/\/procurement\/pos\/[0-9a-f-]{36}$/)
  await expect(header(page)).toContainText('ร่าง PO ยังไม่มีเลขที่')
  await expect(page.getByRole('list', { name: 'รายการของใบสั่งซื้อ' })).toContainText(`จากคำขอ ${made.a.number} บรรทัด 1`)
})

test('@demo [FR-P2P-001/AC2] [FR-P2P-002/AC3] [FR-P2P-004/AC1] [FR-P2P-005/AC1] demo scene 7: the request of scene 1 and H11 become one PO, the COO approves it under PO-01 and it goes to the supplier by e-mail with its PDF', async ({ page, browser }, testInfo) => {
  test.setTimeout(240_000)
  const made = scene<DemoScene>('demo', tagOf(testInfo))
  await signIn(page, 'proc_officer', true)
  await page.goto('/procurement/pool')
  for (const r of [made.scene1, made.h11]) {
    const group = poolGroup(page, r.number)
    await expect(group).toContainText('ไซต์งานตัวอย่าง A')
    await expect(group).toContainText('ผู้ขอแนะนำผู้ขาย บริษัท วัสดุก่อสร้างทดสอบ จำกัด')
    await expect(group.getByText('ต้องเลือกผู้ขาย').first()).toBeVisible()
  }
  await chooseSupplier(page, [made.scene1.number, made.h11.number], S1, 3)
  await consolidateNow(page)
  const draft = page.getByRole('status').filter({ hasText: /รวมแล้ว/ }).getByRole('listitem').filter({ hasText: made.scene1.number }).filter({ hasText: made.h11.number })
  await expect(draft).toContainText(/ยอดก่อน VAT\s*54,000\.00 บาท/)
  // The pool reloads after the round: both requests left it
  await expect(poolGroup(page, made.scene1.number)).toHaveCount(0)
  await expect(poolGroup(page, made.h11.number)).toHaveCount(0)
  await topShot(page, testInfo, 'demo-pool', { whole: false })
  await draft.getByRole('link').click()
  await expect(page).toHaveURL(/\/procurement\/pos\/[0-9a-f-]{36}$/)

  // One PO for both requests; the totals come from the server (FR-P2P-003 AC3)
  const amounts = page.getByRole('region', { name: 'ยอดเงิน' })
  await expect(amounts).toContainText(/ยอดก่อน VAT\s*54,000\.00/)
  await expect(amounts).toContainText(/VAT 7%\s*3,780\.00/)
  await expect(amounts).toContainText(/ยอดรวม VAT\s*57,780\.00/)
  // The budget it charges: what the two requests reserve for it, not what is left on the line (§9.9 principle 5)
  await expect(budgetRegion(page)).toContainText(made.budgetLine)
  await expect(budgetRegion(page)).toContainText(/คำขอต้นทางจองไว้\s*54,000\.00/)
  await expect(budgetRegion(page)).toContainText('คำขอต้นทางจองไว้ PO ยังไม่ได้จองเพิ่ม')
  const lines = page.getByRole('list', { name: 'รายการของใบสั่งซื้อ' })
  await expect(lines).toContainText(`จากคำขอ ${made.scene1.number} บรรทัด 1`)
  await expect(lines).toContainText(`จากคำขอ ${made.scene1.number} บรรทัด 2`)
  await expect(lines).toContainText(`จากคำขอ ${made.h11.number} บรรทัด 1`)
  await expect(lines).toContainText('ราคาที่เคยซื้อรายการนี้')
  await expect(requestsRegion(page).getByRole('link', { name: `${made.h11.number} · อุปกรณ์ความปลอดภัย PPE` })).toBeVisible()
  // Made by whoever ran the round; nobody has sent it for approval yet
  await expect(page.getByRole('region', { name: 'รายละเอียดใบสั่งซื้อ' })).toContainText(/สร้างโดย\s*พิมพ์ใจ จัดหา/)
  await expect(page.getByRole('region', { name: 'รายละเอียดใบสั่งซื้อ' })).not.toContainText('ส่งขออนุมัติโดย')
  // Before sending: the route the DOA expects (§9.9 principle 3)
  await expect(actions(page)).toContainText('ขั้นที่ 1: ชัยวัฒน์ ปฏิบัติการใหญ่')
  await expect(actions(page)).toContainText('DOA-DEMO ฉบับ 1 ข้อ PO-01')
  await expectNoBlockingAxe(page)
  await topShot(page, testInfo, 'demo-po-draft')
  await actions(page).getByRole('button', { name: 'ส่งขออนุมัติ' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'ส่งขออนุมัติแล้ว' })).toBeVisible()
  await expect(header(page)).toContainText('รออนุมัติ')
  await expect(header(page)).toContainText('รอ ชัยวัฒน์ ปฏิบัติการใหญ่')
  const number = await poNumberOf(page)
  await expect(page.getByRole('region', { name: 'เส้นทางอนุมัติ' })).toContainText('DOA-DEMO ฉบับ 1 ข้อ PO-01')
  await expect(page.getByRole('region', { name: 'รายละเอียดใบสั่งซื้อ' })).toContainText(/ส่งขออนุมัติโดย\s*พิมพ์ใจ จัดหา/)
  await topShot(page, testInfo, 'demo-po-pending', { whole: false })

  // The COO approves it from the inbox (rule PO-01)
  const cooContext = await browser.newContext()
  const coo = await cooContext.newPage()
  await signIn(coo, 'coo', true)
  await coo.goto('/tasks')
  const row = rowWith(coo.getByRole('list', { name: 'งานรออนุมัติของคุณ' }), number)
  await expect(row).toContainText('57,780.00')
  await expect(row).toContainText('บริษัท วัสดุก่อสร้างทดสอบ จำกัด')
  await row.getByRole('link').click()
  await expect(coo.getByRole('heading', { level: 1 })).toHaveText('บริษัท วัสดุก่อสร้างทดสอบ จำกัด')
  await expect(coo.getByText(`ใบสั่งซื้อ ${number}`, { exact: true })).toBeVisible()
  await expect(coo.getByRole('region', { name: 'เส้นทางอนุมัติ' })).toContainText('DOA-DEMO ฉบับ 1 ข้อ PO-01')
  await expect(coo.getByRole('list', { name: 'รายการของใบสั่งซื้อ' })).toContainText(made.h11.number)
  // On one screen: the budget the PO reserves and the requests it orders with their attachments (§9.9 principle 5)
  await expect(budgetRegion(coo)).toContainText('จองไว้แล้ว รอผู้อนุมัติตัดสิน')
  await expect(requestsRegion(coo)).toContainText(made.scene1.number)
  // The supplier's address is a full-register field: not for the COO, who sees the register's basic fields
  await expect(coo.getByText('s1@supplier.demo.local')).toHaveCount(0)
  await expect(coo.getByRole('button', { name: 'ส่งคำถามถึงผู้ขอ' })).toHaveCount(0)
  await expectNoBlockingAxe(coo)
  await topShot(coo, testInfo, 'demo-po-task')
  await coo.getByRole('button', { name: 'อนุมัติ', exact: true }).click()
  await expect(coo.getByText(`อนุมัติ ${number} ยอดรวม VAT 57,780.00 บาท`)).toBeVisible()
  await coo.getByRole('button', { name: 'ยืนยันอนุมัติ' }).click()
  await expect(coo.getByRole('status').filter({ hasText: 'อนุมัติแล้วโดย ชัยวัฒน์ ปฏิบัติการใหญ่ เมื่อ' })).toBeVisible()
  await expect(coo.getByRole('list', { name: 'ไทม์ไลน์ของใบสั่งซื้อ' }).getByRole('listitem').filter({ hasText: 'DOA-DEMO ฉบับ 1 ข้อ PO-01' })).toContainText('ชัยวัฒน์ ปฏิบัติการใหญ่')
  await topShot(coo, testInfo, 'demo-po-approved', { whole: false })
  await cooContext.close()

  // Procurement sends it to the supplier: the e-mail carries the PDF; the page says when and to whom (FR-P2P-005 AC1)
  await page.reload()
  await expect(header(page)).toContainText('อนุมัติแล้ว')
  await expect(header(page)).toContainText('รอจัดซื้อส่ง PO ให้ผู้ขาย')
  await expect(budgetRegion(page)).toContainText(/PO ถือไว้\s*54,000\.00/)
  const send = page.getByRole('region', { name: 'ส่ง PO ให้ผู้ขาย' })
  await expect(send).toContainText('s1@supplier.demo.local')
  const before = Date.now()
  await send.getByRole('button', { name: 'ส่ง PO ให้ผู้ขาย' }).click()
  await expect(page.getByText(`ส่ง ${number} ทางอีเมลถึง s1@supplier.demo.local ส่งแล้วเรียกคืนไม่ได้`)).toBeVisible()
  await topShot(page, testInfo, 'demo-po-send-confirm', { whole: false })
  await page.getByRole('button', { name: 'ยืนยันส่ง PO' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'ส่ง PO ให้ผู้ขายแล้ว' })).toBeVisible()
  await expect(header(page)).toContainText('ส่งผู้ขายแล้ว')
  await expect(header(page)).toContainText('ส่งถึง s1@supplier.demo.local เมื่อ')
  await expect(poTimeline(page)).toContainText('ส่ง PO ให้ผู้ขาย')
  await expectPoMail('s1@supplier.demo.local', number, before)
  await expectPdfLink(page, page.getByRole('link', { name: `เปิด PDF ของ ${number}` }))
  await expectNoBlockingAxe(page)
  await topShot(page, testInfo, 'demo-po-sent')
})

test('[FR-P2P-001/AC1] [FR-P2P-001/AC3] [FR-P2P-002/AC1] [FR-P2P-002/AC3] a request whose prices include VAT waits in the pool at its own prices and says why; choosing its supplier and making drafts leave it there (NEW-50)', async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  const made = scene<Made>('vat', tagOf(testInfo))
  await signIn(page, 'proc_officer', true)
  await page.goto('/procurement/pool')
  const group = poolGroup(page, made.number)
  const panel = page.getByRole('region', { name: 'รวมเป็นร่าง PO', exact: true })

  // Why no round drafts it, in words beside an icon under its name; its prices as it states them, VAT included:
  // 3 × 100.00 = 300.00, the amount approved — nothing converted, nothing rounded
  await expect(group).toContainText(VAT_REASON)
  await expect(group).toContainText('ด่วน')
  await expect(group).toContainText('3 ถุง')
  await expect(group).toContainText('300.00')
  await expect(group.getByText('ต้องเลือกผู้ขาย')).toBeVisible()
  // Each figure says its VAT basis: in its label on a phone, in a note under the value on a wide screen, where the
  // column heading over the amounts names no basis while such a request is listed
  await expect(group.getByText('รวม VAT', { exact: true })).toHaveCount(2)
  if (testInfo.project.name === 'mobile') {
    await expect(group.getByText('ราคาต่อหน่วย (รวม VAT)', { exact: true })).toBeVisible()
    await expect(group.getByText('ยอดรวม VAT', { exact: true })).toBeVisible()
  } else {
    await expect(group.getByText('รวม VAT', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('ยอด', { exact: true })).toBeVisible()
  }
  // The round panel counts the lines that wait for the decision, and does not promise an urgent one a draft at once
  await expect(panel).toContainText(/\d+ บรรทัดในกองมาจากคำขอที่ราคารวม VAT จึงยังไม่ถูกรวมเป็นร่าง PO/)
  await expect(panel).toContainText('ส่วนคำขอที่ราคารวม VAT ยังไม่ถูกรวมเป็นร่าง PO แม้เป็นคำขอด่วน')
  await expectNoBlockingAxe(page)
  await topShot(page, testInfo, 'pool-vat')

  // Urgent, yet choosing its supplier asks nothing more (no draft is made at once) and the notice says why it stays
  await chooseSupplier(page, [made.number], S1, 1)
  const chosen = page.getByRole('status').filter({ hasText: `เลือกผู้ขาย ${S1} ให้ 1 บรรทัดแล้ว` })
  await expect(chosen).toContainText('1 บรรทัดที่เลือกมาจากคำขอที่ราคารวม VAT จึงยังรอในกองและยังไม่ถูกรวมเป็นร่าง PO')
  await expect(chosen).not.toContainText('คำขอด่วนได้ร่าง PO ทันที')
  await expect(group).toContainText('ผู้ขาย บริษัท วัสดุก่อสร้างทดสอบ จำกัด')
  await expect(group).toContainText(VAT_REASON)
  await expectNoBlockingAxe(page)
  await topShot(page, testInfo, 'pool-vat-chosen', { whole: false })

  // "รวมเป็นร่าง PO ตอนนี้" leaves it in the pool, and says why
  await consolidateNow(page)
  const result = page.getByRole('status').filter({ hasText: /รอบนี้ไม่มีบรรทัดที่พร้อมรวม|รวมแล้ว ได้ร่าง PO/ })
  await expect(result).toContainText(/เหลือในกอง \d+ บรรทัด เพราะมาจากคำขอที่ราคารวม VAT ซึ่งยังรวมเป็นร่าง PO ไม่ได้/)
  await expect(result).not.toContainText('ไม่มีบรรทัดค้างในกอง')
  await expect(group).toContainText(VAT_REASON)
  await expect(group).toContainText('ผู้ขาย บริษัท วัสดุก่อสร้างทดสอบ จำกัด')
  await expectNoBlockingAxe(page)
  await topShot(page, testInfo, 'pool-vat-round')

  // Its supplier comes off again, as the other scenes leave no line with a supplier behind them
  await page.getByRole('checkbox', { name: `เลือกทุกบรรทัดของ ${made.number}` }).check()
  await page.getByRole('button', { name: 'เอาผู้ขายออกจากบรรทัดที่เลือก' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'เอาผู้ขายออกจาก 1 บรรทัดแล้ว' })).toBeVisible()
  await expect(group.getByText('ต้องเลือกผู้ขาย')).toBeVisible()
})
