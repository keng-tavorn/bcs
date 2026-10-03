import { spawnSync } from 'node:child_process'
import AxeBuilder from '@axe-core/playwright'
import { type Page } from '@playwright/test'
import { deriveSeedTotpSecret, totp } from '../../src/lib/totp'
import { e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'

// S4-06 (FR-NOTI-002 AC2, BR-TOK-03): the decision link of a task e-mail. Opening it signed out goes to sign-in and
// back to the link; the page only shows the task until "ยืนยันอนุมัติ" is pressed; the link then says the task no
// longer waits. Each viewport has its own requester and approver (TOTP codes never repeat).

// Departments no demo scene counts on (scenes 1–9 use the budgets of CON and IT)
const SCENES = { desktop: 'proc_officer', mobile: 'auditor' } as const

function scene(requester: string): { number: string; approver: string; link: string } {
  const r = spawnSync('pnpm exec tsx tests/e2e/action-link-scene.ts', { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv(), SCENE_REQUESTER: requester } })
  if (r.status !== 0) throw new Error(`action link scene failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as { number: string; approver: string; link: string }
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

test('[FR-NOTI-002/AC2] a link that is not a real link opens nothing', async ({ page }) => {
  await page.goto('/a/00000000-0000-7000-8000-000000000000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('ใช้ลิงก์นี้ไม่ได้')
})
