import { devices } from '@playwright/test'
import { E2E_BASE_URL } from '../../support/e2e-env'
import { confirmCoding, deskAs, poOfHistory, proposalsFor, submitDraft } from '../p1demo/money-steps'
import { p1Sheet } from '../p1demo/support'
import { expect, test } from '../fixtures'
import { dayFromToday, p2Expected, p2SceneOf, p2Sheet, portalSessionOn, s7 } from './support'

// Scene 6 of the day of phase 2 (S7-17 · S7-12 · FR-AP-101 AC7 · FR-AP-103 AC5 · FR-PAY-103 AC8): on a phone, the contact
// of the row's supplier sends its invoice (expectJson.invoiceNo) for the PO the history made for expectJson.poFromHistory
// with the PDF, today's date and the PO's VAT; the actor (FINANCE) finds it among the drafts of the portal
// (expectJson.listFilter), confirms the coding BR-AP-10 proposes and sends it to match: it is ready to pay, and the
// contact reads "พร้อมจ่าย ครบกำหนด …" with BCS's number. The supplier's payments page shows what the history paid it
// (expectJson.payments.paidFromHistory · ADR-191) — the run's number read from the database, the transfer, the account's
// last four digits only.

const PDF = Buffer.from('%PDF-1.4\n% invoice of scene 6 of the day of phase 2 (synthetic)\n%%EOF\n')
const baht = (satang: string) => {
  const s = BigInt(satang)
  return `${(s / 100n).toLocaleString('en-US')}.${(s % 100n).toString().padStart(2, '0')}`
}

test('@p2demo [FR-AP-101/AC7] [FR-AP-103/AC5] [FR-PAY-103/AC8] scene 6: the supplier sends its invoice on the portal, finance codes and matches it, the supplier reads it ready to pay and its payments', async ({ browser }) => {
  const [sheet, p1] = await Promise.all([p2Sheet(), p1Sheet()])
  const scene = p2SceneOf(sheet, 6)
  const invoiceNo = p2Expected<string>(scene, 'invoiceNo')
  const ref = p2Expected<string>(scene, 'poFromHistory')
  const po = s7<{ id: string; number: string; vatSatang: string; grossSatang: string; supplier: { code: string } }>('history-po', ref)
  expect(po.supplier.code).toBe(scene.supplier)
  const paid = s7<Array<{ run: string; transferSatang: string; last4: string }>>('paid', scene.supplier!)
  expect(paid.length, `the history paid ${scene.supplier} (${p2Expected<{ paidFromHistory: string }>(scene, 'payments').paidFromHistory})`).toBeGreaterThan(0)

  // the supplier's phone: the invoice with its PDF
  const phone = await browser.newContext({ ...devices['Pixel 7'], viewport: { width: 375, height: 812 }, baseURL: E2E_BASE_URL, locale: 'th-TH', timezoneId: 'Asia/Bangkok' })
  await portalSessionOn(phone, sheet.orgCode, scene.portalActor!)
  const page = await phone.newPage()
  await page.goto(`/portal/${sheet.orgCode}/invoices/new`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('ส่งใบแจ้งหนี้')
  await page.getByLabel('ใบสั่งซื้อ').selectOption(po.id)
  await page.getByLabel('ไฟล์ใบแจ้งหนี้').setInputFiles({ name: `${invoiceNo.replaceAll('/', '-')}.pdf`, mimeType: 'application/pdf', buffer: PDF })
  await page.getByLabel('เลขที่ใบแจ้งหนี้ของท่าน').fill(invoiceNo)
  await page.getByLabel('วันที่ในใบแจ้งหนี้').fill(dayFromToday(0))
  await page.getByLabel('ภาษีมูลค่าเพิ่ม (บาท)').fill(baht(po.vatSatang))
  await page.getByRole('button', { name: 'ส่งใบแจ้งหนี้' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'ส่งใบแจ้งหนี้แล้ว' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(invoiceNo)
  await expect(page.getByRole('heading', { level: 2, name: 'ส่งถึงการเงินแล้ว รอตรวจ' })).toBeVisible()
  await expect(page.getByText(`ยอดรวม ${baht(po.grossSatang)} บาท`)).toBeVisible()

  // FINANCE: the portal's drafts, the coding BR-AP-10 proposes, sent to match
  const desk = await deskAs(browser, p1, scene.actor)
  await desk.goto(`/finance/invoices?tab=draft&channel=${p2Expected<string>(scene, 'listFilter')}`)
  await desk.getByRole('link', { name: invoiceNo }).filter({ visible: true }).first().click()
  const facts = poOfHistory(ref)
  const proposals = proposalsFor(facts)
  const accountCode = proposals.find((p) => p.accountCode)?.accountCode ?? facts.lines[0]!.accountCode!
  await confirmCoding(desk, { accountCode, proposals })
  const number = await submitDraft(desk, 'READY_FOR_PAYMENT')
  await desk.context().close()

  // the supplier reads it ready to pay under BCS's number, then its payments
  await page.reload()
  await expect(page.getByRole('heading', { level: 2, name: /^พร้อมจ่าย ครบกำหนด/ })).toBeVisible()
  await expect(page.getByText(`รับแล้ว เลขที่ ${number}`)).toBeVisible()
  await page.getByRole('link', { name: 'การจ่ายเงิน' }).first().click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('การจ่ายเงิน')
  for (const p of paid) {
    await expect(page.getByText(new RegExp(`รอบ ${p.run}`)).first()).toBeVisible()
    await expect(page.getByText(`ยอดโอน ${baht(p.transferSatang)} บาท`).first()).toBeVisible()
    await expect(page.getByText(new RegExp(`ลงท้าย ${p.last4}`)).first()).toBeVisible()
  }
  await phone.close()
})
