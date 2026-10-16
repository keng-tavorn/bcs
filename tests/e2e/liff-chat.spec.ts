import { spawnSync } from 'node:child_process'
import type { BrowserContext } from '@playwright/test'
import { e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'
import { checkScreen, expectFirstLoadWithinBudget, newLineUserId, openAsLineUser, sceneTag, weighFirstLoad } from './liff-support'

// S17-07 · a request begun in the LINE chat, finished in LIFF (FR-LINE-301 AC4 AC7 · BR-LINE-12, BR-LINE-15 · §9.4), at
// 375 px in the mobile project, each screen also checked and photographed at 1440 px (checkScreen: axe, no sideways
// scroll, 44 px targets). The chat draft is the one the chat side leaves (tests/e2e/liff-chat-scene.ts): two lines of
// text and a photo LINE no longer had. The button the chat answered with opens /liff/requests/new?intake=<id>.

interface Intake {
  readonly memberId: string
  readonly intakeId: string
}
interface State {
  readonly status: string
  readonly requestId: string | null
  readonly requests: number
}

test.describe.configure({ timeout: 180_000 })

function run<T>(...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/liff-chat-scene.ts ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`liff-chat-scene ${args[0]} failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}

/** A requester of the demo organization with a chat draft (and the AI's reading of it), whose LINE account this browser stands for */
async function withDraft(context: BrowserContext, mode: 'intake' | 'intake-ai' = 'intake'): Promise<Intake> {
  const lineUserId = newLineUserId()
  const intake = run<Intake>(mode, sceneTag('chat'), lineUserId)
  await openAsLineUser(context, lineUserId)
  return intake
}

test.describe('[FR-LINE-301/AC4] the chat draft in LIFF: opening it makes nothing; picking a type makes the request draft the requester sends themself', () => {
  test('the page shows the text as a reference and the failed photo, makes the draft only on the button, and opens it in the LIFF form', async ({ page, context }, testInfo) => {
    const s = await withDraft(context)
    await page.goto(`/liff/requests/new?intake=${s.intakeId}`)
    await expect(page.getByRole('heading', { level: 1, name: 'ร่างคำขอจากแชท' })).toBeVisible()
    await expect(page.getByText('ส่งที่ไซต์ก่อสร้างบางนา')).toBeVisible()
    await expect(page.getByText('รูปที่ 3 · ดึงรูปไม่สำเร็จ')).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'ชื่อเรื่อง' })).toHaveValue('ขอซื้อหมวกนิรภัยสีขาว 20 ใบ')
    // A GET never makes a draft (BR-LINE-15)
    expect(run<State>('state', s.intakeId)).toEqual({ status: 'OPEN', requestId: null, requests: 0 })
    await checkScreen(page, testInfo, 'liff-chat-intake')

    // Without a type the page says what is missing and makes nothing
    await page.getByRole('button', { name: 'สร้างร่างคำขอ' }).click()
    await expect(page.getByRole('region', { name: 'สร้างร่างคำขอ' }).getByRole('alert')).toContainText('เลือกประเภทคำขอก่อนสร้างร่าง')
    expect(run<State>('state', s.intakeId).requests).toBe(0)

    await page.getByRole('group', { name: 'ประเภทคำขอ' }).getByRole('radio').first().check()
    await page.getByRole('button', { name: 'สร้างร่างคำขอ' }).click()
    await expect(page).toHaveURL(/\/liff\/requests\/[0-9a-f-]{36}\/edit$/)
    const after = run<State>('state', s.intakeId)
    expect(after).toMatchObject({ status: 'DRAFTED', requests: 1 })
    expect(page.url()).toContain(after.requestId!)
    // The draft's form leads back to the chat text, a reference until it is purged (BR-LINE-12)
    await expect(page.getByRole('link', { name: 'ข้อความจากแชท' })).toHaveAttribute('href', `/liff/requests/new?intake=${s.intakeId}`)
  })

  test('opened without a draft, /liff/requests/new offers the member\'s open chat drafts above the types', async ({ page, context }, testInfo) => {
    const s = await withDraft(context)
    await page.goto('/liff/requests/new')
    const chats = page.getByRole('region', { name: 'ร่างจากแชท' })
    await expect(chats.getByRole('link', { name: 'ขอซื้อหมวกนิรภัยสีขาว 20 ใบ' })).toHaveAttribute('href', `/liff/requests/new?intake=${s.intakeId}`)
    await checkScreen(page, testInfo, 'liff-chat-list')
  })
})

test.describe('[FR-LINE-301/AC7] only the owner sees a chat draft; "ไม่ใช่คำขอ" closes it', () => {
  test('another member opening the link is told it is not found and sees nothing of it', async ({ page, context }) => {
    const s = await withDraft(context)
    await withDraft(context)
    await page.goto(`/liff/requests/new?intake=${s.intakeId}`)
    await expect(page.getByRole('status').filter({ hasText: 'ไม่พบร่างจากแชทนี้' })).toBeVisible()
    await expect(page.getByText('ส่งที่ไซต์ก่อสร้างบางนา')).toHaveCount(0)
    expect(run<State>('state', s.intakeId).status).toBe('OPEN')
  })

  test('the owner dismisses it: closed, no request', async ({ page, context }, testInfo) => {
    const s = await withDraft(context)
    await page.goto(`/liff/requests/new?intake=${s.intakeId}`)
    await page.getByRole('button', { name: 'ไม่ใช่คำขอ' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'ปิดร่างจากแชทนี้แล้ว' })).toBeVisible()
    expect(run<State>('state', s.intakeId)).toEqual({ status: 'DISMISSED', requestId: null, requests: 0 })
    await checkScreen(page, testInfo, 'liff-chat-dismissed')
  })
})

test.describe('[FR-LINE-301/AC4] §9.4 the first JavaScript of the chat draft page stays within 200 KB gzip', () => {
  test('/liff/requests/new?intake=<id>', async ({ page, context }, testInfo) => {
    const s = await withDraft(context)
    const load = await weighFirstLoad(page, `/liff/requests/new?intake=${s.intakeId}`, () => expect(page.getByRole('heading', { level: 1, name: 'ร่างคำขอจากแชท' })).toBeVisible())
    expectFirstLoadWithinBudget(testInfo, '/liff/requests/new?intake=<id>', load)
  })
})

test.describe('[FR-LINE-301/AC5] the AI reading in LIFF: its values marked "เติมโดย AI โปรดตรวจ", money and quantities confirmed one by one on the draft', () => {
  test('the proposed type is picked, the values go into the draft, and the draft waits for the two values until the requester confirms them', async ({ page, context }, testInfo) => {
    const s = await withDraft(context, 'intake-ai')
    await page.goto(`/liff/requests/new?intake=${s.intakeId}`)
    const ai = page.getByRole('region', { name: /ค่าที่ AI อ่านได้/ })
    await expect(ai.getByText('เติมโดย AI โปรดตรวจ')).toBeVisible()
    await expect(ai.getByText('หมวกนิรภัยสีขาว · 20 ใบ · ราคาต่อหน่วย 250.00 บาท')).toBeVisible()
    await expect(page.getByRole('radio', { name: /ซื้อของ/ })).toBeChecked()
    await ai.getByRole('button', { name: 'ใช้ชื่อเรื่องนี้' }).click()
    await expect(page.getByRole('textbox', { name: 'ชื่อเรื่อง' })).toHaveValue('หมวกนิรภัยสีขาวสำหรับไซต์บางนา')
    await checkScreen(page, testInfo, 'liff-chat-ai')

    await page.getByRole('button', { name: 'สร้างร่างคำขอ' }).click()
    await expect(page).toHaveURL(/\/liff\/requests\/[0-9a-f-]{36}\/edit$/)
    const waiting = page.getByRole('region', { name: /ค่าที่ AI เติมรอยืนยัน/ })
    await expect(waiting.getByRole('checkbox')).toHaveCount(2)
    await expect(waiting.getByText('รายการที่ 1 · จำนวน')).toBeVisible()
    await expect(waiting.getByText('รายการที่ 1 · ราคาต่อหน่วย (บาท)')).toBeVisible()
    await checkScreen(page, testInfo, 'liff-ai-confirm')
    for (const box of await waiting.getByRole('checkbox').all()) await box.check()
    await waiting.getByRole('button', { name: 'ยืนยันค่าที่ตรวจแล้ว' }).click()
    await expect(page.getByRole('region', { name: /ค่าที่ AI เติมรอยืนยัน/ })).toHaveCount(0)
    expect(run<State>('state', s.intakeId)).toMatchObject({ status: 'DRAFTED', requests: 1 })
  })
})
