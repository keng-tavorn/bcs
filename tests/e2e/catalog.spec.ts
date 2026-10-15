import { spawnSync } from 'node:child_process'
import { type Page, type TestInfo } from '@playwright/test'
import { MS_PER_DAY } from '../../src/lib/constants'
import { e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'
import { expectNoBlockingAxe, expectNoSideways, shot, signIn } from './tasks-support'

// S6-10 on screen (FR-INT-102 AC1–AC3, BR-PRC-06, §9.1 /catalog and /catalog/manage): a requester searches the
// catalogue and sees an item's reference price and its agreed price with the supplier; PROCUREMENT adds an item and an
// agreed price on /catalog/manage, is refused an overlapping one in words, and ends one after confirming; a requester
// picks a catalogue item in the request form, whose price is locked to the agreed price of the suggested supplier, and
// gives a reason when the request goes to another supplier. Each Playwright project has its own people; the scene
// (catalog-scene.ts) makes fresh items through the services, so desktop and mobile never meet. Screenshots at 375 px
// (mobile) and 1440 px (desktop) go to the test output (§9.9 step 4); every state is checked with axe (step 5).

interface Agreed {
  readonly itemId: string
  readonly code: string
  readonly nameTh: string
  readonly supplier: { readonly id: string; readonly code: string; readonly nameTh: string }
  readonly today: string
}

function castOf(testInfo: TestInfo) {
  return testInfo.project.name === 'mobile' ? { procurement: 'dm_proc', requester: 'req_it' } : { procurement: 'proc_officer', requester: 'req_con' }
}

function scene<T>(...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/catalog-scene.ts ${args.map((a) => `"${a}"`).join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`catalog scene failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}

async function check(page: Page, testInfo: TestInfo, name: string) {
  await expectNoSideways(page)
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, name)
}

/** A day `days` after `day` (YYYY-MM-DD) */
const after = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * MS_PER_DAY).toISOString().slice(0, 10)
const status = (page: Page, text: string | RegExp) => page.getByRole('status').filter({ hasText: text })
const nextStep = (page: Page, name: string) => page.getByRole('button', { name: `ถัดไป: ${name}`, exact: true }).click()

test('[FR-INT-102/AC1] a requester searches the catalogue and sees the reference price and the agreed price with its supplier', async ({ page }, testInfo) => {
  const cast = castOf(testInfo)
  const s = scene<Agreed>('agreed', cast.procurement, 'ปูนแคตตาล็อก')
  await signIn(page, cast.requester, false)
  await page.goto('/catalog')
  await expect(page.getByRole('heading', { level: 1, name: 'แคตตาล็อก' })).toBeVisible()
  // The way to manage it is PROCUREMENT's only
  await expect(page.getByRole('link', { name: 'จัดการแคตตาล็อก' })).toHaveCount(0)
  await page.getByLabel('ค้นหาด้วยรหัสหรือชื่อ').fill(s.code)
  await page.getByRole('region', { name: 'ค้นหาแคตตาล็อก' }).getByRole('button', { name: 'ค้นหา', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/catalog\\?q=${s.code}`))
  const rows = page.getByRole('list', { name: 'รายการในแคตตาล็อก' }).getByRole('listitem')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText(s.nameTh)
  await expect(rows.first()).toContainText(`รหัส ${s.code} · หมวด CEMENT · หน่วย ถุง`)
  await expect(rows.first()).toContainText('180.00 บาท/ถุง')
  await expect(rows.first()).toContainText('ราคาตกลง')
  await expect(rows.first()).toContainText(`${s.supplier.nameTh} · 1,234.50 บาท/ถุง`)
  await check(page, testInfo, 'catalog-search')

  // No match: the empty list says what to do next (§9.9 principle 8)
  await page.goto('/catalog?q=ไม่มีสินค้านี้แน่นอน')
  await expect(page.getByText('ไม่พบรายการที่ตรงกับ “ไม่มีสินค้านี้แน่นอน”')).toBeVisible()
  await expect(page.getByRole('link', { name: 'ล้างคำค้นและดูทุกรายการ' }).first()).toBeVisible()
})

test('[FR-INT-102/AC3] PROCUREMENT adds an item and an agreed price on the manage page, is refused an overlapping one, and ends it after confirming', async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  const cast = castOf(testInfo)
  const sup = scene<{ code: string; nameTh: string; today: string }>('supplier', cast.procurement)
  await signIn(page, cast.procurement, true)
  await page.goto('/catalog')
  await page.getByRole('link', { name: 'จัดการแคตตาล็อก' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'จัดการแคตตาล็อก' })).toBeVisible()
  await check(page, testInfo, 'catalog-manage')

  // A new item: what is missing is said beside each field before anything is sent
  const code = `E2E-UI-${Date.now().toString(36).toUpperCase()}`
  const name = `ทรายหยาบ ${code.slice(-4)}`
  await page.getByRole('button', { name: 'เพิ่มรายการ' }).click()
  const add = page.getByRole('dialog', { name: 'เพิ่มรายการในแคตตาล็อก' })
  await add.getByRole('button', { name: 'บันทึกรายการ' }).click()
  await expect(add.getByText('ใส่ชื่อภาษาไทย')).toBeVisible()
  await expect(add.getByText('ใส่หน่วย')).toBeVisible()
  await add.getByLabel('รหัสรายการ').fill(code.toLowerCase())
  await expect(add.getByLabel('รหัสรายการ')).toHaveValue(code)
  await add.getByLabel('ชื่อภาษาไทย').fill(name)
  await add.getByLabel('หน่วย', { exact: true }).fill('คิว')
  await add.getByLabel('รหัสหมวด').fill('SAND')
  await add.getByLabel('ราคาอ้างอิงต่อหน่วย (บาท ก่อน VAT)').fill('1,250.5')
  await check(page, testInfo, 'catalog-manage-add')
  await add.getByRole('button', { name: 'บันทึกรายการ' }).click()
  await expect(add).toBeHidden()

  await page.getByLabel('ค้นหาด้วยรหัสหรือชื่อ').fill(code)
  await page.getByRole('region', { name: 'ค้นหาแคตตาล็อก' }).getByRole('button', { name: 'ค้นหา', exact: true }).click()
  const row = page.getByRole('list', { name: 'รายการที่จัดการได้' }).getByRole('listitem', { name: `${code} ${name}` })
  await expect(row).toContainText('ใช้งานอยู่')
  await expect(row).toContainText('ราคาอ้างอิง 1,250.50 บาท/คิว (ก่อน VAT)')
  await expect(row).toContainText('ยังไม่มีราคาตกลง')

  // An agreed price with a supplier, from today to its last day (both included)
  const lastDay = after(sup.today, 30)
  await row.getByRole('button', { name: `เพิ่มราคาตกลงของ ${name}` }).click()
  const agree = page.getByRole('dialog', { name: `เพิ่มราคาตกลงของ ${name}` })
  const supplierSelect = agree.getByLabel('ผู้ขาย', { exact: true })
  await supplierSelect.selectOption((await supplierSelect.locator('option', { hasText: `${sup.code} · ` }).getAttribute('value'))!)
  await agree.getByLabel('ราคาตกลงต่อคิว (บาท ก่อน VAT)').fill('1199.5')
  await expect(agree.getByLabel('วันแรกที่ใช้ราคานี้')).toHaveValue(sup.today)
  await agree.getByLabel('วันสุดท้ายที่ใช้ราคานี้').fill(lastDay)
  await check(page, testInfo, 'catalog-manage-agreement')
  await agree.getByRole('button', { name: 'บันทึกราคาตกลง' }).click()
  await expect(agree).toBeHidden()
  const prices = row.getByRole('list', { name: `ราคาตกลงของ ${name}` }).getByRole('listitem')
  await expect(prices).toHaveCount(1)
  await expect(prices.first()).toContainText('มีผลอยู่')
  await expect(prices.first()).toContainText(`${sup.nameTh} · 1,199.50 บาท/คิว`)

  // The same supplier again over the same days: refused in words, with how to fix it (BR-PRC-06 AGREEMENT_OVERLAP)
  await row.getByRole('button', { name: `เพิ่มราคาตกลงของ ${name}` }).click()
  await supplierSelect.selectOption((await supplierSelect.locator('option', { hasText: `${sup.code} · ` }).getAttribute('value'))!)
  await agree.getByLabel('ราคาตกลงต่อคิว (บาท ก่อน VAT)').fill('1100')
  await agree.getByLabel('วันสุดท้ายที่ใช้ราคานี้').fill(after(sup.today, 10))
  await agree.getByRole('button', { name: 'บันทึกราคาตกลง' }).click()
  await expect(agree.getByRole('alert')).toContainText('ช่วงวันนี้ทับกับราคาตกลงที่มีอยู่ของผู้ขายรายนี้')
  await agree.getByRole('button', { name: 'ยกเลิก' }).click()
  await expect(agree).toBeHidden()

  // Ending it asks first: it cannot be undone (§9.9), then today is its last day
  await row.getByRole('button', { name: `สิ้นสุดราคาตกลงกับ ${sup.nameTh} ของ ${name}` }).click()
  const confirm = page.getByRole('alertdialog', { name: `สิ้นสุดราคาตกลงกับ ${sup.nameTh}?` })
  await expect(confirm).toContainText('ย้อนกลับไม่ได้')
  await check(page, testInfo, 'catalog-manage-end')
  await confirm.getByRole('button', { name: 'สิ้นสุดราคาตกลงวันนี้' }).click()
  await expect(confirm).toBeHidden()
  await expect(prices.first()).toContainText('ใช้ได้ถึงวันนี้')
  await expect(row.getByRole('button', { name: `สิ้นสุดราคาตกลงกับ ${sup.nameTh} ของ ${name}` })).toHaveCount(0)
})

test('[FR-INT-102/AC2] a requester picks a catalogue item in the request form: the price is locked to the agreed price, and another supplier needs a reason', async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  const cast = castOf(testInfo)
  const s = scene<Agreed>('agreed', cast.procurement, 'ปูนฟอร์ม')
  await signIn(page, cast.requester, false)
  await page.goto('/requests/new/BUY_GOODS')
  await page.getByLabel('ชื่อคำขอ').fill(`ปูนจากแคตตาล็อก (${testInfo.project.name})`)
  await nextStep(page, 'รายการ ราคา และงบ')
  // Other specs of the run open more lines in the requester's department (S6-15 to S6-17): the request uses its OPEX line
  const budgetLine = page.getByLabel('บรรทัดงบที่ใช้')
  await budgetLine.selectOption((await budgetLine.locator('option', { hasText: /-OPEX-\d{4} · / }).first().getAttribute('value'))!)

  const line = page.getByRole('group', { name: 'รายการที่ 1' })
  await line.getByRole('button', { name: 'เลือกรายการที่ 1 จากแคตตาล็อก' }).click()
  const picker = page.getByRole('dialog', { name: 'เลือกจากแคตตาล็อกสำหรับรายการที่ 1' })
  await picker.getByLabel('ค้นหาในแคตตาล็อก', { exact: true }).fill(s.code)
  await picker.getByRole('button', { name: 'ค้นหา', exact: true }).click()
  const found = picker.getByRole('list', { name: 'ผลการค้นหาในแคตตาล็อก' }).getByRole('listitem')
  await expect(found).toHaveCount(1)
  await expect(found.first()).toContainText(`${s.supplier.nameTh} · 1,234.50 บาท/ถุง`)
  await check(page, testInfo, 'catalog-picker')
  await picker.getByRole('button', { name: `เลือก ${s.nameTh} (${s.code})` }).click()
  await expect(picker).toBeHidden()

  // The line is the item; the request suggests the agreed supplier, and the price is the agreed one, locked (BR-PRC-06)
  await expect(line.getByLabel('สิ่งที่ขอ')).toHaveValue(s.nameTh)
  await expect(line.getByLabel(/^หน่วย/)).toHaveValue('ถุง')
  const price = line.getByLabel(/^ราคาต่อหน่วย/)
  await expect(price).toHaveValue('1,234.50')
  await expect(price).toHaveAttribute('readonly', '')
  await expect(line).toContainText(`ราคาตกลงกับ ${s.supplier.nameTh} (ก่อน VAT) แก้ไม่ได้`)
  await expect(line).toContainText(`จากแคตตาล็อก: ${s.code} ${s.nameTh}`)
  await line.getByLabel(/^จำนวน/).fill('10')
  await expect(line).toContainText('จำนวนเงิน 12,345.00 บาท')
  // The server takes the draft with the agreed price
  await page.getByRole('button', { name: 'บันทึกร่างตอนนี้' }).click()
  await expect(status(page, /^บันทึกร่างแล้ว/)).toBeVisible({ timeout: 25_000 })
  await check(page, testInfo, 'catalog-form-locked')

  await nextStep(page, 'ผู้ขายและใบเสนอราคา')
  const supplier = page.getByLabel('ผู้ขายในทะเบียน (ไม่บังคับ)')
  await expect(supplier.locator('option:checked')).toHaveText(`${s.supplier.code} · ${s.supplier.nameTh}`)
  // No supplier suggested: the item's agreed price no longer applies, and the form asks why
  await supplier.selectOption('')
  await expect(page.getByText('รายการจากแคตตาล็อก 1 รายการมีราคาตกลงกับผู้ขายรายอื่น')).toBeVisible()
  await page.getByRole('button', { name: 'ย้อนกลับ: รายการ ราคา และงบ' }).click()
  await expect(price).not.toHaveAttribute('readonly')
  const reason = page.getByLabel(/^เหตุผลที่ไม่ใช้ผู้ขายที่มีราคาตกลง/)
  await expect(reason).toBeVisible()
  await reason.fill('ยังไม่แน่ใจผู้ขาย ให้ฝ่ายจัดซื้อเลือก')
  await page.getByRole('button', { name: 'บันทึกร่างตอนนี้' }).click()
  await expect(status(page, /^บันทึกร่างแล้ว/)).toBeVisible({ timeout: 25_000 })
  await check(page, testInfo, 'catalog-form-reason')

  // The line can leave the catalogue: its words and price stay, typed freely from now on
  await line.getByRole('button', { name: 'ไม่ใช้รายการจากแคตตาล็อกในรายการที่ 1' }).click()
  await expect(line.getByLabel('สิ่งที่ขอ')).toHaveValue(s.nameTh)
  await expect(reason).toHaveCount(1)
})
