import { spawnSync } from 'node:child_process'
import { type Page, type TestInfo } from '@playwright/test'
import { e2eEnv } from '../support/e2e-env'
import { expectNoBlockingAxe, expectNoSideways, shot, signIn } from './budgets-support'
import { expect, test } from './fixtures'

// S6-16 on screen (FR-BUD-101 AC1 AC2, §9.1 /budgets/overruns/[id]): on the DEMO organization, with an OVER_BUDGET rule
// the scene (budget-overrun-scene.ts) adds to the DOA in effect for this test only, the requester of a draft of 6,000.00
// on a line of 5,000.00 sees what is short and asks for the 1,000.00 with a reason in a Dialog (an empty reason is
// refused beside the field); the approver the route picks sees the task with the shortfall, the reason and the link to
// the source request, opens the request, and approves; the requester then sends the request, which uses the
// approval. Screenshots at 375 px (mobile) and 1440 px (desktop) go to the test output (§9.9 step 4); every state is
// checked with axe (step 5). Without the rule no button shows: tests/integration/budget-overrun.test.ts and the unit
// tests of the panel (tests/unit/budget-overrun-screens.test.ts).

interface Setup {
  readonly ruleId: string
  readonly requester: { readonly code: string; readonly email: string; readonly name: string }
  readonly line: { readonly id: string; readonly code: string; readonly nameTh: string }
  readonly request: { readonly id: string; readonly title: string }
  readonly reason: string
}

interface OpenTask {
  readonly taskId: string
  readonly code: string
  readonly email: string
  readonly name: string
  readonly totp: boolean
}

function scene<T>(...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/budget-overrun-scene.ts ${args.map((a) => `"${a}"`).join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`budget overrun scene failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}

const width = (testInfo: TestInfo) => (testInfo.project.name === 'mobile' ? '375' : '1440')

async function check(page: Page, testInfo: TestInfo, name: string) {
  await expectNoSideways(page)
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, `${name}-${width(testInfo)}`)
}

/** "ถัดไป" in the form's bar, step after step, until its last button sends */
async function toReview(page: Page) {
  const send = page.getByRole('button', { name: 'ส่งขออนุมัติ', exact: true })
  for (let i = 0; i < 6 && !(await send.isVisible()); i++) {
    await page.getByRole('button', { name: /^ถัดไป: / }).click()
  }
  await expect(page.getByRole('heading', { level: 2, name: /ตรวจและส่ง$/ })).toBeVisible()
  return send
}

const overrunSection = (page: Page) => page.getByRole('region', { name: 'ขออนุมัติเกินงบ', exact: true })

test('[FR-BUD-101/AC1] [FR-BUD-101/AC2] the requester asks for the shortfall with a reason, the approver reads the source request and approves, and the request is sent with it', async ({ page }, testInfo) => {
  // A scene of its own, two members, five pages, axe and a screenshot at each state: longer than the default 30 s
  test.slow()
  const s = scene<Setup>('setup', testInfo.project.name)
  try {
    // The requester's draft: what the request needs, what is left and what is short, with the button
    await signIn(page, s.requester.email, null)
    await page.goto(`/requests/${s.request.id}`)
    await expect(page.getByRole('heading', { level: 1 })).toContainText(s.request.title)
    const section = overrunSection(page)
    await expect(section).toBeVisible()
    await expect(section).toContainText(`งบของบรรทัด ${s.line.code} · ${s.line.nameTh} ไม่พอสำหรับคำขอนี้`)
    await expect(section).toContainText('ยอดที่คำขอนี้ต้องใช้6,000.00')
    await expect(section).toContainText('คงเหลือที่ใช้ได้5,000.00')
    await expect(section).toContainText('ขาดอีก1,000.00')
    await section.scrollIntoViewIfNeeded()
    await check(page, testInfo, 'budget-overrun-offer')

    // The Dialog: an empty reason is refused beside the field and nothing is sent
    await section.getByRole('button', { name: 'ขออนุมัติเกินงบ', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: 'ขออนุมัติเกินงบ' })).toBeVisible()
    await expect(dialog).toContainText('ขออนุมัติส่วนที่ขาด 1,000.00 บาท')
    await dialog.getByRole('button', { name: 'ส่งขออนุมัติเกินงบ', exact: true }).click()
    const reason = dialog.getByLabel('เหตุผลที่ต้องใช้เกินงบ')
    await expect(dialog.getByText('ใส่เหตุผลอย่างน้อย 3 ตัวอักษร')).toBeVisible()
    await expect(reason).toHaveAttribute('aria-invalid', 'true')
    await expect(reason).toBeFocused()
    await check(page, testInfo, 'budget-overrun-ask-dialog')

    // Sent: said in the button's words, the overrun listed as waiting, and the request locked meanwhile
    await reason.fill(s.reason)
    await dialog.getByRole('button', { name: 'ส่งขออนุมัติเกินงบ', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const asked = scene<{ id: string; number: string; status: string }>('overrun', s.request.id)
    expect(asked.status).toBe('PENDING_APPROVAL')
    await expect(section.getByRole('status').filter({ hasText: `ส่งขออนุมัติเกินงบ ${asked.number} แล้ว` })).toBeVisible()
    const row = section.getByRole('listitem').filter({ hasText: asked.number })
    await expect(row).toContainText('รออนุมัติ')
    await expect(row).toContainText('ยอดที่ขอเกินงบ 1,000.00 บาท')
    await expect(row).toContainText('ระหว่างนี้แก้ยอดเงินหรือบรรทัดงบของคำขอไม่ได้')
    await expect(row.getByRole('button', { name: `ยกเลิกการขอเกินงบ ${asked.number}` })).toBeVisible()
    await expect(section.getByRole('button', { name: 'ขออนุมัติเกินงบ', exact: true })).toHaveCount(0)
    await check(page, testInfo, 'budget-overrun-pending')

    // The approver the route picks: the task with the shortfall, the reason and the way to the source request
    const task = scene<OpenTask>('task', asked.id)
    await page.context().clearCookies()
    await signIn(page, task.email, task.totp ? task.code : null)
    await page.goto(`/tasks/${task.taskId}`)
    await expect(page.getByRole('heading', { level: 1, name: `ขออนุมัติเกินงบ ${asked.number}` })).toBeVisible()
    const subject = page.getByRole('region', { name: 'การขออนุมัติเกินงบที่รอตัดสิน' })
    await expect(subject).toContainText('1,000.00 บาท')
    await expect(subject).toContainText(`${s.line.code} · ${s.line.nameTh}`)
    await expect(subject).toContainText(s.reason)
    await expect(subject).toContainText(s.requester.name)
    const toRequest = subject.getByRole('link', { name: `เปิดคำขอต้นทาง ${s.request.title}` })
    await expect(toRequest).toHaveAttribute('href', `/requests/${s.request.id}`)
    await check(page, testInfo, 'budget-overrun-task')

    // The approver reads the source request through the task (request.view ASSIGNED)
    await toRequest.click()
    await expect(page.getByRole('heading', { level: 1 })).toContainText(s.request.title)
    await expect(overrunSection(page).getByRole('listitem').filter({ hasText: asked.number })).toContainText('รออนุมัติ')
    await expect(overrunSection(page).getByRole('button')).toHaveCount(0)
    await page.goBack()
    await expect(page.getByRole('heading', { level: 1, name: `ขออนุมัติเกินงบ ${asked.number}` })).toBeVisible()

    // Approves
    await page.getByRole('button', { name: 'อนุมัติ', exact: true }).click()
    await page.getByRole('button', { name: 'ยืนยันอนุมัติ', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: 'อนุมัติแล้ว' }).first()).toBeVisible()
    expect(scene<{ status: string }>('overrun', s.request.id).status).toBe('APPROVED')

    // The requester: approved and set aside, no button; the request goes with it
    await page.context().clearCookies()
    await signIn(page, s.requester.email, null)
    await page.goto(`/requests/${s.request.id}`)
    const approved = overrunSection(page).getByRole('listitem').filter({ hasText: asked.number })
    await expect(approved).toContainText('อนุมัติแล้ว รอใช้')
    await expect(approved).toContainText('งบส่วนนี้กันไว้ให้คำขอนี้ถึง')
    await expect(overrunSection(page).getByRole('button', { name: 'ขออนุมัติเกินงบ', exact: true })).toHaveCount(0)
    await overrunSection(page).scrollIntoViewIfNeeded()
    await check(page, testInfo, 'budget-overrun-approved')

    await page.goto(`/requests/${s.request.id}/edit`)
    await expect(page.getByLabel('ชื่อคำขอ')).toHaveValue(s.request.title)
    const send = await toReview(page)
    await send.click()
    await expect(page.getByRole('status').filter({ hasText: 'ส่งขออนุมัติแล้ว' }).first()).toBeVisible()
    expect(scene<{ status: string }>('overrun', s.request.id).status).toBe('CONSUMED')

    // Its own page: used by the request, with the way back to it
    await page.goto(`/budgets/overruns/${asked.id}`)
    await expect(page.getByRole('heading', { level: 1, name: `ขออนุมัติเกินงบ ${asked.number}` })).toBeVisible()
    await expect(page.getByText('ใช้แล้ว', { exact: true })).toBeVisible()
    await expect(page.getByText('ใช้กับคำขอแล้ว')).toBeVisible()
    await expect(page.getByRole('button', { name: `ยกเลิกการขอเกินงบ ${asked.number}` })).toHaveCount(0)
    await check(page, testInfo, 'budget-overrun-detail')
  } finally {
    scene('cleanup', s.ruleId, s.request.id)
  }
})
