import { spawnSync } from 'node:child_process'
import { type Page } from '@playwright/test'
import { localeCookieName } from '../../src/i18n/locales'
import { E2E_BASE_URL, e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'
import { checkScreen } from './insight-support'
import { poTimeline } from './procurement-support'
import { rowWith, signIn } from './tasks-support'

// NEW-46 on a purchase order (FR-INT-008 AC1, FR-NOTI-003 AC2, BR-SLA-04): a PO's approval step past its escalation
// time waits for the COO it went to (PO-01) and for the CEO, the approver of the band above (PO-02), added as
// co-assignee — whoever decides first decides. The list of POs and the PO's page name both wherever they say whom the PO
// waits for, the page's timeline has a current entry for each, and once the CEO decides, the decision's stamp carries the
// route's own DOA rule with the escalated flag (BR-SLA-04 "DOA ref เดิมพร้อมธง escalated"). The COO's task closed with
// that decision: its page says why and that the CEO approved and when, in the reader's language (FR-DOA-004 AC2), and
// its timeline names the CEO.
// tests/e2e/po-coassign-scene.ts makes the PO through the services with the business clock set back, and decides it as
// the CEO; each project makes its own request and PO. Axe, no sideways scroll and a screenshot at the project's width
// (1440 px, 375 px) on every screen (§9.9 steps 4–5).

interface Escalated {
  readonly run: string
  readonly request: { readonly id: string; readonly number: string }
  readonly po: { readonly id: string; readonly number: string }
  readonly first: { readonly taskId: string; readonly name: string }
  readonly coAssignee: { readonly taskId: string; readonly name: string }
  readonly doaRef: string
}

/** Runs tests/e2e/po-coassign-scene.ts against the e2e database and returns the JSON of its last line */
function scene<T>(...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/po-coassign-scene.ts ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`PO co-assignee scene ${args[0]} failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1)!) as T
}

/** Whom the PO waits for now (the overview's first block), and its route as step cards (FR-INT-012 AC3, AC6) */
const nowBlock = (page: Page) => page.locator('[data-doc-now]')
const routeSteps = (page: Page) => page.getByRole('list', { name: 'ขั้นอนุมัติ' })
const current = (page: Page) => routeSteps(page).locator('[aria-current="step"]')

test('[FR-INT-008/AC1] [FR-NOTI-003/AC2] an escalated PO step names the COO and the CEO wherever the PO says whom it waits for; the CEO’s approval is stamped PO-01 with the flag', async ({ page, browser }, testInfo) => {
  // a scene of its own (a separate process through the services), run twice, three people and axe on five screens
  test.slow()
  const s = scene<Escalated>('escalated', testInfo.project.name)
  await signIn(page, 'proc_officer', true)

  // The list of POs waiting for approval: "รอ COO (…) หรือ CEO (…) อนุมัติ"
  await page.goto('/procurement/pos?status=PENDING_APPROVAL')
  const row = rowWith(page.getByRole('list', { name: 'ใบสั่งซื้อ' }), s.po.number)
  await expect(row).toContainText(`รอ ${s.first.name} (`)
  await expect(row).toContainText(`หรือ ${s.coAssignee.name} (`)
  await checkScreen(page, testInfo, 'po-list-escalated')

  // The PO's page: the same words in its overview, past the COO's due time, and one step card naming both approvers
  await page.goto(`/procurement/pos/${s.po.id}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('บริษัท บริการทำความสะอาดทดสอบ จำกัด')
  await expect(nowBlock(page)).toContainText(`รอ ${s.first.name} (`)
  await expect(nowBlock(page)).toContainText(`หรือ ${s.coAssignee.name} (`)
  await expect(nowBlock(page)).toContainText('เกินกำหนด')
  // Step 1's card names both approvers who may decide it now
  await expect(current(page)).toHaveCount(1)
  await expect(current(page)).toContainText(s.first.name)
  await expect(current(page)).toContainText(`หรือ ${s.coAssignee.name}`)
  await checkScreen(page, testInfo, 'po-escalated')

  // The CEO decides first: nobody waits for an approval any more, and the stamp names the CEO under the route's own
  // rule with the escalated flag
  scene('decide', testInfo.project.name, s.coAssignee.taskId, s.request.id)
  await page.reload()
  await expect(nowBlock(page)).toContainText('รอจัดซื้อส่ง PO ให้ผู้ขาย')
  await expect(nowBlock(page)).not.toContainText(s.first.name)
  const stamp = routeSteps(page).getByRole('listitem').filter({ hasText: s.doaRef })
  await expect(stamp).toHaveCount(1)
  await expect(stamp).toContainText(s.coAssignee.name)
  await expect(stamp).toContainText('ขั้นนี้ส่งต่อเมื่อเลยกำหนด')
  await expect(current(page)).toHaveCount(0)
  await checkScreen(page, testInfo, 'po-escalated-decided')

  // The COO's task was cancelled with the CEO's decision: its page says why, who decided the step and when, and its
  // timeline names the CEO
  const context = await browser.newContext()
  const coo = await context.newPage()
  await signIn(coo, 'coo', true)
  await coo.goto(`/tasks/${s.first.taskId}`)
  const closed = coo.getByRole('status').filter({ hasText: 'งานนี้ปิดแล้ว เพราะผู้อนุมัติอีกคนของขั้นนี้ตัดสินก่อน' })
  await expect(closed).toBeVisible()
  await expect(closed).toContainText(`อนุมัติแล้วโดย ${s.coAssignee.name} เมื่อ`)
  await expect(coo.getByRole('button', { name: 'อนุมัติ', exact: true })).toHaveCount(0)
  const cooStamp = poTimeline(coo).getByRole('listitem').filter({ hasText: s.doaRef })
  await expect(cooStamp).toContainText(s.coAssignee.name)
  await expect(cooStamp).toContainText('ขั้นนี้ส่งต่อเมื่อเลยกำหนด')
  await checkScreen(coo, testInfo, 'po-task-closed-by-co-assignee')
  // The same page in English (the language switch keeps its choice in this cookie)
  await context.addCookies([{ name: localeCookieName, value: 'en', url: E2E_BASE_URL }])
  await coo.reload()
  const closedEn = coo.getByRole('status').filter({ hasText: 'This task is closed because another approver of this step decided first' })
  await expect(closedEn).toBeVisible()
  await expect(closedEn).toContainText(`Approved by ${s.coAssignee.name} `)
  const englishStamp = coo.getByRole('list', { name: 'Timeline of the purchase order' }).getByRole('listitem').filter({ hasText: 'This step was escalated when overdue' })
  await expect(englishStamp).toContainText(s.coAssignee.name)
  await checkScreen(coo, testInfo, 'po-task-closed-by-co-assignee-en')
  await context.close()
})
