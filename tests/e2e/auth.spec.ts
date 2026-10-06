import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import AxeBuilder from '@axe-core/playwright'
import { type Page, type TestInfo } from '@playwright/test'
import { deriveSeedTotpSecret, totp } from '../../src/lib/totp'
import { e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'

// S1-07 "done when": a seeded user signs in with password + TOTP on the local build. The password comes from
// SEED_DEV_PASSWORD and the TOTP secret from SEED_TOTP_KEY (.env), exactly as the presenter's phone would.

async function expectNoBlockingAxe(page: Page) {
  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(blocking.map((v) => `${v.id}: ${v.help}`)).toEqual([])
}

/** A fresh member with a role and no authenticator app yet (tests/e2e/auth-prehydration-scene.ts setup): its e-mail */
function memberToSetUp(testInfo: TestInfo): string {
  const tag = `${testInfo.project.name}-${randomBytes(3).toString('hex')}`
  const r = spawnSync(`pnpm exec tsx tests/e2e/auth-prehydration-scene.ts setup ${tag}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`sign-in scene setup failed:\n${r.stderr}`)
  return (JSON.parse(r.stdout.trim().split('\n').at(-1)!) as { email: string }).email
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

  // The request reaches BCS, which fails (5xx): the e-mail and password were not checked, and the connection worked —
  // said so, never "check the connection"
  await page.unroute('**/api/auth/sign-in/email')
  await page.route('**/api/auth/sign-in/email', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Service Unavailable' }) }))
  await submit.click()
  await expect(page.getByRole('alert').filter({ hasText: 'ระบบขัดข้อง จึงยังไม่ได้ตรวจอีเมลและรหัสผ่าน รอสักครู่แล้วกด เข้าสู่ระบบ อีกครั้ง' })).toBeVisible()
  await expect(page.getByRole('alert').filter({ hasText: 'ตรวจการเชื่อมต่อ' })).toHaveCount(0)
  await expect(submit).toBeEnabled()
})

test('[FR-AUTH-002/AC1] [FR-AUTH-001/AC3] the second step says on its field what a code needs and sends nothing that cannot be one; its switch is a 44 px target', async ({ page, isMobile }) => {
  const sent: string[] = []
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (path.startsWith('/api/auth/two-factor/')) sent.push(path)
  })
  await page.goto('/login/2fa')
  const code = page.getByLabel('รหัส 6 หลักจากแอป')
  const submit = page.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' })
  const useBackup = page.getByRole('button', { name: 'ใช้รหัสสำรองแทน' })
  await expect(submit).toBeEnabled()
  // A phone's tap target (NFR-A11Y-02)
  if (isMobile) expect((await useBackup.boundingBox())!.height).toBeGreaterThanOrEqual(44)

  // Nothing typed: the field says what to enter and takes the focus; nothing is sent, so no failed sign-in is counted
  await submit.click()
  await expect(code).toHaveAttribute('aria-invalid', 'true')
  await expect(code).toHaveAccessibleDescription('ใส่รหัส 6 หลักจากแอปยืนยันตัวตน')
  await expect(code).toBeFocused()
  // Five digits: not a code from the app, said on the field — never "the code is wrong"
  await code.fill('12345')
  await submit.click()
  await expect(code).toHaveAccessibleDescription('รหัสจากแอปเป็นตัวเลข 6 หลัก ใส่ให้ครบ 6 หลัก')
  await expect(code).toBeFocused()
  await expect(page.getByRole('alert').filter({ hasText: 'รหัสไม่ถูกต้อง' })).toHaveCount(0)
  // A backup code: one is asked for
  await useBackup.click()
  const backup = page.getByLabel('รหัสสำรอง', { exact: true })
  await expect(backup).not.toHaveAttribute('aria-invalid', 'true')
  await submit.click()
  await expect(backup).toHaveAttribute('aria-invalid', 'true')
  await expect(backup).toHaveAccessibleDescription(/ใส่รหัสสำรองหนึ่งรหัส/)
  await expect(backup).toBeFocused()
  expect(sent).toEqual([])
  await expectNoBlockingAxe(page)
})

test('[FR-AUTH-002/AC1] [FR-AUTH-001/AC3] a code the second step could not check is never called wrong, and the words above the field ask for what it takes', async ({ page }) => {
  await page.goto('/login/2fa')
  const code = page.getByLabel('รหัส 6 หลักจากแอป')
  const submit = page.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' })
  const appIntro = page.getByText('เปิดแอปยืนยันตัวตนในมือถือ แล้วใส่รหัส 6 หลักของ BCS')
  await expect(submit).toBeEnabled()
  await expect(appIntro).toBeVisible()

  // The request reaches BCS, which fails (5xx): the code was not checked, and the connection worked — said so, never
  // "check the connection" and never a wrong code
  await page.route('**/api/auth/two-factor/verify-totp', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Service Unavailable' }) }))
  await code.fill('123456')
  await submit.click()
  await expect(page.getByRole('alert').filter({ hasText: 'ระบบขัดข้อง จึงยังไม่ได้ตรวจรหัส รอสักครู่แล้วกด ยืนยันและเข้าสู่ระบบ อีกครั้ง' })).toBeVisible()
  await expect(page.getByRole('alert').filter({ hasText: 'ตรวจการเชื่อมต่อ' })).toHaveCount(0)
  await expect(page.getByRole('alert').filter({ hasText: 'รหัสไม่ถูกต้อง' })).toHaveCount(0)
  await expect(submit).toBeEnabled()

  // The connection drops on the way: that is what the message says, and the button can be pressed again
  await page.unroute('**/api/auth/two-factor/verify-totp')
  await page.route('**/api/auth/two-factor/verify-totp', (route) => route.abort('internetdisconnected'))
  await submit.click()
  await expect(page.getByRole('alert').filter({ hasText: 'เข้าสู่ระบบไม่สำเร็จ ตรวจการเชื่อมต่อแล้วลองอีกครั้ง' })).toBeVisible()
  await expect(page.getByRole('alert').filter({ hasText: 'ระบบขัดข้อง' })).toHaveCount(0)
  await expect(submit).toBeEnabled()

  // A backup code instead (no phone at hand): the words above the field ask for one — not to open the app — and a
  // server failure is said the same way
  await page.getByRole('button', { name: 'ใช้รหัสสำรองแทน' }).click()
  await expect(page.getByText('ใส่รหัสสำรองหนึ่งรหัสจากชุดที่เก็บไว้ตอนตั้งค่าการยืนยันตัวตนสองชั้น', { exact: false })).toBeVisible()
  await expect(appIntro).toHaveCount(0)
  await page.route('**/api/auth/two-factor/verify-backup-code', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }))
  await page.getByLabel('รหัสสำรอง', { exact: true }).fill('e2e-backup-code')
  await submit.click()
  await expect(page.getByRole('alert').filter({ hasText: 'ระบบขัดข้อง จึงยังไม่ได้ตรวจรหัส' })).toBeVisible()
  await expect(page.getByRole('alert').filter({ hasText: 'รหัสสำรองนี้ไม่ถูกต้อง' })).toHaveCount(0)
  await expect(submit).toBeEnabled()
  await expectNoBlockingAxe(page)
})

test('[FR-AUTH-001/AC2] a new password longer than the rule is said on its field, and the e-mailed link is not called expired', async ({ page }) => {
  const sent: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/auth/reset-password') sent.push(request.method())
  })
  await page.goto('/reset-password?token=e2e-not-a-token')
  const password = page.getByLabel('รหัสผ่านใหม่', { exact: true })
  const save = page.getByRole('button', { name: 'บันทึกรหัสผ่านใหม่' })
  await expect(save).toBeEnabled()
  // 132 characters, both fields alike: the rule is at most 128 (Better Auth's maxPasswordLength)
  const tooLong = 'Long-pass-9!'.repeat(11)
  await password.fill(tooLong)
  await page.getByLabel('ใส่รหัสผ่านใหม่อีกครั้ง').fill(tooLong)
  await save.click()
  await expect(password).toHaveAttribute('aria-invalid', 'true')
  await expect(password).toHaveAccessibleDescription(/รหัสผ่านยาวเกินไป ใช้ไม่เกิน 128 ตัวอักษร/)
  await expect(password).toBeFocused()
  // Nothing was sent, so the link was not used: the form stays, and nothing speaks of an expired link
  expect(sent).toEqual([])
  await expect(page.getByText('ลิงก์นี้หมดอายุหรือใช้ไปแล้ว', { exact: false })).toHaveCount(0)
  await expect(save).toBeEnabled()
  await expectNoBlockingAxe(page)
})

test('[FR-AUTH-001/AC1] an invitation says what is wrong for what it is: a password longer than the rule on its field, a link cut short as a link that is not valid', async ({ page }) => {
  // The password goes to the server action, a POST to the page's own address
  const posted: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/invite/')) posted.push(request.url())
  })
  // A link cut short when it was copied: shorter than any invitation token BCS sends
  await page.goto('/invite/cut-short')
  const password = page.getByLabel('รหัสผ่านใหม่', { exact: true })
  const again = page.getByLabel('ใส่รหัสผ่านอีกครั้ง')
  const submit = page.getByRole('button', { name: 'ตั้งรหัสผ่านและเปิดใช้บัญชี' })
  await expect(submit).toBeEnabled()

  // 132 characters, both fields alike: the rule is at most 128 — said on the field, which takes the focus, before
  // anything is sent (never "too short")
  const tooLong = 'Long-pass-9!'.repeat(11)
  await password.fill(tooLong)
  await again.fill(tooLong)
  await submit.click()
  await expect(password).toHaveAttribute('aria-invalid', 'true')
  await expect(password).toHaveAccessibleDescription(/รหัสผ่านยาวเกินไป ใช้ไม่เกิน 128 ตัวอักษร/)
  await expect(password).toBeFocused()
  await expect(page.getByText('รหัสผ่านสั้นเกินไป', { exact: false })).toHaveCount(0)
  expect(posted).toEqual([])

  // A password within the rule: the server cannot read the link, and the form says the link is not valid and where to
  // get a new one — not that the password is too short
  const fine = 'Long-pass-9!-fits'
  await password.fill(fine)
  await again.fill(fine)
  await submit.click()
  await expect(page.getByRole('alert').filter({ hasText: 'ลิงก์เชิญนี้ไม่ถูกต้อง ขอลิงก์ใหม่จากผู้ดูแลระบบขององค์กร' })).toBeVisible()
  await expect(password).not.toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByText('รหัสผ่านสั้นเกินไป', { exact: false })).toHaveCount(0)
  expect(posted.length).toBeGreaterThan(0)
  await expectNoBlockingAxe(page)
})

test('[FR-AUTH-002/AC1] the authenticator setup says too many tries for what it is: the password was not checked, and how long to wait', async ({ page }, testInfo) => {
  // A member with a role and no authenticator app yet: the workspace shows the setup before any work
  const email = memberToSetUp(testInfo)
  await page.goto('/login')
  await page.getByLabel('อีเมลบริษัท').fill(email)
  await page.getByLabel('รหัสผ่าน', { exact: true }).fill(process.env.SEED_DEV_PASSWORD!)
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'การยืนยันตัวตนสองชั้น' })).toBeVisible()
  const password = page.getByLabel('รหัสผ่าน', { exact: true })
  const start = page.getByRole('button', { name: 'เริ่มตั้งค่าแอปยืนยันตัวตน' })
  const enabling = () => page.waitForResponse((response) => new URL(response.url()).pathname === '/api/auth/two-factor/enable')
  await expect(start).toBeEnabled()

  // Nothing typed: the field says so and takes the focus, and nothing is sent — an empty password is not a wrong one
  const sent: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/auth/two-factor/enable') sent.push(request.method())
  })
  await start.click()
  await expect(password).toHaveAccessibleDescription('ใส่รหัสผ่านก่อนเริ่มตั้งค่า')
  await expect(password).toBeFocused()
  expect(sent).toEqual([])

  // Better Auth takes 3 tries of its two-factor routes in 10 seconds from one address: these 3 are checked, and wrong
  for (const attempt of [1, 2, 3]) {
    await password.fill(`not-the-password-${attempt}`)
    const [answer] = await Promise.all([enabling(), start.click()])
    expect(answer.status()).toBe(400)
    await expect(page.getByRole('alert').filter({ hasText: 'รหัสผ่านไม่ถูกต้อง ลองอีกครั้ง' })).toBeVisible()
  }
  // The 4th, the right password, is refused before it is checked: not called wrong, and the seconds to wait are said
  await password.fill(process.env.SEED_DEV_PASSWORD!)
  const [limited] = await Promise.all([enabling(), start.click()])
  expect(limited.status()).toBe(429)
  await expect(page.getByRole('alert').filter({ hasText: /ยังไม่ได้ตรวจสิ่งที่กรอก เพราะมีคำขอจากเครือข่ายนี้ถี่เกินไป รอ \d+ วินาทีแล้วลองอีกครั้ง/ })).toBeVisible()
  await expect(page.getByRole('alert').filter({ hasText: 'รหัสผ่านไม่ถูกต้อง' })).toHaveCount(0)
  await expect(start).toBeEnabled()
  await expectNoBlockingAxe(page)
})
