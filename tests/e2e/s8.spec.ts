import { spawnSync } from 'node:child_process'
import type { Browser, Page } from '@playwright/test'
import { deriveSeedTotpSecret, totp } from '../../src/lib/totp'
import { e2eEnv } from '../support/e2e-env'
import { messagesTo } from '../support/mailpit'
import { check, h1, SCENE_TEST_TIMEOUT_MS, signIn as signInDemo, tagOf } from './finance-support'
import { expect, test } from './fixtures'

// S8-13 (docs/sub-specs/S8.md "หน้าจอ", FR-AP-101 FR-AP-103 FR-MATCH-* · e2e @s8): the tier-2 invoice screens of an
// organization with PAY on, each test on an organization of its own made by tests/e2e/s8-scene.ts —
//   an e-Tax invoice e-mailed to the inbox becomes a draft, is coded, submitted and is ready for payment;
//   an invoice over the PO's price goes to procurement, its variance to the approver, and once approved it is ready;
//   FINANCE rejects an invoice and the supplier gets the e-mail with the reason (Mailpit);
//   the demo organization (PAY off) shows none of it.
// Every state is checked with axe, no sideways scrolling and pictures at 375 px and 1440 px (§9.9).

function s8Scene<T>(...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/s8-scene.ts ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`S8 scene ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}

/** A member of the scene's organization signs in: e-mail <code>.<tag>@s8.bcs.local, TOTP as the scene derived it */
async function signIn(page: Page, code: string, tag: string) {
  const local = `${code}.${tag}`
  await page.goto('/login')
  await page.getByLabel('อีเมลบริษัท').fill(`${local}@s8.bcs.local`)
  await page.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
  await expect(page).toHaveURL(/\/login\/2fa$/)
  await page.getByLabel('รหัส 6 หลักจากแอป').fill(totp(deriveSeedTotpSecret(process.env.SEED_TOTP_KEY!, local)))
  await page.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' }).click()
  await expect(h1(page)).toContainText('สวัสดี')
}

async function as(browser: Browser, viewport: { width: number; height: number } | null, code: string, tag: string): Promise<Page> {
  const context = await browser.newContext({ ...(viewport ? { viewport } : {}), locale: 'th-TH', timezoneId: 'Asia/Bangkok' })
  const page = await context.newPage()
  await signIn(page, code, tag)
  return page
}

/** The §9.9 checks with the pointer at rest, away from the button it pressed last (drawn hovered under it otherwise) */
async function look(page: Page, testInfo: Parameters<typeof check>[1], name: string) {
  await page.mouse.move(0, 0)
  await check(page, testInfo, name)
}

/** The element of this layout: tables show from md up, the list of cards below it */
const shown = (page: Page, text: string) => page.getByText(text, { exact: true }).filter({ visible: true }).first()

/** Picks an account code on every line the form leaves without one, then confirms the coding */
async function confirmCoding(page: Page) {
  const pickers = page.getByRole('combobox', { name: /^รหัสบัญชีของบรรทัด/ })
  for (let i = 0; i < (await pickers.count()); i++) {
    const picker = pickers.nth(i)
    if (!(await picker.innerText()).includes('เลือกรหัสบัญชี')) continue
    await picker.click()
    await page.getByRole('option', { name: /510101/ }).click()
  }
  await page.getByRole('button', { name: 'ยืนยันรหัสบัญชีทุกบรรทัด' }).click()
  await expect(page.getByRole('button', { name: 'ส่งจับคู่' })).toBeEnabled()
}

test.describe('@s8 tier-2 invoices (S8-13)', () => {
  test.describe.configure({ timeout: SCENE_TEST_TIMEOUT_MS })

  test('[FR-AP-101/AC2] [FR-AP-102/AC3] an e-Tax invoice e-mailed to the inbox becomes a draft, is coded and submitted, and is ready for payment', async ({ page }, testInfo) => {
    const tag = tagOf(testInfo)
    const made = s8Scene<{ poNumber: string; invoiceNo: string }>('inbox', tag)
    await signIn(page, 'fin_officer', tag)

    await page.goto('/finance/invoices')
    await expect(h1(page)).toHaveText('ใบแจ้งหนี้')
    await page.getByRole('link', { name: 'กล่องรับใบแจ้งหนี้' }).click()
    await expect(h1(page)).toHaveText('กล่องรับใบแจ้งหนี้')
    await page.getByRole('button', { name: 'ดึงอีเมลตอนนี้' }).click()
    await expect(page.getByText(/ดึงอีเมลแล้ว: อีเมลใหม่ 1 ฉบับ สร้างร่าง 1 ใบ/)).toBeVisible({ timeout: 30_000 })
    await look(page, testInfo, 's8-inbox')

    await page.getByRole('link', { name: new RegExp(`^ใบแจ้งหนี้ ${made.invoiceNo}`) }).click()
    await expect(page.getByText(made.invoiceNo).filter({ visible: true }).first()).toBeVisible()
    await confirmCoding(page)
    await look(page, testInfo, 's8-draft-coded')
    await page.getByRole('button', { name: 'ส่งจับคู่' }).click()
    await expect(shown(page, 'พร้อมจ่าย')).toBeVisible()
    await look(page, testInfo, 's8-ready')
  })

  test('[FR-AP-103/AC2] [FR-AP-105/AC3] a price over the PO goes to procurement, the variance to the approver, and once approved the invoice is ready', async ({ page, browser }, testInfo) => {
    const tag = tagOf(testInfo)
    const made = s8Scene<{ invoiceId: string; number: string; poNumber: string; approver: string }>('variance', tag)
    await signIn(page, 'proc_officer', tag)

    // procurement finds it from the PO list
    await page.goto('/procurement/pos')
    await page.getByRole('link', { name: 'ใบแจ้งหนี้ที่ไม่ตรงใบสั่งซื้อ' }).click()
    await expect(h1(page)).toHaveText('ใบแจ้งหนี้ที่ราคาหรือจำนวนเกิน PO')
    await expect(shown(page, 'ราคาสูงกว่า PO เกินเกณฑ์')).toBeVisible()
    await look(page, testInfo, 's8-exceptions')
    // the organization has this one invoice over its price
    await page.getByRole('button', { name: 'ขออนุมัติส่วนต่าง' }).filter({ visible: true }).first().click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('เหตุผล').fill('ราคาวัสดุขึ้นตามประกาศของผู้ผลิต')
    await look(page, testInfo, 's8-variance-dialog')
    await dialog.getByRole('button', { name: 'ส่งขออนุมัติส่วนต่าง' }).click()
    // the invoice waits for the approver now, and leaves procurement's list
    await expect(shown(page, 'ไม่มีใบแจ้งหนี้ที่ราคาหรือจำนวนเกิน PO')).toBeVisible()

    // the approver decides it on their task page
    const approver = await as(browser, page.viewportSize(), made.approver, tag)
    await approver.goto('/tasks')
    await approver.getByRole('link', { name: new RegExp(made.number) }).first().click()
    await expect(h1(approver)).toHaveText('ส่วนต่างราคาของใบแจ้งหนี้')
    await look(approver, testInfo, 's8-variance-task')
    await approver.getByRole('button', { name: 'อนุมัติ', exact: true }).click()
    await approver.getByRole('button', { name: 'ยืนยันอนุมัติ' }).click()
    await expect(approver.getByRole('status').filter({ hasText: 'อนุมัติแล้ว' })).toBeVisible()
    await approver.context().close()

    // FINANCE sees it ready for payment
    const finance = await as(browser, page.viewportSize(), 'fin_officer', tag)
    await finance.goto(`/finance/invoices/${made.invoiceId}`)
    await expect(shown(finance, 'พร้อมจ่าย')).toBeVisible()
    await look(finance, testInfo, 's8-variance-ready')
    await finance.context().close()
  })

  test('[FR-AP-103/AC3] FINANCE rejects an invoice and the supplier gets the e-mail with the reason', async ({ page }, testInfo) => {
    const tag = tagOf(testInfo)
    const made = s8Scene<{ invoiceId: string; number: string; invoiceNo: string; supplierEmail: string }>('reject', tag)
    await signIn(page, 'fin_officer', tag)

    await page.goto('/finance/invoices?tab=exceptions')
    await page.getByRole('link', { name: new RegExp(made.number) }).first().click()
    await expect(shown(page, 'ราคาสูงกว่า PO เกินเกณฑ์')).toBeVisible()
    await look(page, testInfo, 's8-exception')
    await page.getByRole('button', { name: 'ปฏิเสธใบแจ้งหนี้' }).click()
    // rejecting cannot be undone: an AlertDialog
    const dialog = page.getByRole('alertdialog')
    await dialog.getByLabel('เหตุผล').fill('ราคาไม่ตรงกับที่ตกลงไว้ในใบสั่งซื้อ')
    await dialog.getByRole('button', { name: 'ปฏิเสธและแจ้งผู้ขาย' }).click()
    await expect(page.getByText('ปฏิเสธใบแจ้งหนี้และแจ้งผู้ขายแล้ว')).toBeVisible()
    await expect(shown(page, 'ปฏิเสธแล้ว')).toBeVisible()
    await look(page, testInfo, 's8-rejected')

    // the job supplier-notice-send (not run by the e2e app) sends it: the supplier reads the invoice and the reason
    s8Scene('notices')
    // the e-mail of the submission ("received") came first; the rejection follows it with the reason
    const reason = 'ราคาไม่ตรงกับที่ตกลงไว้ในใบสั่งซื้อ'
    const rejection = async () => (await messagesTo(made.supplierEmail)).filter((m) => m.Text.includes(reason))
    await expect.poll(async () => (await rejection()).length, { timeout: 20_000 }).toBe(1)
    const [mail] = await rejection()
    expect(`${mail!.Subject}\n${mail!.Text}`).toContain(made.invoiceNo)
  })

  test('[FR-AP-102/AC6] BR-AP-13: the demo organization (PAY off) keeps tier-1 invoices and shows no tier-2 page', async ({ page }, testInfo) => {
    await signInDemo(page, 'fin_officer', true)
    await page.goto('/finance/invoices')
    await expect(h1(page)).not.toHaveText('ใบแจ้งหนี้')
    for (const name of ['กล่องรับใบแจ้งหนี้', 'เงินประกันผลงาน', 'ภาษีหัก ณ ที่จ่าย']) await expect(page.getByRole('link', { name })).toHaveCount(0)
    await page.goto('/finance/wht')
    await expect(page.getByRole('table')).toHaveCount(0)
    await look(page, testInfo, 's8-pay-off')
  })
})
