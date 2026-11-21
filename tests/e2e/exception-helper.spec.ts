import { messagesTo } from '../support/mailpit'
import { check, h1, SCENE_TEST_TIMEOUT_MS, tagOf } from './finance-support'
import { expect, test } from './fixtures'
import { s8Scene, signIn } from './s8-support'

// NEW-126 (FR-AP-103 AC6 AC7, ADR-081): the helper of an invoice's difference, at 1440 and 375 px. FINANCE sees what the
// assistant did with a tick each — the PO line, this invoice's line, the receipts — and the ways it has; it opens the
// drafted question, reads it, confirms it in a dialog that shows the whole text, and sends it to the receiver; the
// history names who sent it and the receiver finds the words in the bell. The e-mail to the supplier goes the same way.
// The receiver's own helper offers receiving the rest and never the supplier. Every state is checked with axe.

test.describe('@s8 the helper of a difference', () => {
  test.describe.configure({ timeout: SCENE_TEST_TIMEOUT_MS })

  test('[FR-AP-103/AC6] [FR-AP-103/AC7] FINANCE reads what the helper gathered, sends the drafted question and e-mail itself; the receiver sees its own ways', async ({ page, browser }, testInfo) => {
    const tag = tagOf(testInfo)
    const made = s8Scene<{ invoiceId: string; number: string; poId: string; poNumber: string; supplierEmail: string }>('helper', tag)
    await signIn(page, 'fin_officer', tag)
    await page.goto(`/finance/invoices/${made.invoiceId}`)
    await expect(h1(page)).toContainText(made.number)

    const helper = page.getByRole('region', { name: 'ผู้ช่วยแก้รายการไม่ตรง' })
    const item = helper.getByRole('article', { name: /จำนวนเกินที่รับของแล้ว · บรรทัด 1/ })
    const steps = item.getByRole('list', { name: 'สิ่งที่ผู้ช่วยทำแล้ว' })
    await expect(steps.locator('[data-step="poLine"]')).toContainText('ดึงบรรทัด 1 ของ PO แล้ว: สั่ง 10 ชิ้น ราคา 100.00 บาทต่อหน่วย')
    await expect(steps.locator('[data-step="invoiceLine"]')).toContainText('เรียกเก็บ 10 ชิ้น')
    await expect(steps.locator('[data-step="receipts"]')).toContainText('รับแล้ว 6 ชิ้น จากการตรวจรับ 1 ครั้ง')
    await expect(steps.locator('[data-step="choose"]')).toContainText('รอคุณ: รอคุณเลือกทางแก้')
    const ways = item.getByRole('list', { name: 'ทางแก้ที่คุณทำได้' })
    await expect(ways.getByRole('link')).toHaveText(['ถามผู้ตรวจรับหรือผู้ขอ', 'ตรวจซ้ำหลังแก้ที่ต้นเหตุแล้ว', 'ขอใบลดหนี้หรือใบแจ้งหนี้ใหม่จากผู้ขาย', 'เปิดแก้เป็นร่างถ้าบันทึกผิด', 'ปฏิเสธใบเมื่อผู้ขายจะส่งใบใหม่'])
    // The rules found all of it: no Sparkles, no AI
    await expect(helper.locator('svg.lucide-sparkles')).toHaveCount(0)
    await check(page, testInfo, 'exception-helper')

    // The way to ask opens the drafted question; nothing goes until it is confirmed
    await ways.getByRole('link', { name: 'ถามผู้ตรวจรับหรือผู้ขอ' }).click()
    const ask = item.getByRole('region', { name: 'ร่างคำถามถึงผู้ตรวจรับหรือผู้ขอ' })
    const text = ask.getByLabel('ข้อความ')
    await expect(text).toBeVisible()
    await expect(ask.getByRole('radio', { name: 'ผู้ใช้ receiver_con (ผู้ตรวจรับ)' })).toBeChecked()
    await expect(text).toHaveValue(/^เรียนคุณผู้ใช้ receiver_con ใบแจ้งหนี้ .+ บรรทัด 1 \(ปูนซีเมนต์\) เรียกเก็บ 10 ชิ้น แต่ในระบบรับของแล้ว 6 ชิ้น/)
    // Choosing the requester swaps the untouched draft to their name
    await ask.getByRole('radio', { name: 'ผู้ใช้ req_con (ผู้ขอ)' }).check()
    await expect(text).toHaveValue(/^เรียนคุณผู้ใช้ req_con /)
    await ask.getByRole('radio', { name: 'ผู้ใช้ receiver_con (ผู้ตรวจรับ)' }).check()
    await text.fill(`${await text.inputValue()} ช่วยตอบภายในวันนี้`)
    await check(page, testInfo, 'exception-helper-draft')
    await ask.getByRole('button', { name: 'ตรวจก่อนส่งคำถาม' }).click()
    const confirm = page.getByRole('alertdialog', { name: 'ส่งคำถามถึง ผู้ใช้ receiver_con' })
    await expect(confirm).toContainText('ช่วยตอบภายในวันนี้')
    await check(page, testInfo, 'exception-helper-confirm')
    await confirm.getByRole('button', { name: 'ส่งคำถาม' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'ส่งคำถามถึง ผู้ใช้ receiver_con แล้ว' })).toBeVisible()

    // The e-mail to the supplier, the same way
    await item.getByRole('button', { name: 'ร่างอีเมลถึงผู้ขาย' }).click()
    const email = item.getByRole('region', { name: 'ร่างอีเมลถึงผู้ขาย' })
    await expect(email.getByLabel('ข้อความ')).toHaveValue(/เรียกเก็บ 10 ชิ้น แต่เราได้รับของแล้ว 6 ชิ้น/)
    await email.getByRole('button', { name: 'ตรวจก่อนส่งอีเมล' }).click()
    await page.getByRole('alertdialog', { name: /^ส่งอีเมลถึง/ }).getByRole('button', { name: 'ส่งอีเมลถึงผู้ขาย' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'ส่งอีเมลถึงผู้ขายแล้ว' })).toBeVisible()

    // The history names who pressed send
    const history = page.getByRole('list', { name: 'ประวัติของใบแจ้งหนี้' })
    if (testInfo.project.name !== 'mobile') await page.getByRole('tab', { name: 'ที่มา' }).click()
    await expect(history.getByRole('listitem').filter({ hasText: 'ส่งคำถามเรื่องรายการไม่ตรงถึงผู้ตรวจรับหรือผู้ขอ' })).toContainText('ผู้ใช้ fin_officer')
    await expect(history.getByRole('listitem').filter({ hasText: 'ส่งอีเมลถามผู้ขายเรื่องรายการไม่ตรง' })).toContainText('ผู้ใช้ fin_officer')

    // The job supplier-notice-send (not run by the e2e app) sends the e-mail: the supplier reads FINANCE's words
    s8Scene('notices')
    const asked = async () => (await messagesTo(made.supplierEmail)).filter((m) => m.Subject.startsWith('คำถามเรื่องใบแจ้งหนี้'))
    await expect.poll(async () => (await asked()).length, { timeout: 20_000 }).toBe(1)
    const [mail] = await asked()
    expect(mail!.Text).toContain('แต่เราได้รับของแล้ว 6 ชิ้น')
    expect(mail!.Text).toContain('ผู้ติดต่อ: ผู้ใช้ fin_officer')

    // The receiver: the question in the bell, and a helper that offers receiving the rest, never the supplier
    const context = await browser.newContext({ viewport: page.viewportSize(), locale: 'th-TH', timezoneId: 'Asia/Bangkok' })
    const receiver = await context.newPage()
    await signIn(receiver, 'receiver_con', tag)
    const bell = receiver.locator('details:has(> summary[aria-label^="แจ้งเตือน"])').filter({ visible: true })
    await bell.locator('summary').click()
    await expect(bell).toContainText(`ผู้ใช้ fin_officer ถามเรื่องใบแจ้งหนี้ ${made.number}`)
    await expect(bell).toContainText('ช่วยตอบภายในวันนี้')
    await receiver.keyboard.press('Escape')
    await receiver.goto(`/finance/invoices/${made.invoiceId}`)
    const theirs = receiver.getByRole('region', { name: 'ผู้ช่วยแก้รายการไม่ตรง' }).getByRole('list', { name: 'ทางแก้ที่คุณทำได้' })
    await expect(theirs.getByRole('link')).toHaveText(['ตรวจรับให้ครบ แล้วระบบตรวจซ้ำเอง', 'ถามผู้ตรวจรับหรือผู้ขอ', 'ตรวจซ้ำหลังแก้ที่ต้นเหตุแล้ว'])
    await expect(theirs.getByRole('link', { name: 'ตรวจรับให้ครบ แล้วระบบตรวจซ้ำเอง' })).toHaveAttribute('href', `/receiving/${made.poId}`)
    await expect(receiver.getByRole('button', { name: 'ร่างอีเมลถึงผู้ขาย' })).toHaveCount(0)
    await check(receiver, testInfo, 'exception-helper-receiver')
    await context.close()
  })
})
