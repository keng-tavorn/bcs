import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import type { Locator, Page, TestInfo } from '@playwright/test'
import { e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'
import { newLineUserId, openAsLineUser } from './liff-support'
import { expectNoValueInAddresses, withoutScript } from './settings-line-scene'

// NFR-SEC-09 on the sign-in pages (FR-AUTH-001, FR-AUTH-002, FR-LINE-001 AC2): before the page runs its script — a slow
// phone, a script that did not load — a form whose submit is handled by the script would be submitted by the browser
// itself, and a form without a method goes by GET: the password, the sign-in code or the e-mail typed would land in the
// page's address, the browser's history, request logs and Referer headers. Each page is opened here with JavaScript off
// (the page as the server sends it): its form posts, its submit button is disabled, Enter in the field sends nothing, and
// even with the button forced back on (as a browser extension could) the browser posts to the page's own address — no
// typed value and no field name is in any address the browser asked for. With the script, the same page's button comes
// on and the form is sent by the script: each page then answers as it does (a code without the password step, a token
// that is no invitation). The sign-in inside LIFF is drawn by the script only: with JavaScript off there is nothing to
// type in, and once drawn both of its forms post.

const run = () => randomBytes(3).toString('hex')

/** Runs tests/e2e/auth-prehydration-scene.ts against the e2e database and returns the JSON of its last line */
function signInScene(command: 'setup' | 'totp', testInfo: TestInfo): { readonly email: string; readonly employeeCode: string } {
  const tag = `${testInfo.project.name}-${run()}`
  const r = spawnSync(`pnpm exec tsx tests/e2e/auth-prehydration-scene.ts ${command} ${tag}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`sign-in scene ${command} failed:\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as { email: string; employeeCode: string }
}

/** A value as a person might type it, and as a GET submission would write it into an address (letters, digits and -) */
const typed = (what: string) => `${what}-${run()}-Zq7`

/**
 * expectNoValueInAddresses (settings-line-scene.ts), and the submission it forces once the button is back on is the
 * browser's own: a POST to the page's own address, its body never in an address
 */
async function expectPostOnly(page: Page, requested: readonly string[], field: Locator, submitName: string, values: readonly string[], names: readonly string[]) {
  const own = page.url()
  const posted = page.waitForRequest((r) => r.method() === 'POST' && r.isNavigationRequest()).catch(() => null)
  await expectNoValueInAddresses(page, requested, field, submitName, values, names)
  const post = await posted
  expect(post?.url()).toBe(own)
}

/**
 * The same for a page whose own address carries the token of the e-mailed link (/reset-password?token=…): nothing is
 * sent with the button disabled, and the forced submission posts to the address the link opened, which stays as it was
 */
async function expectPostOnlyKeepingAddress(page: Page, requested: readonly string[], field: Locator, submitName: string, values: readonly string[], names: readonly string[]) {
  const own = page.url()
  const form = page.locator('form').filter({ has: field })
  await expect(form).toHaveAttribute('method', 'post')
  const submit = form.getByRole('button', { name: submitName, exact: true })
  await expect(submit).toBeDisabled()
  await field.press('Enter')
  await page.waitForLoadState('networkidle')
  expect(page.url()).toBe(own)
  await submit.evaluate((button) => button.removeAttribute('disabled'))
  const posted = page.waitForRequest((r) => r.method() === 'POST' && r.isNavigationRequest()).catch(() => null)
  await field.press('Enter')
  expect((await posted)?.url()).toBe(own)
  await page.waitForLoadState('networkidle')
  expect(page.url()).toBe(own)
  for (const url of requested) {
    for (const value of values) expect(url, url).not.toContain(encodeURIComponent(value))
    for (const name of names) expect(url, url).not.toContain(`${name}=`)
  }
}

test('[FR-AUTH-001/AC1][NFR-SEC-09] /login with JavaScript off: the e-mail and the password never reach an address', async ({ page, browser, clientIp }, testInfo) => {
  const bare = await withoutScript(browser, page, testInfo, clientIp)
  try {
    await bare.page.goto('/login')
    await expect(bare.page.getByRole('heading', { level: 1, name: 'เข้าสู่ระบบ' })).toBeVisible()
    const email = `${typed('nobody')}@demo.bcs.local`.toLowerCase()
    const password = typed('Password')
    await bare.page.getByLabel('อีเมลบริษัท').fill(email)
    const field = bare.page.getByLabel('รหัสผ่าน', { exact: true })
    await field.fill(password)
    await expectPostOnly(bare.page, bare.requested, field, 'เข้าสู่ระบบ', [email, password], ['email', 'password'])
  } finally {
    await bare.page.context().close()
  }
  // With the script the button comes on (tests/e2e/auth.spec.ts signs in through it)
  await page.goto('/login')
  await expect(page.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true })).toBeEnabled()
})

test('[FR-AUTH-002/AC1][NFR-SEC-09] /login/2fa with JavaScript off: the code never reaches an address, and the switch to a backup code waits', async ({ page, browser, clientIp }, testInfo) => {
  const bare = await withoutScript(browser, page, testInfo, clientIp)
  try {
    await bare.page.goto('/login/2fa')
    await expect(bare.page.getByRole('heading', { level: 1, name: 'ยืนยันตัวตนขั้นที่สอง' })).toBeVisible()
    await expect(bare.page.getByRole('button', { name: 'ใช้รหัสสำรองแทน' })).toBeDisabled()
    const code = String(100000 + (randomBytes(3).readUIntBE(0, 3) % 900000))
    const field = bare.page.getByLabel('รหัส 6 หลักจากแอป')
    await field.fill(code)
    await expectPostOnly(bare.page, bare.requested, field, 'ยืนยันและเข้าสู่ระบบ', [code], ['code'])
  } finally {
    await bare.page.context().close()
  }
  // With the script, opened directly (not after the password step): the script sends the code, and the page says the
  // sign-in has to start again with the password
  await page.goto('/login/2fa')
  await page.getByLabel('รหัส 6 หลักจากแอป').fill('123456')
  await page.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' }).click()
  await expect(page.getByText('หมดเวลายืนยันตัวตน เข้าสู่ระบบด้วยรหัสผ่านอีกครั้ง')).toBeVisible()
  expect(new URL(page.url()).search).toBe('')
})

test('[FR-AUTH-001/AC2][NFR-SEC-09] /forgot-password with JavaScript off: the e-mail never reaches an address', async ({ page, browser, clientIp }, testInfo) => {
  const bare = await withoutScript(browser, page, testInfo, clientIp)
  try {
    await bare.page.goto('/forgot-password')
    const email = `${typed('nobody')}@demo.bcs.local`.toLowerCase()
    const field = bare.page.getByLabel('อีเมลบริษัท')
    await field.fill(email)
    await expectPostOnly(bare.page, bare.requested, field, 'ส่งลิงก์ตั้งรหัสผ่านใหม่', [email], ['email'])
  } finally {
    await bare.page.context().close()
  }
  // With the script: sent by the script, and the same answer whether or not the address has an account
  const address = `${typed('nobody')}@demo.bcs.local`.toLowerCase()
  await page.goto('/forgot-password')
  await page.getByLabel('อีเมลบริษัท').fill(address)
  await page.getByRole('button', { name: 'ส่งลิงก์ตั้งรหัสผ่านใหม่' }).click()
  await expect(page.getByText(/^ถ้าอีเมลนี้มีบัญชีใน BCS ระบบส่งลิงก์ตั้งรหัสผ่านใหม่ไปแล้ว/)).toBeVisible()
  expect(page.url()).not.toContain(encodeURIComponent(address))
})

test('[FR-AUTH-001/AC2][NFR-SEC-09] /reset-password with JavaScript off: the new password never reaches an address', async ({ page, browser, clientIp }, testInfo) => {
  const bare = await withoutScript(browser, page, testInfo, clientIp)
  try {
    // The form shows for any token: Better Auth checks it when the new password is sent
    await bare.page.goto(`/reset-password?token=${typed('not-a-token')}`)
    const password = typed('NewPassword')
    await bare.page.getByLabel('รหัสผ่านใหม่', { exact: true }).fill(password)
    const field = bare.page.getByLabel('ใส่รหัสผ่านใหม่อีกครั้ง')
    await field.fill(password)
    await expectPostOnlyKeepingAddress(bare.page, bare.requested, field, 'บันทึกรหัสผ่านใหม่', [password], ['password', 'confirm'])
  } finally {
    await bare.page.context().close()
  }
  // With the script: sent by the script to Better Auth, which refuses a token it never issued
  const newPassword = typed('NewPassword')
  await page.goto(`/reset-password?token=${typed('not-a-token')}`)
  await page.getByLabel('รหัสผ่านใหม่', { exact: true }).fill(newPassword)
  await page.getByLabel('ใส่รหัสผ่านใหม่อีกครั้ง').fill(newPassword)
  await page.getByRole('button', { name: 'บันทึกรหัสผ่านใหม่' }).click()
  await expect(page.getByText('ลิงก์นี้หมดอายุหรือใช้ไปแล้ว ขอลิงก์ใหม่ที่หน้า ลืมรหัสผ่าน')).toBeVisible()
  expect(page.url()).not.toContain(newPassword)
})

test('[FR-AUTH-001/AC1][NFR-SEC-09] /invite/[token] with JavaScript off: the password never reaches an address', async ({ page, browser, clientIp }, testInfo) => {
  const bare = await withoutScript(browser, page, testInfo, clientIp)
  try {
    // The form shows for any token: the invitation is checked when it is accepted (a POST server action, BR-TOK-03)
    await bare.page.goto(`/invite/${typed('not-a-token')}`)
    await expect(bare.page.getByRole('heading', { level: 1, name: 'ตั้งรหัสผ่านเพื่อเริ่มใช้งาน' })).toBeVisible()
    const password = typed('FirstPassword')
    await bare.page.getByLabel('รหัสผ่านใหม่', { exact: true }).fill(password)
    const field = bare.page.getByLabel('ใส่รหัสผ่านอีกครั้ง')
    await field.fill(password)
    await expectPostOnly(bare.page, bare.requested, field, 'ตั้งรหัสผ่านและเปิดใช้บัญชี', [password], ['password', 'confirm'])
  } finally {
    await bare.page.context().close()
  }
  // With the script: sent by the script to the server action, which knows no such invitation
  const firstPassword = typed('FirstPassword')
  await page.goto(`/invite/${typed('not-a-token')}`)
  await page.getByLabel('รหัสผ่านใหม่', { exact: true }).fill(firstPassword)
  await page.getByLabel('ใส่รหัสผ่านอีกครั้ง').fill(firstPassword)
  await page.getByRole('button', { name: 'ตั้งรหัสผ่านและเปิดใช้บัญชี' }).click()
  await expect(page.getByText('ลิงก์เชิญนี้ไม่ถูกต้อง ขอลิงก์ใหม่จากผู้ดูแลระบบขององค์กร')).toBeVisible()
  expect(page.url()).not.toContain(firstPassword)
})

test('[FR-AUTH-002/AC1][NFR-SEC-09] the authenticator setup with JavaScript off: the password never reaches an address; with it, both of its forms post', async ({ page, browser, clientIp }, testInfo) => {
  // A member with a role and no authenticator app yet: the workspace shows the setup before any work
  const member = signInScene('setup', testInfo)
  await page.goto('/login')
  await page.getByLabel('อีเมลบริษัท').fill(member.email)
  await page.getByLabel('รหัสผ่าน', { exact: true }).fill(process.env.SEED_DEV_PASSWORD!)
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'การยืนยันตัวตนสองชั้น' })).toBeVisible()

  // The same member on a slow phone, or with a script that did not load
  const bare = await withoutScript(browser, page, testInfo, clientIp)
  try {
    await bare.page.goto('/')
    await expect(bare.page.getByRole('heading', { level: 1, name: 'การยืนยันตัวตนสองชั้น' })).toBeVisible()
    const password = typed('Password')
    const field = bare.page.getByLabel('รหัสผ่าน', { exact: true })
    await field.fill(password)
    await expectPostOnly(bare.page, bare.requested, field, 'เริ่มตั้งค่าแอปยืนยันตัวตน', [password], ['password'])
  } finally {
    await bare.page.context().close()
  }

  // With the script: the password step posts, and so does the code step it opens
  const start = page.getByRole('button', { name: 'เริ่มตั้งค่าแอปยืนยันตัวตน' })
  await expect(start).toBeEnabled()
  const passwordField = page.getByLabel('รหัสผ่าน', { exact: true })
  await expect(page.locator('form').filter({ has: passwordField })).toHaveAttribute('method', 'post')
  await passwordField.fill(process.env.SEED_DEV_PASSWORD!)
  await start.click()
  const codeField = page.getByLabel('รหัส 6 หลักจากแอป')
  await expect(codeField).toBeVisible()
  await expect(page.locator('form').filter({ has: codeField })).toHaveAttribute('method', 'post')
  await expect(page.getByRole('button', { name: 'ยืนยันและเปิดใช้' })).toBeEnabled()
  expect(new URL(page.url()).search).toBe('')
})

// At both widths of the run: the phone in the LINE app, and LINE on a computer (§9.4)
test('[FR-LINE-001/AC2][NFR-SEC-09] /liff/link: the sign-in inside LIFF is drawn by the script only, and both of its forms post', async ({ page, context, browser, clientIp }, testInfo) => {
  // A LINE account that is not linked to anyone
  await openAsLineUser(context, newLineUserId())

  // JavaScript off: the page says it is signing in with LINE, with nothing to type a password or a code into
  const bare = await withoutScript(browser, page, testInfo, clientIp)
  try {
    await bare.page.goto('/liff/link')
    await expect(bare.page.getByRole('status').filter({ hasText: 'กำลังยืนยันตัวตนด้วยบัญชี LINE' })).toBeVisible()
    await expect(bare.page.locator('input[type="password"], input[type="email"], input[name="code"]')).toHaveCount(0)
  } finally {
    await bare.page.context().close()
  }

  // With the script: the e-mail and password form posts, and so does the second step it opens
  const member = signInScene('totp', testInfo)
  await page.goto('/liff/link')
  await expect(page.getByRole('heading', { level: 2, name: 'เข้าสู่ระบบ BCS เพื่อผูกบัญชี' })).toBeVisible()
  const passwordField = page.getByLabel('รหัสผ่าน', { exact: true })
  await expect(page.locator('form').filter({ has: passwordField })).toHaveAttribute('method', 'post')
  await page.getByLabel('อีเมลบริษัท').fill(member.email)
  await passwordField.fill(process.env.SEED_DEV_PASSWORD!)
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
  await expect(page.getByRole('heading', { level: 2, name: 'ยืนยันตัวตนขั้นที่สอง' })).toBeVisible()
  const codeField = page.getByLabel('รหัส 6 หลักจากแอป')
  await expect(page.locator('form').filter({ has: codeField })).toHaveAttribute('method', 'post')
  await expect(page.getByRole('button', { name: 'ใช้รหัสสำรองแทน' })).toBeEnabled()
  expect(new URL(page.url()).search).toBe('')
})
