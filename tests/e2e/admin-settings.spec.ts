import { spawnSync } from 'node:child_process'
import AxeBuilder from '@axe-core/playwright'
import type { Page, TestInfo } from '@playwright/test'
import ExcelJS from 'exceljs'
import { deriveSeedTotpSecret, totp } from '../../src/lib/totp'
import { e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'

// S2-13 (unit d): business calendar and holidays (FR-ADM-003), number patterns (FR-ADM-004), request types and their
// forms (FR-ADM-005). Each viewport changes its own records (holiday dates, document types, request types) so desktop and
// mobile never collide in the shared e2e database; settings both change are put back. Screenshots at 375 px and
// 1440 px go to the test output (§9.9 step 4) and axe runs on every page (step 5).

async function expectNoBlockingAxe(page: Page) {
  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(blocking.map((v) => `${v.id}: ${v.help}`)).toEqual([])
}

async function shot(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })
}

/** The page is never wider than the screen (§9.9: no horizontal scroll on phones) */
async function expectNoHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
}

async function signIn(page: Page, code: string, withTotp: boolean) {
  await page.goto('/login')
  await page.getByLabel('อีเมลบริษัท').fill(`${code}@demo.bcs.local`)
  await page.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
  if (withTotp) {
    await expect(page).toHaveURL(/\/login\/2fa$/)
    await page.getByLabel('รหัส 6 หลักจากแอป').fill(totp(deriveSeedTotpSecret(process.env.SEED_TOTP_KEY!, code)))
    await page.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' }).click()
  }
  await expect(page.getByRole('heading', { level: 1 })).toContainText('สวัสดี')
}

/** The organization admin of this project (two seeded admins, one per viewport) */
const signInOrgAdmin = (page: Page, testInfo: TestInfo) => signIn(page, testInfo.project.name === 'mobile' ? 'admin2' : 'admin', true)

/** Buddhist-era year, its last two digits and the month, in Thai time now (what {BE} {YY} {MM} print) */
function thaiPeriod(): { be: string; yy: string; mm: string } {
  const [year, month] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit' }).format(new Date()).split('-')
  const be = String(Number(year) + 543)
  return { be, yy: be.slice(2), mm: month! }
}

const success = (page: Page, text: string | RegExp) => page.getByRole('status').filter({ hasText: text })
const failure = (page: Page, text: string | RegExp) => page.getByRole('alert').filter({ hasText: text })

/** A step of tests/e2e/admin-settings-scene.ts in the e2e database (what another unit's request page will do) */
function scene(...args: string[]): Record<string, unknown> {
  const r = spawnSync(`pnpm exec tsx tests/e2e/admin-settings-scene.ts ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`admin settings scene failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as Record<string, unknown>
}

/** A filled copy of the holiday template downloaded from the page */
async function holidayFile(page: Page, testInfo: TestInfo, name: string, rows: Array<[string, string]>): Promise<string> {
  const response = await page.request.get('/admin/calendar/template')
  expect(response.status()).toBe(200)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(new Uint8Array(await response.body()).buffer as ArrayBuffer)
  const sheet = workbook.getWorksheet('Holidays')!
  for (const row of rows) sheet.addRow(row)
  const file = testInfo.outputPath(name)
  await workbook.xlsx.writeFile(file)
  return file
}

test('[FR-ADM-003/AC1] [FR-ADM-003/AC2] the admin sets business days and hours and imports the year’s holidays from Excel', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile'
  await signInOrgAdmin(page, testInfo)
  await page.goto('/admin/calendar')
  await expect(page.getByRole('heading', { level: 1, name: 'ปฏิทินทำการและวันหยุด' })).toBeVisible()
  // A-07: Monday to Friday 08:30–17:30
  for (const day of ['จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์']) await expect(page.getByLabel(day, { exact: true })).toBeChecked()
  for (const day of ['เสาร์', 'อาทิตย์']) await expect(page.getByLabel(day, { exact: true })).not.toBeChecked()
  await expect(page.getByLabel('เริ่มเวลาทำการ')).toHaveValue('08:30')
  await expect(page.getByLabel('เลิกเวลาทำการ')).toHaveValue('17:30')
  await expectNoBlockingAxe(page)
  await expectNoHorizontalScroll(page)
  await shot(page, testInfo, 'calendar')

  const save = page.getByRole('button', { name: 'บันทึกเวลาทำการ' })
  await page.getByLabel('เลิกเวลาทำการ').fill('07:00')
  await save.click()
  await expect(page.getByText('เวลาเลิกต้องหลังเวลาเริ่ม')).toBeVisible()
  await page.getByLabel('เสาร์', { exact: true }).check()
  await page.getByLabel('เริ่มเวลาทำการ').fill('08:00')
  await page.getByLabel('เลิกเวลาทำการ').fill('17:00')
  await save.click()
  await expect(success(page, 'บันทึกเวลาทำการแล้ว งานที่มอบหลังจากนี้ใช้เวลาใหม่ งานที่มอบไปแล้วคงกำหนดเวลาเดิม')).toBeVisible()
  await page.reload()
  await expect(page.getByLabel('เสาร์', { exact: true })).toBeChecked()
  await expect(page.getByLabel('เริ่มเวลาทำการ')).toHaveValue('08:00')
  // Back to A-07 for everything else in this run
  await page.getByLabel('เสาร์', { exact: true }).uncheck()
  await page.getByLabel('เริ่มเวลาทำการ').fill('08:30')
  await page.getByLabel('เลิกเวลาทำการ').fill('17:30')
  await page.getByRole('button', { name: 'บันทึกเวลาทำการ' }).click()
  await expect(success(page, 'บันทึกเวลาทำการแล้ว')).toBeVisible()

  // FR-ADM-003 AC2: holidays of next year (Buddhist era `next`), different for each viewport; dates as Christian-era
  // text, Buddhist-era text or both
  const be = Number(thaiPeriod().be)
  const next = be + 1
  const ce = next - 543
  const [first, second, third]: Array<[string, string]> = mobile
    ? [
        [`${ce}-05-04`, 'วันฉัตรมงคล'],
        [`03/06/${next}`, 'วันเฉลิมพระชนมพรรษาพระราชินี'],
        [`${ce}-07-28`, 'วันเฉลิมพระชนมพรรษาพระบาทสมเด็จพระเจ้าอยู่หัว'],
      ]
    : [
        [`${ce}-04-13`, 'วันสงกรานต์'],
        [`14/04/${next}`, 'วันครอบครัว'],
        [`${ce}-04-15`, 'วันสงกรานต์วันสุดท้าย'],
      ]

  // Step 1 with a wrong file: every wrong row is listed and nothing is saved
  const fileInput = page.getByLabel('ไฟล์ Excel ที่กรอกแล้ว')
  const check = page.getByRole('button', { name: 'ตรวจไฟล์' })
  const bad = await holidayFile(page, testInfo, 'holidays-bad.xlsx', [first!, [`31/02/${next}`, 'วันที่ไม่มีจริง'], ['', 'ไม่มีวันที่'], [`31/12/${be - 1}`, 'ปีที่แล้ว']])
  await fileInput.setInputFiles(bad)
  await check.click()
  const errors = failure(page, 'ยังไม่ได้บันทึก แก้แถวเหล่านี้แล้วตรวจไฟล์อีกครั้ง')
  await expect(errors).toContainText('แถว 4 · วันที่ · วันที่ไม่ถูกต้อง ใช้รูปแบบ 2027-04-13 หรือ 13/04/2570')
  await expect(errors).toContainText('แถว 5 · วันที่ · ต้องกรอก')
  await expect(errors).toContainText(`แถว 6 · วันที่ · ใส่ได้เฉพาะวันที่ในปี พ.ศ. ${be} ถึง ${be + 10} ตรวจปีอีกครั้ง`)
  await expect(page.getByRole('button', { name: /^เพิ่มวันหยุด/ })).toHaveCount(0)
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'calendar-import-errors')
  const list = page.getByRole('region', { name: /^วันหยุดตั้งแต่ปี / })
  await expect(list.getByRole('listitem').filter({ hasText: first![1] })).toHaveCount(0)

  // Step 1 with a good file lists what it would add; nothing is saved until the admin ticks the confirmation (an added
  // holiday cannot be removed or renamed)
  await fileInput.setInputFiles(await holidayFile(page, testInfo, 'holidays-good.xlsx', [first!, second!]))
  await check.click()
  const toAdd = page.getByRole('region', { name: 'จะเพิ่มวันหยุด 2 วัน' })
  for (const [, name] of [first!, second!]) await expect(toAdd.getByRole('listitem').filter({ hasText: name })).toBeVisible()
  await expect(list.getByRole('listitem').filter({ hasText: first![1] })).toHaveCount(0)
  const add = page.getByRole('button', { name: 'เพิ่มวันหยุด 2 วัน' })
  await add.click()
  await expect(page.getByText('ติ๊กช่องยืนยันก่อนเพิ่มวันหยุด')).toBeVisible()
  await page.getByLabel(/^ยืนยันเพิ่มวันหยุด 2 วันตามรายการนี้ เพิ่มแล้วลบหรือแก้ชื่อในระบบไม่ได้/).check()
  await add.click()
  await expect(success(page, 'เพิ่มวันหยุดแล้ว 2 วัน')).toBeVisible()
  const nextYear = list.getByRole('region', { name: new RegExp(`^ปี ${next} · `) })
  for (const [, name] of [first!, second!]) await expect(nextYear.getByRole('listitem').filter({ hasText: name })).toBeVisible()

  // A date the calendar has is skipped and keeps its name; the check says so before anything is added
  await fileInput.setInputFiles(await holidayFile(page, testInfo, 'holidays-again.xlsx', [[first![0], 'ชื่อใหม่ที่ไม่ใช้'], third!]))
  await check.click()
  await expect(page.getByRole('region', { name: 'จะเพิ่มวันหยุด 1 วัน' }).getByRole('listitem').filter({ hasText: third![1] })).toBeVisible()
  const skipped = page.getByRole('region', { name: 'ข้าม 1 วันที่มีในปฏิทินแล้ว (ชื่อเดิมไม่เปลี่ยน)' })
  await expect(skipped).toContainText(`ชื่อในปฏิทิน: ${first![1]}`)
  await expectNoBlockingAxe(page)
  await expectNoHorizontalScroll(page)
  await shot(page, testInfo, 'calendar-import-check')
  await page.getByLabel(/^ยืนยันเพิ่มวันหยุด 1 วันตามรายการนี้/).check()
  await page.getByRole('button', { name: 'เพิ่มวันหยุด 1 วัน' }).click()
  await expect(success(page, 'เพิ่มวันหยุดแล้ว 1 วัน และข้าม 1 วันที่มีในปฏิทินแล้ว (ชื่อเดิมไม่เปลี่ยน)')).toBeVisible()
  await expect(nextYear.getByRole('listitem').filter({ hasText: third![1] })).toBeVisible()
  await expect(nextYear.getByRole('listitem').filter({ hasText: 'ชื่อใหม่ที่ไม่ใช้' })).toHaveCount(0)
  await expectNoBlockingAxe(page)
  await expectNoHorizontalScroll(page)
  await shot(page, testInfo, 'calendar-imported')
})

test('[FR-ADM-004/AC1] [FR-ADM-004/AC2] [FR-ADM-004/AC3] the next number shows before a pattern is saved; unknown codes and repeated numbers are refused', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile'
  const { be, yy, mm } = thaiPeriod()
  await signInOrgAdmin(page, testInfo)
  await page.goto('/admin/numbering')
  await expect(page.getByRole('heading', { level: 1, name: 'รูปแบบเลขเอกสาร' })).toBeVisible()
  const doc = mobile ? { code: 'GR', name: 'ใบตรวจรับ (GR)' } : { code: 'PO', name: 'ใบสั่งซื้อ (PO)' }
  const section = page.getByRole('region', { name: doc.name })
  // Other tests of the run may have issued numbers of this year already: the next one is any number of the pattern
  const yearly = new RegExp(`^เลขถัดไปตอนนี้ ${doc.code}-${be}-\\d{5}$`)
  await expect(section.getByText(yearly)).toBeVisible()
  await expectNoBlockingAxe(page)
  await expectNoHorizontalScroll(page)
  await shot(page, testInfo, 'numbering')

  // AC2: a code it does not know, or no running number, is said under the field while typing, and the save is refused
  const pattern = section.getByLabel('รูปแบบเลข')
  const refused = 'ยังบันทึกรูปแบบนี้ไม่ได้ แก้ตามข้อความใต้ช่องรูปแบบเลข'
  const unknown = 'มีรหัสที่ระบบไม่รู้จัก {BEE} แก้ให้ตรงกับรายการรหัสที่ใช้ได้'
  await pattern.fill(`${doc.code}-{BEE}-{SEQ5}`)
  await expect(section.getByText(unknown)).toHaveCount(1)
  await expect(pattern).toHaveAttribute('aria-invalid', 'true')
  await expect(section.getByText(refused)).toBeVisible()
  await section.getByRole('button', { name: `บันทึกรูปแบบเลข ${doc.code}` }).click()
  await expect(section.getByText(unknown)).toHaveCount(1)
  await expect(success(page, `บันทึกรูปแบบเลข ${doc.code} แล้ว`)).toHaveCount(0)
  await shot(page, testInfo, 'numbering-unknown-code')
  // Nothing was stored: the page read again still has the pattern of before
  await page.reload()
  await expect(section.getByLabel('รูปแบบเลข')).toHaveValue(`${doc.code}-{BE}-{SEQ5}`)
  await expect(section.getByText(yearly)).toBeVisible()
  await pattern.fill(`${doc.code}-{BE}`)
  await expect(section.getByText('รูปแบบต้องมีเลขลำดับหนึ่งตัว เช่น {SEQ5}')).toBeVisible()

  // AC1 and AC3: a monthly series shows its first number before it is saved, and starts a new scope at 1
  await section.getByLabel('เริ่มนับใหม่').selectOption({ label: 'ทุกเดือน' })
  if (mobile) {
    await pattern.fill('GR-{DEPT}-{YY}{MM}-{SEQ3}')
    await expect(section.getByText(`GR-CON-${yy}${mm}-001`, { exact: true })).toBeVisible()
    await section.getByLabel('แผนกที่ใช้แสดงตัวอย่าง').selectOption('IT')
    await expect(section.getByText(`GR-IT-${yy}${mm}-001`, { exact: true })).toBeVisible()
  } else {
    await pattern.fill('PO{YY}{MM}-{SEQ4}')
    await expect(section.getByText(`PO${yy}${mm}-0001`, { exact: true })).toBeVisible()
  }
  await expect(section.getByText('เริ่มชุดเลขใหม่ที่ 1')).toBeVisible()
  await section.getByRole('button', { name: `บันทึกรูปแบบเลข ${doc.code}` }).click()
  await expect(success(page, `บันทึกรูปแบบเลข ${doc.code} แล้ว`)).toBeVisible()
  await page.reload()
  const saved = page.getByRole('region', { name: doc.name })
  await expect(saved.getByText(mobile ? `เลขถัดไปตอนนี้ GR-CON-${yy}${mm}-001` : `เลขถัดไปตอนนี้ PO${yy}${mm}-0001`)).toBeVisible()

  // AC3: counting PR on without a reset would issue PR numbers of this year again, so it is refused
  const pr = page.getByRole('region', { name: 'ใบขอซื้อ (PR)' })
  await pr.getByLabel('เริ่มนับใหม่').selectOption({ label: 'ไม่เริ่มใหม่ นับต่อเนื่อง' })
  const collision = new RegExp(`^รูปแบบนี้จะออกเลข PR-${be}-\\d{5} ซึ่งออกไปแล้ว`)
  await expect(pr.getByText(collision)).toHaveCount(1)
  await expect(pr.getByText(refused)).toBeVisible()
  await pr.getByRole('button', { name: 'บันทึกรูปแบบเลข PR' }).click()
  await expect(pr.getByText(collision)).toHaveCount(1)
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'numbering-refused')
  await page.reload()
  await expect(page.getByRole('region', { name: 'ใบขอซื้อ (PR)' }).getByLabel('เริ่มนับใหม่')).toHaveValue('YEARLY')

  // Put the yearly pattern back for the tests that follow (they read PO and GR numbers of the seeded pattern); the
  // yearly series goes on where it stopped, so no number is issued twice (INV-NUM-01)
  const restore = page.getByRole('region', { name: doc.name })
  await restore.getByLabel('เริ่มนับใหม่').selectOption({ label: 'ทุกปี พ.ศ.' })
  await restore.getByLabel('รูปแบบเลข').fill(`${doc.code}-{BE}-{SEQ5}`)
  await restore.getByRole('button', { name: `บันทึกรูปแบบเลข ${doc.code}` }).click()
  await expect(success(page, `บันทึกรูปแบบเลข ${doc.code} แล้ว`)).toBeVisible()
  await page.reload()
  await expect(page.getByRole('region', { name: doc.name }).getByLabel('รูปแบบเลข')).toHaveValue(`${doc.code}-{BE}-{SEQ5}`)
})

test('[FR-ADM-005/AC2] the admin orders the catalog and switches request types off and on', async ({ page }, testInfo) => {
  const name = testInfo.project.name === 'mobile' ? 'ซื้ออุปกรณ์/ซอฟต์แวร์ไอที' : 'จ้างเหมา'
  await signInOrgAdmin(page, testInfo)
  await page.goto('/admin/request-types')
  await expect(page.getByRole('heading', { level: 1, name: 'ประเภทคำขอ' })).toBeVisible()
  const list = page.getByRole('region', { name: /^ประเภทคำขอทั้งหมด/ })
  const names = () => list.getByRole('listitem').evaluateAll((items) => items.map((li) => li.querySelector('p')?.textContent ?? ''))
  await expectNoBlockingAxe(page)
  await expectNoHorizontalScroll(page)
  await shot(page, testInfo, 'request-types')

  const before = await names()
  const at = before.indexOf(name)
  expect(at).toBeGreaterThan(0)
  const moved = [...before]
  moved.splice(at - 1, 0, ...moved.splice(at, 1))
  await page.getByRole('button', { name: `เลื่อนขึ้น ${name}` }).click()
  await expect(success(page, `ย้าย ${name} แล้ว`)).toBeVisible()
  await expect.poll(names).toEqual(moved)
  await page.getByRole('button', { name: `เลื่อนลง ${name}` }).click()
  await expect.poll(names).toEqual(before)

  const row = list.getByRole('listitem').filter({ hasText: name })
  await row.getByRole('button', { name: `ปิดใช้ประเภทนี้ ${name}` }).click()
  await expect(success(page, `ปิดใช้ ${name} แล้ว ผู้ขอจะไม่เห็นประเภทนี้ในหน้าเริ่มคำขอ คำขอที่ทำไว้แล้วไม่เปลี่ยน`)).toBeVisible()
  await expect(row.getByText('ปิดอยู่', { exact: true })).toBeVisible()
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'request-types-off')
  await row.getByRole('button', { name: `เปิดใช้ประเภทนี้ ${name}` }).click()
  await expect(success(page, `เปิดใช้ ${name} แล้ว ผู้ขอเห็นประเภทนี้ในหน้าเริ่มคำขอ`)).toBeVisible()
  await expect(row.getByText('เปิดใช้', { exact: true })).toBeVisible()
  await expect(row.getByRole('button', { name: `ปิดใช้ประเภทนี้ ${name}` })).toBeVisible()
})

test('[FR-ADM-005/AC1] [FR-ADM-005/AC3] the admin imports a new form version as JSON; requests made before keep their version', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile'
  const type = mobile ? { code: 'HIRE_SERVICE', name: 'จ้างบริการ' } : { code: 'BUY_GOODS', name: 'ซื้อของ' }
  // AC3 needs a request made with the version in use: a draft of this type, made the way the request page makes it
  const requester = mobile ? 'req_con2' : 'req_con'
  const before = scene('draft', requester, type.code) as { requestId: string }
  await signInOrgAdmin(page, testInfo)
  await page.goto('/admin/request-types')
  await page.getByRole('link', { name: `จัดการฟอร์มของ ${type.name}` }).click()
  await expect(page.getByRole('heading', { level: 1, name: type.name })).toBeVisible()
  const currentHeading = page.getByRole('heading', { level: 2, name: /^ฟอร์มที่ใช้อยู่ \(ฉบับ \d+\)$/ })
  const current = Number(/ฉบับ (\d+)/.exec((await currentHeading.textContent()) ?? '')![1])
  const next = current + 1
  const versions = page.getByRole('region', { name: 'ประวัติฉบับของฟอร์ม' })
  const version = (no: number) => versions.getByRole('listitem').filter({ hasText: new RegExp(`^ฉบับ ${no}(?!\\d)`) })
  await expect(version(current)).toContainText('ฉบับที่ใช้อยู่')
  const usedBefore = Number(/ใช้กับคำขอ (\d+) รายการ/.exec((await version(current).textContent()) ?? '')![1])
  expect(usedBefore).toBeGreaterThan(0)
  await expectNoBlockingAxe(page)
  await expectNoHorizontalScroll(page)
  await shot(page, testInfo, 'form')

  // The JSON of the form in use, to edit
  const response = await page.request.get(`/admin/request-types/${type.code}/form`)
  expect(response.status()).toBe(200)
  const form = (await response.json()) as { fields: unknown[] }
  const json = page.getByLabel('JSON ของฟอร์ม')
  const check = page.getByRole('button', { name: 'ตรวจฟอร์ม' })
  await json.fill('{ "fields": [ ')
  await check.click()
  await expect(failure(page, 'อ่าน JSON ไม่ได้ ตรวจวงเล็บ เครื่องหมายคำพูด และจุลภาค')).toBeVisible()
  await json.fill(JSON.stringify({ ...form, fields: [...form.fields, { id: 'badField', type: 'colour' }] }))
  await check.click()
  await expect(failure(page, `fields[${form.fields.length}].type ค่าไม่อยู่ในรายการที่ใช้ได้`)).toBeVisible()
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'form-problems')

  // A good form: what changes, then a tick box before it is published (it cannot be undone)
  const fieldId = mobile ? 'siteContactMobile' : 'siteContactDesktop'
  await json.fill(JSON.stringify({ ...form, fields: [...form.fields, { id: fieldId, type: 'text', label: { th: 'ผู้ติดต่อหน้างาน', en: 'Site contact' } }] }, null, 2))
  await check.click()
  await expect(success(page, `ฟอร์มถูกต้อง จะเผยแพร่เป็นฉบับ ${next}`)).toBeVisible()
  await expect(page.getByText(`เพิ่มช่อง ${fieldId}`)).toBeVisible()
  const publish = page.getByRole('button', { name: `เผยแพร่ฟอร์มฉบับ ${next}` })
  await publish.click()
  await expect(page.getByText('ติ๊กช่องยืนยันก่อนเผยแพร่')).toBeVisible()
  await page.getByLabel(`ยืนยันเผยแพร่เป็นฉบับ ${next} คำขอใหม่จะใช้ฟอร์มนี้ คำขอที่ทำไว้แล้วยังใช้ฉบับเดิม`).check()
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'form-checked')
  await publish.click()
  await expect(success(page, `เผยแพร่ฟอร์มฉบับ ${next} แล้ว คำขอใหม่ใช้ฟอร์มนี้ตั้งแต่ตอนนี้`)).toBeVisible()
  await expect(page.getByRole('heading', { level: 2, name: `ฟอร์มที่ใช้อยู่ (ฉบับ ${next})` })).toBeVisible()
  await expect(page.getByText('ผู้ติดต่อหน้างาน', { exact: true })).toBeVisible()

  // AC3: the earlier version keeps the requests made with it; the new one has none yet
  await expect(version(next)).toContainText('ฉบับที่ใช้อยู่')
  await expect(version(next)).toContainText('ใช้กับคำขอ 0 รายการ')
  await expect(version(current)).not.toContainText('ฉบับที่ใช้อยู่')
  await expect(version(current)).toContainText(`ใช้กับคำขอ ${usedBefore} รายการ`)
  await expectNoHorizontalScroll(page)
  await shot(page, testInfo, 'form-published')
  // The draft made before still opens with the form it was made with: same version, no new field
  expect(scene('form', requester, before.requestId)).toEqual({ versionNo: current, fields: (form.fields as Array<{ id: string }>).map((f) => f.id) })

  // A code that cannot be a request type is "not found", never an error page
  expect((await page.goto('/admin/request-types/%25'))?.status()).toBe(404)
  expect((await page.request.get('/admin/request-types/%25/form')).status()).toBe(404)
})

test('[FR-ADM-003/AC1] [FR-ADM-004/AC1] [FR-ADM-005/AC2] a member without the admin capabilities gets none of the settings pages', async ({ page }, testInfo) => {
  await signIn(page, testInfo.project.name === 'mobile' ? 'req_con2' : 'req_con', false)
  for (const path of ['/admin/calendar', '/admin/numbering', '/admin/request-types', '/admin/request-types/BUY_GOODS']) {
    await page.goto(path)
    await expect(page.getByRole('alert').filter({ hasText: 'หน้านี้สำหรับผู้ดูแลองค์กร' })).toBeVisible()
    await expect(page.locator('main form')).toHaveCount(0)
  }
  await expectNoBlockingAxe(page)
  expect((await page.request.get('/admin/calendar/template')).status()).toBe(403)
  expect((await page.request.get('/admin/request-types/BUY_GOODS/form')).status()).toBe(403)
})
