import AxeBuilder from '@axe-core/playwright'
import { type Page } from '@playwright/test'
import { expect, test } from './fixtures'

// S16-02 · FR-PLT-013 AC1 · §9.9 step 4–5: the component sheet of the workspace (/dev/ui, APP_ENV=local) in a real
// browser at 375 and 1440 px — every shadcn/ui component of §9.10 drawn with the BCS tokens, no page that scrolls
// sideways on a phone, and no axe violation of serious or critical impact, with the page as it loads and with a dialog
// open. The screenshots are kept with the run's results for the design review (S16-12).

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('อีเมลบริษัท').fill('req_con@demo.bcs.local')
  await page.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('สวัสดี')
}

async function blockingViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze()
  return results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
}

for (const width of [375, 1440]) {
  test(`[FR-PLT-013/AC1] /dev/ui draws the components with the tokens at ${width} px, with no axe violation`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    await signIn(page)
    await page.goto('/dev/ui')
    await expect(page.getByRole('heading', { level: 1, name: 'ชุดคอมโพเนนต์ของ Workspace' })).toBeVisible()
    // The chart comes with import() after the page: wait for its bars' table before the picture
    await expect(page.getByRole('cell', { name: 'ก่อสร้าง' })).toBeVisible()

    // The theme's colours on the components: the primary button and a status badge from their tokens
    const primary = page.getByRole('button', { name: 'ส่งขออนุมัติ' })
    await expect(primary).toHaveCSS('background-color', 'rgb(11, 110, 95)')
    await expect(primary).toHaveCSS('color', 'rgb(255, 255, 255)')
    const badge = page.locator('[data-slot="badge"]', { hasText: 'อนุมัติแล้ว' }).first()
    await expect(badge).toHaveCSS('background-color', 'rgb(227, 243, 236)')
    await expect(badge).toHaveCSS('color', 'rgb(10, 94, 80)')
    // No text under 14 px in any component of the sheet
    const small = await page.locator('main [data-slot]').evaluateAll((nodes) =>
      nodes.filter((n) => n.textContent?.trim() && parseFloat(getComputedStyle(n).fontSize) < 14).map((n) => `${n.getAttribute('data-slot')}: ${getComputedStyle(n).fontSize}`),
    )
    expect(small).toEqual([])
    // A focused control draws a solid --focus ring
    await primary.focus()
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Tab')
    await expect(primary).toBeFocused()
    await expect(primary).toHaveCSS('box-shadow', /rgb\(11, 110, 95\)/)

    if (width === 375) expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect(await blockingViolations(page)).toEqual([])
    await page.screenshot({ path: testInfo.outputPath(`dev-ui-${width}.png`), fullPage: true })

    // A dialog opened by a click: its own words, a close button in the reader's language, and still no violation
    await page.getByRole('button', { name: 'เริ่มคำขอใหม่' }).click()
    const dialog = page.getByRole('dialog', { name: 'เลือกประเภทคำขอ' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'ปิด' })).toBeVisible()
    expect(await blockingViolations(page)).toEqual([])
    await page.screenshot({ path: testInfo.outputPath(`dev-ui-dialog-${width}.png`) })
  })
}
