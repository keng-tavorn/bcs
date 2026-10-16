import { spawnSync } from 'node:child_process'
import { type Page, type TestInfo } from '@playwright/test'
import { e2eEnv } from '../support/e2e-env'
import { expectNoBlockingAxe, expectNoSideways, shot, signIn } from './budgets-support'
import { expect, test } from './fixtures'

// S6-15 on screen (FR-BUD-103 AC3 AC4, §9.1 /budgets/transfers): on the DEMO organization, whose DOA in effect has no
// BUDGET_TRANSFER rule, a BUDGET_ADMIN finds no "โอนหรือปรับงบ" button on the budget dashboard or the list of
// transfers, and the new-transfer page says why in place of the form (AC4); each line of the dashboard opens how it
// came to its planned amount (AC3); a draft sent from its page is refused in words with DOA_NOT_CONFIGURED and reserves
// nothing, and is then cancelled after an Alert Dialog. The scene (budget-transfer-scene.ts) never publishes a DOA
// version — other specs count on the DOA's version numbers — so the approved path runs in the integration tests
// (tests/integration/budget-transfer.test.ts). Screenshots at 375 px (mobile) and 1440 px (desktop) go to the test
// output (§9.9 step 4); every state is checked with axe (step 5).

interface Setup {
  readonly budgetAdmin: { readonly code: string; readonly email: string }
  readonly from: { readonly id: string; readonly code: string; readonly nameTh: string }
  readonly to: { readonly id: string; readonly code: string; readonly nameTh: string }
  readonly transferId: string
  readonly reason: string
}

function scene<T>(...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/budget-transfer-scene.ts ${args.map((a) => `"${a}"`).join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`budget transfer scene failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}

async function check(page: Page, testInfo: TestInfo, name: string) {
  await expectNoSideways(page)
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, name)
}

const NO_RULE = 'ผังอำนาจที่มีผลยังไม่มีข้อการโอนงบ จึงส่งไม่ได้'

test('[FR-BUD-103/AC4] [FR-BUD-103/AC3] without a BUDGET_TRANSFER rule there is no transfer button, the form says why, a draft is refused with DOA_NOT_CONFIGURED and reserves nothing; each line shows how it came to its planned amount', async ({
  page,
}, testInfo) => {
  // A scene of its own, four pages, axe and a screenshot at each state: longer than the default 30 s
  test.slow()
  const s = scene<Setup>('setup', testInfo.project.name)
  await signIn(page, s.budgetAdmin.email, s.budgetAdmin.code)

  // The dashboard: no transfer button (AC4), the list of transfers a link away, and each line's changes behind a button
  await page.goto('/budgets')
  await expect(page.getByRole('heading', { level: 1, name: 'งบประมาณ' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'โอนหรือปรับงบ', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'โอนหรือปรับงบ', exact: true })).toHaveCount(0)
  const changes = page.getByRole('button', { name: `ที่มาของงบ ${s.from.code}`, exact: true })
  await changes.click()
  await expect(changes).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByRole('link', { name: `งบตั้งต้น 5,000.00 บาท ของ ${s.from.code}: ดูการนำเข้างบ` })).toBeVisible()
  await expect(page.getByRole('link', { name: `โอนออก 0.00 บาท ของ ${s.from.code}: ดูความเคลื่อนไหวในบัญชีงบ` })).toBeVisible()
  await expect(page.getByRole('link', { name: `งบปัจจุบัน 5,000.00 บาท ของ ${s.from.code}: ดูการนำเข้างบ` }).last()).toBeVisible()
  await check(page, testInfo, 'budget-transfer-dashboard')

  // The list: the rule is missing, so no button and the reason in words; the scene's draft is there
  await page.getByRole('link', { name: 'การโอนและปรับงบ', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'การโอนและปรับงบ' })).toBeVisible()
  await expect(page.getByText(NO_RULE)).toBeVisible()
  await expect(page.getByRole('link', { name: 'โอนหรือปรับงบ', exact: true })).toHaveCount(0)
  const row = page.getByRole('listitem').filter({ hasText: `จาก ${s.from.code} ไป ${s.to.code}` })
  await expect(row).toContainText('ร่าง')
  await expect(row).toContainText('300.00')
  await expect(row).toContainText('ยังไม่ได้ส่ง')
  await check(page, testInfo, 'budget-transfer-list')

  // The new-transfer page, opened by its address: the reason in place of the form
  await page.goto('/budgets/transfers/new')
  await expect(page.getByRole('heading', { level: 1, name: 'โอนหรือปรับงบ' })).toBeVisible()
  await expect(page.getByText(NO_RULE)).toBeVisible()
  await expect(page.getByRole('button', { name: 'ส่งขออนุมัติ', exact: true })).toHaveCount(0)
  await check(page, testInfo, 'budget-transfer-new-no-rule')

  // The draft's page: sent, it is refused in words and stays a draft with nothing reserved
  await page.goto('/budgets')
  await page.getByRole('link', { name: 'การโอนและปรับงบ', exact: true }).click()
  await row.getByRole('link', { name: 'เปิด ร่างที่ยังไม่มีเลข' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'ร่างการโอนหรือปรับงบ' })).toBeVisible()
  await expect(page.getByText(`${s.from.code} · ${s.from.nameTh}`)).toBeVisible()
  await expect(page.getByText(`${s.to.code} · ${s.to.nameTh}`)).toBeVisible()
  await expect(page.getByText('300.00 บาท')).toBeVisible()
  await expect(page.getByText(s.reason)).toBeVisible()
  await check(page, testInfo, 'budget-transfer-draft')
  await page.getByRole('button', { name: 'ส่งขออนุมัติอีกครั้ง', exact: true }).click()
  await expect(page.getByRole('alert').filter({ hasText: NO_RULE })).toBeVisible()
  await expect(page.getByText('ร่าง', { exact: true })).toBeVisible()
  expect(scene<{ available: string; reserved: string }>('figures', s.from.id)).toEqual({ available: '5,000.00', reserved: '0.00' })
  await check(page, testInfo, 'budget-transfer-refused')

  // Cancelling asks first in an Alert Dialog, then the transfer is cancelled and offers nothing more
  await page.getByRole('button', { name: 'ยกเลิกรายการนี้', exact: true }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog.getByRole('heading', { name: 'ยกเลิก ร่างที่ยังไม่มีเลข' })).toBeVisible()
  await check(page, testInfo, 'budget-transfer-cancel-confirm')
  await dialog.getByRole('button', { name: 'ยืนยันยกเลิกรายการ', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'ยกเลิกรายการนี้แล้ว' })).toBeVisible()
  await expect(page.getByText('ยกเลิก', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'ส่งขออนุมัติอีกครั้ง', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'ยกเลิกรายการนี้', exact: true })).toHaveCount(0)
  await check(page, testInfo, 'budget-transfer-cancelled')
})
