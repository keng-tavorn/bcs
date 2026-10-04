import { spawnSync } from 'node:child_process'
import type { Page, TestInfo } from '@playwright/test'
import { e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'
import { checkScreen, FIRST_LOAD_JS_BUDGET_BYTES, gzipBytes, inlineScriptsOf, newLineUserId, openAsLineUser, sceneTag, watchScripts } from './liff-support'

// S5-06 · /liff/delegation, naming an acting approver in the LINE app (§9.4 "ตั้งรักษาการ", FR-DOA-006 AC2 LIFF part,
// BR-DLG-01 to BR-DLG-03, demo scene 11), at 375 px in the mobile project, every screen also checked at 1440 px
// (checkScreen). LIFF_MOCK stands in for the LINE app (the mock cookie names the LINE user; the fake LINE server of the
// run issues its ID token); the LIFF session, the delegation service and its Events are the real path. The delegator is
// dm_con, linked to a LINE account of the test's own (tests/e2e/liff-gr-scene.ts); the delegate is a fresh member
// (tests/e2e/liff-delegation-scene.ts), so no other spec meets these delegations, and whatever a test leaves running is
// cancelled and the link ended afterwards.

type Person = { id: string; nameTh: string; code: string }
type Setup = { delegator: { code: string; nameTh: string }; delegate: Person; endedId: string }
type State = { delegations: Array<{ id: string; status: string; createdVia: string; events: Array<{ type: string; channel: string }> }> }

function runScene<T>(script: string, args: readonly string[]): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/${script} ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  // Link codes stay inside the test database: on failure only what went wrong is shown
  if (r.status !== 0) throw new Error(`${script} ${args[0]} failed:\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}
const delegationScene = <T,>(...args: string[]) => runScene<T>('liff-delegation-scene.ts', args)
const lineScene = <T,>(...args: string[]) => runScene<T>('liff-gr-scene.ts', args)

/** YYYY-MM-DD of today plus `days` in Thai time, as the date inputs take it */
function thaiDay(days: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + days * 86_400_000))
}

/** The screen as the approver sees it now, the bar stuck to the bottom (checkScreen's full-page pictures draw it mid-page) */
async function onScreen(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ path: testInfo.outputPath(`${name}-screen.png`) })
}

/** The bar of a LIFF page sits at the bottom of the screen (§9.4, §9.9 "ปุ่มหลักติดล่างจอ") */
async function expectAtBottom(page: Page, name: string) {
  const box = (await page.getByRole('region', { name }).boundingBox())!
  expect(box.y + box.height).toBeGreaterThan(page.viewportSize()!.height - 2)
}

test.beforeEach(() => {
  test.slow()
})

test.describe('[FR-DOA-006/AC2] the delegator names and cancels an acting approver in LINE', () => {
  let tag: string | null = null
  // Whatever happened, the delegator's delegations to the test's delegate stop and dm_con's LINE link ends — the link
  // even when the clean-up of the delegations fails, so the seeded approver never stays linked for the specs after this
  test.afterEach(() => {
    if (!tag) return
    const done = tag
    tag = null
    try {
      delegationScene('cleanup', done)
    } finally {
      lineScene('unlink', 'dm_con')
    }
  })

  test('[FR-LINE-003/AC1] demo scene 11 in LINE: dm_con names an acting approver for two days with a cap — the same rules and service as the web, channel LIFF — then cancels it; an ended one offers no cancel', async ({ page, context }, testInfo) => {
    tag = sceneTag('dlg')
    const { delegate } = delegationScene<Setup>('setup', tag)
    const lineUserId = newLineUserId()
    lineScene('link', 'dm_con', lineUserId)
    await openAsLineUser(context, lineUserId)
    await page.goto('/liff/delegation')
    await expect(page.getByRole('heading', { level: 1, name: 'รักษาการ' })).toBeVisible()
    // What a delegation does, before anything is set (§9.9 principle 3): the tasks already waiting move too, not only new ones
    await expect(page.getByText(/^ตั้งผู้รักษาการเมื่อคุณลาหรือไม่อยู่ เมื่อเริ่มช่วงนั้น งานอนุมัติที่รอคุณอยู่จะย้ายไปที่ผู้รักษาการ .* เมื่อจบช่วง งานที่ยังค้างจะกลับมาที่คุณ$/)).toBeVisible()
    await expect(page.getByText('อำนาจที่มอบได้มาจากตำแหน่ง ผู้จัดการฝ่าย ของ ฝ่ายก่อสร้าง')).toBeVisible()
    const given = page.getByRole('region', { name: 'ผู้รักษาการแทนคุณ' })
    // The delegation that already ended is listed with its state, and offers nothing to press
    const ended = given.getByRole('listitem').filter({ hasText: delegate.nameTh }).filter({ hasText: 'สิ้นสุดแล้ว' })
    await expect(ended).toBeVisible()
    await expect(ended.getByRole('button')).toHaveCount(0)
    await expect(page.getByRole('region', { name: 'คุณรักษาการแทน' })).toBeVisible()
    expect(await page.getByRole('main').locator('p').first().evaluate((el) => getComputedStyle(el).fontSize)).toBe('16px')
    await expectAtBottom(page, 'บันทึกการรักษาการ')
    await checkScreen(page, testInfo, 'liff-delegation')
    await onScreen(page, testInfo, 'liff-delegation')

    // Nothing chosen: each field says what it needs, the bar says where, and the first one gets the focus
    const bar = page.getByRole('region', { name: 'บันทึกการรักษาการ' })
    await page.getByRole('button', { name: 'ตั้งผู้รักษาการ', exact: true }).click()
    await expect(page.getByText('เลือกผู้รักษาการจากรายการก่อนบันทึก')).toBeVisible()
    await expect(page.getByText('ใส่เหตุผลอย่างน้อย 3 ตัวอักษร')).toBeVisible()
    await expect(bar.getByText('ยังตั้งไม่ได้ แก้ช่องที่มีข้อความแจ้งด้านบนก่อน')).toBeVisible()
    // The focus lands once the error is there, so the field is read with it
    const delegateField = page.getByLabel('ผู้รักษาการ', { exact: true })
    await expect(delegateField).toBeFocused()
    await expect(delegateField).toHaveAttribute('aria-invalid', 'true')
    await expect(delegateField).toHaveAccessibleDescription('เลือกผู้รักษาการจากรายการก่อนบันทึก')
    // The last day before the first is refused before anything is sent (BR-DLG-03 [startsAt, endsAt))
    await page.getByLabel('วันสุดท้าย (รวมวันนั้น)').fill(thaiDay(-1))
    await page.getByRole('button', { name: 'ตั้งผู้รักษาการ', exact: true }).click()
    await expect(page.getByText('วันสุดท้ายต้องไม่ก่อนวันเริ่ม')).toBeVisible()
    await checkScreen(page, testInfo, 'liff-delegation-errors')

    // Only some kinds of task, none ticked: the first box gets the focus, read with what is missing
    await page.getByLabel('ผู้รักษาการ', { exact: true }).selectOption({ label: `${delegate.nameTh} · ฝ่ายก่อสร้าง` })
    await page.getByLabel('วันสุดท้าย (รวมวันนั้น)').fill(thaiDay(1))
    await page.getByRole('radio', { name: 'เฉพาะประเภทที่เลือก' }).check()
    await page.getByLabel('เหตุผล (เช่น ลาพักร้อน)').fill('ลาพักร้อน')
    await page.getByRole('button', { name: 'ตั้งผู้รักษาการ', exact: true }).click()
    const firstKind = page.locator('input[name="documentTypes"]').first()
    await expect(firstKind).toBeFocused()
    await expect(firstKind).toHaveAccessibleDescription('เลือกประเภทงานอนุมัติอย่างน้อย 1 ประเภท หรือเลือกทุกประเภท')
    await checkScreen(page, testInfo, 'liff-delegation-types-error')
    // Every kind after all: what was said about the kinds goes
    await page.getByRole('radio', { name: /^ทุกประเภทงานอนุมัติของตำแหน่งคุณ/ }).check()
    await expect(page.getByText('เลือกประเภทงานอนุมัติอย่างน้อย 1 ประเภท หรือเลือกทุกประเภท')).toHaveCount(0)

    // Two days from today, up to 20,000 baht, while on leave; the period reads in words as the days are chosen
    await page.getByLabel('ผู้รักษาการ', { exact: true }).selectOption({ label: `${delegate.nameTh} · ฝ่ายก่อสร้าง` })
    await page.getByLabel('วันเริ่ม', { exact: true }).fill(thaiDay(0))
    await page.getByLabel('วันสุดท้าย (รวมวันนั้น)').fill(thaiDay(1))
    await expect(page.getByText(/^รักษาการ \d{1,2} \S+ \d{4} ถึง \d{1,2} \S+ \d{4}$/)).toBeVisible()
    await page.getByLabel('วงเงินสูงสุดที่มอบ (บาท)').fill('20,000')
    await page.getByLabel('เหตุผล (เช่น ลาพักร้อน)').fill('ลาพักร้อน')
    await page.getByRole('button', { name: 'ตั้งผู้รักษาการ', exact: true }).click()
    await expect(bar.getByText(new RegExp(`^ตั้งผู้รักษาการแล้ว ${delegate.nameTh} รักษาการแทนคุณ \\d{1,2} \\S+ \\d{4} ถึง \\d{1,2} \\S+ \\d{4}$`))).toBeVisible()
    const row = given.getByRole('listitem').filter({ hasText: delegate.nameTh }).filter({ hasNotText: 'สิ้นสุดแล้ว' })
    await expect(row).toContainText('กำลังรักษาการ')
    await expect(row).toContainText('ทุกประเภทงานอนุมัติ')
    await expect(row).toContainText('วงเงินไม่เกิน 20,000.00 บาท')
    await expect(row).toContainText('เหตุผล ลาพักร้อน')
    await checkScreen(page, testInfo, 'liff-delegation-set')
    await row.scrollIntoViewIfNeeded()
    await onScreen(page, testInfo, 'liff-delegation-set')
    // The same service as the web, recorded on channel LIFF
    const set = delegationScene<State>('state', tag).delegations.filter((d) => d.status === 'ACTIVE')
    expect(set).toEqual([expect.objectContaining({ createdVia: 'SELF', events: [{ type: 'delegation.created', channel: 'LIFF' }] })])

    // Cancelling cannot be undone, so it asks first, and says what happens as this build does it (NEW-35): new tasks
    // come to the delegator at once, and what the acting approver still holds for them comes back
    await row.getByRole('button', { name: `ยกเลิกการรักษาการของ ${delegate.nameTh}` }).click()
    await row.getByRole('button', { name: 'ยืนยันยกเลิกการรักษาการ' }).click()
    await expect(row.getByText('ติ๊กช่องยืนยันก่อนยกเลิก')).toBeVisible()
    const confirm = row.getByLabel('ยืนยันยกเลิก งานอนุมัติใหม่จะมาที่คุณทันที และงานที่ยังค้างอยู่กับผู้รักษาการจะกลับมาที่คุณ')
    await expect(confirm).toBeFocused()
    await expect(confirm).toHaveAccessibleDescription('ติ๊กช่องยืนยันก่อนยกเลิก')
    // Pressed again without the tick (the same error): the focus goes back to the box again
    const cancel = row.getByRole('button', { name: 'ยืนยันยกเลิกการรักษาการ' })
    await cancel.focus()
    await expect(cancel).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(confirm).toBeFocused()
    await checkScreen(page, testInfo, 'liff-delegation-revoke-confirm')
    await confirm.check()
    await row.getByRole('button', { name: 'ยืนยันยกเลิกการรักษาการ' }).click()
    await expect(row.getByText('ยกเลิกการรักษาการแล้ว งานอนุมัติใหม่และงานที่ค้างอยู่กับผู้รักษาการจะกลับมาที่คุณ')).toBeVisible()
    await expect(row).toContainText('ยกเลิกแล้ว')
    await expect(row.getByRole('button')).toHaveCount(0)
    await checkScreen(page, testInfo, 'liff-delegation-revoked')
    // The bar no longer says the delegation was set: it was cancelled since
    await expect(bar.getByText(/^ตั้งผู้รักษาการแล้ว/)).toHaveCount(0)
    const revoked = delegationScene<State>('state', tag).delegations.find((d) => d.id === set[0]!.id)
    expect(revoked).toMatchObject({ status: 'REVOKED' })
    expect(revoked!.events).toEqual(expect.arrayContaining([{ type: 'delegation.revoked', channel: 'LIFF' }]))
  })
})

test('[FR-DOA-006/AC2] in LINE, a member who holds no position learns why there is nothing to hand over, and gets no form', async ({ page, context }, testInfo) => {
  const { member } = delegationScene<{ member: Person }>('plain', sceneTag('nopos'))
  const lineUserId = newLineUserId()
  lineScene('link', member.code, lineUserId)
  await openAsLineUser(context, lineUserId)
  await page.goto('/liff/delegation')
  await expect(page.getByText('คุณไม่ได้ดำรงตำแหน่งที่มีอำนาจอนุมัติ จึงไม่มีอำนาจให้มอบ', { exact: false })).toBeVisible()
  await expect(page.getByRole('button', { name: 'ตั้งผู้รักษาการ', exact: true })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'ผู้รักษาการแทนคุณ' })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'คุณรักษาการแทน' })).toBeVisible()
  await checkScreen(page, testInfo, 'liff-delegation-no-position')
})

/** The script files a page loads until the network is quiet (§9.4, as tests/e2e/liff-shell.spec.ts weighs them) */
async function firstLoad(page: Page, testInfo: TestInfo, path: string, ready: () => Promise<void>) {
  const scripts = watchScripts(page)
  const document = await page.goto(path)
  await ready()
  await page.waitForLoadState('networkidle')
  const loads = await scripts()
  const total = loads.reduce((sum, load) => sum + load.transferred, 0)
  const inline = gzipBytes(inlineScriptsOf((await document?.text()) ?? '').join('\n'))
  testInfo.annotations.push({ type: 'first-load-js', description: `${path}: ${loads.length} script files, ${total} bytes over the wire; inline page data about ${inline} bytes gzip, reported apart` })
  expect(loads.filter((l) => l.sdk)).toHaveLength(1)
  expect(loads.filter((l) => l.transferred > 1024).every((l) => l.encoding === 'gzip' || l.encoding === 'br')).toBe(true)
  expect(total).toBeLessThanOrEqual(FIRST_LOAD_JS_BUDGET_BYTES)
}

test('[§9.4] the first JavaScript of /liff/delegation — the form of an approver, with the LINE SDK — is at most 200 KB gzip', async ({ page, context }, testInfo) => {
  // A member who holds no position sees no form: the form's own weight is measured with the approver of scene 11
  const lineUserId = newLineUserId()
  lineScene('link', 'dm_con', lineUserId)
  try {
    await openAsLineUser(context, lineUserId)
    await firstLoad(page, testInfo, '/liff/delegation', () => expect(page.getByRole('button', { name: 'ตั้งผู้รักษาการ', exact: true })).toBeVisible())
  } finally {
    lineScene('unlink', 'dm_con')
  }
})
