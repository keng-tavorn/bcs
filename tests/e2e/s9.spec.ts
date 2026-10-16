import { spawnSync } from 'node:child_process'
import type { Browser, Page, TestInfo } from '@playwright/test'
import { deriveSeedTotpSecret, totp } from '../../src/lib/totp'
import { E2E_PIN, e2eEnv } from '../support/e2e-env'
import { messagesTo } from '../support/mailpit'
import { check, h1, SCENE_TEST_TIMEOUT_MS, tagOf } from './finance-support'
import { expect, test } from './fixtures'

// S9-09 (docs/sub-specs/S9.md "หน้าจอ" and "Demo ของขั้น", web part · e2e @pay): the Workspace screens of payment runs and
// bank accounts, each test on an organization of its own made by tests/e2e/pay-scene.ts (mode web) —
//   FINANCE prepares the run the system proposes, explains the flagged supplier and sends it; the CFO opens it from the
//   task, ticks the flags and approves with the PIN; FINANCE makes the neutral file, downloads it, marks it sent and
//   records the results (one supplier failed); the paid suppliers get their payment advice (Mailpit); AUDITOR reads the
//   run with the accounts masked;
//   FINANCE proposes a supplier's new account from the supplier's card with its proof and the call to the register
//   number; the CFO approves it with the PIN on the web; the supplier is told at the register address.
// Every state is checked with axe, no sideways scrolling and pictures at 375 px and 1440 px (§9.9).

interface WebScene {
  readonly orgCode: string
  readonly suppliers: ReadonlyArray<{ readonly id: string; readonly code: string; readonly email: string; readonly accountNo: string; readonly last4: string }>
}

function payScene<T>(...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/pay-scene.ts ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`payment scene ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}

/** A member of the scene's organization signs in: e-mail <code>.<tag>@pay.bcs.local, TOTP as the scene derived it */
async function signIn(page: Page, code: string, tag: string) {
  const local = `${code}.${tag}`
  await page.goto('/login')
  await page.getByLabel('อีเมลบริษัท').fill(`${local}@pay.bcs.local`)
  await page.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
  await expect(page).toHaveURL(/\/login\/2fa$/)
  await page.getByLabel('รหัส 6 หลักจากแอป').fill(totp(deriveSeedTotpSecret(process.env.SEED_TOTP_KEY!, local)))
  await page.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' }).click()
  await expect(h1(page)).toContainText('สวัสดี')
}

async function as(browser: Browser, page: Page, code: string, tag: string): Promise<Page> {
  const viewport = page.viewportSize()
  const context = await browser.newContext({ ...(viewport ? { viewport } : {}), locale: 'th-TH', timezoneId: 'Asia/Bangkok' })
  const other = await context.newPage()
  await signIn(other, code, tag)
  return other
}

/** A tab of the run's page */
async function tab(page: Page, name: string) {
  await page.getByRole('tab', { name, exact: true }).click()
  await expect(page.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true')
}

async function shot(page: Page, testInfo: TestInfo, name: string) {
  await check(page, testInfo, `s9-${name}`)
}

test.describe('@pay payment runs and bank accounts on the web (S9-09)', () => {
  test.describe.configure({ timeout: SCENE_TEST_TIMEOUT_MS * 2 })

  test('[FR-PAY-101/AC1] [FR-PAY-101/AC5] [FR-PAY-102/AC1] [FR-PAY-102/AC6] [FR-PAY-103/AC1] [FR-PAY-103/AC3] a run from the proposal to the suppliers’ e-mail', async ({ page, browser }, testInfo) => {
    const tag = tagOf(testInfo).toLowerCase()
    const made = payScene<WebScene>('web', tag)
    const [paid, failed, flagged] = made.suppliers

    // FINANCE: no run yet, then the proposal (the three ready invoices, the payer CB-01)
    await signIn(page, 'fin_officer', tag)
    await page.goto('/finance/payments')
    await expect(h1(page)).toHaveText('รอบจ่าย')
    await expect(page.getByText('ยังไม่มีรอบจ่าย')).toBeVisible()
    await shot(page, testInfo, 'list-empty')
    await page.getByRole('link', { name: 'เตรียมรอบจ่าย' }).first().click()
    await expect(h1(page)).toHaveText('เตรียมรอบจ่าย')
    await expect(page.getByText(/3 เอกสารจากผู้ขาย 3 ราย/)).toBeVisible()
    await shot(page, testInfo, 'new')
    await page.getByRole('button', { name: 'สร้างร่างรอบจ่าย' }).click()
    await expect(h1(page)).toHaveText('ร่างรอบจ่าย', { timeout: 30_000 })
    const runUrl = page.url()
    const runId = new URL(runUrl).pathname.split('/').at(-1)!

    // the ceased supplier is flagged first and needs the preparer's reason before sending
    await expect(page.getByText('ธงนี้ต้องมีเหตุผลก่อนส่งขออนุมัติ')).toBeVisible()
    await shot(page, testInfo, 'draft-flagged')
    await page.getByLabel('เหตุผลของธง (ผู้อนุมัติจะเห็น)').fill('ส่งมอบงานครบก่อนเลิกกิจการ ตรวจกับจัดซื้อแล้ว')
    await page.getByRole('button', { name: 'บันทึกเหตุผลของธง' }).click()
    await expect(page.getByText('บันทึกเหตุผลของธงแล้ว').first()).toBeVisible()
    // the page refreshes itself after the save; reading it again makes sure the send carries the run's new version
    await page.reload()
    await expect(page.getByText('เหตุผลจากผู้เตรียม: ส่งมอบงานครบก่อนเลิกกิจการ ตรวจกับจัดซื้อแล้ว')).toBeVisible()
    await page.getByRole('button', { name: 'ส่งขออนุมัติ', exact: true }).click()
    await expect(page.getByText(/ส่งขออนุมัติแล้ว เลขรอบจ่าย PAY-/).first()).toBeVisible({ timeout: 30_000 })
    await page.reload()
    const number = (await h1(page).textContent())!.replace('รอบจ่าย ', '').trim()
    expect(number).toMatch(/^PAY-/)

    // the CFO: the task opens the run's page; the flags ticked, then the PIN (over the stepUpThreshold)
    const cfo = await as(browser, page, 'cfo', tag)
    await cfo.goto('/tasks')
    await cfo.getByRole('link', { name: new RegExp(number) }).first().click()
    await expect(cfo).toHaveURL(new RegExp(`/finance/payments/${runId}$`))
    await expect(h1(cfo)).toHaveText(`รอบจ่าย ${number}`)
    const bar = cfo.getByRole('region', { name: 'ตัดสินรอบจ่ายนี้' })
    await expect(bar).toBeVisible()
    await shot(cfo, testInfo, 'approve')
    await bar.getByRole('button', { name: 'อนุมัติรอบจ่าย' }).click()
    await expect(bar.getByText('ติ๊กว่าตรวจรายการที่มีธงแล้วก่อนอนุมัติ')).toBeVisible()
    await bar.getByRole('checkbox', { name: 'ตรวจรายการที่มีธง 1 รายการแล้ว' }).check()
    await bar.getByRole('button', { name: 'อนุมัติรอบจ่าย' }).click()
    await bar.getByLabel('PIN 6 หลัก').fill(E2E_PIN)
    await bar.getByRole('button', { name: 'ยืนยันอนุมัติ' }).click()
    await expect(cfo.getByText('อนุมัติรอบจ่ายแล้ว').first()).toBeVisible({ timeout: 30_000 })
    await cfo.context().close()

    // FINANCE: the neutral file, downloaded by POST, then marked sent
    await page.reload()
    await tab(page, 'ไฟล์')
    await page.getByRole('button', { name: 'สร้างไฟล์ธนาคาร' }).click()
    await expect(page.getByText('สร้างไฟล์ธนาคารแล้ว').first()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText('แม่แบบกลางสำหรับทดสอบ ไม่ใช่รูปแบบของธนาคารใด ธนาคารจะไม่รับไฟล์นี้').first()).toBeVisible()
    await expect(page.getByRole('button', { name: 'ส่งธนาคารแล้ว' })).toBeDisabled()
    await shot(page, testInfo, 'file')
    const fileName = `BCS-NEUTRAL-1_NOT-A-BANK-FORMAT_${number}_v1.csv`
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: `ดาวน์โหลด ${fileName}` }).click()
    expect((await download).suggestedFilename()).toBe(fileName)
    await page.goto(`${runUrl}?tab=files`)
    await page.getByRole('button', { name: 'ส่งธนาคารแล้ว' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'ยืนยันส่งธนาคารแล้ว' }).click()
    await expect(page.getByText('บันทึกว่าส่งธนาคารแล้ว').first()).toBeVisible({ timeout: 30_000 })

    // the bank paid today: results — every item paid but one
    payScene('payday', runId)
    await page.reload()
    await tab(page, 'ผลการจ่าย')
    await page.getByRole('radiogroup', { name: `ผลของ ${failed!.code}` }).getByRole('radio', { name: 'ไม่สำเร็จ' }).click()
    await page.getByLabel('เหตุผลที่ไม่สำเร็จ').fill('บัญชีปิดแล้ว ธนาคารคืนเงิน')
    await shot(page, testInfo, 'results')
    await page.getByRole('button', { name: 'บันทึกผลการจ่าย' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'ยืนยันบันทึกผล' }).click()
    await expect(page.getByText('บันทึกผลครบทุกรายการ รอบจ่ายเสร็จแล้ว').first()).toBeVisible({ timeout: 30_000 })
    await page.reload()
    await expect(page.getByText('เสร็จ', { exact: true }).first()).toBeVisible()
    await shot(page, testInfo, 'completed')

    // the payment advice: the paid suppliers get theirs (the job that sends supplier e-mails runs in the scene)
    payScene('notices')
    for (const s of [paid!, flagged!]) {
      const advice = (await messagesTo(s.email)).filter((m) => m.Subject.includes('Payment advice'))
      expect(advice, s.code).toHaveLength(1)
      expect(advice[0]!.Text).toContain(`ลงท้าย ${s.last4}`)
      expect(advice[0]!.Text).not.toContain(s.accountNo)
    }
    expect((await messagesTo(failed!.email)).filter((m) => m.Subject.includes('Payment advice'))).toHaveLength(0)

    // AUDITOR reads the run, the accounts masked
    const auditor = await as(browser, page, 'auditor', tag)
    await auditor.goto(runUrl)
    await expect(auditor.getByText('คุณดูรอบจ่ายนี้ได้อย่างเดียว เลขบัญชีแสดงเฉพาะ 4 หลักท้าย')).toBeVisible()
    const html = await auditor.content()
    for (const s of made.suppliers) expect(html.includes(s.accountNo), `${s.code}'s number whole`).toBe(false)
    await shot(auditor, testInfo, 'auditor')
    await auditor.context().close()
  })

  test('[FR-PAY-102/AC7] [FR-PAY-102/AC8] a supplier’s new account: proposed with its proof and the call, approved with the PIN on the web, the supplier told', async ({ page, browser }, testInfo) => {
    const tag = tagOf(testInfo).toLowerCase()
    const made = payScene<WebScene>('web', tag)
    const supplier = made.suppliers[0]!

    // FINANCE: the supplier's card, masked, then the proposal from it
    await signIn(page, 'fin_officer', tag)
    await page.goto(`/suppliers/${supplier.id}`)
    const card = page.getByRole('region', { name: 'บัญชีรับเงิน' })
    await expect(card).toContainText(supplier.last4)
    expect(await card.textContent()).not.toContain(supplier.accountNo)
    await shot(page, testInfo, 'supplier-card')
    await card.getByRole('link', { name: 'เสนอเปลี่ยนบัญชี' }).click()
    await expect(page).toHaveURL(/\/finance\/bank-accounts\/changes\/new/)
    await page.getByRole('radio', { name: /เปลี่ยนบัญชี/ }).check()
    await shot(page, testInfo, 'change-step-1')
    await page.getByRole('button', { name: 'ถัดไป: ใส่บัญชีใหม่และหลักฐาน' }).click()
    await page.getByLabel('ธนาคาร', { exact: true }).selectOption('002')
    await page.getByLabel('เลขบัญชี', { exact: true }).fill('3030303031')
    await page.getByLabel('ชื่อบัญชี', { exact: true }).fill(`ผู้ขาย ${supplier.code.slice(3)}`)
    await page.locator('input[type="file"]').setInputFiles({ name: 'bank-letter.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\n' + 'x'.repeat(200) + '\n%%EOF\n', 'latin1') })
    await expect(page.getByText('bank-letter.pdf').first()).toBeVisible({ timeout: 30_000 })
    await page.getByLabel('บันทึกการโทร').fill('โทรเบอร์ในทะเบียน คุยกับฝ่ายบัญชีของผู้ขาย ยืนยันการเปลี่ยนตามหนังสือ')
    await page.getByRole('checkbox', { name: 'ฉันโทรเบอร์ในทะเบียนผู้ขายแล้ว และผู้ขายยืนยันการเปลี่ยนนี้' }).check()
    await page.getByLabel('เหตุผลของคำขอ').fill('ผู้ขายแจ้งเปลี่ยนบัญชีรับเงินเป็นบัญชีใหม่')
    await shot(page, testInfo, 'change-step-2')
    await page.getByRole('button', { name: 'บันทึกและส่งขออนุมัติ' }).click()
    await expect(page).toHaveURL(/\/finance\/bank-accounts\/changes\/[0-9a-f-]{36}(\?|$)/, { timeout: 30_000 })
    const changeUrl = new URL(page.url()).pathname
    await expect(page.getByText('รออนุมัติ').first()).toBeVisible()
    await shot(page, testInfo, 'change-sent')

    // the CFO: both accounts masked; approving always asks for the PIN (BR-DOA-25)
    const cfo = await as(browser, page, 'cfo', tag)
    await cfo.goto(changeUrl)
    const bar = cfo.getByRole('region', { name: 'ตัดสินคำขอนี้' })
    await expect(bar).toBeVisible()
    const html = await cfo.content()
    expect(html.includes('3030303031')).toBe(false)
    expect(html.includes(supplier.accountNo)).toBe(false)
    await shot(cfo, testInfo, 'change-approve')
    await bar.getByRole('button', { name: 'อนุมัติ', exact: true }).click()
    await bar.getByLabel('PIN 6 หลัก').fill(E2E_PIN)
    await bar.getByRole('button', { name: 'ยืนยันอนุมัติ' }).click()
    await expect(cfo.getByText('อนุมัติแล้ว').first()).toBeVisible({ timeout: 30_000 })
    await cfo.context().close()

    // the supplier hears of it at the register address
    payScene('notices')
    const told = (await messagesTo(supplier.email)).filter((m) => m.Subject.includes('Your bank account for payments was recorded'))
    expect(told).toHaveLength(1)
    expect(told[0]!.Text).toContain('3031')
    expect(told[0]!.Text).not.toContain('3030303031')

    // the bank accounts page lists the request as approved
    await page.goto('/finance/bank-accounts?tab=all')
    await expect(h1(page)).toHaveText('บัญชีธนาคาร')
    await shot(page, testInfo, 'bank-accounts')
  })
})
