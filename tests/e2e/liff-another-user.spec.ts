import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { checkScreen, liffScene, newLineUserId, openAsLineUser, sceneTag, sessionCookie, type SceneMember } from './liff-support'

// S5-06 · a LINE sign-in never takes the place of someone else's live sign-in in the same LINE browser (§9.4,
// FR-AUTH-003 AC1): POST /api/liff/session refuses it (403 SIGNED_IN_AS_ANOTHER_USER) and that session stays with its
// cookie. The gate of the LIFF page says so in the member's words and offers to sign out (POST /api/auth/sign-out); the
// page then loads again and its gate signs in with LINE. At 375 px in the mobile project (playwright.config.ts runs
// liff-* specs on the phone only), and at 1440 px (checkScreen). LIFF_MOCK stands in for the LINE app: the mock cookie
// says which LINE user opens the page and the ID token comes from the fake LINE server of the run; everything after it
// is the real path.

const SESSION_ENDPOINT = '/api/liff/session'
const SIGN_OUT_ENDPOINT = '/api/auth/sign-out'
const ANOTHER_USER = 'เบราว์เซอร์นี้เข้าระบบ BCS ในชื่อคนอื่นอยู่ ให้ออกจากระบบก่อน แล้วเปิดหน้านี้อีกครั้ง'

const pathOf = (url: string) => new URL(url).pathname

/** A member signs in with their password at the web sign-in, in this LINE browser */
async function passwordSignIn(page: Page, member: SceneMember, next: string): Promise<void> {
  await page.goto(`/login?next=${encodeURIComponent(next)}`)
  await page.getByLabel('อีเมลบริษัท').fill(member.email)
  await page.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
  await page.waitForURL((url) => url.pathname === next)
}

test.describe('[FR-AUTH-003/AC1] [§9.4] a LINE sign-in in a browser that holds someone else’s sign-in', () => {
  test('the gate says so and keeps that sign-in; signing out on request lets LINE sign the owner in', async ({ page, context }, testInfo) => {
    // Two scenes, two sign-ins and the §9.9 checks at two widths: more than the default 30 seconds
    test.setTimeout(120_000)
    // LINE account X is linked to its owner. In another tab of X's LINE app a colleague signs in with their password
    // while the first tab's gate is still getting X's ID token
    const lineX = newLineUserId()
    const { member: owner } = liffScene<{ member: SceneMember }>('linked', sceneTag('owner'), lineX)
    const { member: guest, admins } = liffScene<{ member: SceneMember; admins: string[] }>('plain', sceneTag('guest'))
    expect(admins.length).toBeGreaterThan(0)
    await openAsLineUser(context, lineX)
    let guestIn: () => void = () => undefined
    const guestSignedIn = new Promise<void>((resolve) => {
      guestIn = resolve
    })
    // LIFF_MOCK: the first tab's ID token (POST /api/liff/mock-token) comes once the guest has signed in
    await page.route('**/api/liff/mock-token', async (route) => {
      await guestSignedIn
      await route.continue()
    })
    const refusal = page.waitForResponse((r) => pathOf(r.url()) === SESSION_ENDPOINT)
    await page.goto('/liff/tasks')

    const tab = await context.newPage()
    await passwordSignIn(tab, guest, '/liff/help')
    const guestSession = await sessionCookie(context)
    expect(guestSession).toBeTruthy()
    expect(guestSession).not.toMatch(/^liff_/)
    guestIn()

    // The LINE sign-in is refused, and the page says why and what to do: nothing of the page or of either person shows
    const refused = await refusal
    expect(refused.status()).toBe(403)
    expect(await refused.json()).toMatchObject({ reason: 'SIGNED_IN_AS_ANOTHER_USER' })
    await expect(page.getByText(ANOTHER_USER)).toBeVisible()
    await expect(page.getByRole('button', { name: 'ออกจากระบบ' })).toBeVisible()
    await expect(page.getByText(owner.nameTh)).toHaveCount(0)
    await expect(page.getByText(guest.nameTh)).toHaveCount(0)
    // The guest's sign-in stays as it was, and still opens their pages: only the person in front of the phone ends it
    expect(await sessionCookie(context)).toBe(guestSession)
    await tab.reload()
    for (const name of admins) await expect(tab.getByRole('listitem').filter({ hasText: name })).toBeVisible()
    expect(await sessionCookie(context)).toBe(guestSession)
    await tab.close()
    await checkScreen(page, testInfo, 'liff-gate-another-user')

    // Sign out: the guest's session ends, the page loads again, and its gate signs X's owner in with LINE
    const signedOut = page.waitForResponse((r) => pathOf(r.url()) === SIGN_OUT_ENDPOINT)
    const signedIn = page.waitForResponse((r) => pathOf(r.url()) === SESSION_ENDPOINT && r.status() === 200)
    await page.getByRole('button', { name: 'ออกจากระบบ' }).click()
    expect((await signedOut).status()).toBe(200)
    await signedIn
    await expect(page.getByRole('heading', { level: 1, name: 'งานรออนุมัติ' })).toBeVisible()
    await expect(page.getByText(ANOTHER_USER)).toHaveCount(0)
    const ownerSession = await sessionCookie(context)
    expect(ownerSession).toMatch(/^liff_/)
    expect(ownerSession).not.toBe(guestSession)
  })
})
