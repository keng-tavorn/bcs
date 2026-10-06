import { spawnSync } from 'node:child_process'
import AxeBuilder from '@axe-core/playwright'
import { type Page } from '@playwright/test'
import { deriveSeedTotpSecret, totp } from '../../src/lib/totp'
import { e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'

// S4-06 (FR-NOTI-002 AC2, BR-TOK-03): the decision link of a task e-mail. Opening it signed out goes to sign-in and
// back to the link; the page only shows the task until "ยืนยันอนุมัติ" is pressed; the link then says the task no
// longer waits. A link pressed after its task was decided elsewhere says who decided it and when (FR-DOA-004 AC2,
// §9.3), and offers the task in BCS instead of its buttons. Each viewport has its own requester and approver (TOTP
// codes never repeat).

// Departments no demo scene counts on (scenes 1–9 use the budgets of CON and IT)
const SCENES = { desktop: 'proc_officer', mobile: 'auditor' } as const

interface LinkScene {
  readonly number: string
  readonly approver: string
  readonly approverName: string
  readonly taskId: string
  readonly link: string
}

/** unitPrice: of each of the four cartridges, 2,000.00 unless given (a smaller request leaves the department's budget room) */
function scene(requester: string, unitPrice?: string): LinkScene {
  const env = { ...process.env, ...e2eEnv(), SCENE_REQUESTER: requester, ...(unitPrice ? { SCENE_UNIT_PRICE: unitPrice } : {}) }
  const r = spawnSync('pnpm exec tsx tests/e2e/action-link-scene.ts', { shell: true, encoding: 'utf8', env })
  if (r.status !== 0) throw new Error(`action link scene failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as LinkScene
}

async function signInAs(page: Page, code: string) {
  await page.goto('/login')
  await page.getByLabel('อีเมลบริษัท').fill(`${code}@demo.bcs.local`)
  await page.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
  await expect(page).toHaveURL(/\/login\/2fa$/)
  await page.getByLabel('รหัส 6 หลักจากแอป').fill(totp(deriveSeedTotpSecret(process.env.SEED_TOTP_KEY!, code)))
  await page.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('สวัสดี')
}

async function expectNoBlockingAxe(page: Page) {
  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(blocking.map((v) => `${v.id}: ${v.help}`)).toEqual([])
}

test('[FR-NOTI-002/AC2] an e-mail link signs in first, shows the task, and decides only when confirmed', async ({ page }, testInfo) => {
  const { number, approver, link } = scene(SCENES[testInfo.project.name as keyof typeof SCENES] ?? 'proc_officer')

  // Signed out: the link sends you to sign in, then back to itself
  await page.goto(`/a/${link}`)
  await expect(page).toHaveURL(/\/login\?next=%2Fa%2F/)
  await page.getByLabel('อีเมลบริษัท').fill(`${approver}@demo.bcs.local`)
  await page.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
  await expect(page).toHaveURL(/\/login\/2fa\?next=/)
  await page.getByLabel('รหัส 6 หลักจากแอป').fill(totp(deriveSeedTotpSecret(process.env.SEED_TOTP_KEY!, approver)))
  await page.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' }).click()
  await expect(page).toHaveURL(new RegExp(`/a/${link.replace('.', '\\.')}$`))

  // Opening it only shows the task (GET changes nothing): open it again, it still waits
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`พิจารณาคำขอซื้อ ${number}`)
  await page.reload()
  await expect(page.getByRole('button', { name: 'ยืนยันอนุมัติ' })).toBeVisible()
  await expect(page.getByText('8,560.00 บาท')).toBeVisible()
  await expectNoBlockingAxe(page)
  await page.screenshot({ path: testInfo.outputPath('action-link-open.png'), fullPage: true })

  // Not approving asks for a reason first; going back keeps the task waiting
  await page.getByRole('button', { name: 'ไม่อนุมัติ' }).click()
  await page.getByRole('button', { name: 'ยืนยันไม่อนุมัติ' }).click()
  await expect(page.getByText('ใส่เหตุผลอย่างน้อย 3 ตัวอักษร')).toBeVisible()
  await page.getByRole('button', { name: 'กลับ' }).click()

  await page.getByRole('button', { name: 'ยืนยันอนุมัติ' }).click()
  await expect(page.getByText('อนุมัติแล้ว')).toBeVisible()
  await expectNoBlockingAxe(page)
  await page.screenshot({ path: testInfo.outputPath('action-link-done.png'), fullPage: true })

  // The link again: the task no longer waits
  await page.goto(`/a/${link}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('งานนี้ไม่ได้รอคุณแล้ว')
})

test('[FR-DOA-004/AC2] [FR-NOTI-002/AC2] a link pressed after its task was decided on the web says who decided it and when, with the task in place of the buttons', async ({ page, context }, testInfo) => {
  test.slow()
  // 1,000 baht: the first test spends 8,000 of the same department's operating budget
  const made = scene(SCENES[testInfo.project.name as keyof typeof SCENES] ?? 'proc_officer', '250.00')
  await signInAs(page, made.approver)
  await page.goto(`/a/${made.link}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`พิจารณาคำขอซื้อ ${made.number}`)
  await expect(page.getByRole('button', { name: 'ยืนยันอนุมัติ' })).toBeVisible()

  // Meanwhile the approver decides it on the web, in another tab of the same session
  const web = await context.newPage()
  await web.goto(`/tasks/${made.taskId}`)
  await web.getByRole('button', { name: 'อนุมัติ', exact: true }).click()
  await web.getByRole('button', { name: 'ยืนยันอนุมัติ' }).click()
  await expect(web.getByRole('status').filter({ hasText: `อนุมัติแล้วโดย ${made.approverName} เมื่อ` })).toBeVisible()
  await web.close()

  // The link page, open all along: pressing approve decides nothing and says who decided it and when (§14.2 TOKEN_USED)
  await page.getByRole('button', { name: 'ยืนยันอนุมัติ' }).click()
  const answer = page.getByRole('alert').filter({ hasText: `รายการนี้ดำเนินการแล้วโดย ${made.approverName} เมื่อ` })
  await expect(answer).toHaveText(new RegExp(`^รายการนี้ดำเนินการแล้วโดย ${made.approverName} เมื่อ \\d{1,2} \\S+ 25\\d\\d \\d\\d:\\d\\d น\\.$`))
  await expect(page.getByRole('button', { name: 'ยืนยันอนุมัติ' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'ไม่อนุมัติ' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'เปิดงานในระบบ' })).toHaveAttribute('href', `/tasks/${made.taskId}`)
  await expectNoBlockingAxe(page)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
  await page.screenshot({ path: testInfo.outputPath('action-link-decided-elsewhere.png'), fullPage: true })
})

test('[FR-NOTI-002/AC2] a link that is not a real link opens nothing', async ({ page }) => {
  await page.goto('/a/00000000-0000-7000-8000-000000000000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('ใช้ลิงก์นี้ไม่ได้')
})
