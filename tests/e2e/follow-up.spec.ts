import { expect, test } from './fixtures'
import { castOf, expectNoBlockingAxe, expectNoSideways, fixture, shot, signIn } from './tasks-support'

// NEW-124 (ADR-082 · FR-VIS-001 AC4 to AC6): the follow-up assistant in the browser, at 1440 px and on the phone. The
// requester's request waits an hour past its approver's due time (tests/e2e/tasks-fixtures.ts followup). Its panel
// "จากผู้ช่วย" leads to the drafted nudge on /follow-ups, which lists why it waits; the requester edits the words,
// chooses e-mail, reads the confirmation with the whole text and sends it. The row then says it was nudged today and
// when it may go again; the approver finds the words in the bell. Every state is checked with axe.

type Made = { requestId: string; number: string; taskId: string }

test('[FR-VIS-001/AC4] [FR-VIS-001/AC5] [FR-VIS-001/AC6] the requester reads why the request waits and sends a nudge they confirmed', async ({ page, browser }, testInfo) => {
  const cast = castOf(testInfo)
  // one word: the fixture's arguments are split on spaces
  const made = fixture<Made>('followup', cast.requester, 'จอภาพตามงาน')
  await signIn(page, cast.requester, false)

  // the request's panel leads to the draft
  await page.goto(`/requests/${made.requestId}`)
  const panel = page.getByRole('region', { name: 'จากผู้ช่วย' })
  const draftLink = panel.getByRole('link', { name: 'ร่างข้อความทวง' })
  await expect(draftLink).toHaveAttribute('href', `/follow-ups#follow-up-${made.taskId}-draft`)
  await draftLink.click()
  await expect(page).toHaveURL(new RegExp(`/follow-ups#follow-up-${made.taskId}-draft$`))
  await expect(page.getByRole('heading', { level: 1, name: 'ผู้ช่วยตามงาน' })).toBeVisible()
  await expect(page.getByText('จากกฎและข้อมูลในระบบ ไม่ได้ใช้ AI', { exact: true })).toBeVisible()
  await expect(page.locator('main svg.lucide-sparkles')).toHaveCount(0)

  const row = page.locator(`[data-follow-up="${made.taskId}"]`)
  await expect(row.getByRole('heading', { level: 3 })).toHaveText(`คำขอ ${made.number} · จอภาพตามงาน`)
  await expect(row.getByText(/^เกินกำหนดแล้ว \(ครบเมื่อ .+\)$/)).toBeVisible()
  await expect(row.getByText('คุณเป็นผู้ขอ', { exact: false })).toBeVisible()
  await expect(row.getByRole('list', { name: 'ทำไมยังค้าง' }).getByRole('listitem').first()).toHaveText(`รอ ${cast.approverName} ตัดสิน`)
  await expect(row.getByRole('link', { name: 'เปิดคำขอ' })).toHaveAttribute('href', `/requests/${made.requestId}`)

  // reached by its link, the draft is open: to the holder only, drafted by code
  const draft = row.getByRole('region', { name: 'ร่างข้อความทวง' })
  await expect(draft.getByText(`ส่งถึง ${cast.approverName} ผู้ถืองานนี้`, { exact: true })).toBeVisible()
  const text = draft.getByLabel('ข้อความ')
  await expect(text).toHaveValue(new RegExp(`^เรียนคุณ${cast.approverName} ขอติดตามคำขอ ${made.number} ที่รอการพิจารณาจากคุณซึ่งครบกำหนดเมื่อ `))
  await expect(draft.getByRole('radio', { name: 'LINE (ถ้ายังไม่ผูก LINE ส่งทางอีเมล)' })).toBeChecked()
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'follow-up-draft')

  // the person changes the words and the way, then reads it all again before it goes
  await text.fill(`${await text.inputValue()} รบกวนดูภายในบ่ายนี้`)
  await draft.getByRole('radio', { name: 'อีเมล', exact: true }).check()
  await draft.getByRole('button', { name: 'ตรวจก่อนส่ง' }).click()
  const confirm = page.getByRole('alertdialog', { name: `ส่งข้อความทวงถึง ${cast.approverName}` })
  await expect(confirm).toContainText(`ระบบแจ้งทางอีเมลว่ามีข้อความติดตามคำขอ ${made.number}`)
  await expect(confirm).toContainText('รบกวนดูภายในบ่ายนี้')
  await expectNoBlockingAxe(page)
  await confirm.getByRole('button', { name: 'ส่งข้อความทวง' }).click()
  await expect(page.getByRole('status').filter({ hasText: `ส่งข้อความทวงถึง ${cast.approverName} แล้ว` })).toBeVisible()

  // once a day: the row says who nudged and when it may go again, and offers no draft
  await expect(row.getByRole('list', { name: 'ทำไมยังค้าง' })).toContainText('คุณส่งข้อความทวงงานนี้แล้ววันนี้เมื่อ')
  await expect(row.getByText(/^ทวงงานนี้ได้อีกครั้ง .+$/)).toBeVisible()
  await expect(row.getByRole('button', { name: 'ร่างข้อความทวง' })).toHaveCount(0)
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'follow-up-sent')

  // the approver reads who sent it and the words in the bell
  const context = await browser.newContext({ viewport: page.viewportSize(), locale: 'th-TH', timezoneId: 'Asia/Bangkok' })
  const approver = await context.newPage()
  await signIn(approver, cast.approver, true)
  const bell = approver.locator('details:has(> summary[aria-label^="แจ้งเตือน"])').filter({ visible: true })
  await bell.locator('summary').click()
  await expect(bell).toContainText(`${cast.requesterName} ติดตามงานอนุมัติคำขอ ${made.number}`)
  await expect(bell).toContainText('รบกวนดูภายในบ่ายนี้')
  await context.close()
})
