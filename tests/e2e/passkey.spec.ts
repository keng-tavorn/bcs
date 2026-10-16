import { spawnSync } from 'node:child_process'
import type { CDPSession, Page, TestInfo } from '@playwright/test'
import { E2E_PIN, e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'
import { castOf, expectNoBlockingAxe, expectNoSideways, PIN_LABEL, shot, signIn, stepUpFixture } from './tasks-support'

// S17-15 passkeys (FR-PLT-301 AC3 AC4, FR-AUTH-005 AC6, BR-AUTH-09 BR-AUTH-10, ADR-166) in Chromium with its virtual
// authenticator (DevTools WebAuthn): a platform authenticator with user verification, as a phone's fingerprint is. A
// member adds a passkey on /settings/pin after proving who they are again, then approves a task at the step-up
// threshold with it in place of the PIN; with the user not verified nothing is decided; the PIN still decides the next
// task. The refusals of the server one fact at a time are tests/integration/passkey-step-up.test.ts. Each test leaves
// the approver without a passkey, as the other specs of the run expect them.

function scene(command: string, code: string): unknown {
  const r = spawnSync(`pnpm exec tsx tests/e2e/passkey-scene.ts ${command} ${code}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`passkey scene ${command} failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!)
}

/** Chromium's virtual authenticator for this page: internal (a platform one), resident keys, user verification on */
async function authenticator(page: Page): Promise<{ cdp: CDPSession; id: string }> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  })
  return { cdp, id: authenticatorId }
}

/** Adds a passkey on /settings/pin: the password again, the device's name, the virtual fingerprint */
async function addPasskey(page: Page, testInfo: TestInfo, name: string) {
  await page.goto('/settings/pin')
  await page.getByRole('button', { name: 'เพิ่ม passkey บนเครื่องนี้' }).click()
  const form = page.locator('form').filter({ has: page.getByRole('heading', { name: 'ยืนยันตัวตนก่อนเพิ่ม passkey' }) })
  // Members with an authenticator app choose between it and the password: the password here
  if (await form.getByRole('radio').count()) await form.getByRole('radio').first().check()
  await form.locator('#passkey-password').fill(process.env.SEED_DEV_PASSWORD!)
  await form.getByLabel('ชื่อเครื่อง').fill(name)
  await shot(page, testInfo, 'passkey-add')
  await form.getByRole('button', { name: 'ยืนยันและเพิ่ม passkey' }).click()
  await expect(page.getByText('เพิ่ม passkey แล้ว ระบบส่งอีเมลแจ้งคุณด้วย')).toBeVisible()
  await expect(page.getByRole('listitem').filter({ hasText: name })).toBeVisible()
}

test('[FR-PLT-301/AC4] [FR-AUTH-005/AC6] a member adds a passkey after proving who they are again, sees it listed and removes it', async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  const cast = castOf(testInfo)
  await authenticator(page)
  await signIn(page, cast.approver, true)
  try {
    await addPasskey(page, testInfo, 'โทรศัพท์ทดสอบ')
    await expectNoBlockingAxe(page)
    await expectNoSideways(page)
    await shot(page, testInfo, 'passkey-listed')
    await page.getByRole('button', { name: 'ลบ โทรศัพท์ทดสอบ' }).click()
    const dialog = page.getByRole('alertdialog', { name: 'ลบ โทรศัพท์ทดสอบ?' })
    await expect(dialog).toBeVisible()
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'))
    await expectNoBlockingAxe(page)
    await dialog.getByRole('button', { name: 'ลบ passkey นี้' }).click()
    await expect(page.getByText('ลบ passkey แล้ว')).toBeVisible()
    await expect(page.getByText('ยังไม่มี passkey')).toBeVisible()
  } finally {
    scene('off', cast.approver)
  }
})

test('[FR-PLT-301/AC3] [FR-AUTH-005/AC2] [FR-AUTH-005/AC6] a task at the step-up threshold is approved with a passkey; unverified nothing is decided; the PIN still decides', async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  const cast = castOf(testInfo)
  const first = stepUpFixture<{ taskId: string; number: string }>('at-threshold', cast.requester)
  const second = stepUpFixture<{ taskId: string; number: string }>('at-threshold', cast.requester)
  const device = await authenticator(page)
  await signIn(page, cast.approver, true)
  try {
    await addPasskey(page, testInfo, 'โทรศัพท์อนุมัติ')
    await page.goto(`/tasks/${first.taskId}`)
    await page.getByRole('button', { name: 'อนุมัติ', exact: true }).click()
    const confirm = page.getByRole('group', { name: new RegExp(`^อนุมัติ ${first.number} `) })
    await expect(confirm.getByLabel(PIN_LABEL)).toBeVisible()
    const withPasskey = confirm.getByRole('button', { name: 'อนุมัติด้วยลายนิ้วมือหรือใบหน้า (passkey)' })
    await expect(withPasskey).toBeVisible()
    await expectNoBlockingAxe(page)
    await expectNoSideways(page)
    await shot(page, testInfo, 'passkey-decide')

    // The fingerprint does not match (the user is not verified): the device gives no answer, nothing is approved
    await device.cdp.send('WebAuthn.setUserVerified', { authenticatorId: device.id, isUserVerified: false })
    await withPasskey.click()
    await expect(withPasskey).toBeEnabled()
    await expect(page.getByText('อนุมัติแล้ว', { exact: true })).toHaveCount(0)
    expect((scene('grants', cast.approver) as { grants: Array<{ method: string }> }).grants.filter((g) => g.method === 'PASSKEY')).toEqual([])

    // Verified: approved with a grant of the passkey, used by the decision
    await device.cdp.send('WebAuthn.setUserVerified', { authenticatorId: device.id, isUserVerified: true })
    await withPasskey.click()
    await expect(page.getByText('อนุมัติแล้ว', { exact: true })).toBeVisible()
    expect((scene('grants', cast.approver) as { grants: unknown[] }).grants[0]).toEqual({ method: 'PASSKEY', used: true, subjectType: 'REQUEST' })
    await shot(page, testInfo, 'passkey-approved')

    // The PIN still decides, with a passkey on the device
    await page.goto(`/tasks/${second.taskId}`)
    await page.getByRole('button', { name: 'อนุมัติ', exact: true }).click()
    const again = page.getByRole('group', { name: new RegExp(`^อนุมัติ ${second.number} `) })
    await again.getByLabel(PIN_LABEL).fill(E2E_PIN)
    await again.getByRole('button', { name: 'ยืนยันอนุมัติ' }).click()
    await expect(page.getByText('อนุมัติแล้ว', { exact: true })).toBeVisible()
    expect((scene('grants', cast.approver) as { grants: unknown[] }).grants[0]).toEqual({ method: 'PIN', used: true, subjectType: 'REQUEST' })
  } finally {
    scene('off', cast.approver)
  }
})
