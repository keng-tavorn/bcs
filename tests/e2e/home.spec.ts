import { spawnSync } from 'node:child_process'
import type { Page } from '@playwright/test'
import { e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'
import { castOf, expectNoBlockingAxe, expectNoSideways, fixture, shot, signIn } from './tasks-support'

// S16-09 · the home page "งานของฉัน" (spec §9.10, FR-VIS-006) in the browser, at 1440 px and on the phone: the greeting by
// first name, the search field and the chips opening the shell's palette and dialog; a to-do row and the followed
// requests opening lists that hold as many as they say; the tabs of the tasks waiting; a member with nothing to do told
// the next step; and the home's largest paint within 2.5 seconds on the phone (NFR-PERF-01). The numbers for every seed
// member are tests/integration/home.test.ts.

const firstWord = (name: string) => name.split(' ')[0]!

/** The number a text holds: "คำขอที่ถูกตีกลับรอแก้ 3 ใบ" → 3 */
const numberIn = (text: string) => Number(/(\d+)/.exec(text)![1])

/** The count line of /requests: "พบ {matched} จาก {total} คำขอ" → matched */
async function matchedOnRequests(page: Page): Promise<number> {
  const line = await page.getByRole('status').filter({ hasText: /^พบ \d+ จาก \d+ คำขอ$/ }).innerText()
  return numberIn(line)
}

/** A plain member nobody else has touched (tests/e2e/fresh-member-scene.ts) */
function freshMember(project: string): string {
  const code = `e2e-home-${project}-${Date.now().toString(36)}`
  const r = spawnSync('pnpm exec tsx tests/e2e/fresh-member-scene.ts', { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv(), SCENE_MEMBER_CODE: code } })
  if (r.status !== 0) throw new Error(`fresh member scene failed:\n${r.stdout}\n${r.stderr}`)
  return code
}

test('[FR-VIS-006/AC1] [FR-VIS-006/AC2] [FR-VIS-006/AC4] the requester’s home: greeting, search, chips, a to-do row and the followed requests open lists of as many', async ({ page }, testInfo) => {
  const cast = castOf(testInfo)
  // Requests of the requester's: one approved, one returned to fix, one waiting (tests/e2e/tasks-fixtures.ts)
  fixture('requests', cast.requester, cast.approver, cast.follower)
  await signIn(page, cast.requester, false)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`สวัสดี คุณ${firstWord(cast.requesterName)} วันนี้ต้องการทำอะไร`)

  // The search field opens the shell's palette; the chips: my work pressed, a new request's dialog, the register
  const content = page.locator('#content')
  await content.getByRole('button', { name: /ค้นหาเลขเอกสาร ผู้ขาย หรือเมนู/ }).click()
  const palette = page.getByRole('dialog', { name: 'ค้นหาและคำสั่ง' })
  await expect(palette).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(palette).toBeHidden()
  const chips = page.getByRole('list', { name: 'ทางลัดของหน้าแรก' })
  await expect(chips.getByRole('button', { name: 'งานของฉัน' })).toHaveAttribute('aria-pressed', 'true')
  await chips.getByRole('link', { name: 'เริ่มคำขอใหม่' }).click()
  const door = page.getByRole('dialog', { name: 'เริ่มคำขอใหม่' })
  await expect(door).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(door).toBeHidden()
  await expect(chips.getByRole('link', { name: 'ผู้ขายและราคา' })).toHaveAttribute('href', '/suppliers')

  // Every card is there, each with its title
  for (const title of ['สิ่งที่ต้องทำ', 'รอฉันอนุมัติ', 'งานอนุมัติทันเวลา', 'ที่ฉันติดตาม']) await expect(page.getByRole('heading', { level: 2, name: title })).toBeVisible()
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'home-requester')

  // "คำขอที่ถูกตีกลับรอแก้ n ใบ" opens the requester's returned requests: n of them
  const returned = page.getByRole('list', { name: 'สิ่งที่คุณต้องทำ' }).getByRole('link', { name: /^คำขอที่ถูกตีกลับรอแก้ \d+ ใบ$/ })
  const count = numberIn(await returned.innerText())
  expect(count).toBeGreaterThan(0)
  await returned.click()
  await expect(page).toHaveURL(/\/requests\?status=returned&scope=mine$/)
  await expect(page.getByText('เฉพาะคำขอที่คุณเป็นผู้ขอ', { exact: true })).toBeVisible()
  expect(await matchedOnRequests(page)).toBe(count)

  // "ที่ฉันติดตาม": n requests, five that moved last, and "see all" opens n
  await page.goto('/')
  const following = page.getByRole('region', { name: 'ที่ฉันติดตาม' })
  const summary = following.getByText(/^\d+ คำขอ · เปิดอยู่ \d+$/)
  const total = numberIn(await summary.innerText())
  await expect(following.getByRole('list', { name: 'คำขอที่ฉันติดตามซึ่งเคลื่อนไหวล่าสุด' }).getByRole('listitem')).toHaveCount(Math.min(total, 5))
  await following.getByRole('link', { name: 'ดูคำขอที่ติดตามทั้งหมด' }).click()
  await expect(page).toHaveURL(/\/requests\?scope=following$/)
  expect(await matchedOnRequests(page)).toBe(total)
})

test('[FR-VIS-006/AC5] [FR-VIS-006/AC3] the approver’s home: the tabs of the tasks waiting, each opening its decision page', async ({ page }, testInfo) => {
  const cast = castOf(testInfo)
  fixture('requests', cast.requester, cast.approver, cast.follower)
  await signIn(page, cast.approver, true)
  const card = page.getByRole('region', { name: 'รอฉันอนุมัติ' })
  const tabs = card.getByRole('tablist', { name: 'งานรอฉันอนุมัติแยกตามสถานะ' })
  const all = tabs.getByRole('tab', { name: /^ทั้งหมด \(\d+\)$/ })
  await expect(all).toHaveAttribute('aria-selected', 'true')
  const rows = card.getByRole('list', { name: 'งานรอฉันอนุมัติทั้งหมด' }).getByRole('listitem')
  await expect(rows.first()).toContainText('ยอดตามฐาน DOA')
  expect(await rows.count()).toBe(Math.min(numberIn(await all.innerText()), 10))
  // the overdue tab and the one waiting for the requester, each with its count
  await tabs.getByRole('tab', { name: /^รอผู้ขอตอบ \(\d+\)$/ }).click()
  await expect(tabs.getByRole('tab', { name: /^รอผู้ขอตอบ/ })).toHaveAttribute('aria-selected', 'true')
  await tabs.getByRole('tab', { name: /^ทั้งหมด/ }).click()
  // the on-time card: my tasks, with a percent or "nothing yet"
  await expect(page.getByRole('region', { name: 'งานอนุมัติทันเวลา' }).getByRole('link', { name: /^งานของฉัน/ })).toBeVisible()
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'home-approver')
  await rows.first().getByRole('link').click()
  await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/)
})

test('[FR-VIS-006/AC6] a member with nothing to do is told the next step, in each card', async ({ page }, testInfo) => {
  const code = freshMember(testInfo.project.name)
  await signIn(page, code, false)
  const todo = page.getByRole('region', { name: 'สิ่งที่ต้องทำ' })
  await expect(todo.getByText('ไม่มีงานที่ต้องทำตอนนี้', { exact: true })).toBeVisible()
  await expect(todo.getByRole('link', { name: 'เริ่มคำขอใหม่' })).toHaveAttribute('href', '/requests/new')
  await expect(todo.getByRole('link', { name: 'ดูคำขอของฉัน' })).toHaveAttribute('href', '/requests')
  await expect(page.getByRole('region', { name: 'รอฉันอนุมัติ' }).getByText('ยังไม่มีงานรออนุมัติ', { exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: 'ที่ฉันติดตาม' }).getByText('ยังไม่มีคำขอที่คุณส่งหรือติดตาม', { exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: 'งานอนุมัติทันเวลา' })).toContainText('ยังไม่มีงานอนุมัติของคุณใน 60 วันที่ผ่านมา')
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'home-empty')
})

test('[FR-VIS-006/AC6] the home paints its largest content within 2.5 seconds — the phone profile (§16.12 S16-09), and the desktop too (NFR-PERF-01)', async ({ page }, testInfo) => {
  const cast = castOf(testInfo)
  await signIn(page, cast.requester, false)
  // A fresh load of the home, signed in: the largest paint the browser reports once the page has loaded
  await page.goto('/', { waitUntil: 'load' })
  const lcp = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        new PerformanceObserver((list) => {
          const entries = list.getEntries()
          resolve(entries[entries.length - 1]!.startTime)
        }).observe({ type: 'largest-contentful-paint', buffered: true })
      }),
  )
  testInfo.annotations.push({ type: 'lcp-ms', description: String(Math.round(lcp)) })
  expect(lcp).toBeLessThanOrEqual(2500)
})
