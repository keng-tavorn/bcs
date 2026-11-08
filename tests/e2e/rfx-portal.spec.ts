import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { Browser, Page, TestInfo } from '@playwright/test'
import { messagesTo } from '../support/mailpit'
import { E2E_BASE_URL, e2eEnv } from '../support/e2e-env'
import { expectNoBlockingAxe, expectNoSideways } from './budgets-support'
import { expect, test } from './fixtures'
import { FIRST_LOAD_JS_BUDGET_BYTES, weighFirstLoad } from './liff-support'

// S10-07 (FR-SRC-202 AC1 AC2 · BR-RFX-04 07 08 · BR-FORM-11): the supplier's contact on a phone (375 px) with the AI off
// opens the RFx from its invite's link (the six-digit code, then straight to the RFx), asks a question and reads the
// answer, bids step by step (prices, delivery, a file, check and send), changes the bid and sends it again, and reads
// its result once awarded. A contact whose language is English sees the RFx pages in English. Every page: axe with no
// serious or critical finding, no sideways scrolling, a picture at 375 and 1440 px, and its first JavaScript (script
// files and the page data in its HTML, gzip) within 200 KB with none of the workspace's class merger (§9.4 · ADR-052).

interface Opened {
  readonly orgCode: string
  readonly rfxEventId: string
  readonly number: string
  readonly contactId: string
  readonly procMemberId: string
  readonly path: string
}

function scene<T>(...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/rfx-portal-scene.ts ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`rfx portal scene ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}

/** The sign-in code of the contact: from its notice before it is sent, else from the e-mail Mailpit holds */
async function codeOf(contactId: string, email: string): Promise<string> {
  try {
    return scene<{ code: string }>('otp', contactId).code
  } catch {
    const mails = await messagesTo(email)
    return /\b(\d{6})\b/.exec(mails.at(-1)?.Text ?? '')?.[1] ?? ''
  }
}

/** A picture at the phone's 375 px and at 1440 px (§9.9 step 4), the page checked at both */
async function shot(page: Page, testInfo: TestInfo, name: string) {
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await page.screenshot({ path: testInfo.outputPath(`${name}-375.png`), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 900 })
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await page.screenshot({ path: testInfo.outputPath(`${name}-1440.png`), fullPage: true })
  await page.setViewportSize({ width: 375, height: 812 })
}

/** The portal's path as the server writes it (the session's cookies live under it, and a cookie's path is case-sensitive) */
const baseOf = (opened: Opened) => opened.path.slice(0, opened.path.indexOf('/link/'))

/** From the invite's one-time link to the RFx: the code e-mailed, typed, and the contact lands on the RFx itself */
async function signIn(page: Page, opened: Opened, email: string) {
  await page.goto(opened.path)
  await page.getByRole('button', { name: 'ส่งรหัสยืนยันให้ฉัน' }).click()
  await expect(page.getByRole('heading', { name: 'กรอกรหัสยืนยัน' })).toBeVisible()
  await page.getByLabel('รหัสยืนยัน 6 หลัก').fill(await codeOf(opened.contactId, email))
  await page.getByRole('button', { name: 'เข้าระบบ' }).click()
  await expect(page).toHaveURL(new RegExp(`/portal/${opened.orgCode}/rfx/${opened.rfxEventId}$`, 'i'))
}

/**
 * §9.4 on one portal page: opened in a browser of its own with nothing cached but the contact's session, its script
 * files over the wire (gzip) and the page data in its HTML within 200 KB, none of them tailwind-merge (a component of
 * the workspace would bring it). The portal has no LINE SDK.
 */
async function expectPortalPageWithinBudget(browser: Browser, page: Page, testInfo: TestInfo, path: string, ready: (p: Page) => Promise<void>) {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, baseURL: E2E_BASE_URL })
  await context.addCookies(await page.context().cookies())
  const fresh = await context.newPage()
  const load = await weighFirstLoad(fresh, path, () => ready(fresh))
  testInfo.annotations.push({ type: 'first-load-js', description: `${path}: ${load.note}` })
  expect.soft(load.loads.filter((l) => l.merge).map((l) => l.url), `${path}: no tailwind-merge`).toEqual([])
  expect.soft(load.total, `${path}: ${load.note}`).toBeLessThanOrEqual(FIRST_LOAD_JS_BUDGET_BYTES)
  await context.close()
}

test.use({ viewport: { width: 375, height: 812 } })

test('[FR-SRC-202/AC1] [FR-SRC-202/AC2] the contact opens the invite, asks, bids, changes and sends again, and reads the result, AI off', async ({ page, browser }, testInfo) => {
  test.setTimeout(240_000)
  const tag = randomUUID().slice(0, 6)
  const opened = scene<Opened>('open', tag, 'th')
  const base = baseOf(opened)
  await signIn(page, opened, `rfx.${tag}@supplier.test`)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('ปูนซีเมนต์และทราย ไซต์ 9')
  await expect(page.getByText('ขอราคา · ยังไม่ยื่น')).toBeVisible()
  await expect(page.getByText(/เหลือเวลา [23] วัน/)).toBeVisible()
  await shot(page, testInfo, 'rfx-detail')

  // a question, answered by procurement to everyone
  await page.getByLabel('คำถาม', { exact: true }).fill('ส่งหน้างานไซต์ 9 ได้หรือไม่')
  await page.getByRole('button', { name: 'ส่งคำถาม' }).click()
  await expect(page.getByText('ส่งคำถามแล้ว')).toBeVisible()
  await expect(page.getByText('คำถามของท่าน')).toBeVisible()
  scene('answer', opened.rfxEventId, opened.procMemberId)
  await page.reload()
  await expect(page.getByText('คำตอบ: ส่งหน้างานไซต์ 9 ได้ ไม่มีค่าขนส่งเพิ่ม')).toBeVisible()

  // the bid, step by step: the prices of both lines, the delivery, a file, then the check with the amounts and the send
  await page.getByRole('link', { name: 'ยื่นข้อเสนอ' }).click()
  await expect(page.getByRole('heading', { name: 'ราคาต่อหน่วย' })).toBeVisible()
  await expect(page.getByText('ขั้นที่ 1 จาก 4')).toBeVisible()
  await page.getByRole('group', { name: '1. ปูนซีเมนต์ 50 กก.' }).getByLabel('ราคาต่อหน่วย (บาท)').fill('abc')
  await page.getByRole('button', { name: 'ถัดไป' }).click()
  await expect(page.getByText('ใส่ราคาเป็นตัวเลขมากกว่า 0 ทศนิยมไม่เกิน 2 ตำแหน่ง')).toBeVisible()
  await page.getByRole('group', { name: '1. ปูนซีเมนต์ 50 กก.' }).getByLabel('ราคาต่อหน่วย (บาท)').fill('150')
  await page.getByRole('group', { name: '2. ทรายหยาบ' }).getByLabel('ราคาต่อหน่วย (บาท)').fill('600.00')
  await shot(page, testInfo, 'rfx-bid-prices')
  await page.getByRole('button', { name: 'ถัดไป' }).click()
  await expect(page.getByRole('heading', { name: 'การส่งมอบและหมายเหตุ' })).toBeVisible()
  await page.getByLabel('ส่งมอบภายใน (วันหลังได้รับใบสั่งซื้อ)').fill('7')
  await page.getByRole('button', { name: 'ถัดไป' }).click()
  await expect(page.getByRole('heading', { name: 'ไฟล์แนบ' })).toBeVisible()
  await page.getByLabel('เลือกไฟล์').setInputFiles({ name: 'quotation.pdf', mimeType: 'application/pdf', buffer: Buffer.from(`%PDF-1.7\nใบเสนอราคา ${tag}\n%%EOF`) })
  await page.getByRole('button', { name: 'แนบไฟล์นี้' }).click()
  await expect(page.getByText('quotation.pdf')).toBeVisible()
  await expect(page.getByText('กำลังตรวจความปลอดภัย')).toBeVisible()
  await shot(page, testInfo, 'rfx-bid-files')
  await page.getByRole('button', { name: 'ถัดไป' }).click()
  await expect(page.getByRole('heading', { name: 'ตรวจและยื่น' })).toBeVisible()
  // 100 × 150.00 + 4 × 600.00 = 17,400.00 · VAT 7% 1,218.00 · 18,618.00
  await expect(page.getByText('17,400.00', { exact: true })).toBeVisible()
  await expect(page.getByText('1,218.00', { exact: true })).toBeVisible()
  await expect(page.getByText('18,618.00', { exact: true })).toBeVisible()
  await shot(page, testInfo, 'rfx-bid-review')
  await page.getByRole('button', { name: 'ยื่นข้อเสนอ', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`${base}/rfx/${opened.rfxEventId}\\?sent=1`, 'i'))
  await expect(page.getByText('ยื่นข้อเสนอแล้ว', { exact: true })).toBeVisible()
  await expect(page.getByText('ก่อน VAT 17,400.00 · VAT 1,218.00 · รวม 18,618.00 บาท')).toBeVisible()

  // changed and sent again: the bid that counts stays sent until the new one goes
  await page.getByRole('link', { name: 'แก้และยื่นใหม่' }).click()
  await expect(page.getByRole('group', { name: '1. ปูนซีเมนต์ 50 กก.' }).getByLabel('ราคาต่อหน่วย (บาท)')).toHaveValue('150.00')
  await page.getByRole('group', { name: '1. ปูนซีเมนต์ 50 กก.' }).getByLabel('ราคาต่อหน่วย (บาท)').fill('145.00')
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'ถัดไป' }).click()
  await expect(page.getByText('16,900.00', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'ยื่นข้อเสนอใหม่' }).click()
  await expect(page.getByText('ยื่นข้อเสนอแล้ว', { exact: true })).toBeVisible()
  await expect(page.getByText(/ยื่นแล้ว 2 ครั้ง/)).toBeVisible()
  await expect(page.getByText('ก่อน VAT 16,900.00 · VAT 1,183.00 · รวม 18,083.00 บาท')).toBeVisible()

  // the list, then the result once procurement closed it and an approved award gave both lines to the supplier
  await page.goto(`${base}/rfx`)
  await expect(page.getByText('ขอราคา · ยื่นแล้ว')).toBeVisible()
  await shot(page, testInfo, 'rfx-list')
  scene('award', opened.rfxEventId, opened.procMemberId)
  await page.goto(`${base}/rfx/${opened.rfxEventId}`)
  await expect(page.getByText('ขอราคา · ได้รับเลือก')).toBeVisible()
  await page.getByRole('link', { name: 'ดูผล' }).click()
  await expect(page.getByText('ท่านได้รับเลือกสำหรับรายการต่อไปนี้', { exact: false })).toBeVisible()
  await expect(page.getByText('100 ถุง × 145.00 = 14,500.00 บาท')).toBeVisible()
  await expect(page.getByText('รวมก่อน VAT 16,900.00 บาท')).toBeVisible()
  await shot(page, testInfo, 'rfx-result')

  // §9.4 on every page of the RFx in the portal
  const rfxPath = `${base}/rfx/${opened.rfxEventId}`
  await expectPortalPageWithinBudget(browser, page, testInfo, `${base}/rfx`, (p) => expect(p.getByRole('heading', { level: 1 })).toBeVisible())
  await expectPortalPageWithinBudget(browser, page, testInfo, rfxPath, (p) => expect(p.getByRole('heading', { level: 1 })).toBeVisible())
  await expectPortalPageWithinBudget(browser, page, testInfo, `${rfxPath}/result`, (p) => expect(p.getByRole('heading', { level: 1 })).toBeVisible())
})

test('[FR-SRC-202/AC1] a contact whose language is English reads the RFx and its bid form in English', async ({ page, browser }, testInfo) => {
  test.setTimeout(180_000)
  const tag = randomUUID().slice(0, 6)
  const opened = scene<Opened>('open', tag, 'en')
  await signIn(page, opened, `rfx.${tag}@supplier.test`)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Cement and sand, site 9')
  await expect(page.getByText('Request for quotation · Not bid yet')).toBeVisible()
  await expect(page.getByText('Cement and sand for the foundations, delivered to the site')).toBeVisible()
  await expect(page.getByText('1. Cement 50 kg')).toBeVisible()
  await shot(page, testInfo, 'rfx-detail-en')
  await page.getByRole('link', { name: 'Bid', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Unit prices' })).toBeVisible()
  await expect(page.getByText('Step 1 of 4')).toBeVisible()
  await shot(page, testInfo, 'rfx-bid-en')
  // the bid form is the heaviest page: weighed with the contact's session and a draft of its own
  await expectPortalPageWithinBudget(browser, page, testInfo, `${baseOf(opened)}/rfx/${opened.rfxEventId}/bid`, (p) => expect(p.getByRole('heading', { name: 'Unit prices' })).toBeVisible())
})
