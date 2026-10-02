import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

// Smoke test for the S1-01 scaffold: the app serves Thai by default and has no serious/critical
// accessibility violations (NFR-A11Y-01). Feature e2e tests arrive with their checklist items.
test('home page renders in Thai and passes axe', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('html')).toHaveAttribute('lang', 'th')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('BCS')
  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(blocking.map((v) => `${v.id}: ${v.help}`)).toEqual([])
})
