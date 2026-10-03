import { spawnSync } from 'node:child_process'
import { type Browser, type Page, type TestInfo } from '@playwright/test'
import { e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'
import { expectNoBlockingAxe, shot, signIn } from './tasks-support'

// S4-02 and S4-15 on screen (FR-SUP-001 AC1–AC3, §9.1 /suppliers): PROCUREMENT adds a supplier by typing its 13-digit
// tax id — the Revenue Department and DBD (the stub, BR-SUP-05) fill the name, address, branch, VAT and juristic status
// to confirm before saving; when they cannot confirm it, PROCUREMENT confirms with proof; the register is searched by
// name, tax id or code and shows the Express vendor code gaps (BR-EXP-04); every member sees names and basic details
// only, and an AUDITOR sees an individual's tax id masked (BR-AUTH-04). Each Playwright project has its own people and
// tax ids, so desktop and mobile never meet in the shared database. Screenshots at 375 px (mobile) and 1440 px
// (desktop) go to the test output (§9.9 step 4); every screen is checked with axe (step 5).

const PDF = Buffer.from('%PDF-1.7\n' + 'x'.repeat(200) + '\n%%EOF\n', 'latin1')

/** The people and tax ids of each project (TOTP codes never repeat; created suppliers never clash) */
function castOf(testInfo: TestInfo) {
  return testInfo.project.name === 'mobile'
    ? { procurement: 'dm_proc', basic: 'req_it', finance: 'dm_fin', newTaxId: '0999999000101', newName: 'บริษัท ขนส่งทดสอบ จำกัด', newVat: 'ไม่ได้จดทะเบียน VAT', unconfirmed: '0999999000128', unconfirmedText: 'ไม่พบเลขนี้ในทะเบียน' }
    : { procurement: 'proc_officer', basic: 'req_con', finance: 'fin_officer', newTaxId: '0999999000098', newName: 'บริษัท เครื่องมือช่างทดสอบ จำกัด', newVat: 'จดทะเบียน VAT', unconfirmed: '0999999000080', unconfirmedText: 'บริการของกรมสรรพากรหรือ DBD ไม่ตอบในตอนนี้' }
}

function scene<T>(...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/suppliers-scene.ts ${args.map((a) => `"${a}"`).join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`supplier scene failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}

/** §9.9: nothing makes the page scroll sideways */
async function expectNoSidewaysScroll(page: Page) {
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }))
  expect(scroll).toBeLessThanOrEqual(client)
}

async function check(page: Page, testInfo: TestInfo, name: string) {
  await expectNoSidewaysScroll(page)
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, name)
}

const unique = (prefix: string) => `${prefix}-${Date.now().toString(36).toUpperCase()}`
const stepHeading = (page: Page, n: number, name: string) => expect(page.getByRole('heading', { level: 2, name: `ขั้นที่ ${n} จาก 3: ${name}` })).toBeVisible()
const nextStep = (page: Page, name: string) => page.getByRole('button', { name: `ไปขั้นถัดไป: ${name}` }).click()
const result = (page: Page) => page.getByRole('region', { name: 'ผลการค้นทะเบียน' })
const lookup = (page: Page) => page.getByRole('button', { name: /^(ค้นข้อมูลจากกรมสรรพากรและ DBD|ค้นอีกครั้ง)$/ }).click()
/** The tax id box (the choice "ผู้ขายในประเทศไทย มีเลขประจำตัวผู้เสียภาษี 13 หลัก" names it too) */
const taxIdField = (page: Page) => page.getByRole('textbox', { name: /^เลขประจำตัวผู้เสียภาษี/ })

async function asMember(browser: Browser, testInfo: TestInfo, code: string, withTotp: boolean): Promise<Page> {
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
    extraHTTPHeaders: { 'x-forwarded-for': `198.19.251.${(code.length * 7 + (testInfo.project.name === 'mobile' ? 101 : 3)) % 250 + 1}` },
  })
  const page = await context.newPage()
  await signIn(page, code, withTotp)
  return page
}

test('@demo [FR-SUP-001/AC1] [FR-SUP-001/AC3] [S4-02] procurement types a 13-digit tax id and the Revenue Department and DBD fill the supplier to confirm before saving', async ({ page }, testInfo) => {
  const cast = castOf(testInfo)
  await signIn(page, cast.procurement, true)
  await page.goto('/suppliers')
  await expect(page.getByRole('heading', { level: 1, name: 'ผู้ขาย' })).toBeVisible()
  await page.getByRole('link', { name: 'เพิ่มผู้ขาย' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'เพิ่มผู้ขาย' })).toBeVisible()
  // FR-SUP-001 AC3: the screen says the registry is the stub, so nobody takes it for the real services
  await expect(page.getByText('โหมดทดสอบ: ข้อมูลทะเบียนมาจากระบบจำลอง')).toBeVisible()
  await stepHeading(page, 1, 'ตรวจตัวตนผู้ขาย')

  // BR-TAXID-01 as it is typed: a wrong check digit shows at once, and the lookup refuses it
  await taxIdField(page).fill('0999999000099')
  await expect(page.getByText('เลขนี้ไม่ถูกต้อง หลักสุดท้ายไม่ตรงกับเลขตรวจสอบ')).toBeVisible()

  // A supplier of the seed: the registries fill it, and the register says it has it already (S4-15 done-when)
  await taxIdField(page).fill('0-9999-99000-01-2')
  await expect(page.getByText('เลขถูกต้อง เป็นนิติบุคคล')).toBeVisible()
  await lookup(page)
  await expect(result(page)).toContainText('บริษัท วัสดุก่อสร้างทดสอบ จำกัด')
  await expect(result(page)).toContainText('มีผู้ขายเลขนี้และสาขานี้ในทะเบียนแล้ว: S1')
  await expect(result(page).getByRole('link', { name: 'เปิดผู้ขาย S1' })).toBeVisible()
  await check(page, testInfo, 'supplier-new-existing')
  await nextStep(page, 'ข้อมูลผู้ขาย')
  await expect(page.getByRole('alert').filter({ hasText: 'ผู้ขายรายนี้มีในทะเบียนแล้ว' })).toBeVisible()

  // A company that is not in the register yet: name, address, branch, VAT and juristic status come from the registries
  await taxIdField(page).fill(cast.newTaxId)
  await lookup(page)
  const found = result(page)
  await expect(found).toContainText('พบข้อมูลในทะเบียน ระบบเติมชื่อ ที่อยู่ และสถานะ VAT ให้ในขั้นถัดไป')
  await expect(found).toContainText(cast.newName)
  await expect(found).toContainText('ถนนทดสอบ แขวงทดสอบ เขตทดสอบ กรุงเทพมหานคร')
  await expect(found).toContainText('สำนักงานใหญ่ (00000)')
  await expect(found).toContainText(cast.newVat)
  await expect(found).toContainText('ยังดำเนินกิจการอยู่')
  await expect(found).toContainText('ระบบจำลอง ไม่ได้เรียกบริการจริง')
  await check(page, testInfo, 'supplier-new-found')

  await nextStep(page, 'ข้อมูลผู้ขาย')
  await stepHeading(page, 2, 'ข้อมูลผู้ขาย')
  await expect(page.getByLabel('ชื่อผู้ขาย')).toHaveValue(cast.newName)
  await expect(page.getByLabel('ที่อยู่')).toHaveValue(/ถนนทดสอบ/)
  await expect(page.getByRole('radio', { name: cast.newVat, exact: true })).toBeChecked()
  await page.getByLabel('หมวด').fill('เครื่องมือช่าง')
  await check(page, testInfo, 'supplier-new-details')

  await nextStep(page, 'รหัสและการติดต่อ')
  await stepHeading(page, 3, 'รหัสและการติดต่อ')
  // The next code of the register is offered; this run uses its own so a second run cannot clash
  await expect(page.getByLabel('รหัสผู้ขาย')).toHaveValue(/^S\d+$/)
  const code = unique('SN')
  await page.getByLabel('รหัสผู้ขาย').fill(code)
  await page.getByLabel('รหัสเจ้าหนี้ Express').fill('V-E2E-1')
  await page.getByLabel('อีเมลรับใบสั่งซื้อ').fill('po@supplier.test')
  const summary = page.getByRole('region', { name: 'ตรวจก่อนบันทึก' })
  await expect(summary).toContainText(cast.newName)
  await expect(summary).toContainText('ตรวจกับทะเบียน ระบบตรวจอีกครั้งตอนบันทึก')
  await check(page, testInfo, 'supplier-new-codes')

  await page.getByRole('button', { name: 'บันทึกผู้ขาย' }).click()
  await expect(page).toHaveURL(/\/suppliers\/[0-9a-f-]{36}\?created=1$/)
  await expect(page.getByRole('status').filter({ hasText: 'บันทึกผู้ขายแล้ว' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 1, name: cast.newName })).toBeVisible()
  const registry = page.getByRole('region', { name: 'การตรวจตัวตน' })
  await expect(registry).toContainText('ตรวจกับทะเบียนแล้ว (ระบบจำลอง)')
  await expect(registry).toContainText('ยังดำเนินกิจการอยู่')
  await expect(registry).toContainText('กรมสรรพากร: พบข้อมูล · DBD: พบข้อมูล')
  await expect(registry).toContainText('ไม่ได้เรียกบริการจริงของกรมสรรพากรและ DBD')
  await check(page, testInfo, 'supplier-created')

  // The register finds it by its tax id written with dashes
  await page.goto(`/suppliers?q=${encodeURIComponent(`${cast.newTaxId.slice(0, 1)}-${cast.newTaxId.slice(1, 5)}-${cast.newTaxId.slice(5, 10)}-${cast.newTaxId.slice(10, 12)}-${cast.newTaxId.slice(12)}`)}`)
  await expect(page.getByRole('list', { name: 'รายชื่อผู้ขาย' }).getByRole('listitem').filter({ hasText: code })).toContainText('รหัสเจ้าหนี้ Express V-E2E-1')
})

test('[FR-SUP-001/AC2] when the registries cannot confirm a supplier, procurement confirms it with proof; an individual is checked at the Revenue Department only', async ({ page }, testInfo) => {
  const cast = castOf(testInfo)
  await signIn(page, cast.procurement, true)
  await page.goto('/suppliers/new')

  // BR-SUP-02: an individual is not in DBD
  await taxIdField(page).fill('1234567890121')
  await expect(page.getByText('เลขถูกต้อง เป็นบุคคลธรรมดา ระบบตรวจกับกรมสรรพากรอย่างเดียว')).toBeVisible()
  await lookup(page)
  await expect(result(page)).toContainText('นายทดสอบ ผู้รับจ้าง')
  await expect(result(page)).toContainText('ไม่ตรวจ บุคคลธรรมดาไม่มีในทะเบียน DBD')
  await expect(result(page)).toContainText('บุคคลธรรมดาตรวจได้เฉพาะกับกรมสรรพากร')
  await check(page, testInfo, 'supplier-new-individual')

  // BR-SUP-03: the services do not answer (desktop) or do not know the number (mobile): no way on without proof
  await taxIdField(page).fill(cast.unconfirmed)
  await lookup(page)
  await expect(result(page)).toContainText(cast.unconfirmedText)
  await nextStep(page, 'ข้อมูลผู้ขาย')
  await expect(page.getByRole('alert').filter({ hasText: 'ทะเบียนยืนยันผู้ขายรายนี้ไม่ได้ แนบหลักฐานก่อนไปขั้นถัดไป' })).toBeVisible()
  await check(page, testInfo, 'supplier-new-unconfirmed')
  const proof = page.getByRole('region', { name: 'ยืนยันเองพร้อมหลักฐาน' })
  await proof.locator('input[type="file"]').setInputFiles({ name: 'proof.pdf', mimeType: 'application/pdf', buffer: PDF })
  await expect(proof.getByText('หลักฐาน: proof.pdf')).toBeVisible()

  await nextStep(page, 'ข้อมูลผู้ขาย')
  await stepHeading(page, 2, 'ข้อมูลผู้ขาย')
  await expect(page.getByLabel('ชื่อผู้ขาย')).toHaveValue('')
  await nextStep(page, 'รหัสและการติดต่อ')
  await expect(page.getByText('ใส่ชื่อผู้ขาย')).toBeVisible()
  await expect(page.getByText('เลือกว่าผู้ขายจดทะเบียน VAT หรือไม่')).toBeVisible()
  const name = `บริษัท ยืนยันเองทดสอบ ${testInfo.project.name}`
  await page.getByLabel('ชื่อผู้ขาย').fill(name)
  await page.getByRole('radio', { name: 'จดทะเบียน VAT', exact: true }).check()
  await nextStep(page, 'รหัสและการติดต่อ')
  await page.getByLabel('รหัสผู้ขาย').fill(unique('SM'))
  await expect(page.getByRole('region', { name: 'ตรวจก่อนบันทึก' })).toContainText('ยืนยันเองพร้อมหลักฐาน proof.pdf')
  await page.getByRole('button', { name: 'บันทึกผู้ขาย' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'บันทึกผู้ขายแล้ว' })).toBeVisible()
  const registry = page.getByRole('region', { name: 'การตรวจตัวตน' })
  await expect(registry).toContainText('ยืนยันเองพร้อมหลักฐาน')
  await expect(registry.getByText('proof.pdf', { exact: true })).toBeVisible()
  await check(page, testInfo, 'supplier-manual-proof')

  // FR-PLT-004 AC2: the proof opens through a short-lived address (the new window is caught so the test reads it)
  await page.evaluate(() => {
    const opened: string[] = []
    Object.assign(window, { __opened: opened })
    window.open = () => ({ opener: null, close: () => undefined, location: { set href(url: string) { opened.push(url) } } }) as unknown as Window
  })
  await page.getByRole('button', { name: 'เปิดไฟล์ proof.pdf' }).click()
  const openedUrl = () => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened[0] ?? '')
  await expect.poll(openedUrl).toMatch(/X-Amz-Expires=\d+/)
  const download = await page.request.get(await openedUrl())
  expect(download.status()).toBe(200)
  expect(Buffer.from(await download.body()).equals(PDF)).toBe(true)
})

test('[S4-02] the register: search by name, tax id or code; procurement adds the Express vendor code and deactivates a supplier after a question', async ({ page }, testInfo) => {
  const cast = castOf(testInfo)
  const made = scene<{ id: string; code: string; nameTh: string; branchCode: string }>('supplier', cast.procurement, 'นายช่าง ซ่อมบำรุง')
  await signIn(page, cast.procurement, true)
  await page.goto('/suppliers')
  const list = page.getByRole('list', { name: 'รายชื่อผู้ขาย' })
  await expect(list.getByRole('listitem').filter({ hasText: 'บริษัท วัสดุก่อสร้างทดสอบ จำกัด' })).toContainText('รหัสเจ้าหนี้ Express V0001')
  await check(page, testInfo, 'suppliers-list')

  // By code, by part of a tax id, and the suppliers the Express file would leave out (BR-EXP-04)
  const search = page.getByLabel('ค้นหาผู้ขาย')
  await search.fill(made.code)
  await page.getByRole('button', { name: 'แสดงผู้ขายที่ตรงกัน' }).click()
  await expect(list.getByRole('listitem')).toHaveCount(1)
  await expect(page.getByRole('status').filter({ hasText: /^พบ 1 จาก \d+ ราย$/ })).toBeVisible()
  await search.fill('0999999000021')
  await page.getByRole('button', { name: 'แสดงผู้ขายที่ตรงกัน' }).click()
  await expect(list.getByRole('listitem')).toHaveCount(1)
  await expect(list).toContainText('บริษัท ไอทีทดสอบ จำกัด')
  await search.fill('')
  await page.getByLabel('เฉพาะที่ยังไม่มีรหัสเจ้าหนี้ Express').check()
  await page.getByRole('button', { name: 'แสดงผู้ขายที่ตรงกัน' }).click()
  await expect(page).toHaveURL(/missing=1/)
  const row = list.getByRole('listitem').filter({ hasText: made.code })
  await expect(row).toContainText('ยังไม่มีรหัสเจ้าหนี้ Express')
  await expect(row).toContainText('เลขผู้เสียภาษี 1-2345-67890-12-1')
  await expect(list.getByRole('listitem').filter({ hasText: 'V0001' })).toHaveCount(0)
  // Nothing found says what to do next
  await search.fill('ไม่มีผู้ขายชื่อนี้แน่นอน')
  await page.getByRole('button', { name: 'แสดงผู้ขายที่ตรงกัน' }).click()
  await expect(page.getByText('ไม่พบผู้ขายที่ตรงกับเงื่อนไข')).toBeVisible()
  await check(page, testInfo, 'suppliers-none')

  await page.goto(`/suppliers/${made.id}`)
  await expect(page.getByRole('heading', { level: 1, name: made.nameTh })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'ผู้ขายรายนี้ยังไม่มีรหัสเจ้าหนี้ Express' })).toBeVisible()
  const codes = page.getByRole('region', { name: 'รหัสเจ้าหนี้และการติดต่อ' })
  await codes.getByLabel('รหัสเจ้าหนี้ Express').fill('V-E2E-9')
  await codes.getByRole('button', { name: 'บันทึกรหัสและการติดต่อ' }).click()
  await expect(codes.getByRole('status').filter({ hasText: 'บันทึกรหัสและการติดต่อแล้ว' })).toBeVisible()
  // A second form of the page saves on top of the first one's version
  const details = page.getByRole('region', { name: 'แก้ไขข้อมูลผู้ขาย' })
  await details.getByLabel('หมวด').fill('งานซ่อมบำรุงและติดตั้ง')
  await details.getByRole('button', { name: 'บันทึกข้อมูลผู้ขาย' }).click()
  await expect(details.getByRole('status').filter({ hasText: 'บันทึกข้อมูลผู้ขายแล้ว' })).toBeVisible()
  await details.getByRole('button', { name: 'บันทึกข้อมูลผู้ขาย' }).click()
  await expect(details.getByRole('alert').filter({ hasText: 'ยังไม่มีอะไรเปลี่ยน' })).toBeVisible()
  await check(page, testInfo, 'supplier-edit')

  // Deactivating asks first and says what follows; activating again needs no question
  const status = page.getByRole('region', { name: 'สถานะผู้ขาย' })
  await status.getByRole('button', { name: 'เลิกใช้ผู้ขายรายนี้' }).click()
  const question = page.getByRole('group', { name: `เลิกใช้ ${made.nameTh}?` })
  await expect(question).toContainText('ร่างใบสั่งซื้อของผู้ขายรายนี้ส่งขออนุมัติไม่ได้')
  await check(page, testInfo, 'supplier-deactivate-question')
  await question.getByRole('button', { name: 'ยืนยันเลิกใช้ผู้ขาย' }).click()
  await expect(status.getByRole('status').filter({ hasText: 'เลิกใช้ผู้ขายแล้ว' })).toBeVisible()
  await expect(page.locator('#content header').getByText('เลิกใช้แล้ว', { exact: true })).toBeVisible()
  await status.getByRole('button', { name: 'เปิดใช้ผู้ขายรายนี้อีกครั้ง' }).click()
  await expect(status.getByRole('status').filter({ hasText: 'เปิดใช้ผู้ขายอีกครั้งแล้ว' })).toBeVisible()
  await expect(page.locator('#content header').getByText('ใช้งานอยู่', { exact: true })).toBeVisible()
})

test('[S4-02] every member sees names and basic details only; finance sees the Express code gaps; an auditor sees an individual’s tax id masked', async ({ page, browser }, testInfo) => {
  const cast = castOf(testInfo)
  const made = scene<{ id: string; code: string; nameTh: string }>('supplier', cast.procurement, 'นายช่าง ไม้')

  // A requester: names and basic details, no tax id, no way to add (supplier.manage is PROCUREMENT's)
  await signIn(page, cast.basic, false)
  await page.goto('/suppliers')
  await expect(page.getByText('รายชื่อผู้ขายในทะเบียนขององค์กร ใช้ดูชื่อและรหัสเมื่อแนะนำผู้ขายในคำขอ')).toBeVisible()
  await expect(page.getByRole('link', { name: 'เพิ่มผู้ขาย' })).toHaveCount(0)
  await expect(page.getByLabel('เฉพาะที่ยังไม่มีรหัสเจ้าหนี้ Express')).toHaveCount(0)
  await expect(page.getByRole('list', { name: 'รายชื่อผู้ขาย' })).not.toContainText('เลขผู้เสียภาษี')
  await check(page, testInfo, 'suppliers-basic')
  await page.goto(`/suppliers/${made.id}`)
  await expect(page.getByText('คุณเห็นชื่อและข้อมูลพื้นฐานของผู้ขาย')).toBeVisible()
  await expect(page.getByText('1-2345-67890-12-1')).toHaveCount(0)
  await expect(page.locator('main form')).toHaveCount(0)
  await check(page, testInfo, 'supplier-basic')
  await page.goto('/suppliers/new')
  await expect(page.getByRole('heading', { level: 1, name: 'เพิ่มผู้ขายไม่ได้' })).toBeVisible()
  await expect(page.getByText('เพิ่มผู้ขายได้เฉพาะฝ่ายจัดซื้อ')).toBeVisible()
  await expect(taxIdField(page)).toHaveCount(0)
  await check(page, testInfo, 'supplier-new-forbidden')

  // Finance sees everything but edits nothing; a missing Express code says whom to ask
  const finance = await asMember(browser, testInfo, cast.finance, true)
  try {
    await finance.goto(`/suppliers/${made.id}`)
    await expect(finance.getByText('1-2345-67890-12-1')).toBeVisible()
    await expect(finance.getByText('แจ้งฝ่ายจัดซื้อให้เติมรหัส')).toBeVisible()
    await expect(finance.locator('main form')).toHaveCount(0)
    await check(finance, testInfo, 'supplier-finance')
  } finally {
    await finance.context().close()
  }

  // BR-AUTH-04: an AUDITOR reads an individual's tax id (their national id number) masked
  const auditor = await asMember(browser, testInfo, 'auditor', true)
  try {
    await auditor.goto(`/suppliers/${made.id}`)
    await expect(auditor.getByText('X-XXXX-XXXX0-12-1')).toBeVisible()
    await expect(auditor.getByText('ปิดบางหลัก เพราะเป็นเลขประจำตัวประชาชนของบุคคลธรรมดา')).toBeVisible()
    await expect(auditor.getByText('1-2345-67890-12-1')).toHaveCount(0)
    await check(auditor, testInfo, 'supplier-auditor')

    // ...and cannot find it by its hidden digits; the whole number, typed from a document, finds it still masked
    const row = (p: Page) => p.getByRole('list', { name: 'รายชื่อผู้ขาย' }).getByRole('listitem').filter({ hasText: made.code })
    await auditor.goto(`/suppliers?q=${encodeURIComponent('67890-12')}`)
    await expect(auditor.getByText('เลขของบุคคลธรรมดาต้องพิมพ์ครบ 13 หลักจึงค้นพบ')).toBeVisible()
    await expect(auditor.getByRole('status').filter({ hasText: /^พบ \d+ จาก \d+ ราย$/ })).toBeVisible()
    await expect(row(auditor)).toHaveCount(0)
    await auditor.goto(`/suppliers?q=${encodeURIComponent('1-2345-67890-12-1')}`)
    await expect(row(auditor)).toContainText('เลขผู้เสียภาษี X-XXXX-XXXX0-12-1 (ปิดบางหลัก)')
    await check(auditor, testInfo, 'suppliers-auditor-search')
  } finally {
    await auditor.context().close()
  }
})
