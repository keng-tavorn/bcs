import { Buffer } from 'node:buffer'
import { scannedInvoicePdf } from '../../src/server/seed/etax-sample'
import { check, h1, SCENE_TEST_TIMEOUT_MS, tagOf } from './finance-support'
import { expect, test } from './fixtures'
import { uploadDraft } from './p1demo/money-steps'
import { s8Scene, signIn } from './s8-support'

// NEW-115 and NEW-116 (FR-AP-102 AC7 AC8, FR-AP-103 AC5): the page of a tier-2 invoice beside its file. From 1280 px up the
// supplier's file is on the left and the values in tabs on the right, with the bar of what the PO has left; on a phone one
// column with no tabs and no file in the page. The badge on the head opens why the rules raised the invoice, by who reads
// it. Every state is checked with axe, no sideways scrolling and pictures at 375 px and 1440 px (§9.9).

const FILE = 'invoice-split.pdf'
const pane = '[data-invoice-file-pane]'

test.describe('@s8 the invoice beside its file', () => {
  test.describe.configure({ timeout: SCENE_TEST_TIMEOUT_MS })

  test('[FR-AP-102/AC7] [FR-AP-102/AC8] a computer opens the file in the page beside the tabs and the PO bar; a phone keeps one column', async ({ page }, testInfo) => {
    const tag = tagOf(testInfo)
    const made = s8Scene<{ poNumber: string }>('split', tag)
    await signIn(page, 'fin_officer', tag)
    await uploadDraft(page, made.poNumber, { name: FILE, buffer: Buffer.from(scannedInvoicePdf(['ผู้ขายหนึ่ง', 'INV-SPLIT', '642.00'])) })

    // The bar: the draft comes with what is received and not yet billed, 6 of 10 at the PO's price
    const bar = page.getByRole('region', { name: 'ยอดเทียบกับ PO' })
    await expect(bar).toContainText('ใบนี้600.00')
    await expect(bar).toContainText('ใบอื่นที่ตัดแล้ว400.00')
    await expect(bar).toContainText('เหลือ0.00')
    await expect(bar).toContainText('ยอด PO1,000.00')
    await expect(bar.getByRole('img')).toHaveAccessibleName('ใบนี้ 600.00 บาท ใบอื่น 400.00 บาท จากยอด PO 1,000.00 บาท')
    await expect(bar).toContainText('ใบนี้ยังไม่ตัดยอดจริง')
    await expect(bar.getByRole('link', { name: new RegExp(made.poNumber) })).toBeVisible()

    if (testInfo.project.name === 'mobile') {
      await expect(page.locator(pane)).toBeHidden()
      await expect(page.locator('iframe')).toHaveCount(0)
      await expect(page.getByRole('tablist')).toBeHidden()
      for (const name of ['หัวเอกสาร', 'บรรทัดและผลจับคู่', 'รหัสบัญชีและศูนย์ต้นทุน', 'ยอดเงิน', 'บรรทัดเทียบกับ PO', 'ที่มาของใบนี้', 'ไฟล์ต้นฉบับ', 'ประวัติของใบแจ้งหนี้', 'ความเห็นในใบนี้']) {
        await expect(page.getByRole('region', { name, exact: true }), name).toBeVisible()
      }
      await expect(page.getByRole('button', { name: `ดาวน์โหลดไฟล์ ${FILE}` })).toBeVisible()
      await check(page, testInfo, 'invoice-split-phone')
      return
    }

    // The file in the page, opening rather than downloading
    const frame = page.locator(pane).locator('iframe')
    await expect(frame).toHaveAttribute('title', `ไฟล์ต้นฉบับ ${FILE}`, { timeout: 30_000 })
    const served = await page.request.get((await frame.getAttribute('src'))!)
    expect(served.status()).toBe(200)
    expect(served.headers()['content-type']).toContain('application/pdf')
    expect(served.headers()['content-disposition']).toMatch(/^inline/)
    await expect(page.locator(pane)).toContainText(FILE)
    await check(page, testInfo, 'invoice-split')

    // The tabs: what is typed stays while another tab is read, and the address keeps the tab
    const tab = (name: string | RegExp) => page.getByRole('tab', { name })
    await expect(tab('รายละเอียด')).toHaveAttribute('aria-selected', 'true')
    const number = page.getByRole('form', { name: 'หัวเอกสาร' }).getByLabel('เลขที่ใบแจ้งหนี้ของผู้ขาย')
    await number.fill('INV-TYPED')
    await tab('จับคู่ PO').click()
    const match = page.getByRole('region', { name: 'บรรทัดเทียบกับ PO' })
    await expect(match).toContainText('ยังไม่ได้จับคู่')
    await expect(match).toContainText('สั่งใน PO10 ')
    await expect(match).toContainText('ใบอื่นเรียกเก็บแล้ว4 ')
    await expect(match).toContainText('ใบนี้เรียกเก็บ6 ')
    await expect(number).toBeHidden()
    await check(page, testInfo, 'invoice-split-match')
    await tab('รายละเอียด').click()
    await expect(number).toHaveValue('INV-TYPED')

    await tab('ที่มา').click()
    const source = page.getByRole('region', { name: 'ที่มาของใบนี้' })
    await expect(source).toContainText('อัปโหลดไฟล์')
    await expect(page.getByRole('button', { name: `ดาวน์โหลดไฟล์ ${FILE}` })).toBeVisible()
    await expect(page).toHaveURL(/\?tab=source$/)
    await check(page, testInfo, 'invoice-split-source')
    await page.reload()
    await expect(tab('ที่มา')).toHaveAttribute('aria-selected', 'true')
    await expect(source).toBeVisible()

    await tab(/^ความเห็น/).click()
    await expect(page.getByRole('region', { name: 'ความเห็นในใบนี้' })).toContainText('ยังไม่มีความเห็น')

    // Still in one page on the smallest screen that splits; below it the file leaves the page
    await tab('รายละเอียด').click()
    await page.setViewportSize({ width: 1280, height: 800 })
    await expect(frame).toBeVisible()
    await check(page, testInfo, 'invoice-split-1280')
    await page.setViewportSize({ width: 1279, height: 800 })
    await expect(page.locator(pane)).toBeHidden()
    await expect(page.getByRole('tablist')).toBeHidden()
    await expect(page.getByRole('region', { name: 'ที่มาของใบนี้' })).toBeVisible()
  })

  test('[FR-AP-103/AC5] the badge on the head opens why the rules raised the invoice, by who reads it', async ({ page, browser }, testInfo) => {
    const tag = tagOf(testInfo)
    const made = s8Scene<{ invoiceId: string; number: string }>('alerts', tag)
    await signIn(page, 'fin_officer', tag)
    await page.goto(`/finance/invoices/${made.invoiceId}`)
    await expect(h1(page)).toContainText(made.number)

    // The bar says the invoice is over its PO, in words as well as colour
    await expect(page.getByRole('region', { name: 'ยอดเทียบกับ PO' })).toContainText('เกิน PO100.00')

    const badge = page.getByRole('button', { name: '2 แจ้งเตือน' })
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await badge.click()
    const alerts = page.getByRole('dialog', { name: 'แจ้งเตือนของใบนี้' })
    await expect(alerts).toContainText('ราคาสูงกว่า PO เกินเกณฑ์')
    await expect(alerts).toContainText('บรรทัด 1 · 100.00 บาท · ส่งถึงฝ่ายจัดซื้อ')
    await expect(alerts).toContainText('ฝ่ายจัดซื้อขออนุมัติส่วนต่าง')
    await expect(alerts).toContainText('สถานะทะเบียนเปลี่ยน')
    await expect(alerts).toContainText('เลิกกิจการ')
    await check(page, testInfo, 'invoice-alerts')
    await page.keyboard.press('Escape')
    await expect(alerts).toHaveCount(0)

    // NEW-122: the panel "จากผู้ช่วย" tells the same alerts, each with one way to where it is dealt with
    const panel = page.getByRole('region', { name: 'จากผู้ช่วย' })
    const found = panel.getByRole('list', { name: 'เรื่องที่ผู้ช่วยเจอในเอกสารนี้' })
    const differences = found.locator('[data-assistant-note="INVOICE_DIFFERENCES:1"]')
    await expect(differences).toContainText('ใบนี้มีรายการไม่ตรง 1 รายการ')
    await expect(differences.getByRole('link', { name: 'ไปที่รายการไม่ตรง' })).toHaveAttribute('href', `/finance/invoices/${made.invoiceId}#invoice-exceptions`)
    await expect(found.locator('[data-assistant-note^="INVOICE_SUPPLIER_FLAGS:"]')).toContainText('สถานะทะเบียนเปลี่ยน')
    await expect(panel.getByRole('button', { name: 'ถามเรื่องนี้' })).toHaveCount(0)
    // Above the PO bar: under the header on a phone, the head of the right column from 1280 px
    const y = async (l: typeof panel) => (await l.boundingBox())!.y
    expect(await y(panel)).toBeLessThan(await y(page.getByRole('region', { name: 'ยอดเทียบกับ PO' })))
    await check(page, testInfo, 'invoice-assistant-panel')

    // PROCUREMENT reads the same difference, and nothing of what a payment run would flag
    const context = await browser.newContext({ viewport: page.viewportSize(), locale: 'th-TH', timezoneId: 'Asia/Bangkok' })
    const procurement = await context.newPage()
    await signIn(procurement, 'proc_officer', tag)
    await procurement.goto(`/finance/invoices/${made.invoiceId}`)
    await procurement.getByRole('button', { name: '1 แจ้งเตือน' }).click()
    const theirs = procurement.getByRole('dialog', { name: 'แจ้งเตือนของใบนี้' })
    await expect(theirs).toContainText('ราคาสูงกว่า PO เกินเกณฑ์')
    await expect(theirs).not.toContainText('สถานะทะเบียนเปลี่ยน')
    await procurement.keyboard.press('Escape')
    // Their panel the same: the difference, nothing of a payment run
    const theirPanel = procurement.getByRole('region', { name: 'จากผู้ช่วย' })
    await expect(theirPanel.locator('[data-assistant-note="INVOICE_DIFFERENCES:1"]')).toBeVisible()
    await expect(theirPanel.locator('[data-assistant-note^="INVOICE_SUPPLIER_FLAGS:"]')).toHaveCount(0)
    await context.close()
  })
})
