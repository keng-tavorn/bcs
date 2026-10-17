import AxeBuilder from '@axe-core/playwright'
import { spawnSync } from 'node:child_process'
import { type Page, type TestInfo } from '@playwright/test'
import { deriveSeedTotpSecret, totp } from '../../src/lib/totp'
import { e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'
import { settled } from './settled'

// S6-06 · the reviewers' step on screen (FR-WF-101, ADR-103): pm_p07's contract work of 2,642,900.00 VAT included waits
// for the DM of LEG, QSE and FIN at once — the request page shows the step as one group of three stamps, "ผ่านแล้ว 0 ใน
// 3 ฝ่าย" — and the CEO's step waits behind it. The DM of LEG opens the task: "ผ่าน", no rejection and no PIN; the other
// two pass; the request page then shows 3 of 3 passed and the CEO's step running, and the CEO finds the task in the
// inbox. Each run builds an organization of its own (tests/e2e/review-step-scene.ts). Screenshots at 375 px and 1440
// px go to the test output (§9.9 step 4); axe runs on every state.

interface Scene {
  readonly orgCode: string
  readonly requestId: string
  readonly number: string
  readonly signIn: Readonly<Record<'pm_p07' | 'dm_leg' | 'dm_qse' | 'dm_fin' | 'ceo', { readonly email: string; readonly code: string }>>
  readonly names: Readonly<Record<string, string>>
  readonly tasks: Readonly<Record<'dm_leg' | 'dm_qse' | 'dm_fin', string>>
}

function scene<T>(...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/review-step-scene.ts ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`review step scene failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}

async function review(page: Page, testInfo: TestInfo, name: string) {
  await page.waitForFunction(() => document.title !== '', undefined, { timeout: 5_000 }).catch(() => undefined)
  await settled(page)
  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(blocking.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)).toEqual([])
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })
}

async function signIn(page: Page, s: { email: string; code: string }) {
  await page.context().clearCookies()
  await page.goto('/login')
  await page.getByLabel('อีเมลบริษัท').fill(s.email)
  await page.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
  await expect(page).toHaveURL(/\/login\/2fa$/)
  await page.getByLabel('รหัส 6 หลักจากแอป').fill(totp(deriveSeedTotpSecret(process.env.SEED_TOTP_KEY!, s.code)))
  await page.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('สวัสดี')
}

test('[FR-WF-101/AC1] [FR-WF-101/AC2] [FR-WF-101/AC5] pm_p07\'s contract work waits for LEG, QSE and FIN at once, each passes on its own; only then does the CEO get it', async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  const s = scene<Scene>('org', testInfo.project.name)
  // The step cards of the document page (§9.10 "การ์ดขั้น"); a slot's stamp is the innermost item naming its holder
  const route = () => page.getByRole('list', { name: 'ขั้นอนุมัติ' })
  const stampOf = (name: string) => route().getByRole('listitem').filter({ hasText: name }).last()

  // The requester sees the reviewers' step as one group of three, then the CEO's step waiting
  await signIn(page, s.signIn.pm_p07)
  await page.goto(`/requests/${s.requestId}`)
  await expect(route()).toContainText('ขั้นที่ 1 · ผู้ตรวจ')
  await expect(route()).toContainText('ผ่านแล้ว 0 ใน 3 ฝ่าย')
  for (const [code, rule] of [
    ['dm_leg', 'RV-03'],
    ['dm_qse', 'RV-04'],
    ['dm_fin', 'RV-05'],
  ] as const) {
    const stamp = stampOf(s.names[code]!)
    await expect(stamp).toContainText(`ตามข้อ ${rule}`)
    await expect(stamp).toContainText('รอตัดสิน')
  }
  await expect(route()).toContainText('ขั้นที่ 2')
  await expect(page.getByText(`รอ ${s.names.dm_leg}`)).toContainText('ตรวจ ก่อนถึงผู้อนุมัติ')
  await review(page, testInfo, 'review-step-request-waiting')

  // The DM of LEG: the inbox says it is a review; the task passes without a PIN and cannot be rejected
  await signIn(page, s.signIn.dm_leg)
  await page.goto('/tasks')
  await expect(page.getByRole('listitem').filter({ hasText: s.number })).toContainText('งานตรวจก่อนอนุมัติ')
  await page.goto(`/tasks/${s.tasks.dm_leg}`)
  await expect(page.getByText('ไม่อนุมัติ', { exact: true })).toHaveCount(0)
  await expect(page.getByText('PIN 6 หลัก')).toHaveCount(0)
  await review(page, testInfo, 'review-step-decision')
  await page.getByRole('button', { name: 'ผ่าน', exact: true }).first().click()
  await page.getByRole('button', { name: 'ยืนยันผ่าน' }).click()
  await expect(page.getByText('ผ่านแล้ว', { exact: true }).first()).toBeVisible()

  // The other two pass; the requester sees 3 of 3 and the CEO's step running
  scene('pass', s.orgCode, 'dm_qse')
  scene('pass', s.orgCode, 'dm_fin')
  await signIn(page, s.signIn.pm_p07)
  await page.goto(`/requests/${s.requestId}`)
  await expect(route()).toContainText('ผ่านแล้ว 3 ใน 3 ฝ่าย')
  await expect(stampOf(s.names.dm_leg!)).toContainText('ผ่าน')
  await expect(stampOf(s.names.dm_leg!)).toContainText(s.names.dm_leg!)
  await expect(route()).toContainText(s.names.ceo!)
  await review(page, testInfo, 'review-step-request-passed')

  // The CEO has it now, as an approval (not a review)
  await signIn(page, s.signIn.ceo)
  await page.goto('/tasks')
  const row = page.getByRole('listitem').filter({ hasText: s.number })
  await expect(row).toBeVisible()
  await expect(row).not.toContainText('งานตรวจก่อนอนุมัติ')
})
