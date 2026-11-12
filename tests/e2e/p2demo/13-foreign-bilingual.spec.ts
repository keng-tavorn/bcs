import { devices } from '@playwright/test'
import { E2E_BASE_URL } from '../../support/e2e-env'
import { deskAs } from '../p1demo/money-steps'
import { p1Sheet, userOf } from '../p1demo/support'
import { expect, test } from '../fixtures'
import { p2Expected, p2SceneOf, p2Sheet, portalSessionOn, s10 } from './support'

// Scene 13 of the day of phase 2 (S10-17 · FR-INT-201 AC2 AC3 AC4 · BR-FORM-11 · OQ-205 OQ-211): procurement (the row's
// actor) has a new RFP for the need of scene 10 in Thai only (the scene script makes the draft as /sourcing/new does).
// Inviting the foreign supplier of RFx_Suppliers is refused until the RFx is in Thai and English; with the English title
// and description typed it is invited, but the RFx does not open while a line lacks its English; with every line's
// English it opens. On a phone the supplier's contact (locale en) reads the portal in English, is told prices are in
// Thai baht, and bids in THB: the bid is in baht with VAT 0 (not registered for Thai VAT).

test('@p2demo [FR-INT-201/AC2] [FR-INT-201/AC3] [FR-INT-201/AC4] scene 13: a foreign supplier needs an RFx in Thai and English, reads the portal in English and bids in baht', async ({ browser }) => {
  // a desk scene of several steps (two scene scripts, the setup, the print) and a bid on a phone
  test.setTimeout(240_000)
  const [sheet, p1] = await Promise.all([p2Sheet(), p1Sheet()])
  const scene = p2SceneOf(sheet, 13)
  expect(p2Expected<string>(scene, 'locale')).toBe('TH_EN')
  expect(p2Expected<string>(scene, 'currency')).toBe('THB')
  expect(p2Expected<string>(scene, 'contactLocale')).toBe('en')
  const { rfxEventId, supplierId } = s10<{ rfxEventId: string; supplierId: string }>('foreign-rfp', userOf(p1, scene.actor).email, scene.portalActor!)

  // procurement on a computer: the foreign supplier is refused while the RFx is Thai only
  const desk = await deskAs(browser, p1, scene.actor)
  const edit = (step: string) => desk.goto(`/sourcing/${rfxEventId}/edit?step=${step}`)
  await edit('suppliers')
  await desk.getByLabel('ผู้ขายที่จะเชิญ').selectOption(supplierId)
  await desk.getByRole('button', { name: 'เชิญผู้ขายนี้' }).click()
  await expect(desk.getByText(/ต้องเป็นเอกสารสองภาษา/).first()).toBeVisible()

  // Thai and English, with the English title and description typed (nothing is translated · OQ-211)
  await edit('general')
  await desk.getByLabel('เอกสารสองภาษา ไทยและอังกฤษ').check()
  await desk.getByLabel(/^ชื่อ RFx \(อังกฤษ/).fill('Office firewall for two sites with installation (second round)')
  await desk.getByLabel(/^รายละเอียดและขอบเขต \(อังกฤษ/).fill('Firewalls for the head office and the plant, installed, with a three-year warranty')
  await desk.getByRole('button', { name: 'บันทึกข้อมูลทั่วไป' }).click()
  await expect(desk.getByText('บันทึกข้อมูลทั่วไปแล้ว')).toBeVisible()

  await edit('suppliers')
  await desk.getByLabel('ผู้ขายที่จะเชิญ').selectOption(supplierId)
  await desk.getByRole('button', { name: 'เชิญผู้ขายนี้' }).click()
  await expect(desk.getByRole('status').filter({ hasText: /^เชิญ .+ แล้ว$/ })).toBeVisible()
  await expect(desk.getByText('ผู้ขายต่างชาติ').first()).toBeVisible()

  // the RFx does not open while a line lacks its English
  await edit('schedule')
  await desk.getByRole('button', { name: 'ถัดไป: ตรวจและเปิด' }).click()
  // the checks before opening (each item read with its state first: "ยังไม่ครบ: …")
  const checks = desk.getByRole('list', { name: 'สิ่งที่ตรวจก่อนเปิด' }).getByRole('listitem')
  await expect(checks.filter({ hasText: /ภาษาอังกฤษยังไม่ครบ: .*หน่วยบรรทัด 1/ })).toBeVisible()
  await expect(desk.getByRole('button', { name: 'เปิด RFx' })).toBeDisabled()

  // every line's English, then it opens
  await edit('lines')
  const englishForms = desk.getByRole('form', { name: /^ภาษาอังกฤษของ / })
  const count = await englishForms.count()
  expect(count).toBeGreaterThan(0)
  for (let i = 0; i < count; i++) {
    const form = englishForms.nth(i)
    const item = form.getByLabel('รายการ (อังกฤษ)')
    if (!(await item.inputValue())) await item.fill(`Item ${i + 1}`)
    await form.getByLabel('หน่วย (อังกฤษ)').fill(i === 0 ? 'set' : 'job')
    await form.getByRole('button', { name: 'บันทึกภาษาอังกฤษ' }).click()
    await expect(desk.getByText('บันทึกภาษาอังกฤษของบรรทัดแล้ว')).toBeVisible()
    await desk.reload()
  }
  await edit('schedule')
  await desk.getByRole('button', { name: 'ถัดไป: ตรวจและเปิด' }).click()
  await expect(checks.filter({ hasText: /^ครบ: ภาษาอังกฤษครบ$/ })).toBeVisible()
  const reason = desk.getByLabel('เหตุผลที่เชิญน้อยกว่าขั้นต่ำ')
  if (await reason.isVisible()) await reason.fill('รอบสองสำหรับผู้ขายต่างชาติรายเดียว เทียบกับผลรอบแรก')
  await desk.getByRole('button', { name: 'เปิด RFx' }).click()
  await desk.getByRole('alertdialog').getByRole('button', { name: 'เปิด RFx' }).click()
  await desk.waitForURL(new RegExp(`/sourcing/${rfxEventId}(\\?|$)`))
  await desk.goto(`/sourcing/${rfxEventId}/print`)
  await expect(desk.getByRole('columnheader', { name: 'English' }).first()).toBeVisible()
  await expect(desk.getByText('ราคาเป็นบาทไทย / Prices in Thai Baht')).toBeVisible()
  await desk.context().close()

  // the foreign supplier's phone, in English: the RFx's English, baht only, a bid in THB
  const phone = await browser.newContext({ ...devices['Pixel 7'], viewport: { width: 375, height: 812 }, baseURL: E2E_BASE_URL, locale: 'en-US', timezoneId: 'Asia/Bangkok' })
  await portalSessionOn(phone, sheet.orgCode, scene.portalActor!)
  const page = await phone.newPage()
  await page.goto(`/portal/${sheet.orgCode}/rfx/${rfxEventId}`)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Office firewall for two sites with installation (second round)')
  await expect(page.getByText(/^Prices in Thai Baht/)).toBeVisible()
  await expect(page.getByText('(TH)')).toHaveCount(0)
  await page.getByRole('link', { name: 'Bid', exact: true }).click()
  const prices = page.getByLabel('Unit price (THB)')
  const lines = await prices.count()
  for (let i = 0; i < lines; i++) {
    if (!(await prices.nth(i).isVisible())) await page.getByRole('button', { name: 'Next' }).click()
    await prices.nth(i).fill(i === 0 ? '80000.00' : '20000.00')
  }
  while (await page.getByRole('button', { name: 'Next' }).isVisible()) await page.getByRole('button', { name: 'Next' }).click()
  await page.getByRole('button', { name: 'Send my bid' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Your bid was sent' })).toBeVisible()
  await expect(page.getByText(/VAT 0\.00 · Total .* THB/)).toBeVisible()
  const bid = s10<{ status: string; vat: string; locale: string; currency: string }>('bid', rfxEventId, supplierId)
  expect(bid).toMatchObject({ status: 'SUBMITTED', vat: '0.00', locale: 'TH_EN', currency: 'THB' })
  await phone.close()
})
