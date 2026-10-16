import { spawnSync } from 'node:child_process'
import type { BrowserContext, Page, TestInfo } from '@playwright/test'
import { e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'
import { checkScreen, expectFirstLoadWithinBudget, newLineUserId, openAsLineUser, weighFirstLoad } from './liff-support'

// S17-02 · the home page in LINE, /liff/home (FR-LINE-302 · BR-LINE-18 · ADR-167 · §9.4), at 375 px in the mobile
// project (liff-* specs run on the phone only), each screen also checked and photographed at 1440 px (checkScreen: axe,
// no sideways scroll, 44 px targets). The organization is the S6 review scene's (tests/e2e/review-step-scene.ts): pm_p07
// of CON has sent a contract work of 2,642,900.00 baht that the DM of LEG, QSE and FIN review at once (RV-03 to RV-05)
// before the CEO approves. Its members are linked to LINE here (tests/e2e/liff-home-scene.ts) and the numbers the page
// must show are what the web home's services give the same member at the same moment (AC1).

interface Scene {
  readonly orgCode: string
  readonly requestId: string
  readonly number: string
  readonly tasks: { readonly dm_leg: string; readonly dm_qse: string; readonly dm_fin: string }
}
interface Home {
  readonly todo: ReadonlyArray<{ readonly key: string; readonly count: number }>
  readonly approvals: { readonly all: number; readonly overdue: number; readonly info: number; readonly taskIds: readonly string[] }
  readonly following: { readonly total: number; readonly open: number }
}

test.describe.configure({ timeout: 180_000 })

function run<T>(script: string, ...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx ${script} ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`${script} ${args[0]} failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}
const reviewScene = (testInfo: TestInfo) => run<Scene>('tests/e2e/review-step-scene.ts', 'org', testInfo.project.name)
const homeScene = <T,>(...args: string[]) => run<T>('tests/e2e/liff-home-scene.ts', ...args)

/** That member of the scene linked to a new LINE account; the page's browser stands for it */
async function asLinked(context: BrowserContext, s: Scene, code: string): Promise<string> {
  const lineUserId = newLineUserId()
  homeScene('link', s.orgCode, code, lineUserId)
  await openAsLineUser(context, lineUserId)
  return lineUserId
}

const part = (page: Page, name: string) => page.getByRole('region', { name, exact: true })
const todo = (page: Page) => part(page, 'สิ่งที่ต้องทำ')
const approvals = (page: Page) => part(page, 'รอฉันอนุมัติ')
const following = (page: Page) => part(page, 'ที่ฉันติดตาม')

/** /liff/home has its three parts loaded (no part still saying กำลังโหลด) */
async function homeLoaded(page: Page) {
  await expect(page.getByRole('heading', { level: 1, name: 'หน้าแรก' })).toBeVisible()
  for (const p of [todo(page), approvals(page), following(page)]) await expect(p.getByRole('status').filter({ hasText: 'กำลังโหลด' })).toHaveCount(0)
}

test.describe('[FR-LINE-302/AC1] /liff/home shows the web home\'s numbers for the same member', () => {
  test('[FR-LINE-302/AC5] [FR-LINE-302/AC2] [FR-LINE-302/AC4] a reviewer of the three at once: /liff opens the home, รอฉันอนุมัติ has the REVIEW task, which opens its LIFF page', async ({ page, context }, testInfo) => {
    const s = reviewScene(testInfo)
    await asLinked(context, s, 'dm_leg')
    await page.goto('/liff')
    await expect(page).toHaveURL(/\/liff\/home$/)
    await homeLoaded(page)
    const expected = homeScene<Home>('home', s.orgCode, 'dm_leg')
    expect(expected.approvals.taskIds).toContain(s.tasks.dm_leg)
    const waiting = approvals(page)
    await expect(waiting).toContainText(`ทั้งหมด ${expected.approvals.all} งาน · เกินกำหนด ${expected.approvals.overdue} · รอผู้ขอตอบ ${expected.approvals.info}`)
    const row = waiting.getByRole('list', { name: 'งานรอฉันอนุมัติทั้งหมด' }).getByRole('listitem').filter({ hasText: s.number })
    await expect(row).toHaveCount(1)
    await expect(row.getByRole('link')).toHaveAttribute('href', `/liff/tasks/${s.tasks.dm_leg}`)
    await expect(waiting.getByRole('link', { name: `ดูงานรออนุมัติทั้งหมด (${expected.approvals.all} งาน)` })).toHaveAttribute('href', '/liff/tasks')
    // สิ่งที่ต้องทำ: a row for each the web shows, or the line that the tasks are below
    if (expected.todo.length === 0) await expect(todo(page)).toContainText('งานที่รออนุมัติอยู่ในส่วน รอฉันอนุมัติ ข้างล่าง')
    else await expect(todo(page).getByRole('listitem')).toHaveCount(expected.todo.length)
    await expect(following(page)).toContainText(expected.following.total === 0 ? 'ยังไม่มีคำขอที่คุณส่งหรือติดตาม' : `${expected.following.total} คำขอ`)
    await checkScreen(page, testInfo, 'liff-home-reviewer')
    await row.getByRole('link').click()
    await expect(page).toHaveURL(new RegExp(`/liff/tasks/${s.tasks.dm_leg}$`))
  })

  test('[FR-LINE-302/AC2] the requester follows the contract work: its row opens /liff/requests/<id>, ดูคำขอที่ติดตามทั้งหมด opens /liff/track', async ({ page, context }, testInfo) => {
    const s = reviewScene(testInfo)
    await asLinked(context, s, 'pm_p07')
    await page.goto('/liff/home')
    await homeLoaded(page)
    const expected = homeScene<Home>('home', s.orgCode, 'pm_p07')
    const mine = following(page)
    await expect(mine).toContainText(`${expected.following.total} คำขอ · เปิดอยู่ ${expected.following.open}`)
    const row = mine.getByRole('listitem').filter({ hasText: s.number })
    await expect(row.getByRole('link')).toHaveAttribute('href', `/liff/requests/${s.requestId}`)
    await expect(row).toContainText('รออนุมัติ')
    await expect(mine.getByRole('link', { name: 'ดูคำขอที่ติดตามทั้งหมด' })).toHaveAttribute('href', '/liff/track')
    await expect(approvals(page)).toContainText(expected.approvals.all === 0 ? 'ยังไม่มีงานรออนุมัติ' : `ทั้งหมด ${expected.approvals.all} งาน`)
    await checkScreen(page, testInfo, 'liff-home-requester')
  })

  test('[FR-LINE-302/AC4] a member with nothing waiting is told so, with the start of a request', async ({ page, context }, testInfo) => {
    const s = reviewScene(testInfo)
    await asLinked(context, s, 'ceo')
    await page.goto('/liff/home')
    await homeLoaded(page)
    const expected = homeScene<Home>('home', s.orgCode, 'ceo')
    expect(expected).toMatchObject({ todo: [], approvals: { all: 0 }, following: { total: 0 } })
    await expect(todo(page)).toContainText('ไม่มีงานที่ต้องทำตอนนี้')
    await expect(todo(page).getByRole('link', { name: 'เริ่มคำขอใหม่' })).toHaveAttribute('href', '/liff/requests/new')
    await expect(todo(page).getByRole('link', { name: 'ดูคำขอของฉัน' })).toHaveAttribute('href', '/liff/track')
    await expect(approvals(page)).toContainText('ยังไม่มีงานรออนุมัติ')
    await checkScreen(page, testInfo, 'liff-home-empty')
  })
})

test.describe('[FR-LINE-302/AC2] §9.4 the first JavaScript of /liff/home and of S6\'s REVIEW task page stays within 200 KB gzip', () => {
  test('/liff/home of a reviewer', async ({ page, context }, testInfo) => {
    const s = reviewScene(testInfo)
    await asLinked(context, s, 'dm_qse')
    const load = await weighFirstLoad(page, '/liff/home', () => homeLoaded(page))
    expectFirstLoadWithinBudget(testInfo, '/liff/home', load)
  })

  test('/liff/tasks/<id> of a REVIEW task (the page S6 changed)', async ({ page, context }, testInfo) => {
    const s = reviewScene(testInfo)
    await asLinked(context, s, 'dm_fin')
    const load = await weighFirstLoad(page, `/liff/tasks/${s.tasks.dm_fin}`, () => expect(page.getByRole('heading', { level: 1 })).toBeVisible())
    expectFirstLoadWithinBudget(testInfo, '/liff/tasks/<review task>', load)
  })
})
