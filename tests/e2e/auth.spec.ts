import AxeBuilder from '@axe-core/playwright'
import { type Page } from '@playwright/test'
import { deriveSeedTotpSecret, totp } from '../../src/lib/totp'
import { expect, test } from './fixtures'

// S1-07 "done when": a seeded user signs in with password + TOTP on the local build. The password comes from
// SEED_DEV_PASSWORD and the TOTP secret from SEED_TOTP_KEY (.env), exactly as the presenter's phone would.

async function expectNoBlockingAxe(page: Page) {
  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(blocking.map((v) => `${v.id}: ${v.help}`)).toEqual([])
}

test('[FR-AUTH-002/AC1] a seeded user signs in with password and TOTP', async ({ page, isMobile }, testInfo) => {
  // A different seeded user per viewport, so the same TOTP code is never used twice within its 30 seconds
  const code = testInfo.project.name === 'mobile' ? 'admin2' : 'admin'
  const name = code === 'admin' ? 'แอดมิน ดูแลระบบ' : 'สมศักดิ์ ดูแลร่วม'

  await page.goto('/login')
  await expectNoBlockingAxe(page)
  await page.screenshot({ path: testInfo.outputPath('login.png'), fullPage: true })
  await page.getByLabel('อีเมลบริษัท').fill(`${code}@demo.bcs.local`)
  await page.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()

  await expect(page).toHaveURL(/\/login\/2fa$/)
  await expectNoBlockingAxe(page)
  await page.screenshot({ path: testInfo.outputPath('two-factor.png'), fullPage: true })
  await page.getByLabel('รหัส 6 หลักจากแอป').fill(totp(deriveSeedTotpSecret(process.env.SEED_TOTP_KEY!, code)))
  await page.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' }).click()

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`สวัสดี ${name}`)
  if (isMobile) await page.getByText('เมนู', { exact: true }).click()
  await page.getByRole('link', { name: 'ความปลอดภัยของบัญชี' }).click()
  await expect(page.getByRole('heading', { level: 2, name: 'อุปกรณ์ที่เข้าระบบอยู่' })).toBeVisible()
  await expectNoBlockingAxe(page)
  await page.screenshot({ path: testInfo.outputPath('security.png'), fullPage: true })
})

test('[FR-AUTH-001/AC3] a wrong password shows how to recover, without saying which part was wrong', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('อีเมลบริษัท').fill('auditor@demo.bcs.local')
  await page.getByLabel('รหัสผ่าน').fill('not-the-password-123')
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
  // (Next.js also renders an empty role=alert route announcer, so match the message itself)
  await expect(page.getByRole('alert').filter({ hasText: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' })).toBeVisible()
  await expectNoBlockingAxe(page)
})

test('[FR-AUTH-001/AC3] a sign-in that cannot be checked says what to fix: on the field it is about, or that the connection dropped', async ({ page }) => {
  const sent: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/auth/sign-in/email') sent.push(request.method())
  })
  await page.goto('/login')
  const email = page.getByLabel('อีเมลบริษัท')
  const password = page.getByLabel('รหัสผ่าน')
  const submit = page.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true })

  // Nothing typed: each field says what to fill in, the e-mail takes the focus, and nothing is sent
  await submit.click()
  await expect(email).toHaveAttribute('aria-invalid', 'true')
  await expect(email).toHaveAccessibleDescription('ใส่อีเมลบริษัทก่อนเข้าสู่ระบบ')
  await expect(email).toBeFocused()
  await expect(password).toHaveAccessibleDescription('ใส่รหัสผ่านก่อนเข้าสู่ระบบ')
  expect(sent).toEqual([])
  await expectNoBlockingAxe(page)

  // An address that is not a whole e-mail: Better Auth refuses it (INVALID_EMAIL), and the e-mail field says how to fix
  // it — not the connection
  await email.fill('auditor@demo')
  await password.fill('not-the-password-123')
  await submit.click()
  await expect(email).toHaveAccessibleDescription('รูปแบบอีเมลไม่ถูกต้อง ตรวจว่ามี @ และชื่อโดเมนของบริษัทต่อท้าย')
  await expect(email).toBeFocused()
  await expect(password).not.toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByRole('alert').filter({ hasText: 'ตรวจการเชื่อมต่อ' })).toHaveCount(0)

  // The connection drops on the way: the message says so above the fields, and the button can be pressed again
  await page.route('**/api/auth/sign-in/email', (route) => route.abort('internetdisconnected'))
  await email.fill('auditor@demo.bcs.local')
  await submit.click()
  await expect(page.getByRole('alert').filter({ hasText: 'เข้าสู่ระบบไม่สำเร็จ ตรวจการเชื่อมต่อแล้วลองอีกครั้ง' })).toBeVisible()
  await expect(submit).toBeEnabled()
  await expect(email).not.toHaveAttribute('aria-invalid', 'true')
  await expectNoBlockingAxe(page)
})
