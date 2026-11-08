import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import type { Page, TestInfo } from '@playwright/test'
import { deriveSeedTotpSecret, totp } from '@/lib/totp'
import { e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'
import { expectNoBlockingAxe } from './liff-support'

// S7-16 (BR-SUP ข้อ 13 · §11.4 G-7 · scene 7 of Demo_Script_P2 on a test organization): PROCUREMENT opens
// /reports/suppliers for October and sees the lower median 3.6 business days of the three approvals (2.1 self · 8.8 on
// behalf · 3.6 self), the applications it counts, the one waiting past its escalation and the expired documents by
// category; the page is checked with axe at 1440 and 375 px, without a sideways scroll on the phone.

function scene<T>(...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/supplier-report-scene.ts ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`supplier report scene ${args[0]} failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1)!) as T
}

async function signIn(page: Page, local: string) {
  await page.goto('/login')
  await page.getByLabel('อีเมลบริษัท').fill(`${local}@p2.bcs.local`)
  await page.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
  await expect(page).toHaveURL(/\/login\/2fa$/)
  await page.getByLabel('รหัส 6 หลักจากแอป').fill(totp(deriveSeedTotpSecret(process.env.SEED_TOTP_KEY!, local)))
  await page.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('สวัสดี')
}

/** axe and a picture at 1440 px, then at 375 px (§9.9 step 4), no sideways scroll on the phone */
async function shot(page: Page, testInfo: TestInfo, name: string) {
  await expectNoBlockingAxe(page)
  await page.screenshot({ path: testInfo.outputPath(`${name}-1440.png`), fullPage: true })
  const wide = page.viewportSize()
  await page.setViewportSize({ width: 375, height: 812 })
  await expectNoBlockingAxe(page)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${name}: no sideways scroll at 375 px`).toBe(true)
  await page.screenshot({ path: testInfo.outputPath(`${name}-375.png`), fullPage: true })
  if (wide) await page.setViewportSize(wide)
}

test.describe('@s7 the supplier report', () => {
  test.describe.configure({ timeout: 240_000 })

  test('[BR-SUP-13] [FR-VIS-002/AC1] G-7 for October: 3.6 business days from 3 approvals, self 2.1, on behalf 8.8', async ({ page }, testInfo) => {
    const tag = randomBytes(3).toString('hex')
    scene('setup', tag)
    await signIn(page, `proc_officer.${tag}`)

    // the catalog of /reports leads to the page of its own
    await page.goto('/reports')
    await page.getByRole('link', { name: 'เวลาขึ้นทะเบียนผู้ขายรายใหม่ (G-7)' }).click()
    await expect(page).toHaveURL(/\/reports\/suppliers/)

    await page.goto('/reports/suppliers?from=2026-10-01&to=2026-10-31')
    const medians = page.getByRole('definition')
    await expect(page.getByRole('heading', { name: 'รายงานผู้ขาย', level: 1 })).toBeVisible()
    await expect(medians.nth(0)).toHaveText('3.6 วันทำการ')
    await expect(medians.nth(1)).toHaveText('2.1 วันทำการ')
    await expect(medians.nth(2)).toHaveText('8.8 วันทำการ')
    await expect(page.getByText('ใบสมัครที่อนุมัติในช่วงนี้ (3 ใบ)')).toBeVisible()
    await expect(page.getByText('ใบสมัครที่ค้างเกินกำหนด (1 ใบ)')).toBeVisible()
    await expect(page.getByRole('region', { name: 'ผู้ขายที่เอกสารบังคับหมดอายุ' })).toContainText('วัสดุก่อสร้างทั่วไป')
    await shot(page, testInfo, 's7-16-suppliers')
  })
})
