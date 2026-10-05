import { spawnSync } from 'node:child_process'
import { type Page } from '@playwright/test'
import { e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'
import { checkScreen, signIn } from './insight-support'

// NEW-46 and NEW-47 on the request page (FR-INT-008 AC1, FR-NOTI-003 AC2, BR-SLA-04): a step past its escalation time
// waits for the DM it went to and for the VP of the band above, added as co-assignee — whoever decides first decides.
// The requester's page names both wherever it says whom the request waits for: the "now" line, the route's step and the
// timeline's current step. Once the VP decides, the route names the VP and nobody waits on that step any more; the
// step and the decision's stamp carry the escalated flag of BR-SLA-04 under the route's own DOA rule.
// tests/e2e/coassign-scene.ts makes the request through the services with the business clock set back, and decides it
// as the VP; each project uses its own requester and department (CON on desktop, IT on phones).

interface Escalated {
  readonly run: string
  readonly requester: { readonly code: string; readonly email: string; readonly name: string }
  readonly request: { readonly id: string; readonly number: string; readonly title: string }
  readonly first: { readonly taskId: string; readonly name: string }
  readonly coAssignee: { readonly taskId: string; readonly name: string }
  readonly doaRef: string
}

/** Runs tests/e2e/coassign-scene.ts against the e2e database and returns the JSON of its last line */
function scene<T>(...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/coassign-scene.ts ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`co-assignee scene ${args[0]} failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}

/** The page's own heading block, and its "ตอนนี้: …" line */
const heading = (page: Page) => page.locator('#content header')
const nowLine = (page: Page) => heading(page).locator('p', { hasText: 'ตอนนี้:' })
/** The steps of the route (each a list item; an escalated step lists its approvers inside) */
const routeSteps = (page: Page) => page.getByRole('region', { name: 'เส้นทางอนุมัติ' }).locator('ol')
const stepOne = (page: Page) => routeSteps(page).locator(':scope > li').first()
const timeline = (page: Page) => page.getByRole('list', { name: 'ไทม์ไลน์ของคำขอ' })

test('[FR-INT-008/AC1] [FR-NOTI-003/AC2] an escalated step names the DM and the VP wherever the page says whom it waits for, then the VP who decided', async ({ page }, testInfo) => {
  // a scene of its own (a separate process through the services), run twice, and axe on two screens
  test.slow()
  const s = scene<Escalated>('escalated', testInfo.project.name)
  await signIn(page, s.requester.email, null)
  await page.goto(`/requests/${s.request.id}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(s.request.title)

  // "Now": the DM or the VP added at the escalation, each with their position; the step is past its due time
  await expect(nowLine(page)).toContainText(`รอ ${s.first.name} (`)
  await expect(nowLine(page)).toContainText(`หรือ ${s.coAssignee.name} (`)
  await expect(heading(page)).toContainText('เกินกำหนด')
  // The route's step 1 lists both, says why (escalated when overdue, BR-SLA-04) and that whoever decides first decides
  await expect(stepOne(page)).toContainText('ขั้นที่ 1')
  await expect(stepOne(page).getByRole('listitem')).toHaveCount(2)
  await expect(stepOne(page).getByRole('listitem').first()).toContainText(s.first.name)
  await expect(stepOne(page).getByRole('listitem').last()).toContainText(`หรือ ${s.coAssignee.name}`)
  await expect(stepOne(page)).toContainText('ส่งต่อเมื่อเลยกำหนด ผู้อนุมัติระดับถัดไปร่วมพิจารณา')
  await expect(stepOne(page)).toContainText('ผู้ที่ตัดสินก่อนเป็นผู้ตัดสินขั้นนี้')
  await expect(stepOne(page)).toContainText('กำลังรออนุมัติ')
  // The timeline's current step: one entry per approver, each with the business time waited
  const current = timeline(page).locator('[aria-current="step"]')
  await expect(current).toHaveCount(2)
  await expect(current.first()).toContainText(s.first.name)
  await expect(current.last()).toContainText(s.coAssignee.name)
  for (const entry of await current.all()) await expect(entry).toContainText(/ค้างมา|ยังไม่เริ่มนับเวลาทำการ/)
  await checkScreen(page, testInfo, 'request-escalated')

  // The VP decides first: step 1 names the VP who decided, and nobody waits on it any more
  scene('decide', testInfo.project.name, s.coAssignee.taskId)
  await page.reload()
  await expect(nowLine(page)).toContainText('รอฝ่ายจัดซื้อออกใบสั่งซื้อ')
  await expect(stepOne(page)).toContainText(`ขั้นที่ 1 · ${s.coAssignee.name}`)
  await expect(stepOne(page)).toContainText('อนุมัติแล้ว')
  // The VP decided a step the rule gives to the DM: the step says it was escalated when overdue
  await expect(stepOne(page)).toContainText('ส่งต่อเมื่อเลยกำหนด ผู้อนุมัติระดับถัดไปร่วมพิจารณา')
  await expect(routeSteps(page)).not.toContainText(s.first.name)
  await expect(routeSteps(page)).not.toContainText('ผู้ที่ตัดสินก่อนเป็นผู้ตัดสินขั้นนี้')
  await expect(timeline(page).locator('[aria-current="step"]')).toHaveCount(1)
  await expect(timeline(page).locator('[aria-current="step"]')).toContainText('รอฝ่ายจัดซื้อออกใบสั่งซื้อ')
  // The stamp names the VP under the route's own rule, with the escalated flag (BR-SLA-04)
  const stamp = timeline(page).getByRole('listitem').filter({ hasText: s.doaRef })
  await expect(stamp).toContainText(s.coAssignee.name)
  await expect(stamp).toContainText('ขั้นนี้ส่งต่อเมื่อเลยกำหนด')
  await checkScreen(page, testInfo, 'request-escalated-decided')
})
