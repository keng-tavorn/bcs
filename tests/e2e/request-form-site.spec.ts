import { spawnSync } from 'node:child_process'
import { type Page, type TestInfo } from '@playwright/test'
import { e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'
import { expectNoBlockingAxe, shot, signIn } from './tasks-support'

// FR-INT-003 AC1 and AC3 (owned by S4-02, BR-FORM-02): a new purchase form starts with the delivery site of the
// requester's latest request — and the department, cost center and budget line as before — and the requester changes
// it; they may suggest a supplier from the register; the draft keeps both and the request's page shows them; a general
// purchase still asks the requester to type at most 6 fields. Each Playwright project has its own requester.
// Screenshots at 375 px (mobile) and 1440 px (desktop) go to the test output (§9.9 step 4), with axe (step 5).

function scene<T>(...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/suppliers-scene.ts ${args.map((a) => `"${a}"`).join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`supplier scene failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}

/** §9.9 and FR-INT-002 AC3: nothing makes the page scroll sideways */
async function expectNoSidewaysScroll(page: Page) {
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }))
  expect(scroll).toBeLessThanOrEqual(client)
}

async function check(page: Page, testInfo: TestInfo, name: string) {
  await expectNoSidewaysScroll(page)
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, name)
}

const nextStep = (page: Page, name: string) => page.getByRole('button', { name: `ไปขั้นถัดไป: ${name}` }).click()
const stepHeading = (page: Page, n: number, name: string) => expect(page.getByRole('heading', { level: 2, name: `ขั้นที่ ${n} จาก 4: ${name}` })).toBeVisible()
const status = (page: Page, text: string | RegExp) => page.getByRole('status').filter({ hasText: text })

/** Empty controls the requester must fill on the step shown (FR-INT-003 AC3) */
async function emptyRequired(page: Page): Promise<number> {
  return page.locator('main [aria-required="true"]').evaluateAll((els) => els.filter((e) => (e as HTMLInputElement).value === '').length)
}

test('@demo [FR-INT-003/AC1] [FR-INT-003/AC3] the form fills the delivery site from the requester’s latest request; the requester changes it, suggests a supplier, and the request shows both', async ({
  page,
}, testInfo) => {
  const requester = testInfo.project.name === 'mobile' ? 'asst_con' : 'req_con2'
  // The requester's latest request names SITE-B (a draft made through the services)
  scene('site-draft', requester, 'SITE-B')
  await signIn(page, requester, false)
  await page.goto('/requests/new/BUY_GOODS')
  await stepHeading(page, 1, 'รายละเอียดคำขอ')
  // The department and cost center follow the budget line (BR-FORM-02), as before
  await expect(page.getByText('ฝ่ายก่อสร้าง', { exact: true })).toBeVisible()
  let typed = await emptyRequired(page)
  await page.getByLabel('ชื่อคำขอ').fill(`ไม้แบบและตะปู (${testInfo.project.name})`)
  await page.getByLabel('บรรทัดงบที่ใช้').selectOption({ label: 'CON-OPEX-2569 · ค่าใช้จ่ายดำเนินงาน ฝ่ายก่อสร้าง' })

  await nextStep(page, 'รายการที่ขอ')
  await stepHeading(page, 2, 'รายการที่ขอ')
  typed += await emptyRequired(page)
  // BR-FORM-02 "สถานที่ส่งล่าสุด": filled in, with its address, and not a field the requester must type
  const site = page.getByLabel('สถานที่ส่ง')
  await expect(site.locator('option:checked')).toHaveText('SITE-B · ไซต์งานตัวอย่าง B')
  await expect(site).not.toHaveAttribute('aria-required', 'true')
  await expect(page.getByText('ระบบเติมให้แล้ว เปลี่ยนได้ถ้าครั้งนี้ส่งที่อื่น')).toBeVisible()
  await expect(page.getByText('ที่อยู่: ไซต์ก่อสร้างสมมติ B')).toBeVisible()
  await check(page, testInfo, 'form-site-prefilled')
  // The requester changes it
  await site.selectOption({ label: 'SITE-A · ไซต์งานตัวอย่าง A' })
  await expect(page.getByText('ที่อยู่: ไซต์ก่อสร้างสมมติ A')).toBeVisible()
  const item = page.getByRole('group', { name: 'รายการที่ 1' })
  await item.getByLabel('สิ่งที่ขอ').fill('ไม้อัด')
  await item.getByLabel(/^จำนวน/).fill('20')
  await item.getByLabel(/^หน่วย/).fill('แผ่น')
  await item.getByLabel(/^ราคาต่อหน่วย/).fill('450')

  await nextStep(page, 'ใบเสนอราคาและเอกสาร')
  typed += await emptyRequired(page)
  // FR-INT-003 AC3: title, then item, quantity, unit and price; the site and the supplier are not asked for
  expect(typed).toBeLessThanOrEqual(6)
  const suggestion = page.getByRole('region', { name: 'ผู้ขายที่แนะนำ' })
  const supplier = suggestion.getByLabel('ผู้ขายในทะเบียน (ไม่บังคับ)')
  await expect(supplier.locator('option:checked')).toHaveText('ไม่ระบุ')
  await supplier.selectOption({ label: 'S1 · บริษัท วัสดุก่อสร้างทดสอบ จำกัด' })
  await expect(suggestion).toContainText('ฝ่ายจัดซื้อเป็นผู้เลือกผู้ขายจริงของแต่ละรายการ')
  await check(page, testInfo, 'form-supplier')

  await nextStep(page, 'ตรวจและส่ง')
  const summary = page.getByRole('region', { name: 'สรุปคำขอ' })
  await expect(summary).toContainText('SITE-A · ไซต์งานตัวอย่าง A')
  await expect(summary).toContainText('S1 · บริษัท วัสดุก่อสร้างทดสอบ จำกัด')
  await check(page, testInfo, 'form-review-site')

  // The draft keeps both, on any device
  await page.getByRole('button', { name: 'บันทึกร่างตอนนี้' }).click()
  await expect(status(page, /^บันทึกร่างแล้ว/)).toBeVisible()
  await expect(page).toHaveURL(/\/requests\/[0-9a-f-]{36}\/edit$/)
  const requestId = /\/requests\/([0-9a-f-]{36})\/edit$/.exec(page.url())![1]!
  await page.reload()
  await nextStep(page, 'รายการที่ขอ')
  await expect(page.getByLabel('สถานที่ส่ง').locator('option:checked')).toHaveText('SITE-A · ไซต์งานตัวอย่าง A')
  await nextStep(page, 'ใบเสนอราคาและเอกสาร')
  await expect(page.getByLabel('ผู้ขายในทะเบียน (ไม่บังคับ)').locator('option:checked')).toHaveText('S1 · บริษัท วัสดุก่อสร้างทดสอบ จำกัด')

  // The request's page names them with the request's other facts
  await page.goto(`/requests/${requestId}`)
  const facts = page.locator('#content dl').filter({ hasText: 'สถานที่ส่ง' })
  await expect(facts).toContainText('SITE-A · ไซต์งานตัวอย่าง A')
  await expect(facts).toContainText('ไซต์ก่อสร้างสมมติ A')
  await expect(facts).toContainText('ผู้ขายที่แนะนำ')
  await expect(facts).toContainText('S1 · บริษัท วัสดุก่อสร้างทดสอบ จำกัด')
  await check(page, testInfo, 'request-site-supplier')
})
