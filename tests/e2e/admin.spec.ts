import AxeBuilder from '@axe-core/playwright'
import { type Browser, type Page, type TestInfo } from '@playwright/test'
import ExcelJS from 'exceljs'
import { deriveSeedTotpSecret, totp } from '../../src/lib/totp'
import { E2E_BASE_URL } from '../support/e2e-env'
import { E2E_PLATFORM_ADMIN } from './platform-admin'
import { expect, test } from './fixtures'

// S1-12: members and roles (FR-ADM-001 S1), modules for the organization admin and for the BCS team (FR-ADM-006 AC1,
// FR-PLT-011). Each project changes its own records (e-mails and modules per project) so desktop and mobile never
// collide in the shared e2e database. Screenshots at 375 px and 1440 px go to the test output (§9.9 step 4).

async function expectNoBlockingAxe(page: Page) {
  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(blocking.map((v) => `${v.id}: ${v.help}`)).toEqual([])
}

async function shot(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })
}

/** Signs in with password and the TOTP derived from SEED_TOTP_KEY, as the presenter's phone would. */
async function signIn(page: Page, email: string, totpCode: string | null) {
  await page.goto('/login')
  await page.getByLabel('อีเมลบริษัท').fill(email)
  await page.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
  if (totpCode === null) return
  await expect(page).toHaveURL(/\/login\/2fa$/)
  await page.getByLabel('รหัส 6 หลักจากแอป').fill(totp(deriveSeedTotpSecret(process.env.SEED_TOTP_KEY!, totpCode)))
  await page.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' }).click()
}

/** The organization admin of this project (two seeded admins, one per viewport). */
async function signInOrgAdmin(page: Page, testInfo: TestInfo) {
  const code = testInfo.project.name === 'mobile' ? 'admin2' : 'admin'
  await signIn(page, `${code}@demo.bcs.local`, code)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('สวัสดี')
}

async function signInPlatform(page: Page) {
  await signIn(page, E2E_PLATFORM_ADMIN.email, E2E_PLATFORM_ADMIN.code)
  await expect(page).toHaveURL(/\/platform\/tenants$/)
}

async function openMenuItem(page: Page, isMobile: boolean, name: string) {
  if (isMobile) {
    const menu = page.locator('header details')
    if (!(await menu.evaluate((d) => (d as HTMLDetailsElement).open))) await page.getByText('เมนู', { exact: true }).click()
  }
  await page.getByRole('navigation', { name: 'เมนูหลัก' }).getByRole('link', { name }).click()
}

const success = (page: Page, text: string | RegExp) => page.getByRole('status').filter({ hasText: text })
const failure = (page: Page, text: string | RegExp) => page.getByRole('alert').filter({ hasText: text })

async function importFile(page: Page, testInfo: TestInfo, name: string, rows: Array<Record<string, string>>): Promise<string> {
  const response = await page.request.get('/admin/members/template')
  expect(response.status()).toBe(200)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(new Uint8Array(await response.body()).buffer as ArrayBuffer)
  const sheet = workbook.getWorksheet('Members')!
  const keys = (sheet.getRow(1).values as unknown[]).slice(1).map(String)
  for (const row of rows) sheet.addRow(keys.map((k) => row[k] ?? ''))
  const file = testInfo.outputPath(name)
  await workbook.xlsx.writeFile(file)
  return file
}

test('[FR-ADM-001/AC1] an organization admin invites a member, grants and revokes a role, then deactivates them', async ({ page, isMobile }, testInfo) => {
  const project = testInfo.project.name
  await signInOrgAdmin(page, testInfo)
  await openMenuItem(page, isMobile, 'สมาชิกและบทบาท')
  await expect(page.getByRole('heading', { level: 1, name: 'สมาชิกและบทบาท' })).toBeVisible()
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'members')

  const email = `e2e-${project}-invite@demo.bcs.local`
  const name = `ทดสอบ เชิญ ${project}`
  await page.getByRole('button', { name: 'ส่งคำเชิญทางอีเมล' }).click()
  await expect(page.getByText('ใส่อีเมลให้ถูกรูปแบบ เช่น name@company.co.th')).toBeVisible()
  await page.getByLabel('อีเมลบริษัท').fill(email)
  await page.getByLabel('ชื่อที่แสดง (ไทย)').fill(name)
  await page.getByLabel('ผู้ตรวจรับ').check()
  await page.getByRole('button', { name: 'ส่งคำเชิญทางอีเมล' }).click()
  await expect(success(page, `ส่งคำเชิญไปที่ ${email} แล้ว`)).toBeVisible()

  const row = page.getByRole('listitem').filter({ hasText: email })
  await expect(row).toContainText('รอตอบรับคำเชิญ')
  await expect(row).toContainText('ผู้ตรวจรับ')
  await row.getByRole('link', { name: `จัดการ ${name}` }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name)

  await page.getByLabel('มอบบทบาท').selectOption({ label: 'จัดซื้อ' })
  await page.getByRole('button', { name: 'มอบบทบาท', exact: true }).click()
  await expect(success(page, 'มอบบทบาทแล้ว')).toBeVisible()
  await expect(page.getByRole('button', { name: 'ถอนบทบาท จัดซื้อ' })).toBeVisible()
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'member')
  await page.getByRole('button', { name: 'ถอนบทบาท จัดซื้อ' }).click()
  await expect(success(page, 'ถอนบทบาทแล้ว')).toBeVisible()
  await expect(page.getByRole('button', { name: 'ถอนบทบาท จัดซื้อ' })).toHaveCount(0)

  // Deactivation cannot be undone from this page: it needs a reason and an explicit confirmation (§9.9)
  const deactivate = page.getByRole('button', { name: 'ปิดใช้งานสมาชิก', exact: true })
  await deactivate.click()
  await expect(page.getByText('ใส่เหตุผลอย่างน้อย 3 ตัวอักษร')).toBeVisible()
  await page.getByLabel('เหตุผล (บันทึกในประวัติ)').fill('ทดสอบปิดใช้งาน')
  await deactivate.click()
  await expect(page.getByText('ติ๊กช่องยืนยันก่อนทำรายการนี้')).toBeVisible()
  await page.getByLabel('ยืนยันว่าต้องการปิดใช้งานสมาชิกคนนี้').check()
  await deactivate.click()
  // The deactivate form goes away with the member's access; the page confirms with the button's own words (§9.9 rule 7)
  await expect(success(page, 'ปิดใช้งานสมาชิกแล้ว')).toBeVisible()
  await expect(page.getByRole('button', { name: 'ปิดใช้งานสมาชิก', exact: true })).toHaveCount(0)
  await shot(page, testInfo, 'member-deactivated')
})

test('[FR-ADM-001/AC2] an administrator sees that they cannot grant a role to themselves', async ({ page, isMobile }, testInfo) => {
  await signInOrgAdmin(page, testInfo)
  await openMenuItem(page, isMobile, 'สมาชิกและบทบาท')
  await page.getByRole('listitem').filter({ hasText: '(คุณ)' }).getByRole('link', { name: /^จัดการ / }).click()
  await expect(page.getByText('มอบบทบาทให้ตัวเองไม่ได้ ให้ผู้ดูแลอีกคนเป็นผู้มอบ')).toBeVisible()
  await expect(page.getByRole('button', { name: 'มอบบทบาท', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'ปิดใช้งานสมาชิก', exact: true })).toHaveCount(0)
  await expectNoBlockingAxe(page)
})

test('[FR-ADM-001/AC3] importing from the Excel template lists every wrong row and saves nothing until the file is right', async ({ page }, testInfo) => {
  const project = testInfo.project.name
  await signInOrgAdmin(page, testInfo)
  await page.goto('/admin/members')
  const good = [
    { email: `e2e-${project}-import1@demo.bcs.local`, displayNameTh: `นำเข้า หนึ่ง ${project}`, roles: 'RECEIVER' },
    { email: `e2e-${project}-import2@demo.bcs.local`, displayNameTh: `นำเข้า สอง ${project}`, roles: '' },
  ]
  const bad = await importFile(page, testInfo, 'import-bad.xlsx', [good[0]!, { email: 'not-an-email', displayNameTh: '' }])
  await page.getByLabel('ไฟล์ Excel ที่กรอกแล้ว').setInputFiles(bad)
  await page.getByRole('button', { name: 'นำเข้าและส่งคำเชิญ' }).click()
  const errors = failure(page, 'ยังไม่ได้บันทึก แก้แถวเหล่านี้แล้วนำเข้าอีกครั้ง')
  await expect(errors).toContainText('แถว 4 · อีเมล · อีเมลไม่ถูกรูปแบบ')
  await expect(errors).toContainText('แถว 4 · ชื่อ (ไทย) · ต้องกรอก')
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'import-errors')
  // A refusal does not redraw the list, so read it again from the server: nothing was saved
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: 'สมาชิกและบทบาท' })).toBeVisible()
  await expect(page.getByRole('listitem').filter({ hasText: good[0]!.email })).toHaveCount(0)

  const fixed = await importFile(page, testInfo, 'import-good.xlsx', good)
  await page.getByLabel('ไฟล์ Excel ที่กรอกแล้ว').setInputFiles(fixed)
  await page.getByRole('button', { name: 'นำเข้าและส่งคำเชิญ' }).click()
  await expect(success(page, 'นำเข้าแล้ว 2 คน และส่งคำเชิญทางอีเมลครบทุกคนแล้ว')).toBeVisible()
  for (const member of good) await expect(page.getByRole('listitem').filter({ hasText: member.email })).toContainText('รอตอบรับคำเชิญ')
})

test('[FR-ADM-001/AC1] members without admin.members get no member list and the BCS area stays hidden', async ({ page }) => {
  await signIn(page, 'req_con@demo.bcs.local', null)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('สวัสดี')
  await page.goto('/admin/members')
  await expect(page.getByRole('alert').filter({ hasText: 'หน้านี้สำหรับผู้ดูแลองค์กร' })).toBeVisible()
  await expect(page.getByRole('link', { name: /^จัดการ / })).toHaveCount(0)
  const response = await page.goto('/platform/tenants')
  expect(response?.status()).toBe(404)
})

async function orgAdminModulesPage(browser: Browser, testInfo: TestInfo, clientIp: string): Promise<Page> {
  const context = await browser.newContext({ ...testInfo.project.use, baseURL: E2E_BASE_URL, extraHTTPHeaders: { 'x-forwarded-for': clientIp } })
  const page = await context.newPage()
  await signInOrgAdmin(page, testInfo)
  await page.goto('/admin/modules')
  await expect(page.getByRole('heading', { level: 1, name: 'โมดูลที่เปิดใช้' })).toBeVisible()
  return page
}

test('[FR-ADM-006/AC1] the BCS team switches a module with a contract reference and a reason; the organization admin sees it read-only', async ({ page, browser, clientIp }, testInfo) => {
  // Customer screens show the module name alone; the BCS team's page adds the code (รหัส …) beside it
  const [moduleName, code] = testInfo.project.name === 'mobile' ? ['สัญญา', 'CONTRACTS'] : ['จ่ายเงิน', 'PAY']
  const contractRef = `E2E-${testInfo.project.name.toUpperCase()}-001`
  await signInPlatform(page)
  await expect(page.getByRole('heading', { level: 1, name: 'องค์กรลูกค้า' })).toBeVisible()
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'platform-tenants')
  await page.getByRole('link', { name: /^จัดการโมดูลของ / }).first().click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('โมดูลของ')
  await expect(page.getByText('ระบบหลักเปิดเสมอ ปิดไม่ได้')).toBeVisible()

  const item = page.getByRole('listitem').filter({ hasText: `รหัส ${code}` })
  await item.getByText(`เปิดโมดูล ${moduleName}`, { exact: true }).click()
  await item.getByRole('button', { name: `ยืนยันเปิดโมดูล ${moduleName}` }).click()
  await expect(item.getByText('ใส่เลขอ้างอิงสัญญา')).toBeVisible()
  await expect(item.getByText('ใส่เหตุผลอย่างน้อย 3 ตัวอักษร')).toBeVisible()
  await item.getByLabel('เลขอ้างอิงสัญญา').fill(contractRef)
  await item.getByLabel('เหตุผล (บันทึกในประวัติ)').fill('ลูกค้าซื้อโมดูลเพิ่มตามสัญญา')
  await item.getByRole('button', { name: `ยืนยันเปิดโมดูล ${moduleName}` }).click()
  await expect(success(page, `เปิดโมดูล ${moduleName} แล้ว ผู้ดูแลองค์กรจะได้รับแจ้ง`)).toBeVisible()
  await expect(item).toContainText(`อ้างอิงสัญญา ${contractRef}`)
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'platform-modules')

  const orgAdmin = await orgAdminModulesPage(browser, testInfo, clientIp)
  const row = orgAdmin.getByRole('listitem').filter({ has: orgAdmin.getByText(moduleName, { exact: true }) })
  await expect(row).toContainText('เปิดใช้')
  await expect(row).toContainText(`อ้างอิงสัญญา ${contractRef}`)
  await expect(orgAdmin.locator('main form')).toHaveCount(0)
  await expectNoBlockingAxe(orgAdmin)
  await shot(orgAdmin, testInfo, 'admin-modules')
  await orgAdmin.context().close()

  // Switch it off again: same rules, and the data stays
  const on = page.getByRole('listitem').filter({ hasText: `รหัส ${code}` })
  await on.getByText(`ปิดโมดูล ${moduleName}`, { exact: true }).click()
  await on.getByLabel('เลขอ้างอิงสัญญา').fill(contractRef)
  await on.getByLabel('เหตุผล (บันทึกในประวัติ)').fill('จบการทดสอบ')
  await on.getByRole('button', { name: `ยืนยันปิดโมดูล ${moduleName}` }).click()
  await expect(success(page, `ปิดโมดูล ${moduleName} แล้ว ผู้ดูแลองค์กรจะได้รับแจ้ง`)).toBeVisible()
})

test('[FR-PLT-011/AC2] switching on a module whose dependency is off is refused and names the missing module', async ({ page }, testInfo) => {
  const [moduleName, code] = testInfo.project.name === 'mobile' ? ['ประเมินความเสี่ยงผู้ขาย', 'RISK'] : ['จัดหาและเปรียบเทียบราคา', 'SOURCING']
  await signInPlatform(page)
  await page.getByRole('link', { name: /^จัดการโมดูลของ / }).first().click()
  const item = page.getByRole('listitem').filter({ hasText: `รหัส ${code}` })
  await item.getByText(`เปิดโมดูล ${moduleName}`, { exact: true }).click()
  await item.getByLabel('เลขอ้างอิงสัญญา').fill('E2E-DEP-001')
  await item.getByLabel('เหตุผล (บันทึกในประวัติ)').fill('ทดสอบโมดูลที่ต้องพึ่งโมดูลอื่น')
  await item.getByRole('button', { name: `ยืนยันเปิดโมดูล ${moduleName}` }).click()
  await expect(failure(page, 'ต้องเปิด พอร์ทัลผู้ขาย ก่อน แล้วจึงเปิดโมดูลนี้')).toBeVisible()
  await expectNoBlockingAxe(page)
  // A refusal does not redraw the list, so read it again from the server: the module is still off
  await page.reload()
  await expect(page.getByRole('listitem').filter({ hasText: `รหัส ${code}` })).toContainText('ปิดอยู่')
})
