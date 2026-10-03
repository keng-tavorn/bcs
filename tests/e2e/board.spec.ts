import { type Locator, type Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { checkScreen, scene, settleNoticesAfterEachTest, signIn, signInAs, type BoardScene } from './insight-support'

// S4-10 · FR-VIS-001 (spec §11.1, demo scene 9): the board "เอกสารค้างที่ใคร" — every person holding open documents
// within the reader's scope, the ones past their SLA first, ages in business hours; a name opens that person's
// documents, and a document can be reminded by hand once an hour — by the requester here; the auditor reads only
// (BR-AUTH-04) and gets no reminder button. tests/e2e/insight-scene.ts makes, for each project,
// a request waiting 18 business hours at a VP (past its 8-hour SLA, like Demo_History H12) and one the DM asked the
// requester about; desktop works in CON (vp_ops, dm_con), mobile in IT (vp_sup, dm_it).

settleNoticesAfterEachTest(test)

/** One person's block on the board: a table row on wide screens, a list item on phones */
function personBlock(page: Page, name: string): Locator {
  return page.locator('tr:visible, li:visible').filter({ has: page.getByRole('link', { name: `ดูเอกสารที่ค้างที่ ${name}`, exact: true }) })
}

/** The number in a figure link "เกินกำหนด 2 ฉบับที่ …: ดูเอกสาร" */
async function figure(block: Locator, what: 'รอตัดสิน' | 'เกินกำหนด' | 'รอผู้ขอตอบ', name: string): Promise<number> {
  const link = block.getByRole('link', { name: new RegExp(`^${what} \\d+ ฉบับที่ ${name}: ดูเอกสาร$`) })
  const label = (await link.getAttribute('aria-label')) ?? ''
  return Number(/ (\d+) ฉบับ/.exec(label)?.[1] ?? Number.NaN)
}

test('[FR-VIS-001/AC1] the executive sees who holds open documents, past SLA first with their business hours, and filters by department and kind of document', async ({ page }, testInfo) => {
  // a scene of its own (a separate process through the services) and axe on several screens
  test.slow()
  const s = scene<BoardScene>('board', testInfo.project.name)
  const vp = s.overdue.approver
  await signInAs(page, 'ceo')
  await page.goto('/board/pending')
  await expect(page.getByRole('heading', { level: 1, name: 'เอกสารค้างที่ใคร' })).toBeVisible()
  await expect(page.getByText('แสดงเอกสารค้างทั้งองค์กร')).toBeVisible()
  await expect(page.getByText(/^นับเวลาถึง .+ · อายุงานนับเฉพาะชั่วโมงทำการ$/)).toBeVisible()

  // The VP holds the request past its SLA: at least one past due, the oldest at least 18 business hours
  const row = personBlock(page, vp.name)
  await expect(row).toHaveCount(1)
  expect(await figure(row, 'เกินกำหนด', vp.name)).toBeGreaterThanOrEqual(1)
  expect(await figure(row, 'รอตัดสิน', vp.name)).toBeGreaterThanOrEqual(1)
  const oldest = Number((await row.locator('td, dd').nth(3).innerText()).match(/\d+\.\d/)?.[0])
  expect(oldest).toBeGreaterThanOrEqual(18)
  // People with documents past due come first: nobody above the VP has none past due
  const blocks = page.locator('tbody tr:visible, ul[aria-label="เอกสารค้างแยกตามผู้รับงาน"] > li:visible')
  const names = await blocks.evaluateAll((els) => els.map((el) => el.querySelector('a')?.textContent ?? ''))
  for (const name of names.slice(0, names.indexOf(vp.name))) expect(await figure(personBlock(page, name), 'เกินกำหนด', name)).toBeGreaterThanOrEqual(1)
  // The DM's question waits for the requester
  const dm = personBlock(page, s.waiting.approver.name)
  expect(await figure(dm, 'รอผู้ขอตอบ', s.waiting.approver.name)).toBeGreaterThanOrEqual(1)
  await checkScreen(page, testInfo, 'board')

  // Filter by the holder's department: the VP's division holds only the VP
  await page.getByLabel('แผนกของผู้รับงาน').selectOption({ label: s.overdue.approverDepartment.nameTh })
  await page.getByRole('button', { name: 'แสดงตามตัวกรอง' }).click()
  await expect(page).toHaveURL(new RegExp(`department=${s.overdue.approverDepartment.id}`))
  await expect(personBlock(page, vp.name)).toHaveCount(1)
  await expect(personBlock(page, s.waiting.approver.name)).toHaveCount(0)
  // …and by kind: purchase orders wait at no VP
  await page.getByLabel('ชนิดเอกสาร').selectOption({ label: 'ใบสั่งซื้อ' })
  await page.getByRole('button', { name: 'แสดงตามตัวกรอง' }).click()
  await expect(page.getByText('ไม่พบเอกสารค้างตามตัวกรองนี้')).toBeVisible()
  await checkScreen(page, testInfo, 'board-filtered-empty')
  await page.getByRole('link', { name: 'ล้างตัวกรอง' }).first().click()
  await expect(page).toHaveURL(/\/board\/pending$/)
  await expect(page.getByLabel('แผนกของผู้รับงาน')).toHaveValue('')
  await expect(page.getByLabel('ชนิดเอกสาร')).toHaveValue('')

  // A requester's board holds their own documents only: the VP with their request, the DM with their question
  await page.context().clearCookies()
  await signIn(page, s.requester.email, null)
  await page.goto('/board/pending')
  await expect(page.getByText('แสดงงานของคุณและเอกสารที่คุณขอ')).toBeVisible()
  await expect(personBlock(page, vp.name)).toHaveCount(1)
  expect(await figure(personBlock(page, vp.name), 'รอตัดสิน', vp.name)).toBe(1)
  expect(await figure(personBlock(page, s.waiting.approver.name), 'รอผู้ขอตอบ', s.waiting.approver.name)).toBe(1)
  await expect(page.locator('tbody tr:visible, ul[aria-label="เอกสารค้างแยกตามผู้รับงาน"] > li:visible')).toHaveCount(2)
  await checkScreen(page, testInfo, 'board-requester')
})

test('[FR-VIS-001/AC2] a name lists that person’s documents with links, and a document is reminded by hand once an hour — the second reminder is refused in plain words; the auditor reads only', async ({ page }, testInfo) => {
  // a scene of its own (a separate process through the services) and axe on several screens
  test.slow()
  const s = scene<BoardScene>('board', testInfo.project.name)
  const vp = s.overdue.approver
  // The requester follows their own request, waiting at the VP past its SLA
  await signIn(page, s.requester.email, null)
  await page.goto('/board/pending')
  await personBlock(page, vp.name).getByRole('link', { name: `ดูเอกสารที่ค้างที่ ${vp.name}`, exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/board/pending/${vp.id}$`))
  await expect(page.getByRole('heading', { level: 1, name: `เอกสารที่ค้างที่ ${vp.name}` })).toBeVisible()
  const item = page.getByRole('list', { name: `เอกสารที่ค้างที่ ${vp.name}` }).getByRole('listitem').filter({ hasText: s.overdue.number })
  await expect(item.getByRole('link', { name: `${s.overdue.number} ${s.overdue.title}` })).toHaveAttribute('href', `/requests/${s.overdue.id}`)
  await expect(item).toContainText(/ค้างมา 1[89]\.\d ชั่วโมงทำการ/)
  await expect(item).toContainText('เกินกำหนดตั้งแต่')
  await expect(item).toContainText('คำขอ · มอบงานเมื่อ')
  await checkScreen(page, testInfo, 'board-person')

  // Remind: sent, and when the next one may go
  const remind = item.getByRole('button', { name: `ส่งเตือน ${vp.name} เรื่อง ${s.overdue.number} ${s.overdue.title}` })
  await remind.click()
  await expect(item.getByRole('status')).toContainText(/^ส่งเตือนแล้วเมื่อ .+ · ส่งเตือนเอกสารนี้ได้อีกครั้งหลัง .+$/)
  // Within the hour: refused, in plain words, with the time it may be sent again
  await remind.click()
  await expect(item.getByRole('alert')).toHaveText(/^ยังส่งเตือนไม่ได้ เพราะมีคนเตือนเอกสารนี้ไปแล้วภายใน 1 ชั่วโมง ส่งเตือนได้อีกครั้งหลัง .+ น\.$/)
  await checkScreen(page, testInfo, 'board-remind-refused')
  // The board remembers it for everyone who opens the page
  await page.reload()
  await expect(page.getByRole('list', { name: `เอกสารที่ค้างที่ ${vp.name}` }).getByRole('listitem').filter({ hasText: s.overdue.number })).toContainText('ส่งเตือนแล้วภายในชั่วโมงนี้ ส่งได้อีกครั้งหลัง')

  // A document waiting for the requester's answer has nothing to remind the approver of
  await page.getByRole('link', { name: 'กลับไปกระดานเอกสารค้าง' }).click()
  await personBlock(page, s.waiting.approver.name).getByRole('link', { name: `ดูเอกสารที่ค้างที่ ${s.waiting.approver.name}`, exact: true }).click()
  const waiting = page.getByRole('list', { name: `เอกสารที่ค้างที่ ${s.waiting.approver.name}` }).getByRole('listitem').filter({ hasText: s.waiting.number })
  await expect(waiting).toContainText('รอผู้ขอตอบคำถาม')
  await expect(waiting.getByRole('button')).toHaveCount(0)
  await checkScreen(page, testInfo, 'board-person-waiting')

  // The auditor sees the same request past its SLA but sends no reminder: the AUDITOR reads only (BR-AUTH-04)
  await page.context().clearCookies()
  await signInAs(page, 'auditor')
  await page.goto(`/board/pending/${vp.id}`)
  const seen = page.getByRole('list', { name: `เอกสารที่ค้างที่ ${vp.name}` }).getByRole('listitem').filter({ hasText: s.overdue.number })
  await expect(seen).toContainText('เกินกำหนดตั้งแต่')
  await expect(seen.getByRole('button')).toHaveCount(0)
  await expect(page.getByText('เอกสารที่ไม่มีปุ่มส่งเตือนเป็นเอกสารที่คุณเห็นในฐานะผู้ตรวจสอบ ซึ่งดูได้อย่างเดียวและส่งเตือนไม่ได้')).toBeVisible()
  await checkScreen(page, testInfo, 'board-auditor')
})
