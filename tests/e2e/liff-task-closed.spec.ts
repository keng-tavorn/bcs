import { spawnSync } from 'node:child_process'
import type { Page } from '@playwright/test'
import { localeCookieName } from '../../src/i18n/locales'
import { E2E_BASE_URL, e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'
import { checkScreen, newLineUserId, openAsLineUser } from './liff-support'

// FR-DOA-004 AC2 on the LIFF decision page (§9.4, §9.3) with BR-SLA-04 (NEW-46): a step past its escalation time waits
// for the DM it went to and for the VP of the band above, added as co-assignee — whoever decides first decides. Once the
// VP decides, the DM's task is closed, and its LIFF page says why, who decided the step and when, in the reader's
// language, with nothing left to decide — the words of the web decision page (src/app/(workspace)/tasks/_parts/
// closed-task.tsx). The route's step names the VP who decided it, its stamp carries the escalated flag under the
// route's own rule, and "Why this route" still names the DM the rule gave the step, in English as the Thai record does
// (BR-DOA-10). The people are those of a twin of the demo organization made for this test (tests/e2e/liff-tasks-scene.ts
// `twin`, linked to LINE through a link code), so nothing here touches a record another spec reads;
// tests/e2e/liff-task-closed-scene.ts makes the escalated request through the services with the business clock set back,
// and decides it as the VP. LIFF_MOCK stands in for the LINE app (liff-* specs run on the phone only). Axe, no sideways
// scroll, 44 px targets and screenshots at 375 px and 1440 px on each screen (checkScreen, §9.9 steps 4–5).

interface Twin {
  readonly orgCode: string
  /** The DM of construction (dm_con) */
  readonly dm: string
  /** The VP of the operations division (vp_ops) */
  readonly approver: string
}
interface Named {
  readonly taskId: string
  readonly name: string
  readonly nameEn: string | null
}
interface Escalated {
  readonly request: { readonly id: string; readonly number: string; readonly title: string }
  readonly first: Named
  readonly coAssignee: Named
  readonly doaRef: string
}

/** Runs a scene of tests/e2e against the e2e database and returns the JSON of its last line */
function scene<T>(file: string, ...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/${file} ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`${file} ${args[0]} failed:\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}

/** The name a page in English shows: the English one when the member has it */
const inEnglish = (who: Named) => who.nameEn ?? who.name
const routeRegion = (page: Page, name: string) => page.getByRole('region', { name, exact: true })
/** The route's first step (each step a list item; an escalated step that waits lists its approvers inside) */
const stepOne = (page: Page, name: string) => routeRegion(page, name).locator('ol').locator(':scope > li').first()

test('[FR-DOA-004/AC2] [FR-NOTI-003/AC2] [FR-DOA-003/AC2] the DM’s LIFF page of a step the VP decided first says why it closed, who decided and when, in Thai and English; "Why this route" still names the DM', async ({ page, context }, testInfo) => {
  // A twin of the demo organization, three scene runs, and axe on two screens at two widths
  test.setTimeout(300_000)
  // The twin's LINE users, in the order its `twin` command links them: vp_ops, ceo, coo, dm_con, vp_sup, asst_con
  const lines = Array.from({ length: 6 }, () => newLineUserId())
  const twin = scene<Twin>('liff-tasks-scene.ts', 'twin', ...lines)
  const lineDm = lines[3]!
  const s = scene<Escalated>('liff-task-closed-scene.ts', 'escalated', twin.orgCode)
  expect(s.first.name).toBe(twin.dm)
  expect(s.coAssignee.name).toBe(twin.approver)
  // The VP decides first, on the web: the DM's task is cancelled with that decision
  scene('liff-task-closed-scene.ts', 'decide', twin.orgCode, s.coAssignee.taskId)

  // The DM opens their task from LINE (the card they were sent): it says why it closed, then who decided and when
  await openAsLineUser(context, lineDm)
  await page.goto(`/liff/tasks/${s.first.taskId}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(s.request.title)
  const closed = page.getByRole('status').filter({ hasText: 'งานนี้ปิดแล้ว เพราะผู้อนุมัติอีกคนของขั้นนี้ตัดสินก่อน' })
  await expect(closed).toBeVisible()
  await expect(closed).toContainText(`อนุมัติแล้วโดย ${s.coAssignee.name} เมื่อ`)
  // Nothing is left to decide on it
  await expect(page.getByRole('region', { name: 'ตัดสินงานนี้' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'อนุมัติ', exact: true })).toHaveCount(0)
  // The route's step names the VP who decided it; the decision's stamp names the VP under the route's own rule, with
  // the escalated flag (BR-SLA-04)
  await expect(stepOne(page, 'เส้นทางอนุมัติ')).toContainText(`ขั้นที่ 1 · ${s.coAssignee.name}`)
  await expect(stepOne(page, 'เส้นทางอนุมัติ')).toContainText('ส่งต่อเมื่อเลยกำหนด ผู้อนุมัติระดับถัดไปร่วมพิจารณา')
  const stamp = page.getByRole('list', { name: 'ไทม์ไลน์ของคำขอ' }).getByRole('listitem').filter({ hasText: s.doaRef })
  await expect(stamp).toContainText(s.coAssignee.name)
  await expect(stamp).toContainText('ขั้นนี้ส่งต่อเมื่อเลยกำหนด')
  await checkScreen(page, testInfo, 'liff-task-closed-by-co-assignee')

  // The same page in English (the language switch keeps its choice in this cookie)
  await context.addCookies([{ name: localeCookieName, value: 'en', url: E2E_BASE_URL }])
  await page.reload()
  const closedEn = page.getByRole('status').filter({ hasText: 'This task is closed because another approver of this step decided first' })
  await expect(closedEn).toBeVisible()
  await expect(closedEn).toContainText(`Approved by ${inEnglish(s.coAssignee)} `)
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0)
  // "Why this route" names the DM the rule gave the step, as the Thai record does — not the VP who decided it
  const why = routeRegion(page, 'Approval route').locator('p', { hasText: 'goes to' })
  await expect(why).toContainText(`, goes to ${inEnglish(s.first)} (`)
  await expect(why).not.toContainText(inEnglish(s.coAssignee))
  await expect(stepOne(page, 'Approval route')).toContainText(inEnglish(s.coAssignee))
  await checkScreen(page, testInfo, 'liff-task-closed-by-co-assignee-en')
})
