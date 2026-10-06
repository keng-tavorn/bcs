import AxeBuilder from '@axe-core/playwright'
import { spawnSync } from 'node:child_process'
import { type Locator, type Page, type TestInfo } from '@playwright/test'
import { deriveSeedTotpSecret, totp } from '../../src/lib/totp'
import { e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'

// S2-13: the organization structure (FR-ADM-002) and the authority changes (FR-DOA-010 AC1) as ORG_ADMIN sees them.
// Each project changes its own records (codes and positions per project) so desktop and mobile never collide in the
// shared e2e database. Screenshots at 375 px and 1440 px go to the test output (§9.9 step 4); axe runs on every page
// state. The pages are opened by address: their menu entries are turned on in menu.ts, outside this unit.
// A proposal a test sends waits for the CEO; at the end of the test the CEO rejects it (tests/e2e/admin-org-cleanup.ts),
// so the specs that run later in the same database find no task of ours in the CEO's list.

async function expectNoBlockingAxe(page: Page) {
  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(blocking.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)).toEqual([])
}

async function shot(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })
}

/** No horizontal scroll on phones (§9.9): the page is never wider than the screen */
async function expectNoSideways(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
}

/** The organization admin of this project (two seeded admins, one per viewport, so TOTP codes never repeat) */
async function signInOrgAdmin(page: Page, testInfo: TestInfo) {
  const code = testInfo.project.name === 'mobile' ? 'admin2' : 'admin'
  await page.goto('/login')
  await page.getByLabel('อีเมลบริษัท').fill(`${code}@demo.bcs.local`)
  await page.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
  await expect(page).toHaveURL(/\/login\/2fa$/)
  await page.getByLabel('รหัส 6 หลักจากแอป').fill(totp(deriveSeedTotpSecret(process.env.SEED_TOTP_KEY!, code)))
  await page.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('สวัสดี')
}

const success = (scope: Page | Locator, text: string | RegExp) => scope.getByRole('status').filter({ hasText: text })
const failure = (scope: Page | Locator, text: string | RegExp) => scope.getByRole('alert').filter({ hasText: text })

/** Chooses the option whose text contains `text` (department options are indented by their depth in the tree) */
async function choose(select: Locator, text: string) {
  const value = await select.locator('option', { hasText: text }).first().getAttribute('value')
  expect(value, text).toBeTruthy()
  await select.selectOption(value!)
}

/** A date and time `days` from now in Thai time, as a datetime-local input takes it */
function daysAhead(days: number, hour: number): string {
  const at = new Date(Date.now() + days * 24 * 60 * 60 * 1000 + 7 * 60 * 60 * 1000)
  return `${at.toISOString().slice(0, 10)}T${String(hour).padStart(2, '0')}:00`
}
const monthAhead = (hour: number) => daysAhead(30, hour)

/** The CEO rejects, with a step-up, the proposals and DOA versions this test sent with these reasons */
function rejectSent(...reasons: string[]) {
  const arg = Buffer.from(JSON.stringify(reasons), 'utf8').toString('base64')
  const r = spawnSync(`pnpm exec tsx tests/e2e/admin-org-cleanup.ts ${arg}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`cleanup failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as { rejected: string[] }
}

test('[FR-ADM-002/AC1] an organization admin adds and renames a department, and adds, switches off and on a cost center', async ({ page }, testInfo) => {
  const project = testInfo.project.name
  const code = project === 'mobile' ? 'E2E-ORG-M' : 'E2E-ORG-D'
  const name = `ฝ่ายทดสอบ ${project}`
  await signInOrgAdmin(page, testInfo)
  await page.goto('/admin/org')
  await expect(page.getByRole('heading', { level: 1, name: 'ผังองค์กร' })).toBeVisible()
  const sections = page.getByRole('navigation', { name: 'ส่วนของผังองค์กร' })
  await expect(sections.getByRole('link', { name: 'แผนก', exact: true })).toHaveAttribute('aria-current', 'page')
  const tree = page.getByRole('region', { name: /ผังแผนก/ })
  await expect(tree.getByRole('listitem').filter({ hasText: 'สำนักงานใหญ่' }).first()).toContainText('แผนกราก')
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'org-departments')

  // Nothing filled in: the form says what is missing, at the field
  await page.getByRole('button', { name: 'เพิ่มแผนก', exact: true }).click()
  await expect(page.getByText('ใส่รหัสเป็นตัวอักษรอังกฤษ ตัวเลข ขีด หรือขีดล่าง ไม่เกิน 40 ตัว')).toBeVisible()
  await expect(page.getByText('เลือกแผนกที่จะอยู่ใต้')).toBeVisible()
  await page.getByLabel('รหัสแผนก').fill(code.toLowerCase())
  await page.getByLabel('ชื่อแผนก (ไทย)').fill(name)
  await choose(page.getByLabel('อยู่ใต้แผนก'), 'สายปฏิบัติการ (OPS)')
  await page.getByRole('button', { name: 'เพิ่มแผนก', exact: true }).click()
  await expect(success(page, `เพิ่มแผนก ${code} แล้ว`)).toBeVisible()
  const row = tree.getByRole('listitem').filter({ hasText: code })
  await expect(row).toContainText(name)
  await expect(row).toContainText('ฝ่าย · ศูนย์ต้นทุน 0 แห่ง')

  // Rename in place
  await row.getByRole('button', { name: `แก้ชื่อ ${name}` }).click()
  await row.getByLabel('ชื่อแผนก (ไทย)').fill(`${name} ใหม่`)
  await row.getByRole('button', { name: 'บันทึกชื่อใหม่' }).click()
  await expect(success(row, `บันทึกชื่อใหม่ของ ${code} แล้ว`)).toBeVisible()
  await expect(row).toContainText(`${name} ใหม่`)
  // A move is proposed for approval, never made here
  await expect(row.getByRole('link', { name: `เสนอย้ายไปอยู่ใต้แผนกอื่น ${name} ใหม่` })).toHaveAttribute('href', /kind=DEPARTMENT_REPARENT/)

  // Cost centers of the new department
  await sections.getByRole('link', { name: 'ศูนย์ต้นทุน', exact: true }).click()
  await expect(page.getByRole('heading', { level: 2, name: /ศูนย์ต้นทุนทั้งหมด/ })).toBeVisible()
  const ccCode = `CC-${code}`
  await page.getByLabel('รหัสศูนย์ต้นทุน').fill(ccCode)
  await page.getByLabel('ชื่อศูนย์ต้นทุน').fill(`ศูนย์ต้นทุน ${name}`)
  await choose(page.getByLabel('แผนกเจ้าของ'), `${name} ใหม่ (${code})`)
  await page.getByRole('button', { name: 'เพิ่มศูนย์ต้นทุน', exact: true }).click()
  await expect(success(page, `เพิ่มศูนย์ต้นทุน ${ccCode} แล้ว`)).toBeVisible()
  const cc = page.getByRole('listitem').filter({ hasText: ccCode })
  await expect(cc).toContainText('ใช้งานอยู่')
  await expect(cc).toContainText(`แผนก ${name} ใหม่`)
  await cc.getByRole('button', { name: `ปิดใช้งาน ${ccCode}` }).click()
  await expect(success(cc, `ปิดใช้งาน ${ccCode} แล้ว`)).toBeVisible()
  await expect(cc).toContainText('ปิดใช้งานแล้ว')
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'org-cost-centers')
  await cc.getByRole('button', { name: `เปิดใช้งาน ${ccCode} อีกครั้ง` }).click()
  await expect(success(cc, `เปิดใช้งาน ${ccCode} อีกครั้งแล้ว`)).toBeVisible()
  // The same code twice is refused at the field
  await page.getByLabel('รหัสศูนย์ต้นทุน').fill(ccCode)
  await page.getByLabel('ชื่อศูนย์ต้นทุน').fill('ซ้ำ')
  await choose(page.getByLabel('แผนกเจ้าของ'), `${name} ใหม่ (${code})`)
  await page.getByRole('button', { name: 'เพิ่มศูนย์ต้นทุน', exact: true }).click()
  await expect(page.getByText('รหัสนี้มีอยู่แล้ว ใช้รหัสอื่น')).toBeVisible()
})

test('[FR-ADM-002/AC2] a position no DOA names changes holders at once; a position the DOA names links to a proposal', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile'
  const [holder, holderCode] = mobile ? ['สมหญิง รักงาน', 'asst_con'] : ['พิมพ์ใจ จัดหา', 'proc_officer']
  await signInOrgAdmin(page, testInfo)
  await page.goto('/admin/org/positions')
  await expect(page.getByRole('heading', { level: 1, name: 'ผังองค์กร' })).toBeVisible()
  const dm = page.getByRole('region', { name: 'ผู้จัดการฝ่าย · DM' })
  await expect(dm).toContainText('DOA อ้างถึงตำแหน่งนี้ เปลี่ยนผู้ดำรงได้เมื่อผู้มีอำนาจอนุมัติแล้วเท่านั้น')
  await expect(dm.getByRole('link', { name: 'เสนอแต่งตั้งคนใหม่แทน ดำรง ก่อสร้างไทย' })).toHaveAttribute('href', /kind=POSITION_ASSIGN&position=DM&department=/)
  await expect(dm.getByRole('button')).toHaveCount(0)
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'org-positions')

  const procMgr = page.getByRole('region', { name: 'ผู้จัดการจัดซื้อ · PROC_MGR' })
  await expect(procMgr).toContainText('DOA ไม่ได้อ้างถึงตำแหน่งนี้ กำหนดหรือสิ้นสุดผู้ดำรงได้ทันที')
  await choose(procMgr.getByLabel('ผู้ดำรงตำแหน่ง', { exact: true }), `${holder} (${holderCode})`)
  await procMgr.getByRole('button', { name: 'กำหนดผู้ดำรงตำแหน่ง', exact: true }).click()
  await expect(success(procMgr, `กำหนดให้ ${holder} ดำรงตำแหน่ง ผู้จัดการจัดซื้อ แล้ว`)).toBeVisible()
  const held = procMgr.getByRole('listitem').filter({ hasText: holder })
  await expect(held).toContainText('สำนักงานใหญ่')

  // Ending a term takes effect at once, so it asks once more and says so
  await held.getByRole('button', { name: `สิ้นสุดตำแหน่งของ ${holder}` }).click()
  await expect(held).toContainText(`${holder} จะสิ้นสุดตำแหน่งนี้ทันที`)
  await expectNoBlockingAxe(page)
  await held.getByRole('button', { name: `ยืนยันสิ้นสุดตำแหน่งของ ${holder}` }).click()
  await expect(success(procMgr, `สิ้นสุดตำแหน่งของ ${holder} แล้ว`)).toBeVisible()
  await expect(procMgr).toContainText('ยังไม่มีผู้ดำรงตำแหน่งนี้')
  // Leave the demo as it was seeded: the procurement manager is ปรีชา จัดซื้อ again
  await choose(procMgr.getByLabel('ผู้ดำรงตำแหน่ง', { exact: true }), 'ปรีชา จัดซื้อ (dm_proc)')
  await procMgr.getByRole('button', { name: 'กำหนดผู้ดำรงตำแหน่ง', exact: true }).click()
  await expect(success(procMgr, 'กำหนดให้ ปรีชา จัดซื้อ ดำรงตำแหน่ง ผู้จัดการจัดซื้อ แล้ว')).toBeVisible()
})

test('[FR-DOA-010/AC1] a proposal shows who gains and loses authority, the open tasks that move, and asks to tick each vacancy warning', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile'
  await signInOrgAdmin(page, testInfo)
  await page.goto('/admin/org-authority/new')
  await expect(page.getByRole('heading', { level: 1, name: 'เสนอการเปลี่ยนโครงสร้างอำนาจ' })).toBeVisible()
  for (const kind of ['แต่งตั้งผู้ดำรงตำแหน่ง', 'สิ้นสุดการดำรงตำแหน่ง', 'ย้ายแผนก', 'ตั้งรักษาการแทนผู้อื่น', 'รีเซ็ตตัวตนของผู้มีอำนาจ']) {
    await expect(page.getByRole('link', { name: kind, exact: true })).toBeVisible()
  }
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'org-authority-kinds')

  let summary: string
  let reason: string
  if (!mobile) {
    // Desktop: from the positions page, a new VP of SUP instead of the current one
    await page.goto('/admin/org/positions')
    await page.getByRole('region', { name: 'รองประธานสายงาน · VP' }).getByRole('link', { name: 'เสนอแต่งตั้งคนใหม่แทน วิไล สนับสนุน' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'เสนอการเปลี่ยน: แต่งตั้งผู้ดำรงตำแหน่ง' })).toBeVisible()
    await expect(page.getByText('ผู้ดำรงปัจจุบัน: วิไล สนับสนุน')).toBeVisible()
    await choose(page.getByLabel('ผู้ดำรงตำแหน่งคนใหม่', { exact: true }), 'ธนา การเงิน (dm_fin)')
    await page.getByLabel('กำหนดวันและเวลา (เวลาไทย)').check()
    await page.getByLabel('วันและเวลามีผล').fill(monthAhead(9))
    reason = 'แต่งตั้ง VP สายสนับสนุนคนใหม่ตามคำสั่งบริษัท'
    await page.getByLabel('เหตุผล (บันทึกในประวัติและแสดงต่อผู้อนุมัติ)').fill(reason)
    summary = 'ธนา การเงิน ดำรงตำแหน่ง รองประธานสายงาน (VP) ของ สายสนับสนุน'
  } else {
    // Phone: end the DM of IT without a replacement; the empty form first says what is missing
    await page.getByRole('link', { name: 'สิ้นสุดการดำรงตำแหน่ง', exact: true }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'เสนอการเปลี่ยน: สิ้นสุดการดำรงตำแหน่ง' })).toBeVisible()
    await page.getByRole('button', { name: 'ดูผลกระทบก่อนส่ง' }).click()
    await expect(page.getByText('เลือกตำแหน่ง', { exact: true })).toBeVisible()
    await expect(page.getByText('ใส่เหตุผลอย่างน้อย 3 ตัวอักษร')).toBeVisible()
    await choose(page.getByLabel('ตำแหน่ง', { exact: true }), 'ผู้จัดการฝ่าย (DM)')
    await choose(page.getByLabel('แผนก', { exact: true }), 'ฝ่ายไอที (IT)')
    await expect(page.getByText('ผู้ดำรงปัจจุบัน: ไอศูรย์ ระบบดี')).toBeVisible()
    await page.getByLabel('กำหนดวันและเวลา (เวลาไทย)').check()
    await page.getByLabel('วันและเวลามีผล').fill(monthAhead(10))
    // The chosen time is said back in Thai dates (the browser's picker shows its own calendar)
    await expect(page.getByText(/^เวลาที่เลือก: \d{1,2} \S+ 25\d\d 10:00 น\. \(เวลาไทย\)$/)).toBeVisible()
    reason = 'ผู้จัดการฝ่ายไอทีลาออก'
    await page.getByLabel('เหตุผล (บันทึกในประวัติและแสดงต่อผู้อนุมัติ)').fill(reason)
    summary = 'สิ้นสุดผู้ดำรงตำแหน่ง ผู้จัดการฝ่าย (DM) ของ ฝ่ายไอที โดยไม่มีผู้แทน'
  }
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'org-authority-details')
  await page.getByRole('button', { name: 'ดูผลกระทบก่อนส่ง' }).click()

  // Step 3: what changes, the impact, who approves, and the warnings to tick one by one
  await expect(page.getByRole('heading', { level: 2, name: 'ตรวจผลกระทบก่อนส่ง' })).toBeVisible()
  await expect(page.getByText(summary)).toBeVisible()
  const impact = page.getByRole('region', { name: 'ผลกระทบ' })
  const [gains, loses, tasks] = [impact.locator('dd').nth(0), impact.locator('dd').nth(1), impact.locator('dd').nth(2)]
  await expect(page.getByRole('region', { name: 'ผู้อนุมัติ' })).toContainText('ส่งให้ ศักดิ์ชัย ผู้นำ อนุมัติตาม DOA-DEMO ฉบับ 1 ข้อ ORG-CHG-01')
  if (!mobile) {
    await expect(gains).toHaveText('ธนา การเงิน')
    await expect(loses).toHaveText('วิไล สนับสนุน')
    await expect(tasks).toHaveText(/^\d+ งานจะย้ายไปผู้ดำรงคนใหม่เมื่อการเปลี่ยนมีผล$/)
    await expect(page.getByRole('checkbox')).toHaveCount(0)
  } else {
    await expect(gains).toHaveText('ไม่มี')
    await expect(loses).toHaveText('ไอศูรย์ ระบบดี')
    // With nobody new, pending tasks of the slot stay with the former holder; they never "move"
    await expect(tasks).toHaveText(/^(\d+ งานจะยังอยู่กับ ไอศูรย์ ระบบดี เพราะไม่มีผู้ดำรงคนใหม่ ผู้ดูแลองค์กรจะได้รับแจ้งเมื่อการเปลี่ยนมีผล|ไม่มีงานค้างที่ต้องย้าย)$/)
  }
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'org-authority-review')
  if (mobile) {
    const warning = page.getByRole('checkbox', { name: /ตำแหน่ง ผู้จัดการฝ่าย \(DM\) ของ ฝ่ายไอที จะว่างเมื่อการเปลี่ยนมีผล/ })
    await page.getByRole('button', { name: 'ส่งขออนุมัติ', exact: true }).click()
    await expect(failure(page, 'ติ๊กยืนยันคำเตือนทุกข้อก่อนส่ง')).toBeVisible()
    await warning.check()
  }
  await page.getByRole('button', { name: 'ส่งขออนุมัติ', exact: true }).click()
  await expect(success(page, 'ส่งขออนุมัติแล้ว รอ ศักดิ์ชัย ผู้นำ อนุมัติ')).toBeVisible()

  // The list shows it waiting for the CEO, with its route and impact
  await page.getByRole('link', { name: 'ดูรายการการเปลี่ยนโครงสร้างอำนาจ' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'เปลี่ยนโครงสร้างอำนาจ' })).toBeVisible()
  const item = page.getByRole('region', { name: /กำลังดำเนินการ/ }).getByRole('listitem').filter({ hasText: summary })
  await expect(item).toContainText('รออนุมัติ')
  await expect(item).toContainText('รอ ศักดิ์ชัย ผู้นำ อนุมัติ ตาม DOA-DEMO ฉบับ 1 ข้อ ORG-CHG-01')
  await expect(item).toContainText(mobile ? 'เสียอำนาจ: ไอศูรย์ ระบบดี' : 'ได้อำนาจ: ธนา การเงิน')
  // No label above the sentence: the sentence says what changes
  await expect(item.getByText(mobile ? 'สิ้นสุดการดำรงตำแหน่ง' : 'แต่งตั้งผู้ดำรงตำแหน่ง', { exact: true })).toHaveCount(0)
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'org-authority-list')
  expect(rejectSent(reason).rejected).toHaveLength(1)
})

test('[FR-DOA-010/AC1] moving a department, acting for someone and resetting an identity each show their impact before sending', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile'
  await signInOrgAdmin(page, testInfo)

  // A department move: nobody gains or loses a position, and it takes effect when approved
  await page.goto('/admin/org-authority/new?kind=DEPARTMENT_REPARENT')
  await expect(page.getByRole('heading', { level: 1, name: 'เสนอการเปลี่ยน: ย้ายแผนก' })).toBeVisible()
  const [moving, movingCode] = mobile ? ['ฝ่ายบัญชีและการเงิน', 'FIN'] : ['ฝ่ายไอที', 'IT']
  await choose(page.getByLabel('แผนกที่จะย้าย'), `${moving} (${movingCode})`)
  await choose(page.getByLabel('ย้ายไปอยู่ใต้แผนก'), 'สายปฏิบัติการ (OPS)')
  await page.getByLabel('เหตุผล (บันทึกในประวัติและแสดงต่อผู้อนุมัติ)').fill('รวมงานสนับสนุนเข้าสายปฏิบัติการ')
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'org-authority-reparent-details')
  await page.getByRole('button', { name: 'ดูผลกระทบก่อนส่ง' }).click()
  await expect(page.getByRole('heading', { level: 2, name: 'ตรวจผลกระทบก่อนส่ง' })).toBeVisible()
  await expect(page.getByText(`ย้าย ${moving} ไปอยู่ใต้ สายปฏิบัติการ`)).toBeVisible()
  await expect(page.getByText('มีผลทันทีเมื่อผู้มีอำนาจอนุมัติ')).toBeVisible()
  const reparentImpact = page.getByRole('region', { name: 'ผลกระทบ' })
  await expect(reparentImpact.locator('dd').nth(2)).toHaveText('ไม่มีงานค้างที่ต้องย้าย')
  await expect(page.getByRole('region', { name: 'ผู้อนุมัติ' })).toContainText('ส่งให้ ศักดิ์ชัย ผู้นำ อนุมัติตาม DOA-DEMO ฉบับ 1 ข้อ ORG-CHG-01')
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'org-authority-reparent-review')

  // Acting for someone: Thai times said back in Thai dates, an amount with separators, sent through the form's action
  const [delegator, delegatorCode, delegate, delegateCode] = mobile ? ['ชัยวัฒน์ ปฏิบัติการใหญ่', 'coo', 'วีระ ปฏิบัติการ', 'vp_ops'] : ['วิไล สนับสนุน', 'vp_sup', 'ธนา การเงิน', 'dm_fin']
  await page.goto('/admin/org-authority/new?kind=DELEGATION_ON_BEHALF')
  await expect(page.getByRole('heading', { level: 1, name: 'เสนอการเปลี่ยน: ตั้งรักษาการแทนผู้อื่น' })).toBeVisible()
  await choose(page.getByLabel('ผู้มอบ (ผู้มีอำนาจที่ไม่อยู่)'), `${delegator} (${delegatorCode})`)
  await choose(page.getByLabel('ผู้รักษาการ'), `${delegate} (${delegateCode})`)
  await expect(page.getByText('เลือกวันและเวลาตามเวลาไทย')).toHaveCount(2)
  await page.getByLabel('เริ่มรักษาการ (เวลาไทย)').fill(daysAhead(mobile ? 45 : 40, 8))
  await page.getByLabel('สิ้นสุดรักษาการ (เวลาไทย)').fill(daysAhead(mobile ? 49 : 44, 17))
  await expect(page.getByText(/^เวลาที่เลือก: .+ 08:00 น\. \(เวลาไทย\)$/)).toBeVisible()
  await expect(page.getByText(/^เวลาที่เลือก: .+ 17:00 น\. \(เวลาไทย\)$/)).toBeVisible()
  await page.getByLabel('คำขอซื้อ (PR)').check()
  await page.getByLabel('วงเงินสูงสุดที่รักษาการได้ (บาท ไม่บังคับ)').fill('50,000')
  const delegationReason = mobile ? 'ประธานฝ่ายปฏิบัติการเดินทางต่างประเทศ' : 'รองประธานสายสนับสนุนลาพักร้อน'
  await page.getByLabel('เหตุผล (บันทึกในประวัติและแสดงต่อผู้อนุมัติ)').fill(delegationReason)
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'org-authority-delegation-details')
  await page.getByRole('button', { name: 'ดูผลกระทบก่อนส่ง' }).click()
  await expect(page.getByRole('heading', { level: 2, name: 'ตรวจผลกระทบก่อนส่ง' })).toBeVisible()
  const delegation = `${delegate} รักษาการแทน ${delegator} ตั้งแต่`
  await expect(page.getByText(delegation)).toContainText('คำขอซื้อ (PR) · วงเงินไม่เกิน 50,000.00 บาท')
  await expect(page.getByText('บันทึกรักษาการทันทีเมื่อผู้มีอำนาจอนุมัติ และเริ่มมีผลตามเวลาเริ่มรักษาการ')).toBeVisible()
  await expect(page.getByRole('region', { name: 'ผลกระทบ' }).locator('dd').nth(0)).toHaveText(delegate)
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'org-authority-delegation-review')
  await page.getByRole('button', { name: 'ส่งขออนุมัติ', exact: true }).click()
  await expect(success(page, 'ส่งขออนุมัติแล้ว รอ ศักดิ์ชัย ผู้นำ อนุมัติ')).toBeVisible()
  await page.getByRole('link', { name: 'ดูรายการการเปลี่ยนโครงสร้างอำนาจ' }).click()
  const sent = page.getByRole('region', { name: /กำลังดำเนินการ/ }).getByRole('listitem').filter({ hasText: delegation })
  await expect(sent).toContainText('รออนุมัติ')
  await expect(sent).toContainText('บันทึกเมื่อผู้มีอำนาจอนุมัติ และเริ่มรักษาการตามเวลาที่กำหนด')
  await expect(sent).toContainText(`ได้อำนาจ: ${delegate}`)
  // What the server stored from the form: the amount without its separators, the period in Thai time
  await expect(sent).toContainText('คำขอซื้อ (PR) · วงเงินไม่เกิน 50,000.00 บาท')
  await expect(sent).toContainText('08:00 น.')
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'org-authority-delegation-list')

  // An identity reset of an approver: applies as soon as it is approved, signs the member out everywhere
  await page.goto('/admin/org-authority/new?kind=IDENTITY_RESET')
  await expect(page.getByRole('heading', { level: 1, name: 'เสนอการเปลี่ยน: รีเซ็ตตัวตนของผู้มีอำนาจ' })).toBeVisible()
  const [member, memberCode] = mobile ? ['ปรีชา จัดซื้อ', 'dm_proc'] : ['ดำรง ก่อสร้างไทย', 'dm_con']
  await choose(page.getByLabel('สมาชิกที่ต้องรีเซ็ตการยืนยันตัวตนสองชั้น'), `${member} (${memberCode})`)
  await expect(page.getByText('รีเซ็ตทันทีเมื่อผู้มีอำนาจอนุมัติ')).toBeVisible()
  await page.getByLabel('เหตุผล (บันทึกในประวัติและแสดงต่อผู้อนุมัติ)').fill('ทำโทรศัพท์ที่ใช้ยืนยันตัวตนหาย')
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'org-authority-identity-details')
  await page.getByRole('button', { name: 'ดูผลกระทบก่อนส่ง' }).click()
  await expect(page.getByText(`รีเซ็ตการยืนยันตัวตนสองชั้นของ ${member}`)).toBeVisible()
  await expect(page.getByText('มีผลทันทีเมื่อผู้มีอำนาจอนุมัติ')).toBeVisible()
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'org-authority-identity-review')

  expect(rejectSent(delegationReason).rejected).toHaveLength(1)
})

test('[FR-ADM-002/AC1] members without admin.orgStructure.editBasic get no structure and no proposal form', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('อีเมลบริษัท').fill('req_con@demo.bcs.local')
  await page.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('สวัสดี')
  for (const path of ['/admin/org', '/admin/org/cost-centers', '/admin/org/positions', '/admin/org-authority', '/admin/org-authority/new']) {
    await page.goto(path)
    await expect(page.getByRole('alert').filter({ hasText: 'หน้านี้สำหรับผู้ดูแลองค์กร' })).toBeVisible()
    await expect(page.locator('main').getByRole('button')).toHaveCount(0)
  }
})
