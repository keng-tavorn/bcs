import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import AxeBuilder from '@axe-core/playwright'
import { devices, type Browser, type BrowserContext, type CDPSession, type Page, type TestInfo } from '@playwright/test'
import { E2E_BASE_URL, E2E_FAKE_LINE_URL, e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'
import { checkScreen, fakeLine, newLineUserId, openAsLineUser, totpOf } from './liff-support'

// S17-16 (e2e @s17): the scenes of docs/sub-specs/S17.md "Demo ของขั้น" in the browser, with their people and figures,
// on a twin of the phase-1 organization (tests/e2e/s17-scene.ts) — phone screens, so in the mobile project only
// (playwright.config.ts):
//   scene 1  the rich menu of each role, read from the fake LINE server: pm_p07 4 buttons, dm_coni + งานรออนุมัติ,
//            store_p07 ตรวจรับ, proc_officer งานจัดซื้อ, dm_proc 6 buttons; admin gives fm_p07 RECEIVER on the web and
//            fm_p07's menu gains ตรวจรับ once job line-rich-menu ran (played by the scene: e2e has no Inngest)
//   scene 2  dm_coni taps หน้าแรก: /liff/home shows what to do, what waits for them (store_p06's steel sheets, H237) and
//            what they follow, with the numbers of the web home's services for the same member
//   scene 4  pm_p07's asphalt road (H229, 2,642,900.00 with VAT) has passed the parallel reviewers of S6 and waits for
//            the CEO; the CEO's phone gets the push from the fake FCM (no amount, name or title), the tap opens the task
//            in the app, and the CEO approves with a passkey (Chromium's virtual authenticator as the fingerprint): the
//            decision's channel is APP and the timeline says "แอป BCS Go"
//   scene 5  store_p07 receives the ready-mix concrete of H042 (2 m³ at 2,780.00) in the app without a signal: finds the
//            PO by its number, records 2 m³, the delivery note and a photo; with the signal back the photo goes up and the
//            receipt goes by itself, its first answer lost on the way: sent again with the same key, one GR, PO RECEIVED
//   scene 3  se_p01a writes in the LINE chat and sends the quotation's photo (DOC-031: steel DB25, 24,411.00 + VAT
//            1,708.77 = 26,119.77) through the fake LINE server, gets the button "ตรวจและส่งคำขอ", and in LIFF takes the
//            AI's values, confirms the money and the quantity one by one and sends it: DOA sends it to vp_ops
//   scene 6  the same with the AI module off (EG-1): the type picked and the line typed by the requester
// The app is the mobile browser with BCS Go's mark in its user agent (BCSGo/0.1.0), as the app's WebView sends it: the
// native halves — FCM's token, the tap on the notification, the camera's QR, the fingerprint itself — are tried on a phone
// (docs/runbooks/bcs-go-demo.md). Background jobs, which e2e runs without Inngest, are played by the scene script.

interface Twin {
  readonly orgCode: string
  readonly names: Readonly<Record<'ceo' | 'pm_p07' | 'store_p07' | 'se_p01a' | 'vp_ops', string>>
  readonly road: { readonly id: string; readonly number: string; readonly title: string; readonly ceoTaskId: string | null }
  readonly concrete: { readonly poId: string; readonly poNumber: string; readonly poStatus: string }
}
interface Home {
  readonly todo: ReadonlyArray<{ readonly key: string; readonly count: number }>
  readonly approvals: { readonly all: number; readonly overdue: number; readonly info: number; readonly taskIds: readonly string[] }
  readonly following: { readonly total: number; readonly open: number }
}
interface FakePush {
  readonly token: string
  readonly title: string
  readonly body: string | null
  readonly data: Readonly<Record<string, string>>
}

/** The fake FCM of the run, for the job the scene plays (PUSH_PROVIDER=fake is local only) */
const FAKE_PUSH_ENV = { PUSH_PROVIDER: 'fake', FCM_PROJECT_ID: 'bcs-go-e2e', FCM_API_BASE_URL: `${E2E_FAKE_LINE_URL}/fcm`, FCM_TOKEN_URL: `${E2E_FAKE_LINE_URL}/fcm/token` }
/** What the WebView of BCS Go adds to the phone's user agent (mobile/bcs-go/capacitor.config.ts) */
const APP_MARK = 'BCSGo/0.1.0'

function scene<T>(args: readonly string[], extra: Record<string, string> = {}): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/s17-scene.ts ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv(), ...extra } })
  // Link codes and push tokens are secrets of this test database: on failure only what went wrong is shown
  if (r.status !== 0) throw new Error(`S17 scene ${args[0]} failed:\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}

let twin: Twin

test.describe('@s17 the scenes of S17 with BCS Go and the LINE chat (S17-16)', () => {
  test.describe.configure({ timeout: 240_000 })

  test.beforeAll(({}, testInfo) => {
    testInfo.setTimeout(180_000)
    twin = scene<Twin>(['twin'])
  })

  /** The phone with the app: the mobile project's browser, BCS Go's mark in its user agent, an address of its own */
  async function appPhone(browser: Browser, options: { serviceWorkers?: 'allow' | 'block' } = {}): Promise<BrowserContext> {
    const [a, b] = randomBytes(2)
    const phone = devices['Pixel 7']
    return browser.newContext({
      ...phone,
      viewport: { width: 375, height: 812 },
      userAgent: `${phone.userAgent} ${APP_MARK}`,
      baseURL: E2E_BASE_URL,
      locale: 'th-TH',
      timezoneId: 'Asia/Bangkok',
      serviceWorkers: options.serviceWorkers ?? 'allow',
      extraHTTPHeaders: { 'x-forwarded-for': `198.18.${a!}.${(b! % 254) + 1}` },
    })
  }

  /** A member of the twin signs in: s17.<e-mail>, the seed's password, the authenticator code of their employee code */
  async function signIn(page: Page, code: string) {
    await page.goto('/login')
    await page.getByLabel('อีเมลบริษัท').fill(`s17.${code}@simec.bcs.local`)
    await page.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
    await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
    await expect(page).toHaveURL(/\/login\/2fa$/)
    await page.getByLabel('รหัส 6 หลักจากแอป').fill(totpOf(code))
    await page.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' }).click()
    await expect(page.getByRole('heading', { level: 1 })).toContainText('สวัสดี')
  }

  /** §9.9 on a screen of the app: axe without serious or critical violations, no sideways scroll, a picture at 375 px */
  async function check(page: Page, testInfo: TestInfo, name: string) {
    await expect(page).toHaveTitle(/\S/)
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'))
    const results = await new AxeBuilder({ page }).analyze()
    const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
    expect(blocking.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`s17-${name}.png`), fullPage: true })
  }

  /** Chromium's virtual authenticator: a platform one with user verification, as a phone's fingerprint is */
  async function fingerprint(page: Page): Promise<CDPSession> {
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('WebAuthn.enable')
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    })
    return cdp
  }

  /** The labels of the rich menu LINE shows this LINE user, and which set it is */
  async function menuOf(lineUserId: string, sets: Readonly<Record<string, string>>): Promise<{ set: string | null; labels: string[] }> {
    const { effectiveRichMenuId } = await fakeLine<{ effectiveRichMenuId: string | null }>(`/__fake/users/${lineUserId}/richmenu`)
    const { richMenus } = await fakeLine<{ richMenus: ReadonlyArray<{ richMenuId: string; menu: { areas?: ReadonlyArray<{ action?: { label?: string } }> } }> }>('/__fake/state')
    const menu = richMenus.find((m) => m.richMenuId === effectiveRichMenuId)
    const set = Object.entries(sets).find(([, id]) => id === effectiveRichMenuId)?.[0] ?? null
    return { set, labels: (menu?.menu.areas ?? []).map((a) => a.action?.label ?? '') }
  }

  test('[FR-LINE-303/AC1] [FR-LINE-303/AC2] scene 1: each role’s rich menu, and fm_p07’s gains ตรวจรับ once admin gives them RECEIVER on the web', async ({ browser }, testInfo) => {
    const { sets } = scene<{ sets: Record<string, string> }>(['menus'])
    const people = { pm_p07: 'LINKED', dm_coni: 'LINKED:APPROVER', store_p07: 'LINKED:RECEIVER', proc_officer: 'LINKED:PROCUREMENT', dm_proc: 'LINKED:APPROVER:PROCUREMENT', fm_p07: 'LINKED' } as const
    const lines: Record<string, string> = {}
    for (const code of Object.keys(people)) lines[code] = scene<{ lineUserId: string }>(['link', code, newLineUserId()]).lineUserId
    for (const [code, set] of Object.entries(people)) await expect.poll(async () => (await menuOf(lines[code]!, sets)).set, { message: code }).toBe(set)
    expect((await menuOf(lines.pm_p07!, sets)).labels).toEqual(['หน้าแรก', 'ขอซื้อ', 'ติดตามสถานะ', 'ช่วยเหลือ'])
    expect((await menuOf(lines.dm_coni!, sets)).labels).toContain('งานรออนุมัติ')
    expect((await menuOf(lines.store_p07!, sets)).labels).toContain('ตรวจรับ')
    expect((await menuOf(lines.proc_officer!, sets)).labels).toContain('งานจัดซื้อ')
    expect((await menuOf(lines.dm_proc!, sets)).labels).toHaveLength(6)

    // admin gives fm_p07 the role on the web (two organization admins: the one who grants is never the one granted)
    const context = await appPhone(browser)
    try {
      const page = await context.newPage()
      await signIn(page, 'admin')
      await page.goto('/admin/members')
      const row = page.getByRole('listitem').filter({ hasText: 's17.fm_p07@simec.bcs.local' })
      await row.getByRole('link', { name: /^จัดการ / }).click()
      await page.getByLabel('มอบบทบาท').selectOption({ label: 'ผู้ตรวจรับ' })
      await page.getByRole('button', { name: 'มอบบทบาท', exact: true }).click()
      await expect(page.getByRole('status').filter({ hasText: 'มอบบทบาทแล้ว' })).toBeVisible()
      await check(page, testInfo, 'menu-role-granted')
    } finally {
      await context.close()
    }
    scene(['menu-job', 'fm_p07'])
    await expect.poll(async () => (await menuOf(lines.fm_p07!, sets)).set).toBe('LINKED:RECEIVER')
    expect((await menuOf(lines.fm_p07!, sets)).labels).toContain('ตรวจรับ')
  })

  test('[FR-LINE-302/AC1] [FR-LINE-302/AC2] scene 2: dm_coni’s home in LINE shows the numbers of their web home and the steel sheets waiting for them', async ({ page, context }, testInfo) => {
    const { lineUserId } = scene<{ lineUserId: string }>(['link', 'dm_coni', newLineUserId()])
    await openAsLineUser(context, lineUserId)
    await page.goto('/liff')
    await expect(page).toHaveURL(/\/liff\/home$/)
    await expect(page.getByRole('heading', { level: 1, name: 'หน้าแรก' })).toBeVisible()
    const part = (name: string) => page.getByRole('region', { name, exact: true })
    for (const name of ['สิ่งที่ต้องทำ', 'รอฉันอนุมัติ', 'ที่ฉันติดตาม']) await expect(part(name).getByRole('status').filter({ hasText: 'กำลังโหลด' })).toHaveCount(0)
    const expected = scene<Home>(['home', 'dm_coni'])
    expect(expected.approvals.all).toBeGreaterThan(0)
    const waiting = part('รอฉันอนุมัติ')
    await expect(waiting).toContainText(`ทั้งหมด ${expected.approvals.all} งาน · เกินกำหนด ${expected.approvals.overdue} · รอผู้ขอตอบ ${expected.approvals.info}`)
    await expect(waiting.getByRole('list', { name: 'งานรอฉันอนุมัติทั้งหมด' }).getByRole('listitem').filter({ hasText: 'เหล็กแผ่นดำ' })).toHaveCount(1)
    if (expected.todo.length === 0) await expect(part('สิ่งที่ต้องทำ')).toContainText('งานที่รออนุมัติอยู่ในส่วน รอฉันอนุมัติ ข้างล่าง')
    else await expect(part('สิ่งที่ต้องทำ').getByRole('listitem')).toHaveCount(expected.todo.length)
    await expect(part('ที่ฉันติดตาม')).toContainText(expected.following.total === 0 ? 'ยังไม่มีคำขอที่คุณส่งหรือติดตาม' : `${expected.following.total} คำขอ`)
    await checkScreen(page, testInfo, 's17-liff-home')
  })

  /** se_p01a writes and sends the photo in the chat; the button of the account's answer leads to LIFF */
  async function askInChat(context: BrowserContext): Promise<{ intakeId: string; lineUserId: string }> {
    const { lineUserId } = scene<{ lineUserId: string }>(['link', 'se_p01a', newLineUserId()])
    const chat = scene<{ intakeId: string; messageCount: number; imageCount: number; replies: unknown[][] }>(['chat', lineUserId])
    expect(chat).toMatchObject({ messageCount: 2, imageCount: 1 })
    // BR-LINE-06: the answer is a button to LIFF, with none of what was typed
    const answer = JSON.stringify(chat.replies[0])
    expect(answer).toContain('ตรวจและส่งคำขอ')
    expect(answer).toContain(`/requests/new?intake=${chat.intakeId}`)
    for (const typed of ['DB25', 'เหล็ก', 'พระราม', '24,411', '26,119']) expect(JSON.stringify(chat.replies)).not.toContain(typed)
    await openAsLineUser(context, lineUserId)
    return { intakeId: chat.intakeId, lineUserId }
  }

  /** Step 1 of the draft in LIFF: the budget line of P01's construction materials of this fiscal year, then the items */
  async function toItems(page: Page) {
    await expect(page.getByRole('heading', { level: 2, name: /^ขั้นที่ 1 จาก 3: / })).toBeVisible()
    const budget = page.getByLabel('บรรทัดงบที่ใช้')
    const labels = await budget.locator('option').allTextContents()
    const materials = labels.filter((l) => l.startsWith('P01-MAT-')).sort().at(-1)
    if (!materials) throw new Error(`no budget line of P01's materials among ${labels.join(' | ')}`)
    await budget.selectOption({ label: materials })
    await page.getByRole('button', { name: 'ไปขั้นถัดไป: รายการที่ขอ' }).click()
    await expect(page.getByRole('heading', { level: 2, name: /^ขั้นที่ 2 จาก 3: / })).toBeVisible()
  }

  /** The items' figures of DOC-031, the route to vp_ops, and the send: returns the request's id */
  async function reviewAndSend(page: Page, testInfo: TestInfo, name: string): Promise<string> {
    await expect(page.getByRole('group', { name: 'รายการที่ 1' }).getByLabel('สิ่งที่ขอ')).toHaveValue('เหล็กข้ออ้อย DB25 SD40')
    // 24,411.00 before VAT, VAT 7% 1,708.77, 26,119.77 with it (DOC-031)
    await expect(page.getByText('24,411.00 บาท').first()).toBeVisible()
    await expect(page.getByText('1,708.77 บาท').first()).toBeVisible()
    await expect(page.getByText('26,119.77 บาท').first()).toBeVisible()
    await checkScreen(page, testInfo, `${name}-items`)
    await page.getByRole('button', { name: 'ไปขั้นถัดไป: ตรวจและส่ง' }).click()
    const route = page.getByRole('region', { name: 'เส้นทางอนุมัติที่คาดไว้' })
    await expect(route.getByText(twin.names.vp_ops)).toBeVisible()
    await checkScreen(page, testInfo, `${name}-review`)
    await page.getByRole('button', { name: 'ส่งขออนุมัติ', exact: true }).click()
    const sent = page.getByRole('status').filter({ hasText: 'ส่งขออนุมัติแล้ว' })
    // The same steel sent by an earlier scene of the run (scene 6 replays scene 3) is flagged as a likely duplicate:
    // BR-DUP-05 asks the requester for a reason on the LIFF page before it goes (FR-LINE-301 AC4)
    const duplicate = page.getByRole('heading', { level: 3, name: 'คำขอนี้คล้ายคำขอที่คุณส่งไปแล้ว' })
    await expect(sent.or(duplicate)).toBeVisible()
    if (await duplicate.isVisible()) {
      await checkScreen(page, testInfo, `${name}-duplicate`)
      await page.getByRole('textbox', { name: /^เหตุผลที่ขออีกครั้ง/ }).fill('เล่นฉากขอผ่านแชทซ้ำโดยปิด AI ตามแผน demo')
      await page.getByRole('button', { name: 'ส่งขออนุมัติ', exact: true }).click()
    }
    await expect(sent).toContainText(`รอ ${twin.names.vp_ops} พิจารณา`)
    await checkScreen(page, testInfo, `${name}-sent`)
    return new URL(page.url()).pathname.split('/').at(-2)!
  }

  test('[FR-LINE-301/AC1] [FR-LINE-301/AC3] [FR-LINE-301/AC4] [FR-LINE-301/AC5] scene 3: se_p01a asks in the chat with the quotation\'s photo; in LIFF the AI\'s values are marked, the money and quantity confirmed one by one, and the request goes to vp_ops', async ({ page, context }, testInfo) => {
    scene(['ai', 'on'])
    const { intakeId } = await askInChat(context)
    // The photo is fetched from LINE and kept, then the Intake Agent reads the words and the photo (jobs of the scene)
    expect(scene(['chat-jobs', intakeId])).toEqual({ images: ['STORED'], ai: { status: 'LINKED', agentActionId: expect.any(String) }, action: { status: 'DRAFT', errorCode: null } })

    await page.goto(`/liff/requests/new?intake=${intakeId}`)
    await expect(page.getByRole('heading', { level: 1, name: 'ร่างคำขอจากแชท' })).toBeVisible()
    await expect(page.getByText(/ขอซื้อเหล็กข้ออ้อย DB25 1 ตัน/)).toBeVisible()
    const ai = page.getByRole('region', { name: /ค่าที่ AI อ่านได้/ })
    await expect(ai.getByText('เติมโดย AI โปรดตรวจ')).toBeVisible()
    await expect(ai.getByText(/เหล็กข้ออ้อย DB25 SD40 · 1 ตัน · ราคาต่อหน่วย 24,?411\.00 บาท/)).toBeVisible()
    await expect(page.getByRole('radio', { name: /ซื้อของ/ })).toBeChecked()
    await checkScreen(page, testInfo, 's17-chat-ai')
    await page.getByRole('button', { name: 'สร้างร่างคำขอ' }).click()
    await expect(page).toHaveURL(/\/liff\/requests\/[0-9a-f-]{36}\/edit$/)

    // BR-AI-16: the quantity and the unit price wait to be confirmed one by one before the request may go
    const waiting = page.getByRole('region', { name: /ค่าที่ AI เติมรอยืนยัน/ })
    await expect(waiting.getByText('รายการที่ 1 · จำนวน')).toBeVisible()
    await expect(waiting.getByText('รายการที่ 1 · ราคาต่อหน่วย (บาท)')).toBeVisible()
    await checkScreen(page, testInfo, 's17-chat-ai-confirm')
    for (const box of await waiting.getByRole('checkbox').all()) await box.check()
    await waiting.getByRole('button', { name: 'ยืนยันค่าที่ตรวจแล้ว' }).click()
    await expect(page.getByRole('region', { name: /ค่าที่ AI เติมรอยืนยัน/ })).toHaveCount(0)

    await toItems(page)
    const requestId = await reviewAndSend(page, testInfo, 's17-chat-ai')
    expect(scene(['request', requestId])).toEqual({ number: expect.stringMatching(/^PR-\d{4}-\d{5}$/), status: 'PENDING_APPROVAL', type: 'BUY_GOODS', gross: '2611977', approver: 'vp_ops' })
  })

  test('[FR-LINE-301/AC6] [FR-LINE-301/AC4] scene 6: with the AI module off the chat works on: the requester picks the type, types the line and the request goes to vp_ops', async ({ page, context }, testInfo) => {
    scene(['ai', 'off'])
    try {
      const { intakeId } = await askInChat(context)
      expect(scene(['chat-jobs', intakeId])).toMatchObject({ images: ['STORED'], ai: { status: 'SKIPPED' }, action: null })

      await page.goto(`/liff/requests/new?intake=${intakeId}`)
      await expect(page.getByRole('heading', { level: 1, name: 'ร่างคำขอจากแชท' })).toBeVisible()
      await expect(page.getByRole('region', { name: /ค่าที่ AI อ่านได้/ })).toHaveCount(0)
      await expect(page.getByText('เติมโดย AI โปรดตรวจ')).toHaveCount(0)
      await page.getByRole('radio', { name: /ซื้อของ/ }).check()
      await checkScreen(page, testInfo, 's17-chat-no-ai')
      await page.getByRole('button', { name: 'สร้างร่างคำขอ' }).click()
      await expect(page).toHaveURL(/\/liff\/requests\/[0-9a-f-]{36}\/edit$/)
      await expect(page.getByLabel('ชื่อคำขอ')).toHaveValue('ขอซื้อเหล็กข้ออ้อย DB25 1 ตัน ส่งไซต์พระราม 9')

      await toItems(page)
      await page.getByLabel('สถานที่ส่ง').selectOption({ label: 'SITE-P01 · หน้างานโครงการ P01 อาคารสำนักงานพระราม 9' })
      const line = page.getByRole('group', { name: 'รายการที่ 1' })
      await line.getByLabel('สิ่งที่ขอ').fill('เหล็กข้ออ้อย DB25 SD40')
      await line.getByLabel(/^จำนวน/).fill('1')
      await line.getByLabel(/^หน่วย/).fill('ตัน')
      await line.getByLabel(/^ราคาต่อหน่วย/).fill('24411.00')
      const requestId = await reviewAndSend(page, testInfo, 's17-chat-no-ai')
      expect(scene(['request', requestId])).toEqual({ number: expect.stringMatching(/^PR-\d{4}-\d{5}$/), status: 'PENDING_APPROVAL', type: 'BUY_GOODS', gross: '2611977', approver: 'vp_ops' })
    } finally {
      scene(['ai', 'on'])
    }
  })

  test('[FR-PLT-301/AC1] [FR-PLT-301/AC3] scene 4: the CEO gets the push of the asphalt road, opens the task in the app and approves it with a passkey; the timeline says "แอป BCS Go"', async ({ browser }, testInfo) => {
    expect(twin.road.ceoTaskId, 'H229 waits for the CEO once its three reviewers passed it').not.toBeNull()
    const taskId = twin.road.ceoTaskId!
    const context = await appPhone(browser)
    try {
      const page = await context.newPage()
      await fingerprint(page)
      await signIn(page, 'ceo')
      // The CEO's passkey, added in the app after the password again (FR-PLT-301 AC4)
      await page.goto('/settings/pin')
      await page.getByRole('button', { name: 'เพิ่ม passkey บนเครื่องนี้' }).click()
      const form = page.locator('form').filter({ has: page.getByRole('heading', { name: 'ยืนยันตัวตนก่อนเพิ่ม passkey' }) })
      if (await form.getByRole('radio').count()) await form.getByRole('radio').first().check()
      await form.locator('#passkey-password').fill(process.env.SEED_DEV_PASSWORD!)
      await form.getByLabel('ชื่อเครื่อง').fill('โทรศัพท์ของ CEO')
      await form.getByRole('button', { name: 'ยืนยันและเพิ่ม passkey' }).click()
      await expect(page.getByText('เพิ่ม passkey แล้ว ระบบส่งอีเมลแจ้งคุณด้วย')).toBeVisible()

      // The phone registered for push (the app does it once FCM gives its token), then the task notice goes by push
      const device = scene<{ token: string }>(['push-device', 'ceo'])
      const delivered = scene<{ outcomes: Array<{ status: string; channel?: string }> }>(['deliver', 'ceo', twin.road.id], FAKE_PUSH_ENV)
      expect(delivered.outcomes).toEqual([{ status: 'SENT', channel: 'PUSH' }])
      const { pushes } = (await (await fetch(`${E2E_FAKE_LINE_URL}/__fake/pushes`)).json()) as { pushes: FakePush[] }
      const push = pushes.find((p) => p.token === device.token)
      // BR-NOTI-06: a title, the document's number, the page to open — no amount, no name, no subject
      expect(push).toMatchObject({ title: 'มีงานรออนุมัติ', body: twin.road.number, data: expect.objectContaining({ path: `/tasks/${taskId}` }) })
      const shown = JSON.stringify(push)
      for (const secret of ['2,642,900', '2642900', 'แอสฟัลต์', twin.names.pm_p07, twin.names.ceo]) expect(shown).not.toContain(secret)

      // The tap opens the task in the app; at 2,642,900.00 (from 100,000.00) the approval asks for a step-up
      await page.goto(push!.data.path!)
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(twin.road.title)
      await expect(page.getByText(`คำขอ ${twin.road.number}`, { exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'อนุมัติ', exact: true }).click()
      const confirm = page.getByRole('group', { name: new RegExp(`^อนุมัติ ${twin.road.number} `) })
      const withPasskey = confirm.getByRole('button', { name: 'อนุมัติด้วยลายนิ้วมือหรือใบหน้า (passkey)' })
      await expect(withPasskey).toBeVisible()
      await check(page, testInfo, 'push-task')
      await withPasskey.click()
      // The decision's outcome on the task (the route above it already shows the three reviewers' อนุมัติแล้ว)
      await expect(page.getByRole('region', { name: twin.road.title }).getByText('อนุมัติแล้ว', { exact: true })).toBeVisible()
      expect(scene(['decided', taskId])).toEqual({ status: 'APPROVED', decision: 'APPROVE', channel: 'APP', stepUp: 'PASSKEY' })

      // FR-PLT-003 AC3: the route and the history name the channel of the decision
      await page.goto(`/requests/${twin.road.id}`)
      const ceoStep = page.getByRole('list', { name: 'ขั้นอนุมัติ' }).getByRole('listitem').filter({ hasText: twin.names.ceo })
      await expect(ceoStep).toContainText('อนุมัติแล้ว')
      await expect(ceoStep).toContainText('แอป BCS Go')
      await check(page, testInfo, 'push-route')
      await page.getByRole('tab', { name: 'ประวัติ' }).click()
      await expect(page).toHaveURL(/[?&]tab=history/)
      const history = page.getByRole('list', { name: 'ประวัติของเอกสาร' }).getByRole('listitem').filter({ hasText: twin.names.ceo }).filter({ hasText: 'อนุมัติ' })
      await expect(history.first()).toContainText('แอป BCS Go')
      await check(page, testInfo, 'push-history')
    } finally {
      await context.close()
    }
  })

  test('[FR-PLT-301/AC6] [FR-PLT-301/AC7] [FR-PLT-301/AC8] scene 5: store_p07 receives 2 m³ of ready-mix concrete without a signal; back online it goes once, its lost answer sent again with the same key: one GR, PO RECEIVED', async ({ browser }, testInfo) => {
    // A context without the service worker, so that the page's route sees the receipt's request (go-receive.spec.ts opens
    // the page itself without a signal)
    const context = await appPhone(browser, { serviceWorkers: 'block' })
    try {
      const page = await context.newPage()
      await signIn(page, 'store_p07')
      await page.goto('/go/receive')
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('ตรวจรับหน้างาน')
      const prepared = page.getByRole('button', { name: `บันทึกตรวจรับ ${twin.concrete.poNumber}` })
      await expect(prepared).toBeVisible()
      await check(page, testInfo, 'receive-online')

      const keys: string[] = []
      await page.route('**/api/go/receiving/gr', async (route) => {
        if (route.request().method() !== 'POST') return route.continue()
        keys.push(route.request().headers()['idempotency-key'] ?? '')
        if (keys.length > 1) return route.continue()
        // The server records the receipt; its answer never reaches the phone
        await route.fetch()
        await route.abort('connectionfailed')
      })

      await context.setOffline(true)
      try {
        // The PO's number, as the scanner's value would find it (the camera itself is tried on a phone)
        await page.getByLabel('เลขใบสั่งซื้อ').fill(twin.concrete.poNumber)
        await page.getByRole('button', { name: 'หาใบสั่งซื้อ' }).click()
        const found = page.getByRole('dialog', { name: twin.concrete.poNumber })
        await expect(found).toContainText('1 รายการ')
        await found.getByRole('button', { name: `บันทึกตรวจรับ ${twin.concrete.poNumber}` }).click()
        await expect(page.getByRole('heading', { name: `บันทึกตรวจรับ ${twin.concrete.poNumber}` })).toBeVisible()
        await expect(page.getByText('คอนกรีตผสมเสร็จ 400 กก./ตร.ซม.').first()).toBeVisible()
        await page.getByLabel(/รับรอบนี้/).first().fill('2')
        await page.getByLabel('เลขที่ใบส่งของ').fill('DN-RMC-0716')
        await page.locator('input[type=file]').setInputFiles({ name: 'concrete.jpg', mimeType: 'image/jpeg', buffer: await photo(page) })
        await expect(page.getByRole('button', { name: /^เอารูป .+ ออก$/ })).toBeVisible()
        await check(page, testInfo, 'receive-form-offline')
        await page.getByRole('button', { name: 'บันทึกไว้ในเครื่อง' }).click()
        await expect(page.getByText('บันทึกไว้ในเครื่องแล้ว จะส่งให้เองเมื่อมีสัญญาณ')).toBeVisible()
        await expect(pending(page, 'รอส่ง')).toHaveText('1')
        await check(page, testInfo, 'receive-queued')
        expect(scene<{ receipts: unknown[] }>(['po', twin.concrete.poId]).receipts).toEqual([])
      } finally {
        await context.setOffline(false)
      }

      // The signal is back: the photo goes up and the receipt goes; its answer is lost, so it goes again with its key
      await expect(page.getByText('ไม่มีรายการค้างในเครื่อง')).toBeVisible({ timeout: 90_000 })
      expect(keys).toHaveLength(2)
      expect(keys[1]).toBe(keys[0])
      expect(scene(['po', twin.concrete.poId])).toEqual({
        status: 'RECEIVED',
        receipts: [{ number: expect.stringMatching(/^GR-\d{4}-\d{5}$/), status: 'POSTED', offline: true, quantities: ['2.00'], photos: 1, channel: 'APP' }],
      })
      await check(page, testInfo, 'receive-sent')
    } finally {
      await context.close()
    }
  })
})

/** The count of one kind of the queue on /go/receive (รอส่ง, อาจบันทึกแล้ว, …) */
const pending = (page: Page, label: string) => page.locator('dl > div').filter({ has: page.locator('dt', { hasText: new RegExp(`^${label}$`) }) }).locator('dd')

/** A camera-sized photo made by the browser itself (a real JPEG, so the page can shrink it before keeping it) */
async function photo(page: Page): Promise<Buffer> {
  const base64 = await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 3000
    canvas.height = 2000
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#6b6b6b'
    ctx.fillRect(0, 0, 3000, 2000)
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/jpeg', 0.9))
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let text = ''
    for (const b of bytes) text += String.fromCharCode(b)
    return btoa(text)
  })
  return Buffer.from(base64, 'base64')
}
