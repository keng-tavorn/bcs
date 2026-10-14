import { spawnSync } from 'node:child_process'
import { e2eEnv } from '../support/e2e-env'
import { expectNoBlockingAxe, expectNoSideways, shot } from './budgets-support'
import { expect, test } from './fixtures'

// S6-19 on screen (FR-DOA-102 AC2 · BR-QR-02 · OQ-112): the public page a printed PR's QR opens, without signing in —
// the company, the kind, the number, the current status, and that this printing is the latest — no amount; a token that
// is wrong opens the same "not found" page. Screenshots at 375 px and 1440 px (§9.9 step 4) and axe on both (step 5).

function scene(): { token: string; number: string; gross: string } {
  const r = spawnSync('pnpm exec tsx tests/e2e/verify-scene.ts', { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`verify scene failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as { token: string; number: string; gross: string }
}

test('[FR-DOA-102/AC2] the QR of a printed PR opens its public verification page; a wrong token is not found', async ({ page }, testInfo) => {
  const width = testInfo.project.name === 'mobile' ? '375' : '1440'
  const { token, number, gross } = scene()
  await page.goto(`/verify/${token}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('ใบขอซื้อนี้ออกโดยระบบจริง')
  await expect(page.getByText('เอกสารฉบับนี้เป็นฉบับล่าสุด')).toBeVisible()
  await expect(page.getByText(number, { exact: true })).toBeVisible()
  const text = await page.locator('main').innerText()
  expect(text).not.toContain(gross)
  expect(text).not.toMatch(/\d{1,3}(,\d{3})*\.\d\d/)
  await expectNoSideways(page)
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, `verify-found-${width}`)

  await page.goto(`/verify/${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('ไม่พบเอกสาร')
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, `verify-not-found-${width}`)
})
