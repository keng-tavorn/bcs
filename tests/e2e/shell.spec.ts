import AxeBuilder from '@axe-core/playwright'
import { type Page } from '@playwright/test'
import { expect, test } from './fixtures'

// S1-09 and S16-04: the workspace shell — Thai by default, English on request (FR-PLT-002 AC2), the menu of §9.10 and
// the frame of FR-PLT-013 AC2–AC4: a sidebar that collapses to icons (a button or Ctrl B, remembered by the browser,
// collapsed on a document page) and opens as a sheet from the left on a phone; a top bar with the search, the bell, the
// door and the user menu; no page wider than a phone. req_con has no role, so no 2FA step (FR-AUTH-002 AC1).

async function expectNoBlockingAxe(page: Page, where = '') {
  // Next streams the <title> after the first HTML: let it arrive before axe reads the page (a page without one still fails)
  await page.waitForFunction(() => document.title !== '', undefined, { timeout: 5_000 }).catch(() => undefined)
  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(blocking.map((v) => `${v.id}: ${v.help} at ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), where).toEqual([])
}

async function signInAsRequester(page: Page) {
  await page.goto('/login')
  await page.getByLabel('อีเมลบริษัท').fill('req_con@demo.bcs.local')
  await page.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('สวัสดี คุณสมชาย วันนี้ต้องการทำอะไร')
}

/** The user menu: in the top bar from 768 px, at the foot of the menu sheet on a phone (§9.10) */
async function openUserMenu(page: Page, isMobile: boolean, label: string) {
  if (isMobile) return openMenuOnPhone(page, true, label === 'My account' ? 'Collapse or expand the menu' : 'ยุบหรือขยายเมนู')
  // The menu stays open across the language switch (the page is the same): open it only when it is closed
  const menu = page.locator('details', { has: page.locator(`summary[aria-label="${label}"]`) })
  if (!(await menu.evaluate((d) => (d as HTMLDetailsElement).open))) await menu.locator('summary').click()
}

/** Back to the page after a choice in the user menu: a phone's sheet stays open over it */
async function closeUserMenu(page: Page, isMobile: boolean) {
  if (isMobile) await page.keyboard.press('Escape')
}

/** Phones show the menu as a sheet behind the top bar's menu button */
async function openMenuOnPhone(page: Page, isMobile: boolean, label = 'ยุบหรือขยายเมนู') {
  if (!isMobile) return
  await page.getByRole('button', { name: label }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
}

test('[FR-PLT-002/AC2] Thai by default, English on request; the menu lists what the member may open', async ({ page, isMobile }, testInfo) => {
  await signInAsRequester(page)
  await expect(page.getByRole('heading', { level: 2, name: 'รอฉันอนุมัติ' })).toBeVisible()
  await expectNoBlockingAxe(page)
  await page.screenshot({ path: testInfo.outputPath('home-th.png'), fullPage: true })

  await openMenuOnPhone(page, isMobile)
  const nav = page.getByRole('navigation', { name: 'เมนูหลัก' })
  // §9.10 for a member without roles: the main group, suppliers and the pending board, and their own settings
  await expect(nav.getByRole('link')).toHaveText(['หน้าแรก', 'งานอนุมัติ', 'คำขอ', 'ผู้ขาย', 'เอกสารค้าง', 'ตั้งค่าของฉัน'])
  await expect(nav.getByRole('link', { name: 'หน้าแรก' })).toHaveAttribute('aria-current', 'page')
  await page.screenshot({ path: testInfo.outputPath('menu-th.png'), fullPage: true })
  if (isMobile) await page.keyboard.press('Escape')

  await openUserMenu(page, isMobile, 'บัญชีของฉัน')
  await page.getByRole('button', { name: 'English' }).click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await closeUserMenu(page, isMobile)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Hello สมชาย. What would you like to do today?')
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expectNoBlockingAxe(page)
  await page.screenshot({ path: testInfo.outputPath('home-en.png'), fullPage: true })

  await openUserMenu(page, isMobile, 'My account')
  await page.getByRole('button', { name: 'ไทย' }).click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'th')
  await closeUserMenu(page, isMobile)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('สวัสดี คุณสมชาย วันนี้ต้องการทำอะไร')
  await expect(page.locator('html')).toHaveAttribute('lang', 'th')
})

test('[FR-PLT-002/AC1] choosing a page from the menu leaves the page uncovered (on phones the menu sheet closes)', async ({ page, isMobile }) => {
  await signInAsRequester(page)
  await openMenuOnPhone(page, isMobile)
  await page.getByRole('navigation', { name: 'เมนูหลัก' }).getByRole('link', { name: 'ตั้งค่าของฉัน' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('ตั้งค่าของฉัน')
  if (isMobile) await expect(page.getByRole('dialog')).toBeHidden()
  await page.getByRole('navigation', { name: 'ตั้งค่าของฉัน' }).getByRole('link', { name: 'ความปลอดภัยของบัญชี' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('ความปลอดภัยของบัญชี')
  // Nothing lies over the content: a click on it lands on it (Playwright refuses a click another element intercepts)
  await page.locator('main').getByRole('heading', { level: 2 }).first().click({ timeout: 3000 })
})

test('[FR-PLT-013/AC2] the sidebar collapses to icons with its button and Ctrl B, keeps the choice, and opens collapsed on a document page', async ({ page, isMobile }, testInfo) => {
  await signInAsRequester(page)
  if (isMobile) {
    // A phone has no collapsed sidebar: the menu is a sheet (AC4), its entries named all the same
    await openMenuOnPhone(page, true)
    const sheetNav = page.getByRole('dialog').getByRole('navigation', { name: 'เมนูหลัก' })
    await expect(sheetNav.getByRole('link', { name: 'งานอนุมัติ' })).toHaveAttribute('aria-label', 'งานอนุมัติ')
    return
  }
  const sidebar = page.locator('[data-slot="sidebar"]')
  await expect(sidebar).toHaveAttribute('data-state', 'expanded')
  await page.screenshot({ path: testInfo.outputPath('sidebar-open.png') })

  await page.getByRole('button', { name: 'ยุบหรือขยายเมนู' }).click()
  await expect(sidebar).toHaveAttribute('data-state', 'collapsed')
  // 64 px of icons, each still named, and its words in a tooltip
  await expect.poll(async () => (await sidebar.locator('[data-slot="sidebar-container"]').boundingBox())?.width).toBe(64)
  const tasks = page.getByRole('navigation', { name: 'เมนูหลัก' }).getByRole('link', { name: 'งานอนุมัติ' })
  await tasks.hover()
  await expect(page.getByRole('tooltip').first()).toHaveText('งานอนุมัติ')
  await expectNoBlockingAxe(page)
  await page.screenshot({ path: testInfo.outputPath('sidebar-collapsed.png') })

  // Remembered by the browser: still collapsed after a reload
  await page.reload()
  await expect(sidebar).toHaveAttribute('data-state', 'collapsed')
  // Ctrl B opens it again, also while the Thai keyboard layout is on (the physical key decides)
  await page.locator('main').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('Control+KeyB')
  await expect(sidebar).toHaveAttribute('data-state', 'expanded')
  await page.reload()
  await expect(sidebar).toHaveAttribute('data-state', 'expanded')

  // A document page opens collapsed for a wider page, without changing the member's choice
  await page.goto('/requests')
  await page.locator('main a[href^="/requests/0"]').first().click()
  await expect(page).toHaveURL(/\/requests\/[0-9a-f-]{36}$/)
  await expect(sidebar).toHaveAttribute('data-state', 'collapsed')
  await page.goto('/requests')
  await expect(sidebar).toHaveAttribute('data-state', 'expanded')
})

test('[FR-PLT-013/AC3] the top bar holds the search, the bell, the user menu and the door; the door steps aside on the form', async ({ page, isMobile }, testInfo) => {
  await signInAsRequester(page)
  const bar = page.locator('header').first()
  await expect(bar.getByRole('button', { name: /ค้นหา/ })).toBeVisible()
  await expect(bar.locator('summary[aria-label^="แจ้งเตือน"]')).toBeVisible()
  // A phone's bar keeps the door; its user menu is at the foot of the menu sheet
  if (isMobile) {
    await openMenuOnPhone(page, true)
    await expect(page.getByRole('dialog').getByRole('region', { name: 'บัญชีของฉัน' }).getByRole('button', { name: 'ออกจากระบบ' })).toBeVisible()
    await page.keyboard.press('Escape')
  } else {
    await bar.locator('summary[aria-label="บัญชีของฉัน"]').click()
    await expect(bar.getByRole('button', { name: 'ออกจากระบบ' })).toBeVisible()
    await bar.locator('summary[aria-label="บัญชีของฉัน"]').click()
  }
  // The door, not the trail's link of the same words on the form's address
  const door = bar.locator('[data-door]').getByRole('link', { name: 'ขอซื้อ / ขอจ้าง' })
  for (const address of ['/', '/tasks', '/requests', '/suppliers', '/settings']) {
    await page.goto(address)
    await expect(door, address).toBeVisible()
  }
  await page.screenshot({ path: testInfo.outputPath('top-bar.png') })
  // The step form keeps the page to itself (FR-INT-011): the door is hidden there
  await page.goto('/requests/new/BUY_GOODS')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(door).toBeHidden()
})

test('[FR-PLT-013/AC4] on a 375 px phone the menu is a sheet from the left, the door shows, and no page scrolls sideways at either width', async ({ page, isMobile }, testInfo) => {
  await signInAsRequester(page)
  await expect(page.locator('header').first().locator('[data-door]').getByRole('link', { name: 'ขอซื้อ / ขอจ้าง' })).toBeVisible()
  if (isMobile) {
    await openMenuOnPhone(page, true)
    const sheet = page.getByRole('dialog')
    // From the left edge, once its 200 ms slide has ended
    await expect.poll(async () => (await sheet.boundingBox())?.x).toBe(0)
    await expect(sheet.getByRole('navigation', { name: 'เมนูหลัก' })).toBeVisible()
    await expectNoBlockingAxe(page)
    await page.screenshot({ path: testInfo.outputPath('menu-sheet.png') })
    await page.keyboard.press('Escape')
    await expect(sheet).toBeHidden()
  } else {
    // A wide screen keeps the sidebar beside the page, no sheet
    await expect(page.locator('[data-slot="sidebar"]')).toHaveAttribute('data-state', 'expanded')
    await expect(page.getByRole('dialog')).toHaveCount(0)
  }

  for (const address of ['/', '/tasks', '/requests', '/requests/new', '/suppliers', '/board/pending', '/settings', '/settings/security', '/settings/notifications']) {
    await page.goto(address)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow, address).toBeLessThanOrEqual(0)
    await expectNoBlockingAxe(page, address)
  }

  // The top bar holds a four-digit count on the bell in either language: nothing spills past the screen or over the
  // menu button (on CI a two-digit count in English once pushed the search over it). The count is written into the page,
  // since how many notices the member has depends on the tests run before this one.
  // The cookie on the site's root, whatever page is open: a cookie set from a page's URL gets that page's folder as its path
  const site = new URL('/', page.url()).href
  for (const locale of ['th', 'en']) {
    await page.context().addCookies([{ name: 'NEXT_LOCALE', value: locale, url: site }])
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('lang', locale)
    const { doorWhole: _, ...bar } = await topBarWith(page, '1234')
    expect(bar, locale).toEqual({ spill: 0, triggerFree: true, doorInside: true })
  }
  // From 768 px the door keeps its words whole: on a deep page with a long breadcrumb, the breadcrumb gives way (a
  // phone's door is the one that may shorten, and a phone has no breadcrumb)
  if (!isMobile) {
    await page.setViewportSize({ width: 768, height: 1024 })
    await page.goto('/settings/security')
    await page.locator('header [data-slot="breadcrumb-page"]').evaluate((crumb) => (crumb.textContent = 'การตั้งค่าความปลอดภัยของบัญชีผู้ใช้งานและการยืนยันตัวตนสองขั้นตอน'))
    expect(await topBarWith(page, '1234')).toEqual({ spill: 0, triggerFree: true, doorInside: true, doorWhole: true })
  }
})

/** The top bar with this text as the bell's count: what spills, whether the menu button is clear and the door whole */
function topBarWith(page: Page, count: string) {
  return page.locator('header').first().evaluate((header, count) => {
    const summary = header.querySelector('summary')!
    const badge = summary.querySelector('span.rounded-full') ?? summary.appendChild(Object.assign(document.createElement('span'), { className: 'rounded-full px-2 text-base tabular-nums' }))
    badge.textContent = count
    const trigger = header.querySelector('[data-sidebar="trigger"]')!.getBoundingClientRect()
    const atTrigger = document.elementFromPoint(trigger.left + trigger.width / 2, trigger.top + trigger.height / 2)
    const door = header.querySelector('[data-door]')!
    const label = door.querySelector('a span')!
    return {
      spill: header.scrollWidth - header.clientWidth,
      triggerFree: !!atTrigger?.closest('[data-sidebar="trigger"]'),
      doorInside: door.getBoundingClientRect().right <= window.innerWidth,
      doorWhole: label.scrollWidth <= label.clientWidth,
    }
  }, count)
}
