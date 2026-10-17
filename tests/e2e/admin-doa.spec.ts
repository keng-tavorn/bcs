import AxeBuilder from '@axe-core/playwright'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { type Locator, type Page, type TestInfo } from '@playwright/test'
import { deriveSeedTotpSecret, totp } from '../../src/lib/totp'
import { e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'
import { settled } from './settled'

// S2-13: the DOA pages of ORG_ADMIN — every version with its status and effective period, a published version that has
// no edit control (FR-DOA-001 AC3), importing a version from YAML and downloading it in the same shape (AC2), and
// sending a draft with its lint errors shown by code and band and each warning ticked on its own (FR-DOA-002 AC1).
// Each project imports its own version numbers so desktop and mobile never collide in the shared e2e database. A
// version a test sends for approval is rejected by the CEO at the end of the test (tests/e2e/admin-org-cleanup.ts), so
// no task of ours waits in the CEO's list for the specs that run later.
// Screenshots at 375 px and 1440 px go to the test output (§9.9 step 4); axe runs on every page state.

const FIXTURE = readFileSync(path.resolve(import.meta.dirname, '../golden/fixtures/doa-versions.yaml'), 'utf8')
/** Version 2 of the §7.4 fixture (DM band up to 30,000) under its own number, starting in mid-2027 */
const version2 = (versionNo: number, edit: (text: string) => string = (t) => t) =>
  edit(`versions:\n${FIXTURE.slice(FIXTURE.indexOf('  - code: DOA-DEMO\n    version: 2')).replace('version: 2', `version: ${versionNo}`).replace('"2026-11-01T00:00:00+07:00"', '"2027-06-01T00:00:00+07:00"')}`)

async function expectNoBlockingAxe(page: Page) {
  // Next streams the <title> after the first HTML: let it arrive before axe reads the page (a page without one still fails)
  await page.waitForFunction(() => document.title !== '', undefined, { timeout: 5_000 }).catch(() => undefined)
  await settled(page)
  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(blocking.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)).toEqual([])
}

async function shot(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })
}

async function expectNoSideways(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
}

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

/** The CEO rejects, with a step-up, the DOA versions this test sent with these reasons */
function rejectSent(...reasons: string[]) {
  const arg = Buffer.from(JSON.stringify(reasons), 'utf8').toString('base64')
  const r = spawnSync(`pnpm exec tsx tests/e2e/admin-org-cleanup.ts ${arg}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`cleanup failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as { rejected: string[] }
}

const success = (scope: Page | Locator, text: string | RegExp) => scope.getByRole('status').filter({ hasText: text })
const failure = (scope: Page | Locator, text: string | RegExp) => scope.getByRole('alert').filter({ hasText: text })

/** Imports a YAML text through the form, with a reason */
async function importYaml(page: Page, testInfo: TestInfo, fileName: string, yaml: string, reason: string) {
  const file = testInfo.outputPath(fileName)
  writeFileSync(file, yaml, 'utf8')
  await page.getByLabel('ไฟล์ YAML').setInputFiles(file)
  await page.getByLabel('เหตุผลการเปลี่ยน', { exact: true }).fill(reason)
  await page.getByRole('button', { name: 'นำเข้าเป็นฉบับร่าง' }).click()
}

test('[FR-DOA-001/AC3] every version shows its status and effective period; a published version has no edit or send', async ({ page }, testInfo) => {
  await signInOrgAdmin(page, testInfo)
  await page.goto('/admin/doa')
  await expect(page.getByRole('heading', { level: 1, name: 'อำนาจอนุมัติ (DOA)' })).toBeVisible()
  // Exactly version 1 (other runs add versions 11, 12, … whose names start the same)
  const v1 = page.getByRole('region', { name: /ทุกฉบับ/ }).getByRole('listitem').filter({ has: page.getByText('DOA-DEMO ฉบับ 1', { exact: true }) })
  await expect(v1).toContainText('มีผลอยู่')
  await expect(v1).toContainText('มีผลตั้งแต่ 1 ม.ค. 2569 00:00 น. จนกว่าจะมีฉบับใหม่')
  await expect(v1).toContainText('8 ข้อ')
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'doa-versions')

  await v1.getByRole('link', { name: 'ดูรายละเอียด DOA-DEMO ฉบับ 1' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'DOA-DEMO ฉบับ 1' })).toBeVisible()
  await expect(page.getByText('ฉบับที่ส่งแล้วหรือเผยแพร่แล้วแก้ไม่ได้ ถ้าต้องการเปลี่ยน ให้แก้เป็นฉบับร่างใหม่จากฉบับนี้ หรือนำเข้าฉบับใหม่ แล้วส่งขออนุมัติ')).toBeVisible()
  await expect(page.getByRole('button', { name: 'ส่งขออนุมัติเผยแพร่' })).toHaveCount(0)
  // Nothing on the page edits it: the way to change it is a new draft, from a copy (S3-09) or an import
  await expect(page.getByRole('textbox')).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'แก้เป็นฉบับร่างใหม่จากฉบับนี้' })).toHaveAttribute('href', /\/admin\/doa\/[0-9a-f-]+\/edit$/)
  await expect(page.getByText('นี่คือฉบับแรกของ DOA-DEMO จึงไม่มีฉบับก่อนหน้าให้เทียบ')).toBeVisible()
  const pr02 = page.getByRole('region', { name: /ข้อของฉบับนี้/ }).getByRole('listitem').filter({ hasText: 'PR-02' })
  await expect(pr02).toContainText('20,000.00')
  await expect(pr02).toContainText('100,000.00')
  await expect(pr02).toContainText('รองประธานสายงาน (VP) ของแผนกที่ตั้งเบิก')
  await expect(pr02).toContainText('8 ชั่วโมงทำการ')
  await expect(page.getByRole('region', { name: 'นโยบายของฉบับ' })).toContainText('รวม VAT')
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'doa-version-published')
})

test('[FR-DOA-001/AC2] a version imported from YAML shows its diff with the version in effect and downloads in the same shape', async ({ page }, testInfo) => {
  const versionNo = testInfo.project.name === 'mobile' ? 22 : 12
  const name = `DOA-DEMO ฉบับ ${versionNo}`
  await signInOrgAdmin(page, testInfo)
  await page.goto('/admin/doa')

  // A file with problems imports nothing and says where and what to fix
  await importYaml(page, testInfo, 'doa-bad.yaml', version2(versionNo, (t) => t.replace('lte: "30000.00"', 'lte: "30000"')), 'ไฟล์ที่ผิดรูปแบบ')
  const problems = failure(page, 'ยังไม่ได้นำเข้า แก้ไฟล์ตามรายการนี้แล้วนำเข้าอีกครั้ง')
  await expect(problems).toContainText('ฉบับที่ 1 ในไฟล์ ข้อที่ 1 · when.amount.lte · ใส่ยอดเป็นบาทพร้อมทศนิยม 2 ตำแหน่งในเครื่องหมายคำพูด')
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'doa-import-problems')

  // The DM band of the fixture's version 2 and a rule that names a person (a warning to tick before sending)
  const yaml = version2(versionNo, (t) => t.replace('approver: { kind: POSITION_OF_DEPARTMENT, position: DM }, slaBusinessHours: 8 }\n      - { code: DOA-CHG-01', 'approver: { kind: MEMBER, member: dm_con }, slaBusinessHours: 8 }\n      - { code: DOA-CHG-01'))
  expect(yaml).toContain('member: dm_con')
  await importYaml(page, testInfo, 'doa-draft.yaml', yaml, 'ขยายวงเงิน DM เป็น 30,000 บาท')
  await expect(success(page, `นำเข้า ${name} เป็นฉบับร่างแล้ว`)).toBeVisible()
  await expect(page.getByRole('region', { name: /ทุกฉบับ/ }).getByRole('listitem').filter({ hasText: name })).toContainText('ฉบับร่าง')
  // The same edition again is refused: an edition never changes
  await importYaml(page, testInfo, 'doa-again.yaml', yaml, 'นำเข้าซ้ำ')
  await expect(failure(page, `DOA-DEMO ฉบับ ${versionNo} มีอยู่แล้ว ฉบับที่มีอยู่แก้ไม่ได้`)).toBeVisible()

  await page.getByRole('link', { name: `ดูรายละเอียด ${name}` }).click()
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
  await expect(page.getByText('ขยายวงเงิน DM เป็น 30,000 บาท')).toBeVisible()
  const diff = page.getByRole('region', { name: 'เปลี่ยนจาก DOA-DEMO ฉบับ 1' })
  await expect(diff.getByRole('listitem').filter({ hasText: 'แก้ข้อ PR-01' })).toContainText('ช่วงวงเงิน: เดิม ไม่เกิน 20,000.00 บาท · ใหม่ ไม่เกิน 30,000.00 บาท')
  await expect(diff.getByRole('listitem').filter({ hasText: 'แก้ข้อ GRV-01' })).toContainText('ผู้อนุมัติ: เดิม ผู้จัดการฝ่าย (DM) ของแผนกที่ตั้งเบิก · ใหม่ ดำรง ก่อสร้างไทย (ระบุตัวบุคคล)')
  const boundaries = page.getByRole('region', { name: 'ตารางผลที่ขอบของช่วงวงเงิน' })
  await expect(boundaries.getByRole('listitem').filter({ hasText: '30,000.00 บาท' })).toContainText('ใช้ข้อ PR-01')
  await expect(boundaries.getByRole('listitem').filter({ hasText: '30,000.01 บาท' })).toContainText('ใช้ข้อ PR-02')
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'doa-version-draft')

  // Download it: the same shape as the imported file, member written with the member code
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: `ดาวน์โหลดไฟล์ YAML ของ ${name}` }).click()])
  expect(download.suggestedFilename()).toBe(`DOA-DEMO-v${versionNo}.yaml`)
  const exported = readFileSync(await download.path(), 'utf8')
  expect(exported).toContain(`version: ${versionNo}`)
  expect(exported).toContain('effectiveFrom: 2027-06-01T00:00:00+07:00')
  expect(exported).toContain('lte: "30000.00"')
  expect(exported).toContain('member: dm_con')
})

test('[FR-DOA-002/AC1] a draft shows lint errors by code and band; each warning is ticked on its own before sending', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile'
  const [gapNo, warnNo] = mobile ? [21, 23] : [11, 13]
  await signInOrgAdmin(page, testInfo)
  await page.goto('/admin/doa')

  // A gap between two bands: shown with its code and band, and the draft has no send
  await importYaml(page, testInfo, 'doa-gap.yaml', version2(gapNo, (t) => t.replace('when: { amount: { gt: "30000.00", lte: "100000.00" } }', 'when: { amount: { gt: "40000.00", lte: "100000.00" } }')), 'ช่วงวงเงินที่ขาดหาย')
  await expect(success(page, `นำเข้า DOA-DEMO ฉบับ ${gapNo} เป็นฉบับร่างแล้ว`)).toBeVisible()
  await page.getByRole('link', { name: `เปิด DOA-DEMO ฉบับ ${gapNo} เพื่อตรวจและส่งขออนุมัติ` }).click()
  await expect(page.getByRole('heading', { level: 1, name: `DOA-DEMO ฉบับ ${gapNo}` })).toBeVisible()
  const errors = page.getByRole('alert').filter({ hasText: 'ฉบับนี้ยังไม่ผ่านการตรวจ ส่งไม่ได้' })
  await expect(errors).toContainText('คำขอซื้อ (PR): ยอดมากกว่า 30,000.00 ถึงไม่เกิน 40,000.00 บาท ไม่มีข้อใดครอบคลุม (รหัส DOA_LINT_GAP)')
  await expect(page.getByRole('button', { name: 'ส่งขออนุมัติเผยแพร่' })).toHaveCount(0)
  // Phones: a draft that cannot be sent says why with its status, before the content (S3-09 moved the send after it)
  if (mobile) {
    const alertBox = (await errors.boundingBox())!
    const diffBox = (await page.getByRole('region', { name: /เปลี่ยนจาก DOA-DEMO ฉบับ 1/ }).boundingBox())!
    expect(alertBox.y).toBeLessThan(diffBox.y)
  }
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'doa-lint-errors')

  // A rule naming a person: the warning is ticked on its own, then the draft goes to the CEO
  await page.goto('/admin/doa')
  const yaml = version2(warnNo, (t) => t.replace('approver: { kind: POSITION_OF_DEPARTMENT, position: DM }, slaBusinessHours: 8 }\n      - { code: DOA-CHG-01', 'approver: { kind: MEMBER, member: dm_con }, slaBusinessHours: 8 }\n      - { code: DOA-CHG-01'))
  const reason = `ผู้อนุมัติผลต่างการตรวจรับระบุตัวบุคคล (ฉบับ ${warnNo})`
  await importYaml(page, testInfo, 'doa-warning.yaml', yaml, reason)
  await page.getByRole('link', { name: `เปิด DOA-DEMO ฉบับ ${warnNo} เพื่อตรวจและส่งขออนุมัติ` }).click()
  const send = page.getByRole('region', { name: 'ส่งขออนุมัติเผยแพร่' })
  await expect(send).toContainText('ฉบับนี้จะส่งให้ ศักดิ์ชัย ผู้นำ อนุมัติตาม DOA-DEMO ฉบับ 1 ข้อ DOA-CHG-01')
  const warning = send.getByRole('checkbox', { name: 'ข้อ GRV-01 ระบุผู้อนุมัติเป็นตัวบุคคล ถ้าคนนี้ย้ายหรือลาออก ต้องออก DOA ฉบับใหม่' })
  await expect(warning).not.toBeChecked()
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'doa-submit-warnings')
  await send.getByRole('button', { name: 'ส่งขออนุมัติเผยแพร่' }).click()
  await expect(failure(send, 'ติ๊กยืนยันคำเตือนทุกข้อก่อนส่ง')).toBeVisible()
  await warning.check()
  // FR-DOA-009 AC3: the boundary table is ticked as checked too
  await send.getByRole('button', { name: 'ส่งขออนุมัติเผยแพร่' }).click()
  await expect(send.getByText('ติ๊กยืนยันว่าตรวจตารางผลที่ขอบแล้วก่อนส่ง')).toBeVisible()
  await send.getByRole('checkbox', { name: 'ฉันตรวจตารางผลที่ขอบแล้ว ทุกยอดที่ขอบของช่วงไปหาผู้อนุมัติตามที่ตั้งใจ' }).check()
  await send.getByRole('button', { name: 'ส่งขออนุมัติเผยแพร่' }).click()
  await expect(success(page, 'ส่งขออนุมัติเผยแพร่แล้ว รอ ศักดิ์ชัย ผู้นำ อนุมัติ').first()).toBeVisible()
  await page.reload()
  await expect(success(page, 'ส่งขออนุมัติเผยแพร่แล้ว รอ ศักดิ์ชัย ผู้นำ อนุมัติ')).toBeVisible()
  await expect(page.getByText('รออนุมัติ', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('region', { name: 'การอนุมัติ' })).toContainText('รอ ศักดิ์ชัย ผู้นำ อนุมัติ ตาม DOA-DEMO ฉบับ 1 ข้อ DOA-CHG-01')
  await expect(page.getByRole('button', { name: 'ส่งขออนุมัติเผยแพร่' })).toHaveCount(0)
  await shot(page, testInfo, 'doa-version-pending')
  expect(rejectSent(reason).rejected).toHaveLength(1)
})

test('[FR-DOA-001/AC3] members without admin.doa.draft get no versions and no download', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('อีเมลบริษัท').fill('req_con@demo.bcs.local')
  await page.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('สวัสดี')
  await page.goto('/admin/doa')
  await expect(page.getByRole('alert').filter({ hasText: 'หน้านี้สำหรับผู้ดูแลองค์กร' })).toBeVisible()
  await expect(page.getByRole('link', { name: /ดาวน์โหลด/ })).toHaveCount(0)
})
