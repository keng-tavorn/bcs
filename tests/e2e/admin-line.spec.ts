import type { Page } from '@playwright/test'
import { E2E_BASE_URL, E2E_LINE } from '../support/e2e-env'
import { expect, test } from './fixtures'
import { checkScreen, signInAs } from './insight-support'
import { adminOf, expectNoValueInAddresses, notAdminOf, setWebhookAtLine, withoutScript } from './settings-line-scene'

// S5-01 · FR-ADM-006 AC2 AC3 (/admin/line, ADR-045): the organization's administrator sees the LINE channel the demo seed
// saved — the channel secret and the access token only as "ตั้งแล้ว", never a character of either — saves changes with
// the version the page showed (a save in between is refused and the page then shows what is saved now), copies the
// webhook URL, runs the connection test against the fake LINE server of the run (each check PASS or FAIL with the fix
// in words) and makes both rich menus again. Before the page runs its script nothing can be submitted, and the form
// posts, so the secret and the token never reach an address (NFR-SEC-09). Anybody else is refused by the service. Each
// project has its own administrator; the channel ends as it started (on, the seed's values). Screens at the project's
// width with axe (§9.9).

const success = (page: Page, text: string | RegExp) => page.getByRole('status').filter({ hasText: text })
const failure = (page: Page, text: string | RegExp) => page.getByRole('alert').filter({ hasText: text })
/** One check of the connection test's results */
const checkRow = (page: Page, title: string) => page.getByRole('list', { name: 'ผลการทดสอบ' }).getByRole('listitem').filter({ has: page.getByText(title, { exact: true }) })

async function openLineSettings(page: Page) {
  await page.goto('/admin/line')
  await expect(page.getByRole('heading', { level: 1, name: 'ตั้งค่า LINE' })).toBeVisible()
  // Save is enabled once the page runs its script (src/ui/form/hydrated.ts): the form is the page's state from then on
  await expect(page.getByRole('button', { name: 'บันทึกค่า LINE' })).toBeEnabled()
}

/** Nothing of the two secrets is on the page: not in what shows, not in any field, not in the HTML */
async function expectNoSecretOnPage(page: Page) {
  for (const label of ['Channel secret', 'Channel access token (long-lived)']) {
    const field = page.getByLabel(label)
    await expect(field).toHaveValue('')
    // Masked, and never offered to the browser's password manager (no generated password, no "save password?")
    await expect(field).toHaveAttribute('type', 'password')
    await expect(field).toHaveAttribute('autocomplete', 'one-time-code')
    await expect(field).toHaveAttribute('data-bwignore', 'true')
  }
  const html = await page.content()
  expect(html).not.toContain(E2E_LINE.LINE_MESSAGING_CHANNEL_SECRET)
  expect(html).not.toContain(E2E_LINE.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN)
  expect(html).not.toContain('••••')
}

test('[FR-ADM-006/AC2] the administrator sees the channel with the secret and the token only as set, and saves changes with the version shown', async ({ page }, testInfo) => {
  const admin = adminOf(testInfo)
  await signInAs(page, admin.code, admin.totp)
  await openLineSettings(page)
  await expect(page.getByText('ใช้ LINE อยู่ สมาชิกที่ผูกบัญชีแล้วได้รับงานและการแจ้งเตือนทาง LINE')).toBeVisible()
  await expect(page.getByLabel('Provider ID')).toHaveValue(E2E_LINE.LINE_PROVIDER_ID)
  await expect(page.getByLabel('Channel ID ของ Messaging API channel')).toHaveValue(E2E_LINE.LINE_MESSAGING_CHANNEL_ID)
  await expect(page.getByLabel('LIFF ID', { exact: true })).toHaveValue(E2E_LINE.NEXT_PUBLIC_LIFF_ID)
  // Write-only: whether each is set, said beside it and read out with the field
  await expect(page.getByLabel('Channel secret')).toHaveAccessibleDescription(/^ตั้งแล้ว /)
  await expect(page.getByLabel('Channel access token (long-lived)')).toHaveAccessibleDescription(/^ตั้งแล้ว /)
  await expectNoSecretOnPage(page)
  // The webhook URL to give LINE
  const webhook = page.getByRole('region', { name: 'Webhook URL' })
  await expect(webhook.getByText(new RegExp(`^${E2E_BASE_URL}/api/webhooks/line/[A-Za-z0-9_-]{24}$`))).toBeVisible()
  await expect(webhook.getByRole('button', { name: 'คัดลอก Webhook URL' })).toBeVisible()
  await checkScreen(page, testInfo, 'admin-line')

  // Switched off with the secret typed again (the same value is no change): saved, the field empty again
  const active = page.getByRole('switch', { name: 'ใช้ LINE กับองค์กรนี้' })
  await page.getByLabel('Channel secret').fill(E2E_LINE.LINE_MESSAGING_CHANNEL_SECRET)
  await page.getByText('ใช้ LINE กับองค์กรนี้', { exact: true }).click()
  await expect(active).not.toBeChecked()
  // Changes not saved yet: the test and the menus wait for them
  await expect(page.getByRole('button', { name: 'ทดสอบการเชื่อมต่อ' })).toBeDisabled()
  await page.getByRole('button', { name: 'บันทึกค่า LINE' }).click()
  await expect(success(page, 'บันทึกค่า LINE แล้ว')).toBeVisible()
  await expect(page.getByText('ปิดใช้ LINE อยู่ สมาชิกได้รับงานและการแจ้งเตือนทางอีเมลแทน')).toBeVisible()
  await expectNoSecretOnPage(page)
  await expect(page.getByLabel('Channel secret')).toHaveAccessibleDescription(/^ตั้งแล้ว /)

  // Another tab of the same administrator saves first: this page's save is refused and it shows what is saved now
  const other = await page.context().newPage()
  await openLineSettings(other)
  await other.getByText('ใช้ LINE กับองค์กรนี้', { exact: true }).click()
  await other.getByRole('button', { name: 'บันทึกค่า LINE' }).click()
  await expect(success(other, 'บันทึกค่า LINE แล้ว')).toBeVisible()
  await other.close()

  await page.getByLabel('LIFF ID', { exact: true }).fill(`${E2E_LINE.NEXT_PUBLIC_LIFF_ID}x`)
  await page.getByRole('button', { name: 'บันทึกค่า LINE' }).click()
  await expect(failure(page, 'มีผู้ดูแลคนอื่นบันทึกค่า LINE ระหว่างที่คุณแก้ไข หน้านี้แสดงค่าล่าสุดแล้ว')).toBeVisible()
  // The latest values: switched on by the other tab, and this page's unsaved LIFF ID gone
  await expect(active).toBeChecked()
  await expect(page.getByLabel('LIFF ID', { exact: true })).toHaveValue(E2E_LINE.NEXT_PUBLIC_LIFF_ID)
  await expect(page.getByText('ใช้ LINE อยู่ สมาชิกที่ผูกบัญชีแล้วได้รับงานและการแจ้งเตือนทาง LINE')).toBeVisible()
  await checkScreen(page, testInfo, 'admin-line-conflict')
  // Saving again now goes against the version shown: nothing differs from what is saved
  await page.getByRole('button', { name: 'บันทึกค่า LINE' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'ไม่มีค่าที่เปลี่ยนจากเดิม' })).toBeVisible()

  // A value in the wrong format is refused under its field, without saving anything
  await page.getByLabel('Channel secret').fill('not-a-channel-secret')
  await page.getByRole('button', { name: 'บันทึกค่า LINE' }).click()
  await expect(page.getByText('Channel secret ต้องเป็นตัวอักษร 0–9 และ a–f จำนวน 32 ตัว คัดลอกจาก Basic settings ใหม่อีกครั้ง')).toBeVisible()
  await expect(page.getByLabel('Channel secret')).toHaveValue('')
  await expectNoSecretOnPage(page)
})

test('[FR-ADM-006/AC2][NFR-SEC-09] before the page runs its script, the channel form sends nothing and never puts the secret or the token in an address', async ({ page, browser, clientIp }, testInfo) => {
  const admin = adminOf(testInfo)
  await signInAs(page, admin.code, admin.totp)
  // The same administrator on a slow phone, or with a script that did not load: the page as the server sends it
  const bare = await withoutScript(browser, page, testInfo, clientIp)
  try {
    await bare.page.goto('/admin/line')
    await expect(bare.page.getByRole('heading', { level: 1, name: 'ตั้งค่า LINE' })).toBeVisible()
    const secret = 'fedcba9876543210fedcba9876543210'
    const token = 'not-a-real-access-token-of-this-channel'
    await bare.page.getByLabel('Channel secret').fill(secret)
    const tokenField = bare.page.getByLabel('Channel access token (long-lived)')
    await tokenField.fill(token)
    await expectNoValueInAddresses(bare.page, bare.requested, tokenField, 'บันทึกค่า LINE', [secret, token], ['channelSecret', 'channelAccessToken'])
  } finally {
    await bare.page.context().close()
  }
  // A native submission saves nothing (the page only renders again): the channel is still on, nothing of the secrets shows,
  // and the next test's connection test checks LINE's webhook signature against the secret the seed saved
  await openLineSettings(page)
  await expect(page.getByText('ใช้ LINE อยู่ สมาชิกที่ผูกบัญชีแล้วได้รับงานและการแจ้งเตือนทาง LINE')).toBeVisible()
  await expectNoSecretOnPage(page)
})

test('[FR-ADM-006/AC3] the connection test reports each check as PASS or FAIL with the fix in words; fixed, every check passes', async ({ page, request }, testInfo) => {
  const admin = adminOf(testInfo)
  await signInAs(page, admin.code, admin.totp)
  await openLineSettings(page)
  const expected = await page.getByRole('region', { name: 'Webhook URL' }).getByText(/\/api\/webhooks\/line\//).innerText()
  // At LINE the webhook URL still points somewhere else
  await setWebhookAtLine(request, 'https://old-host.example/line/webhook')

  await page.getByRole('button', { name: 'ทดสอบการเชื่อมต่อ' }).click()
  await expect(page.getByRole('status').filter({ hasText: /^ยังไม่ผ่าน \d ข้อ แก้ตามคำแนะนำของแต่ละข้อแล้วทดสอบอีกครั้ง$/ })).toBeVisible({ timeout: 20_000 })
  const token = checkRow(page, 'Channel access token')
  await expect(token.getByText('ผ่าน', { exact: true })).toBeVisible()
  await expect(token).toContainText('LINE รับ token นี้ (บัญชี BCS (fake LINE) @bcs-fake)')
  const url = checkRow(page, 'Webhook URL ที่ตั้งไว้ใน LINE')
  await expect(url.getByText('ไม่ผ่าน', { exact: true })).toBeVisible()
  await expect(url).toContainText(`Webhook URL ใน LINE คือ https://old-host.example/line/webhook แต่ต้องเป็น ${expected} แก้ที่ LINE Developers Console → Messaging API → Webhook settings`)
  // LINE's own test webhook reached this system and the signature matched the saved secret
  await expect(checkRow(page, 'LINE ส่ง webhook ถึง BCS ได้').getByText('ผ่าน', { exact: true })).toBeVisible()
  await expect(checkRow(page, 'LIFF ID').getByText('ผ่าน', { exact: true })).toBeVisible()
  await expect(checkRow(page, 'Rich menu ทุกชุด')).toBeVisible()
  await checkScreen(page, testInfo, 'admin-line-test-failed')

  // The administrator fixes the URL at LINE and makes both rich menus again
  await setWebhookAtLine(request, expected)
  await page.getByRole('button', { name: 'สร้าง rich menu ใหม่ทุกชุด' }).click()
  const menus = page.getByRole('region', { name: 'Rich menu' })
  await expect(menus.getByRole('status').filter({ hasText: 'สร้าง rich menu ใหม่ทุกชุดแล้ว' })).toBeVisible({ timeout: 20_000 })
  await expect(menus.getByText('สร้างไว้แล้วทุกชุด')).toBeVisible()

  await page.getByRole('button', { name: 'ทดสอบการเชื่อมต่อ' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'ผ่านทุกข้อ LINE พร้อมใช้งาน' })).toBeVisible({ timeout: 20_000 })
  const results = page.getByRole('list', { name: 'ผลการทดสอบ' }).getByRole('listitem')
  await expect(results).toHaveCount(5)
  for (const row of await results.all()) await expect(row.getByText('ผ่าน', { exact: true })).toBeVisible()
  await expect(checkRow(page, 'Webhook URL ที่ตั้งไว้ใน LINE')).toContainText(`LINE ส่ง webhook มาที่ ${expected} และเปิด Use webhook แล้ว`)
  await checkScreen(page, testInfo, 'admin-line-test-passed')
})

test('[FR-ADM-006/AC2] a member who is not an organization administrator is refused by the service, not only by the menu', async ({ page }, testInfo) => {
  const member = notAdminOf(testInfo)
  await signInAs(page, member.code, member.totp)
  await page.goto('/admin/line')
  await expect(page.getByRole('heading', { level: 1, name: 'ตั้งค่า LINE' })).toBeVisible()
  await expect(page.getByRole('alert').filter({ hasText: 'หน้านี้สำหรับผู้ดูแลองค์กร' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'บันทึกค่า LINE' })).toHaveCount(0)
  await expect(page.getByLabel('Provider ID')).toHaveCount(0)
  // The menu leaves the page out for them too, but that is convenience: the refusal above came from the service
  await expect(page.getByRole('link', { name: 'ตั้งค่า LINE', includeHidden: true })).toHaveCount(0)
  await checkScreen(page, testInfo, 'admin-line-refused')
})
