import type { Locator } from '@playwright/test'
import { expect, test } from './fixtures'
import { castOf, expectNoBlockingAxe, expectNoSideways, fixture, shot, signIn } from './tasks-support'

// NEW-121 (ADR-078 · FR-VIS-006 AC7 AC8): the home card "ผู้ช่วยเจอให้คุณ" in the browser, at 1440 px and on the phone. A
// request of the requester's waits long past its approver's due time (tests/e2e/tasks-fixtures.ts overdue): the card
// says so with one way to the request; on a computer it heads the right column, on a phone it comes right after "สิ่งที่
// ต้องทำ"; "ไม่ใช่เรื่องนี้" hides it for this member, also after a reload. The sources and their permissions are
// tests/integration/home-assistant.test.ts.

type Made = { requestId: string; number: string; taskId: string }

const top = async (l: Locator) => (await l.boundingBox())!.y
const left = async (l: Locator) => (await l.boundingBox())!.x

test('[FR-VIS-006/AC7] [FR-VIS-006/AC8] the requester reads the request past its due time and sets it aside', async ({ page }, testInfo) => {
  const cast = castOf(testInfo)
  const made = fixture<Made>('overdue', cast.requester, `เครื่องพิมพ์ (ผู้ช่วย ${testInfo.project.name})`)
  await signIn(page, cast.requester, false)

  const card = page.getByRole('region', { name: 'ผู้ช่วยเจอให้คุณ' })
  await expect(card.getByText('จากกฎและข้อมูลในระบบ ไม่ได้ใช้ AI', { exact: true })).toBeVisible()
  const list = card.getByRole('list', { name: 'เรื่องที่ผู้ช่วยเจอ' })
  const note = list.locator(`[data-assistant-note="FOLLOW_OVERDUE:${made.taskId}"]`)
  await expect(note).toBeVisible()
  await expect(note.getByText(`${made.number} เกินกำหนดอนุมัติแล้ว`, { exact: true })).toBeVisible()
  await expect(note.getByText(/^รอ .+ · ครบกำหนดเมื่อ .+ · ระบบเตือนผู้อนุมัติตามเวลาแล้ว$/)).toBeVisible()
  await expect(note.getByRole('link', { name: 'ดูคำขอ' })).toHaveAttribute('href', `/requests/${made.requestId}`)
  // nothing from an AI: no Sparkles, no "AI" label on the card
  await expect(card.locator('svg.lucide-sparkles')).toHaveCount(0)

  // where it stands: the right column's head on a computer, right after the to-do card on a phone
  const todo = page.getByRole('region', { name: 'สิ่งที่ต้องทำ' })
  const approvals = page.getByRole('region', { name: 'รอฉันอนุมัติ' })
  const onTime = page.getByRole('region', { name: 'งานอนุมัติทันเวลา' })
  if (testInfo.project.name === 'mobile') {
    expect(await top(card)).toBeGreaterThan(await top(todo))
    expect(await top(card)).toBeLessThan(await top(approvals))
  } else {
    expect(await left(card)).toBeGreaterThan(await left(todo))
    expect(await top(card)).toBeLessThan(await top(onTime))
  }
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'home-assistant')

  // set aside: gone, and still gone after a reload
  const title = await note.locator('[data-slot="item-title"]').innerText()
  await note.getByRole('button', { name: `ไม่ใช่เรื่องนี้: ${title}` }).click()
  await expect(note).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('region', { name: 'ผู้ช่วยเจอให้คุณ' })).toBeVisible()
  await expect(page.locator(`[data-assistant-note="FOLLOW_OVERDUE:${made.taskId}"]`)).toHaveCount(0)
})
