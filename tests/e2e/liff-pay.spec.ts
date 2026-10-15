import { spawnSync } from 'node:child_process'
import { formatSatang } from '../../src/core/money/format'
import { E2E_PIN, e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'
import { checkScreen, expectFirstLoadWithinBudget, newLineUserId, openAsLineUser, weighFirstLoad } from './liff-support'

// S9-06 · @pay: the CFO approves a payment run with a flag in the LINE app (FR-PAY-101 AC5 AC9, BR-PAY-07, BR-TOK-05,
// ADR-052) at 375 px in the mobile project, each screen checked at 1440 px too (axe, no sideways scroll, 44 px targets).
// LIFF_MOCK stands in for the LINE app: the mock cookie names the LINE user, the fake LINE server of the run issues its
// ID token, and the sign-in and everything after are the real path. The run is a phase-1 organization's of its own
// (pay-scene.ts): two suppliers over the stepUpThreshold, the first one's registry reported ceased with the preparer's
// reason. The page lists the flagged item first with its reason; approving takes the tick of the flags and the PIN.

interface Made {
  readonly orgCode: string
  readonly runId: string
  readonly taskId: string
  readonly number: string
  readonly flagsKey: string
  readonly flagged: string
  readonly clean: string
  readonly transferSatang: string
}

test.describe.configure({ timeout: 180_000 })

function scene<T>(...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/pay-scene.ts ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`payment scene ${args[0]} failed:\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}

test('[FR-PAY-101/AC5] [FR-PAY-101/AC9] @pay the CFO reads the flagged item first and approves the run in LINE with the tick of the flags and the PIN', async ({ page, context }, testInfo) => {
  const lineCfo = newLineUserId()
  const made = scene<Made>('liff', lineCfo)
  expect(made.flagsKey).toBe(`${made.flagged}:REGISTRY_CHANGED`)
  const decisionBar = page.getByRole('region', { name: 'ตัดสินงานนี้' })

  await openAsLineUser(context, lineCfo)
  // the page's first JavaScript is within the budget of §9.4 (ADR-052: no workspace library)
  expectFirstLoadWithinBudget(testInfo, '/liff/tasks/[id], a payment run with a flag', await weighFirstLoad(page, `/liff/tasks/${made.taskId}`, () => expect(decisionBar).toBeVisible()))

  const transfer = formatSatang(BigInt(made.transferSatang))
  const summary = page.getByRole('region', { name: 'รอบจ่าย', exact: true })
  await expect(summary).toContainText(made.number)
  await expect(summary).toContainText(`${transfer} บาท`)
  await expect(summary).toContainText('CB-01')
  // BR-PAY-07: the flagged item first, with its flag and the preparer's reason; the clean supplier is not listed there
  const flags = page.getByRole('region', { name: 'รายการที่มีธง (1)' })
  await expect(flags).toContainText(made.flagged)
  await expect(flags).toContainText('สถานะทะเบียนเปลี่ยน')
  await expect(flags).toContainText('ส่งมอบงานครบก่อนเลิกกิจการ ตรวจกับจัดซื้อแล้ว')
  await expect(flags).not.toContainText(made.clean)
  await checkScreen(page, testInfo, 'liff-payment-run-task')

  // approving asks for the tick of the flags first, then the PIN (the run is over the stepUpThreshold)
  await decisionBar.getByRole('button', { name: 'อนุมัติ', exact: true }).click()
  const confirm = decisionBar.getByRole('group', { name: new RegExp(`อนุมัติ ${made.number}`) })
  await expect(confirm).toBeVisible()
  await confirm.getByLabel('PIN 6 หลัก').fill(E2E_PIN)
  await confirm.getByRole('button', { name: 'ยืนยันอนุมัติ' }).click()
  await expect(confirm.getByText('กรุณาติ๊กว่าตรวจรายการที่มีธงแล้วก่อนอนุมัติ')).toBeVisible()
  await confirm.getByRole('checkbox', { name: 'ฉันตรวจรายการที่มีธงทั้งหมดและเหตุผลแล้ว' }).check()
  await confirm.getByLabel('PIN 6 หลัก').fill(E2E_PIN)
  await confirm.getByRole('button', { name: 'ยืนยันอนุมัติ' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'อนุมัติแล้วโดย' })).toBeVisible({ timeout: 15_000 })
  await expect(decisionBar).toHaveCount(0)
  expect(scene('decided', made.runId)).toEqual({ status: 'APPROVED', channel: 'LIFF', decision: 'APPROVE', stepUp: true })
  await checkScreen(page, testInfo, 'liff-payment-run-approved')
})
