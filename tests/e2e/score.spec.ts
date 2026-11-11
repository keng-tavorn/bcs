import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { Page, TestInfo } from '@playwright/test'
import { deriveSeedTotpSecret, totp } from '../../src/lib/totp'
import { e2eEnv } from '../support/e2e-env'
import { expectNoBlockingAxe, expectNoSideways } from './budgets-support'
import { expect, test } from './fixtures'

// S10-08 (FR-SRC-203 AC2 AC3 · BR-RFX-09 10): an evaluator scores a closed RFx at /sourcing/[id]/score — the table of the
// bids × delivery and quality, a draft saved, an incomplete send refused, then the send confirmed (AlertDialog) — and,
// the other evaluator having sent already, the totals and ranking appear. axe with no serious or critical finding, no
// sideways scrolling of the page, a picture at 1440 and 375 px of the sheet and of the ranking.

function scene<T>(...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/score-scene.ts ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`score scene ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`)
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

test('[FR-SRC-203/AC2] [FR-SRC-203/AC3] an evaluator scores the bids on their own, sends, and the ranking is revealed', async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  const opened = scene<{ rfxEventId: string; number: string }>('open', randomUUID().slice(0, 6))
  await signIn(page, 'dm_it')
  await page.goto(`/sourcing/${opened.rfxEventId}/score`)
  await expect(page.getByRole('heading', { level: 1 })).toContainText(opened.number)
  await expect(page.getByText('รอผู้ประเมินส่งครบ').first()).toBeVisible()
  const scores: Array<[string, string, string]> = [
    ['บริษัท ชลบุรีภัณฑ์ จำกัด', '90', '90'],
    ['บริษัท สหมิตรเหล็ก จำกัด', '90', '90'],
    ['บริษัท เหล็กไทยค้าส่ง จำกัด', '75', '80'],
  ]
  // a draft of one bid, then a send that still misses the others is refused
  await page.getByLabel(`คะแนน การส่งมอบ ของ ${scores[0]![0]}`).fill(scores[0]![1])
  await page.getByRole('button', { name: 'บันทึกร่าง' }).click()
  await expect(page.getByText('บันทึกร่างแล้ว')).toBeVisible()
  await shot(page, testInfo, 'score-sheet')
  await page.getByRole('button', { name: 'ส่งคะแนน' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'ส่งคะแนน' }).click()
  await expect(page.getByText('ยังให้คะแนนไม่ครบ 5 ช่อง')).toBeVisible()
  for (const [supplier, delivery, quality] of scores) {
    await page.getByLabel(`คะแนน การส่งมอบ ของ ${supplier}`).fill(delivery)
    await page.getByLabel(`คะแนน คุณภาพ ของ ${supplier}`).fill(quality)
  }
  await page.getByRole('button', { name: 'ส่งคะแนน' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'ส่งคะแนน' }).click()
  await expect(page.getByRole('heading', { name: 'คะแนนรวมและอันดับ' })).toBeVisible()
  await expect(page.getByText('เปิดเผยคะแนนแล้ว').first()).toBeVisible()
  // ชลบุรีภัณฑ์ lowest at 300,950.00 → price 100.00; delivery (85+90)/2 = 87.50, quality 90.00 → 95.38
  const first = page.getByRole('row').filter({ hasText: 'บริษัท ชลบุรีภัณฑ์ จำกัด' })
  await expect(first).toContainText('300,950.00')
  await expect(first).toContainText('95.38')
  await shot(page, testInfo, 'score-ranking')
})
