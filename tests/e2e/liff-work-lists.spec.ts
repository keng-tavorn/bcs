import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import type { Page } from '@playwright/test'
import { E2E_LINE, e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'
import { checkScreen, expectFirstLoadWithinBudget, fakeLine, newLineUserId, openAsLineUser, sceneTag, weighFirstLoad } from './liff-support'

// S17-04 · the pages the role buttons of the rich menu open (FR-LINE-303 AC3 AC4 · §9.4 §9.5), at 375 px in the mobile
// project (liff-* specs run on the phone only), each screen also checked and photographed at 1440 px (checkScreen: axe,
// no sideways scroll, 44 px targets). The people: a fresh member of construction who is RECEIVER and PROCUREMENT
// (tests/e2e/liff-home-scene.ts worker), so the link gives them the set LINKED:RECEIVER:PROCUREMENT, and a fresh member
// with no role (tests/e2e/liff-gr-scene.ts outsider): no gr.post, no procurement.pool.view. The PO to receive is a sent PO
// of a fresh requester of construction (tests/e2e/receiving-scene.ts), which every RECEIVER of construction receives.

interface Worker {
  readonly memberId: string
  readonly employeeCode: string
  readonly richMenuId: string
}
interface ReceivingScene {
  readonly poId: string
  readonly number: string
}

test.describe.configure({ timeout: 180_000 })

function run<T>(command: string, env: Record<string, string> = {}): T {
  const r = spawnSync(command, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv(), ...env } })
  if (r.status !== 0) throw new Error(`${command} failed:\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}
const worker = (lineUserId: string) => run<Worker>(`pnpm exec tsx tests/e2e/liff-home-scene.ts worker ${sceneTag('lw')} ${lineUserId}`)
const outsider = () => run<{ code: string }>(`pnpm exec tsx tests/e2e/liff-gr-scene.ts outsider ${sceneTag('lw')}`)
const linkOutsider = (employeeCode: string, lineUserId: string) => run<unknown>(`pnpm exec tsx tests/e2e/liff-gr-scene.ts link ${employeeCode} ${lineUserId}`)
const sentPo = () => run<ReceivingScene>('pnpm exec tsx tests/e2e/receiving-scene.ts', { SCENE_MODE: 'demo', SCENE_RUN: `w${Date.now().toString(36)}${randomBytes(2).toString('hex')}` })

/** The buttons of the rich menu this LINE user sees, from the fake LINE server */
async function buttonsOf(lineUserId: string): Promise<Array<{ label: string; uri: string }>> {
  const { effectiveRichMenuId } = await fakeLine<{ effectiveRichMenuId: string | null }>(`/__fake/users/${lineUserId}/richmenu`)
  const { richMenus } = await fakeLine<{ richMenus: ReadonlyArray<{ richMenuId: string; menu: { areas?: ReadonlyArray<{ action?: { label?: string; uri?: string } }> } }> }>('/__fake/state')
  const menu = richMenus.find((m) => m.richMenuId === effectiveRichMenuId)
  if (!menu) throw new Error(`no rich menu for ${lineUserId}`)
  return (menu.menu.areas ?? []).map((a) => ({ label: a.action?.label ?? '', uri: a.action?.uri ?? '' }))
}

/** Opens a button's LIFF deep link as the LINE app does: the LIFF endpoint with the button's page in liff.state */
async function tap(page: Page, button: { label: string; uri: string }) {
  const url = new URL(button.uri)
  const [, liffId = '', ...rest] = url.pathname.split('/')
  expect(decodeURIComponent(liffId)).toBe(E2E_LINE.NEXT_PUBLIC_LIFF_ID)
  await page.goto(`/liff?liff.state=${encodeURIComponent(`/${rest.join('/')}`)}`)
}

const heading = (page: Page, name: string) => page.getByRole('heading', { level: 1, name })

test.describe('[FR-LINE-303/AC3] [FR-LINE-303/AC4] the role buttons of a receiver who buys', () => {
  test('the set LINKED:RECEIVER:PROCUREMENT: each button opens its page (หน้าแรก ขอซื้อ ตรวจรับ งานจัดซื้อ ติดตามสถานะ ช่วยเหลือ)', async ({ page, context }) => {
    const lineUserId = newLineUserId()
    const w = worker(lineUserId)
    await expect.poll(async () => (await fakeLine<{ richMenuId: string | null }>(`/__fake/users/${lineUserId}/richmenu`)).richMenuId).toBe(w.richMenuId)
    await openAsLineUser(context, lineUserId)
    const buttons = await buttonsOf(lineUserId)
    const want = [
      { label: 'หน้าแรก', path: '/liff/home', heading: 'หน้าแรก' },
      { label: 'ขอซื้อ', path: '/liff/requests/new', heading: 'ขอซื้อ / ขอจ้าง' },
      { label: 'ตรวจรับ', path: '/liff/gr', heading: 'ตรวจรับ' },
      { label: 'งานจัดซื้อ', path: '/liff/procurement', heading: 'งานจัดซื้อ' },
      { label: 'ติดตามสถานะ', path: '/liff/track', heading: 'คำขอของฉัน' },
      { label: 'ช่วยเหลือ', path: '/liff/help', heading: 'วิธีใช้ BCS ใน LINE' },
    ]
    expect(buttons.map((b) => b.label)).toEqual(want.map((b) => b.label))
    for (const w2 of want) {
      await tap(page, buttons.find((b) => b.label === w2.label)!)
      await expect(page).toHaveURL(new RegExp(`${w2.path.replaceAll('/', '\\/')}$`))
      await expect(heading(page, w2.heading)).toBeVisible()
    }
  })

  test('ตรวจรับ lists the sent PO the receiver may receive, which opens its receiving page; งานจัดซื้อ shows the numbers', async ({ page, context }, testInfo) => {
    const po = sentPo()
    const lineUserId = newLineUserId()
    worker(lineUserId)
    await openAsLineUser(context, lineUserId)
    await page.goto('/liff/gr')
    await expect(heading(page, 'ตรวจรับ')).toBeVisible()
    const row = page.getByRole('list', { name: 'PO ที่คุณตรวจรับได้' }).getByRole('listitem').filter({ hasText: po.number })
    await expect(row).toHaveCount(1)
    await expect(row.getByRole('link')).toHaveAttribute('href', `/liff/gr/${po.poId}`)
    await expect(row).not.toContainText('บาท')
    await checkScreen(page, testInfo, 'liff-gr-list')
    await row.getByRole('link').click()
    await expect(page).toHaveURL(new RegExp(`/liff/gr/${po.poId}$`))

    await page.goto('/liff/procurement')
    await expect(heading(page, 'งานจัดซื้อ')).toBeVisible()
    await expect(page.getByText(/บรรทัดรอจัดซื้อ/)).toBeVisible()
    await expect(page.getByRole('list', { name: 'จำนวนใบสั่งซื้อในแต่ละสถานะ' }).getByRole('listitem')).toHaveCount(5)
    await expect(page.getByRole('link', { name: /เปิดกองรอจัดซื้อบนเว็บ/ })).toHaveAttribute('href', '/procurement/pool')
    await checkScreen(page, testInfo, 'liff-procurement')
  })

  test('someone without gr.post sees an empty ตรวจรับ, and without procurement.pool.view no number at all', async ({ page, context }, testInfo) => {
    const lineUserId = newLineUserId()
    const o = outsider()
    linkOutsider(o.code, lineUserId)
    await openAsLineUser(context, lineUserId)
    await page.goto('/liff/gr')
    await expect(page.getByText('ไม่มี PO ที่คุณตรวจรับได้ตอนนี้')).toBeVisible()
    await expect(page.getByRole('list', { name: 'PO ที่คุณตรวจรับได้' })).toHaveCount(0)
    await checkScreen(page, testInfo, 'liff-gr-list-empty')
    await page.goto('/liff/procurement')
    await expect(page.getByText('หน้านี้สำหรับฝ่ายจัดซื้อ')).toBeVisible()
    await expect(page.getByText(/บรรทัดรอจัดซื้อ/)).toHaveCount(0)
    await expect(page.getByRole('list', { name: 'จำนวนใบสั่งซื้อในแต่ละสถานะ' })).toHaveCount(0)
    await checkScreen(page, testInfo, 'liff-procurement-denied')
  })
})

test.describe('[FR-LINE-303/AC4] §9.4 the first JavaScript of /liff/gr and /liff/procurement stays within 200 KB gzip', () => {
  test('/liff/gr', async ({ page, context }, testInfo) => {
    const lineUserId = newLineUserId()
    worker(lineUserId)
    await openAsLineUser(context, lineUserId)
    expectFirstLoadWithinBudget(testInfo, '/liff/gr', await weighFirstLoad(page, '/liff/gr', () => expect(heading(page, 'ตรวจรับ')).toBeVisible()))
  })

  test('/liff/procurement', async ({ page, context }, testInfo) => {
    const lineUserId = newLineUserId()
    worker(lineUserId)
    await openAsLineUser(context, lineUserId)
    expectFirstLoadWithinBudget(testInfo, '/liff/procurement', await weighFirstLoad(page, '/liff/procurement', () => expect(heading(page, 'งานจัดซื้อ')).toBeVisible()))
  })
})
