import AxeBuilder from '@axe-core/playwright'
import { type Page } from '@playwright/test'
import { expect, test } from './fixtures'

// S1-09: the workspace shell — Thai by default, English on request (FR-PLT-002 AC2), menu and home page (§9.9).
// req_con has no role, so no 2FA step (FR-AUTH-002 AC1 applies only to roles and DOA positions).

async function expectNoBlockingAxe(page: Page) {
  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(blocking.map((v) => `${v.id}: ${v.help}`)).toEqual([])
}

/** Phones show the menu behind a button; open it only when it is closed (a second click would close it). */
async function openMenuOnPhone(page: Page, isMobile: boolean, label: string) {
  if (!isMobile) return
  // The menu, not the notification bell that shares the phone header
  const menu = page.locator('header details:has(nav)')
  if (!(await menu.evaluate((d) => (d as HTMLDetailsElement).open))) await page.getByText(label, { exact: true }).click()
}

test('[FR-PLT-002/AC2] Thai by default, English on request; the menu lists what the member may open', async ({ page, isMobile }, testInfo) => {
  await page.goto('/login')
  await page.getByLabel('อีเมลบริษัท').fill('req_con@demo.bcs.local')
  await page.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('สวัสดี สมชาย ใจดี')
  await expect(page.getByRole('heading', { level: 2, name: 'งานรอคุณตัดสิน' })).toBeVisible()
  await expectNoBlockingAxe(page)
  await page.screenshot({ path: testInfo.outputPath('home-th.png'), fullPage: true })

  await openMenuOnPhone(page, isMobile, 'เมนู')
  const nav = page.getByRole('navigation', { name: 'เมนูหลัก' })
  await expect(nav.getByRole('link')).toHaveText(['หน้าแรก', 'ขอซื้อ / ขอจ้าง', 'คำขอ', 'งานรออนุมัติ', 'รักษาการ', 'ความปลอดภัยของบัญชี'])
  await expect(nav.getByRole('link', { name: 'หน้าแรก' })).toHaveAttribute('aria-current', 'page')
  await page.screenshot({ path: testInfo.outputPath('menu-th.png'), fullPage: true })

  await page.getByRole('button', { name: 'English' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Hello สมชาย ใจดี')
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expectNoBlockingAxe(page)
  await page.screenshot({ path: testInfo.outputPath('home-en.png'), fullPage: true })

  await openMenuOnPhone(page, isMobile, 'Menu')
  await page.getByRole('button', { name: 'ไทย' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('สวัสดี สมชาย ใจดี')
  await expect(page.locator('html')).toHaveAttribute('lang', 'th')
})

test('[FR-PLT-002/AC1] choosing a page from the menu leaves the page uncovered (on phones the menu panel closes)', async ({ page, isMobile }) => {
  await page.goto('/login')
  await page.getByLabel('อีเมลบริษัท').fill('req_con@demo.bcs.local')
  await page.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('สวัสดี สมชาย ใจดี')
  await openMenuOnPhone(page, isMobile, 'เมนู')
  await page.getByRole('navigation', { name: 'เมนูหลัก' }).getByRole('link', { name: 'ความปลอดภัยของบัญชี' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('ความปลอดภัยของบัญชี')
  if (isMobile) {
    await expect(page.locator('header details:has(nav)')).not.toHaveAttribute('open', '')
    await expect(page.getByRole('navigation', { name: 'เมนูหลัก' })).toBeHidden()
  }
  // Nothing lies over the content: a click on it lands on it (Playwright refuses a click another element intercepts)
  await page.getByRole('heading', { level: 2 }).first().click({ timeout: 3000 })
})
