import { spawnSync } from 'node:child_process'
import AxeBuilder from '@axe-core/playwright'
import { type Page } from '@playwright/test'
import { deriveSeedTotpSecret, totp } from '../../src/lib/totp'
import { e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'

// S2-14 (FR-NOTI-001 AC1): the bell shows an approver's new tasks with a link to each, opening one marks it read, and
// "mark all as read" clears the count. tests/e2e/seed-activity.ts gave vp_ops and vp_sup two tasks each.

async function expectNoBlockingAxe(page: Page) {
  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(blocking.map((v) => `${v.id}: ${v.help}`)).toEqual([])
}

async function signIn(page: Page, code: string) {
  await page.goto('/login')
  await page.getByLabel('อีเมลบริษัท').fill(`${code}@demo.bcs.local`)
  await page.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
  await expect(page).toHaveURL(/\/login\/2fa$/)
  await page.getByLabel('รหัส 6 หลักจากแอป').fill(totp(deriveSeedTotpSecret(process.env.SEED_TOTP_KEY!, code)))
  await page.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
}

/** The bell that shows at this width (the phone header and the wide-screen bar each have one) */
const bell = (page: Page) => page.locator('details:has(> summary[aria-label^="แจ้งเตือน"])').filter({ visible: true })

test('[FR-NOTI-001/AC1] the bell lists the approver’s new tasks, opens one and marks the rest read', async ({ page }, testInfo) => {
  const code = testInfo.project.name === 'mobile' ? 'vp_sup' : 'vp_ops'
  await signIn(page, code)

  // seed-activity.ts gave this approver two tasks; other specs of the same run may have added more
  const summary = bell(page).locator('summary')
  await expect(summary).toHaveAttribute('aria-label', /^แจ้งเตือน · ยังไม่อ่าน \d+ รายการ$/)
  const unread = Number(/ยังไม่อ่าน (\d+) รายการ/.exec((await summary.getAttribute('aria-label')) ?? '')![1])
  expect(unread).toBeGreaterThanOrEqual(2)
  await summary.click()
  const panel = bell(page)
  await expect(panel.getByRole('heading', { name: 'การแจ้งเตือน' })).toBeVisible()
  const items = panel.getByRole('button', { name: /มีงานรออนุมัติ: PR-2569-\d{5}/ })
  expect(await items.count()).toBeGreaterThanOrEqual(2)
  await expect(items.first()).toContainText('ใหม่')
  await expectNoBlockingAxe(page)
  await page.screenshot({ path: testInfo.outputPath('bell-open.png'), fullPage: true })

  // Opening one goes to its task and marks it read
  await items.first().click()
  await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/)
  await page.goto('/')
  await expect(bell(page).locator('summary')).toHaveAttribute('aria-label', unread === 1 ? 'แจ้งเตือน' : `แจ้งเตือน · ยังไม่อ่าน ${unread - 1} รายการ`)

  // Mark all as read clears the count
  await bell(page).locator('summary').click()
  await bell(page).getByRole('button', { name: 'ทำเครื่องหมายว่าอ่านทั้งหมดแล้ว' }).click()
  await expect(bell(page).locator('summary')).toHaveAttribute('aria-label', 'แจ้งเตือน')
  await bell(page).locator('summary').click()
  await expect(bell(page).getByText('ใหม่', { exact: true })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('bell-read.png'), fullPage: true })
})

/** A plain member nobody else has touched (tests/e2e/fresh-member-scene.ts): the demo users carry what other specs did */
function freshMember(project: string): string {
  const code = `e2e-bell-${project}-${Date.now().toString(36)}`
  const r = spawnSync('pnpm exec tsx tests/e2e/fresh-member-scene.ts', { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv(), SCENE_MEMBER_CODE: code } })
  if (r.status !== 0) throw new Error(`fresh member scene failed:\n${r.stdout}\n${r.stderr}`)
  return (JSON.parse(r.stdout.trim().split('\n').at(-1)!) as { email: string }).email
}

test('[FR-NOTI-001/AC1] a member with no notifications sees what will show there', async ({ page }, testInfo) => {
  const email = freshMember(testInfo.project.name)
  await page.goto('/login')
  await page.getByLabel('อีเมลบริษัท').fill(email)
  await page.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await bell(page).locator('summary').click()
  await expect(bell(page).getByText('ยังไม่มีการแจ้งเตือน')).toBeVisible()
  await expect(bell(page).getByText('งานที่รอคุณอนุมัติและความคืบหน้าของคำขอของคุณจะแสดงที่นี่')).toBeVisible()
  await expectNoBlockingAxe(page)
  await page.screenshot({ path: testInfo.outputPath('bell-empty.png'), fullPage: true })
})
