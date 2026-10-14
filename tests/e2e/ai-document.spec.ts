import { spawnSync } from 'node:child_process'
import AxeBuilder from '@axe-core/playwright'
import type { Page, TestInfo } from '@playwright/test'
import { deriveSeedTotpSecret, totp } from '../../src/lib/totp'
import { e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'

// S13-07 (FR-AI-303 AC1 AC3 AC4 AC8, docs/sub-specs/S13.md "หน้าจอ"): the Document Agent on the request form's quotation
// step and on the receiving page. The demo organization keeps the AI module off — no AI button anywhere (AC8) — and each
// test switches it on for itself and off again (tests/e2e/ai-document-scene.ts, which also plays the background job:
// the e2e app sends no outbox to Inngest). The values the AI read come back marked "เติมโดย AI โปรดตรวจ", the requester
// or the receiver confirms them, and the save or the receipt that carries the confirmations closes the AI action.
// Every state is checked with axe and photographed at the project's width (375 px or 1440 px, §9.9 step 4).

type SceneMode = 'on' | 'off' | 'run' | 'state' | 'brief' | 'doa-cleanup'

function scene<T>(file: 'ai-document-scene' | 'receiving-scene', env: Record<string, string>): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/${file}.ts`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv(), ...env } })
  if (r.status !== 0) throw new Error(`${file} ${JSON.stringify(env)} failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}
const ai = <T>(mode: SceneMode, extra: Record<string, string> = {}) => scene<T>('ai-document-scene', { SCENE_MODE: mode, ...extra })

async function check(page: Page, testInfo: TestInfo, name: string) {
  await page.waitForFunction(() => document.title !== '', undefined, { timeout: 5_000 }).catch(() => undefined)
  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(blocking.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(' | ')})`)).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true, style: '.sticky { position: static !important; }' })
}

async function signIn(page: Page, code: string, withTotp = false) {
  await page.goto('/login')
  await page.getByLabel('อีเมลบริษัท').fill(`${code}@demo.bcs.local`)
  await page.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
  if (withTotp) {
    await expect(page).toHaveURL(/\/login\/2fa$/)
    await page.getByLabel('รหัส 6 หลักจากแอป').fill(totp(deriveSeedTotpSecret(process.env.SEED_TOTP_KEY!, code)))
    await page.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' }).click()
  }
  await expect(page.getByRole('heading', { level: 1 })).toContainText('สวัสดี')
}

const PDF = Buffer.from('%PDF-1.7\n' + 'ใบเสนอราคา'.repeat(4) + '\n%%EOF\n', 'utf8')
const nextStep = (page: Page, name: string) => page.getByRole('button', { name: `ถัดไป: ${name}`, exact: true }).click()

// Each test builds its data in child processes and waits for the background read: three times the default time
test.beforeEach(() => {
  test.setTimeout(90_000)
})

test.afterEach(() => {
  ai('off')
})

test('[FR-AI-303/AC1] [FR-AI-303/AC3] [FR-AI-303/AC8] a quotation read from its file fills the quotation, each value confirmed by the requester', async ({ page }, testInfo) => {
  // AC8: with the AI module off the quotation has no AI button and is filled by hand as before
  ai('off')
  await signIn(page, 'req_con2')
  await page.goto('/requests/new/BUY_GOODS')
  await page.getByLabel('ชื่อคำขอ').fill(`วัสดุตามใบเสนอราคา AI (${testInfo.project.name})`)
  await nextStep(page, 'รายการ ราคา และงบ')
  // The requester's budget line: the one the form chose, or the first offered
  const budget = page.getByLabel('บรรทัดงบที่ใช้')
  if ((await budget.inputValue()) === '') await budget.selectOption({ index: 1 })
  const line = page.getByRole('group', { name: 'รายการที่ 1' })
  await line.getByLabel('สิ่งที่ขอ').fill('สินค้าตามใบเสนอราคา')
  await line.getByLabel(/^จำนวน/).fill('1')
  await line.getByLabel(/^หน่วย/).fill('งาน')
  await line.getByLabel(/^ราคาต่อหน่วย/).fill('5000')
  await nextStep(page, 'ผู้ขายและใบเสนอราคา')
  await page.getByRole('button', { name: 'เพิ่มใบเสนอราคา' }).click()
  const quote = page.getByRole('group', { name: 'ใบเสนอราคาที่ 1' })
  await quote.locator('input[type="file"]').setInputFiles({ name: 'quote-ai.pdf', mimeType: 'application/pdf', buffer: PDF })
  await expect(quote.getByText('ไฟล์: quote-ai.pdf')).toBeVisible()
  await expect(quote.getByRole('button', { name: 'อ่านใบเสนอราคาที่ 1 จากไฟล์' })).toHaveCount(0)
  await expect(page.getByText(/บันทึกร่างแล้ว/).first()).toBeVisible({ timeout: 20_000 })

  // The module on: the draft opened again offers the Document Agent (availability is decided on the server)
  ai('on')
  await page.reload()
  await nextStep(page, 'รายการ ราคา และงบ')
  await nextStep(page, 'ผู้ขายและใบเสนอราคา')
  // An empty quotation is not saved with the draft: the requester adds it and its file again, as on a new form
  await page.getByRole('button', { name: 'เพิ่มใบเสนอราคา' }).click()
  const quoteAgain = page.getByRole('group', { name: 'ใบเสนอราคาที่ 1' })
  await quoteAgain.locator('input[type="file"]').setInputFiles({ name: 'quote-ai.pdf', mimeType: 'application/pdf', buffer: PDF })
  await expect(quoteAgain.getByText('ไฟล์: quote-ai.pdf')).toBeVisible()
  await quoteAgain.getByRole('button', { name: 'อ่านใบเสนอราคาที่ 1 จากไฟล์' }).click()
  await expect(quoteAgain.getByRole('status').filter({ hasText: 'กำลังอ่านเอกสาร' })).toBeVisible()
  expect(ai<{ drafted: number }>('run').drafted).toBeGreaterThanOrEqual(1)

  const box = quoteAgain.getByRole('region', { name: 'ค่าที่ AI อ่านจากใบเสนอราคาที่ 1' })
  await expect(box.getByText('เติมโดย AI โปรดตรวจ')).toBeVisible()
  await expect(quoteAgain.getByLabel('ยอดในใบเสนอราคา (บาท)')).toHaveValue(/5,?000/)
  await expect(quoteAgain.getByLabel('ชื่อผู้ขาย')).not.toHaveValue('')
  // Money and the supplier of the register wait one by one; the rest are confirmed together by the person's own press
  await expect(box.getByText('ช่องนี้ต้องยืนยันทีละช่อง').first()).toBeVisible()
  await check(page, testInfo, 'quotation-ai-read')
  await box.getByRole('button', { name: /ยืนยันค่าที่เหลือทั้งหมด/ }).click()
  const waiting = box.getByRole('checkbox', { checked: false })
  for (let n = await waiting.count(); n > 0; n--) await waiting.first().click()
  await expect(box.getByRole('status').filter({ hasText: 'ยืนยันค่าที่ AI เติมครบแล้ว' })).toBeVisible()
  await check(page, testInfo, 'quotation-ai-confirmed')

  // The next save carries the confirmations: the AI action closes as accepted on this request
  await page.getByRole('button', { name: 'บันทึกร่างตอนนี้' }).click()
  await expect.poll(() => ai<{ status: string; subjectType: string | null }>('state').status, { timeout: 30_000 }).toBe('ACCEPTED')
  expect(ai<{ subjectType: string | null }>('state').subjectType).toBe('REQUEST')
})

test('[FR-AI-303/AC4] a delivery note read on the receiving page fills what came, and the receipt waits for every line to be confirmed', async ({ page }, testInfo) => {
  const run = `a${testInfo.project.name.slice(0, 1)}${Date.now().toString(36)}`
  const po = scene<{ poId: string; number: string; receiver: string }>('receiving-scene', { SCENE_MODE: 'variance', SCENE_RUN: run })
  ai('on')
  await signIn(page, po.receiver, true)
  await page.goto(`/receiving/${po.poId}`)
  const reader = page.getByRole('region', { name: 'อ่านใบส่งของ' })
  await reader.locator('input[type="file"]').setInputFiles({ name: 'delivery-note.pdf', mimeType: 'application/pdf', buffer: PDF })
  await expect(reader.getByRole('status').filter({ hasText: 'กำลังอ่านเอกสาร' })).toBeVisible()
  expect(ai<{ drafted: number }>('run').drafted).toBeGreaterThanOrEqual(1)

  const box = page.getByRole('region', { name: 'จำนวนรับที่ AI อ่านจากใบส่งของ' })
  await expect(box.getByText('เติมโดย AI โปรดตรวจ')).toBeVisible()
  await expect(page.getByLabel('ปูนซีเมนต์ 50 กก.: รับรอบนี้ (ถุง)')).toHaveValue('10')
  await check(page, testInfo, 'receiving-ai-read')

  // Quantities are confirmed one by one; the receipt is refused until they are
  await page.getByRole('button', { name: 'ตรวจสอบก่อนบันทึก' }).click()
  await page.getByRole('button', { name: 'ยืนยันบันทึกการตรวจรับ' }).click()
  await expect(page.getByText('ยังมีจำนวนที่ AI อ่านจากใบส่งของรอคุณยืนยัน')).toBeVisible()
  await page.getByRole('button', { name: 'กลับไปแก้จำนวน' }).click()
  await box.getByRole('checkbox', { name: /ยืนยัน รับ ปูนซีเมนต์ 50 กก\. แล้ว/ }).click()
  await page.getByRole('button', { name: 'ตรวจสอบก่อนบันทึก' }).click()
  await page.getByRole('button', { name: 'ยืนยันบันทึกการตรวจรับ' }).click()
  await expect(page.getByText(/บันทึกการตรวจรับแล้ว/)).toBeVisible()
  const state = ai<{ status: string; subjectType: string | null }>('state')
  expect(state).toMatchObject({ status: 'ACCEPTED', subjectType: 'GOODS_RECEIPT' })
})

test('[FR-AI-302/AC1] [FR-AI-302/AC5] step 0: what the requester wrote fills the request, every value confirmed; with Intake off there is no step 0', async ({ page }, testInfo) => {
  ai('off')
  await signIn(page, 'req_con2')
  await page.goto('/requests/new/BUY_GOODS')
  await expect(page.getByRole('heading', { name: 'ให้ AI ช่วยกรอก (ไม่บังคับ)' })).toHaveCount(0)

  ai('on')
  await page.reload()
  const step0 = page.getByRole('region', { name: 'ให้ AI ช่วยกรอก (ไม่บังคับ)' })
  await step0.getByLabel('สิ่งที่ต้องการ').fill('ขอปูนซีเมนต์ 20 ถุง ถุงละ 150 บาท สำหรับไซต์งาน')
  await step0.getByRole('button', { name: 'ให้ AI ช่วยกรอก' }).click()
  await expect(step0.getByRole('status').filter({ hasText: 'กำลังอ่านเอกสาร' })).toBeVisible()
  expect(ai<{ drafted: number }>('run').drafted).toBeGreaterThanOrEqual(1)

  const box = step0.getByRole('region', { name: 'ค่าที่ AI เติมจากสิ่งที่คุณเขียน' })
  await expect(box.getByText('เติมโดย AI โปรดตรวจ')).toBeVisible()
  await expect(page.getByRole('textbox', { name: /^ชื่อคำขอ/ })).toHaveValue('ปูนซีเมนต์สำหรับไซต์งาน')
  await check(page, testInfo, 'intake-ai-read')
  await box.getByRole('button', { name: /ยืนยันค่าที่เหลือทั้งหมด/ }).click()
  const waiting = box.getByRole('checkbox', { checked: false })
  for (let n = await waiting.count(); n > 0; n--) await waiting.first().click()
  await expect(box.getByRole('status').filter({ hasText: 'ยืนยันค่าที่ AI เติมครบแล้ว' })).toBeVisible()
  await check(page, testInfo, 'intake-ai-confirmed')
  await page.getByRole('button', { name: 'บันทึกร่างตอนนี้' }).click()
  await expect.poll(() => ai<{ status: string }>('state').status, { timeout: 30_000 }).toBe('ACCEPTED')
})

test('[FR-AI-301/AC1] [FR-AI-301/AC3] the decider sees the Brief apart on the decision bar, with the facts and no button of its own', async ({ page }, testInfo) => {
  ai('on')
  const brief = ai<{ taskId: string; assignee: string; result: string }>('brief')
  expect(brief.result).toBe('DRAFT')
  await signIn(page, brief.assignee, true)
  await page.goto(`/tasks/${brief.taskId}`)
  const box = page.getByRole('region', { name: 'สรุปจาก AI' })
  await expect(box.getByText('AI อาจผิดพลาด ตรวจกับเอกสาร')).toBeVisible()
  await expect(box.getByText('ยังไม่มีราคาอ้างอิงของรายการนี้')).toBeVisible()
  await expect(box.getByText(/คำขอนี้ยอด [\d,]+\.\d{2} บาท ตามข้อ /)).toBeVisible()
  await expect(box.getByRole('button')).toHaveCount(0)
  await check(page, testInfo, 'brief-web')
})

test('[FR-AI-309/AC1] [FR-AI-309/AC2] [FR-AI-309/AC5] ⌘K asks BCS AI only while it is on; the answer streams into its sheet', async ({ page }, testInfo) => {
  const question = 'ช่วยแต่งกลอนเรื่องทะเลให้หน่อย'
  ai('off')
  await signIn(page, 'req_con2')
  const openPalette = async () => {
    await page.getByRole('button', { name: /ค้นหา/ }).first().click()
    await page.getByRole('combobox').fill(question)
  }
  await openPalette()
  await expect(page.getByRole('option', { name: `ถาม BCS AI: ${question}` })).toHaveCount(0)
  await page.keyboard.press('Escape')

  ai('on')
  await page.reload()
  await openPalette()
  await page.getByRole('option', { name: `ถาม BCS AI: ${question}` }).click()
  const sheet = page.getByRole('dialog', { name: 'ถาม BCS AI' })
  await expect(sheet.getByText('ถาม BCS AI ตอบได้เฉพาะเรื่องคำขอ งานอนุมัติ งบ ใบสั่งซื้อ และผู้ขายในสิทธิ์ของคุณ')).toBeVisible({ timeout: 20_000 })
  await expect(sheet.getByText(question)).toBeVisible()
  await check(page, testInfo, 'ask-ai')
})

test('[FR-AI-308/AC1] [FR-AI-308/AC3] the DOA drafter: each rule with its source and page, confirmed one by one, then a draft of the admin\'s own', async ({ page }, testInfo) => {
  ai('on')
  const code = testInfo.project.name === 'mobile' ? 'admin2' : 'admin'
  await signIn(page, code, true)
  await page.goto('/admin/doa/ai-draft')
  await expect(page.getByRole('heading', { level: 1, name: 'ร่าง DOA จากระเบียบ' })).toBeVisible()
  await page.locator('input[type="file"]').first().setInputFiles({ name: 'ระเบียบ.pdf', mimeType: 'application/pdf', buffer: PDF })
  await expect(page.getByRole('status').filter({ hasText: 'กำลังอ่านระเบียบ' })).toBeVisible()
  expect(ai<{ drafted: number }>('run').drafted).toBeGreaterThanOrEqual(1)
  await expect(page.getByRole('heading', { name: /ข้อที่ AI ร่าง/ })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('ไม่พบปัญหา')).toBeVisible()
  await check(page, testInfo, 'doa-ai-draft')
  const boxes = page.getByRole('checkbox', { name: /ยืนยันข้อ/ })
  for (let n = await boxes.count(), i = 0; i < n; i++) await boxes.nth(i).click()
  try {
    await page.getByRole('button', { name: 'สร้างฉบับร่าง' }).click()
    await expect(page).toHaveURL(/\/admin\/doa\/[0-9a-f-]{36}$/, { timeout: 20_000 })
  } finally {
    ai('doa-cleanup')
  }
})
