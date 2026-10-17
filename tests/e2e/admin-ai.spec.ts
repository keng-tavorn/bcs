import AxeBuilder from '@axe-core/playwright'
import { type Page, type TestInfo } from '@playwright/test'
import { deriveSeedTotpSecret, totp } from '../../src/lib/totp'
import { E2E_PLATFORM_ADMIN } from './platform-admin'
import { expect, test } from './fixtures'
import { settled } from './settled'

// S13-04 (docs/sub-specs/S13.md "หน้าจอ" and "ฐานของโมดูล" AC1 AC2): the organization admin switches AI assistants and
// sets the lowest confidence at /admin/ai; the BCS team grants AI credits with a contract reference at
// /platform/tenants/[orgId]/ai. The demo organization keeps the AI module off (the @demo scenes do not change), so the
// admin page says so and still saves the settings. Each project changes its own agent. Screenshots at 375 px and
// 1440 px go to the test output and axe runs on each page (§9.9 step 4).

async function expectNoBlockingAxe(page: Page) {
  await page.waitForFunction(() => document.title !== '', undefined, { timeout: 5_000 }).catch(() => undefined)
  await settled(page)
  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(blocking.map((v) => `${v.id}: ${v.help}`)).toEqual([])
}

async function shot(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })
}

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

const success = (page: Page, text: string | RegExp) => page.getByRole('status').filter({ hasText: text })

test('[BR-AI-05] the organization admin switches an AI assistant and sets its lowest confidence; others are refused', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile'
  const code = mobile ? 'admin2' : 'admin'
  const agent = mobile ? 'ผู้ช่วยร่าง DOA จากระเบียบ' : 'ผู้ช่วยกรอกคำขอ'
  await signIn(page, `${code}@demo.bcs.local`, code)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('สวัสดี')
  await page.goto('/admin/ai')
  await expect(page.getByRole('heading', { level: 1, name: 'ผู้ช่วย AI' })).toBeVisible()
  await expect(page.getByText('องค์กรยังไม่ได้เปิดโมดูล AI')).toBeVisible()
  await expect(page.getByRole('region', { name: 'credits ของเดือนนี้' })).toBeVisible()

  const row = page.getByRole('listitem').filter({ hasText: agent })
  const toggle = row.getByRole('switch', { name: agent })
  const wasOn = (await toggle.getAttribute('aria-checked')) === 'true'
  await toggle.click()
  await expect(success(page, wasOn ? `ปิด${agent}แล้ว` : `เปิด${agent}แล้ว`)).toBeVisible()
  await expect(row.getByRole('switch', { name: agent })).toHaveAttribute('aria-checked', wasOn ? 'false' : 'true')

  const confidence = row.getByLabel('ความมั่นใจขั้นต่ำ (%)')
  await confidence.fill('101')
  await row.getByRole('button', { name: 'บันทึกความมั่นใจขั้นต่ำ' }).click()
  await expect(row.getByText('ใส่ตัวเลข 0 ถึง 100')).toBeVisible()
  await confidence.fill(mobile ? '80' : '85')
  await row.getByRole('button', { name: 'บันทึกความมั่นใจขั้นต่ำ' }).click()
  await expect(success(page, `บันทึกความมั่นใจขั้นต่ำของ${agent}แล้ว`)).toBeVisible()
  await page.reload()
  await expect(page.getByRole('listitem').filter({ hasText: agent }).getByLabel('ความมั่นใจขั้นต่ำ (%)')).toHaveValue(mobile ? '80' : '85')
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'admin-ai')

  // A member who is not ORG_ADMIN is refused by the service, whatever the screen shows
  await page.context().clearCookies()
  await signIn(page, 'req_con@demo.bcs.local', null)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('สวัสดี')
  await page.goto('/admin/ai')
  await expect(page.getByRole('alert').filter({ hasText: 'หน้านี้สำหรับผู้ดูแลองค์กร' })).toBeVisible()
  await expect(page.getByRole('switch')).toHaveCount(0)
})

test('[BR-AI-23] the BCS team grants AI credits with a contract reference and sees the month without business data', async ({ page }, testInfo) => {
  const contractRef = `E2E-AI-${testInfo.project.name.toUpperCase()}`
  await signIn(page, E2E_PLATFORM_ADMIN.email, E2E_PLATFORM_ADMIN.code)
  await expect(page).toHaveURL(/\/platform\/tenants$/)
  await page.getByRole('link', { name: /^credits ของ AI ของ / }).first().click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('credits ของ AI ของ')

  await page.getByRole('button', { name: 'บันทึก credits' }).click()
  await expect(page.getByText('ใส่จำนวน credits เป็นจำนวนเต็มบวกอย่างน้อยหนึ่งช่อง')).toBeVisible()
  await expect(page.getByText('ใส่เลขอ้างอิงสัญญา', { exact: true })).toBeVisible()
  await page.getByLabel('เพิ่ม credits ให้เดือนนี้').fill('500')
  await page.getByLabel('เลขอ้างอิงสัญญา').fill(contractRef)
  await page.getByLabel('เหตุผล (เก็บในประวัติ)').fill('ทดลองใช้ AI ตามสัญญา')
  await page.getByRole('button', { name: 'บันทึก credits' }).click()
  await expect(success(page, 'บันทึก credits แล้ว')).toBeVisible()
  // a row of the table on a computer, a row of the list on a phone (P1-09)
  const grant = page.getByRole('row').or(page.getByRole('listitem')).filter({ hasText: contractRef })
  await expect(grant).toContainText('เพิ่มโดยทีม BCS')
  await expect(grant).toContainText('500')
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'platform-ai')
})
