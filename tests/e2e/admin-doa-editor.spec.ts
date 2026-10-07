import AxeBuilder from '@axe-core/playwright'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { type Locator, type Page, type TestInfo } from '@playwright/test'
import { parse as parseYaml } from 'yaml'
import { amountToSatang } from '../../src/core/money/dto'
import { formatSatang } from '../../src/core/money/format'
import { deriveSeedTotpSecret, totp } from '../../src/lib/totp'
import { E2E_BASE_URL, E2E_PIN, e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'
import { PIN_LABEL } from './tasks-support'

// S3-09 · the DOA editor (FR-DOA-001 AC1), the comparison with the version in effect and the boundary table, ticked by
// the drafter before sending and by the approver before approving (FR-DOA-009 AC1, AC3; GC-DOA-22), and the try-out
// (AC2). Demo scene 10: the admin moves the DM band to 30,000 baht on screen, sees the diff and the boundary table,
// sends; the CEO opens the task, reads the same diff, authority changes and boundary table, cannot approve before
// ticking the table, ticks it and approves with a step-up — the PIN (FR-DOA-002 AC2, FR-AUTH-005 AC2); it takes effect on the first of next
// month; the try-out with 25,000 baht shows version 1 going to the VP and version 2 to the DM. Each test builds an
// organization of its own (tests/e2e/admin-doa-editor-scene.ts) so the demo organization's DOA never changes under
// other specs, and desktop and mobile never meet. Screenshots at 375 px and 1440 px go to the test output (§9.9 step
// 4); axe runs on every state.

interface Scene {
  readonly orgCode: string
  readonly email: string
  readonly code: string
  /** The CEO's sign-in: the approver of DOA-CHG-01 */
  readonly ceo: { readonly email: string; readonly code: string }
  readonly v1: string
  readonly names: Readonly<Record<'admin' | 'ceo' | 'coo' | 'vp_ops' | 'vp_sup' | 'dm_con' | 'dm_it' | 'req_con', string>>
}

function scene<T>(...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/admin-doa-editor-scene.ts ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`DOA editor scene failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}

async function expectNoBlockingAxe(page: Page) {
  // Next streams the <title> after the first HTML: let it arrive before axe reads the page (a page without one still fails)
  await page.waitForFunction(() => document.title !== '', undefined, { timeout: 5_000 }).catch(() => undefined)
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

/** Every check of §9.9 steps 4–5 on the page as it is now */
async function review(page: Page, testInfo: TestInfo, name: string) {
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, name)
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

const THAI_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']
/** "2026-11-01" → "1 พ.ย. 2569" */
const thaiDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  return `${d} ${THAI_MONTHS[m - 1]} ${y + 543}`
}

test('@demo [FR-DOA-001/AC1] [FR-DOA-009/AC1] [FR-DOA-009/AC3] [FR-DOA-002/AC2] the admin moves the DM band to 30,000 on screen, checks the diff and ticks the boundary table, sends; the CEO reads the same, ticks the table and approves; it takes effect on the first of next month', async ({
  page,
  browser,
  clientIp,
}, testInfo) => {
  // The whole demo scene in one test, the CEO in a browser of their own, and an accessibility check on every state
  test.setTimeout(300_000)
  const mobile = testInfo.project.name === 'mobile'
  const s = scene<Scene>('org', testInfo.project.name)
  await signIn(page, s)

  // The versions page starts the editor from the latest version
  await page.goto('/admin/doa')
  const start = page.getByRole('region', { name: 'แก้ DOA บนหน้าจอ' })
  await expect(start).toContainText('ฉบับล่าสุดของ DOA-DEMO คือ DOA-DEMO ฉบับ 1 (มีผลอยู่)')
  await review(page, testInfo, 'doa-list-edit-entry')
  await start.getByRole('link', { name: 'แก้ต่อจาก DOA-DEMO ฉบับ 1' }).click()

  // Step 1: the rules of each document type as a table, edited one rule at a time
  await expect(page.getByRole('heading', { level: 1, name: 'ร่าง DOA-DEMO ฉบับ 2' })).toBeVisible()
  await expect(page.getByRole('list', { name: 'ขั้นตอนการแก้ DOA' }).getByRole('listitem').first()).toHaveAttribute('aria-current', 'step')
  const pr = page.getByRole('list', { name: 'คำขอซื้อ (PR)' })
  await expect(pr.getByRole('listitem')).toHaveCount(3)
  await expect(pr.getByRole('listitem').filter({ hasText: 'PR-01' })).toContainText('20,000.00')
  await expect(pr.getByRole('listitem').filter({ hasText: 'PR-01' })).toContainText('ผู้จัดการฝ่าย (DM) ของแผนกที่ตั้งเบิก')
  await expect(page.getByRole('combobox')).toHaveCount(0)
  await review(page, testInfo, 'doa-editor-rules')

  await page.getByRole('button', { name: 'แก้ข้อ PR-01' }).click()
  const row = page.getByRole('group', { name: 'แก้ข้อ PR-01' })
  await expect(row.getByLabel('ไม่เกิน (บาท)')).toHaveValue('20,000.00')
  await expect(row.getByLabel('ผู้อนุมัติ')).toHaveValue('POSITION_OF_DEPARTMENT:DM')
  // The approver comes from the organization's positions
  await expect(row.getByLabel('ผู้อนุมัติ').locator('option')).toContainText(['ประธานเจ้าหน้าที่บริหาร (CEO) ระดับองค์กร', 'รองประธานสายงาน (VP) ของแผนกที่ตั้งเบิก'])
  // An amount of more than two decimals is refused at the field, with what to type
  await row.getByLabel('ไม่เกิน (บาท)').fill('30,000.555')
  await row.getByRole('button', { name: 'บันทึกข้อนี้' }).click()
  await expect(row.getByText('ใส่ยอดเป็นบาท ทศนิยมไม่เกิน 2 ตำแหน่ง เช่น 30,000.00')).toBeVisible()
  await review(page, testInfo, 'doa-editor-row-error')
  await row.getByLabel('ไม่เกิน (บาท)').fill('30,000')
  // Save and cancel sit together; removing the rule is the danger-outlined button at the far end of the row, or on a
  // line of its own on a phone, never next to save
  const saveBox = (await row.getByRole('button', { name: 'บันทึกข้อนี้' }).boundingBox())!
  const removeBox = (await row.getByRole('button', { name: 'ลบข้อนี้: PR-01' }).boundingBox())!
  const ownLine = removeBox.y >= saveBox.y + saveBox.height
  expect(ownLine || removeBox.x - (saveBox.x + saveBox.width) > (mobile ? 40 : 200)).toBe(true)
  await review(page, testInfo, 'doa-editor-row')
  await row.getByRole('button', { name: 'บันทึกข้อนี้' }).click()
  // The VP band moved along with it, and the screen says so
  await expect(page.getByRole('status').filter({ hasText: 'ช่วงที่อยู่ติดกันเลื่อนตามแล้ว: ข้อ PR-02 เริ่มที่ยอดมากกว่า 30,000.00 บาท' })).toBeVisible()
  await expect(pr.getByRole('listitem').filter({ hasText: 'PR-01' })).toContainText('แก้แล้ว: ช่วงวงเงิน')
  await expect(pr.getByRole('listitem').filter({ hasText: 'PR-02' })).toContainText('30,000.00')

  // A rule removed by mistake comes back with one press, as it was
  const po = page.getByRole('list', { name: 'ใบสั่งซื้อ (PO)' })
  await expect(po.getByRole('listitem')).toHaveCount(2)
  await page.getByRole('button', { name: 'แก้ข้อ PO-02' }).click()
  await page.getByRole('group', { name: 'แก้ข้อ PO-02' }).getByRole('button', { name: 'ลบข้อนี้: PO-02' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'ลบข้อ PO-02 ออกจากฉบับร่างแล้ว' })).toBeVisible()
  await expect(po.getByRole('listitem')).toHaveCount(1)
  await review(page, testInfo, 'doa-editor-removed')
  await page.getByRole('button', { name: 'นำข้อ PO-02 กลับมา' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'นำข้อ PO-02 กลับมาแล้ว' })).toBeVisible()
  await expect(po.getByRole('listitem')).toHaveCount(2)
  await expect(po.getByRole('listitem').filter({ hasText: 'PO-02' })).not.toContainText('แก้แล้ว')

  // Step 2: the version's policies
  await page.getByRole('button', { name: 'ถัดไป: นโยบายของฉบับ' }).click()
  await expect(page.getByRole('heading', { name: 'นโยบายของฉบับ' })).toBeFocused()
  await expect(page.getByRole('group', { name: 'ฐานวงเงิน' }).getByRole('radio', { name: 'รวม VAT' })).toBeChecked()
  await expect(page.getByLabel('ยอด (บาท)')).toHaveValue('100,000.00')
  await expect(page.getByRole('group', { name: 'ผู้อนุมัติตรวจรับของเองได้' }).getByRole('radio', { name: 'ไม่ได้' })).toBeChecked()
  await review(page, testInfo, 'doa-editor-policy')
  await page.getByRole('button', { name: 'ถัดไป: วันมีผลและบันทึก' }).click()

  // Step 3: what changes, the effective date (first of next month) and the reason
  await expect(page.getByRole('heading', { name: 'วันมีผลและบันทึก' })).toBeFocused()
  const summary = page.getByRole('region', { name: 'สิ่งที่เปลี่ยนจาก DOA-DEMO ฉบับ 1' })
  await expect(summary.getByRole('listitem')).toHaveText([/แก้ข้อ PR-01 \(คำขอซื้อ \(PR\)\)ไม่เกิน 30,000\.00 บาท/, /แก้ข้อ PR-02 \(คำขอซื้อ \(PR\)\)มากกว่า 30,000\.00 ถึงไม่เกิน 100,000\.00 บาท/])
  const date = page.getByLabel('วันมีผล')
  const effective = await date.inputValue()
  expect(effective).toMatch(/^\d{4}-\d{2}-01$/)
  await expect(page.getByText(`มีผลตั้งแต่ ${thaiDate(effective)} 00:00 น. (เวลาไทย) เมื่อได้รับอนุมัติ`)).toBeVisible()
  await page.getByRole('button', { name: 'บันทึกเป็นฉบับร่าง DOA-DEMO ฉบับ 2' }).click()
  await expect(page.getByText('ใส่เหตุผลอย่างน้อย 3 ตัวอักษร')).toBeVisible()
  await page.getByLabel('เหตุผลการเปลี่ยน').fill('ขยายวงเงิน DM เป็น 30,000 บาท')
  await review(page, testInfo, 'doa-editor-save')
  await page.getByRole('button', { name: 'บันทึกเป็นฉบับร่าง DOA-DEMO ฉบับ 2' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'บันทึก DOA-DEMO ฉบับ 2 เป็นฉบับร่างแล้ว' })).toBeVisible()
  await page.getByRole('link', { name: 'เปิด DOA-DEMO ฉบับ 2 เพื่อตรวจและส่งขออนุมัติ' }).click()

  // The draft beside the version in effect: what changed, who gains or loses authority, the boundary table
  await expect(page.getByRole('heading', { level: 1, name: 'DOA-DEMO ฉบับ 2' })).toBeVisible()
  await expect(page.getByText('ฉบับร่าง', { exact: true }).first()).toBeVisible()
  const diff = page.getByRole('region', { name: 'เปลี่ยนจาก DOA-DEMO ฉบับ 1 ซึ่งมีผลอยู่' })
  await expect(diff.getByRole('listitem').filter({ hasText: 'แก้ข้อ PR-01' })).toContainText('ช่วงวงเงิน: เดิม ไม่เกิน 20,000.00 บาท · ใหม่ ไม่เกิน 30,000.00 บาท')
  await expect(diff.getByRole('listitem').filter({ hasText: 'แก้ข้อ PR-02' })).toContainText('ใหม่ มากกว่า 30,000.00 ถึงไม่เกิน 100,000.00 บาท')
  const authority = page.getByRole('region', { name: 'ตำแหน่งที่ได้หรือเสียอำนาจ' })
  await expect(authority.getByRole('listitem')).toHaveText([
    /ได้อำนาจ\s*ผู้จัดการฝ่าย \(DM\) ของแผนกที่ตั้งเบิก\s*คำขอซื้อ \(PR\) · มากกว่า 20,000\.00 ถึงไม่เกิน 30,000\.00 บาท/,
    /เสียอำนาจ\s*รองประธานสายงาน \(VP\) ของแผนกที่ตั้งเบิก\s*คำขอซื้อ \(PR\) · มากกว่า 20,000\.00 ถึงไม่เกิน 30,000\.00 บาท/,
  ])
  const boundaries = page.getByRole('region', { name: 'ตารางผลที่ขอบของช่วงวงเงิน' })
  const prEdges = boundaries.getByRole('list', { name: 'คำขอซื้อ (PR)' }).getByRole('listitem')
  await expect(prEdges).toHaveCount(6)
  // At 20,000.01 baht: version 1 uses PR-02 (the VP), this version PR-01 (the DM)
  const edge = prEdges.filter({ hasText: '20,000.01 บาท' })
  await expect(edge).toContainText(/ฉบับที่มีผล\s*ใช้ข้อ PR-02\s*รองประธานสายงาน \(VP\)/)
  await expect(edge).toContainText(/ฉบับนี้\s*ใช้ข้อ PR-01\s*ผู้จัดการฝ่าย \(DM\)/)
  await expect(edge).toContainText('ผู้อนุมัติเปลี่ยน')
  await expect(prEdges.filter({ hasText: '30,000.01 บาท' })).toContainText('ผู้อนุมัติเดิม')
  await review(page, testInfo, 'doa-draft-compare')

  // Phones: the send follows the boundary table it asks to tick; wide screens: it sits beside the content, on the right
  const send = page.getByRole('region', { name: 'ส่งขออนุมัติเผยแพร่' })
  const sendBox = (await send.boundingBox())!
  const tableBox = (await boundaries.boundingBox())!
  if (mobile) expect(sendBox.y).toBeGreaterThan(tableBox.y + tableBox.height)
  else expect(sendBox.x).toBeGreaterThan(tableBox.x + tableBox.width)

  // The drafter ticks the boundary table before sending
  await expect(send).toContainText(`ฉบับนี้จะส่งให้ ${s.names.ceo} อนุมัติตาม DOA-DEMO ฉบับ 1 ข้อ DOA-CHG-01`)
  await send.getByRole('button', { name: 'ส่งขออนุมัติเผยแพร่' }).click()
  await expect(send.getByText('ติ๊กยืนยันว่าตรวจตารางผลที่ขอบแล้วก่อนส่ง')).toBeVisible()
  await review(page, testInfo, 'doa-draft-tick')
  await send.getByRole('checkbox', { name: 'ฉันตรวจตารางผลที่ขอบแล้ว ทุกยอดที่ขอบของช่วงไปหาผู้อนุมัติตามที่ตั้งใจ' }).check()
  await send.getByRole('button', { name: 'ส่งขออนุมัติเผยแพร่' }).click()
  await expect(page.getByRole('status').filter({ hasText: `ส่งขออนุมัติเผยแพร่แล้ว รอ ${s.names.ceo} อนุมัติ` }).first()).toBeVisible()

  // The CEO, the approver of DOA-CHG-01, decides on the task's page in a browser of their own (FR-DOA-009 AC3, BR-DOA-15)
  const ceoContext = await browser.newContext({ ...testInfo.project.use, baseURL: E2E_BASE_URL, extraHTTPHeaders: { 'x-forwarded-for': clientIp } })
  const ceo = await ceoContext.newPage()
  await signIn(ceo, s.ceo)
  await ceo.goto('/tasks')
  await ceo.getByRole('link', { name: 'อนุมัติเผยแพร่ DOA-DEMO ฉบับ 2' }).click()
  await expect(ceo.getByRole('heading', { level: 1 })).toHaveText('เผยแพร่ DOA-DEMO ฉบับ 2')
  // The same comparison the admin sent: what changes, who gains or loses authority, and the boundary table
  const taskDiff = ceo.getByRole('region', { name: 'เปลี่ยนจาก DOA-DEMO ฉบับ 1 ที่มีผลอยู่' })
  await expect(taskDiff.getByRole('listitem').filter({ hasText: 'แก้ข้อ PR-01' })).toContainText('ช่วงวงเงิน: เดิม ไม่เกิน 20,000.00 บาท · ใหม่ ไม่เกิน 30,000.00 บาท')
  await expect(ceo.getByRole('region', { name: 'ตำแหน่งที่ได้หรือเสียอำนาจ' }).getByRole('listitem')).toHaveText([
    /ได้อำนาจ\s*ผู้จัดการฝ่าย \(DM\) ของแผนกที่ตั้งเบิก\s*คำขอซื้อ \(PR\) · มากกว่า 20,000\.00 ถึงไม่เกิน 30,000\.00 บาท/,
    /เสียอำนาจ\s*รองประธานสายงาน \(VP\) ของแผนกที่ตั้งเบิก\s*คำขอซื้อ \(PR\) · มากกว่า 20,000\.00 ถึงไม่เกิน 30,000\.00 บาท/,
  ])
  const taskEdges = ceo.getByRole('region', { name: 'ตารางผลที่ขอบของช่วงวงเงิน' }).getByRole('list', { name: 'คำขอซื้อ (PR)' }).getByRole('listitem')
  await expect(taskEdges).toHaveCount(6)
  const taskEdge = taskEdges.filter({ hasText: '20,000.01 บาท' })
  await expect(taskEdge).toContainText(/ฉบับที่มีผล\s*ใช้ข้อ PR-02\s*รองประธานสายงาน \(VP\)/)
  await expect(taskEdge).toContainText(/ฉบับนี้\s*ใช้ข้อ PR-01\s*ผู้จัดการฝ่าย \(DM\)/)
  await expect(taskEdge).toContainText('ผู้อนุมัติเปลี่ยน')
  await expect(taskEdges.filter({ hasText: '30,000.01 บาท' })).toContainText('ผู้อนุมัติเดิม')
  // Money right-aligned on wide screens; on phones each amount is a row of its own with its label
  if (!mobile) expect(await taskEdge.locator('.tabular').first().evaluate((e) => getComputedStyle(e.parentElement!).textAlign)).toBe('right')
  // The column header keeps the name of the version compared with on one line
  if (!mobile) {
    const header = ceo.getByRole('region', { name: 'ตารางผลที่ขอบของช่วงวงเงิน' }).getByText('(DOA-DEMO ฉบับ 1)', { exact: true }).first()
    expect(await header.evaluate((e) => getComputedStyle(e).whiteSpace)).toBe('nowrap')
  }
  await review(ceo, testInfo, 'doa-task-compare')

  // Approving asks for the tick of the boundary table first, then the PIN (FR-AUTH-005 AC2)
  const approve = ceo.getByRole('button', { name: 'อนุมัติการเปลี่ยนนี้', exact: true })
  const approveForm = ceo.locator('form').filter({ has: approve })
  const tick = approveForm.getByRole('checkbox', { name: 'ฉันตรวจตารางผลที่ขอบแล้ว ทุกยอดที่ขอบของช่วงไปหาผู้อนุมัติที่ถูกต้อง' })
  const tickBox = (await tick.boundingBox())!
  const pinBox = (await approveForm.getByLabel(PIN_LABEL).boundingBox())!
  expect(tickBox.y).toBeLessThan(pinBox.y)
  await approveForm.getByLabel(PIN_LABEL).fill(E2E_PIN)
  await approve.click()
  await expect(approveForm.getByText('ติ๊กยืนยันว่าตรวจตารางผลที่ขอบแล้วก่อนอนุมัติ')).toBeVisible()
  await expect(tick).toHaveAttribute('aria-invalid', 'true')
  await review(ceo, testInfo, 'doa-task-tick')
  await expect(ceo.getByRole('status').filter({ hasText: 'อนุมัติการเปลี่ยนนี้แล้ว' })).toHaveCount(0)
  await tick.check()
  await expect(approveForm.getByText('ติ๊กยืนยันว่าตรวจตารางผลที่ขอบแล้วก่อนอนุมัติ')).toHaveCount(0)
  await approveForm.getByLabel(PIN_LABEL).fill(E2E_PIN)
  await approve.click()
  await expect(ceo.getByRole('status').filter({ hasText: 'อนุมัติการเปลี่ยนนี้แล้ว' })).toBeVisible()
  await expect(ceo.getByRole('status').filter({ hasText: `อนุมัติแล้วโดย ${s.names.ceo} เมื่อ` })).toBeVisible()
  await review(ceo, testInfo, 'doa-task-approved')
  await ceoContext.close()

  await page.goto('/admin/doa')
  const list = page.getByRole('region', { name: /ทุกฉบับ/ }).getByRole('listitem')
  await expect(list.filter({ hasText: 'DOA-DEMO ฉบับ 2' })).toContainText('อนุมัติแล้ว รอมีผล')
  await expect(list.filter({ hasText: 'DOA-DEMO ฉบับ 2' })).toContainText(`มีผลตั้งแต่ ${thaiDate(effective)} 00:00 น. จนกว่าจะมีฉบับใหม่`)
  await expect(list.filter({ hasText: 'DOA-DEMO ฉบับ 1' })).toContainText(`มีผล 1 ม.ค. 2569 00:00 น. ถึง ${thaiDate(effective)} 00:00 น.`)
  // The editor now starts from the version approved for later
  await expect(page.getByRole('region', { name: 'แก้ DOA บนหน้าจอ' })).toContainText('ฉบับล่าสุดของ DOA-DEMO คือ DOA-DEMO ฉบับ 2 (อนุมัติแล้ว รอมีผล)')
  await review(page, testInfo, 'doa-list-approved')

  // The try-out with 25,000 baht: version 1 (in effect) goes to the VP, version 2 to the DM
  await list.filter({ hasText: 'DOA-DEMO ฉบับ 2' }).getByRole('link', { name: 'ดูรายละเอียด DOA-DEMO ฉบับ 2' }).click()
  await page.getByRole('link', { name: 'ทดลองส่งกับฉบับนี้' }).click()
  await page.getByLabel('ยอดก่อน VAT (บาท)').fill('25,000')
  await choose(page.getByLabel('แผนกที่ตั้งเบิก'), 'ฝ่ายก่อสร้าง (CON)')
  await choose(page.getByLabel('ผู้ขอ'), s.names.req_con)
  await page.getByRole('button', { name: 'ทดลองหาเส้นทาง' }).click()
  await expect(page.getByText(`ผลต่างกัน: ฉบับที่มีผลอยู่ส่งไปหา ${s.names.vp_ops} แต่ฉบับนี้ส่งไปหา ${s.names.dm_con}`)).toBeVisible()
  await review(page, testInfo, 'doa-simulate-approved')
})

test('@demo [FR-DOA-009/AC2] the try-out routes a document with both versions and explains each route in Thai', async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  const s = scene<Scene>('org', testInfo.project.name)
  const draft = scene<{ versionId: string; versionNo: number }>('draft', s.orgCode)
  await signIn(page, s)

  await page.goto(`/admin/doa/${draft.versionId}`)
  await page.getByRole('link', { name: 'ทดลองส่งกับฉบับนี้' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'ทดลองส่งกับ DOA-DEMO ฉบับ 2' })).toBeVisible()
  await expect(page.getByText('ใส่ข้อมูลเอกสารแล้วกด ทดลองหาเส้นทาง เพื่อดูว่าเอกสารจะไปหาใครในแต่ละฉบับ')).toBeVisible()
  await review(page, testInfo, 'doa-simulate-empty')

  // What is missing is said at each field, and nothing is routed
  await page.getByLabel('ยอดก่อน VAT (บาท)').fill('25,000')
  await page.getByRole('button', { name: 'ทดลองหาเส้นทาง' }).click()
  await expect(page.getByText('เลือกแผนกที่ตั้งเบิก')).toBeVisible()
  await expect(page.getByText('เลือกผู้ขอที่ใช้งานอยู่')).toBeVisible()
  await review(page, testInfo, 'doa-simulate-errors')

  await choose(page.getByLabel('แผนกที่ตั้งเบิก'), 'ฝ่ายก่อสร้าง (CON)')
  await choose(page.getByLabel('ผู้ขอ'), s.names.req_con)
  await page.getByRole('button', { name: 'ทดลองหาเส้นทาง' }).click()
  // A GET form: the address carries the document, so the result can be reloaded or shared
  await expect(page).toHaveURL(/type=PURCHASE_REQUEST/)
  await expect(page.getByText(`ผลต่างกัน: ฉบับที่มีผลอยู่ส่งไปหา ${s.names.vp_ops} แต่ฉบับนี้ส่งไปหา ${s.names.dm_con}`)).toBeVisible()
  const current = page.getByRole('region', { name: 'DOA-DEMO ฉบับ 1 ซึ่งมีผลอยู่' })
  await expect(current).toContainText('ใช้ข้อ PR-02')
  await expect(current).toContainText(s.names.vp_ops)
  await expect(current).toContainText('รองประธานสายงาน (VP) ของสายปฏิบัติการ')
  await expect(current).toContainText('8 ชั่วโมงทำการ')
  await expect(current).toContainText('DOA-DEMO ฉบับ 1 ข้อ PR-02: คำขอซื้อยอด 25,000.00 บาท (รวม VAT) อยู่ในช่วงมากกว่า 20,000.00 ถึงไม่เกิน 100,000.00 → VP ของสายปฏิบัติการ')
  const proposed = page.getByRole('region', { name: 'ฉบับนี้: DOA-DEMO ฉบับ 2 (ฉบับร่าง)' })
  await expect(proposed).toContainText('ใช้ข้อ PR-01')
  await expect(proposed).toContainText(s.names.dm_con)
  await expect(proposed).toContainText('DOA-DEMO ฉบับ 2 ข้อ PR-01: คำขอซื้อยอด 25,000.00 บาท (รวม VAT) อยู่ในช่วงไม่เกิน 30,000.00 → DM ของฝ่ายก่อสร้าง')
  await review(page, testInfo, 'doa-simulate-result')

  // The DM asking for themselves goes up a band in both versions
  await choose(page.getByLabel('ผู้ขอ'), s.names.dm_con)
  await page.getByLabel('ยอดก่อน VAT (บาท)').fill('15000')
  await page.getByRole('button', { name: 'ทดลองหาเส้นทาง' }).click()
  await expect(page.getByText(`ทั้งสองฉบับส่งไปหาผู้อนุมัติคนเดียวกัน: ${s.names.vp_ops}`)).toBeVisible()
  await expect(proposed).toContainText('ยกมาจากข้อ PR-01 เพราะผู้อนุมัติของข้อนั้นเป็นผู้ขอ')
})

test('[GC-DOA-22] the boundary table of version 1 is the golden case, with the approver at each edge', async ({ page }, testInfo) => {
  const s = scene<Scene>('org', testInfo.project.name)
  await signIn(page, s)
  await page.goto(`/admin/doa/${s.v1}`)
  const golden = (parseYaml(readFileSync(path.resolve(import.meta.dirname, '../golden/doa-lint.yaml'), 'utf8')) as { cases: Array<{ id: string; expect: { rows: Array<{ amount: string; rule: string }> } }> }).cases.find((c) => c.id === 'GC-DOA-22')!
  // "20000.01" → "20,000.01" the way the page formats money: parsed to satang and formatted, never through a float
  const money = (text: string) => formatSatang(amountToSatang(text))
  const rows = page.getByRole('region', { name: 'ตารางผลที่ขอบของช่วงวงเงิน' }).getByRole('list', { name: 'คำขอซื้อ (PR)' }).getByRole('listitem')
  // Each edge in order: the amount, the rule of the golden case, and who that rule names (BR-DOA-08 (ช))
  await expect(rows).toHaveText(golden.expect.rows.map((r) => new RegExp(`${money(r.amount).replace(/[.]/g, '\\.')} บาท.*ใช้ข้อ ${r.rule}`)))
  const approvers: Record<string, string> = { 'PR-01': 'ผู้จัดการฝ่าย (DM)', 'PR-02': 'รองประธานสายงาน (VP)', 'PR-03': 'ประธานเจ้าหน้าที่บริหาร (CEO)' }
  for (const [i, r] of golden.expect.rows.entries()) await expect(rows.nth(i)).toContainText(approvers[r.rule]!)
  await review(page, testInfo, 'doa-version-1-boundaries')
})

test('[FR-DOA-009/AC1] a version without a band edge has no boundary table to tick, and is sent all the same', async ({ page }, testInfo) => {
  const s = scene<Scene & { draftId: string; draftNo: number }>('flat', testInfo.project.name)
  await signIn(page, s)
  await page.goto(`/admin/doa/${s.draftId}`)
  await expect(page.getByRole('heading', { level: 1, name: `DOA-DEMO ฉบับ ${s.draftNo}` })).toBeVisible()
  // Who gains and loses authority is said, even with no band edge to show
  const authority = page.getByRole('region', { name: 'ตำแหน่งที่ได้หรือเสียอำนาจ' })
  await expect(authority.getByRole('listitem')).toHaveText([
    /ได้อำนาจ\s*รองประธานสายงาน \(VP\) ของแผนกที่ตั้งเบิก\s*คำขอซื้อ \(PR\) · ทุกยอด/,
    /เสียอำนาจ\s*ผู้จัดการฝ่าย \(DM\) ของแผนกที่ตั้งเบิก\s*คำขอซื้อ \(PR\) · ทุกยอด/,
  ])
  // No table, so no tick to ask for: the send goes through as it is
  await expect(page.getByRole('region', { name: 'ตารางผลที่ขอบของช่วงวงเงิน' })).toHaveCount(0)
  const send = page.getByRole('region', { name: 'ส่งขออนุมัติเผยแพร่' })
  await expect(send.getByRole('checkbox')).toHaveCount(0)
  await review(page, testInfo, 'doa-flat-send')
  await send.getByRole('button', { name: 'ส่งขออนุมัติเผยแพร่' }).click()
  await expect(page.getByRole('status').filter({ hasText: `ส่งขออนุมัติเผยแพร่แล้ว รอ ${s.names.ceo} อนุมัติ` }).first()).toBeVisible()
})

test('[FR-DOA-001/AC1] [FR-DOA-009/AC2] members without the admin capabilities get neither the editor nor the try-out', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('อีเมลบริษัท').fill('req_con@demo.bcs.local')
  await page.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('สวัสดี')
  const id = randomUUID()
  await page.goto(`/admin/doa/${id}/edit`)
  await expect(page.getByRole('alert').filter({ hasText: 'หน้านี้สำหรับผู้ดูแลองค์กร' })).toBeVisible()
  await expect(page.getByRole('button', { name: /บันทึกเป็นฉบับร่าง/ })).toHaveCount(0)
  await page.goto(`/admin/doa/${id}/simulate?type=PURCHASE_REQUEST&net=25000`)
  await expect(page.getByRole('alert').filter({ hasText: 'หน้านี้สำหรับผู้ดูแลองค์กร' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'ทดลองหาเส้นทาง' })).toHaveCount(0)
})
