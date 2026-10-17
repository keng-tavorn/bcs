import AxeBuilder from '@axe-core/playwright'
import { spawnSync } from 'node:child_process'
import { type Locator, type Page, type TestInfo } from '@playwright/test'
import { deriveSeedTotpSecret, totp } from '../../src/lib/totp'
import { E2E_BASE_URL, E2E_PIN, e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'
import { settled } from './settled'
import { PIN_LABEL } from './tasks-support'

// S6-06 · the workflow screens (FR-WF-103 AC1 AC2 AC3, ADR-103, NG-4): the second admin makes a draft of the
// workflow in effect, adds a reviewer rule in the Dialog (chemicals go to the DM of LEG, with the VP of SUP as the
// fallback), saves, finds the send closed until the dry-run ran on the latest save, runs the dry-run and reads the
// route of the version in effect beside the draft's, ticks any warning and sends; the CEO — the approver of
// DOA_CHANGE — opens the task on the web and approves with the PIN (BR-WF-12: every time a step-up); the version is
// PUBLISHED for the first of next month. Each test builds an organization of its own (admin-workflows-scene.ts) so
// desktop and mobile never meet. Screenshots at 375 px and 1440 px go to the test output (§9.9 step 4); axe runs on
// every state.

interface Scene {
  readonly orgCode: string
  readonly admin: { readonly email: string; readonly code: string }
  readonly ceo: { readonly email: string; readonly code: string }
  readonly workflowCode: string
  readonly rules: number
  readonly names: Readonly<Record<string, string>>
}

function scene<T>(...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/admin-workflows-scene.ts ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`workflow scene failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}

async function expectNoBlockingAxe(page: Page) {
  // Next streams the <title> after the first HTML: let it arrive before axe reads the page (a page without one still fails)
  await page.waitForFunction(() => document.title !== '', undefined, { timeout: 5_000 }).catch(() => undefined)
  await settled(page)
  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(blocking.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)).toEqual([])
}

async function expectNoSideways(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
}

/** Every check of §9.9 steps 4–5 on the page as it is now */
async function review(page: Page, testInfo: TestInfo, name: string) {
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })
}

async function signIn(page: Page, s: { email: string; code: string }) {
  await page.goto('/login')
  await page.getByLabel('อีเมลบริษัท').fill(s.email)
  await page.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
  await expect(page).toHaveURL(/\/login\/2fa$/)
  await page.getByLabel('รหัส 6 หลักจากแอป').fill(totp(deriveSeedTotpSecret(process.env.SEED_TOTP_KEY!, s.code)))
  await page.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('สวัสดี')
}

/** Chooses the option whose text contains `text` (department options are indented by their depth in the tree) */
async function choose(select: Locator, text: string) {
  const value = await select.locator('option', { hasText: text }).first().getAttribute('value')
  expect(value, text).toBeTruthy()
  await select.selectOption(value!)
}

test('[FR-WF-103/AC1] [FR-WF-103/AC2] [FR-WF-103/AC3] the admin adds a reviewer rule in the Dialog, dry-runs the draft beside the version in effect and sends it; the CEO approves with the PIN and it is published', async ({
  page,
  browser,
  clientIp,
}, testInfo) => {
  test.setTimeout(300_000)
  const s = scene<Scene>('org', testInfo.project.name)
  const v1 = `${s.workflowCode} ฉบับ 1`
  const v2 = `${s.workflowCode} ฉบับ 2`
  await signIn(page, s.admin)

  // The list: version 1 in effect, and the main action makes a draft copied from it
  await page.goto('/admin/workflows')
  await expect(page.getByRole('heading', { level: 1, name: 'ผู้ตรวจคู่ขนาน (workflow)' })).toBeVisible()
  const versions = page.getByRole('region', { name: 'ฉบับทั้งหมด (1)' })
  await expect(versions.getByRole('listitem').filter({ hasText: v1 })).toContainText('มีผลอยู่')
  await expect(versions.getByRole('listitem').filter({ hasText: v1 })).toContainText(`${s.rules} ข้อ`)
  const start = page.getByRole('region', { name: 'แก้ผู้ตรวจ' })
  await expect(start).toContainText(`ฉบับล่าสุดคือ ${v1} (มีผลอยู่)`)
  await review(page, testInfo, 'workflow-list')
  await start.getByRole('button', { name: `สร้างร่างจาก ${v1}` }).click()

  // The draft: its rules in words, edited one at a time; no dragging (NG-4)
  await expect(page).toHaveURL(/\/admin\/workflows\/[0-9a-f-]{36}$/)
  await expect(page.getByRole('heading', { level: 1, name: v2 })).toBeVisible()
  const rules = page.getByRole('list', { name: 'ข้อผู้ตรวจ' })
  await expect(rules.getByRole('listitem')).toHaveCount(s.rules)
  await expect(rules.getByRole('listitem').filter({ hasText: 'RV-06' })).toContainText('หมวดของรายการ มีค่าใดค่าหนึ่งใน SAFETY, FUEL')
  await expect(rules.getByRole('listitem').filter({ hasText: 'RV-03' })).toContainText('ยอดรวม VAT มากกว่า 1,000,000.00 บาท')
  await expect(page.locator('[draggable="true"]')).toHaveCount(0)
  await review(page, testInfo, 'workflow-draft-rules')

  // The Dialog, step 1: when a request enters the rule
  await page.getByRole('button', { name: 'เพิ่มข้อผู้ตรวจ' }).click()
  const dialog = page.getByRole('dialog', { name: 'เพิ่มข้อผู้ตรวจ' })
  await expect(dialog.getByLabel('รหัสข้อ')).toHaveValue('RV-10')
  // Next without a request type: refused at the field, with what to do
  await dialog.getByRole('button', { name: 'ถัดไป: ใครตรวจ' }).click()
  await expect(dialog.getByText('เลือกอย่างน้อยหนึ่งรายการ')).toBeVisible()
  await dialog.getByRole('checkbox', { name: 'ซื้อของ (BUY_GOODS)' }).check()
  await dialog.getByRole('button', { name: 'เพิ่มแถวเงื่อนไข' }).click()
  await choose(dialog.getByLabel('ข้อมูลที่ใช้'), 'หมวดของรายการ')
  await expect(dialog.getByLabel('เทียบแบบ')).toHaveValue('anyIn')
  await dialog.getByLabel('ค่าที่ใช้').fill('CHEM')
  await review(page, testInfo, 'workflow-dialog-when')
  await dialog.getByRole('button', { name: 'ถัดไป: ใครตรวจ' }).click()

  // Step 2: who reviews — the DM of LEG, the VP of SUP as the fallback, 8 business hours
  await expect(dialog.getByRole('radio', { name: /ผู้ตรวจคนเดียว ต้องผ่าน/ })).toBeChecked()
  const reviewer = dialog.getByRole('group', { name: 'ผู้ตรวจคนที่ 1' })
  await choose(reviewer.getByLabel('ตำแหน่ง'), 'ผู้จัดการฝ่าย (DM)')
  await choose(reviewer.getByLabel('หน่วยงาน'), 'ฝ่ายกฎหมาย (LEG)')
  await dialog.getByRole('checkbox', { name: 'มีผู้สำรองเมื่อผู้ตรวจว่างหรือเป็นผู้ขอเอง' }).check()
  const fallback = dialog.getByRole('group', { name: 'ผู้สำรอง', exact: true })
  await choose(fallback.getByLabel('ตำแหน่ง'), 'รองประธานสายงาน (VP)')
  await choose(fallback.getByLabel('หน่วยงาน'), 'สายสนับสนุน (SUP)')
  await expect(dialog.getByLabel('เวลาตรวจ (ชั่วโมงทำการ)')).toHaveValue('8')
  await review(page, testInfo, 'workflow-dialog-who')
  await dialog.getByRole('button', { name: 'เพิ่มข้อนี้' }).click()
  await expect(dialog).toHaveCount(0)
  const added = rules.getByRole('listitem').filter({ hasText: 'RV-10' })
  await expect(added).toContainText('ข้อใหม่')
  await expect(added).toContainText('หมวดของรายการ มีค่าใดค่าหนึ่งใน CHEM')
  await expect(added).toContainText('ผู้จัดการฝ่าย (DM) ของ ฝ่ายกฎหมาย (LEG)')

  // Unsaved: the send says to save first; then the draft is saved with its reason
  await page.getByRole('tab', { name: 'ตรวจและส่งขออนุมัติ' }).click()
  await expect(page.getByText('มีการแก้ที่ยังไม่ได้บันทึก บันทึกร่างก่อน')).toBeVisible()
  await expect(page.getByRole('button', { name: 'ส่งขออนุมัติเผยแพร่' })).toBeDisabled()
  await page.getByRole('tab', { name: 'ข้อผู้ตรวจ' }).click()
  await page.getByLabel('เหตุผลที่เปลี่ยน').fill('เพิ่มผู้ตรวจของสารเคมี')
  await page.getByRole('button', { name: `บันทึกร่าง ${v2}` }).click()
  await expect(page.getByRole('status').filter({ hasText: `บันทึกร่าง ${v2} แล้ว` })).toBeVisible()

  // Saved but not dry-run: the send stays closed and says why (§9.9 rule 7)
  await page.getByRole('tab', { name: 'ตรวจและส่งขออนุมัติ' }).click()
  await expect(page.getByText('ยังไม่ได้ทดลองส่งร่างล่าสุด ไปที่แท็บทดลองส่งแล้วกดทดลองส่ง')).toBeVisible()
  await expect(page.getByRole('button', { name: 'ส่งขออนุมัติเผยแพร่' })).toBeDisabled()
  await review(page, testInfo, 'workflow-check-before-dry-run')

  // The dry-run: chemicals of 5,000 baht — version 1 has no reviewer, the draft sends them to the DM of LEG
  await page.getByRole('tab', { name: 'ทดลองส่ง' }).click()
  await choose(page.getByLabel('ประเภทคำขอ', { exact: true }), 'ซื้อของ')
  await page.getByLabel('ยอดรวม VAT (บาท)').fill('5,000')
  await page.getByLabel('หมวดของรายการ', { exact: true }).fill('CHEM')
  await choose(page.getByLabel('ผู้ขอ', { exact: true }), s.names.req_con!)
  await page.getByRole('button', { name: 'ทดลองส่ง', exact: true }).click()
  await expect(page.getByText('เส้นทางของร่างต่างจากฉบับที่มีผลอยู่')).toBeVisible()
  const current = page.getByRole('region', { name: `ฉบับที่มีผล: ${v1}` })
  const draft = page.getByRole('region', { name: `ร่าง: ${v2}` })
  await expect(current).toContainText('ไม่มีผู้ตรวจ ไปที่ผู้อนุมัติตาม DOA โดยตรง')
  await expect(draft).toContainText(`ข้อ RV-10: ${s.names.dm_leg}`)
  await expect(draft).toContainText('ต่างจากฉบับที่มีผล')
  await review(page, testInfo, 'workflow-dry-run')

  // The send: open now; every warning ticked; confirmed in an Alert Dialog naming the CEO
  await page.getByRole('tab', { name: 'ตรวจและส่งขออนุมัติ' }).click()
  await expect(page.getByRole('listitem').filter({ hasText: 'ครบแล้ว: ทดลองส่งร่างล่าสุดแล้ว' })).toBeVisible()
  const warnings = page.getByRole('group', { name: 'คำเตือนที่ต้องติ๊กยืนยัน' }).getByRole('checkbox')
  for (const box of await warnings.all()) await box.check()
  await expect(page.getByText(`ฉบับนี้จะส่งให้ ${s.names.ceo} อนุมัติตาม`)).toBeVisible()
  await review(page, testInfo, 'workflow-check-ready')
  await page.getByRole('button', { name: 'ส่งขออนุมัติเผยแพร่' }).click()
  const confirm = page.getByRole('alertdialog', { name: `ส่ง ${v2} ขออนุมัติเผยแพร่` })
  await expect(confirm).toContainText(s.names.ceo!)
  await review(page, testInfo, 'workflow-send-confirm')
  await confirm.getByRole('button', { name: 'ส่งขออนุมัติเผยแพร่' }).click()
  await expect(page.getByRole('status').filter({ hasText: `ส่งขออนุมัติเผยแพร่แล้ว รอ ${s.names.ceo} อนุมัติ` }).first()).toBeVisible()
  // Sent: read only
  await expect(page.getByText('ฉบับนี้รออนุมัติจึงแก้ไม่ได้')).toBeVisible()
  await expect(page.getByRole('button', { name: 'แก้ข้อ RV-10' })).toHaveCount(0)
  await review(page, testInfo, 'workflow-sent')

  // The CEO decides on the web, in a browser of their own, with the PIN every time (BR-WF-12)
  const { taskId, versionId } = scene<{ taskId: string; versionId: string }>('task', s.orgCode)
  const ceoContext = await browser.newContext({ ...testInfo.project.use, baseURL: E2E_BASE_URL, extraHTTPHeaders: { 'x-forwarded-for': clientIp } })
  const ceo = await ceoContext.newPage()
  await signIn(ceo, s.ceo)
  await ceo.goto(`/tasks/${taskId}`)
  await expect(ceo.getByRole('heading', { level: 1 })).toContainText(`อนุมัติเผยแพร่ผู้ตรวจคู่ขนาน ${v2}`)
  // The approver reads the version — its rules, the comparison and the try-out — before deciding (FR-WF-103 AC3)
  await ceo.getByRole('link', { name: /เปิดฉบับนี้/ }).click()
  await expect(ceo).toHaveURL(new RegExp(`/admin/workflows/${versionId}$`))
  await ceo.getByRole('tab', { name: 'เทียบกับฉบับก่อน' }).click()
  await expect(ceo.getByText('เพิ่มข้อ RV-10')).toBeVisible()
  await review(ceo, testInfo, 'workflow-approver-reads')
  await ceo.goto(`/tasks/${taskId}`)
  const approve = ceo.getByRole('button', { name: 'อนุมัติการเปลี่ยนนี้', exact: true })
  const approveForm = ceo.locator('form').filter({ has: approve })
  await approveForm.getByLabel(PIN_LABEL).fill(E2E_PIN)
  await review(ceo, testInfo, 'workflow-task-pin')
  await approve.click()
  await expect(ceo.getByRole('status').filter({ hasText: 'อนุมัติการเปลี่ยนนี้แล้ว' })).toBeVisible()
  await ceoContext.close()

  // Published for its date: the list says so, and the version page names the CEO
  expect(scene<{ versions: Array<{ versionNo: number; status: string; approved: boolean }> }>('status', s.orgCode).versions).toEqual([
    expect.objectContaining({ versionNo: 1, status: 'PUBLISHED' }),
    expect.objectContaining({ versionNo: 2, status: 'PUBLISHED', approved: true }),
  ])
  await page.goto('/admin/workflows')
  await expect(page.getByRole('region', { name: 'ฉบับทั้งหมด (2)' }).getByRole('listitem').filter({ hasText: v2 })).toContainText('อนุมัติแล้ว รอมีผล')
  await page.goto(`/admin/workflows/${versionId}`)
  await expect(page.getByText(`${s.names.ceo} เมื่อ`)).toBeVisible()
  await expect(page.getByText('ฉบับนี้แก้ไม่ได้ ถ้าต้องการเปลี่ยน ให้สร้างร่างใหม่จากหน้ารายการ')).toBeVisible()
  await page.getByRole('tab', { name: 'เทียบกับฉบับก่อน' }).click()
  await expect(page.getByText('เพิ่มข้อ RV-10')).toBeVisible()
  await review(page, testInfo, 'workflow-published')
})
