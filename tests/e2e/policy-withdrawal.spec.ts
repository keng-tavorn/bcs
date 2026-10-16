import AxeBuilder from '@axe-core/playwright'
import { spawnSync } from 'node:child_process'
import { type Page, type TestInfo } from '@playwright/test'
import { deriveSeedTotpSecret, totp } from '../../src/lib/totp'
import { E2E_BASE_URL, E2E_PIN, e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'
import { PIN_LABEL } from './tasks-support'

// S6-07 · the backtest and the withdrawal screens (FR-DOA-103 AC1 AC3 · BR-WF-13 · FR-DOA-104 AC1 · FR-WF-103 ·
// BR-DOA-14): on an organization of its own (admin-workflows-scene.ts, then policy-withdrawal-scene.ts) the second
// admin opens a workflow draft that adds a reviewer above 10,000.00 baht and runs its 90-day backtest — two requests
// were sent, the cutter of 26,750.00 moves to the DM of LEG (one task more for her), the gloves do not; then opens
// version 2, approved for a date still ahead, and asks to withdraw it with a reason (refused without one). The CEO —
// the approver of DOA_CHANGE — reads on the task that it is a withdrawal, why, and what each decision does, runs the
// backtest there and on the version's page, and approves with the PIN; the version is WITHDRAWN. Screenshots at 375 px
// and 1440 px go to the test output (§9.9 step 4); axe runs on every state.

interface Scene {
  readonly orgCode: string
  readonly admin: { readonly email: string; readonly code: string }
  readonly ceo: { readonly email: string; readonly code: string }
  readonly workflowCode: string
  readonly names: Readonly<Record<string, string>>
}
interface Extras {
  readonly v2: string
  readonly v3: string
  readonly aheadAt: string
  readonly requests: readonly string[]
}

function run<T>(script: string, ...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/${script} ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`${script} failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}

async function expectNoBlockingAxe(page: Page) {
  // Next streams the <title> after the first HTML: let it arrive before axe reads the page
  await page.waitForFunction(() => document.title !== '', undefined, { timeout: 5_000 }).catch(() => undefined)
  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(blocking.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)).toEqual([])
}

async function expectNoSideways(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
}

/** Every check of §9.9 steps 4–5 on the page as it is now */
async function review(page: Page, testInfo: TestInfo, name: string) {
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })
}

async function signIn(page: Page, s: { email: string; code: string }) {
  await page.goto('/login')
  await page.getByLabel('อีเมลบริษัท').fill(s.email)
  await page.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
  await expect(page).toHaveURL(/\/login\/2fa$/)
  await page.getByLabel('รหัส 6 หลักจากแอป').fill(totp(deriveSeedTotpSecret(process.env.SEED_TOTP_KEY!, s.code)))
  await page.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('สวัสดี')
}

test('[FR-DOA-103/AC1] [FR-DOA-103/AC3] [BR-WF-13] [FR-DOA-104/AC1] [FR-WF-103] the admin backtests a workflow draft and asks to withdraw a version still ahead; the CEO reads the withdrawal and the backtest and approves with the PIN; the version is withdrawn', async ({
  page,
  browser,
  clientIp,
}, testInfo) => {
  test.setTimeout(300_000)
  const s = run<Scene>('admin-workflows-scene.ts', 'org', testInfo.project.name)
  const x = run<Extras>('policy-withdrawal-scene.ts', 'extras', s.orgCode)
  const v2 = `${s.workflowCode} ฉบับ 2`
  const v3 = `${s.workflowCode} ฉบับ 3`
  await signIn(page, s.admin)

  // The draft's backtest: two requests in 90 days; the cutter goes to the DM of LEG under the draft, the gloves do not
  await page.goto(`/admin/workflows/${x.v3}`)
  await expect(page.getByRole('heading', { level: 1, name: v3 })).toBeVisible()
  await page.getByRole('tab', { name: 'ย้อนทดสอบ 90 วัน' }).click()
  await expect(page.getByText(`ลองใช้ ${v3} กับเอกสารทุกฉบับที่ส่งใน 90 วันที่ผ่านมา`)).toBeVisible()
  await review(page, testInfo, 'backtest-before')
  await page.getByRole('button', { name: 'ย้อนทดสอบ 90 วัน', exact: true }).click()
  await expect(page.getByText('เอกสาร 2 ฉบับ · เปลี่ยนเส้นทาง 1 ฉบับ')).toBeVisible()
  const load = page.getByRole('region', { name: 'ภาระงานต่อคนถ้าใช้ฉบับนี้' })
  await expect(load.getByRole('listitem').filter({ hasText: s.names.dm_leg! })).toContainText('+1 งาน')
  const rows = page.getByRole('list', { name: 'เอกสารที่เปลี่ยนเส้นทาง' })
  await expect(rows.getByRole('listitem')).toHaveCount(1)
  await expect(rows.getByRole('listitem')).toContainText('เครื่องตัดคอนกรีต')
  await expect(rows.getByRole('listitem')).toContainText(`ผู้ตรวจ: ${s.names.dm_leg}`)
  await expect(rows.getByRole('listitem')).toContainText('ไม่มีผู้ตรวจ')
  await expect(rows).not.toContainText('ถุงมือผ้า')
  await review(page, testInfo, 'backtest-draft')

  // Version 2, approved for a date still ahead: the withdrawal asks for a reason, then waits for the CEO
  await page.goto(`/admin/workflows/${x.v2}`)
  await expect(page.getByRole('heading', { level: 1, name: v2 })).toBeVisible()
  await expect(page.getByText('อนุมัติแล้ว รอมีผล').first()).toBeVisible()
  await page.getByRole('button', { name: 'ขอถอนฉบับนี้' }).click()
  const dialog = page.getByRole('alertdialog', { name: `ขอถอน ${v2}` })
  await dialog.getByRole('button', { name: 'ส่งขอถอนฉบับนี้' }).click()
  await expect(dialog.getByText('กรอกเหตุผลอย่างน้อย 3 ตัวอักษร')).toBeVisible()
  await dialog.getByLabel('เหตุผลที่ขอถอน').fill('โครงสร้างใหม่เลื่อนออกไปอีกหนึ่งไตรมาส')
  await review(page, testInfo, 'withdrawal-dialog')
  await dialog.getByRole('button', { name: 'ส่งขอถอนฉบับนี้' }).click()
  await expect(dialog).toHaveCount(0)
  const pending = page.getByRole('status').filter({ hasText: 'ส่งขอถอนฉบับนี้แล้ว รอผู้อนุมัติตัดสิน' })
  await expect(pending).toContainText('เหตุผล: โครงสร้างใหม่เลื่อนออกไปอีกหนึ่งไตรมาส')
  await expect(pending).toContainText(`รอ ${s.names.ceo} ตัดสิน`)
  await expect(page.getByRole('button', { name: 'ขอถอนฉบับนี้' })).toHaveCount(0)
  await review(page, testInfo, 'withdrawal-pending')

  // The CEO decides on the web, in a browser of their own, with the PIN (BR-DOA-18: never who asked)
  const { taskId, versionId } = run<{ taskId: string; versionId: string }>('admin-workflows-scene.ts', 'task', s.orgCode)
  expect(versionId).toBe(x.v2)
  const ceoContext = await browser.newContext({ ...testInfo.project.use, baseURL: E2E_BASE_URL, extraHTTPHeaders: { 'x-forwarded-for': clientIp } })
  const ceo = await ceoContext.newPage()
  await signIn(ceo, s.ceo)

  // The approver may run the backtest on the version's page too (BR-DOA-14), and may not ask a withdrawal there
  await ceo.goto(`/admin/workflows/${x.v2}`)
  await expect(ceo.getByText('ส่งขอถอนฉบับนี้แล้ว รอผู้อนุมัติตัดสิน')).toBeVisible()
  await ceo.getByRole('tab', { name: 'ย้อนทดสอบ 90 วัน' }).click()
  await ceo.getByRole('button', { name: 'ย้อนทดสอบ 90 วัน', exact: true }).click()
  await expect(ceo.getByText('เอกสาร 2 ฉบับ · ไม่มีฉบับใดเปลี่ยนเส้นทาง')).toBeVisible()

  await ceo.goto(`/tasks/${taskId}`)
  await expect(ceo.getByRole('heading', { level: 1 })).toContainText(`ขอถอนผู้ตรวจคู่ขนาน ${v2}`)
  const notice = ceo.getByRole('status').filter({ hasText: 'คำขอถอนฉบับนี้' })
  await expect(notice).toContainText(`${s.names.admin2} ขอถอน ${v2} ซึ่งอนุมัติแล้วแต่ยังไม่มีผล`)
  await expect(notice).toContainText('เหตุผลที่ขอถอน: โครงสร้างใหม่เลื่อนออกไปอีกหนึ่งไตรมาส')
  await expect(notice).toContainText('อนุมัติ = ถอนฉบับนี้')
  const backtest = ceo.getByRole('region', { name: 'ย้อนทดสอบ 90 วัน' })
  await expect(backtest).toContainText('ถ้าถอนฉบับนี้ ความเปลี่ยนแปลงเหล่านี้จะไม่เกิดขึ้น')
  await backtest.getByRole('button', { name: 'ย้อนทดสอบ 90 วัน', exact: true }).click()
  await expect(backtest.getByText('เอกสาร 2 ฉบับ · ไม่มีฉบับใดเปลี่ยนเส้นทาง')).toBeVisible()
  await expect(backtest.getByText('ไม่มีเอกสารใดเปลี่ยนเส้นทาง')).toBeVisible()
  await review(ceo, testInfo, 'withdrawal-task')
  const approve = ceo.getByRole('button', { name: 'อนุมัติการเปลี่ยนนี้', exact: true })
  const approveForm = ceo.locator('form').filter({ has: approve })
  await approveForm.getByLabel(PIN_LABEL).fill(E2E_PIN)
  await approve.click()
  await expect(ceo.getByRole('status').filter({ hasText: 'อนุมัติการเปลี่ยนนี้แล้ว' })).toBeVisible()
  await ceoContext.close()

  // Withdrawn: version 1 runs on; the page says when and who asked
  expect(run<{ versions: Array<{ versionNo: number; status: string }> }>('admin-workflows-scene.ts', 'status', s.orgCode).versions).toEqual([
    expect.objectContaining({ versionNo: 1, status: 'PUBLISHED' }),
    expect.objectContaining({ versionNo: 2, status: 'WITHDRAWN' }),
    expect.objectContaining({ versionNo: 3, status: 'DRAFT' }),
  ])
  await page.goto(`/admin/workflows/${x.v2}`)
  await expect(page.getByText('ถอนแล้ว').first()).toBeVisible()
  const done = page.getByRole('status').filter({ hasText: 'ถอนฉบับนี้แล้วเมื่อ' })
  await expect(done).toContainText(`ขอถอนโดย ${s.names.admin2}`)
  await expect(page.getByRole('button', { name: 'ขอถอนฉบับนี้' })).toHaveCount(0)
  await review(page, testInfo, 'withdrawal-done')
})
