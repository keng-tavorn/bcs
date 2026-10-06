import { readFile } from 'node:fs/promises'
import ExcelJS from 'exceljs'
import { type Page } from '@playwright/test'
import { expectNoBlockingAxe, expectNoSideways, scene, sheetRows, shot, signIn, startsWithAmount, type AdminScene } from './budgets-support'
import { expect, test } from './fixtures'

// S3-04 · FR-BUD-001: BUDGET_ADMIN downloads the template, checks a file that has wrong rows (each row and column is
// reported, nothing is saved — AC1), imports the corrected file once it is confirmed (each row funds its line — AC2),
// and must confirm again before the same file adds its amounts a second time (AC3). Each project has its own budget
// administrator and line codes (tests/e2e/budgets-scene.ts).

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
/** Row 1 of the template: the column keys the import reads (src/server/services/budget/import.ts) */
const COLUMN_KEYS = ['fiscalYear', 'department', 'costCenter', 'code', 'nameTh', 'accountCode', 'amount']

/** The template with these rows filled in from row 3, as the administrator would fill it */
async function filled(template: Buffer, rows: Array<Array<string | number>>): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(new Uint8Array(template).buffer as ArrayBuffer)
  const sheet = workbook.getWorksheet('Budget')!
  for (const row of rows) sheet.addRow(row)
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

async function checkFile(page: Page, name: string, buffer: Buffer) {
  await page.locator('input[type="file"]').setInputFiles({ name, mimeType: XLSX, buffer })
  await page.getByRole('button', { name: 'ตรวจไฟล์', exact: true }).click()
}

test('[FR-BUD-001/AC1] [FR-BUD-001/AC2] [FR-BUD-001/AC3] BUDGET_ADMIN checks a file row by row, imports it once confirmed, and confirms again before the same file adds its amounts twice', async ({
  page,
}, testInfo) => {
  // A scene of its own, several pages, axe and a screenshot at each state: longer than the default 30 s
  test.slow()
  const s = scene<AdminScene>('admin', testInfo.project.name)
  await signIn(page, s.budgetAdmin.email, s.budgetAdmin.code)
  await page.goto('/budgets')
  await page.getByRole('link', { name: 'นำเข้างบจาก Excel' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'นำเข้างบจาก Excel' })).toBeVisible()
  await expect(page.getByText('ยังไม่เคยนำเข้างบ').or(page.getByRole('heading', { name: 'นำเข้าล่าสุด' }))).toBeVisible()

  // The template: the column keys on row 1, the labels on row 2, and a guide with the organization's codes
  const download = page.waitForEvent('download')
  await page.getByRole('link', { name: 'ดาวน์โหลดแม่แบบ Excel' }).click()
  const template = await readFile((await (await download).path())!)
  const [keys, labels] = await sheetRows(template, 'Budget')
  expect(keys).toEqual(COLUMN_KEYS)
  expect(labels).toEqual(['ปีงบ', 'แผนก', 'cost center', 'รหัสบรรทัดงบ', 'ชื่อบรรทัดงบ', 'รหัสบัญชี', 'ยอดงบ (บาท ก่อน VAT)'])
  expect((await sheetRows(template, 'วิธีกรอก')).flat()).toEqual(expect.arrayContaining([s.fiscalYear.code, 'FIN', 'CC-FIN']))

  // AC1: wrong rows are each reported with the column and what to fix; nothing can be imported yet
  const fy = s.fiscalYear.code
  const [fileName, againName] = [`งบทดสอบ-${s.run}.xlsx`, `งบทดสอบ-อีกครั้ง-${s.run}.xlsx`]
  const [codeA, codeB] = [`FIN-E2EJ-I${s.run}-A`, `FIN-E2EJ-I${s.run}-B`]
  await checkFile(
    page,
    `งบทดสอบ-ผิด-${s.run}.xlsx`,
    await filled(template, [
      [fy, 'FIN', 'CC-FIN', codeA, 'ค่าอบรมทดสอบ', '5103', '12345.5'],
      [fy, 'XX', 'CC-FIN', codeB, 'แผนกไม่มีจริง', '', 1000],
      [fy, 'FIN', 'CC-FIN', `${codeB}-2`, 'ยอดผิด', '', 'หนึ่งพัน'],
    ]),
  )
  const result = page.getByRole('list', { name: 'ผลตรวจ 3 แถว' })
  await expect(page.getByText('แก้ 2 แถวในไฟล์แล้วตรวจอีกครั้ง ยังไม่ได้บันทึกอะไร')).toBeVisible()
  await expect(result.getByRole('listitem').filter({ hasText: 'แถว 3' })).toContainText('สร้างบรรทัดงบใหม่')
  await expect(result.getByRole('listitem').filter({ hasText: 'แถว 4' })).toContainText('แผนก · ไม่พบรหัสแผนกนี้ ใช้รหัสในชีตวิธีกรอก')
  await expect(result.getByRole('listitem').filter({ hasText: 'แถว 5' })).toContainText('ยอดงบ (บาท ก่อน VAT) · ใส่ยอดเป็นตัวเลขมากกว่า 0 ทศนิยมไม่เกิน 2 ตำแหน่ง')
  await expect(page.getByRole('button', { name: /^นำเข้างบ/ })).toHaveCount(0)
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'budgets-import-errors')

  // AC1 AC2: the corrected file — a summary, a confirmation, then every row funds its line
  const good = await filled(template, [
    [fy, 'FIN', 'CC-FIN', codeA, 'ค่าอบรมทดสอบ', '5103', '12345.5'],
    [fy, 'FIN', 'CC-FIN', codeB, 'ค่าเดินทางทดสอบ', '', 1000],
  ])
  await checkFile(page, fileName, good)
  await expect(page.getByText('นำเข้า 2 แถว รวม 13,345.50 บาท · สร้างบรรทัดงบใหม่ 2 · เพิ่มยอดบรรทัดเดิม 0')).toBeVisible()
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'budgets-import-ready')
  await page.getByRole('button', { name: 'นำเข้างบ 2 แถว' }).click()
  await expect(page.getByText('ติ๊กช่องยืนยันก่อนนำเข้างบ')).toBeVisible()
  await page.getByLabel('ยืนยันเพิ่มงบตามรายการข้างบน ยอดจะบันทึกในบัญชีงบและลบออกไม่ได้').check()
  await page.getByRole('button', { name: 'นำเข้างบ 2 แถว' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'นำเข้างบแล้ว 2 แถว รวม 13,345.50 บาท สร้างบรรทัดงบใหม่ 2 บรรทัด' })).toBeVisible()
  const history = page.getByRole('list', { name: 'นำเข้าล่าสุด' })
  await expect(history.getByRole('listitem').filter({ hasText: fileName })).toContainText(`2 แถว · รวม 13,345.50 บาท · ปีงบ ${fy}`)
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'budgets-import-done')

  // A row that adds to an existing line under another name is said before anyone confirms; the line keeps its name
  await checkFile(page, `งบทดสอบ-ชื่อต่าง-${s.run}.xlsx`, await filled(template, [[fy, 'FIN', 'CC-FIN', codeA, 'ค่าอบรมพิมพ์ผิด', '5103', '100']]))
  const differs = page.getByRole('list', { name: 'ผลตรวจ 1 แถว' }).getByRole('listitem').filter({ hasText: 'แถว 3' })
  await expect(differs).toContainText('เพิ่มยอดให้บรรทัดงบเดิม (ตอนนี้ 12,345.50 บาท)')
  await expect(differs).toContainText('ชื่อในไฟล์ต่างจากบรรทัดงบเดิม (ค่าอบรมทดสอบ) ระบบเพิ่มยอดโดยใช้ชื่อเดิม')
  await expect(page.getByRole('status').filter({ hasText: '1 แถวมีข้อมูลต่างจากบรรทัดงบเดิม' })).toBeVisible()
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'budgets-import-differs')

  // AC3: the same file again is recognised and needs its own confirmation before it adds the amounts again
  await checkFile(page, againName, good)
  await expect(page.getByRole('status').filter({ hasText: 'ไฟล์นี้เคยนำเข้าแล้วเมื่อ' })).toContainText(`ในชื่อ ${fileName} โดย ${s.budgetAdmin.name}`)
  await expect(page.getByRole('list', { name: 'ผลตรวจ 2 แถว' }).getByRole('listitem').filter({ hasText: 'แถว 3' })).toContainText('เพิ่มยอดให้บรรทัดงบเดิม (ตอนนี้ 12,345.50 บาท)')
  await page.getByLabel('ยืนยันเพิ่มงบตามรายการข้างบน ยอดจะบันทึกในบัญชีงบและลบออกไม่ได้').check()
  await page.getByRole('button', { name: 'นำเข้างบ 2 แถว' }).click()
  await expect(page.getByText('ติ๊กช่องยืนยันว่าต้องการเพิ่มยอดจากไฟล์นี้อีกครั้ง')).toBeVisible()
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'budgets-import-duplicate')
  await page.getByLabel('ฉันต้องการเพิ่มยอดจากไฟล์นี้อีกครั้ง').check()
  await page.getByRole('button', { name: 'นำเข้างบ 2 แถว' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'นำเข้างบแล้ว 2 แถว รวม 13,345.50 บาท สร้างบรรทัดงบใหม่ 0 บรรทัด' })).toBeVisible()
  await expect(history.getByRole('listitem').filter({ hasText: againName })).toContainText('นำเข้าซ้ำ (ยืนยันแล้ว)')

  // The dashboard has the new lines with both imports added up
  await page.getByRole('link', { name: 'ดูหน้างบประมาณ' }).click()
  const wide = testInfo.project.name === 'desktop'
  const line = wide ? page.getByRole('row').filter({ hasText: codeA }) : page.getByRole('listitem').filter({ has: page.getByRole('link', { name: codeA, exact: true }) })
  await expect((wide ? line.getByRole('cell') : line.locator('dd')).first()).toHaveText(startsWithAmount('24,691.00'))
})

test('[FR-BUD-001/AC1] only BUDGET_ADMIN imports budgets', async ({ page }, testInfo) => {
  const s = scene<AdminScene>('admin', testInfo.project.name)
  await signIn(page, s.member.email, null)
  await page.goto('/budgets/import')
  await expect(page.getByRole('heading', { level: 1, name: 'นำเข้างบจาก Excel' })).toBeVisible()
  await expect(page.getByText('หน้านำเข้างบสำหรับผู้ดูแลงบเท่านั้น', { exact: false })).toBeVisible()
  await expect(page.getByRole('button', { name: 'ตรวจไฟล์' })).toHaveCount(0)
  const template = await page.request.get('/budgets/import/template')
  expect(template.status()).toBe(403)
})
