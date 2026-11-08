import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { Page, TestInfo } from '@playwright/test'
import { messagesTo } from '../support/mailpit'
import { e2eEnv } from '../support/e2e-env'
import { expectNoBlockingAxe, expectNoSideways } from './budgets-support'
import { expect, test } from './fixtures'

// S11-05 (FR-RSK-201 AC5 · BR-RSK-17): the supplier's contact answers the risk questionnaire on a phone (375 px) with the
// AI off — from the link of the e-mail, the six-digit code, straight to the questionnaire (the link was sent for it),
// every question of the set answered and saved, then sent; the assessment completes with no reviewer rule. axe on each
// page, no sideways scrolling, a picture of each state.

function scene<T>(...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/risk-portal-scene.ts ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`risk portal scene ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}

/** The sign-in code of the contact: from its notice before it is sent, else from the e-mail Mailpit holds */
async function codeOf(contactId: string, email: string): Promise<string> {
  try {
    return scene<{ code: string }>('otp', contactId).code
  } catch {
    const mails = await messagesTo(email)
    const text = mails.at(-1)?.Text ?? ''
    return /\b(\d{6})\b/.exec(text)?.[1] ?? ''
  }
}

/** A picture at the phone's 375 px and at 1440 px (§9.9 step 4), the page checked at both */
async function shot(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ path: testInfo.outputPath(`${name}-375.png`), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 900 })
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await page.screenshot({ path: testInfo.outputPath(`${name}-1440.png`), fullPage: true })
  await page.setViewportSize({ width: 375, height: 812 })
}

test.use({ viewport: { width: 375, height: 812 } })

test('[FR-RSK-201/AC5] the contact answers the risk questionnaire from the e-mailed link and sends it, AI off', async ({ page }, testInfo) => {
  const tag = randomUUID().slice(0, 6)
  const opened = scene<{ orgCode: string; assessmentId: string; contactId: string; path: string }>('open', tag)
  await page.goto(opened.path)
  await page.getByRole('button', { name: 'ส่งรหัสยืนยันให้ฉัน' }).click()
  await expect(page.getByRole('heading', { name: 'กรอกรหัสยืนยัน' })).toBeVisible()
  await page.getByLabel('รหัสยืนยัน 6 หลัก').fill(await codeOf(opened.contactId, `risk.${tag}@supplier.test`))
  await page.getByRole('button', { name: 'เข้าระบบ' }).click()
  // the link was sent for the questionnaire: the contact lands on it, not on the portal's home
  await expect(page).toHaveURL(new RegExp(`/portal/${opened.orgCode}/risk/${opened.assessmentId}`, 'i'))
  await expect(page.getByRole('heading', { level: 1 })).toContainText('แบบประเมินความเสี่ยง')
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'risk-portal-answer')

  // the three questions of the set (personal data and systems were screened in): each answered, then saved
  for (const question of ['บริษัทมีนโยบายต่อต้านการทุจริตเป็นลายลักษณ์อักษรหรือไม่', 'บริษัทมีมาตรการควบคุมการเข้าถึงระบบของลูกค้าหรือไม่', 'บริษัทแต่งตั้งเจ้าหน้าที่คุ้มครองข้อมูลส่วนบุคคลแล้วหรือไม่']) {
    await page.getByRole('group', { name: question }).getByLabel('มี', { exact: true }).check()
  }
  await page.getByRole('button', { name: 'บันทึกคำตอบ' }).click()
  await expect(page.getByText('บันทึกคำตอบแล้ว')).toBeVisible()
  await page.getByRole('button', { name: 'ส่งแบบประเมิน' }).click()
  await expect(page.getByText('ส่งแบบประเมินแล้ว', { exact: false }).first()).toBeVisible()
  await expect(page.getByText('แบบประเมินนี้ส่งแล้วหรือปิดแล้ว', { exact: false })).toBeVisible()
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'risk-portal-sent')
})
