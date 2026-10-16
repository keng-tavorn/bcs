import { spawnSync } from 'node:child_process'
import AxeBuilder from '@axe-core/playwright'
import type { Page, TestInfo } from '@playwright/test'
import { deriveSeedTotpSecret, totp } from '../../src/lib/totp'
import { e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'

// S6-14: the no-code form builder (FR-INT-104 · BR-FORM-09). ORG_ADMIN opens the builder of a request type, makes a
// draft of the form in use, adds a question, sees it in the preview of the real form, saves and publishes it; a request
// made before keeps the version it was made with, a new one gets the new question. It works on NEW_SUPPLIER, which no
// other spec opens or fills in: the desktop run publishes the next version and the mobile run the one after, each with
// a question of its own (optional, so nothing else about the type changes). Screenshots at 1440 px and 375 px go to
// the test output (§9.9 step 4) and axe runs on every state (step 5).

const TYPE = 'NEW_SUPPLIER'

async function expectNoBlockingAxe(page: Page) {
  // Next streams the <title> after the first HTML: let it arrive before axe reads the page
  await page.waitForFunction(() => document.title !== '', undefined, { timeout: 5_000 }).catch(() => undefined)
  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(blocking.map((v) => `${v.id}: ${v.help}`)).toEqual([])
}

async function shot(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })
}

/** The page is never wider than the screen (§9.9: no horizontal scroll on phones) */
async function expectNoHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
}

/** The organization admin of this viewport (two seeded admins), with the TOTP an admin signs in with */
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

const success = (page: Page, text: string | RegExp) => page.getByRole('status').filter({ hasText: text })

/**
 * A step of tests/e2e/admin-settings-scene.ts in the e2e database, the way the request page acts: `draft <member>
 * <type>` makes a request draft of the type with its form in use; `form <member> <request>` prints the version it keeps
 * and the ids of its fields
 */
function scene(...args: string[]): Record<string, unknown> {
  const r = spawnSync(`pnpm exec tsx tests/e2e/admin-settings-scene.ts ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`form builder scene failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as Record<string, unknown>
}

test('[FR-INT-104/AC1] [FR-INT-104/AC2] the admin builds the next form version without code; requests made before keep theirs', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile'
  const question = mobile ? { id: 'contactNameMobile', th: 'ชื่อผู้ติดต่อของผู้ขาย', en: 'Supplier contact name' } : { id: 'contactPhoneDesktop', th: 'เบอร์โทรผู้ติดต่อของผู้ขาย', en: 'Supplier contact phone' }
  const requester = mobile ? 'req_con2' : 'req_con'
  // A request made with the form in use, before the new version
  const before = scene('draft', requester, TYPE) as { requestId: string }
  const fieldsBefore = (scene('form', requester, before.requestId) as { fields: string[] }).fields

  await signInOrgAdmin(page, testInfo)
  await page.goto(`/admin/request-types/${TYPE}`)
  await page.getByRole('link', { name: 'แก้ฟอร์มด้วยตัวสร้างฟอร์ม' }).click()
  await expect(page).toHaveURL(new RegExp(`/admin/request-types/${TYPE}/form$`))
  await expect(page.getByRole('heading', { level: 1, name: /^ตัวสร้างฟอร์มของ / })).toBeVisible()
  const currentHeading = page.getByRole('heading', { level: 2, name: /^ฟอร์มที่ใช้อยู่ \(ฉบับ \d+\)$/ })
  const current = Number(/ฉบับ (\d+)/.exec((await currentHeading.textContent()) ?? '')![1])
  const next = current + 1
  await expectNoBlockingAxe(page)
  await expectNoHorizontalScroll(page)
  await shot(page, testInfo, 'builder-current')

  // A draft copies the form in use: nothing to publish yet
  await page.getByRole('button', { name: 'สร้างร่างฉบับใหม่' }).click()
  await expect(page.getByRole('heading', { level: 2, name: `ร่างฉบับ ${next}` })).toBeVisible()
  await expect(page.getByText('ร่างนี้เหมือนฉบับที่ใช้อยู่ ยังไม่มีอะไรต้องเผยแพร่')).toBeVisible()
  const publish = page.getByRole('button', { name: `เผยแพร่ฉบับ ${next}` })
  await expect(publish).toBeDisabled()

  // Add a question: what is missing is said next to its input; then it joins the list and the preview
  await page.getByRole('button', { name: 'เพิ่มคำถาม', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'เพิ่มคำถาม' })
  await dialog.getByRole('button', { name: 'เพิ่มคำถามลงร่าง' }).click()
  await expect(dialog.getByText('ใส่รหัสคำถาม')).toBeVisible()
  await dialog.getByLabel('รหัสคำถาม').fill(question.id)
  await dialog.getByLabel('คำถามภาษาไทย').fill(question.th)
  await dialog.getByLabel('คำถามภาษาอังกฤษ').fill(question.en)
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'builder-add-question')
  await dialog.getByRole('button', { name: 'เพิ่มคำถามลงร่าง' }).click()
  await expect(dialog).toBeHidden()

  const fields = page.getByRole('region', { name: 'คำถามในฟอร์ม' })
  const items = fields.getByRole('listitem')
  await expect(items.last()).toContainText(question.th)
  const count = await items.count()
  // Moved one place up with its button (no dragging)
  await fields.getByRole('button', { name: `ขึ้น: เลื่อน ${question.th} ขึ้น` }).click()
  await expect(items.nth(count - 2)).toContainText(question.th)
  const preview = page.getByRole('region', { name: 'ตัวอย่างฟอร์ม' })
  await expect(preview.getByLabel(question.th)).toBeVisible()
  await expect(page.getByText('มีการแก้ที่ยังไม่บันทึก กดบันทึกร่างก่อนออกจากหน้านี้')).toBeVisible()
  await expect(publish).toBeDisabled()

  // Saved: the change against the version in use, and the publish may be pressed
  await page.getByRole('button', { name: 'บันทึกร่าง' }).click()
  await expect(success(page, `บันทึกร่างฉบับ ${next} แล้ว`)).toBeVisible()
  await expect(page.getByText(`เพิ่มช่อง ${question.id}`)).toBeVisible()
  await expect(publish).toBeEnabled()
  await expectNoBlockingAxe(page)
  await expectNoHorizontalScroll(page)
  await shot(page, testInfo, 'builder-draft')

  // Publish, confirmed: new requests take it, requests made keep theirs, the AUDITOR hears of changed attachment rules
  await publish.click()
  const confirm = page.getByRole('alertdialog', { name: new RegExp(`^เผยแพร่ฟอร์มฉบับ ${next} ของ `) })
  await expect(confirm).toContainText('คำขอใหม่จะใช้ฟอร์มฉบับนี้ทันที คำขอที่ทำไว้แล้วยังใช้ฉบับเดิมของตัวเอง')
  await expect(confirm).toContainText('ร่างนี้ไม่เปลี่ยนกฎเอกสารแนบ ถ้าเปลี่ยน ระบบจะแจ้งผู้ตรวจสอบ (AUDITOR) ทันที')
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'builder-confirm')
  await confirm.getByRole('button', { name: `เผยแพร่ฉบับ ${next}` }).click()
  await expect(success(page, `เผยแพร่ฟอร์มฉบับ ${next} แล้ว คำขอใหม่ใช้ฟอร์มนี้ตั้งแต่ตอนนี้`)).toBeVisible()
  await expect(page.getByRole('heading', { level: 2, name: `ฟอร์มที่ใช้อยู่ (ฉบับ ${next})` })).toBeVisible()
  await expect(page.getByRole('region', { name: `ฟอร์มที่ใช้อยู่ (ฉบับ ${next})` }).getByText(question.th, { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'สร้างร่างฉบับใหม่' })).toBeVisible()
  await expectNoBlockingAxe(page)
  await expectNoHorizontalScroll(page)
  await shot(page, testInfo, 'builder-published')

  // The request made before keeps its version; a new request of the type asks the new question
  expect(scene('form', requester, before.requestId)).toEqual({ versionNo: current, fields: fieldsBefore })
  const after = scene('draft', requester, TYPE) as { requestId: string }
  const made = scene('form', requester, after.requestId) as { versionNo: number; fields: string[] }
  expect(made.versionNo).toBe(next)
  expect(made.fields).toContain(question.id)
  expect(fieldsBefore).not.toContain(question.id)
})
