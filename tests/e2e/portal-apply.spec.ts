import { spawnSync } from 'node:child_process'
import { type Browser } from '@playwright/test'
import { E2E_BASE_URL, e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'
import { checkScreen, FIRST_LOAD_JS_BUDGET_BYTES, weighFirstLoad, type BrowserCookies } from './liff-support'

// S7-08 (ADR-184 · FR-SUP-101 · BR-PORTAL ข้อ 01 ข้อ 02 ข้อ 08): a supplier invited by e-mail applies on a phone at 375 px
// with AI off — the link, the six-digit code, the privacy notice, the six steps (company, tax, contacts, bank account,
// documents, check and send) — and sees its application sent. Every page of the portal is checked with axe at 375 and
// 1440 px, and its first JavaScript weighed: at most 200 KB gzip with the page data (§9.4 · ADR-052), no tailwind-merge.

/** Runs tests/e2e/portal-scene.ts against the e2e database: the JSON of its last line */
function portalScene<T>(...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/portal-scene.ts ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`portal scene ${args[0]} failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1)!) as T
}

/** A taxpayer id with its check digit (BR-TAXID-01), new for every run */
function taxId(): string {
  const digits = Array.from({ length: 12 }, (_, i) => (i === 0 ? 0 : Math.floor(Math.random() * 10)))
  const sum = digits.reduce((s, d, i) => s + d * (13 - i), 0)
  return digits.join('') + String((11 - (sum % 11)) % 10)
}

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n')

/** The first JavaScript of a portal page in a browser of its own with the session's cookies and nothing cached */
async function weigh(browser: Browser, cookies: BrowserCookies, path: string) {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, locale: 'th-TH' })
  try {
    await context.addCookies(cookies)
    const page = await context.newPage()
    const load = await weighFirstLoad(page, path, () => expect(page.getByRole('heading', { level: 1 })).toBeVisible())
    test.info().annotations.push({ type: 'first-load-js', description: `${path}: ${load.note}` })
    expect.soft(load.loads.filter((l) => l.merge).map((l) => l.url), `${path}: no tailwind-merge`).toEqual([])
    expect.soft(load.total, `${path}: ${load.note}`).toBeLessThanOrEqual(FIRST_LOAD_JS_BUDGET_BYTES)
  } finally {
    await context.close()
  }
}

test.describe('@portal the supplier portal on a phone', () => {
  test.describe.configure({ timeout: 240_000 })

  test('[FR-SUP-101/AC3] invited by e-mail, the supplier fills in its application in six steps and sends it, AI off', async ({ page, browser }, testInfo) => {
    const made = portalScene<{ org: string; url: string; contactId: string }>('invite', taxId())
    const base = `/portal/${made.org}`

    // the link of the e-mail: a page with a button (a GET never uses it), then the code typed on this phone
    await page.goto(made.url.replace(/^https?:\/\/[^/]+/, E2E_BASE_URL))
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('ยืนยันการเข้าระบบ')
    await checkScreen(page, testInfo, 'portal-link')
    await page.getByRole('button', { name: 'ส่งรหัสยืนยันให้ฉัน' }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('กรอกรหัสยืนยัน')
    await checkScreen(page, testInfo, 'portal-otp')
    const { code } = portalScene<{ code: string }>('code', made.contactId)
    await page.getByLabel('รหัสยืนยัน 6 หลัก').fill(code)
    await page.getByRole('button', { name: 'เข้าระบบ' }).click()

    // the privacy notice before anything else (BR-PORTAL ข้อ 08)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('ประกาศความเป็นส่วนตัว')
    await checkScreen(page, testInfo, 'portal-privacy')
    await page.getByRole('button', { name: 'รับทราบ' }).click()

    // step 1: company
    await expect(page).toHaveURL(new RegExp(`${base}/apply`))
    await expect(page.getByText('ขั้นที่ 1 จาก 6')).toBeVisible()
    await checkScreen(page, testInfo, 'portal-apply-company')
    await page.getByLabel('ที่อยู่ตามทะเบียน').fill('99 ถนนเพชรเกษม ตำบลบ้านโป่ง ราชบุรี 70110')
    await page.getByLabel('เบอร์โทรศัพท์').fill('032-211-000')
    await page.getByRole('button', { name: 'บันทึกแล้วไปขั้นถัดไป' }).click()

    // step 2: tax — VAT registered
    await expect(page.getByText('ขั้นที่ 2 จาก 6')).toBeVisible()
    await checkScreen(page, testInfo, 'portal-apply-tax')
    await page.getByLabel('จดทะเบียนภาษีมูลค่าเพิ่ม (VAT)').check()
    await page.getByRole('button', { name: 'บันทึกแล้วไปขั้นถัดไป' }).click()

    // step 3: contacts — the language of the e-mails
    await expect(page.getByText('ขั้นที่ 3 จาก 6')).toBeVisible()
    await expect(page.getByText('คุณสมใจ ผู้ติดต่อ (ท่าน)')).toBeVisible()
    await checkScreen(page, testInfo, 'portal-apply-contact')
    await page.getByRole('button', { name: 'บันทึกแล้วไปขั้นถัดไป' }).click()

    // step 4: bank account — the number never comes back, its last four only
    await expect(page.getByText('ขั้นที่ 4 จาก 6')).toBeVisible()
    await page.getByLabel('ธนาคาร', { exact: true }).selectOption('004')
    await page.getByLabel('เลขที่บัญชี', { exact: true }).fill('1234567890')
    await page.getByLabel('ชื่อบัญชี', { exact: true }).fill('บริษัท พอร์ทัลทดสอบ จำกัด')
    await checkScreen(page, testInfo, 'portal-apply-bank')
    await page.getByRole('button', { name: 'บันทึกแล้วไปขั้นถัดไป' }).click()

    // step 5: documents — both required ones sent as PDF files
    await expect(page.getByText('ขั้นที่ 5 จาก 6')).toBeVisible()
    await checkScreen(page, testInfo, 'portal-apply-documents')
    // the company certificate lives 180 days from its issue; the VAT registration has no validity of its own, so its
    // expiry date is asked for
    for (const [type, issued, expires] of [['หนังสือรับรองบริษัท', '2026-10-01', null], ['ภ.พ.20', '2020-05-01', '2030-12-31']] as const) {
      const item = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: type, exact: true }) })
      await item.getByLabel('ไฟล์').setInputFiles({ name: `${type}.pdf`, mimeType: 'application/pdf', buffer: PDF })
      await item.getByLabel('วันที่ออก').fill(issued)
      if (expires) await item.getByLabel(/^วันหมดอายุ/).fill(expires)
      await item.getByRole('button', { name: `ส่ง ${type}` }).click()
      await expect(page.getByText('ขั้นที่ 5 จาก 6')).toBeVisible()
      await expect(page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: type, exact: true }) })).not.toContainText('ยังไม่ได้ส่ง')
    }
    await page.getByRole('link', { name: 'ตรวจและส่ง' }).last().click()

    // step 6: check and send
    await expect(page.getByText('ขั้นที่ 6 จาก 6')).toBeVisible()
    await expect(page.getByText('ข้อมูลครบแล้ว')).toBeVisible()
    await expect(page.getByText('•••• 7890')).toBeVisible()
    await expect(page.locator('body')).not.toContainText('1234567890')
    await checkScreen(page, testInfo, 'portal-apply-review')
    const cookies = await page.context().cookies()
    // the first JavaScript of every page of the portal, before the application is sent (the form's steps show)
    for (const path of [`${base}/apply?step=company`, `${base}/apply?step=documents`, `${base}/apply?step=review`, `${base}/profile`, `${base}/help`, `${base}/documents`, `${base}/login`]) {
      await weigh(browser, cookies, path)
    }
    await page.getByRole('button', { name: /^ส่งใบสมัครให้ / }).click()
    await expect(page.getByRole('status').filter({ hasText: /ส่งใบสมัครเลขที่ SUP-/ })).toBeVisible()
    await checkScreen(page, testInfo, 'portal-apply-sent')

    // profile and help
    await page.getByRole('link', { name: 'บัญชีของฉัน' }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('บัญชีของฉัน')
    await checkScreen(page, testInfo, 'portal-profile')
    await page.getByRole('link', { name: 'ช่วยเหลือ' }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('ช่วยเหลือ')
    await checkScreen(page, testInfo, 'portal-help')
  })
})

