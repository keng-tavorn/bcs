import { spawnSync } from 'node:child_process'
import AxeBuilder from '@axe-core/playwright'
import { type Browser, type Locator, type Page, type TestInfo } from '@playwright/test'
import { e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'

// S2-11 · S3-06 · the screens of S2-17 and of the budget-line choice of S3-07: the catalog, the request form in four
// steps, drafts that save themselves and meet on two devices, quotations and attachments, the budget line's balance and
// the expected route before sending, the confirmation once sent, and a returned request that keeps its reservation.
// Requesters without a role sign in with their password only (FR-AUTH-002 AC1). Screenshots at 375 px (mobile project)
// and 1440 px (desktop project) go to the test output (§9.9 step 4); every screen is checked with axe (step 5).

const PDF = Buffer.from('%PDF-1.7\n' + 'x'.repeat(200) + '\n%%EOF\n', 'latin1')

async function expectNoBlockingAxe(page: Page) {
  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(blocking.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(' | ')})`)).toEqual([])
}

async function shot(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })
}

async function signIn(page: Page, code: string) {
  await page.goto('/login')
  await page.getByLabel('อีเมลบริษัท').fill(`${code}@demo.bcs.local`)
  await page.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('สวัสดี')
}

/** FR-INT-002 AC3: nothing makes the page scroll sideways */
async function expectNoSidewaysScroll(page: Page) {
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }))
  expect(scroll).toBeLessThanOrEqual(client)
}

const nextStep = (page: Page, name: string) => page.getByRole('button', { name: `ไปขั้นถัดไป: ${name}` }).click()
const stepHeading = (page: Page, n: number, name: string, total = 4) => expect(page.getByRole('heading', { level: 2, name: `ขั้นที่ ${n} จาก ${total}: ${name}` })).toBeVisible()
const status = (page: Page, text: string | RegExp) => page.getByRole('status').filter({ hasText: text })
const alert = (page: Page, text: string | RegExp) => page.getByRole('alert').filter({ hasText: text })
const money = (text: string) => BigInt(text.replace(/[^\d]/g, ''))

async function fillLine(group: Locator, item: { description: string; quantity: string; uom: string; price: string }) {
  await group.getByLabel('สิ่งที่ขอ').fill(item.description)
  await group.getByLabel(/^จำนวน/).fill(item.quantity)
  await group.getByLabel(/^หน่วย/).fill(item.uom)
  await group.getByLabel(/^ราคาต่อหน่วย/).fill(item.price)
}

/** Empty controls the requester must fill on the step shown (FR-INT-003 AC3) */
async function emptyRequired(page: Page): Promise<number> {
  return page.locator('main [aria-required="true"]').evaluateAll((els) => els.filter((e) => (e as HTMLInputElement).value === '').length)
}

/** The requester's latest request names this delivery site (a draft made through the services, suppliers-scene.ts) */
function latestSite(requester: string, site: string): void {
  const r = spawnSync(`pnpm exec tsx tests/e2e/suppliers-scene.ts site-draft ${requester} ${site}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`supplier scene failed:\n${r.stdout}\n${r.stderr}`)
}

/** The code of the budget line <member> sent their latest request of <type> on, or null (tests/e2e/form-defaults-scene.ts) */
function lastUsedBudgetLine(member: string, type: string): string | null {
  const r = spawnSync(`pnpm exec tsx tests/e2e/form-defaults-scene.ts ${member} ${type}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`form defaults scene failed:\n${r.stdout}\n${r.stderr}`)
  return (JSON.parse(r.stdout.trim().split('\n').at(-1)!) as { code: string | null }).code
}

/** A request req_con2 sent and its approver returned, made through the services in the e2e database (request-form-scene.ts) */
function returnedRequest(): { requestId: string } {
  const r = spawnSync('pnpm exec tsx tests/e2e/request-form-scene.ts', { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`request form scene failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as { requestId: string }
}

/** After "ส่งขออนุมัติ": the confirmation in the button's own words, with the number, then the request's own page (§9.9 rule 7) */
async function expectSent(page: Page, waitingFor: string | null): Promise<string> {
  const sent = page.getByRole('status').filter({ hasText: 'ส่งขออนุมัติแล้ว' })
  await expect(sent).toBeVisible()
  if (waitingFor) await expect(sent).toContainText(`ส่งขออนุมัติแล้ว รอ ${waitingFor} พิจารณา`)
  await expect(sent).toContainText(/เลขที่คำขอ PR-\d{4}-\d{5}/)
  return (/PR-\d{4}-\d{5}/.exec((await sent.textContent()) ?? '') ?? [''])[0]
}

test('[FR-INT-001/AC1] [FR-INT-001/AC2] @demo the catalog shows each request type with when to use it, and a keyword finds one', async ({ page }, testInfo) => {
  await signIn(page, 'req_con')
  await page.goto('/requests/new')
  await expect(page.getByRole('heading', { level: 1, name: 'ขอซื้อ / ขอจ้าง' })).toBeVisible()
  const starts = page.getByRole('link', { name: /เริ่มคำขอ / })
  await expect(starts).toHaveCount(5)
  await expect(page.getByRole('link', { name: /เริ่มคำขอ ซื้อของ$/ })).toContainText('ใช้เมื่อ: วัสดุ อุปกรณ์ สินค้าทั่วไป')
  await expect(status(page, 'ประเภทคำขอที่เปิดใช้ 5 ประเภท')).toBeVisible()
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'catalog')

  const search = page.getByLabel('ค้นหาประเภทคำขอ')
  await search.fill('ไอที')
  await expect(starts).toHaveCount(1)
  await expect(starts).toContainText('ซื้ออุปกรณ์/ซอฟต์แวร์ไอที')
  await expect(status(page, 'พบ 1 ประเภทที่ตรงกับคำค้น')).toBeVisible()
  await search.fill('เช่า')
  await expect(starts).toHaveCount(1)
  await expect(starts).toContainText('จ้างบริการ')
  await search.fill('เรือดำน้ำ')
  await expect(starts).toHaveCount(0)
  await expect(page.getByText('ไม่พบประเภทคำขอที่ตรงกับ “เรือดำน้ำ”')).toBeVisible()
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'catalog-no-match')
  await page.getByRole('button', { name: 'ล้างคำค้นและดูทุกประเภท' }).click()
  await expect(starts).toHaveCount(5)
  await page.getByRole('link', { name: /เริ่มคำขอ ซื้อของ$/ }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'คำขอใหม่: ซื้อของ' })).toBeVisible()
})

test('[FR-INT-003/AC1] [FR-INT-003/AC2] [FR-INT-004/AC1] [FR-DOA-003/AC2] @demo req_con asks for 45,000 baht on CON-OPEX-2569 and sees the route to the VP of OPS before sending', async ({
  page,
}, testInfo) => {
  // Demo scene 1: req_con's requests go to SITE-A, so the form fills the department, the budget and the site
  latestSite('req_con', 'SITE-A')
  await signIn(page, 'req_con')
  await page.goto('/requests/new/BUY_GOODS')
  await expect(page.getByRole('heading', { level: 1, name: 'คำขอใหม่: ซื้อของ' })).toBeVisible()
  await stepHeading(page, 1, 'รายละเอียดคำขอ')

  // BR-FORM-02: the line req_con used last for this type (other tests may have sent requests of req_con on another
  // line), the department that pays; only CON's own lines are offered; the requester may change the line
  const budgetLine = page.getByLabel('บรรทัดงบที่ใช้')
  const lastUsed = lastUsedBudgetLine('req_con', 'BUY_GOODS')
  await expect(budgetLine.locator('option:checked')).toHaveText(new RegExp(`^${lastUsed ?? 'CON-OPEX-2569'} · `))
  const opex = await budgetLine.locator('option', { hasText: /^CON-OPEX-2569 · / }).getAttribute('value')
  await budgetLine.selectOption(opex!)
  await expect(budgetLine.locator('option:checked')).toHaveText(/^CON-OPEX-2569 · /)
  const offered = await budgetLine.locator('option').allTextContents()
  expect(offered.filter((o) => /^[A-Z]+-/.test(o)).every((o) => o.startsWith('CON-'))).toBe(true)
  await expect(page.getByText('ฝ่ายก่อสร้าง', { exact: true })).toBeVisible()
  await expect(page.getByText('งบคงเหลือของบรรทัดนี้')).toBeVisible()
  await expect(page.getByText(/^[\d,]+\.\d{2} บาท$/).first()).toBeVisible()

  await page.getByLabel('ชื่อคำขอ').fill(`วัสดุก่อสร้างโครงการบางนา (${testInfo.project.name})`)
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'form-details')

  await nextStep(page, 'รายการที่ขอ')
  await stepHeading(page, 2, 'รายการที่ขอ')
  // BR-FORM-02 "สถานที่ส่งล่าสุด": the delivery site of req_con's latest request, which they may change (S4-02)
  await expect(page.getByLabel('สถานที่ส่ง').locator('option:checked')).toHaveText('SITE-A · ไซต์งานตัวอย่าง A')
  await page.getByLabel('ราคาที่กรอกรวม VAT แล้ว').check()
  await fillLine(page.getByRole('group', { name: 'รายการที่ 1' }), { description: 'ปูนซีเมนต์', quantity: '1', uom: 'งาน', price: '45000' })
  // VAT inside a price that includes it = round(45,000 × 700 / 10,700) = 2,943.93 (BR-VAT-03)
  await expect(page.getByText('42,056.07 บาท').first()).toBeVisible()
  await expect(page.getByText('45,000.00 บาท').first()).toBeVisible()
  await expect(page.getByText('งบพอ', { exact: true })).toBeVisible()
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'form-items')

  await nextStep(page, 'ใบเสนอราคาและเอกสาร')
  await expect(page.getByText('ยอดและคำตอบตอนนี้ยังไม่ต้องแนบเอกสาร')).toBeVisible()
  await nextStep(page, 'ตรวจและส่ง')
  await stepHeading(page, 4, 'ตรวจและส่ง')
  // FR-DOA-003 AC2: the expected approver with the engine's Thai explanation, before pressing send
  const route = page.getByRole('region', { name: 'เส้นทางอนุมัติที่คาดไว้' })
  await expect(route.getByText('วีระ ปฏิบัติการ')).toBeVisible()
  await expect(route.getByText('รองประธานสายงาน ของสายปฏิบัติการ')).toBeVisible()
  await expect(route).toContainText('DOA-DEMO ฉบับ 1 ข้อ PR-02')
  await expect(page.getByText('ข้อมูลที่ตรวจได้บนหน้านี้ครบแล้ว กดส่งได้')).toBeVisible()
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'form-review')

  await page.getByRole('button', { name: 'ส่งขออนุมัติ', exact: true }).click()
  // §9.9 rule 7: the confirmation repeats the button's words, with the number and the VP of OPS who decides it now
  const number = await expectSent(page, 'วีระ ปฏิบัติการ')
  await expect(page.getByText('ระบบแจ้งผู้อนุมัติแล้ว ติดตามสถานะได้ที่หน้าคำขอ')).toBeVisible()
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'form-sent')
  await page.getByRole('link', { name: `ดูคำขอ ${number} และติดตามสถานะ` }).click()
  await expect(page).toHaveURL(/\/requests\/[0-9a-f-]{36}$/)
})

test('[FR-INT-004/AC2] over budget, the send button says why and by how much, and cannot send', async ({ page }, testInfo) => {
  await signIn(page, 'req_con2')
  await page.goto('/requests/new/BUY_GOODS')
  await page.getByLabel('ชื่อคำขอ').fill('รถขุดเล็ก')
  // CON has two lines and req_con2 has used none: the requester chooses
  await page.getByLabel('บรรทัดงบที่ใช้').selectOption({ label: 'CON-OPEX-2569 · ค่าใช้จ่ายดำเนินงาน ฝ่ายก่อสร้าง' })
  const remaining = page.locator('div[aria-live="polite"]').filter({ hasText: 'งบคงเหลือของบรรทัดนี้' })
  await expect(remaining).toContainText(/[\d,]+\.\d{2} บาท/)
  const available = money((await remaining.textContent())!.replace('งบคงเหลือของบรรทัดนี้', ''))

  await nextStep(page, 'รายการที่ขอ')
  await fillLine(page.getByRole('group', { name: 'รายการที่ 1' }), { description: 'รถขุดเล็ก', quantity: '1', uom: 'คัน', price: '900,000' })
  const shortfall = 90_000_000n - available
  const shown = (s: bigint) => `${(s / 100n).toLocaleString('en-US')}.${String(s % 100n).padStart(2, '0')}`
  await expect(page.getByText(`งบไม่พอ ขาด ${shown(shortfall)} บาท ลดยอดหรือเลือกบรรทัดงบอื่น`)).toBeVisible()
  await shot(page, testInfo, 'items-over-budget')

  await nextStep(page, 'ใบเสนอราคาและเอกสาร')
  await nextStep(page, 'ตรวจและส่ง')
  const send = page.getByRole('button', { name: 'ส่งขออนุมัติ', exact: true })
  await expect(send).toBeDisabled()
  await expect(page.getByText(`ส่งไม่ได้เพราะงบไม่พอ: คงเหลือ ${shown(available)} บาท ขาด ${shown(shortfall)} บาท`)).toBeVisible()
  await expect(send).toHaveAccessibleDescription(/ส่งไม่ได้เพราะงบไม่พอ/)
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'review-over-budget')
})

test('[FR-INT-002/AC1] [FR-INT-002/AC3] [FR-INT-005/AC5] [FR-PLT-004/AC2] IT: fields follow the answers, and a supplier that processes personal data asks for a DPA', async ({
  page,
  isMobile,
}, testInfo) => {
  await signIn(page, 'req_it')
  // FR-INT-002 AC3: the form works on a 360 px screen without sideways scrolling
  if (isMobile) await page.setViewportSize({ width: 360, height: 800 })
  await page.goto('/requests/new/IT_PURCHASE')
  await page.getByLabel('ชื่อคำขอ').fill(`ไลเซนส์ระบบบัญชี (${testInfo.project.name})`)
  const category = page.getByRole('group', { name: /^หมวด/ })
  await expect(page.getByLabel('เลขทะเบียนทรัพย์สิน')).toHaveCount(0)
  await category.getByLabel('ฮาร์ดแวร์').check()
  await expect(page.getByLabel('เลขทะเบียนทรัพย์สิน')).toBeVisible()
  await category.getByLabel('ซอฟต์แวร์และไลเซนส์').check()
  await expect(page.getByLabel('เลขทะเบียนทรัพย์สิน')).toHaveCount(0)
  // BR-FORM-05: three screening questions
  const personal = page.getByRole('group', { name: /ผู้ขายจะประมวลผลข้อมูลส่วนบุคคลแทนบริษัทหรือไม่/ })
  await expect(page.getByRole('group', { name: /ผู้ขายจะเข้าถึงระบบหรือข้อมูลภายในหรือไม่/ })).toBeVisible()
  await expect(page.getByRole('group', { name: /ผู้ขายจะเข้าพื้นที่ทำงานหรือไซต์งานหรือไม่/ })).toBeVisible()
  await personal.getByLabel('ใช่', { exact: true }).check()
  await page.getByRole('group', { name: /ผู้ขายจะเข้าถึงระบบหรือข้อมูลภายในหรือไม่/ }).getByLabel('ไม่ใช่', { exact: true }).check()
  await page.getByRole('group', { name: /ผู้ขายจะเข้าพื้นที่ทำงานหรือไซต์งานหรือไม่/ }).getByLabel('ไม่ใช่', { exact: true }).check()
  await expectNoSidewaysScroll(page)
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'it-details')

  await nextStep(page, 'รายการที่ขอ')
  const item = page.getByRole('group', { name: 'รายการที่ 1' })
  await fillLine(item, { description: 'ไลเซนส์ระบบบัญชี 1 ปี', quantity: '1', uom: 'ชุด', price: '24000' })
  // Software lines carry the day the service ends
  await item.getByLabel('วันสิ้นสุดบริการ').fill('2027-10-31')
  await expectNoSidewaysScroll(page)
  await shot(page, testInfo, 'it-items')

  await nextStep(page, 'ใบเสนอราคาและเอกสาร')
  const dpaRule = page.locator('[data-rule="ATT-DPA"]')
  await expect(dpaRule).toContainText('ยังไม่ครบ')
  await expect(dpaRule).toContainText('ข้อตกลงการประมวลผลข้อมูล (DPA) อย่างน้อย 1 ไฟล์ (แนบแล้ว 0)')
  await expect(page.getByLabel('ชนิดของไฟล์')).toHaveValue('DPA')
  await page.getByRole('region', { name: 'ไฟล์แนบอื่น' }).locator('input[type="file"]').setInputFiles({ name: 'dpa.pdf', mimeType: 'application/pdf', buffer: PDF })
  await expect(page.getByText('dpa.pdf', { exact: true })).toBeVisible()
  await expect(dpaRule).toContainText('ครบแล้ว')
  await expectNoSidewaysScroll(page)
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'it-documents')

  // FR-PLT-004 AC2: the requester opens the attached file through a short-lived address (the new window is caught so
  // the test reads the address it was sent to)
  await page.evaluate(() => {
    const opened: string[] = []
    Object.assign(window, { __opened: opened })
    window.open = () => ({ opener: null, close: () => undefined, location: { set href(url: string) { opened.push(url) } } }) as unknown as Window
  })
  await page.getByRole('button', { name: 'เปิดไฟล์ dpa.pdf' }).click()
  const openedUrl = () => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened[0] ?? '')
  await expect.poll(openedUrl).toMatch(/X-Amz-Expires=\d+/)
  const href = await openedUrl()
  expect(Number(new URL(href).searchParams.get('X-Amz-Expires'))).toBeLessThanOrEqual(300)
  const download = await page.request.get(href)
  expect(download.status()).toBe(200)
  expect(Buffer.from(await download.body()).equals(PDF)).toBe(true)

  await nextStep(page, 'ตรวจและส่ง')
  await expectNoSidewaysScroll(page)
  await shot(page, testInfo, 'it-review')
})

test('[FR-INT-005/AC1] [FR-INT-005/AC2] [FR-INT-005/AC4] above 100,000 baht: quotations as data, compared before VAT, and what is missing is refused with the rule', async ({
  page,
}, testInfo) => {
  await signIn(page, 'req_con2')
  await page.goto('/requests/new/BUY_GOODS')
  await page.getByLabel('ชื่อคำขอ').fill(`เครื่องผสมปูน (${testInfo.project.name})`)
  await page.getByLabel('บรรทัดงบที่ใช้').selectOption({ label: 'CON-CAPEX-2569 · ลงทุนเครื่องมือและอุปกรณ์ ฝ่ายก่อสร้าง' })
  await nextStep(page, 'รายการที่ขอ')
  await page.getByLabel('ราคาที่กรอกรวม VAT แล้ว').check()
  await fillLine(page.getByRole('group', { name: 'รายการที่ 1' }), { description: 'เครื่องผสมปูน', quantity: '1', uom: 'เครื่อง', price: '107000' })
  await nextStep(page, 'ใบเสนอราคาและเอกสาร')

  // FR-INT-005 AC1: the rule that applies at this amount, why, and what it asks for
  const quotesRule = page.locator('[data-rule="ATT-QUOTES"]')
  await expect(quotesRule).toContainText('ใช้เพราะ ยอดรวม VAT มากกว่า 100,000.00 บาท')
  await expect(quotesRule).toContainText('ยังไม่ครบ')

  const quotation = async (n: number, supplier: string, amount: string, includesVat: boolean) => {
    await page.getByRole('button', { name: 'เพิ่มใบเสนอราคา' }).click()
    const group = page.getByRole('group', { name: `ใบเสนอราคาที่ ${n}` })
    await group.getByLabel('ชื่อผู้ขาย').fill(supplier)
    await group.getByLabel('ยอดในใบเสนอราคา (บาท)').fill(amount)
    if (includesVat) await group.getByLabel('ยอดนี้รวม VAT แล้ว').check()
    await group.locator('input[type="file"]').setInputFiles({ name: `quote-${n}.pdf`, mimeType: 'application/pdf', buffer: PDF })
    await expect(group.getByText(`ไฟล์: quote-${n}.pdf`)).toBeVisible()
    return group
  }
  // One quotation only: the server refuses with the rule's code (AC2)
  const a = await quotation(1, 'ผู้ขาย A', '107000', true)
  await a.getByLabel('เลือกใช้ใบเสนอราคาที่ 1').check()
  await nextStep(page, 'ตรวจและส่ง')
  await expect(page.getByText('เอกสารแนบยังไม่ครบตามกฎ ATT-QUOTES')).toBeVisible()
  await page.getByRole('button', { name: 'ส่งขออนุมัติ', exact: true }).click()
  await expect(alert(page, 'แนบเอกสารยังไม่ครบตามกฎ ATT-QUOTES: ขาด ใบเสนอราคา 3 ไฟล์ (มี 1)')).toBeVisible()
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'review-attachment-rule')

  // GC-FORM-09: A 107,000 incl. VAT, B 101,000 without, C 105,000 incl. VAT — compared before VAT as they are typed
  await page.getByRole('button', { name: 'ไปแก้ที่ขั้น ใบเสนอราคาและเอกสาร' }).first().click()
  const b = await quotation(2, 'ผู้ขาย B', '101000', false)
  const c = await quotation(3, 'ผู้ขาย C', '105000', true)
  await expect(a).toContainText('ยอดก่อน VAT 100,000.00 บาท')
  await expect(b).toContainText('ยอดก่อน VAT 101,000.00 บาท')
  await expect(c).toContainText('ยอดก่อน VAT 98,130.84 บาท')
  await expect(c).toContainText('ต่ำสุดก่อน VAT')
  await expect(a).not.toContainText('ต่ำสุดก่อน VAT')
  await expect(quotesRule).toContainText('ครบแล้ว')
  // A is chosen but is not the lowest: a reason is asked for (BR-FORM-06)
  await expect(page.getByLabel('เหตุผลที่ไม่เลือกรายที่ต่ำสุด')).toBeVisible()
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'quotations')

  // GC-FORM-10: sent without the reason, the server refuses with QUOTE-LOWEST
  await nextStep(page, 'ตรวจและส่ง')
  await page.getByRole('button', { name: 'ส่งขออนุมัติ', exact: true }).click()
  await expect(alert(page, 'ใบเสนอราคาที่เลือกไม่ใช่ยอดก่อน VAT ต่ำสุด (กฎ QUOTE-LOWEST)')).toBeVisible()
  // GC-FORM-11: with a reason it goes
  await page.getByRole('button', { name: 'ไปแก้ที่ขั้น ใบเสนอราคาและเอกสาร' }).first().click()
  await page.getByLabel('เหตุผลที่ไม่เลือกรายที่ต่ำสุด').fill('ส่งของได้เร็วกว่า 2 สัปดาห์')
  await nextStep(page, 'ตรวจและส่ง')
  await page.getByRole('button', { name: 'ส่งขออนุมัติ', exact: true }).click()
  await expectSent(page, null)
})

test('[FR-INT-006/AC1] [FR-INT-009/AC2] a returned request keeps its reservation: taking a line away asks first and says what goes back', async ({ page }, testInfo) => {
  const { requestId } = returnedRequest()
  await signIn(page, 'req_con2')
  await page.goto(`/requests/${requestId}/edit`)
  await expect(page.getByRole('heading', { level: 1, name: 'แก้ไขคำขอที่ถูกตีกลับ: ซื้อของ' })).toBeVisible()
  await expect(page.getByText('ผู้อนุมัติตีกลับให้แก้ไข: แยกรายการปูนออกเป็นคำขอใหม่')).toBeVisible()
  await nextStep(page, 'รายการที่ขอ')
  const cement = page.getByRole('group', { name: 'รายการที่ 1', exact: true })
  await expect(cement.getByLabel('สิ่งที่ขอ')).toHaveValue('ปูนซีเมนต์')

  // Taking it away is a danger button that asks first, saying the line's own share goes back once saved (§6.4)
  await cement.getByRole('button', { name: 'ลบรายการที่ 1' }).click()
  const question = page.getByRole('group', { name: 'ลบรายการที่ 1 ออกจากคำขอ?' })
  await expect(question).toContainText('รายการนี้จองงบไว้ 12,000.00 บาท')
  await expect(question.getByText('ลบรายการที่ 1 ออกจากคำขอ?')).toBeFocused()
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'returned-remove-line')
  await question.getByRole('button', { name: 'ไม่ลบ เก็บรายการไว้' }).click()
  await expect(page.getByRole('group', { name: 'รายการที่ 2', exact: true })).toBeVisible()
  await expect(cement.getByRole('button', { name: 'ลบรายการที่ 1' })).toBeFocused()

  // Taken away for real: the other line stays with its own content
  await cement.getByRole('button', { name: 'ลบรายการที่ 1' }).click()
  await page.getByRole('group', { name: 'ลบรายการที่ 1 ออกจากคำขอ?' }).getByRole('button', { name: 'ลบรายการนี้' }).click()
  await expect(page.getByRole('group', { name: 'รายการที่ 2', exact: true })).toHaveCount(0)
  await expect(page.getByRole('group', { name: 'รายการที่ 1', exact: true }).getByLabel('สิ่งที่ขอ')).toHaveValue('ทราย')
  await page.getByRole('button', { name: 'บันทึกร่างตอนนี้' }).click()
  await expect(status(page, /^บันทึกร่างแล้ว/)).toBeVisible()
  // Opened again: only the sand is left, and it is still a returned request to send again
  await page.reload()
  await nextStep(page, 'รายการที่ขอ')
  await expect(page.getByRole('group', { name: /^รายการที่ \d+$/ })).toHaveCount(1)
  await expect(page.getByRole('group', { name: 'รายการที่ 1', exact: true }).getByLabel('สิ่งที่ขอ')).toHaveValue('ทราย')
})

test('[FR-INT-006/AC1] a draft saves itself 10 seconds after typing stops, and when the requester leaves the page', async ({ page }, testInfo) => {
  await signIn(page, 'asst_con')
  await page.goto('/requests/new/BUY_GOODS')
  await expect(status(page, 'ร่างจะถูกบันทึกให้อัตโนมัติเมื่อคุณเริ่มกรอก')).toBeVisible()
  const title = `ร่างบันทึกเอง ${testInfo.project.name} ${Date.now()}`
  await page.getByLabel('ชื่อคำขอ').fill(title)
  const stopped = Date.now()
  await expect(status(page, 'มีการแก้ไขที่ยังไม่บันทึก')).toBeVisible()
  await expect(status(page, /^บันทึกร่างแล้ว/)).toBeVisible({ timeout: 25_000 })
  expect(Date.now() - stopped).toBeGreaterThanOrEqual(9_000)
  // The draft has its own address now and opens again with what was typed
  await expect(page).toHaveURL(/\/requests\/[0-9a-f-]{36}\/edit$/)
  const editUrl = page.url()
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: 'ร่างคำขอ: ซื้อของ' })).toBeVisible()
  await expect(page.getByLabel('ชื่อคำขอ')).toHaveValue(title)
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'draft-saved')

  // Leaving at once, without waiting: the change is saved on the way out
  await page.getByLabel('ชื่อคำขอ').fill(`${title} แก้ก่อนออก`)
  await page.getByRole('link', { name: 'กลับไปหน้าเลือกประเภทคำขอ' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'ขอซื้อ / ขอจ้าง' })).toBeVisible()
  await expect(async () => {
    await page.goto(editUrl)
    await expect(page.getByLabel('ชื่อคำขอ')).toHaveValue(`${title} แก้ก่อนออก`, { timeout: 1_000 })
  }).toPass({ timeout: 15_000 })
  // The catalog offers to go on with it, on any device
  await page.goto('/requests/new')
  await expect(page.getByRole('link', { name: `ทำต่อ: ${title} แก้ก่อนออก` })).toBeVisible()
  await shot(page, testInfo, 'catalog-drafts')
})

async function secondDevice(browser: Browser, testInfo: TestInfo): Promise<Page> {
  const use = testInfo.project.use
  const context = await browser.newContext({
    baseURL: use.baseURL,
    viewport: use.viewport,
    locale: use.locale,
    timezoneId: use.timezoneId,
    isMobile: use.isMobile,
    hasTouch: use.hasTouch,
    userAgent: use.userAgent,
    deviceScaleFactor: use.deviceScaleFactor,
    // A client address of its own (as tests/e2e/fixtures.ts gives each test), so sign-in limits never mix
    extraHTTPHeaders: { 'x-forwarded-for': `198.19.250.${testInfo.project.name === 'mobile' ? 2 : 1}` },
  })
  return context.newPage()
}

test('[FR-INT-006/AC2] the same draft open on two devices: the second save is refused and offers the latest version', async ({ page, browser }, testInfo) => {
  await signIn(page, 'asst_con')
  await page.goto('/requests/new/BUY_GOODS')
  await page.getByLabel('ชื่อคำขอ').fill(`ร่างสองเครื่อง ${testInfo.project.name}`)
  await page.getByRole('button', { name: 'บันทึกร่างตอนนี้' }).click()
  await expect(status(page, /^บันทึกร่างแล้ว/)).toBeVisible()
  await expect(page).toHaveURL(/\/edit$/)
  const editUrl = page.url()

  const other = await secondDevice(browser, testInfo)
  try {
    await signIn(other, 'asst_con')
    await other.goto(editUrl)
    await expect(other.getByLabel('ชื่อคำขอ')).toHaveValue(`ร่างสองเครื่อง ${testInfo.project.name}`)

    await page.getByLabel('ชื่อคำขอ').fill('แก้จากเครื่อง A')
    await page.getByRole('button', { name: 'บันทึกร่างตอนนี้' }).click()
    await expect(status(page, /^บันทึกร่างแล้ว/)).toBeVisible()

    await other.getByLabel('ชื่อคำขอ').fill('แก้จากเครื่อง B')
    await other.getByRole('button', { name: 'บันทึกร่างตอนนี้' }).click()
    await expect(alert(other, 'ร่างนี้ถูกแก้จากอุปกรณ์หรือแท็บอื่นหลังจากที่คุณเปิดไว้')).toBeVisible()
    await expectNoBlockingAxe(other)
    await shot(other, testInfo, 'draft-conflict')
    await other.getByRole('button', { name: 'โหลดฉบับล่าสุด' }).click()
    await expect(other.getByLabel('ชื่อคำขอ')).toHaveValue('แก้จากเครื่อง A')
  } finally {
    await other.context().close()
  }
})

test('[FR-INT-003/AC3] a purchase of general goods asks the requester to fill in at most 6 fields', async ({ page }) => {
  await signIn(page, 'req_con')
  await page.goto('/requests/new/BUY_GOODS')
  await stepHeading(page, 1, 'รายละเอียดคำขอ')
  let fields = await emptyRequired(page)
  await nextStep(page, 'รายการที่ขอ')
  fields += await emptyRequired(page)
  await nextStep(page, 'ใบเสนอราคาและเอกสาร')
  fields += await emptyRequired(page)
  // Title, then item, quantity, unit and price; the budget line and the department are filled from the context
  expect(fields).toBe(5)
  expect(fields).toBeLessThanOrEqual(6)
})
