import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Locator, Page } from '@playwright/test'
import ExcelJS from 'exceljs'
import { TEST_EXPRESS_HEADERS, testExpressColumn, testExpressRow } from '../support/express-layout'
import { check, h1, scene, SCENE_TEST_TIMEOUT_MS, signIn, tagOf } from './finance-support'
import { expect, test } from './fixtures'

// Unit g, the Express export (S4-09 · spec §9.1 /finance/exports, FR-P2P-009 AC1 AC2 AC4, BR-EXP-01 to BR-EXP-04).
// The demo organization has no Express layout until the customer's sample import file arrives (OQ-10): the page says
// so, still lists the invoice waiting, and makes no file, neither a first one nor an earlier one again (the scene makes
// that earlier file and the waiting invoice beforehand). For the export itself, tests/e2e/finance-scene.ts gives the
// organization the TEST FIXTURE layout of tests/support/express-layout.ts (not the Express format; the expected header
// and rows are built from it), adds a supplier without an Express vendor code (procurement, after the registry check),
// sends a PO of it and two of S3, and records FINANCE's invoice on two of them through the services. FINANCE
// (fin_officer) opens the page; the third PO's invoice is recorded after that, so the list FINANCE ticks is no longer
// the list waiting and no file is made until the page shows it (BR-EXP-02). FINANCE then makes the file, checks the
// downloaded file against the rows, total and checksum the page shows, makes it again with a reason, and — once
// procurement fills the vendor code — exports the invoice that was kept out. Other invoices waiting in the database
// (the one the first test leaves, for instance) go into the same file, so the file is compared with what the page
// says, not with a fixed count. Pictures at 1440 px and 375 px, axe on every state.

type Made = { poId: string; number: string; invoiceNo: string }
type ExportScene = { supplier: { id: string; code: string; nameTh: string }; held: Made; ready: Made; late: { poId: string; number: string }; today: string }
type WaitingScene = { filed: { invoiceNo: string; number: string; checksum: string }; waiting: { invoiceNo: string; number: string } }

/** Where the invoice number sits in a row of the test layout's file */
const INVOICE_NO = testExpressColumn('invoiceNo')

/** "2026-10-05" → "05/10/2569", the test layout's Buddhist-era date */
const beDate = (day: string) => {
  const [y, m, d] = day.split('-')
  return `${d}/${m}/${Number(y) + 543}`
}

/** Baht with two decimals → satang, exactly */
const satang = (amount: string) => BigInt(amount.replace(/,/g, '').replace('.', ''))

/** Downloads the file the button opens and reads its rows (every cell is text in the file) */
async function downloaded(page: Page, button: Locator): Promise<{ bytes: Buffer; rows: string[][] }> {
  const [download] = await Promise.all([page.waitForEvent('download'), button.click()])
  const bytes = readFileSync((await download.path())!)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(new Uint8Array(bytes).buffer as ArrayBuffer)
  const rows: string[][] = []
  workbook.worksheets[0]!.eachRow((row) => rows.push((row.values as unknown[]).slice(1).map((v) => String(v ?? ''))))
  return { bytes, rows }
}

/** What the page says the file holds: its rows, its total and its checksum */
async function shown(made: Locator) {
  const checksum = ((await made.getByText(/^[0-9a-f]{64}$/).textContent()) ?? '').trim()
  const rows = Number(((await made.getByText(/^\d+ แถว$/).textContent()) ?? '').replace(/\D/g, ''))
  const total = ((await made.getByText(/^[\d,]+\.\d{2} บาท$/).textContent()) ?? '').replace(' บาท', '').trim()
  return { checksum, rows, total }
}

async function makeFile(page: Page): Promise<Locator> {
  await page.getByLabel(/^ตรวจรายการแล้ว ใบกำกับ \d+ ใบนี้จะถูกบันทึกว่าส่งออกแล้ว$/).check()
  await page.getByRole('button', { name: /^สร้างไฟล์ Express \(\d+ ใบ · [\d,]+\.\d{2} บาท\)$/ }).click()
  const made = page.getByRole('region', { name: 'สร้างไฟล์ Express แล้ว' })
  await expect(made).toBeVisible()
  return made
}

test('[FR-P2P-009/AC1] without an Express layout — the demo’s until the customer’s sample file (OQ-10) — the page says why and makes no file, first or again', async ({ page }, testInfo) => {
  // A scene through the services (two POs approved and e-mailed, a file made) comes first: longer than the default 30 s
  test.setTimeout(SCENE_TEST_TIMEOUT_MS)
  // A file made earlier and an invoice waiting for the next one; then the layout as the demo is seeded: none
  const s = scene<WaitingScene>('waiting', tagOf(testInfo))
  scene('layout', 'none')
  await signIn(page, 'fin_officer', true)
  await page.goto('/finance/exports')
  await expect(h1(page)).toHaveText('ส่งออกไฟล์ Express')
  const notice = page.getByRole('status').filter({ hasText: 'ยังสร้างไฟล์ Express ไม่ได้ เพราะยังไม่ได้ตั้งรูปแบบไฟล์' })
  await expect(notice).toContainText('ต้องตั้งตามไฟล์ตัวอย่างที่ Express นำเข้าได้จริง ระบบจึงไม่เดาเอง')
  await expect(notice).toContainText('ส่งไฟล์ตัวอย่างนั้นให้ผู้ดูแลระบบขององค์กร เพื่อส่งต่อให้ทีม BCS ตั้งรูปแบบ')
  await expect(notice).toContainText('ใบกำกับที่บันทึกแล้วรออยู่ในรายการด้านล่าง และส่งออกได้เมื่อตั้งรูปแบบแล้ว')
  // The invoice waits in the list, yet nothing can be made: no tick, no button, no layout to show
  const ready = page.getByRole('list', { name: 'ใบกำกับที่จะเข้าไฟล์' })
  await expect(ready.getByRole('listitem').filter({ hasText: s.waiting.invoiceNo })).toContainText(s.waiting.number)
  await expect(page.getByLabel(/^ตรวจรายการแล้ว ใบกำกับ/)).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^สร้างไฟล์ Express/ })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'รูปแบบไฟล์ขององค์กร' })).toHaveCount(0)
  await check(page, testInfo, 'exports-no-layout')

  // The earlier file cannot be made again either: the page says why, and no new file appears (BR-EXP-02)
  const jobs = page.getByRole('list', { name: 'ไฟล์ Express ที่สร้างแล้ว' })
  const filesBefore = await jobs.getByRole('listitem').count()
  const job = jobs.getByRole('listitem').filter({ hasText: s.filed.checksum })
  await job.getByText(/^ส่งออกใบกำกับ \d+ ใบของไฟล์นี้อีกครั้ง$/).click()
  await job.getByLabel('เหตุผลที่ส่งออกซ้ำ').fill('ไฟล์เดิมนำเข้า Express ไม่สำเร็จ')
  await job.getByRole('button', { name: /^สร้างไฟล์ใหม่จากใบกำกับ \d+ ใบนี้$/ }).click()
  const refused = job.getByRole('alert').filter({ hasText: 'ยังไม่ได้สร้างไฟล์ เพราะยังไม่ได้ตั้งรูปแบบไฟล์ Express' })
  await expect(refused).toContainText('ส่งไฟล์ตัวอย่างนั้นให้ผู้ดูแลระบบขององค์กร เพื่อส่งต่อให้ทีม BCS ตั้งรูปแบบ')
  await expect(refused).toContainText('ระบบยังไม่ได้บันทึกใบกำกับใบไหนว่าส่งออกเพิ่ม')
  await check(page, testInfo, 'exports-no-layout-again')
  await page.reload()
  await expect(h1(page)).toHaveText('ส่งออกไฟล์ Express')
  await expect(jobs.getByRole('listitem')).toHaveCount(filesBefore)
  await expect(ready.getByRole('listitem').filter({ hasText: s.waiting.invoiceNo })).toHaveCount(1)
})

test('[FR-P2P-009/AC1] [FR-P2P-009/AC2] [FR-P2P-009/AC4] finance makes the Express file of the invoices not exported yet; the file matches its rows, total and checksum; an invoice without a vendor code waits for procurement', async ({ page }, testInfo) => {
  // A scene through the services (requests, approvals, the PO e-mailed) comes first: longer than the default 30 s
  test.setTimeout(SCENE_TEST_TIMEOUT_MS)
  const tag = tagOf(testInfo)
  const s = scene<ExportScene>('export', tag)
  await signIn(page, 'fin_officer', true)
  await page.goto('/finance/exports')
  await expect(h1(page)).toHaveText('ส่งออกไฟล์ Express')

  // AC1: the invoices the next file takes; AC4: the one kept out, with its supplier to fix
  const ready = page.getByRole('list', { name: 'ใบกำกับที่จะเข้าไฟล์' })
  await expect(ready.getByRole('listitem').filter({ hasText: s.ready.invoiceNo })).toContainText('1,070.00')
  await expect(ready.getByRole('listitem').filter({ hasText: s.ready.invoiceNo })).toContainText('รหัสเจ้าหนี้ V0003')
  await expect(ready.getByRole('listitem').filter({ hasText: s.held.invoiceNo })).toHaveCount(0)
  const held = page.getByRole('list', { name: 'ผู้ขายที่ยังไม่มีรหัสเจ้าหนี้ Express' }).getByRole('listitem').filter({ hasText: s.supplier.code })
  await expect(held).toContainText(`${s.held.invoiceNo} (${s.held.number})`)
  await expect(held).toContainText('2,140.00')
  await expect(held.getByRole('link', { name: `เปิดข้อมูลผู้ขาย ${s.supplier.nameTh}` })).toHaveAttribute('href', `/suppliers/${s.supplier.id}`)
  // BR-EXP-01: the organization's layout (here the test fixture's) and no notice that it is missing
  await expect(page.getByText('ไฟล์ Excel (xlsx) · อักขระ UTF-8 (มี BOM) · วันที่แบบ พ.ศ. (วว/ดด/ปปปป)')).toBeVisible()
  await expect(page.getByText(`${TEST_EXPRESS_HEADERS.length} คอลัมน์ตามลำดับ: ${TEST_EXPRESS_HEADERS.join(' · ')}`)).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'ยังสร้างไฟล์ Express ไม่ได้' })).toHaveCount(0)
  await check(page, testInfo, 'exports')

  // Marking invoices exported cannot be undone: the tick first
  await page.getByRole('button', { name: /^สร้างไฟล์ Express \(/ }).click()
  await expect(page.getByText('ติ๊กยืนยันว่าตรวจรายการแล้วก่อนสร้างไฟล์')).toBeVisible()

  // BR-EXP-02: an invoice recorded after the page opened is not in the list ticked, so no file is made; the page shows
  // the list again with it, to be checked and ticked once more
  const lateInvoiceNo = `EXL-${tag}`
  scene('invoice', s.late.poId, lateInvoiceNo)
  await page.getByLabel(/^ตรวจรายการแล้ว ใบกำกับ \d+ ใบนี้จะถูกบันทึกว่าส่งออกแล้ว$/).check()
  await page.getByRole('button', { name: /^สร้างไฟล์ Express \(/ }).click()
  await expect(page.getByRole('status').filter({ hasText: 'รายการใบกำกับเปลี่ยนไปหลังจากเปิดหน้านี้' })).toContainText('ตรวจอีกครั้งแล้วติ๊กยืนยันใหม่')
  await expect(ready.getByRole('listitem').filter({ hasText: lateInvoiceNo })).toContainText(s.late.number)
  await expect(page.getByLabel(/^ตรวจรายการแล้ว ใบกำกับ \d+ ใบนี้จะถูกบันทึกว่าส่งออกแล้ว$/)).not.toBeChecked()
  await expect(page.getByRole('region', { name: 'สร้างไฟล์ Express แล้ว' })).toHaveCount(0)
  await check(page, testInfo, 'exports-changed')

  const made = await makeFile(page)
  await expect(made).toContainText(/ใบกำกับอีก \d+ ใบถูกกันไว้เพราะผู้ขายยังไม่มีรหัสเจ้าหนี้ Express/)
  const first = await shown(made)
  await check(page, testInfo, 'exports-made')

  // AC2: the downloaded file is the one the page describes — checksum, rows and total — in the layout's columns
  const file = await downloaded(page, made.getByRole('button', { name: 'ดาวน์โหลดไฟล์ที่สร้าง' }))
  expect(createHash('sha256').update(file.bytes).digest('hex')).toBe(first.checksum)
  expect(file.rows[0]).toEqual(TEST_EXPRESS_HEADERS)
  const body = file.rows.slice(1)
  expect(body).toHaveLength(first.rows)
  expect(body.find((r) => r[INVOICE_NO] === s.ready.invoiceNo)).toEqual(
    testExpressRow({
      expressVendorCode: 'V0003',
      invoiceNo: s.ready.invoiceNo,
      invoiceDate: beDate(s.today),
      supplierCode: 'S3',
      supplierName: 'บริษัท บริการทำความสะอาดทดสอบ จำกัด',
      supplierTaxId: '0999999000039',
      supplierBranch: '00000',
      poNumber: s.ready.number,
      net: '1000.00',
      vat: '70.00',
      gross: '1070.00',
      budgetLineCode: expect.stringMatching(/^CON-(CAPEX|OPEX)-2569$/),
      costCenterCode: expect.any(String),
      accountCode: expect.any(String),
    }),
  )
  expect(body.some((r) => r[INVOICE_NO] === s.held.invoiceNo)).toBe(false)
  expect(body.reduce((sum, r) => sum + satang(r[testExpressColumn('gross')]!), 0n)).toBe(satang(first.total))

  // The file among those made, with the same figures; made again only with a reason (BR-EXP-02)
  const jobs = page.getByRole('list', { name: 'ไฟล์ Express ที่สร้างแล้ว' })
  const job = jobs.getByRole('listitem').filter({ hasText: first.checksum })
  await expect(job).toContainText(`${first.rows} แถว`)
  await expect(job).toContainText(first.total)
  await expect(job).toContainText('สร้างโดย ฟ้าใส บัญชี')
  await job.getByText(/^ส่งออกใบกำกับ \d+ ใบของไฟล์นี้อีกครั้ง$/).click()
  const again = job.getByRole('button', { name: /^สร้างไฟล์ใหม่จากใบกำกับ \d+ ใบนี้$/ })
  await again.click()
  await expect(job.getByText('ใส่เหตุผลที่ส่งออกซ้ำอย่างน้อย 3 ตัวอักษร')).toBeVisible()
  await job.getByLabel('เหตุผลที่ส่งออกซ้ำ').fill('ไฟล์เดิมนำเข้า Express ไม่สำเร็จ')
  await check(page, testInfo, 'exports-again')
  await again.click()
  await expect(job.getByText(new RegExp(`^สร้างไฟล์ใหม่แล้ว ${first.rows} แถว ยอดรวม ${first.total.replace(/[.]/g, '\\.')} บาท`))).toBeVisible()
  await expect(jobs.getByRole('listitem').first()).toContainText('ส่งออกซ้ำ เหตุผล: ไฟล์เดิมนำเข้า Express ไม่สำเร็จ')
  await check(page, testInfo, 'exports-again-done')

  // AC4: procurement fills the vendor code in the supplier register; the invoice kept out goes into the next file
  scene('vendor-code', s.supplier.id, tag)
  await page.reload()
  await expect(page.getByRole('list', { name: 'ผู้ขายที่ยังไม่มีรหัสเจ้าหนี้ Express' }).getByRole('listitem').filter({ hasText: s.supplier.code })).toHaveCount(0)
  await expect(page.getByRole('list', { name: 'ใบกำกับที่จะเข้าไฟล์' }).getByRole('listitem').filter({ hasText: s.held.invoiceNo })).toContainText('2,140.00')
  const next = await makeFile(page)
  const second = await shown(next)
  const nextFile = await downloaded(page, next.getByRole('button', { name: 'ดาวน์โหลดไฟล์ที่สร้าง' }))
  expect(createHash('sha256').update(nextFile.bytes).digest('hex')).toBe(second.checksum)
  expect(nextFile.rows[0]).toEqual(TEST_EXPRESS_HEADERS)
  expect(nextFile.rows.slice(1).find((r) => r[INVOICE_NO] === s.held.invoiceNo)).toEqual(
    testExpressRow({
      expressVendorCode: `V-${tag.toUpperCase()}`,
      invoiceNo: s.held.invoiceNo,
      invoiceDate: beDate(s.today),
      supplierCode: s.supplier.code,
      supplierName: s.supplier.nameTh,
      supplierTaxId: '0999999000098',
      supplierBranch: expect.stringMatching(/^\d{5}$/),
      poNumber: s.held.number,
      net: '2000.00',
      vat: '140.00',
      gross: '2140.00',
      budgetLineCode: expect.stringMatching(/^CON-(CAPEX|OPEX)-2569$/),
      costCenterCode: expect.any(String),
      accountCode: expect.any(String),
    }),
  )
  await check(page, testInfo, 'exports-code-filled')
})
