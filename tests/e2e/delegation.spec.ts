import { spawnSync } from 'node:child_process'
import AxeBuilder from '@axe-core/playwright'
import type { Browser, Page, TestInfo } from '@playwright/test'
import { deriveSeedTotpSecret, totp } from '../../src/lib/totp'
import { E2E_BASE_URL, e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'
import { settled } from './settled'

// NEW-06 · FR-DOA-006 AC2 (web part, BR-DLG-01..03): dm_con names asst_con as acting approver on /settings/delegation;
// a 10,000 baht request of req_con then goes to asst_con, who sees it in the bell and sees whom they act for; dm_con
// cancels it again. Both viewports run the same scene one after the other (the cancellation frees the days).

async function expectNoBlockingAxe(page: Page) {
  // Next streams the <title> after the first HTML: let it arrive before axe reads the page (a page without one still fails)
  await page.waitForFunction(() => document.title !== '', undefined, { timeout: 5_000 }).catch(() => undefined)
  await settled(page)
  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(blocking.map((v) => `${v.id}: ${v.help}`)).toEqual([])
}

async function shot(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })
}

/** The page is never wider than the screen (§9.9: no horizontal scroll on phones) */
async function expectNoHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
}

async function signIn(page: Page, code: string, withTotp: boolean) {
  await page.goto('/login')
  await page.getByLabel('อีเมลบริษัท').fill(`${code}@demo.bcs.local`)
  await page.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
  if (withTotp) {
    await expect(page).toHaveURL(/\/login\/2fa$/)
    await page.getByLabel('รหัส 6 หลักจากแอป').fill(totp(deriveSeedTotpSecret(process.env.SEED_TOTP_KEY!, code)))
    await page.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' }).click()
  }
  await expect(page.getByRole('heading', { level: 1 })).toContainText('สวัสดี')
}

async function asMember(browser: Browser, testInfo: TestInfo, clientIp: string, code: string, withTotp: boolean): Promise<Page> {
  const context = await browser.newContext({ ...testInfo.project.use, baseURL: E2E_BASE_URL, extraHTTPHeaders: { 'x-forwarded-for': clientIp } })
  const page = await context.newPage()
  await signIn(page, code, withTotp)
  return page
}

/** YYYY-MM-DD of today plus `days` in Thai time, as the date inputs take it */
function thaiDay(days: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + days * 86_400_000))
  return parts
}

/** The S2 demo scene's request, submitted through the services in the e2e database (tests/e2e/delegation-scene.ts) */
function submitTenThousandBahtRequest(): { number: string; assignee: string; principal: string | null } {
  const r = spawnSync('pnpm exec tsx tests/e2e/delegation-scene.ts', { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`delegation scene failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!)
}

const success = (page: Page, text: string | RegExp) => page.getByRole('status').filter({ hasText: text })
const failure = (page: Page, text: string | RegExp) => page.getByRole('alert').filter({ hasText: text })

test('[FR-DOA-006/AC2] the delegator names an acting approver on the web; a 10,000 baht request then goes to them', async ({ page, browser, clientIp }, testInfo) => {
  await signIn(page, 'dm_con', true)
  await page.goto('/settings/delegation')
  await expect(page.getByRole('heading', { level: 1, name: 'รักษาการ' })).toBeVisible()
  // What a delegation does in this build (BR-DLG-04, NEW-35): the waiting tasks move at the start, new ones follow within
  // the kinds and cap set, either decides, and what is still waiting comes back at the end or on a cancel
  await expect(page.getByText(/^ตั้งผู้รักษาการเมื่อคุณลาหรือไม่อยู่ เมื่อเริ่มช่วงนั้น งานอนุมัติที่รอคุณอยู่จะย้ายไปที่ผู้รักษาการ .* ใครตัดสินก่อนได้ก่อน เมื่อจบช่วงหรือเมื่อยกเลิก งานที่ยังค้างจะกลับมาที่คุณ$/)).toBeVisible()
  await expect(page.getByText('อำนาจที่มอบได้มาจากตำแหน่ง ผู้จัดการฝ่าย ของ ฝ่ายก่อสร้าง')).toBeVisible()
  await expectNoBlockingAxe(page)
  await expectNoHorizontalScroll(page)
  await shot(page, testInfo, 'delegation')

  // Nothing chosen and the last day before the first: each field says what it needs
  await expect(page.getByText(/^รักษาการ \d{1,2} .+ \d{4} ถึง \d{1,2} .+ \d{4}$/)).toBeVisible()
  await page.getByLabel('วันสุดท้าย (รวมวันนั้น)').fill(thaiDay(-1))
  await page.getByRole('button', { name: 'ตั้งผู้รักษาการ', exact: true }).click()
  await expect(page.getByText('เลือกผู้รักษาการจากรายการก่อนบันทึก')).toBeVisible()
  await expect(page.getByText('วันสุดท้ายต้องไม่ก่อนวันเริ่ม')).toBeVisible()
  await expect(page.getByText('ใส่เหตุผลอย่างน้อย 3 ตัวอักษร')).toBeVisible()
  // Days that have passed hand over nothing: the first day is today or later
  await page.getByLabel('วันเริ่ม', { exact: true }).fill(thaiDay(-1))
  await page.getByRole('button', { name: 'ตั้งผู้รักษาการ', exact: true }).click()
  await expect(page.getByText('วันเริ่มต้องเป็นวันนี้หรือหลังจากนี้')).toBeVisible()

  await page.getByLabel('ผู้รักษาการ', { exact: true }).selectOption({ label: 'สมหญิง รักงาน · ฝ่ายก่อสร้าง' })
  await page.getByLabel('วันเริ่ม', { exact: true }).fill(thaiDay(0))
  await page.getByLabel('วันสุดท้าย (รวมวันนั้น)').fill(thaiDay(2))
  await expect(page.getByText(/^รักษาการ \d{1,2} .+ \d{4} ถึง \d{1,2} .+ \d{4}$/)).toBeVisible()
  await page.getByLabel('วงเงินสูงสุดที่มอบ (บาท)').fill('20,000')
  await page.getByLabel('เหตุผล (เช่น ลาพักร้อน)').fill('ลาพักร้อน')
  await page.getByRole('button', { name: 'ตั้งผู้รักษาการ', exact: true }).click()
  await expect(success(page, /^ตั้งผู้รักษาการแล้ว สมหญิง รักงาน รักษาการแทนคุณ /)).toBeVisible()
  const row = page.getByRole('region', { name: 'ผู้รักษาการแทนคุณ' }).getByRole('listitem').filter({ hasText: 'สมหญิง รักงาน' }).filter({ hasText: 'กำลังรักษาการ' })
  await expect(row).toContainText('ทุกประเภทงานอนุมัติ')
  await expect(row).toContainText('วงเงินไม่เกิน 20,000.00 บาท')
  await expect(row).toContainText('เหตุผล ลาพักร้อน')

  // The same days again with someone else overlap the first (BR-DLG-03)
  await page.getByLabel('ผู้รักษาการ', { exact: true }).selectOption({ label: 'วิศวะ หน้างาน · ฝ่ายก่อสร้าง' })
  await page.getByLabel('วันสุดท้าย (รวมวันนั้น)').fill(thaiDay(1))
  await page.getByLabel('เหตุผล (เช่น ลาพักร้อน)').fill('ประชุมต่างจังหวัด')
  await page.getByRole('button', { name: 'ตั้งผู้รักษาการ', exact: true }).click()
  await expect(failure(page, 'ช่วงนี้ทับกับการรักษาการที่ตั้งไว้แล้ว ยกเลิกรายการเดิมหรือเลือกวันอื่น')).toBeVisible()
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'delegation-set')

  // The demo scene: req_con asks for 10,000 baht; the DM of CON's task goes to asst_con
  const request = submitTenThousandBahtRequest()
  expect(request).toMatchObject({ assignee: 'asst_con', principal: 'dm_con' })
  const delegate = await asMember(browser, testInfo, clientIp, 'asst_con', false)
  await delegate.goto('/settings/delegation')
  const actingFor = delegate.getByRole('region', { name: 'คุณรักษาการแทน' }).getByRole('listitem').filter({ hasText: 'ดำรง ก่อสร้างไทย' })
  await expect(actingFor).toContainText('กำลังรักษาการ')
  // asst_con holds no position, so there is nothing for them to hand over
  await expect(delegate.getByText('คุณไม่ได้ดำรงตำแหน่งที่มีอำนาจอนุมัติ จึงไม่มีอำนาจให้มอบ')).toBeVisible()
  const bell = delegate.locator('details:has(> summary[aria-label^="แจ้งเตือน"])').filter({ visible: true })
  await bell.locator('summary').click()
  await expect(bell.getByRole('button', { name: new RegExp(`มีงานรออนุมัติ: ${request.number}`) })).toBeVisible()
  await expectNoBlockingAxe(delegate)
  await expectNoHorizontalScroll(delegate)
  await shot(delegate, testInfo, 'delegation-delegate')
  await delegate.context().close()

  // Cancelling cannot be undone, so it asks first
  await row.getByRole('button', { name: 'ยกเลิกการรักษาการของ สมหญิง รักงาน' }).click()
  await row.getByRole('button', { name: 'ยืนยันยกเลิกการรักษาการ' }).click()
  await expect(row.getByText('ติ๊กช่องยืนยันก่อนยกเลิก')).toBeVisible()
  // Cancelling ends the period early: what the acting approver still holds comes back (BR-DLG-04, NEW-35), as the box says
  await row.getByLabel('ยืนยันยกเลิก งานอนุมัติใหม่จะมาที่คุณทันที และงานที่ยังค้างอยู่กับผู้รักษาการจะกลับมาที่คุณ').check()
  await row.getByRole('button', { name: 'ยืนยันยกเลิกการรักษาการ' }).click()
  const cancelled = page.getByRole('region', { name: 'ผู้รักษาการแทนคุณ' }).getByRole('listitem').filter({ hasText: 'ยกเลิกการรักษาการแล้ว งานอนุมัติใหม่และงานที่ค้างอยู่กับผู้รักษาการจะกลับมาที่คุณ' })
  await expect(cancelled).toContainText('ยกเลิกแล้ว')
  // The overlap refusal was about the delegation just cancelled, so it is gone
  await expect(failure(page, 'ช่วงนี้ทับกับการรักษาการที่ตั้งไว้แล้ว')).toHaveCount(0)
  await expectNoHorizontalScroll(page)
  await shot(page, testInfo, 'delegation-cancelled')
})

test('[FR-DOA-006/AC2] a member without a position sees why there is nothing to hand over', async ({ page }, testInfo) => {
  await signIn(page, testInfo.project.name === 'mobile' ? 'req_con2' : 'req_con', false)
  await page.goto('/settings/delegation')
  await expect(page.getByText('คุณไม่ได้ดำรงตำแหน่งที่มีอำนาจอนุมัติ จึงไม่มีอำนาจให้มอบ')).toBeVisible()
  await expect(page.getByRole('button', { name: 'ตั้งผู้รักษาการ', exact: true })).toHaveCount(0)
  // Nothing to hand over and nothing handed over: only whom they act for is listed
  await expect(page.getByRole('region', { name: 'ผู้รักษาการแทนคุณ' })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'คุณรักษาการแทน' })).toBeVisible()
  await expectNoBlockingAxe(page)
  await expectNoHorizontalScroll(page)
  await shot(page, testInfo, 'delegation-no-position')
})
