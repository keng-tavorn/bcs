import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { type Page, type TestInfo } from '@playwright/test'
import { deriveSeedTotpSecret, totp } from '../../src/lib/totp'
import { E2E_BASE_URL, e2eEnv } from '../support/e2e-env'
import { expectNoBlockingAxe, expectNoSideways, shot, signIn } from './budgets-support'
import { expect, test } from './fixtures'
import { E2E_PLATFORM_ADMIN } from './platform-admin'

// S6-21 on screen (FR-PLT-101 AC1 AC2 · BR-UAT-01 to BR-UAT-04). AC2: an ORG_ADMIN of DEMO opens /admin/config from the
// admin hub, reads that an import makes drafts only, exports a WORKFLOW-only package (the file is saved and its checksum
// shown matches the file's), then imports the same file edited after the export and is refused under the file field
// (CONFIG_PACKAGE_INVALID · CHECKSUM), then a package of the scene (uat-config-scene.ts) whose rows do not resolve in
// DEMO and reads them with their reasons; nothing is imported either time. AC1: the BCS team opens DEMO's page, sees it
// is the live system, makes its UAT sandbox with a contract reference and a reason, opens the sandbox's page; a member
// of the sandbox then sees the trial-system banner on the workspace. Each run's sandbox code carries the project and a
// run id. Screenshots at 375 px and 1440 px go to the test output (§9.9 step 4); axe runs on every state (step 5).

function scene<T>(...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/uat-config-scene.ts ${args.map((a) => `"${a}"`).join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`UAT scene failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}

async function check(page: Page, testInfo: TestInfo, name: string) {
  await expectNoSideways(page)
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, name)
}

const BANNER = 'ระบบทดลอง (UAT) — ข้อมูลในระบบนี้ไม่ใช่ของจริง'

/** The BCS team signs in on the same page and lands on its list of customers */
async function signInPlatform(page: Page) {
  await page.goto('/login')
  await page.getByLabel('อีเมลบริษัท').fill(E2E_PLATFORM_ADMIN.email)
  await page.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
  await expect(page).toHaveURL(/\/login\/2fa$/)
  await page.getByLabel('รหัส 6 หลักจากแอป').fill(totp(deriveSeedTotpSecret(process.env.SEED_TOTP_KEY!, E2E_PLATFORM_ADMIN.code)))
  await page.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' }).click()
  await expect(page).toHaveURL(/\/platform\/tenants$/)
}

const runId = (testInfo: TestInfo) => `${testInfo.project.name.slice(0, 1)}${Date.now().toString(36)}`.toUpperCase()

test('[FR-PLT-101/AC2] an organization admin exports a workflow package; a package changed after its export, or whose rows do not fit, imports nothing and says why', async ({ page }, testInfo) => {
  test.slow()
  const code = testInfo.project.name === 'mobile' ? 'admin2' : 'admin'
  const before = scene<{ exports: number; imports: number }>('packages')
  await signIn(page, `${code}@demo.bcs.local`, code)

  // From the admin hub (§9.10 · the sidebar's "ผู้ดูแลองค์กร")
  await page.goto('/admin')
  await page.getByRole('navigation', { name: 'ผู้ดูแลองค์กร' }).getByRole('link', { name: 'ชุดค่าตั้ง' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'ชุดค่าตั้ง' })).toBeVisible()
  const exportCard = page.getByRole('region', { name: 'ส่งออกชุดค่าตั้ง' })
  const importCard = page.getByRole('region', { name: 'นำเข้าชุดค่าตั้งเป็นร่าง' })
  await expect(importCard.getByText('การนำเข้าสร้างเฉพาะร่าง')).toBeVisible()
  await check(page, testInfo, 'uat-config')

  // Export the workflow only: no section ticked is refused under the list, then the file is saved with its checksum
  for (const name of ['ฟอร์มของประเภทคำขอ', 'ผู้ตรวจคู่ขนาน (workflow)', 'อำนาจอนุมัติ (DOA)', 'แคตตาล็อกและราคาตกลง']) await exportCard.getByRole('checkbox', { name }).click()
  await exportCard.getByRole('button', { name: 'ส่งออกชุดค่าตั้ง', exact: true }).click()
  await expect(exportCard.getByText('เลือกอย่างน้อยหนึ่งส่วนที่จะส่งออก')).toBeVisible()
  await exportCard.getByRole('checkbox', { name: 'ผู้ตรวจคู่ขนาน (workflow)' }).click()
  const [download] = await Promise.all([page.waitForEvent('download'), exportCard.getByRole('button', { name: 'ส่งออกชุดค่าตั้ง', exact: true }).click()])
  expect(download.suggestedFilename()).toMatch(/^config-DEMO-\d{4}-\d{2}-\d{2}\.json$/)
  const exported = readFileSync(await download.path(), 'utf8')
  const pkg = JSON.parse(exported) as Record<string, unknown>
  expect(pkg).toMatchObject({ kind: 'BCS_CONFIG_PACKAGE', schemaVersion: 1, organizationCode: 'DEMO' })
  expect(Object.keys(pkg)).toContain('workflows')
  for (const absent of ['forms', 'doa', 'catalog']) expect(Object.keys(pkg)).not.toContain(absent)
  await expect(exportCard.getByRole('status').filter({ hasText: `ส่งออกชุดค่าตั้งแล้ว ไฟล์ ${download.suggestedFilename()}` })).toBeVisible()
  await expect(exportCard.getByText(`checksum (sha256): ${String(pkg.checksum)}`)).toBeVisible()
  await expect(exportCard.getByRole('link', { name: `ดาวน์โหลด ${download.suggestedFilename()} อีกครั้ง` })).toBeVisible()
  await check(page, testInfo, 'uat-config-exported')

  // The same file edited after the export: refused under the file field, nothing imported
  const tampered = testInfo.outputPath('tampered.json')
  writeFileSync(tampered, JSON.stringify({ ...pkg, organizationCode: 'DEMO-EDITED' }, null, 2))
  await importCard.locator('input[type="file"]').setInputFiles(tampered)
  await expect(importCard.getByText('tampered.json')).toBeVisible()
  await importCard.getByLabel('เหตุผลของการเปลี่ยน').fill('ทดสอบนำเข้าชุดค่าตั้งที่ถูกแก้')
  await importCard.getByRole('button', { name: 'นำเข้าเป็นร่าง', exact: true }).click()
  await expect(importCard.getByText('ชุดค่าตั้งถูกแก้หลังส่งออก (checksum ไม่ตรง) จึงไม่นำเข้า ส่งออกใหม่จากระบบทดลองโดยไม่แก้ไฟล์')).toBeVisible()
  await check(page, testInfo, 'uat-config-checksum')

  // A package whose rows do not resolve here: every row with its reason, and nothing created
  const rows = scene<{ file: string; workflow: string; position: string; member: string; catalog: string; supplier: string }>('rows', runId(testInfo))
  const rowsFile = testInfo.outputPath('rows.json')
  writeFileSync(rowsFile, rows.file)
  await importCard.locator('input[type="file"]').setInputFiles(rowsFile)
  await importCard.getByLabel('เหตุผลของการเปลี่ยน').fill('ทดสอบนำเข้าชุดค่าตั้งที่อ้างรหัสที่ไม่มี')
  await importCard.getByRole('button', { name: 'นำเข้าเป็นร่าง', exact: true }).click()
  await expect(importCard.getByRole('alert').filter({ hasText: 'มี 3 แถวในชุดค่าตั้งที่ไม่ตรงกับองค์กรนี้ จึงยังไม่ได้สร้างร่างใดเลย' })).toBeVisible()
  // A phone reads a list, a computer a table: the same three rows
  const shown = testInfo.project.name === 'mobile' ? importCard.getByRole('listitem') : importCard.getByRole('table').getByRole('row').filter({ hasNot: page.getByRole('columnheader') })
  await expect(shown).toHaveCount(3)
  await expect(shown.filter({ hasText: `${rows.workflow}/R1/${rows.position}` })).toContainText('องค์กรนี้ไม่มีตำแหน่งหรือแผนกรหัสนี้ เพิ่มในผังองค์กรก่อน')
  await expect(shown.filter({ hasText: `${rows.workflow}/R1/${rows.member}` })).toContainText('องค์กรนี้ไม่มีสมาชิกที่มีรหัสพนักงานนี้')
  await expect(shown.filter({ hasText: `${rows.catalog}/${rows.supplier}` })).toContainText('องค์กรนี้ไม่มีผู้ขายรหัสนี้ เพิ่มผู้ขายก่อน')
  await expect(shown.filter({ hasText: `${rows.catalog}/${rows.supplier}` })).toContainText('แคตตาล็อกและราคาตกลง')
  await check(page, testInfo, 'uat-config-rows')

  // One package exported, none imported (BR-UAT-03: a refused import creates nothing)
  expect(scene<{ exports: number; imports: number }>('packages')).toEqual({ exports: before.exports + 1, imports: before.imports })
})

test('[FR-PLT-101/AC1] the BCS team makes a UAT sandbox of a live customer with a contract reference; its member sees the trial-system banner', async ({ page, browser, clientIp }, testInfo) => {
  test.slow()
  const sandboxCode = `ZE2E-UAT-${runId(testInfo)}`
  await signInPlatform(page)
  // DEMO sorts first among the customers of the e2e database (the scenes' organizations start with Z)
  await page.getByRole('link', { name: /^ประเภทและระบบทดลองของ / }).first().click()
  await expect(page.getByRole('heading', { level: 2, name: 'ประเภทขององค์กร' })).toBeVisible()
  await expect(page.getByText('ระบบจริง (production)')).toBeVisible()
  await expect(page.getByText('ไม่มีการคัดลอกผังองค์กร ตำแหน่ง ผู้ใช้ DOA workflow หรือเอกสารใดจากระบบจริง', { exact: false })).toBeVisible()

  // Every field is needed, in words under it
  await page.getByRole('button', { name: 'สร้างระบบทดลอง', exact: true }).click()
  await expect(page.getByText('ใส่รหัสเป็นตัวพิมพ์ใหญ่ภาษาอังกฤษ ตัวเลข - หรือ _ 2 ถึง 40 ตัว ขึ้นต้นด้วยตัวอักษรหรือตัวเลข')).toBeVisible()
  await expect(page.getByText('ใส่เลขอ้างอิงสัญญา')).toBeVisible()
  await expect(page.getByText('ใส่เหตุผลอย่างน้อย 3 ตัวอักษร')).toBeVisible()
  await check(page, testInfo, 'uat-sandbox-form')

  await page.getByLabel('รหัสของระบบทดลอง').fill(sandboxCode)
  await page.getByLabel('เลขอ้างอิงสัญญา').fill(`E2E-UAT-${testInfo.project.name.toUpperCase()}`)
  await page.getByLabel('เหตุผล (บันทึกในประวัติ)').fill('ลูกค้าขอระบบทดลองตามสัญญาเพื่อลองค่าตั้งก่อนใช้จริง')
  await page.getByRole('button', { name: 'สร้างระบบทดลอง', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: `สร้างระบบทดลอง ${sandboxCode} แล้ว` })).toBeVisible()
  await check(page, testInfo, 'uat-sandbox-created')

  // The same code again is refused under the field
  await page.getByLabel('รหัสของระบบทดลอง').fill(sandboxCode)
  await page.getByLabel('เลขอ้างอิงสัญญา').fill('E2E-UAT-AGAIN')
  await page.getByLabel('เหตุผล (บันทึกในประวัติ)').fill('ลองรหัสเดิมซ้ำ')
  await page.getByRole('button', { name: 'สร้างระบบทดลอง', exact: true }).click()
  await expect(page.getByText('รหัสนี้มีองค์กรใช้แล้ว เลือกรหัสอื่น')).toBeVisible()

  // The sandbox's page: whose sandbox it is, and no sandbox of a sandbox
  await page.goto('/platform/tenants')
  const sandboxRow = page.getByRole('listitem').filter({ hasText: sandboxCode })
  await sandboxRow.getByRole('link', { name: /^ประเภทและระบบทดลองของ / }).click()
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(page.getByText(/^ระบบทดลอง \(UAT\) ของ .+ รหัส DEMO$/)).toBeVisible()
  await expect(page.getByText('องค์กรนี้เป็นระบบทดลองอยู่แล้ว สร้างระบบทดลองได้จากหน้าขององค์กรระบบจริงเท่านั้น')).toBeVisible()
  await expect(page.getByRole('button', { name: 'สร้างระบบทดลอง', exact: true })).toHaveCount(0)
  await check(page, testInfo, 'uat-sandbox-page')

  // A member of the sandbox: the banner on top of every workspace page, with nothing to close it (BR-UAT-01)
  const member = scene<{ email: string }>('member', sandboxCode, runId(testInfo))
  const context = await browser.newContext({ ...testInfo.project.use, baseURL: E2E_BASE_URL, extraHTTPHeaders: { 'x-forwarded-for': clientIp } })
  const memberPage = await context.newPage()
  await signIn(memberPage, member.email, null)
  const banner = memberPage.getByRole('region', { name: BANNER })
  await expect(banner).toBeVisible()
  await expect(banner).toHaveText(BANNER)
  await expect(banner.getByRole('button')).toHaveCount(0)
  await check(memberPage, testInfo, 'uat-sandbox-banner-home')
  await memberPage.goto('/settings')
  await expect(memberPage.getByRole('region', { name: BANNER })).toBeVisible()
  await context.close()
})
