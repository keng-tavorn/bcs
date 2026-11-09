import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { Page, TestInfo } from '@playwright/test'
import { deriveSeedTotpSecret, totp } from '@/lib/totp'
import { E2E_BASE_URL, E2E_LINE, e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'
import { expectNoBlockingAxe, pushesTo } from './liff-support'

// S7-09 (scenes 1 and 3 of Demo_Script_P2, the workspace's side · FR-SUP-101 FR-SUP-102 FR-SUP-104): PROCUREMENT invites a
// new supplier whose name resembles a registered one — the warning shows inline and the invitation goes with a reason —
// the supplier sends its application (the portal's side is S7-08's), another PROCUREMENT person verifies its document and
// sends it for approval with a proof the registries could not give, and the approver of SA-01 approves it in the LINE
// card (the fake LINE server of the run): the supplier exists. Each page is checked with axe.

function scene<T>(...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/supplier-applications-scene.ts ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`supplier applications scene ${args[0]} failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1)!) as T
}

function taxId(): string {
  const digits = Array.from({ length: 12 }, (_, i) => (i === 0 ? 0 : Math.floor(Math.random() * 10)))
  const sum = digits.reduce((s, d, i) => s + d * (13 - i), 0)
  return digits.join('') + String((11 - (sum % 11)) % 10)
}

async function signIn(page: Page, code: string, tag: string) {
  const local = `${code}.${tag}`
  await page.goto('/login')
  await page.getByLabel('อีเมลบริษัท').fill(`${local}@p2.bcs.local`)
  await page.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
  await expect(page).toHaveURL(/\/login\/2fa$/)
  await page.getByLabel('รหัส 6 หลักจากแอป').fill(totp(deriveSeedTotpSecret(process.env.SEED_TOTP_KEY!, local)))
  await page.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('สวัสดี')
}

/** axe and a picture at 1440 px, then at 375 px (§9.9 step 4), no sideways scroll on the phone */
async function shot(page: Page, testInfo: TestInfo, name: string) {
  await expectNoBlockingAxe(page)
  await page.screenshot({ path: testInfo.outputPath(`${name}-1440.png`), fullPage: true })
  const wide = page.viewportSize()
  await page.setViewportSize({ width: 375, height: 812 })
  await expectNoBlockingAxe(page)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${name}: no sideways scroll at 375 px`).toBe(true)
  await page.screenshot({ path: testInfo.outputPath(`${name}-375.png`), fullPage: true })
  if (wide) await page.setViewportSize(wide)
}

/** The approver taps the card's button: LINE's postback webhook, signed with the run's channel secret */
function tapPostback(testInfo: TestInfo, channelKey: string, lineUserId: string, data: string) {
  const state = testInfo.outputPath(`line-simulate-${Date.now()}.json`)
  const url = `${E2E_BASE_URL}/api/webhooks/line/${channelKey}`
  const r = spawnSync(`pnpm exec tsx scripts/line-simulate.ts postback --data "${data}" --user ${lineUserId} --url ${url} --secret ${E2E_LINE.LINE_MESSAGING_CHANNEL_SECRET}`, {
    shell: true,
    encoding: 'utf8',
    env: { ...process.env, ...e2eEnv(), LINE_SIMULATE_STATE_FILE: state },
  })
  const printed = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
  return { status: Number(/→ (\d{3})/.exec(printed)?.[1] ?? Number.NaN), printed, saved: existsSync(state) }
}

/** Every action of a Flex message, found anywhere in it */
function actionsOf(node: unknown): Array<{ type: string; label?: string; data?: string; uri?: string }> {
  if (!node || typeof node !== 'object') return []
  const own = 'action' in node && node.action && typeof node.action === 'object' ? [node.action as { type: string; label?: string; data?: string }] : []
  return [...own, ...Object.values(node).flatMap(actionsOf)]
}

test.describe('@s7 supplier applications on the workspace', () => {
  test.describe.configure({ timeout: 300_000 })

  test('[FR-SUP-101/AC1] [FR-SUP-102/AC2] [FR-SUP-104/AC5] invite with a duplicate warning, verify, send for approval with proof, approve in the LINE card', async ({ page, browser }, testInfo) => {
    const tag = randomBytes(3).toString('hex')
    const lineUserId = `U${randomBytes(16).toString('hex')}`
    const made = scene<{ orgCode: string; existingName: string; channelKey: string }>('setup', tag, lineUserId)

    // scene 1: PROCUREMENT invites; the name resembles a registered supplier, so the reason is asked for inline
    await signIn(page, 'proc_officer', tag)
    await page.goto('/suppliers/invite')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('เชิญผู้ขาย')
    await shot(page, testInfo, 's7-09-invite')
    await page.getByLabel('ชื่อผู้ขาย').fill(made.existingName)
    await page.getByLabel('เลขผู้เสียภาษี').fill(taxId())
    await page.getByLabel('เบอร์โทรของผู้ขายที่จัดซื้อรู้จัก').fill('02-111-2222')
    await page.getByLabel('ชื่อผู้ติดต่อ').fill('คุณวิภา ผู้ติดต่อ')
    await page.getByLabel('อีเมลผู้ติดต่อ').fill(`wipa.${tag}@supplier.test`)
    await page.getByRole('button', { name: 'ส่งคำเชิญทางอีเมล' }).click()
    await expect(page.getByRole('heading', { name: 'ข้อมูลคล้ายผู้ขายที่มีอยู่ บอกเหตุผลก่อนเชิญ' })).toBeVisible()
    await shot(page, testInfo, 's7-09-invite-warning')
    await page.getByLabel(/^ชื่อคล้ายผู้ขายที่มีอยู่/).fill('คนละบริษัท จดทะเบียนคนละเลข ตรวจกับกรมพัฒน์แล้ว')
    await page.getByRole('button', { name: 'ส่งคำเชิญทางอีเมล' }).click()
    await expect(page.getByText('ส่งคำเชิญแล้ว')).toBeVisible()
    await page.getByRole('link', { name: 'เปิดใบสมัคร' }).click()
    await expect(page).toHaveURL(/\/suppliers\/applications\/[0-9a-f-]{36}$/)
    const applicationId = page.url().split('/').at(-1)!
    await expect(page.getByText('ได้รับคำเชิญ')).toBeVisible()
    await page.goto('/suppliers/applications')
    await expect(page.getByRole('list', { name: 'ใบสมัครผู้ขาย' })).toContainText(made.existingName)
    await shot(page, testInfo, 's7-09-applications')

    // the supplier fills in and sends it on the portal (S7-08)
    const sent = scene<{ number: string }>('fill', applicationId)

    // scene 3: another PROCUREMENT person verifies the certificate and sends it for approval; the registries do not know
    // the tax id (stub), so a proof is attached and it is sent again
    const context = await browser.newContext({ viewport: page.viewportSize(), locale: 'th-TH', timezoneId: 'Asia/Bangkok' })
    const router = await context.newPage()
    await signIn(router, 'asst_con', tag)
    await router.goto(`/suppliers/applications/${applicationId}`)
    await expect(router.getByRole('heading', { level: 1 })).toContainText(sent.number)
    await expect(router.getByText('ชื่อคล้ายผู้ขายที่มีอยู่')).toBeVisible()
    await shot(router, testInfo, 's7-09-application')
    await router.getByRole('button', { name: /^ยืนยัน/ }).first().click()
    // the documents panel draws a table from md and a list under it: the one on screen (S7-18 · review S7-19)
    await expect(router.getByText('ยืนยันแล้ว').filter({ visible: true }).first()).toBeVisible()
    await router.getByRole('button', { name: 'ตรวจทะเบียนแล้วส่งเข้าเส้นทางอนุมัติ' }).click()
    await expect(router.getByText(/ทะเบียนยืนยันผู้ขายรายนี้ไม่ได้/)).toBeVisible()
    await router.locator('input[type="file"]').first().setInputFiles({ name: 'หนังสือรับรองที่ตรวจแล้ว.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\n%%EOF\n') })
    await expect(router.getByText(/แนบแล้ว: /)).toBeVisible()
    await router.getByRole('button', { name: 'ตรวจทะเบียนแล้วส่งเข้าเส้นทางอนุมัติ' }).click()
    await expect(router.getByText('รออนุมัติ').filter({ visible: true }).first()).toBeVisible()
    await context.close()

    // the approver of SA-01 gets the card in LINE and approves in the chat
    scene('deliver', applicationId)
    let card: Record<string, unknown> | undefined
    await expect
      .poll(async () => {
        card = (await pushesTo(lineUserId)).flatMap((p) => p.messages).find((m) => m.type === 'flex' && JSON.stringify(m).includes(sent.number))
        return card !== undefined
      }, { timeout: 15_000 })
      .toBe(true)
    expect(JSON.stringify(card)).toContain(made.existingName)
    const approve = actionsOf(card).find((a) => a.type === 'postback' && /a=approve/.test(a.data ?? ''))
    expect(approve, 'the card approves in the chat (OQ-189)').toBeDefined()
    const tap = tapPostback(testInfo, made.channelKey, lineUserId, approve!.data!)
    expect(tap.status, tap.printed).toBe(200)
    await expect.poll(() => scene<{ status: string; channel: string | null }>('state', applicationId), { timeout: 20_000 }).toMatchObject({ status: 'APPROVED', channel: 'LINE_CHAT' })
  })
})
