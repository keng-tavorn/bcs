import { type Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { checkScreen, settleNoticesAfterEachTest, signInAs } from './insight-support'

settleNoticesAfterEachTest(test)

// S16-03 · FR-PLT-014 AC1 (§9.10 "ค้นหาและคำสั่ง ⌘K"): from any page, Ctrl K (⌘K on a Mac) or a click on the search
// field opens one palette; it is worked with the keyboard alone — type, ↑ ↓ to choose, Enter to open, Esc to close. The
// screens' database has the seed's suppliers and no history, so a supplier, a page and a command are what it finds here;
// that documents are found only in scope is tests/integration/search.test.ts on the seed with Demo_History.

const DIALOG = 'ค้นหาและคำสั่ง'

/**
 * The shortcut works once the page's script runs: the search field announces it (aria-keyshortcuts) only then. A key
 * pressed while the server's HTML still shows goes to the browser, which a slow machine (CI) shows right after goto.
 */
const shortcutReady = (page: Page) => expect(page.locator('[aria-haspopup="dialog"][aria-keyshortcuts]')).toBeAttached()

test('[FR-PLT-014/AC1] Ctrl K opens the palette on any page; the keyboard alone finds and opens a supplier, a page and a command, and Esc closes it', async ({ page }, testInfo) => {
  await signInAs(page, 'req_con', false)
  await page.goto('/requests')
  await shortcutReady(page)
  const dialog = page.getByRole('dialog', { name: DIALOG })

  // A supplier: typed, the first result chosen, Enter opens its page
  await page.keyboard.press('ControlOrMeta+k')
  await expect(dialog).toBeVisible()
  const input = dialog.getByRole('combobox')
  await expect(input).toBeFocused()
  await page.keyboard.type('ไอที')
  await expect(dialog.getByRole('group', { name: 'ผู้ขาย' }).getByRole('option', { name: 'บริษัท ไอทีทดสอบ จำกัด · S2' })).toBeVisible()
  await checkScreen(page, testInfo, 'search-palette')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/suppliers\/[0-9a-f-]{36}$/)
  await expect(dialog).toBeHidden()

  // A page of the menu: ↓ moves the choice, Enter opens it
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('คำขอ')
  const pages = dialog.getByRole('group', { name: 'ไปที่หน้า' })
  await expect(pages.getByRole('option').first()).toBeVisible()
  const options = dialog.getByRole('option')
  await expect(options.first()).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowDown')
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowUp')
  await expect(options.first()).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  await expect(dialog).toBeHidden()

  // A command, then a search that finds nothing says what to try
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('ตั้งรักษา')
  await expect(dialog.getByRole('group', { name: 'คำสั่ง' }).getByRole('option', { name: 'ตั้งรักษาการ' })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/settings\/delegation$/)

  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('ไม่มีสิ่งนี้แน่นอน')
  await expect(dialog.getByText('ไม่พบผลลัพธ์ ลองพิมพ์เลขเอกสารบางส่วน')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  // The search field opens the same palette, empty again
  await page.getByRole('button', { name: /ค้นหา/ }).click()
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('combobox')).toHaveValue('')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})

test('[FR-PLT-014/AC1] the shortcut works with the Thai keyboard layout on, and closing with it opens empty next time', async ({ page }) => {
  await signInAs(page, 'req_con', false)
  await page.goto('/')
  await shortcutReady(page)
  const dialog = page.getByRole('dialog', { name: DIALOG })
  // With the Thai layout the K key types "า": the physical key (code KeyK) is what counts
  const thaiShortcut = () =>
    page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'า', code: 'KeyK', ctrlKey: true, bubbles: true, cancelable: true })))
  await thaiShortcut()
  await expect(dialog).toBeVisible()
  await page.keyboard.type('ไอที')
  await expect(dialog.getByRole('option', { name: 'บริษัท ไอทีทดสอบ จำกัด · S2' })).toBeVisible()
  await thaiShortcut()
  await expect(dialog).toBeHidden()
  await page.keyboard.press('Control+k')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('combobox')).toHaveValue('')
})

test('[FR-PLT-014/AC2] /api/search answers 401 without a session', async ({ request }) => {
  const response = await request.get('/api/search?q=PR')
  expect(response.status()).toBe(401)
})
