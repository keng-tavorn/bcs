import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { Page, TestInfo } from '@playwright/test'
import { deriveSeedTotpSecret, totp } from '../../src/lib/totp'
import { e2eEnv } from '../support/e2e-env'
import { expectNoBlockingAxe, expectNoSideways } from './budgets-support'
import { expect, test } from './fixtures'

// S10-10 (FR-SRC-204 AC2 · BR-RFX-12): procurement awards a closed and revealed RFx at /sourcing/[id]/award — line 1 to
// the first ranked and line 2 to the second is refused without a reason (not the first ranked, split), saved with one;
// the facts show the split amounts (302,700.00 + VAT 21,189.00 = 323,889.00) and the tags; the route panel says what the
// send would meet. The demo organization's DOA has no RA rule, so the send is refused DOA_NOT_CONFIGURED and the award
// stays a draft (the route and the decision are the integration tests'). axe with no serious or critical finding, no
// sideways scrolling, a picture at 1440 and 375 px.

function scene<T>(...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/award-scene.ts ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`award scene ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}

async function signIn(page: Page, code: string) {
  await page.goto('/login')
  await page.getByLabel('อีเมลบริษัท').fill(`${code}@demo.bcs.local`)
  await page.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
  await page.waitForURL((url) => !url.pathname.endsWith('/login'))
  if (page.url().endsWith('/login/2fa')) {
    await page.getByLabel('รหัส 6 หลักจากแอป').fill(totp(deriveSeedTotpSecret(process.env.SEED_TOTP_KEY!, code)))
    await page.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' }).click()
  }
  await expect(page.getByRole('heading', { level: 1 })).toContainText('สวัสดี')
}

/** A picture at 1440 px and at the phone's 375 px (§9.9 step 4), the page checked at both */
async function shot(page: Page, testInfo: TestInfo, name: string) {
  for (const [width, height] of [
    [1440, 900],
    [375, 812],
  ] as const) {
    await page.setViewportSize({ width, height })
    await expectNoBlockingAxe(page)
    await expectNoSideways(page)
    await page.screenshot({ path: testInfo.outputPath(`${name}-${width}.png`), fullPage: true })
  }
  await page.setViewportSize({ width: 1440, height: 900 })
}

test.afterAll(() => {
  scene('module', 'off')
})

test('[FR-SRC-204/AC2] procurement picks the winner of each line, gives the reason a split asks, and sees what the send would meet', async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  const opened = scene<{ rfxEventId: string; number: string }>('open', randomUUID().slice(0, 6))
  await signIn(page, 'proc_officer')
  await page.goto(`/sourcing/${opened.rfxEventId}/award`)
  await expect(page.getByRole('heading', { level: 1 })).toContainText(opened.number)
  await expect(page.getByText('ยังไม่มีผล').first()).toBeVisible()
  await page.getByLabel(/^รายการ 1 /).selectOption({ label: 'บริษัท ชลบุรีภัณฑ์ จำกัด · 185,200.00 บาท (ต่ำสุด)' })
  await page.getByLabel(/^รายการ 2 /).selectOption({ label: 'บริษัท สหมิตรเหล็ก จำกัด · 117,500.00 บาท' })
  await page.getByRole('button', { name: 'บันทึกผล' }).click()
  await expect(page.getByText('ต้องระบุเหตุผลของผลนี้: ไม่ใช่อันดับ 1 · แบ่งมอบหลายราย')).toBeVisible()
  await page.getByLabel('เหตุผลของผลมอบงาน').fill('แบ่งมอบเพื่อให้ส่งทันทั้งสองไซต์')
  await page.getByRole('button', { name: 'บันทึกผล' }).click()
  await expect(page.getByText('บันทึกผลแล้ว')).toBeVisible()
  await expect(page.getByText('323,889.00').first()).toBeVisible()
  await expect(page.getByText('แบ่งมอบหลายราย').first()).toBeVisible()
  await expect(page.getByText('ส่งไม่ได้ตอนนี้').first()).toBeVisible()
  await shot(page, testInfo, 'award-draft')
  await page.getByRole('button', { name: 'ส่งขออนุมัติ' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'ส่งขออนุมัติ' }).click()
  await expect(page.getByText('อำนาจอนุมัติยังไม่มีข้อของผลการจัดหา').first()).toBeVisible()
})
