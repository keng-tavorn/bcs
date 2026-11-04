import { check, h1, SCENE_TEST_TIMEOUT_MS, tagOf } from './finance-support'
import { expect, test } from './fixtures'
import { s8Scene, signIn } from './s8-support'

// NEW-117 (FR-AP-103 AC8): the quick view of the invoice list. From the keyboard, "ดูเร็ว" on a row opens a Sheet with
// the invoice's status and total, the same alerts as the badge on its page, how it arrived, its file and its latest
// activity, and a link to the full page; Esc closes it and gives focus back to the row. A press on the row opens it too.
// Opening it changes nothing: the invoice keeps its status and its history. axe, no sideways scrolling and pictures at
// 375 px and 1440 px (§9.9).

test.describe('@s8 the quick view of the invoice list', () => {
  test.describe.configure({ timeout: SCENE_TEST_TIMEOUT_MS })

  test('[FR-AP-103/AC8] a row opens the quick view from the keyboard and by a press, and it changes nothing', async ({ page }, testInfo) => {
    const tag = tagOf(testInfo)
    const made = s8Scene<{ invoiceId: string; number: string }>('alerts', tag)
    await signIn(page, 'fin_officer', tag)

    // The history as the full page has it before anything is opened
    await page.goto(`/finance/invoices/${made.invoiceId}?tab=source`)
    await expect(h1(page)).toContainText(made.number)
    const history = page.getByRole('list', { name: 'ประวัติของใบแจ้งหนี้' })
    const before = await history.getByRole('listitem').count()
    expect(before).toBeGreaterThan(0)

    await page.goto('/finance/invoices?tab=exceptions')
    const quick = page.getByRole('link', { name: `ดูเร็ว ${made.number}`, exact: true })
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // From the keyboard
    await quick.focus()
    await page.keyboard.press('Enter')
    const sheet = page.getByRole('dialog', { name: `ใบแจ้งหนี้ ${made.number}` })
    await expect(sheet).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`[?&]view=${made.invoiceId}`))
    await expect(sheet).toContainText('ไม่ตรง')
    await expect(sheet).toContainText('1,177.00 บาท')
    const alerts = sheet.getByRole('region', { name: 'แจ้งเตือน (2)' })
    await expect(alerts).toContainText('ราคาสูงกว่า PO เกินเกณฑ์')
    await expect(alerts).toContainText('บรรทัด 1 · 100.00 บาท · ส่งถึงฝ่ายจัดซื้อ')
    await expect(alerts).toContainText('เลิกกิจการ')
    await expect(sheet.getByRole('region', { name: 'ที่มาของใบนี้' })).toBeVisible()
    await expect(sheet.getByRole('region', { name: 'ไฟล์ต้นฉบับ' })).toContainText('ใบนี้ไม่มีไฟล์ต้นฉบับ')
    const activity = sheet.getByRole('list', { name: 'กิจกรรมล่าสุด' })
    expect(await activity.getByRole('listitem').count()).toBe(Math.min(before, 5))
    // Nothing in it changes the invoice: links and the close button only
    await expect(sheet.getByRole('button')).toHaveText([/ปิด/])
    await check(page, testInfo, 'invoice-quick-view')

    await page.keyboard.press('Escape')
    await expect(sheet).toHaveCount(0)
    await expect(page).not.toHaveURL(/view=/)
    await expect(quick).toBeFocused()

    // A press on the row, then to the full page
    const row = testInfo.project.name === 'mobile' ? page.getByRole('listitem').filter({ has: quick }) : page.getByRole('row').filter({ has: quick })
    await row.getByText('ผู้ขาย', { exact: false }).first().click()
    await expect(sheet).toBeVisible()
    await sheet.getByRole('link', { name: 'เปิดหน้าเต็ม' }).click()
    await expect(h1(page)).toContainText(made.number)
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // The invoice is as it was: still waiting on its difference, with no new history
    await page.goto(`/finance/invoices/${made.invoiceId}?tab=source`)
    await expect(page.getByRole('list', { name: 'ประวัติของใบแจ้งหนี้' }).getByRole('listitem')).toHaveCount(before)
    await expect(page.getByRole('button', { name: '2 แจ้งเตือน' })).toBeVisible()
  })

  test("[FR-AP-103/AC8] an address naming another organization's invoice, or no invoice, opens nothing", async ({ page }, testInfo) => {
    const tag = tagOf(testInfo)
    s8Scene<{ invoiceId: string }>('alerts', tag)
    const other = s8Scene<{ invoiceId: string }>('alerts', `${tag}x`)
    await signIn(page, 'fin_officer', tag)
    for (const view of [other.invoiceId, '00000000-0000-7000-8000-000000000000', 'not-an-id']) {
      await page.goto(`/finance/invoices?tab=exceptions&view=${view}`)
      await expect(h1(page)).toBeVisible()
      await expect(page.getByRole('dialog'), view).toHaveCount(0)
    }
  })
})
