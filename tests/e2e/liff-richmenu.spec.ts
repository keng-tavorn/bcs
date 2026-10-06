import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { fakeLine, liffScene, newLineUserId, openAsLineUser, sceneTag } from './liff-support'
import { E2E_LINE } from '../support/e2e-env'

// S5-06 · FR-LINE-004 AC2 (§9.5): every button of both rich menus opens the right LIFF page. The buttons are read from
// the menus LINE holds (the fake LINE server of the run, made by the same command as pnpm line:richmenu): the UNLINKED
// menu, the default of the OA, for a LINE account that is not linked; the LINKED menu for a member who linked. Each
// button is a LIFF deep link, https://liff.line.me/<LIFF ID>/<page>, which LINE opens as the LIFF endpoint with the page
// in liff.state; the page then is the one of §9.5's table, in words.

interface MenuButton {
  readonly label: string
  readonly uri: string
}

/** The buttons of the rich menu this LINE user sees: the one linked to them, or the default one */
async function buttonsOf(lineUserId: string): Promise<MenuButton[]> {
  const { effectiveRichMenuId } = await fakeLine<{ effectiveRichMenuId: string | null }>(`/__fake/users/${lineUserId}/richmenu`)
  const { richMenus } = await fakeLine<{ richMenus: ReadonlyArray<{ richMenuId: string; menu: { areas?: ReadonlyArray<{ action?: { label?: string; uri?: string } }> } }> }>('/__fake/state')
  const menu = richMenus.find((m) => m.richMenuId === effectiveRichMenuId)
  if (!menu) throw new Error(`no rich menu for ${lineUserId}`)
  return (menu.menu.areas ?? []).map((area) => ({ label: area.action?.label ?? '', uri: area.action?.uri ?? '' }))
}

/** Opens a button's LIFF deep link as the LINE app does: the LIFF endpoint with the button's page in liff.state */
async function tap(page: Page, button: MenuButton): Promise<void> {
  const url = new URL(button.uri)
  expect(url.hostname, `the button "${button.label}" is a LIFF deep link`).toBe('liff.line.me')
  const [, liffId = '', ...rest] = url.pathname.split('/')
  expect(decodeURIComponent(liffId), `the button "${button.label}" opens this organization's LIFF app`).toBe(E2E_LINE.NEXT_PUBLIC_LIFF_ID)
  await page.goto(`/liff?liff.state=${encodeURIComponent(`/${rest.join('/')}${url.search}`)}`)
}

/** §9.5: each button, where it leads and the heading of that page */
const UNLINKED = [
  { label: 'ผูกบัญชี', path: '/liff/link', heading: 'ผูกบัญชี LINE' },
  { label: 'ช่วยเหลือ', path: '/liff/help', heading: 'วิธีใช้ BCS ใน LINE' },
] as const
const LINKED = [
  { label: 'ขอซื้อ', path: '/liff/requests/new', heading: 'ขอซื้อ / ขอจ้าง' },
  { label: 'งานรออนุมัติ', path: '/liff/tasks', heading: 'งานรออนุมัติ' },
  { label: 'ติดตามสถานะ', path: '/liff/track', heading: 'คำขอของฉัน' },
  { label: 'ช่วยเหลือ', path: '/liff/help', heading: 'วิธีใช้ BCS ใน LINE' },
] as const

const literally = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

test.describe('[FR-LINE-004/AC2] every button of both rich menus opens its LIFF page (§9.5)', () => {
  test('the UNLINKED menu of a LINE account that is not linked: ผูกบัญชี opens the link page, ช่วยเหลือ the help', async ({ page, context }) => {
    // Both menus exist (made by the command of pnpm line:richmenu); this LINE account links nothing
    liffScene('code', sceneTag('menu-unlinked'))
    const lineUserId = newLineUserId()
    await openAsLineUser(context, lineUserId)
    const buttons = await buttonsOf(lineUserId)
    expect(buttons.map((b) => b.label).sort()).toEqual(UNLINKED.map((b) => b.label).sort())
    for (const want of UNLINKED) {
      await tap(page, buttons.find((b) => b.label === want.label)!)
      await expect(page).toHaveURL(new RegExp(`${literally(want.path)}$`))
      await expect(page.getByRole('heading', { level: 1, name: want.heading })).toBeVisible()
    }
    // The link page asks the visitor to sign in to BCS first: nothing of an organization before that
    await tap(page, buttons.find((b) => b.label === 'ผูกบัญชี')!)
    await expect(page.getByRole('heading', { level: 2, name: 'เข้าสู่ระบบ BCS เพื่อผูกบัญชี' })).toBeVisible()
  })

  test('the LINKED menu of a member: ขอซื้อ, งานรออนุมัติ, ติดตามสถานะ and ช่วยเหลือ each open their page, signed in through LINE', async ({ page, context }) => {
    const lineUserId = newLineUserId()
    const { linkedMenuId } = liffScene<{ linkedMenuId: string }>('linked', sceneTag('menu-linked'), lineUserId)
    await expect.poll(async () => (await fakeLine<{ richMenuId: string | null }>(`/__fake/users/${lineUserId}/richmenu`)).richMenuId).toBe(linkedMenuId)
    await openAsLineUser(context, lineUserId)
    const buttons = await buttonsOf(lineUserId)
    expect(buttons.map((b) => b.label).sort()).toEqual(LINKED.map((b) => b.label).sort())
    for (const want of LINKED) {
      await tap(page, buttons.find((b) => b.label === want.label)!)
      await expect(page).toHaveURL(new RegExp(`${literally(want.path)}$`))
      await expect(page.getByRole('heading', { level: 1, name: want.heading })).toBeVisible()
    }
  })
})
