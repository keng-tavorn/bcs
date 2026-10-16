import { spawnSync } from 'node:child_process'
import { type Page, type TestInfo } from '@playwright/test'
import { e2eEnv } from '../support/e2e-env'
import { expectNoBlockingAxe, expectNoSideways, shot, signIn } from './budgets-support'
import { expect, test } from './fixtures'

// S6-17 on screen (FR-BUD-102 AC1 AC2 · BR-BUD-16 · OQ-106): on the DEMO organization the scene (budget-split-scene.ts)
// makes a requester with two budget lines of their department and a draft of two lines on the first. In the form the
// requester puts line 2 on the second budget line, then splits line 1 (1 × 1,000.01) with "แบ่งบรรทัด": the Dialog
// starts with halves, refuses a part of 0 beside it, and says before saving that the halves (500.01 each) come to 0.01
// above the line because each part is rounded on its own; one half goes on the second budget line. The draft saves,
// the request is sent, and its page lists both budget lines with what each holds, and names the budget line of the
// lines on the second. Screenshots at 375 px (mobile) and 1440 px (desktop) go to the test output (§9.9 step 4); every
// state is checked with axe (step 5).

interface BudgetLine {
  readonly id: string
  readonly code: string
  readonly nameTh: string
}

interface Setup {
  readonly requester: { readonly code: string; readonly email: string; readonly name: string }
  readonly first: BudgetLine
  readonly second: BudgetLine
  readonly request: { readonly id: string; readonly title: string }
}

function scene<T>(...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/budget-split-scene.ts ${args.map((a) => `"${a}"`).join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`budget split scene failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}

const width = (testInfo: TestInfo) => (testInfo.project.name === 'mobile' ? '375' : '1440')

async function check(page: Page, testInfo: TestInfo, name: string) {
  await expectNoSideways(page)
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, `${name}-${width(testInfo)}`)
}

const status = (page: Page, text: string | RegExp) => page.getByRole('status').filter({ hasText: text })

/** "ถัดไป" in the form's bar, step after step, until its last button sends */
async function toReview(page: Page) {
  const send = page.getByRole('button', { name: 'ส่งขออนุมัติ', exact: true })
  for (let i = 0; i < 6 && !(await send.isVisible()); i++) {
    await page.getByRole('button', { name: /^ถัดไป: / }).click()
  }
  await expect(page.getByRole('heading', { level: 2, name: /ตรวจและส่ง$/ })).toBeVisible()
  return send
}

test('[FR-BUD-102/AC1] [FR-BUD-102/AC2] a requester puts a line on another budget line, splits a line seeing the rounding difference first, and sends the request on both budget lines', async ({ page }, testInfo) => {
  // A scene of its own, a form of three steps, a Dialog, a send and the request's page, each with axe and a screenshot
  test.slow()
  const s = scene<Setup>('setup', testInfo.project.name)
  const name = (b: BudgetLine) => `${b.code} · ${b.nameTh}`
  try {
    await signIn(page, s.requester.email, null)
    await page.goto(`/requests/${s.request.id}/edit`)
    await expect(page.getByLabel('ชื่อคำขอ')).toHaveValue(s.request.title)
    await page.getByRole('button', { name: 'ถัดไป: รายการ ราคา และงบ', exact: true }).click()

    // Line 2 on the second budget line; "ตามคำขอ" names the request's own
    const line2 = page.getByRole('group', { name: 'รายการที่ 2' })
    const budget2 = line2.getByLabel('บรรทัดงบ', { exact: true })
    await expect(budget2.locator('option').first()).toHaveText(`ตามคำขอ (${s.first.code})`)
    await budget2.selectOption(s.second.id)

    // "แบ่งบรรทัด" of line 1: halves to start with, each with its amount
    const line1 = page.getByRole('group', { name: 'รายการที่ 1' })
    await line1.getByRole('button', { name: 'แบ่งรายการที่ 1' }).click()
    const dialog = page.getByRole('dialog', { name: 'แบ่งรายการที่ 1' })
    await expect(dialog).toContainText('ทุกส่วนรวมกันต้องได้ 1 เครื่อง')
    const quantities = dialog.getByLabel('จำนวน (เครื่อง)')
    await expect(quantities).toHaveCount(2)
    await expect(quantities.nth(0)).toHaveValue('0.5')
    await expect(quantities.nth(1)).toHaveValue('0.5')

    // A part of 0 is refused beside it, and nothing is split
    await quantities.nth(1).fill('0')
    await dialog.getByRole('button', { name: 'แบ่งเป็น 2 รายการ', exact: true }).click()
    await expect(dialog.getByText('ใส่จำนวนมากกว่า 0 เช่น 1 หรือ 2.5')).toBeVisible()
    await expect(quantities.nth(1)).toHaveAttribute('aria-invalid', 'true')
    await expect(quantities.nth(1)).toBeFocused()

    // Halves again: each 500.01, the total 0.01 above the line, said before saving (BR-BUD-16, OQ-106)
    await quantities.nth(1).fill('0.5')
    await expect(dialog.getByText('จำนวนเงิน 500.01 บาท')).toHaveCount(2)
    await expect(dialog).toContainText('ยอดเดิมของรายการ1,000.01 บาท')
    await expect(dialog).toContainText('ยอดรวมของทุกส่วน1,000.02 บาท')
    await expect(dialog.getByText('ยอดรวมต่างจากเดิม 0.01 บาท เพราะปัดเศษทีละส่วน')).toBeVisible()
    await dialog.getByLabel('บรรทัดงบ', { exact: true }).nth(1).selectOption(s.second.id)
    await check(page, testInfo, 'budget-split-dialog')
    await dialog.getByRole('button', { name: 'แบ่งเป็น 2 รายการ', exact: true }).click()
    await expect(dialog).toBeHidden()

    // Three lines now: the halves of line 1, then the old line 2 — each on its budget line
    await expect(page.getByRole('group', { name: /^รายการที่ \d+$/ })).toHaveCount(3)
    await expect(page.getByRole('group', { name: 'รายการที่ 1' }).getByLabel(/^จำนวน/)).toHaveValue('0.5')
    await expect(page.getByRole('group', { name: 'รายการที่ 1' }).getByLabel('บรรทัดงบ', { exact: true })).toHaveValue('')
    await expect(page.getByRole('group', { name: 'รายการที่ 2' }).getByLabel(/^จำนวน/)).toHaveValue('0.5')
    await expect(page.getByRole('group', { name: 'รายการที่ 2' }).getByLabel('บรรทัดงบ', { exact: true })).toHaveValue(s.second.id)
    await expect(page.getByRole('group', { name: 'รายการที่ 3' }).getByLabel('สิ่งที่ขอ')).toHaveValue('ค่าติดตั้งเครือข่าย')
    await expect(page.getByRole('group', { name: 'รายการที่ 3' }).getByLabel('บรรทัดงบ', { exact: true })).toHaveValue(s.second.id)
    // The request's budget line holds only line 1: 500.01 before VAT; the other two are checked on theirs at submit
    await expect(page.getByText('รายการที่ใช้บรรทัดนี้ (ยอดก่อน VAT)').first()).toBeVisible()
    await expect(page.getByText('อีก 2 รายการใช้บรรทัดงบของตัวเอง ระบบตรวจงบของบรรทัดเหล่านั้นตอนส่งขออนุมัติ').first()).toBeVisible()
    await page.getByRole('button', { name: 'บันทึกร่างตอนนี้' }).click()
    await expect(status(page, /^บันทึกร่างแล้ว/)).toBeVisible({ timeout: 25_000 })
    await check(page, testInfo, 'budget-split-form')

    // Sent
    const send = await toReview(page)
    await send.click()
    await expect(status(page, 'ส่งขออนุมัติแล้ว').first()).toBeVisible({ timeout: 25_000 })

    // The request's page: both budget lines with what each holds, and the lines on the second name it
    await page.goto(`/requests/${s.request.id}`)
    await expect(page.getByRole('heading', { level: 1 })).toContainText(s.request.title)
    const card = page.getByRole('region', { name: 'งบของเอกสารนี้' })
    const held = card.getByRole('list', { name: 'บรรทัดงบที่คำขอนี้ใช้' }).getByRole('listitem')
    await expect(held).toHaveCount(2)
    await expect(held.nth(0)).toContainText(name(s.first))
    await expect(held.nth(0)).toContainText('จองไว้สำหรับคำขอนี้ 500.01 บาท')
    await expect(held.nth(1)).toContainText(name(s.second))
    await expect(held.nth(1)).toContainText('จองไว้สำหรับคำขอนี้ 2,500.01 บาท')
    await card.scrollIntoViewIfNeeded()
    await check(page, testInfo, 'budget-split-request')

    await page.getByRole('tab', { name: 'รายการและงบ' }).click()
    const lines = page.getByRole('region', { name: 'รายการ', exact: true }).getByRole('listitem')
    await expect(lines).toHaveCount(3)
    await expect(lines.nth(0)).not.toContainText('บรรทัดงบ')
    await expect(lines.nth(1)).toContainText(`บรรทัดงบ ${name(s.second)}`)
    await expect(lines.nth(2)).toContainText(`บรรทัดงบ ${name(s.second)}`)
    const budget = page.getByRole('region', { name: 'งบประมาณ', exact: true })
    await expect(budget.getByRole('list', { name: 'บรรทัดงบที่คำขอนี้ใช้' }).getByRole('listitem')).toHaveCount(2)
    await expect(budget).toContainText('คำขอนี้แบ่งค่าใช้จ่ายหลายบรรทัดงบ')
    await check(page, testInfo, 'budget-split-lines')
  } finally {
    scene('cleanup', s.request.id)
  }
})
