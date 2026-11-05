import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import type { TestInfo } from '@playwright/test'
import { e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'
import { expectNoBlockingAxe, expectNoSideways, shot, signIn } from './tasks-support'

// NEW-123 on screen (FR-VIS-008 AC1 AC2 · ADR-084 · spec §7.21): three POs of a drill were approved at 2,400.00,
// 2,380.00 and 2,450.00, then a request for two of it at 2,700.00 waits for approval (price-reference-scene.ts, in the
// demo organization, fresh for each Playwright project). Procurement opens "โอกาสประหยัด" from the menu and finds the
// drill 12.50% above past prices, 600.00 baht to save — 2 × (2,700.00 − 2,400.00) by findSavings — with the three POs as
// its evidence (a table at 1440 px, a list at 375 px) and one way to the request. The requester, who may not read the
// prices of other POs (OQ-116), is refused and has no menu entry. Screenshots at both widths go to the test output
// (§9.9 step 4); every screen is checked with axe (step 5) and never scrolls sideways.

interface Reference {
  readonly id: string
  readonly number: string
  readonly title: string
  readonly item: string
}

// Three POs and a request through the services, and two sign-ins: more than Playwright's default 30 seconds
test.describe.configure({ timeout: 240_000 })

function run<T>(script: string, ...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/${script} ${args.map((a) => `"${a}"`).join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`${script} ${args[0]} failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}

const scene = (testInfo: TestInfo) => run<Reference>('price-reference-scene.ts', 'reference', `savings-${testInfo.project.name}-${randomBytes(3).toString('hex')}`)

test('[FR-VIS-008/AC1] procurement finds the drill above past prices with the amount to save and the POs behind it', async ({ page }, testInfo) => {
  const s = scene(testInfo)
  await signIn(page, 'proc_officer', true)
  if (testInfo.project.name === 'desktop') {
    // The sidebar's procurement group holds the page (§9.10)
    await page.getByRole('link', { name: 'โอกาสประหยัด', exact: true }).first().click()
    await expect(page).toHaveURL(/\/procurement\/savings$/)
  } else {
    await page.goto('/procurement/savings')
  }
  await expect(page.getByRole('heading', { level: 1, name: 'โอกาสประหยัด' })).toBeVisible()
  const summary = page.getByRole('region', { name: 'สรุปโอกาสประหยัด' })
  await expect(summary).toContainText(/ถ้าซื้อในราคาที่เทียบได้ จ่ายน้อยลงรวม [\d,]+\.\d{2} บาท/)
  // Each kind a link with its count, so every number leads to its list (§9.9)
  const kinds = summary.getByRole('navigation', { name: 'ดูเฉพาะชนิด' })
  await expect(kinds.getByRole('link', { name: /^ทั้งหมด \d+$/ })).toHaveAttribute('aria-current', 'page')
  await expect(kinds.getByRole('link', { name: /^แพงกว่าที่เคยซื้อ \d+$/ })).toBeVisible()

  const list = page.getByRole('region', { name: 'เรื่องที่ผู้ช่วยเจอ' })
  const drill = list.getByRole('listitem').filter({ hasText: s.item }).first()
  await expect(drill).toContainText(`${s.number} บรรทัด 1 ${s.item} แพงกว่าที่เคยซื้อ 12.50%`)
  await expect(drill).toContainText('ถ้าได้ราคาค่ากลาง จ่ายน้อยลง 600.00 บาท')
  await expect(drill).toContainText('ค่ากลางของ PO 3 ใบใน 365 วันคือ 2,400.00 บาทต่อชิ้น · คำขอนี้ 2,700.00 บาทต่อชิ้น จำนวน 2 ชิ้น')
  await expect(drill.locator('[data-slot="badge"]')).toHaveText('รออนุมัติ')
  await expect(drill.getByRole('link', { name: 'เปิดคำขอ' })).toHaveAttribute('href', `/requests/${s.id}`)

  // The evidence opens on a press only, and says how the median came out
  const toggle = drill.getByRole('button', { name: 'ดูหลักฐาน' })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  await expect(drill.getByRole('button', { name: 'ซ่อนหลักฐาน' })).toHaveAttribute('aria-expanded', 'true')
  await expect(drill).toContainText('ต่ำสุด 2,380.00 · ค่ากลาง 2,400.00 · สูงสุด 2,450.00 บาท')
  if (testInfo.project.name === 'desktop') {
    const table = drill.getByRole('table', { name: 'PO ที่ใช้เป็นค่ากลาง' })
    await expect(table).toBeVisible()
    await expect(table.getByRole('columnheader', { name: 'ราคาต่อหน่วย (บาท)' })).toBeVisible()
    // the latest PO first: the three prices in the order they were approved, last one on top
    await expect(table.getByRole('row')).toHaveCount(4)
    await expect(table.getByRole('row').nth(1)).toContainText('2,450.00')
    await expect(table.getByRole('row').nth(3)).toContainText('2,400.00')
    await expect(table.getByRole('rowheader').first().getByRole('link')).toHaveAttribute('href', /^\/procurement\/pos\//)
  } else {
    // a phone: the POs as a list, label and figure on one row, nothing scrolls sideways
    const pos = drill.getByRole('list', { name: 'PO ที่ใช้เป็นค่ากลาง' })
    await expect(pos).toBeVisible()
    await expect(pos.getByRole('listitem')).toHaveCount(3)
    await expect(pos.getByRole('listitem').first()).toContainText('2,450.00')
    await expect(drill.getByRole('table')).toBeHidden()
  }
  await expectNoSideways(page)
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'savings')

  // One kind at a time, from its link
  await kinds.getByRole('link', { name: /^แพงกว่าที่เคยซื้อ \d+$/ }).click()
  await expect(page).toHaveURL(/\/procurement\/savings\?kind=PRICE_ABOVE_HISTORY$/)
  await expect(page.getByRole('navigation', { name: 'ดูเฉพาะชนิด' }).getByRole('link', { name: /^แพงกว่าที่เคยซื้อ \d+$/ })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('region', { name: 'เรื่องที่ผู้ช่วยเจอ' }).getByRole('listitem').filter({ hasText: s.item })).toHaveCount(1)
  await expectNoBlockingAxe(page)
})

test('[FR-VIS-008/AC2] the requester, who may not read the prices of every PO, is refused and has no menu entry', async ({ page }, testInfo) => {
  await signIn(page, 'req_con', false)
  await page.goto('/procurement/savings')
  await expect(page.getByRole('heading', { level: 1, name: 'โอกาสประหยัด' })).toBeVisible()
  await expect(page.getByText('หน้านี้เปิดได้เฉพาะผู้ที่ดูใบสั่งซื้อและคำขอทั้งองค์กรได้')).toBeVisible()
  await expect(page.getByRole('region', { name: 'เรื่องที่ผู้ช่วยเจอ' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'กลับหน้าแรก' })).toHaveAttribute('href', '/')
  if (testInfo.project.name === 'desktop') await expect(page.getByRole('link', { name: 'โอกาสประหยัด', exact: true })).toHaveCount(0)
  await expectNoSideways(page)
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'savings-refused')
})

// NEW-136 (FR-VIS-008 AC3 · ADR-084): with the AI module and the Insight agent on, each saving has "ให้ผู้ช่วยอธิบาย",
// which says it uses credits. The e2e app plays recorded answers only and the drill is new each run, so a press finds
// none and the row says the assistant could not explain, the figures staying; the explanation the member then asks for
// through the same service (savings-ai-scene.ts) reads after a reload set apart with Sparkles, the line that the
// assistant wrote it, and "ช่วยได้" "ไม่ช่วย". With the AI off, button and explanation are gone and the figures stay.
function aiScene(mode: 'on' | 'off') {
  const r = spawnSync('pnpm exec tsx tests/e2e/ai-document-scene.ts', { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv(), SCENE_MODE: mode } })
  if (r.status !== 0) throw new Error(`ai-document-scene ${mode} failed:\n${r.stdout}\n${r.stderr}`)
}
// the demo organization keeps the AI module off for every other test (the runs are serial)
test.afterEach(() => aiScene('off'))

test('[FR-VIS-008/AC3] procurement asks the assistant to word the drill’s saving; with the AI off it is gone', async ({ page }, testInfo) => {
  const s = scene(testInfo)
  aiScene('on')
  await signIn(page, 'proc_officer', true)
  await page.goto('/procurement/savings?kind=PRICE_ABOVE_HISTORY')
  const drill = page.getByRole('region', { name: 'เรื่องที่ผู้ช่วยเจอ' }).getByRole('listitem').filter({ hasText: s.item }).first()
  const ask = drill.getByRole('button', { name: 'ให้ผู้ช่วยอธิบาย' })
  await expect(ask).toBeVisible()
  await expect(ask).toHaveAccessibleDescription('ใช้ credits ของ AI ทุกครั้งที่กด')
  await ask.click()
  await expect(drill.getByRole('alert')).toHaveText('ผู้ช่วยเขียนคำอธิบายไม่ได้ในครั้งนี้ ตัวเลขและหลักฐานด้านบนยังใช้ได้')
  await expect(drill).toContainText('ถ้าได้ราคาค่ากลาง จ่ายน้อยลง 600.00 บาท')

  const written = run<{ status: string; sentences: string[] }>('savings-ai-scene.ts', 'explain', 'proc_officer', s.number)
  expect(written.status).toBe('READY')
  await page.reload()
  const words = drill.getByRole('region', { name: 'คำอธิบายจากผู้ช่วย' })
  await expect(words).toContainText(`คำขอ ${s.number} ขอราคา 2,700.00 บาท สูงกว่าค่ากลาง 2,400.00 บาท อยู่ 12.5%`)
  await expect(words).toContainText('ถ้าซื้อที่ค่ากลางจะถูกลง 600.00 บาท')
  await expect(words).toContainText('ผู้ช่วยเขียนจากตัวเลขในเรื่องนี้ โปรดตรวจกับหลักฐาน')
  await expect(words.locator('svg.lucide-sparkles')).toHaveCount(1)
  await expect(drill.getByRole('button', { name: 'อธิบายใหม่' })).toBeVisible()
  const helpful = words.getByRole('button', { name: 'ช่วยได้' })
  await helpful.click()
  await expect(helpful).toHaveAttribute('aria-pressed', 'true')
  await expect(words.getByRole('button', { name: 'ไม่ช่วย' })).toHaveAttribute('aria-pressed', 'false')
  await expectNoSideways(page)
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'savings-explained')

  aiScene('off')
  await page.reload()
  await expect(drill).toContainText('ถ้าได้ราคาค่ากลาง จ่ายน้อยลง 600.00 บาท')
  await expect(drill.getByRole('button', { name: /ให้ผู้ช่วยอธิบาย|อธิบายใหม่/ })).toHaveCount(0)
  await expect(drill.getByRole('region', { name: 'คำอธิบายจากผู้ช่วย' })).toHaveCount(0)
  await expect(page.locator('svg.lucide-sparkles')).toHaveCount(0)
  await expectNoBlockingAxe(page)
})
