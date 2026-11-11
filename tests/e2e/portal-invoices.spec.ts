import { spawnSync } from 'node:child_process'
import { E2E_BASE_URL, e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'
import { checkScreen } from './liff-support'

// S7-12 (FR-AP-101 AC7 · FR-AP-103 AC5 · FR-PAY-103 AC8 · scene 6 of Demo_Script_P2 on the supplier's side): on a phone,
// the contact sends an invoice for a PO of its supplier with its PDF; FINANCE finds it among the portal's drafts, codes
// and submits it; the contact then reads "พร้อมจ่าย ครบกำหนด …" with BCS's number, and its payments page shows the run,
// the amount and the last four digits of the account only. Each page is checked with axe at 375 and 1440 px.

function portalScene<T>(...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/portal-scene.ts ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`portal scene ${args[0]} failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1)!) as T
}

const PDF = Buffer.from('%PDF-1.4\n% invoice S00277/A of the e2e scene\n%%EOF\n')

test.describe('@portal the supplier sends an invoice and reads its payment', () => {
  test.describe.configure({ timeout: 180_000 })

  test('[FR-AP-101/AC7] [FR-AP-103/AC5] [FR-PAY-103/AC8] send on the portal → ready to pay → paid, masked', async ({ page, context }, testInfo) => {
    const made = portalScene<{ org: string; organizationId: string; poId: string; number: string; sid: string; csrf: string }>('invoice')
    await context.addCookies([
      { name: 'bcs_portal', value: made.sid, url: `${E2E_BASE_URL}/portal/${made.org}` },
      { name: 'bcs_portal_csrf', value: made.csrf, url: `${E2E_BASE_URL}/portal/${made.org}` },
    ])
    await page.goto(`/portal/${made.org}/invoices`)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('ใบแจ้งหนี้')
    await checkScreen(page, testInfo, 'portal-invoices')
    await page.getByRole('link', { name: 'ส่งใบแจ้งหนี้ใหม่' }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('ส่งใบแจ้งหนี้')
    await page.getByLabel('ใบสั่งซื้อ').selectOption(made.poId)
    await page.getByLabel('ไฟล์ใบแจ้งหนี้').setInputFiles({ name: 'S00277-A.pdf', mimeType: 'application/pdf', buffer: PDF })
    await page.getByLabel('เลขที่ใบแจ้งหนี้ของท่าน').fill('S00277/A')
    await page.getByLabel('วันที่ในใบแจ้งหนี้').fill('2026-11-02')
    await page.getByLabel('ภาษีมูลค่าเพิ่ม (บาท)').fill('7,000.00')
    await checkScreen(page, testInfo, 'portal-invoice-new')
    await page.getByRole('button', { name: 'ส่งใบแจ้งหนี้' }).click()

    await expect(page.getByRole('status').filter({ hasText: 'ส่งใบแจ้งหนี้แล้ว' })).toBeVisible()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('S00277/A')
    await expect(page.getByRole('heading', { level: 2, name: 'ส่งถึงการเงินแล้ว รอตรวจ' })).toBeVisible()
    await expect(page.getByText('ยอดรวม 107,000.00 บาท')).toBeVisible()
    await expect(page.getByText(/กำลังตรวจความปลอดภัย|ไฟล์: S00277-A\.pdf/)).toBeVisible()
    await checkScreen(page, testInfo, 'portal-invoice')

    const finance = portalScene<{ invoiceId: string; status: string }>('invoice-finance', `${made.organizationId}:${made.poId}`)
    expect(finance.status).toBe('READY_FOR_PAYMENT')
    await page.reload()
    await expect(page.getByRole('heading', { level: 2, name: /^พร้อมจ่าย ครบกำหนด/ })).toBeVisible()
    await expect(page.getByText(/รับแล้ว เลขที่ AP-/)).toBeVisible()
    await expect(page.getByRole('heading', { name: 'แก้ใบแจ้งหนี้' })).toHaveCount(0)

    await page.getByRole('link', { name: 'การจ่ายเงิน' }).first().click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('การจ่ายเงิน')
    await expect(page.getByText(/รอบ PAY-2569-00001/)).toBeVisible()
    await expect(page.getByText('ยอดโอน 100,580.00 บาท')).toBeVisible()
    await expect(page.getByText(/ลงท้าย 6789/)).toBeVisible()
    await expect(page.getByText('2123456789')).toHaveCount(0)
    await expect(page.getByText('E2E-REF-HIDDEN')).toHaveCount(0)
    await checkScreen(page, testInfo, 'portal-payments')
  })
})
