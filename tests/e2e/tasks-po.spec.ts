import { expect, test } from './fixtures'
import { budgetRegion, header, requestsRegion, scene, tagOf, type MadePo, topShot } from './procurement-support'
import { expectNoBlockingAxe, openAttachment, rowWith, signIn } from './tasks-support'

// Unit e, the decision page of purchase-order and variance tasks (spec §9.1 /tasks/[id], FR-DOA-004, FR-P2P-004,
// FR-P2P-007 AC2, §9.9 principle 5): a PO is approved, returned to procurement or rejected — never asked about — from
// one screen with its amounts, the budget it reserves, its lines and the requests it orders with their attachments; a
// receiving variance is approved or rejected — never returned — with its PO line, its amount, the budget the PO holds
// and the photos of the receipt. tests/e2e/procurement-scene.ts builds the PO waiting for the COO and the variances
// waiting for the DM of CON through the services; screenshots at 1440 and 375 px, axe on every screen.

type PendingScene = MadePo & { file: string }
type VarianceScene = MadePo & { varianceId: string; taskId: string; description: string; approver: string }
type DamagedScene = VarianceScene & { photo: string }

const inbox = (page: import('@playwright/test').Page) => page.getByRole('list', { name: 'งานรออนุมัติของคุณ' })
const approveButton = (page: import('@playwright/test').Page) => page.getByRole('button', { name: 'อนุมัติ', exact: true })

test('[FR-DOA-004/AC2] the COO decides a PO on one screen and returns it to procurement with a reason; a tab left open is told who decided and when', async ({ page, context }, testInfo) => {
  test.slow()
  const made = scene<PendingScene>('pending', tagOf(testInfo))
  await signIn(page, 'coo', true)
  await page.goto('/tasks')
  const row = rowWith(inbox(page), made.number)
  await expect(row).toContainText('บริษัท บริการทำความสะอาดทดสอบ จำกัด')
  await expect(row).toContainText('ส่งขออนุมัติโดย พิมพ์ใจ จัดหา')
  await expect(row).toContainText('1,070.00')
  await expectNoBlockingAxe(page)
  await topShot(page, testInfo, 'po-inbox', { whole: false })
  await row.getByRole('link').click()
  await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/)
  const taskUrl = page.url()

  // Everything to decide on one screen (§9.9 principle 5): amounts, the budget it reserves, the lines with their source
  // request, the request's attachment — which opens for the approver — and the DOA rule
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('บริษัท บริการทำความสะอาดทดสอบ จำกัด')
  await expect(page.getByRole('region', { name: 'ยอดเงิน' })).toContainText(/ยอดรวม VAT\s*1,070\.00/)
  await expect(budgetRegion(page)).toContainText('จองไว้แล้ว รอผู้อนุมัติตัดสิน')
  await expect(budgetRegion(page)).toContainText(/คำขอต้นทางจองไว้\s*1,000\.00/)
  await expect(page.getByRole('list', { name: 'รายการของใบสั่งซื้อ' })).toContainText(`จากคำขอ ${made.request.number} บรรทัด 1`)
  await expect(requestsRegion(page).getByRole('link', { name: new RegExp(`^${made.request.number} · `) })).toBeVisible()
  expect(await openAttachment(page, made.file)).toMatch(/X-Amz-Expires=\d+/)
  await expect(page.getByRole('region', { name: 'เส้นทางอนุมัติ' })).toContainText('DOA-DEMO ฉบับ 1 ข้อ PO-01')
  // A PO has no requester to answer: no question form
  await expect(page.getByRole('button', { name: 'ส่งคำถามถึงผู้ขอ' })).toHaveCount(0)
  await expect(page.getByRole('radio', { name: /ตีกลับให้จัดซื้อแก้ไข/ })).toBeChecked()
  await expectNoBlockingAxe(page)
  await topShot(page, testInfo, 'po-decision')

  const stale = await context.newPage()
  await stale.goto(taskUrl)
  await expect(approveButton(stale)).toBeVisible()

  await page.getByLabel('เหตุผล', { exact: true }).fill('ขอให้ต่อราคากับผู้ขายอีกครั้ง')
  await page.getByLabel('ฉันตรวจเหตุผลแล้ว และเข้าใจว่าเปลี่ยนการตัดสินภายหลังไม่ได้').check()
  await page.getByRole('button', { name: 'ตีกลับให้จัดซื้อแก้ไข' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'ตีกลับให้จัดซื้อแก้ไขแล้ว' })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'ตีกลับให้แก้ไขโดย ชัยวัฒน์ ปฏิบัติการใหญ่ เมื่อ' })).toContainText('เหตุผล: ขอให้ต่อราคากับผู้ขายอีกครั้ง')
  const stamp = page.getByRole('list', { name: 'ไทม์ไลน์ของใบสั่งซื้อ' }).getByRole('listitem').filter({ hasText: 'ขอให้ต่อราคากับผู้ขายอีกครั้ง' })
  await expect(stamp).toContainText('DOA-DEMO ฉบับ 1 ข้อ PO-01')
  await expectNoBlockingAxe(page)
  await topShot(page, testInfo, 'po-returned', { whole: false })

  // FR-DOA-004 AC2: the tab left open says who decided it and when
  await approveButton(stale).click()
  await stale.getByRole('button', { name: 'ยืนยันอนุมัติ' }).click()
  await expect(stale.getByRole('alert').filter({ hasText: 'ดำเนินการแล้วโดย ชัยวัฒน์ ปฏิบัติการใหญ่ เมื่อ' })).toBeVisible()
  await stale.close()

  // The PO opens for its approver: a draft again, with its number and the reason; the delta went back
  await page.getByRole('link', { name: `เปิดหน้าใบสั่งซื้อ ${made.number}` }).click()
  await expect(header(page)).toContainText('ร่าง')
  await expect(header(page)).toContainText('ผู้อนุมัติตีกลับให้แก้ไข')
  await expect(page.getByText('คุณดูใบสั่งซื้อนี้ได้อย่างเดียว การแก้ไข ส่ง และยกเลิกเป็นงานของฝ่ายจัดซื้อ')).toBeVisible()
  await expect(budgetRegion(page)).toContainText('คำขอต้นทางจองไว้ PO ยังไม่ได้จองเพิ่ม')
})

test('[FR-P2P-007/AC2] the DM of CON decides a shortfall from the PO line, what was ordered and received, and its amount; no return', async ({ page }, testInfo) => {
  test.slow()
  const made = scene<VarianceScene>('variance', tagOf(testInfo))
  const desktop = testInfo.project.name !== 'mobile'
  await signIn(page, 'dm_con', true)
  await page.goto('/tasks')
  const row = rowWith(inbox(page), made.description)
  await expect(row).toContainText(`ขาดส่ง · ${made.description}`)
  await expect(row).toContainText(`จาก ${made.number}`)
  await expect(row).toContainText('400.00')
  await row.getByRole('link').click()
  await expect(page).toHaveURL(new RegExp(`/tasks/${made.taskId}$`))

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`ขาดส่ง: ${made.description}`)
  await expect(page.getByText(`ผลต่างจากการตรวจรับ · ${made.number}`)).toBeVisible()
  const facts = page.getByRole('region', { name: 'ผลต่างที่ขออนุมัติ' })
  await expect(facts).toContainText(/สั่ง\s*10 ชิ้น/)
  await expect(facts).toContainText(/รับแล้ว\s*6 ชิ้น/)
  await expect(facts).toContainText(/จำนวนที่ต่าง\s*4 ชิ้น/)
  await expect(facts).toContainText('ผู้ขายแจ้งว่าไม่มีของส่วนที่เหลือ')
  await expect(facts).toContainText('ปิดส่วนที่ขาด ไม่รอของอีก')
  const amounts = page.getByRole('region', { name: 'มูลค่าของผลต่าง' })
  await expect(amounts).toContainText(/ราคาต่อหน่วยใน PO\s*100\.00/)
  await expect(amounts).toContainText(/ก่อน VAT\s*400\.00/)
  await expect(amounts).toContainText(/VAT 7%\s*28\.00/)
  await expect(amounts).toContainText(/รวม VAT\s*428\.00/)
  // Which amount the route used, from the DOA version's basis
  await expect(amounts).toContainText('เส้นทางอนุมัติใช้มูลค่ารวม VAT ตามอัตราของ PO')
  // The budget the PO holds for the line, and what approving gives back (BR-GR-04)
  await expect(budgetRegion(page)).toContainText(/PO ถือไว้สำหรับรายการนี้\s*1,000\.00/)
  await expect(budgetRegion(page)).toContainText('PO คืนงบที่ถือไว้ของส่วนที่ขาดให้บรรทัดงบ ไม่เกิน 400.00 บาท')
  await expect(page.getByRole('region', { name: 'รูปถ่ายและเอกสารจากการตรวจรับ' })).toContainText('ไม่มีใบตรวจรับ จึงไม่มีรูปถ่าย เพราะเป็นการขอปิดส่วนที่ขาด')
  await expect(page.getByRole('region', { name: 'เส้นทางอนุมัติ' })).toContainText('DOA-DEMO ฉบับ 1 ข้อ GRV-01')
  // A variance is approved or rejected: no return, no question
  await expect(page.getByRole('radio')).toHaveCount(0)
  await expect(page.getByText('ผลต่างอนุมัติหรือไม่อนุมัติเท่านั้น ไม่มีการตีกลับ')).toBeVisible()
  await expect(page.getByRole('button', { name: 'ส่งคำถามถึงผู้ขอ' })).toHaveCount(0)
  await expectNoBlockingAxe(page)
  await topShot(page, testInfo, 'variance-decision')

  if (desktop) {
    await approveButton(page).click()
    await expect(page.getByText(`อนุมัติผลต่าง ${made.number} · ${made.description} มูลค่า 400.00 บาท (ก่อน VAT)`)).toBeVisible()
    await page.getByRole('button', { name: 'ยืนยันอนุมัติ' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'อนุมัติแล้วโดย ดำรง ก่อสร้างไทย เมื่อ' })).toBeVisible()
    await expect(page.getByRole('list', { name: 'ไทม์ไลน์ของผลต่าง' }).getByRole('listitem').filter({ hasText: 'DOA-DEMO ฉบับ 1 ข้อ GRV-01' })).toContainText('ดำรง ก่อสร้างไทย')
  } else {
    await page.getByRole('button', { name: 'ไม่อนุมัติผลต่างนี้' }).click()
    await expect(page.getByText('ใส่เหตุผลอย่างน้อย 3 ตัวอักษร เพื่อให้ผู้บันทึกผลต่างรู้ว่าทำไมไม่อนุมัติ')).toBeVisible()
    await page.getByLabel('เหตุผล', { exact: true }).fill('ให้ผู้ขายส่งของส่วนที่เหลือตามสัญญา')
    await page.getByLabel('ฉันตรวจเหตุผลแล้ว และเข้าใจว่าเปลี่ยนการตัดสินภายหลังไม่ได้').check()
    await page.getByRole('button', { name: 'ไม่อนุมัติผลต่างนี้' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'ไม่อนุมัติผลต่างนี้แล้ว' })).toBeVisible()
    await expect(page.getByRole('status').filter({ hasText: 'ไม่อนุมัติโดย ดำรง ก่อสร้างไทย เมื่อ' })).toContainText('เหตุผล: ให้ผู้ขายส่งของส่วนที่เหลือตามสัญญา')
  }
  await expectNoBlockingAxe(page)
  await topShot(page, testInfo, 'variance-decided', { whole: false })
})

test('[FR-P2P-007/AC2] the DM of CON decides damaged goods kept from the photo of the receipt and the budget the PO holds', async ({ page }, testInfo) => {
  test.slow()
  const made = scene<DamagedScene>('damaged', tagOf(testInfo))
  await signIn(page, 'dm_con', true)
  await page.goto(`/tasks/${made.taskId}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`ของเสียหาย: ${made.description}`)
  await expect(page.getByRole('region', { name: 'ผลต่างที่ขออนุมัติ' })).toContainText('รับของที่เสียหายไว้')
  await expect(page.getByRole('region', { name: 'มูลค่าของผลต่าง' })).toContainText(/ก่อน VAT\s*200\.00/)
  // BR-GR-05: the photo of the damaged goods is the evidence the approver decides on, and it opens for them
  const photos = page.getByRole('region', { name: 'รูปถ่ายและเอกสารจากการตรวจรับ' })
  await expect(photos).toContainText(made.photo)
  await expect(photos).toContainText('รูปถ่าย')
  expect(await openAttachment(page, made.photo)).toMatch(/X-Amz-Expires=\d+/)
  await expect(budgetRegion(page)).toContainText('งบไม่เปลี่ยน ของที่เสียหายนับเป็นของที่รับไว้ตามราคาใน PO')
  await expect(budgetRegion(page)).toContainText(/PO ถือไว้สำหรับรายการนี้\s*1,000\.00/)
  await expect(page.getByRole('region', { name: 'เส้นทางอนุมัติ' })).toContainText('DOA-DEMO ฉบับ 1 ข้อ GRV-01')
  await expectNoBlockingAxe(page)
  await topShot(page, testInfo, 'variance-damaged')

  await approveButton(page).click()
  await page.getByRole('button', { name: 'ยืนยันอนุมัติ' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'อนุมัติแล้วโดย ดำรง ก่อสร้างไทย เมื่อ' })).toBeVisible()
})
