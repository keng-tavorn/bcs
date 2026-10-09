import { spawnSync } from 'node:child_process'
import type { Page } from '@playwright/test'
import { e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'
import { checkScreen, signInAs } from './insight-support'

// S16-05 (§9.10 "dialog เริ่มคำขอใหม่" and "ฟอร์มทีละขั้น"): the one door opens "เริ่มคำขอใหม่" — a dialog on a wide screen,
// a drawer from the bottom on a phone — whose cards choose one request type with the keyboard alone and say how many
// drafts wait; "ดำเนินการต่อ" opens the type's form full screen, without the menu: the steps on the left (a "ขั้น n จาก m"
// bar on a phone), "ถัดไป" that checks its step first, "ก่อนส่ง" on the right of a wide screen, and "บันทึกร่างและปิด" that
// saves before it leaves. At 375 px (mobile project) and 1440 px (desktop), each screen with axe and a screenshot.

/** A draft of `member` made through the services (tests/e2e/suppliers-scene.ts), so the dialog has drafts to count */
function draftOf(member: string): void {
  const r = spawnSync(`pnpm exec tsx tests/e2e/suppliers-scene.ts site-draft ${member} SITE-A`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`supplier scene failed:\n${r.stdout}\n${r.stderr}`)
}

/**
 * The budget line has at least `baht` left before the form asks for it (tests/e2e/budget-room-scene.ts): the specs of a
 * run spend the same lines, and a budget admin tops the line up through the budget import when they have left less
 */
function roomOn(code: string, baht: string): void {
  const r = spawnSync(`pnpm exec tsx tests/e2e/budget-room-scene.ts ${code} ${baht}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`budget room scene failed:
${r.stdout}
${r.stderr}`)
}

const door = (page: Page) => page.locator('header [data-door]').getByRole('link', { name: 'ขอซื้อ / ขอจ้าง' })
const next = (page: Page, name: string) => page.getByRole('button', { name: `ถัดไป: ${name}`, exact: true })

test('[FR-INT-010/AC1] [FR-INT-010/AC2] [FR-INT-010/AC3] [FR-INT-010/AC4] the door opens "เริ่มคำขอใหม่": one type chosen and confirmed with the keyboard, the drafts a link away', async ({
  page,
  isMobile,
}, testInfo) => {
  draftOf('req_con')
  await signInAs(page, 'req_con', false)
  await door(page).click()
  const dialog = page.getByRole('dialog', { name: 'เริ่มคำขอใหม่' })
  await expect(dialog).toBeVisible()
  // A drawer from the bottom on a phone (vaul), a dialog of 640 px on a wide screen
  if (isMobile) await expect.poll(async () => Math.round(((await dialog.boundingBox())?.y ?? 0) + ((await dialog.boundingBox())?.height ?? 0))).toBe(812)
  else await expect.poll(async () => Math.round((await dialog.boundingBox())?.width ?? 0)).toBe(640)
  const box = (await dialog.boundingBox())!
  // AC1: every type of the seed once, each with when to use it, and the full-width "ดำเนินการต่อ" at the foot
  const types = dialog.getByRole('radio')
  await expect(types).toHaveCount(5)
  await expect(dialog.getByRole('radio', { name: /^ซื้อของ/ })).toHaveAccessibleName(/ใช้เมื่อ: วัสดุ อุปกรณ์ สินค้าทั่วไป/)
  const go = dialog.getByRole('button', { name: 'ดำเนินการต่อ' })
  const goBox = (await go.boundingBox())!
  expect(goBox.width).toBeGreaterThan(box.width - 64)
  // AC2: the requester's drafts, a link away
  await expect(dialog.getByText(/^คุณมีร่างคำขอ \d+ ใบ/)).toBeVisible()
  await expect(dialog.getByRole('link', { name: 'ดูร่าง' })).toHaveAttribute('href', '/requests/new#drafts')
  // Five types: no search (AC3 asks for one above six, tests/unit/request-form-steps.test.tsx)
  await expect(dialog.getByRole('searchbox')).toHaveCount(0)
  // Nothing chosen yet: "ดำเนินการต่อ" says what to do, never a dialog over the dialog
  await go.click()
  await expect(dialog.getByText('เลือกประเภทคำขอหนึ่งรายการก่อน แล้วกด ดำเนินการต่อ')).toBeVisible()
  await checkScreen(page, testInfo, 'new-request-dialog')

  // AC3: the arrow keys choose, Enter goes on to the chosen type's form
  await types.first().focus()
  await page.keyboard.press('Space')
  await expect(types.first()).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('ArrowDown')
  const chosen = dialog.getByRole('radio', { checked: true })
  await expect(chosen).toHaveCount(1)
  await expect(types.nth(1)).toHaveAttribute('aria-checked', 'true')
  const code = await chosen.getAttribute('value')
  await checkScreen(page, testInfo, 'new-request-dialog-chosen')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`/requests/new/${code}$`))
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('heading', { level: 2, name: /^ขั้นที่ 1 จาก \d: รายละเอียด$/ })).toBeVisible()

  // AC4: both addresses still open directly — the catalogue page with the drafts the link leads to
  await page.goto('/requests/new#drafts')
  await expect(page.getByRole('heading', { level: 1, name: 'ขอซื้อ / ขอจ้าง' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 2, name: 'ร่างและคำขอที่ถูกตีกลับของคุณ' })).toBeVisible()
  await page.goto('/requests/new/BUY_GOODS')
  await expect(page.getByRole('heading', { level: 1, name: 'คำขอใหม่: ซื้อของ' })).toBeVisible()
})

test('[FR-INT-011/AC1] [FR-INT-011/AC3] [FR-INT-011/AC4] [FR-INT-011/AC5] [FR-INT-011/AC6] the form full screen, step by step: "ถัดไป" checks its step, "ก่อนส่ง" tells beforehand, and closing saves the draft', async ({
  page,
  isMobile,
}, testInfo) => {
  // the form's line (its default for req_con) has room for the 483.11 baht the test asks, so "ส่งขออนุมัติ" is open
  roomOn('CON-OPEX-2569', '1000.00')
  await signInAs(page, 'req_con', false)
  await page.goto('/requests')
  await page.goto('/requests/new/BUY_GOODS')
  // AC1: no menu — the sidebar and the top bar step aside — and the form's own header and bar
  await expect(page.getByRole('heading', { level: 1, name: 'คำขอใหม่: ซื้อของ' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'เมนูหลัก' })).toBeHidden()
  await expect(door(page)).toBeHidden()
  await expect(page.getByRole('button', { name: 'บันทึกร่างและปิด' })).toBeVisible()
  const steps = page.getByRole('navigation', { name: 'ขั้นตอนของคำขอ' })
  if (isMobile) {
    await expect(steps).toBeHidden()
    await expect(page.getByText('ขั้น 1 จาก 5', { exact: true })).toBeVisible()
  } else {
    await expect(steps.getByRole('button')).toHaveCount(5)
    for (const [i, step] of ['รายละเอียด', 'รายการ ราคา และงบ', 'ผู้ขายและใบเสนอราคา', 'เอกสาร', 'ตรวจและส่ง'].entries()) await expect(steps.getByRole('button').nth(i)).toContainText(step)
    // Nothing applies at this amount yet: the documents are optional, said in words
    await expect(steps.getByRole('button').nth(3)).toContainText('ไม่บังคับ')
    await expect(steps.getByRole('button', { name: /รายละเอียด/ })).toHaveAttribute('aria-current', 'step')
    // The steps ahead come by "ถัดไป", which checks each first
    await expect(steps.getByRole('button', { name: /ตรวจและส่ง/ })).toBeDisabled()
  }
  // AC4: "ก่อนส่ง" beside the step on a wide screen (1280 px and up); a phone has it on the check step
  const beforeSending = page.getByRole('complementary', { name: 'ก่อนส่ง' })
  if (isMobile) await expect(beforeSending).toBeHidden()
  else {
    await expect(beforeSending.getByRole('region', { name: 'งบประมาณ' })).toBeVisible()
    await expect(beforeSending.getByRole('region', { name: 'เส้นทางอนุมัติที่คาดไว้' })).toBeVisible()
    await expect(beforeSending.getByRole('region', { name: 'เอกสารที่ต้องแนบตอนนี้' })).toBeVisible()
  }
  await checkScreen(page, testInfo, 'wizard-details')

  // AC3: "ถัดไป" checks the step's own fields, says what is missing under each, and stays
  await next(page, 'รายการ ราคา และงบ').click()
  await expect(page.getByRole('alert').filter({ hasText: 'ยังมี 1 ข้อในขั้นนี้ที่ต้องกรอกหรือแก้' })).toBeVisible()
  const title = page.getByLabel('ชื่อคำขอ')
  await expect(title).toBeFocused()
  await expect(page.getByText('ใส่ชื่อคำขอ', { exact: true })).toBeVisible()
  await checkScreen(page, testInfo, 'wizard-details-missing')
  const name = `ปูนและทราย (${testInfo.project.name} ${Date.now()})`
  await title.fill(name)
  await next(page, 'รายการ ราคา และงบ').click()
  await expect(page.getByRole('heading', { level: 2, name: 'ขั้นที่ 2 จาก 5: รายการ ราคา และงบ' })).toBeVisible()
  if (isMobile) await expect(page.getByText('ขั้น 2 จาก 5', { exact: true })).toBeVisible()
  else await expect(steps.getByRole('button', { name: /รายละเอียด/ })).toContainText('ผ่านแล้ว')

  // AC5: each line's amount and the totals, worked out by core as they are typed (GC-MONEY)
  const line = page.getByRole('group', { name: 'รายการที่ 1' })
  await line.getByLabel('สิ่งที่ขอ').fill('ปูนซีเมนต์')
  await line.getByLabel(/^จำนวน/).fill('3')
  await line.getByLabel(/^หน่วย/).fill('ถุง')
  await line.getByLabel(/^ราคาต่อหน่วย/).fill('150.50')
  await expect(line).toContainText('451.50 บาท')
  await expect(page.getByRole('region', { name: 'ยอดรวม' })).toContainText('451.50 บาท')
  if (!isMobile) await expect(beforeSending).toContainText('งบพอ')
  await checkScreen(page, testInfo, 'wizard-items')
  // Back keeps what was typed
  await page.getByRole('button', { name: 'ย้อนกลับ: รายละเอียด', exact: true }).click()
  await expect(title).toHaveValue(name)
  await next(page, 'รายการ ราคา และงบ').click()
  await expect(line.getByLabel(/^ราคาต่อหน่วย/)).toHaveValue('150.50')

  await next(page, 'ผู้ขายและใบเสนอราคา').click()
  await checkScreen(page, testInfo, 'wizard-supplier')
  await next(page, 'เอกสาร').click()
  // AC5: the documents the rules ask for at this amount, and a place to drop a file
  await expect(page.getByRole('region', { name: 'เอกสารที่ต้องแนบตอนนี้' }).first()).toContainText('ยอดและคำตอบตอนนี้ยังไม่ต้องแนบเอกสาร')
  await expect(page.getByText('ลากไฟล์มาวางที่นี่ หรือกดปุ่มเพื่อเลือกไฟล์')).toBeVisible()
  await checkScreen(page, testInfo, 'wizard-documents')

  await next(page, 'ตรวจและส่ง').click()
  // AC4 on every screen: the check step tells the budget, the route and the documents; the bar's button says what it does
  await expect(page.getByRole('region', { name: 'เส้นทางอนุมัติที่คาดไว้' })).toBeVisible()
  await expect(page.locator('footer').getByRole('button', { name: 'ส่งขออนุมัติ', exact: true })).toBeEnabled()
  await checkScreen(page, testInfo, 'wizard-review')

  // AC6 and AC1: the draft saved itself; "บันทึกร่างและปิด" saves what is new first, then goes back
  await page.getByRole('button', { name: 'ย้อนกลับ: เอกสาร', exact: true }).click()
  await page.getByRole('button', { name: 'ย้อนกลับ: ผู้ขายและใบเสนอราคา', exact: true }).click()
  await page.getByRole('button', { name: 'ย้อนกลับ: รายการ ราคา และงบ', exact: true }).click()
  await page.getByRole('button', { name: 'ย้อนกลับ: รายละเอียด', exact: true }).click()
  await title.fill(`${name} แก้ก่อนปิด`)
  await page.getByRole('button', { name: 'บันทึกร่างและปิด' }).click()
  await expect(page).toHaveURL(/\/requests$/)
  await page.goto('/requests/new')
  await page.getByRole('link', { name: `ทำต่อ: ${name} แก้ก่อนปิด` }).click()
  await expect(page.getByLabel('ชื่อคำขอ')).toHaveValue(`${name} แก้ก่อนปิด`)
})
