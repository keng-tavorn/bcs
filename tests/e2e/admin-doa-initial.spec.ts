import AxeBuilder from '@axe-core/playwright'
import { spawnSync } from 'node:child_process'
import { type Locator, type Page, type TestInfo } from '@playwright/test'
import { deriveSeedTotpSecret, totp } from '../../src/lib/totp'
import { e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'

// S2-13 · FR-DOA-002 AC3 (BR-DOA-19): with no DOA yet, the first version goes as the initial package — the holders of
// the positions it names, prefilled from today's holders and edited one row at a time, then the reason and the send to
// the contract signatory. The demo organization has a DOA in effect, so each project builds an organization of its own
// without one (tests/e2e/admin-doa-initial-scene.ts). Screenshots at 375 px and 1440 px go to the test output (§9.9
// step 4); axe runs on every state.

interface Scene {
  readonly email: string
  readonly code: string
  readonly versionId: string
  readonly signatory: string
}

function scene(project: string): Scene {
  const r = spawnSync(`pnpm exec tsx tests/e2e/admin-doa-initial-scene.ts ${project}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`initial package scene failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as Scene
}

async function expectNoBlockingAxe(page: Page) {
  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(blocking.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)).toEqual([])
}

async function expectNoSideways(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
}

async function shot(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })
}

/** Chooses the option whose text contains `text` (department options are indented by their depth in the tree) */
async function choose(select: Locator, text: string) {
  const value = await select.locator('option', { hasText: text }).first().getAttribute('value')
  expect(value, text).toBeTruthy()
  await select.selectOption(value!)
}

async function signIn(page: Page, s: Scene) {
  await page.goto('/login')
  await page.getByLabel('อีเมลบริษัท').fill(s.email)
  await page.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
  await expect(page).toHaveURL(/\/login\/2fa$/)
  await page.getByLabel('รหัส 6 หลักจากแอป').fill(totp(deriveSeedTotpSecret(process.env.SEED_TOTP_KEY!, s.code)))
  await page.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('สวัสดี')
}

test('[FR-DOA-002/AC3] with no DOA yet, the first version goes with its position holders to the contract signatory, in two steps', async ({ page }, testInfo) => {
  const s = scene(testInfo.project.name)
  await signIn(page, s)

  // The versions page says the first version goes as the initial package
  await page.goto('/admin/doa')
  await expect(page.getByText('องค์กรยังไม่มี DOA ที่มีผล นำเข้าฉบับแรก แล้วส่งเป็นชุดตั้งต้นพร้อมรายชื่อผู้ดำรงตำแหน่ง ให้ผู้มีอำนาจลงนามตามสัญญาอนุมัติ')).toBeVisible()
  const draft = page.getByRole('region', { name: /ทุกฉบับ/ }).getByRole('listitem').filter({ hasText: 'DOA-DEMO ฉบับ 1' })
  await expect(draft).toContainText('ฉบับร่าง')
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'doa-initial-versions')

  // Step 1: today's holders of the positions the version names, one line each, edited one row at a time
  await draft.getByRole('link', { name: 'ดูรายละเอียด DOA-DEMO ฉบับ 1' }).click()
  const pkg = page.getByRole('region', { name: 'ส่งชุดตั้งต้นขององค์กร' })
  await expect(pkg).toContainText(`ชุดตั้งต้นจะส่งให้ ${s.signatory} (ผู้มีอำนาจลงนามตามสัญญา) อนุมัติ`)
  await expect(pkg.getByRole('list', { name: 'ขั้นตอนการส่งชุดตั้งต้น' }).getByRole('listitem').first()).toHaveAttribute('aria-current', 'step')
  const holders = pkg.locator('ol').filter({ has: page.getByRole('button', { name: /^แก้ / }) })
  await expect(holders.getByRole('listitem')).toHaveCount(6)
  await expect(holders.getByRole('listitem').filter({ hasText: 'ไอยรา ระบบงาน' })).toContainText('ผู้จัดการฝ่าย (DM) ของ ฝ่ายไอที')
  // Nothing but one line and one button per holder: no row of selects on the page
  await expect(pkg.getByRole('combobox')).toHaveCount(0)
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'doa-initial-holders')

  // A new DM of IT: the editor has three fields, and a duplicate slot is refused at the row
  await pkg.getByRole('button', { name: 'แก้ ผู้จัดการฝ่าย (DM) ของ ฝ่ายไอที' }).click()
  const editor = pkg.getByRole('group', { name: 'แก้ ผู้จัดการฝ่าย (DM) ของ ฝ่ายไอที' })
  await expect(editor.getByRole('combobox')).toHaveCount(3)
  await choose(editor.getByLabel('ผู้ดำรงตำแหน่ง', { exact: true }), `รัตนา หน้างาน (${s.code.replace(/_admin$/, '_req_con')})`)
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'doa-initial-edit')
  await editor.getByRole('button', { name: 'บันทึกแถวนี้' }).click()
  await expect(holders.getByRole('listitem').filter({ hasText: 'ผู้จัดการฝ่าย (DM) ของ ฝ่ายไอที' })).toContainText('รัตนา หน้างาน')
  await pkg.getByRole('button', { name: 'เพิ่มผู้ดำรงตำแหน่ง' }).click()
  const added = pkg.getByRole('group', { name: 'เพิ่มผู้ดำรงตำแหน่ง' })
  await added.getByLabel('ตำแหน่ง', { exact: true }).selectOption('DM')
  await choose(added.getByLabel('แผนก', { exact: true }), 'ฝ่ายก่อสร้าง (CON)')
  await choose(added.getByLabel('ผู้ดำรงตำแหน่ง', { exact: true }), `ไอยรา ระบบงาน (${s.code.replace(/_admin$/, '_dm_it')})`)
  await added.getByRole('button', { name: 'เพิ่มแถวนี้' }).click()
  await expect(added.getByRole('alert')).toContainText('ตำแหน่งเดียวกันในแผนกเดียวกันมีผู้ดำรงได้คนเดียว')
  await added.getByRole('button', { name: 'ยกเลิก' }).click()

  // Step 2: the reason and the send, with words that say what happens
  await pkg.getByRole('button', { name: 'ถัดไป: ใส่เหตุผลและส่ง' }).click()
  await expect(pkg.getByRole('heading', { name: 'เหตุผลและการส่ง' })).toBeFocused()
  await expect(pkg).toContainText('ชุดตั้งต้นนี้มีผู้ดำรงตำแหน่ง 6 คน พร้อม DOA ฉบับนี้')
  await pkg.getByRole('button', { name: 'ส่งชุดตั้งต้นให้ผู้มีอำนาจลงนามอนุมัติ' }).click()
  await expect(pkg.getByText('ใส่เหตุผลอย่างน้อย 3 ตัวอักษร')).toBeVisible()
  await pkg.getByLabel('เหตุผล (บันทึกในประวัติ)').fill('ชุดตั้งต้นตามสัญญาบริการ')
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'doa-initial-send')
  await pkg.getByRole('button', { name: 'ส่งชุดตั้งต้นให้ผู้มีอำนาจลงนามอนุมัติ' }).click()
  await expect(page.getByRole('status').filter({ hasText: `ส่งชุดตั้งต้นแล้ว รอ ${s.signatory} อนุมัติ` }).first()).toBeVisible()

  // The version now waits for the signatory under the initial package, and nothing on it can change
  await page.reload()
  await expect(page.getByText('รออนุมัติ', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('region', { name: 'การอนุมัติ' })).toContainText(`รอ ${s.signatory} อนุมัติ ตาม ชุดตั้งต้นขององค์กร (ผู้มีอำนาจลงนามตามสัญญา)`)
  await expect(page.getByRole('button', { name: 'ส่งชุดตั้งต้นให้ผู้มีอำนาจลงนามอนุมัติ' })).toHaveCount(0)
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'doa-initial-sent')
})
