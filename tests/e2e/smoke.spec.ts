import AxeBuilder from '@axe-core/playwright'
import { expect, test } from './fixtures'

// Smoke test: the app serves Thai by default, sends visitors who are not signed in to the sign-in page, and that
// page has no serious/critical accessibility violations (NFR-A11Y-01).
test('home sends anonymous visitors to sign in, in Thai, and passes axe', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.locator('html')).toHaveAttribute('lang', 'th')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('เข้าสู่ระบบ')
  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(blocking.map((v) => `${v.id}: ${v.help}`)).toEqual([])
})
