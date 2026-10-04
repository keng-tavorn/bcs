import type { Page } from '@playwright/test'
import { E2E_PIN } from '../support/e2e-env'
import { expect, test } from './fixtures'
import { checkScreen, signInAs } from './insight-support'
import { totpOf } from './tasks-support'
import { expectNoValueInAddresses, noPinMemberOf, pinChangerOf, pinSetterOf, withoutScript } from './settings-line-scene'

// FR-AUTH-005 AC1 (/settings/pin, ADR-047): a member proves who they are again — the password on desktop, the
// authenticator code on the phone — and sets a 6-digit PIN typed twice; PINs that are easy to guess (a run, a common
// one) are refused in words and the rules are on the page; a PIN pasted with spaces or dashes keeps its six digits. An
// approver who has the seed's PIN changes it the same way. The proof lives in the page only, and before the page runs
// its script step 1 sends nothing, so the password never reaches an address (NFR-SEC-09). Screens at the project's width
// with axe (§9.9).

const NEW_PIN = '582931'

test('[FR-AUTH-005/AC1] a member proves who they are, then sets a PIN the rules accept; easy PINs are refused in words', async ({ page }, testInfo) => {
  const member = pinSetterOf(testInfo)
  const withCode = testInfo.project.name === 'mobile'
  await signInAs(page, member.code, member.totp)
  await page.goto('/settings/pin')
  await expect(page.getByRole('heading', { level: 1, name: 'PIN ยืนยันธุรกรรม' })).toBeVisible()
  await expect(page.getByText('ยังไม่ได้ตั้ง PIN', { exact: true })).toBeVisible()
  // The rules in words
  const rules = page.getByRole('region', { name: 'PIN ที่ใช้ได้' })
  await expect(rules.getByRole('listitem')).toHaveText([
    'ตัวเลข 6 หลัก',
    'ไม่ใช่เลขเดียวกันทั้งชุด เช่น 000000',
    'ไม่ใช่เลขเรียงขึ้นหรือลง เช่น 123456 หรือ 654321',
    'ไม่ใช่เลขที่คนใช้บ่อย เช่น 121212 หรือ 147258',
  ])
  await expect(page.getByRole('heading', { name: 'ขั้นที่ 1 จาก 2: ยืนยันว่าเป็นคุณ' })).toBeVisible()
  // The button is enabled once the page runs its script (src/ui/form/hydrated.ts)
  await expect(page.getByRole('button', { name: 'ยืนยันตัวตน' })).toBeEnabled()
  await checkScreen(page, testInfo, 'settings-pin')

  // Step 1: a wrong answer is said under its field, then the right one
  if (withCode) {
    await page.getByRole('radio', { name: 'รหัส 6 หลักจากแอปยืนยันตัวตน' }).check()
    await page.getByLabel('รหัส 6 หลักที่แอปแสดงตอนนี้').fill('12345')
    await page.getByRole('button', { name: 'ยืนยันตัวตน' }).click()
    await expect(page.getByText('ใส่รหัส 6 หลักจากแอปยืนยันตัวตน')).toBeVisible()
    await page.getByLabel('รหัส 6 หลักที่แอปแสดงตอนนี้').fill(totpOf(member.code))
  } else {
    await page.getByLabel('รหัสผ่านของคุณ').fill('not-the-password-of-this-member')
    await page.getByRole('button', { name: 'ยืนยันตัวตน' }).click()
    await expect(page.getByText('รหัสผ่านไม่ถูกต้อง ลองอีกครั้ง')).toBeVisible()
    await expect(page.getByLabel('รหัสผ่านของคุณ')).toHaveAttribute('aria-invalid', 'true')
    await page.getByLabel('รหัสผ่านของคุณ').fill(process.env.SEED_DEV_PASSWORD!)
  }
  await page.getByRole('button', { name: 'ยืนยันตัวตน' }).click()

  // Step 2: the new PIN twice
  await expect(page.getByRole('heading', { name: 'ขั้นที่ 2 จาก 2: ตั้ง PIN ใหม่' })).toBeVisible()
  await expect(page.getByText(/^ยืนยันตัวตนแล้ว ตั้ง PIN ให้เสร็จก่อน \d{1,2} .+ \d{4} \d{2}:\d{2} น\.$/)).toBeVisible()
  // The proof is in the page only, never in its address
  expect(page.url()).toMatch(/\/settings\/pin$/)
  const pin = page.getByLabel('PIN ใหม่ 6 หลัก')
  const repeat = page.getByLabel('ใส่ PIN ใหม่อีกครั้ง')
  const submit = page.getByRole('button', { name: 'ตั้ง PIN', exact: true })
  // A PIN is not a password of the account: the browser is never asked to generate, save or fill one here
  for (const field of [pin, repeat]) {
    await expect(field).toHaveAttribute('type', 'password')
    await expect(field).toHaveAttribute('autocomplete', 'one-time-code')
    await expect(field).toHaveAttribute('inputmode', 'numeric')
    await expect(field).toHaveAttribute('data-bwignore', 'true')
  }
  // Digits only: anything else typed is dropped as it comes in
  await pin.fill('58a9-1')
  await expect(pin).toHaveValue('5891')
  // A PIN pasted with a space or dashes keeps all six digits (no maxLength cuts it first), and a seventh does not fit
  expect(await pin.getAttribute('maxlength')).toBeNull()
  for (const pasted of ['582 931', '58-29-31']) {
    await pin.fill('')
    await pin.focus()
    await page.keyboard.insertText(pasted)
    await expect(pin).toHaveValue(NEW_PIN)
  }
  await pin.fill('5829317')
  await expect(pin).toHaveValue(NEW_PIN)

  await pin.fill(NEW_PIN)
  await repeat.fill('582930')
  await submit.click()
  await expect(page.getByText('PIN สองช่องไม่ตรงกัน ใส่ให้ตรงกัน')).toBeVisible()

  for (const [easy, words] of [
    ['123456', 'PIN นี้เป็นเลขเรียง เดาง่ายเกินไป เลือก PIN อื่น'],
    ['147258', 'PIN นี้เป็นเลขที่คนใช้บ่อย เดาง่ายเกินไป เลือก PIN อื่น'],
    ['777777', 'PIN นี้เป็นเลขเดียวกันทั้งชุด เดาง่ายเกินไป เลือก PIN อื่น'],
  ] as const) {
    await pin.fill(easy)
    await repeat.fill(easy)
    await submit.click()
    await expect(page.getByText(words)).toBeVisible()
    // Refused PINs are cleared, to be typed again
    await expect(pin).toHaveValue('')
  }
  await checkScreen(page, testInfo, 'settings-pin-refused')

  await pin.fill(NEW_PIN)
  await repeat.fill(NEW_PIN)
  await submit.click()
  await expect(page.getByRole('status').filter({ hasText: 'ตั้ง PIN แล้ว ใช้ PIN นี้ยืนยันการอนุมัติครั้งต่อไป' })).toBeVisible()
  await expect(page.getByText('ตั้ง PIN แล้ว', { exact: true })).toBeVisible()
  await expect(page.getByText('ใส่ PIN ผิดได้อีก 5 ครั้งก่อนถูกล็อกชั่วคราว')).toBeVisible()
  await expect(page.getByRole('button', { name: 'เปลี่ยน PIN', exact: true })).toBeVisible()
  await checkScreen(page, testInfo, 'settings-pin-set')
})

test('[FR-AUTH-005/AC1][NFR-SEC-09] before the page runs its script, step 1 sends nothing and never puts the password in an address', async ({ page, browser, clientIp }, testInfo) => {
  const member = noPinMemberOf(testInfo)
  await signInAs(page, member.code, member.totp)
  // The same member on a slow phone, or with a script that did not load: step 1 is in the page the server sends
  const bare = await withoutScript(browser, page, testInfo, clientIp)
  try {
    await bare.page.goto('/settings/pin')
    await expect(bare.page.getByRole('heading', { name: 'ขั้นที่ 1 จาก 2: ยืนยันว่าเป็นคุณ' })).toBeVisible()
    const password = 'not-the-real-password-123'
    const field = bare.page.getByLabel('รหัสผ่านของคุณ')
    await field.fill(password)
    await expectNoValueInAddresses(bare.page, bare.requested, field, 'ยืนยันตัวตน', [password], ['password', 'method'])
  } finally {
    await bare.page.context().close()
  }
})

/** "เปลี่ยน PIN": prove who you are with the password, then the new PIN twice */
async function changePin(page: Page, pin: string) {
  await page.getByRole('button', { name: 'เปลี่ยน PIN', exact: true }).click()
  await page.getByLabel('รหัสผ่านของคุณ').fill(process.env.SEED_DEV_PASSWORD!)
  await page.getByRole('button', { name: 'ยืนยันตัวตน' }).click()
  await page.getByLabel('PIN ใหม่ 6 หลัก').fill(pin)
  await page.getByLabel('ใส่ PIN ใหม่อีกครั้ง').fill(pin)
  await page.getByRole('button', { name: 'เปลี่ยน PIN', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'เปลี่ยน PIN แล้ว ใช้ PIN ใหม่ยืนยันการอนุมัติครั้งต่อไป' })).toBeVisible()
}

test('[FR-AUTH-005/AC1] an approver with a PIN changes it after proving who they are again', async ({ page }, testInfo) => {
  const approver = pinChangerOf(testInfo)
  await signInAs(page, approver.code, approver.totp)
  await page.goto('/settings/pin')
  await expect(page.getByText('ตั้ง PIN แล้ว', { exact: true })).toBeVisible()
  // Nothing to fill until they choose to change it
  await expect(page.getByLabel('รหัสผ่านของคุณ')).toHaveCount(0)
  await changePin(page, NEW_PIN)
  await checkScreen(page, testInfo, 'settings-pin-changed')
  // Each change proves who they are again (a proof is spent with the PIN it was made for); and back to the seed's PIN,
  // which the other specs of a full run decide with
  await expect(page.getByLabel('รหัสผ่านของคุณ')).toHaveCount(0)
  await changePin(page, E2E_PIN)
})
