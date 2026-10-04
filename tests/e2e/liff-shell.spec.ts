import type { BrowserContext, Page } from '@playwright/test'
import { expect, test } from './fixtures'
import {
  checkScreen,
  FIRST_LOAD_JS_BUDGET_BYTES,
  gzipBytes,
  inlineScriptsOf,
  liffScene,
  newLineUserId,
  openAsLineUser,
  sceneTag,
  sessionCookie,
  watchScripts,
  workspaceOnlyMessages,
  type SceneMember,
} from './liff-support'

// S5-06 · the LIFF shell (§9.4, ADR-024, ADR-046), at 375 px in the mobile project (playwright.config.ts runs liff-*
// specs on the phone only: LIFF pages live in the LINE app); every screen is also photographed and checked at 1440 px
// (checkScreen), as LIFF opens in LINE on a computer and in desktop browsers too. LIFF_MOCK stands in for the LINE app:
// the mock cookie says which LINE user the page is opened by, the ID token comes from the fake LINE server of the run,
// and everything after it — POST /api/liff/session, LINE's verify endpoint, the link check, the session — is the real
// path. /liff/help is one of the eight pages of FR-LINE-003 AC1; the other seven come with the next wave.

test.describe('[FR-LINE-003/AC1] [§9.4] /liff/help in the LINE app', () => {
  test('/liff/help opens for a LINE account that is not linked: how BCS works in LINE, the way to link first, no organization data', async ({ page, context }, testInfo) => {
    const { admins } = liffScene<{ admins: string[] }>('admins')
    await openAsLineUser(context, newLineUserId())
    const signIns: number[] = []
    page.on('response', (response) => {
      if (response.url().endsWith('/api/liff/session')) signIns.push(response.status())
    })
    // The page tries a quiet LINE sign-in, which this LINE account cannot have
    const signIn = page.waitForResponse((r) => r.url().endsWith('/api/liff/session'))
    await page.goto('/liff/help')
    expect((await signIn).status()).toBe(403)
    await expect(page.getByRole('heading', { level: 1, name: 'วิธีใช้ BCS ใน LINE' })).toBeVisible()
    // The next step of a visitor who is not linked comes first, under its own heading
    await expect(page.getByRole('heading', { level: 2, name: 'เริ่มใช้ BCS ใน LINE' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'ผูกบัญชี LINE' })).toHaveAttribute('href', '/liff/link')
    for (const section of ['เมนูด้านล่างแชท', 'อนุมัติในแชทและ PIN', 'ยกเลิกการผูกบัญชี', 'ติดต่อผู้ดูแลระบบ']) {
      await expect(page.getByRole('heading', { level: 2, name: section })).toBeVisible()
    }
    await expect(page.getByText('ใส่ PIN ผิด 5 ครั้งติดกัน PIN จะถูกล็อก 15 นาที', { exact: false })).toBeVisible()
    await expect(page.getByText('ผูกบัญชี LINE ก่อนเพื่อดูรายชื่อผู้ดูแลระบบขององค์กร')).toBeVisible()
    for (const name of admins) await expect(page.getByText(name)).toHaveCount(0)
    // 16 px text (§9.4); the 44 px targets, axe and 1440 px are checkScreen's
    expect(await page.locator('main p').first().evaluate((el) => getComputedStyle(el).fontSize)).toBe('16px')
    await checkScreen(page, testInfo, 'liff-help-unlinked')
    // The tab remembers the answer: opening help again does not ask LINE again (each refusal is a call to LINE and an Event)
    await page.reload()
    await expect(page.getByRole('heading', { level: 2, name: 'เริ่มใช้ BCS ใน LINE' })).toBeVisible()
    await page.waitForLoadState('networkidle')
    expect(signIns).toEqual([403])
  })

  test('a linked member signs in through LINE without a password: the help names their administrators, /liff goes to their tasks', async ({ page, context }, testInfo) => {
    const lineUserId = newLineUserId()
    const { member, admins } = liffScene<{ member: SceneMember; admins: string[] }>('linked', sceneTag('help'), lineUserId)
    expect(admins.length).toBeGreaterThan(0)
    await openAsLineUser(context, lineUserId)
    // Without a session the server sends the page without any data of the organization (§9.4)
    const before = await (await page.request.get('/liff/help')).text()
    for (const name of admins) expect(before).not.toContain(name)
    expect(before).not.toContain(member.organizationName)

    await page.goto('/liff/help')
    await expect(page.getByText(`ผู้ดูแลระบบของ ${member.organizationName}`, { exact: false })).toBeVisible()
    for (const name of admins) await expect(page.getByRole('listitem').filter({ hasText: name })).toBeVisible()
    // The menu buttons lead to their LIFF pages for a member; the way to link is not offered to someone linked
    await expect(page.getByRole('link', { name: 'งานรออนุมัติ' })).toHaveAttribute('href', '/liff/tasks')
    await expect(page.getByRole('link', { name: 'ขอซื้อ' })).toHaveAttribute('href', '/liff/requests/new')
    await expect(page.getByRole('link', { name: 'ติดตามสถานะ' })).toHaveAttribute('href', '/liff/track')
    await expect(page.getByRole('heading', { level: 2, name: 'เริ่มใช้ BCS ใน LINE' })).toHaveCount(0)
    expect(await sessionCookie(context)).toMatch(/^liff_/)
    await checkScreen(page, testInfo, 'liff-help-member')

    // /liff sends a linked member on to their tasks. /liff/tasks itself is a page of the next wave: until it exists only
    // the address is checked here, and the next wave asserts that the page opens
    testInfo.annotations.push({ type: 'waits-for', description: '/liff/tasks (next wave of S5-06): the redirect is checked by its address only' })
    await page.goto('/liff')
    await expect(page).toHaveURL(/\/liff\/tasks$/)
  })
})

test.describe('[§9.4] outside the LINE app, the web sign-in', () => {
  test('outside the LINE app a LIFF page goes to the web sign-in and back; a web session opens LIFF pages too', async ({ page }, testInfo) => {
    const { member, admins } = liffScene<{ member: SceneMember; admins: string[] }>('plain', sceneTag('web'))
    // No LINE user: an ordinary browser
    await page.goto('/liff')
    await expect(page).toHaveURL(/\/login\?next=%2Fliff$/)
    await page.getByLabel('อีเมลบริษัท').fill(member.email)
    await page.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
    await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
    // Back in LIFF: not linked yet, so /liff opens the link page, which says linking happens in the LINE app
    await expect(page).toHaveURL(/\/liff\/link$/)
    await expect(page.getByRole('heading', { level: 2, name: 'ผูก LINE นี้กับบัญชีของคุณ' })).toBeVisible()
    await expect(page.getByText(member.nameTh)).toBeVisible()
    await expect(page.getByText('เปิดหน้านี้ในแอป LINE เพื่อผูกบัญชี', { exact: false })).toBeVisible()
    // …and where to go instead: LINE settings on the web
    await expect(page.getByRole('link', { name: 'เปิดตั้งค่า LINE บนเว็บ' })).toHaveAttribute('href', '/settings/line')
    await expect(page.getByRole('button', { name: 'ผูก LINE นี้กับบัญชีของฉัน' })).toHaveCount(0)
    await checkScreen(page, testInfo, 'liff-link-web-session-outside-line')

    await page.goto('/liff/help')
    for (const name of admins) await expect(page.getByRole('listitem').filter({ hasText: name })).toBeVisible()
  })
})

/** A member signs in with their password at the web sign-in, inside the LINE app this browser stands for */
async function passwordSignIn(page: Page, member: SceneMember, next: string): Promise<void> {
  await page.goto(`/login?next=${encodeURIComponent(next)}`)
  await page.getByLabel('อีเมลบริษัท').fill(member.email)
  await page.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
  await page.waitForURL((url) => url.pathname === next)
}

test.describe('[FR-AUTH-003/AC1] the LIFF session goes idle after 15 minutes; an active person is renewed silently first', () => {
  test('a tap after 13 quiet minutes renews the session with a fresh ID token: a new session id, no question asked', async ({ page, context }) => {
    const lineUserId = newLineUserId()
    const { member } = liffScene<{ member: SceneMember }>('linked', sceneTag('renew'), lineUserId)
    await openAsLineUser(context, lineUserId)
    await page.clock.install()
    await page.goto('/liff/help')
    // Signed in through LINE: the page now names the member's organization
    const signedIn = page.getByText(`ผู้ดูแลระบบของ ${member.organizationName}`, { exact: false })
    await expect(signedIn).toBeVisible()
    const first = await sessionCookie(context)
    expect(first).toMatch(/^liff_/)

    const renewals: string[] = []
    page.on('request', (request) => {
      if (request.url().endsWith('/api/liff/session')) renewals.push(request.method())
    })
    // An open page that nobody touches keeps no session alive
    await page.clock.fastForward('13:00')
    await page.waitForTimeout(500)
    expect(renewals).toEqual([])
    // The person comes back and taps: renewed before the server's 15 idle minutes ran out
    const renewed = page.waitForResponse((r) => r.url().endsWith('/api/liff/session'))
    await page.locator('main').click({ position: { x: 5, y: 5 } })
    expect((await renewed).status()).toBe(200)
    const second = await sessionCookie(context)
    expect(second).toMatch(/^liff_/)
    expect(second).not.toBe(first)
    // More taps right after: renewed already, nothing more is sent
    for (let i = 0; i < 5; i++) await page.locator('main').click({ position: { x: 5, y: 5 } })
    await page.waitForTimeout(500)
    expect(renewals).toEqual(['POST'])
    // NFR-SEC-04: the old session is gone, the new one works
    await page.reload()
    await expect(signedIn).toBeVisible()
    expect(await sessionCookie(context)).toBe(second)
  })

  test('a password sign-in inside a LINE app is never swapped for the LINE account’s session: taps send no LINE sign-in', async ({ page, context }) => {
    const { member } = liffScene<{ member: SceneMember }>('plain', sceneTag('pwd'))
    // A LINE account that is not linked (someone signing in with their password on a colleague's or a new phone)
    await openAsLineUser(context, newLineUserId())
    await page.clock.install()
    await page.goto('/liff/link')
    await page.getByLabel('อีเมลบริษัท').fill(member.email)
    await page.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
    await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
    await expect(page.getByRole('heading', { level: 2, name: 'ผูก LINE นี้กับบัญชีของคุณ' })).toBeVisible()
    const session = await sessionCookie(context)
    expect(session).not.toMatch(/^liff_/)

    const signIns: string[] = []
    page.on('request', (request) => {
      if (request.url().endsWith('/api/liff/session')) signIns.push(request.method())
    })
    await page.clock.fastForward('13:00')
    for (let i = 0; i < 8; i++) {
      await page.locator('main').click({ position: { x: 5, y: 5 } })
      await page.keyboard.press('Shift')
    }
    await page.waitForTimeout(500)
    expect(signIns).toEqual([])
    expect(await sessionCookie(context)).toBe(session)
  })
})

test.describe('[§9.4] a session the page has is never swapped for the session of the LINE account’s owner', () => {
  test('a deep link /liff will not follow keeps a password sign-in made in someone else’s LINE app, and sends the member on', async ({ page, context }) => {
    // LINE account X is linked to its owner; a colleague signs in with their own password inside X's LINE app
    const lineX = newLineUserId()
    const { member: owner } = liffScene<{ member: SceneMember }>('linked', sceneTag('owner'), lineX)
    const { member: guest } = liffScene<{ member: SceneMember }>('plain', sceneTag('guest'))
    await openAsLineUser(context, lineX)
    await passwordSignIn(page, guest, '/liff/help')
    const before = await sessionCookie(context)
    expect(before).not.toMatch(/^liff_/)
    const signIns: number[] = []
    page.on('response', (response) => {
      if (response.url().endsWith('/api/liff/session')) signIns.push(response.status())
    })
    // https://liff.line.me/<LIFF ID>?from=menu (a query only), and a path that leaves the LIFF app: neither is followed
    for (const state of ['?from=menu', '/../settings/line']) {
      await page.goto(`/liff?liff.state=${encodeURIComponent(state)}`)
      // The guest is not linked: the server sends them to /liff/link, with their own session
      await expect(page).toHaveURL(/\/liff\/link$/)
      await expect(page.getByText(guest.nameTh)).toBeVisible()
      await expect(page.getByText(owner.nameTh)).toHaveCount(0)
    }
    await page.waitForLoadState('networkidle')
    expect(signIns).toEqual([])
    expect(await sessionCookie(context)).toBe(before)
  })
})

/** Loads a LIFF page as a person would, waits until its first screen is up and the network is quiet, and weighs it */
async function firstLoad(page: Page, path: string, ready: () => Promise<void>) {
  const scripts = watchScripts(page)
  const document = await page.goto(path)
  await ready()
  await page.waitForLoadState('networkidle')
  const loads = await scripts()
  const total = loads.reduce((sum, load) => sum + load.transferred, 0)
  const sdk = loads.filter((l) => l.sdk)
  // The HTML: its bytes over the wire, and the page data written into it as inline scripts (gzip, as the server sends it)
  const html = (await document?.text()) ?? ''
  const htmlBytes = document ? (await document.request().sizes()).responseBodySize : 0
  const inline = gzipBytes(inlineScriptsOf(html).join('\n'))
  const catalogue = workspaceOnlyMessages().filter((message) => html.includes(message)).length
  const largest = [...loads]
    .sort((a, b) => b.transferred - a.transferred)
    .slice(0, 6)
    .map((l) => `${new URL(l.url).pathname.split('/').at(-1)}${l.sdk ? ' (LINE SDK)' : ''} ${l.transferred}`)
  const note =
    `${loads.length} script files, ${total} bytes over the wire; largest ${largest.join(', ')}. ` +
    `HTML ${htmlBytes} bytes over the wire, of which inline page data about ${inline} bytes gzip ` +
    `(script files and inline data together ${total + inline}); workspace messages found in it: ${catalogue} of ${workspaceOnlyMessages().length}`
  return { loads, total, sdk, inline, note }
}

test.describe('[§9.4] the first JavaScript of a LIFF page: its script files, with the LINE SDK, are at most 200 KB gzip', () => {
  const screens: ReadonlyArray<{ readonly name: string; readonly open: (page: Page, context: BrowserContext) => Promise<{ path: string; ready: () => Promise<void> }> }> = [
    {
      name: '/liff/help, a LINE account that is not linked',
      open: async (page, context) => {
        await openAsLineUser(context, newLineUserId())
        return { path: '/liff/help', ready: () => expect(page.getByRole('heading', { level: 2, name: 'เริ่มใช้ BCS ใน LINE' })).toBeVisible() }
      },
    },
    {
      name: '/liff/link, the e-mail sign-in of a LINE account that is not linked',
      open: async (page, context) => {
        await openAsLineUser(context, newLineUserId())
        return { path: '/liff/link', ready: () => expect(page.getByLabel('อีเมลบริษัท')).toBeVisible() }
      },
    },
    {
      name: '/liff/link?code=, a code from the web settings',
      open: async (page, context) => {
        const { code } = liffScene<{ code: string }>('code', sceneTag('size'))
        await openAsLineUser(context, newLineUserId())
        return { path: `/liff/link?code=${encodeURIComponent(code)}`, ready: () => expect(page.getByRole('button', { name: 'ผูก LINE นี้กับบัญชีนี้' })).toBeVisible() }
      },
    },
    {
      name: '/liff/link, a linked member in their own LINE app',
      open: async (page, context) => {
        const lineUserId = newLineUserId()
        liffScene('linked', sceneTag('size'), lineUserId)
        await openAsLineUser(context, lineUserId)
        return { path: '/liff/link', ready: () => expect(page.getByRole('button', { name: 'ยกเลิกการผูก LINE นี้' })).toBeVisible() }
      },
    },
  ]

  for (const screen of screens) {
    test(screen.name, async ({ page, context }, testInfo) => {
      const { path, ready } = await screen.open(page, context)
      const { loads, total, sdk, note } = await firstLoad(page, path, ready)
      // The page data inlined in the HTML is reported, not counted: whether §9.4 counts it is the spec owner's to say,
      // and today it carries the whole message catalogue of the root layout (src/app/layout.tsx)
      testInfo.annotations.push({ type: 'first-load-js', description: `${screen.name}: ${note}` })
      // The LINE SDK is part of it, as in the LINE app (with LIFF_MOCK the bootstrap loads it without liff.init)
      expect(sdk).toHaveLength(1)
      // What came over the wire was compressed, so this is the gzip size of §9.4
      expect(loads.filter((l) => l.transferred > 1024).every((l) => l.encoding === 'gzip' || l.encoding === 'br')).toBe(true)
      expect(total).toBeLessThanOrEqual(FIRST_LOAD_JS_BUDGET_BYTES)
    })
  }
})
