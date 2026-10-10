import type { Page } from '@playwright/test'
import { etaxXml, pdfWithEmbedded } from '../support/etax-files'
import { check, h1, scene, SCENE_TEST_TIMEOUT_MS, signIn, tagOf } from './finance-support'
import { expect, test } from './fixtures'

// Unit g, confirming invoices (S4-08, S4-17 · spec §9.1 /finance/invoices, FR-P2P-008, BR-IVC-01 to BR-IVC-05) and demo
// scene 13 (Demo_Script: อ่านใบกำกับ e-Tax). tests/e2e/finance-scene.ts makes the POs through the services — the PO of
// demo scene 7 received as in scene 8, POs received in full or closed — and FINANCE (fin_officer) records their
// invoices in the browser: from an e-Tax file the tests make themselves (tests/support/etax-files.ts) or typed. Every
// page state is checked with axe and for sideways scrolling, and photographed at 1440 px and 375 px (§9.9).

type Po = { poId: string; number: string; today: string }
type DemoPo = Po & { requests: string[]; budgetLine: string }

const field = (page: Page, label: string) => page.getByLabel(label, { exact: true })

async function typeInvoice(page: Page, values: { no: string; date: string; net: string; vat: string; final?: boolean }) {
  await field(page, 'เลขที่ใบกำกับ').fill(values.no)
  await field(page, 'วันที่ใบกำกับ').fill(values.date)
  await field(page, 'ยอดก่อน VAT (บาท)').fill(values.net)
  await field(page, 'VAT (บาท)').fill(values.vat)
  if (values.final) await page.getByLabel('ใบนี้เป็นใบกำกับใบสุดท้ายของใบสั่งซื้อนี้').check()
}

const review = (page: Page) => page.getByRole('button', { name: 'ตรวจสอบก่อนบันทึก' }).click()
const confirm = (page: Page) => page.getByRole('button', { name: 'ยืนยันบันทึกใบกำกับ' }).click()
const etaxInput = (page: Page) => page.getByLabel(/^เลือกไฟล์ e-Tax/)
const budgetOfPo = (page: Page) => page.getByRole('list', { name: 'งบของใบสั่งซื้อนี้' })

test('@demo [FR-P2P-008/AC4] [FR-P2P-008/AC2] demo scene 13: finance uploads the e-Tax file of the scene-7 PO, the form fills number, date, amount before VAT and VAT, and saving moves the budget to actual', async ({ page }, testInfo) => {
  // A scene through the services (requests, approvals, the PO e-mailed) comes first: longer than the default 30 s
  test.setTimeout(SCENE_TEST_TIMEOUT_MS)
  const tag = tagOf(testInfo)
  const s = scene<DemoPo>('demo', tag)
  await signIn(page, 'fin_officer', true)

  // The PO waits for its invoice: received in part (12 of 20 sheets and all the PPE), nothing invoiced yet
  await page.goto('/finance/invoices')
  await expect(h1(page)).toHaveText('ยืนยันใบกำกับ')
  const row = page.getByRole('list', { name: 'ใบสั่งซื้อรอใบกำกับ' }).getByRole('listitem').filter({ hasText: s.number })
  await expect(row).toContainText('บริษัท วัสดุก่อสร้างทดสอบ จำกัด (S1)')
  await expect(row).toContainText('รับบางส่วน')
  await expect(row).toContainText('54,000.00')
  await expect(row).toContainText('30,000.00')
  await check(page, testInfo, 'invoices-list')
  await row.getByRole('link', { name: `บันทึกใบกำกับ ${s.number}` }).click()
  await expect(h1(page)).toHaveText(`บันทึกใบกำกับ ${s.number}`)
  await expect(page.getByText('เลขผู้เสียภาษี 0-9999-99000-01-2 · สำนักงานใหญ่')).toBeVisible()
  await expect(page.getByText('ขั้น 1 จาก 2')).toBeVisible()
  await check(page, testInfo, 'invoice-enter')

  // The supplier's e-Tax Invoice by Email: a PDF/A-3 that carries its XML among other files, under a name that says nothing
  const invoiceNo = `IV${tag.toUpperCase()}`
  const pdf = pdfWithEmbedded([
    { name: 'logo.txt', content: 'not xml' },
    { name: 'attachment-1', content: etaxXml({ invoiceNo, issueDate: `${s.today}T00:00:00`, sellerRegistration: '099999900001200000', net: '30000.00', vat: '2100.00', gross: '32100.00' }) },
  ])
  await etaxInput(page).setInputFiles({ name: `${invoiceNo}.pdf`, mimeType: 'application/pdf', buffer: Buffer.from(pdf) })
  await expect(page.getByText(`อ่านไฟล์ ${invoiceNo}.pdf แล้ว`)).toBeVisible()
  await expect(page.getByText('ผู้ขายในไฟล์: เลขผู้เสียภาษี 0-9999-99000-01-2 สาขา 00000 ตรงกับผู้ขายของใบสั่งซื้อ')).toBeVisible()
  await expect(page.getByText('ยอดรวมในไฟล์ 32,100.00 บาท')).toBeVisible()
  await expect(field(page, 'เลขที่ใบกำกับ')).toHaveValue(invoiceNo)
  await expect(field(page, 'วันที่ใบกำกับ')).toHaveValue(s.today)
  await expect(field(page, 'ยอดก่อน VAT (บาท)')).toHaveValue('30,000.00')
  await expect(field(page, 'VAT (บาท)')).toHaveValue('2,100.00')
  await expect(page.getByText('32,100.00', { exact: true })).toBeVisible()
  await check(page, testInfo, 'invoice-etax-read')

  // Before anything is written: the VAT against the PO's rate, the share of each line, the budget that moves
  await review(page)
  await expect(page.getByRole('heading', { name: 'ตรวจสอบก่อนบันทึก' })).toBeVisible()
  await expect(page.getByText('VAT ตรงกับอัตรา 7% ของใบสั่งซื้อ (คำนวณได้ 2,100.00 บาท)')).toBeVisible()
  await expect(page.getByText(`อ่านจากไฟล์ ${invoiceNo}.pdf`)).toBeVisible()
  const parts = page.getByRole('list', { name: 'ปันยอดลงรายการในใบสั่งซื้อ' })
  await expect(parts.getByRole('listitem')).toHaveCount(3)
  await expect(parts.getByRole('listitem').filter({ hasText: 'ไม้อัด 4 มม.' })).toContainText('16,666.67')
  await expect(parts.getByRole('listitem').filter({ hasText: 'ตะปูตอกไม้ 2 นิ้ว' })).toContainText('6,666.67')
  await expect(parts.getByRole('listitem').filter({ hasText: 'หมวกนิรภัยและเสื้อสะท้อนแสง' })).toContainText('6,666.66')
  const moves = page.getByRole('list', { name: 'งบที่จะย้ายจากถือไว้เป็นจ่ายจริง' })
  await expect(moves.getByRole('listitem')).toHaveCount(1)
  await expect(moves).toContainText(s.budgetLine)
  await expect(moves).toContainText('30,000.00')
  await expect(page.getByText('ใบสั่งซื้อยังถือไว้ 54,000.00 บาท หลังบันทึกเหลือ 24,000.00 บาท')).toBeVisible()
  await check(page, testInfo, 'invoice-review')

  // Saved: the budget moved from committed to actual (AC2), and the PO's figures beside the form follow
  await confirm(page)
  await expect(page.getByText(`บันทึกใบกำกับ ${invoiceNo} แล้ว`)).toBeVisible()
  await expect(page.getByText(`ที่มาของข้อมูล: อ่านจากไฟล์ ${invoiceNo}.pdf`)).toBeVisible()
  const moved = page.getByRole('list', { name: 'งบที่ย้ายจากถือไว้เป็นจ่ายจริงแล้ว' })
  await expect(moved).toContainText(s.budgetLine)
  await expect(moved).toContainText('30,000.00')
  await expect(page.getByText('ใบสั่งซื้อยังถือไว้ 24,000.00 บาท รอใบกำกับใบถัดไป')).toBeVisible()
  const budget = budgetOfPo(page).getByRole('listitem').filter({ hasText: s.budgetLine })
  await expect(budget).toContainText(/ถือไว้\s*24,000\.00/)
  await expect(budget).toContainText(/จ่ายจริง\s*30,000\.00/)
  const recorded = page.getByRole('list', { name: 'ใบกำกับของใบสั่งซื้อนี้' }).getByRole('listitem').filter({ hasText: invoiceNo })
  await expect(recorded).toContainText('อ่านจากไฟล์ e-Tax')
  await expect(recorded).toContainText('ยังไม่ส่งออก Express')
  await expect(recorded).toContainText('32,100.00')
  await expect(recorded.getByRole('button', { name: `เปิดไฟล์ ${invoiceNo}.pdf` })).toBeVisible()
  await check(page, testInfo, 'invoice-done')

  // The list follows: invoiced and still held, and the invoice among those recorded
  await page.goto(`/finance/invoices?q=${s.number}`)
  const after = page.getByRole('list', { name: 'ใบสั่งซื้อรอใบกำกับ' }).getByRole('listitem').filter({ hasText: s.number })
  await expect(after).toContainText('บันทึกใบกำกับแล้ว 1 ใบ')
  await expect(after).toContainText('24,000.00')
  await expect(page.getByRole('list', { name: 'ใบกำกับที่บันทึกแล้ว' }).getByRole('listitem').filter({ hasText: invoiceNo })).toContainText(`ของ ${s.number}`)
  await check(page, testInfo, 'invoices-list-after')
})

test('[FR-P2P-008/AC4] an e-Tax file of another seller, a broken file or a scan: the reason in plain words, and the invoice is typed by hand', async ({ page }, testInfo) => {
  // A scene through the services (requests, approvals, the PO e-mailed) comes first: longer than the default 30 s
  test.setTimeout(SCENE_TEST_TIMEOUT_MS)
  const tag = tagOf(testInfo)
  const s = scene<Po>('sent', tag)
  await signIn(page, 'fin_officer', true)
  await page.goto(`/finance/invoices/${s.poId}`)
  await expect(h1(page)).toHaveText(`บันทึกใบกำกับ ${s.number}`)

  // A seller that is not the PO's supplier: nothing is filled and the file is not kept
  await etaxInput(page).setInputFiles({ name: 'other-seller.xml', mimeType: 'application/xml', buffer: Buffer.from(etaxXml({ invoiceNo: `OT${tag}`, sellerRegistration: '010555512345600000' })) })
  await expect(page.getByText('อ่านข้อมูลจากไฟล์ other-seller.xml ไม่ได้')).toBeVisible()
  await expect(page.getByText('เลขผู้เสียภาษีของผู้ขายในไฟล์ไม่ตรงกับผู้ขายของใบสั่งซื้อนี้ (บริษัท วัสดุก่อสร้างทดสอบ จำกัด เลขผู้เสียภาษี 0-9999-99000-01-2)')).toBeVisible()
  await expect(page.getByText('ไฟล์นี้จะไม่แนบกับใบกำกับ ตรวจว่าเลือกไฟล์ถูกใบ หรือกรอกข้อมูลจากใบกำกับเองด้านล่าง')).toBeVisible()
  await expect(field(page, 'เลขที่ใบกำกับ')).toHaveValue('')
  await check(page, testInfo, 'etax-other-seller')

  // A broken XML: the reason, and the file goes with the invoice typed by hand
  await etaxInput(page).setInputFiles({ name: 'broken.xml', mimeType: 'application/xml', buffer: Buffer.from(etaxXml().replace('</ram:ID>', '')) })
  await expect(page.getByText('ข้อมูล XML ในไฟล์เสียหรือไม่ครบ ระบบจึงอ่านค่าไม่ได้ ขอไฟล์ใหม่จากผู้ขายได้')).toBeVisible()
  await expect(page.getByText('กรอกข้อมูลจากใบกำกับเองด้านล่าง ไฟล์นี้จะแนบไว้กับใบกำกับ')).toBeVisible()
  await expect(page.getByText('ไฟล์ที่แนบ: broken.xml')).toBeVisible()
  await check(page, testInfo, 'etax-broken')

  // A scan: no electronic invoice in it
  await etaxInput(page).setInputFiles({ name: 'scan.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdfWithEmbedded([])) })
  await expect(page.getByText('ไม่พบใบกำกับภาษีอิเล็กทรอนิกส์ในไฟล์นี้ (อาจเป็นไฟล์สแกน หรือเป็นใบเพิ่มหนี้หรือใบลดหนี้)')).toBeVisible()
  // Not a PDF or an XML at all: refused by name, and the scan stays the invoice's file
  await etaxInput(page).setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) })
  const refused = page.getByRole('alert').filter({ hasText: 'อ่านไฟล์ photo.png ไม่ได้' })
  await expect(refused).toContainText('ไฟล์ e-Tax ต้องเป็นไฟล์ PDF หรือ XML')
  await check(page, testInfo, 'etax-refused')
  // Larger than the page sends (the host takes at most 4.5 MB in one request): refused in words before it is sent
  await etaxInput(page).setInputFiles({ name: 'big.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(4 * 1024 * 1024 + 1, 0x20) })
  await expect(page.getByRole('alert').filter({ hasText: 'อ่านไฟล์ big.pdf ไม่ได้' })).toContainText('ไฟล์ใหญ่เกิน 4 MB ระบบจึงไม่รับ')

  // Typed by hand, with the scan kept as the invoice's file
  await expect(page.getByText('ไฟล์ที่แนบ: scan.pdf')).toBeVisible()
  await review(page)
  await expect(page.getByText('ใส่เลขที่ใบกำกับตามที่พิมพ์บนใบกำกับ')).toBeVisible()
  await expect(page.getByText('เลือกวันที่ใบกำกับ')).toBeVisible()
  await typeInvoice(page, { no: `MN${tag}`, date: s.today, net: '5000', vat: '350' })
  await expect(page.getByText('5,350.00', { exact: true })).toBeVisible()
  await check(page, testInfo, 'etax-typed')
  await review(page)
  await expect(page.getByText('กรอกเอง แนบไฟล์ scan.pdf')).toBeVisible()
  await confirm(page)
  await expect(page.getByText(`บันทึกใบกำกับ MN${tag} แล้ว`)).toBeVisible()
  await expect(page.getByText('ที่มาของข้อมูล: กรอกเอง แนบไฟล์ scan.pdf')).toBeVisible()
  const recorded = page.getByRole('list', { name: 'ใบกำกับของใบสั่งซื้อนี้' }).getByRole('listitem').filter({ hasText: `MN${tag}` })
  await expect(recorded).toContainText('กรอกเอง')
  await expect(recorded.getByRole('button', { name: 'เปิดไฟล์ scan.pdf' })).toBeVisible()

  // The supplier's tax id at a branch other than the register's: the values fill, and the branch is pointed out
  await page.getByRole('button', { name: 'บันทึกใบกำกับใบถัดไปของใบสั่งซื้อนี้' }).click()
  const branchXml = etaxXml({ invoiceNo: `BR${tag}`, issueDate: `${s.today}T00:00:00`, sellerRegistration: '099999900001200001', net: '1000.00', vat: '70.00', gross: '1070.00' })
  await etaxInput(page).setInputFiles({ name: 'branch.xml', mimeType: 'application/xml', buffer: Buffer.from(branchXml) })
  await expect(page.getByText('แต่เป็นสาขา 00001 ซึ่งต่างจากสาขาในทะเบียนผู้ขาย (00000) ตรวจว่าใบกำกับออกโดยสาขาที่ถูกต้อง')).toBeVisible()
  await expect(field(page, 'เลขที่ใบกำกับ')).toHaveValue(`BR${tag}`)
  await expect(field(page, 'ยอดก่อน VAT (บาท)')).toHaveValue('1,000.00')
  await check(page, testInfo, 'etax-other-branch')
})

test('[FR-P2P-008/AC1] [FR-P2P-008/AC3] typed invoices: the VAT warning, a number used twice, more than the PO holds, then the last invoice lets the PO close and give back the rest', async ({ page }, testInfo) => {
  // A scene through the services (requests, approvals, the PO e-mailed) comes first: longer than the default 30 s
  test.setTimeout(SCENE_TEST_TIMEOUT_MS)
  const tag = tagOf(testInfo)
  const s = scene<Po>('received', tag)
  await signIn(page, 'fin_officer', true)
  await page.goto(`/finance/invoices/${s.poId}`)
  await expect(page.getByText('รับครบ', { exact: true })).toBeVisible()

  // BR-IVC-01: a VAT more than 1.00 baht from the PO's 7 % is a warning, never a refusal
  const first = `A-${tag}`
  await typeInvoice(page, { no: first, date: s.today, net: '4,000.00', vat: '300.00' })
  await review(page)
  await expect(page.getByText('VAT ในใบกำกับ 300.00 บาท ต่างจาก VAT ที่คำนวณจากอัตรา 7% ของใบสั่งซื้อ (280.00 บาท) เกิน 1.00 บาท ตรวจใบกำกับอีกครั้ง ถ้าถูกต้องบันทึกได้')).toBeVisible()
  await check(page, testInfo, 'invoice-vat-warning')
  await page.getByRole('button', { name: 'กลับไปแก้ข้อมูล' }).click()
  await field(page, 'VAT (บาท)').fill('280.00')
  await review(page)
  await expect(page.getByText('VAT ตรงกับอัตรา 7% ของใบสั่งซื้อ (คำนวณได้ 280.00 บาท)')).toBeVisible()
  await confirm(page)
  await expect(page.getByText(`บันทึกใบกำกับ ${first} แล้ว`)).toBeVisible()
  await expect(page.getByText('ใบสั่งซื้อยังถือไว้ 6,000.00 บาท รอใบกำกับใบถัดไป')).toBeVisible()
  await page.getByRole('button', { name: 'บันทึกใบกำกับใบถัดไปของใบสั่งซื้อนี้' }).click()

  // BR-IVC-03: the same number written another way; BR-IVC-02: more than the PO still holds — said under the field
  await typeInvoice(page, { no: ` ${first.toLowerCase()} `, date: s.today, net: '1,000.00', vat: '70.00' })
  await review(page)
  await expect(page.getByText(`ผู้ขายรายนี้มีใบกำกับเลขที่ ${first.toUpperCase()} ในระบบแล้ว`)).toBeVisible()
  await expect(field(page, 'เลขที่ใบกำกับ')).toHaveAttribute('aria-invalid', 'true')
  await check(page, testInfo, 'invoice-duplicate')
  await typeInvoice(page, { no: `B-${tag}`, date: s.today, net: '7,000.00', vat: '490.00' })
  await review(page)
  await expect(page.getByText('ยอดก่อน VAT เกินยอดที่ใบสั่งซื้อนี้ยังถือไว้ (6,000.00 บาท) บันทึกได้ไม่เกินยอดนี้')).toBeVisible()
  await check(page, testInfo, 'invoice-exceeds')

  // AC3: the last invoice — ready to close, and what is still held goes back when procurement closes the PO
  const last = `C-${tag}`
  await typeInvoice(page, { no: last, date: s.today, net: '5,500.00', vat: '385.00', final: true })
  await review(page)
  await expect(page.getByText('ใบนี้เป็นใบสุดท้าย ใบสั่งซื้อพร้อมปิด เมื่อฝ่ายจัดซื้อปิดใบสั่งซื้อ งบที่ยังถือไว้ 500.00 บาทจะคืนเป็นงบคงเหลือทั้งหมด')).toBeVisible()
  await check(page, testInfo, 'invoice-final-review')
  await confirm(page)
  await expect(page.getByText(`บันทึกใบกำกับ ${last} แล้ว`)).toBeVisible()
  await expect(page.getByRole('button', { name: 'บันทึกใบกำกับใบถัดไปของใบสั่งซื้อนี้' })).toHaveCount(0)
  await expect(page.getByText('บันทึกใบกำกับใบสุดท้ายของใบสั่งซื้อนี้แล้ว จึงไม่รับใบเพิ่ม')).toBeVisible()
  await check(page, testInfo, 'invoice-final-done')

  // Procurement closes the PO: nothing is held any more, and the page says the PO is settled
  scene('close', s.poId)
  await page.reload()
  await expect(page.getByText('ปิดแล้ว', { exact: true })).toBeVisible()
  await expect(page.getByText(/ใบสั่งซื้อนี้ปิดเมื่อ .+ และบันทึกใบกำกับใบสุดท้ายแล้ว/)).toBeVisible()
  await expect(budgetOfPo(page)).toContainText(/ถือไว้\s*0\.00/)
  await expect(budgetOfPo(page)).toContainText(/จ่ายจริง\s*9,500\.00/)
  await check(page, testInfo, 'invoice-closed-settled')
})

test('[FR-P2P-008/AC3] a PO closed before its invoice waits in the list while it holds budget, and its last invoice gives the rest back at once', async ({ page }, testInfo) => {
  // A scene through the services (requests, approvals, the PO e-mailed) comes first: longer than the default 30 s
  test.setTimeout(SCENE_TEST_TIMEOUT_MS)
  const tag = tagOf(testInfo)
  const s = scene<Po>('closed', tag)
  await signIn(page, 'fin_officer', true)
  await page.goto(`/finance/invoices?q=${s.number}`)
  const row = page.getByRole('list', { name: 'ใบสั่งซื้อรอใบกำกับ' }).getByRole('listitem').filter({ hasText: s.number })
  await expect(row).toContainText('ปิดแล้ว')
  await expect(row).toContainText('ปิดเมื่อ')
  await expect(row).toContainText('1,000.00')
  await check(page, testInfo, 'invoices-closed-row')
  await row.getByRole('link', { name: `บันทึกใบกำกับ ${s.number}` }).click()

  await typeInvoice(page, { no: `D-${tag}`, date: s.today, net: '900.00', vat: '63.00', final: true })
  await review(page)
  await expect(page.getByText('ใบนี้เป็นใบสุดท้ายของใบสั่งซื้อที่ปิดแล้ว เมื่อบันทึก งบที่ยังถือเหลือ 100.00 บาทจะคืนเป็นงบคงเหลือทันที')).toBeVisible()
  await confirm(page)
  await expect(page.getByText('ใบนี้เป็นใบสุดท้ายของใบสั่งซื้อที่ปิดแล้ว คืนงบที่ถือเหลือ 100.00 บาทเป็นงบคงเหลือแล้ว')).toBeVisible()
  await expect(budgetOfPo(page)).toContainText(/ถือไว้\s*0\.00/)
  await expect(budgetOfPo(page)).toContainText(/จ่ายจริง\s*900\.00/)
  await check(page, testInfo, 'invoice-closed-final')
})

test('the finance pages are for finance (FR-P2P-008, FR-P2P-009 screens, §2.4): a requester sees why, and no figure', async ({ page }, testInfo) => {
  await signIn(page, testInfo.project.name === 'mobile' ? 'req_con2' : 'req_con', false)
  for (const [path, list] of [
    ['/finance/invoices', 'ใบสั่งซื้อรอใบกำกับ'],
    ['/finance/exports', 'ใบกำกับที่จะเข้าไฟล์'],
  ] as const) {
    await page.goto(path)
    await expect(h1(page)).toHaveText('หน้านี้สำหรับฝ่ายการเงิน')
    await expect(page.getByText('บัญชีของคุณไม่มีสิทธิ์บันทึกใบกำกับหรือส่งออกไฟล์ Express')).toBeVisible()
    await expect(page.getByRole('list', { name: list })).toHaveCount(0)
  }
  await check(page, testInfo, 'finance-forbidden')
})
