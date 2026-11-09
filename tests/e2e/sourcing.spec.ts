import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { Page, TestInfo } from '@playwright/test'
import { deriveSeedTotpSecret, totp } from '../../src/lib/totp'
import { E2E_PIN, e2eEnv } from '../support/e2e-env'
import { expectNoBlockingAxe, expectNoSideways } from './budgets-support'
import { expect, test } from './fixtures'
import { anotherPhone, newLineUserId, openAsLineUser } from './liff-support'

// S10-12 (FR-SRC-201 AC1 · FR-SRC-202 AC5 · FR-SRC-204 AC2 · BR-RFX-01 03 06 08 · BR-SOD-14): the internal side of scene 9
// on the new screens. proc_officer ticks two steel lines of the pool and presses "เปิด RFx จากบรรทัดที่เลือก", makes the
// draft RFQ, invites three suppliers, sets the scorecard (price 60 · delivery 25 · quality 15, dm_proc and dm_it), picks
// the close and opens it; while it is open the bids tab shows who sent a bid and no price (sealed); the suppliers bid
// from the portal and the close comes (the scene, as the job does at closesAt); the comparison shows the amounts before
// VAT; the two evaluators score on /sourcing/[id]/score; procurement awards both lines to the lowest and sends it; the
// run's approver approves it on LIFF with the PIN (322,016.50 with VAT is above the step-up threshold), and the award
// drafts its two POs (185,200.00 and 115,750.00). The list shows the RFx; the pool marks its lines "อยู่ใน RFx". axe with
// no serious or critical finding and no sideways scrolling at 1440 and 375 px on each new page. Each project runs it
// with its own tag; the approver's phone is a browser of its own.

interface Setup {
  readonly lines: readonly [string, string]
  readonly suppliers: ReadonlyArray<{ readonly code: string; readonly name: string }>
  readonly evaluators: readonly [string, string]
  readonly approver: string
}

function scene<T>(...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/sourcing-scene.ts ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`sourcing scene ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}

async function signIn(page: Page, code: string) {
  await page.context().clearCookies()
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

let tag = ''
test.afterAll(() => {
  if (tag) scene('cleanup', tag)
})

test('[FR-SRC-201/AC1] [FR-SRC-202/AC5] scene 9 inside: the pool opens an RFQ, it is set up step by step and opened, sealed until its close, compared, scored, awarded and approved on LIFF with the PIN', async ({ page, browser }, testInfo) => {
  test.setTimeout(420_000)
  tag = randomUUID().replace(/-/g, '').slice(0, 8)
  const lineUserId = newLineUserId()
  const made = scene<Setup>('setup', tag, lineUserId)
  const [winner, second, third] = made.suppliers as [Setup['suppliers'][number], Setup['suppliers'][number], Setup['suppliers'][number]]

  // the pool: tick the two lines and open an RFx from them
  await signIn(page, 'proc_officer')
  await page.goto('/procurement/pool')
  for (const description of made.lines) await page.getByRole('checkbox', { name: new RegExp(`เลือกบรรทัด 1 ${description}`) }).check()
  await page.getByRole('button', { name: 'เปิด RFx จากบรรทัดที่เลือก' }).click()
  await page.waitForURL(/\/sourcing\/new\?lines=/)
  await expect(page.getByText('บรรทัดจากกองจัดซื้อ 2 บรรทัด')).toBeVisible()
  await shot(page, testInfo, 'sourcing-new')
  await page.getByLabel('ชื่อ RFx (ไทย)').fill(`เหล็กข้ออ้อย DB12 ${tag}`)
  await page.getByLabel('รายละเอียดและขอบเขต (ไทย)').fill('ขอราคาเหล็กข้ออ้อย DB12 SD40 สำหรับไซต์ A และ B')
  await page.getByRole('button', { name: 'สร้างร่าง RFx' }).click()
  await page.waitForURL(/\/sourcing\/[0-9a-f-]{36}\/edit\?step=suppliers/)
  const rfxEventId = new URL(page.url()).pathname.split('/')[2]!

  // suppliers: three invited, the count against the minimum
  for (const s of made.suppliers) {
    await page.getByLabel('ผู้ขายที่จะเชิญ').selectOption({ label: `${s.code} · ${s.name}` })
    await page.getByRole('button', { name: 'เชิญผู้ขายนี้' }).click()
    await expect(page.getByText(`เชิญ ${s.code} · ${s.name} แล้ว`)).toBeVisible()
  }
  await expect(page.getByText(/^เชิญแล้ว 3 ราย ครบขั้นต่ำ/)).toBeVisible()
  await shot(page, testInfo, 'sourcing-edit-suppliers')

  // the scorecard: price 60 · delivery 25 · quality 15, and two evaluators (the creator cannot be picked · BR-SOD-14)
  await page.getByRole('link', { name: /Scorecard/ }).click()
  await page.waitForURL(/step=scorecard/)
  const weights = page.getByLabel('น้ำหนัก %')
  await weights.nth(0).fill('60')
  await weights.nth(1).fill('25')
  await weights.nth(2).fill('15')
  await expect(page.getByText('รวม 100%')).toBeVisible()
  for (const name of made.evaluators) {
    await page.getByLabel('เพิ่มผู้ประเมิน').selectOption({ label: name })
    await page.getByRole('button', { name: 'เพิ่มเป็นผู้ประเมิน' }).click()
  }
  await expect(page.getByLabel('เพิ่มผู้ประเมิน').locator('option', { hasText: 'ผู้สร้าง RFx' })).toBeDisabled()
  await page.getByRole('button', { name: 'บันทึก Scorecard' }).click()
  await expect(page.getByText('บันทึก Scorecard แล้ว')).toBeVisible()
  await shot(page, testInfo, 'sourcing-edit-scorecard')

  // the close (an hour after the earliest by default), then review and open
  await page.getByRole('link', { name: /กำหนดเวลา/ }).click()
  await page.waitForURL(/step=schedule/)
  await page.getByRole('button', { name: 'ถัดไป: ตรวจและเปิด' }).click()
  await page.waitForURL(/step=review/)
  await expect(page.getByText('Scorecard ครบ')).toBeVisible()
  await shot(page, testInfo, 'sourcing-edit-review')
  await page.getByRole('button', { name: 'เปิด RFx' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'เปิด RFx' }).click()
  await page.waitForURL(new RegExp(`/sourcing/${rfxEventId}$`))
  const heading = page.getByRole('heading', { level: 1 })
  await expect(heading).toContainText(/RFX-\d{4}-\d{5}/)
  const number = (await heading.textContent())!.match(/RFX-\d{4}-\d{5}/)![0]

  // the pool marks its lines; the list shows the RFx open
  await page.goto('/procurement/pool')
  await expect(page.getByText(`อยู่ใน RFx ${number}`).first()).toBeVisible()
  await page.goto('/sourcing')
  await expect(page.getByRole('link', { name: new RegExp(number) })).toBeVisible()
  await shot(page, testInfo, 'sourcing-list')

  // the suppliers bid from the portal: sealed, procurement sees who and how many, no price (BR-RFX-06)
  scene('bids', tag, rfxEventId)
  // (the scene closed it at its closesAt as the job does; the page now shows the comparison before VAT · BR-RFX-08)
  await page.goto(`/sourcing/${rfxEventId}?tab=bids`)
  await expect(page.getByText('300,950.00').first()).toBeVisible()
  await expect(page.getByText(winner.name).first()).toBeVisible()
  await shot(page, testInfo, 'sourcing-detail-bids')

  // the evaluators score on their own pages
  const scores: Record<string, readonly [string, string]> = { [winner.name]: ['90', '90'], [second.name]: ['85', '80'], [third.name]: ['70', '80'] }
  for (const evaluator of ['dm_proc', 'dm_it']) {
    await signIn(page, evaluator)
    await page.goto(`/sourcing/${rfxEventId}/score`)
    for (const [supplier, [delivery, quality]] of Object.entries(scores)) {
      await page.getByLabel(`คะแนน การส่งมอบ ของ ${supplier}`).fill(delivery)
      await page.getByLabel(`คะแนน คุณภาพ ของ ${supplier}`).fill(quality)
    }
    await page.getByRole('button', { name: 'ส่งคะแนน' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'ส่งคะแนน' }).click()
    await expect(page.getByText('ส่งคะแนนแล้ว').first()).toBeVisible()
  }
  await expect(page.getByRole('heading', { name: 'คะแนนรวมและอันดับ' })).toBeVisible()

  // procurement awards both lines to the lowest and first ranked, and sends it
  await signIn(page, 'proc_officer')
  await page.goto(`/sourcing/${rfxEventId}/award`)
  await page.getByLabel(/^รายการ 1 /).selectOption({ label: `${winner.name} · 185,200.00 บาท (ต่ำสุด)` })
  await page.getByLabel(/^รายการ 2 /).selectOption({ label: `${winner.name} · 115,750.00 บาท (ต่ำสุด)` })
  await page.getByRole('button', { name: 'บันทึกผล' }).click()
  await expect(page.getByText('บันทึกผลแล้ว')).toBeVisible()
  await expect(page.getByText('322,016.50').first()).toBeVisible()
  await page.getByRole('button', { name: 'ส่งขออนุมัติ' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'ส่งขออนุมัติ' }).click()
  await expect(page.getByText('ส่งขออนุมัติแล้ว')).toBeVisible()
  const { taskId, awardNumber } = scene<{ taskId: string; awardNumber: string }>('task', rfxEventId)

  // the approver's phone: the award on LIFF, approved with the PIN
  const phone = await anotherPhone(browser)
  try {
    await openAsLineUser(phone, lineUserId)
    const liff = await phone.newPage()
    await liff.goto(`/liff/tasks/${taskId}`)
    await expect(liff.getByText(awardNumber).first()).toBeVisible()
    await expect(liff.getByText('322,016.50').first()).toBeVisible()
    const bar = liff.getByRole('region', { name: 'ตัดสินงานนี้' })
    await bar.getByRole('button', { name: 'อนุมัติ', exact: true }).click()
    await bar.getByLabel('PIN 6 หลัก').fill(E2E_PIN)
    await bar.getByRole('button', { name: 'ยืนยันอนุมัติ' }).click()
    await expect(liff.getByRole('status').filter({ hasText: `อนุมัติแล้วโดย ${made.approver} เมื่อ` })).toBeVisible({ timeout: 15_000 })
  } finally {
    await phone.close()
  }
  const result = scene<{ status: string; gross: string; pos: Array<{ status: string; net: string }>; channel: string | null; stepUp: boolean }>('result', rfxEventId)
  expect(result).toMatchObject({ status: 'APPROVED', gross: '32201650', channel: 'LIFF', stepUp: true })
  expect(result.pos.map((p) => p.net).sort()).toEqual(['11575000', '18520000'])

  // the RFx's page shows its award and what it made
  await page.goto(`/sourcing/${rfxEventId}?tab=awards`)
  await expect(page.getByText(awardNumber).first()).toBeVisible()
  await shot(page, testInfo, 'sourcing-detail-award')
})
