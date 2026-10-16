import { spawnSync } from 'node:child_process'
import { type Page, type TestInfo } from '@playwright/test'
import { e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'
import { anotherPhone, checkScreen, newLineUserId, openAsLineUser, sceneTag } from './liff-support'
import { expectNoBlockingAxe, expectNoSideways, shot, signIn } from './tasks-support'

// S6-13 on screen (FR-INT-103 AC2 AC3 · BR-DUP-05): a requester sent a purchase of floor tiles yesterday and now sends a
// draft of the same tiles in the same quantity from the web form (duplicates-scene.ts: a fresh CON member for each test,
// so other specs' counts never change). The send is refused with an inline panel — not a pop-up — linking the request
// sent yesterday and asking for the reason; with the box empty nothing is sent, with a reason it is. The approver's web
// task page then shows the DUPLICATE badge with the requester's reason, and so does the LIFF task page. The LIFF form's
// own panel: liff-duplicates.spec.ts. Screenshots at 375 px (mobile) and 1440 px (desktop) go to the test output (§9.9
// step 4); each screen is checked with axe (step 5).

interface Requester {
  readonly member: { readonly id: string; readonly employeeCode: string; readonly email: string }
  readonly sent: { readonly id: string; readonly number: string; readonly title: string }
  readonly draft: { readonly id: string; readonly title: string }
}

interface SentTask {
  readonly requestId: string
  readonly number: string
  readonly taskId: string
  readonly approver: string
  readonly approverTotp: boolean
  readonly flags: ReadonlyArray<{ readonly kind: string; readonly acknowledgedReason: string | null }>
}

// A request through the services, two sign-ins and a LINE link: more than Playwright's default 30 seconds
test.describe.configure({ timeout: 240_000 })

function run<T>(script: string, ...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/${script} ${args.map((a) => `"${a}"`).join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  // Its work may spend a link code (a secret of this test database): on failure only what went wrong is shown
  if (r.status !== 0) throw new Error(`${script} ${args[0]} failed:\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}

const width = (testInfo: TestInfo) => (testInfo.project.name === 'mobile' ? '375' : '1440')

async function check(page: Page, testInfo: TestInfo, name: string) {
  await expectNoSideways(page)
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, `${name}-${width(testInfo)}`)
}

/** Signs the scene's member in on the web with the seeded password (a plain requester: no TOTP) */
async function signInAs(page: Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('อีเมลบริษัท').fill(email)
  await page.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('สวัสดี')
}

/** "ถัดไป" in the form's bar, step after step, until its last button sends */
async function toReview(page: Page) {
  const send = page.getByRole('button', { name: 'ส่งขออนุมัติ', exact: true })
  for (let i = 0; i < 6 && !(await send.isVisible()); i++) {
    await page.getByRole('button', { name: /^ถัดไป: / }).click()
  }
  await expect(page.getByRole('heading', { level: 2, name: /ตรวจและส่ง$/ })).toBeVisible()
  return send
}

const flagsSection = (page: Page) => page.getByRole('region', { name: 'ข้อสังเกตของคำขอนี้', exact: true })

test('[FR-INT-103/AC2] [FR-INT-103/AC3] a request like one sent yesterday asks for the reason before it goes; the approver sees the badge with the reason on the web and LIFF task pages', async ({
  page,
  browser,
}, testInfo) => {
  const tag = sceneTag('dup')
  const s = run<Requester>('duplicates-scene.ts', 'requester', tag)
  try {
    await signInAs(page, s.member.email)
    await page.goto(`/requests/${s.draft.id}/edit`)
    await expect(page.getByLabel('ชื่อคำขอ')).toHaveValue(s.draft.title)
    const send = await toReview(page)
    await send.click()

    // The refusal is an inline panel on the check step, with the request sent yesterday as a link and the reason box
    const panel = page.getByRole('status').filter({ has: page.getByRole('heading', { name: 'คำขอนี้คล้ายคำขอที่คุณส่งไปแล้ว' }) })
    await expect(panel).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const link = panel.getByRole('list', { name: 'คำขอที่คล้ายกัน' }).getByRole('link', { name: s.sent.number, exact: true })
    await expect(link).toHaveAttribute('href', `/requests/${s.sent.id}`)
    const reason = panel.getByLabel(/^เหตุผลที่ขออีกครั้ง/)
    await expect(reason).toHaveValue('')
    await panel.scrollIntoViewIfNeeded()
    await check(page, testInfo, 'duplicate-panel')

    // With the box empty nothing is sent: the box says why and takes the focus
    await send.click()
    await expect(panel.getByText('ใส่เหตุผลที่ขออีกครั้งก่อนส่ง')).toBeVisible()
    await expect(reason).toBeFocused()
    await expect(reason).toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByRole('status').filter({ hasText: 'ส่งขออนุมัติแล้ว' })).toHaveCount(0)
    await check(page, testInfo, 'duplicate-panel-missing')

    // With the reason it goes, and the confirmation repeats the button's words (§9.9 rule 7)
    const why = `ของรอบก่อนใช้ที่ไซต์ A หมดแล้ว ${tag}`
    await reason.fill(why)
    await send.click()
    await expect(page.getByRole('status').filter({ hasText: 'ส่งขออนุมัติแล้ว' }).first()).toBeVisible()
    const t = run<SentTask>('duplicates-scene.ts', 'task', tag)
    expect(t.requestId).toBe(s.draft.id)
    expect(t.flags).toContainEqual({ kind: 'DUPLICATE', acknowledgedReason: why })

    // The approver's decision page: the DUPLICATE badge (an icon and words), the requester's reason, the request matched
    await page.context().clearCookies()
    await signIn(page, t.approver, t.approverTotp)
    await page.goto(`/tasks/${t.taskId}`)
    await expect(page.getByRole('heading', { level: 1, name: s.draft.title })).toBeVisible()
    const section = flagsSection(page)
    await expect(section).toBeVisible()
    await expect(section.locator('[data-slot="badge"][data-tone="warn"]')).toContainText('คล้ายคำขอที่ส่งไปแล้ว')
    await expect(section.locator('[data-slot="badge"] [data-icon="Copy"]')).toHaveCount(1)
    await expect(section).toContainText(`เหตุผลของผู้ขอ: ${why}`)
    await expect(section.getByRole('link', { name: s.sent.number, exact: true })).toHaveAttribute('href', `/requests/${s.sent.id}`)
    await section.scrollIntoViewIfNeeded()
    await check(page, testInfo, 'duplicate-task')

    // In LINE, on the approver's phone: the same badge and reason; the matched request opens its LIFF page (ADR-052)
    const lineUserId = newLineUserId()
    run('liff-gr-scene.ts', 'link', t.approver, lineUserId)
    const phone = await anotherPhone(browser)
    try {
      await openAsLineUser(phone, lineUserId)
      const liff = await phone.newPage()
      await liff.goto(`/liff/tasks/${t.taskId}`)
      await expect(liff.getByRole('heading', { level: 1, name: s.draft.title })).toBeVisible()
      const liffSection = flagsSection(liff)
      await expect(liffSection).toBeVisible()
      await expect(liffSection.locator('[data-slot="badge"][data-tone="warn"]')).toContainText('คล้ายคำขอที่ส่งไปแล้ว')
      await expect(liffSection).toContainText(`เหตุผลของผู้ขอ: ${why}`)
      await expect(liffSection.getByRole('link', { name: s.sent.number, exact: true })).toHaveAttribute('href', `/liff/requests/${s.sent.id}`)
      await liffSection.scrollIntoViewIfNeeded()
      await checkScreen(liff, testInfo, `duplicate-liff-task-${testInfo.project.name}`)
    } finally {
      await phone.close()
      run('liff-gr-scene.ts', 'unlink', t.approver)
    }
  } finally {
    run('duplicates-scene.ts', 'cleanup', tag)
  }
})
