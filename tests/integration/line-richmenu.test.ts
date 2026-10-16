import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { POST as linkRoute } from '@/app/api/liff/link/route'
import { POST as webhookRoute } from '@/app/api/webhooks/line/[channelKey]/route'
import type { Result } from '@/core/result'
import { createLineClient, setLineClient } from '@/integrations/line'
import { MS_PER_MINUTE, MS_PER_SECOND } from '@/lib/constants'
import { getEnv } from '@/lib/env'
import { setLiffVerification } from '@/server/auth/liff'
import { upsertUserWithPassword } from '@/server/auth/provision'
import { makeCtx, systemCtx, type Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { getDefaultOutboxSender, setDefaultOutboxSender, type OutboxMessage, type OutboxSender } from '@/server/events/outbox'
import { lineRichMenuRun } from '@/server/jobs/line-rich-menu'
import { processQueuedLineWebhookEvents } from '@/server/jobs/line-webhook'
import { LINE_RICH_MENU_KINDS, lineRichMenuCells, richMenuImageProblem } from '@/server/line/link-rich-menus'
import { saveLineChannelSettings } from '@/server/services/line-channel'
import { issueLineLinkCode, readLineRichMenuImages, replaceLineRichMenus, runLineRichMenuSync, unlinkMyLine, type LineRichMenuImages } from '@/server/services/line-link'
import { describeLineRichMenuRun, runLineRichMenu } from '../../scripts/line-richmenu'
import { buildLineWebhook, lineEvents, newLineUserId, signLineWebhook, type LineWebhookEventJson } from '../../scripts/line-simulate'
import { createOrg } from '../support/factory'
import { TEST_ACCESS_TOKEN, TEST_CHANNEL_SECRET, withFakeLine } from '../support/fake-line'

// S5-04 and D-02 · FR-LINE-004: the two rich menus of §9.5. AC1: UNLINKED — "ผูกบัญชี" and "ช่วยเหลือ" — is the
// account's default, so whoever has not linked sees it; LINKED — "ขอซื้อ", "งานรออนุมัติ", "ติดตามสถานะ" and
// "ช่วยเหลือ" — is linked to each member's LINE user once they link, set again when they follow the account after LINE
// dropped it, and moved when the menus are made again; every button opens its LIFF page. Both are made by an ORG_ADMIN
// command (pnpm line:richmenu on this machine, or the admin screen) from the pictures in assets/line. AC3: the menu
// changes within a minute of a link or an unlink — in the request itself, or in job line-rich-menu, which the outbox
// starts at once. LINE is the fake LINE server of the repo.

const ENV = vi.hoisted(() => {
  const before = { NEXT_PUBLIC_LIFF_ID: process.env.NEXT_PUBLIC_LIFF_ID, LINE_LIFF_CHANNEL_ID: process.env.LINE_LIFF_CHANNEL_ID }
  const values = { liffId: '1650000023-RcHmEnUs', liffChannelId: '1650000023' }
  process.env.NEXT_PUBLIC_LIFF_ID = values.liffId
  process.env.LINE_LIFF_CHANNEL_ID = values.liffChannelId
  return { ...values, before }
})

const PROVIDER = '1650000021'
const CHANNEL = {
  providerId: PROVIDER,
  messagingChannelId: '1650000022',
  channelSecret: TEST_CHANNEL_SECRET,
  channelAccessToken: TEST_ACCESS_TOKEN,
  liffId: ENV.liffId,
  liffChannelId: ENV.liffChannelId,
}
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const liff = (path: string) => `https://liff.line.me/${ENV.liffId}${path}`

const line = withFakeLine()
let images: LineRichMenuImages
const toInngest: OutboxMessage[] = []
let senderBefore: OutboxSender | null = null

beforeAll(async () => {
  images = await readLineRichMenuImages()
  setLiffVerification({ fetch: (input, init) => fetch(String(input).replace(getEnv().LINE_API_BASE_URL, line.fake.url), init) })
  senderBefore = getDefaultOutboxSender()
  setDefaultOutboxSender(async (messages) => {
    toInngest.push(...messages)
  })
})
afterAll(() => {
  setLiffVerification(null)
  setDefaultOutboxSender(senderBefore)
  for (const [name, value] of Object.entries(ENV.before)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

function ok<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`)
  return result.data
}

async function person(orgId: string, roles: Array<'ORG_ADMIN'> = []) {
  const email = `${randomUUID()}@test.bcs.local`
  const userId = await upsertUserWithPassword({ email, name: 'ผู้ใช้ LINE', password: 'rich-menu-password-1' })
  const member = await prisma.member.create({ data: { organizationId: orgId, email, displayNameTh: 'ผู้ใช้ LINE', status: 'ACTIVE', userId } })
  for (const role of roles) await prisma.roleAssignment.create({ data: { organizationId: orgId, memberId: member.id, role, grantedAt: new Date() } })
  return { memberId: member.id, ctx: (channel: Ctx['channel'] = 'WEB') => makeCtx({ organizationId: orgId, actor: { type: 'USER', memberId: member.id }, channel, now: new Date() }) }
}
type Person = Awaited<ReturnType<typeof person>>

async function lineOrg(options: { menus?: boolean; liff?: boolean } = {}) {
  const org = await createOrg()
  const admin = await person(org.id, ['ORG_ADMIN'])
  const adminCtx = admin.ctx()
  const saved = ok(await saveLineChannelSettings(adminCtx, { ...CHANNEL, ...(options.liff === false ? { liffId: '', liffChannelId: '' } : {}), active: true }, key()))
  const menus = options.menus === false ? null : ok(await replaceLineRichMenus(adminCtx, images, key()))
  return { orgId: org.id, code: org.code, admin, adminCtx, channelKey: saved.channelKey, linkedMenu: menus?.linkedId ?? null, unlinkedMenu: menus?.unlinkedId ?? null }
}

const config = (orgId: string) => prisma.lineChannelConfig.findFirstOrThrow({ where: { organizationId: orgId } })
const idTokenFor = (lineUserId: string) => line.fake.issueIdToken({ sub: lineUserId, aud: ENV.liffChannelId })

async function postLink(body: unknown) {
  const env = getEnv()
  const response = await linkRoute(
    new Request(`${env.APP_URL.replace(/\/+$/, '')}/api/liff/link`, { method: 'POST', headers: { 'content-type': 'application/json', origin: new URL(env.APP_URL).origin }, body: JSON.stringify(body) }),
  )
  return response.status
}

async function linkVia(p: Person, lineUserId: string = newLineUserId()) {
  const code = ok(await issueLineLinkCode(p.ctx()))
  expect(await postLink({ code: code.code, idToken: idTokenFor(lineUserId) })).toBe(200)
  const identity = await prisma.channelIdentity.findFirstOrThrow({ where: { memberId: p.memberId, unlinkedAt: null } })
  return { lineUserId, identityId: identity.id }
}

const atLine = (id: string | null) => line.fake.richMenus().find((m) => m.richMenuId === id)
const buttons = (id: string | null) => ((atLine(id)?.menu.areas ?? []) as Array<{ action: { label?: string; uri?: string } }>).map((a) => ({ label: a.action.label, uri: a.action.uri }))
const jobStep = { run: <T>(_id: string, fn: () => Promise<T>) => fn() }
const lastSettingsEvent = async (orgId: string) =>
  (await prisma.event.findMany({ where: { organizationId: orgId, type: 'organization.settings_updated' }, orderBy: { seq: 'asc' } })).at(-1)

/** Runs `work` with the app's LINE client going through `through` (to make LINE fail or wait), then puts it back */
async function withLine<T>(through: typeof fetch, work: () => Promise<T>): Promise<T> {
  setLineClient(createLineClient({ apiBaseUrl: line.fake.url, dataApiBaseUrl: line.fake.url, fetch: through }))
  try {
    return await work()
  } finally {
    setLineClient(line.client)
  }
}

/** LINE answering `status` to the calls `when` picks, and as usual otherwise */
const failing =
  (when: (url: string, init?: RequestInit) => boolean, status = 500): typeof fetch =>
  async (input, init) =>
    when(String(input), init) ? new Response(JSON.stringify({ message: 'refused by the test' }), { status, headers: { 'content-type': 'application/json' } }) : fetch(input, init)

/** A menu made at LINE outside BCS's run, under this name (as an earlier or a concurrent run leaves one) */
const menuNamed = (name: string) =>
  line.client.channel(TEST_ACCESS_TOKEN).createRichMenu({
    size: { width: 2500, height: 843 },
    selected: false,
    name,
    chatBarText: 'เมนู BCS',
    areas: [{ bounds: { x: 0, y: 0, width: 2500, height: 843 }, action: { type: 'uri', uri: liff('/help') } }],
  })

/** A PNG that says it is `width` × `height` (only its header is read before LINE would see it) */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return new Uint8Array(bytes)
}

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 5_000): Promise<T> {
  const until = performance.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (done(value) || performance.now() > until) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** A webhook signed as LINE signs it, to the app's route; answered once the events processed inline are done */
async function deliver(channelKey: string, events: readonly LineWebhookEventJson[]): Promise<number> {
  const { body } = buildLineWebhook(events)
  const response = await webhookRoute(
    new Request(`http://localhost:3000/api/webhooks/line/${channelKey}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', 'user-agent': 'LineBotWebhook/2.0', 'x-line-signature': signLineWebhook(TEST_CHANNEL_SECRET, body) },
      body,
    }),
    { params: Promise.resolve({ channelKey }) },
  )
  return response.status
}

const webhookRow = (orgId: string, event: LineWebhookEventJson) => prisma.lineWebhookEvent.findFirstOrThrow({ where: { organizationId: orgId, webhookEventId: event.webhookEventId } })
const repliesTo = (event: LineWebhookEventJson) => line.fake.messages().filter((m) => m.kind === 'reply' && m.replyToken === event.replyToken)
/**
 * What LINE does to a user who blocks and then unblocks the account (LINE's FAQ: "that rich menu will be unlinked from
 * the user"); the fake keeps a user's menu across unfollow and follow, so the test drops it the way LINE does
 */
const lineDropsMenuOf = (lineUserId: string) => line.client.channel(TEST_ACCESS_TOKEN).unlinkRichMenuFromUser(lineUserId)
/** A call that links some menu to this LINE user */
const linksMenuTo = (lineUserId: string) => (url: string, init?: RequestInit) => init?.method === 'POST' && url.includes(`/v2/bot/user/${lineUserId}/richmenu/`)

describe('[FR-LINE-004/AC1] two menus from assets/line: UNLINKED (link, help) is the default for everyone; LINKED (request, tasks, track, help) is linked to each member who links', () => {
  it('makes both at LINE with their pictures, sets UNLINKED as the default and stores both on the channel, as ORG_ADMIN with organization.settings_updated', async () => {
    const org = await lineOrg({ menus: false })
    const before = await config(org.orgId)
    const made = ok(await replaceLineRichMenus(org.adminCtx, images, key()))
    expect(made).toEqual({
      linkedId: expect.stringMatching(/^richmenu-/),
      unlinkedId: expect.stringMatching(/^richmenu-/),
      // FR-LINE-303 AC4: UNLINKED and the eight sets by role
      sets: 9,
      replaced: false,
      defaultSet: true,
      relinked: 0,
      relinkRefused: 0,
      relinkFailed: 0,
      removed: 0,
      removeFailed: 0,
    })
    expect(await config(org.orgId)).toMatchObject({ richMenuLinkedId: made.linkedId, richMenuUnlinkedId: made.unlinkedId, version: before.version + 1 })
    expect(line.fake.defaultRichMenu()).toBe(made.unlinkedId)
    for (const [kind, id] of [
      ['UNLINKED', made.unlinkedId],
      ['LINKED', made.linkedId],
    ] as const) {
      expect(atLine(id)?.menu).toMatchObject({ size: { width: 2500, height: 843 }, selected: true, name: expect.stringMatching(new RegExp(`^bcs:${org.channelKey}:${kind}:\\d+$`)), chatBarText: 'เมนู BCS' })
      expect(atLine(id)?.image).toEqual({ contentType: 'image/png', bytes: images[kind]!.length })
    }
    expect(buttons(made.unlinkedId)).toEqual([
      { label: 'ผูกบัญชี', uri: liff('/link') },
      { label: 'ช่วยเหลือ', uri: liff('/help') },
    ])
    // FR-LINE-004 AC1 as S17-03 changed it: LINKED is the set of a member with no role button (golden line-rich-menu)
    expect(buttons(made.linkedId)).toEqual([
      { label: 'หน้าแรก', uri: liff('/home') },
      { label: 'ขอซื้อ', uri: liff('/requests/new') },
      { label: 'ติดตามสถานะ', uri: liff('/track') },
      { label: 'ช่วยเหลือ', uri: liff('/help') },
    ])
    expect(await lastSettingsEvent(org.orgId)).toMatchObject({ aggregateType: 'Organization', actorMemberId: org.admin.memberId, data: { section: 'lineRichMenu', replaced: false } })
    // [FR-LINE-303/AC4] every set by role is made with its own picture and stored, LINKED the same menu as on the channel
    const sets = await prisma.lineRichMenuVariant.findMany({ where: { organizationId: org.orgId }, select: { variantKey: true, richMenuId: true } })
    expect(sets.map((v) => v.variantKey).sort()).toEqual(LINE_RICH_MENU_KINDS.filter((k) => k !== 'UNLINKED').sort())
    expect(sets.find((v) => v.variantKey === 'LINKED')!.richMenuId).toBe(made.linkedId)
    for (const v of sets) {
      expect(atLine(v.richMenuId)?.image, v.variantKey).toEqual({ contentType: 'image/png', bytes: images[v.variantKey]!.length })
      expect(buttons(v.richMenuId).map((b) => b.uri), v.variantKey).toEqual(lineRichMenuCells(v.variantKey).map((c) => liff(c.button.path)))
    }
    expect(buttons(sets.find((v) => v.variantKey === 'LINKED:APPROVER:RECEIVER:PROCUREMENT')!.richMenuId)).toEqual([
      { label: 'หน้าแรก', uri: liff('/home') },
      { label: 'ขอซื้อ', uri: liff('/requests/new') },
      { label: 'งานรออนุมัติ', uri: liff('/tasks') },
      { label: 'ตรวจรับ', uri: liff('/gr') },
      { label: 'งานจัดซื้อ', uri: liff('/procurement') },
      { label: 'ช่วยเหลือ', uri: liff('/help') },
    ])
  })

  it('shares the picture among the buttons (§9.5): no gap and no overlap, in the order they are drawn', () => {
    for (const kind of LINE_RICH_MENU_KINDS) {
      const cells = lineRichMenuCells(kind)
      expect(cells.reduce((sum, c) => sum + c.bounds.width * c.bounds.height, 0)).toBe(2500 * 843)
      for (const [i, a] of cells.entries()) {
        expect(a.bounds.x + a.bounds.width).toBeLessThanOrEqual(2500)
        expect(a.bounds.y + a.bounds.height).toBeLessThanOrEqual(843)
        for (const b of cells.slice(i + 1)) {
          const apart = a.bounds.x + a.bounds.width <= b.bounds.x || b.bounds.x + b.bounds.width <= a.bounds.x || a.bounds.y + a.bounds.height <= b.bounds.y || b.bounds.y + b.bounds.height <= a.bounds.y
          expect(apart, `${kind} ${a.button.key} and ${b.button.key}`).toBe(true)
        }
      }
    }
    expect(lineRichMenuCells('UNLINKED').map((c) => [c.button.key, c.button.primary, c.bounds])).toEqual([
      ['link', true, { x: 0, y: 0, width: 1250, height: 843 }],
      ['help', false, { x: 1250, y: 0, width: 1250, height: 843 }],
    ])
    expect(lineRichMenuCells('LINKED').map((c) => [c.button.key, c.button.primary, c.bounds])).toEqual([
      ['home', false, { x: 0, y: 0, width: 1250, height: 421 }],
      ['request', true, { x: 1250, y: 0, width: 1250, height: 421 }],
      ['track', false, { x: 0, y: 421, width: 1250, height: 422 }],
      ['help', false, { x: 1250, y: 421, width: 1250, height: 422 }],
    ])
    // FR-LINE-303: five buttons are 3 + 2, six are 3 + 3; the first role button is the main one
    expect(lineRichMenuCells('LINKED:APPROVER').map((c) => [c.button.key, c.button.primary, c.bounds])).toEqual([
      ['home', false, { x: 0, y: 0, width: 833, height: 421 }],
      ['request', false, { x: 833, y: 0, width: 833, height: 421 }],
      ['tasks', true, { x: 1666, y: 0, width: 834, height: 421 }],
      ['track', false, { x: 0, y: 421, width: 1250, height: 422 }],
      ['help', false, { x: 1250, y: 421, width: 1250, height: 422 }],
    ])
    expect(lineRichMenuCells('LINKED:APPROVER:RECEIVER:PROCUREMENT').map((c) => c.button.key)).toEqual(['home', 'request', 'tasks', 'receive', 'procurement', 'help'])
  })

  it('shows UNLINKED to someone who is not linked, LINKED with its four buttons once they link, and UNLINKED again after the unlink', async () => {
    const org = await lineOrg()
    const member = await person(org.orgId)
    const lineUserId = newLineUserId()
    const shown = () => line.fake.userRichMenu(lineUserId) ?? line.fake.defaultRichMenu()
    expect(shown()).toBe(org.unlinkedMenu)
    await linkVia(member, lineUserId)
    expect(shown()).toBe(org.linkedMenu)
    expect(buttons(shown())).toHaveLength(4)
    ok(await unlinkMyLine(member.ctx(), {}, key()))
    expect(shown()).toBe(org.unlinkedMenu)
    expect(buttons(shown()).map((b) => b.label)).toEqual(['ผูกบัญชี', 'ช่วยเหลือ'])
  })

  it('makes them again: the new pair is stored, members linked now move to the new LINKED menu, and the menus made before are taken down', async () => {
    const org = await lineOrg()
    const member = await person(org.orgId)
    const { lineUserId } = await linkVia(member)
    const again = ok(await replaceLineRichMenus(org.adminCtx, images, key()))
    expect(again).toMatchObject({ replaced: true, defaultSet: true, relinked: 1, relinkRefused: 0, relinkFailed: 0, removed: 9, removeFailed: 0 })
    expect(line.fake.userRichMenu(lineUserId)).toBe(again.linkedId)
    expect(line.fake.defaultRichMenu()).toBe(again.unlinkedId)
    expect(atLine(org.linkedMenu)).toBeUndefined()
    expect(atLine(org.unlinkedMenu)).toBeUndefined()
    expect(await config(org.orgId)).toMatchObject({ richMenuLinkedId: again.linkedId, richMenuUnlinkedId: again.unlinkedId })
    expect(await lastSettingsEvent(org.orgId)).toMatchObject({ data: { section: 'lineRichMenu', replaced: true } })
  })

  it('takes down what a run that broke off left for this organization, and never the menus of another organization on the same LINE account', async () => {
    const [a, b] = [await lineOrg(), await lineOrg()]
    const stray = await menuNamed(`bcs:${a.channelKey}:LINKED:${Date.now() - MS_PER_MINUTE}`)
    const unstamped = await menuNamed(`bcs:${a.channelKey}:LINKED`)
    const again = ok(await replaceLineRichMenus(a.adminCtx, images, key()))
    // The nine of the first run, and the two a broken run left
    expect(again.removed).toBe(11)
    const left = line.fake.richMenus().map((m) => m.richMenuId)
    expect(left).not.toContain(stray)
    expect(left).not.toContain(unstamped)
    expect(left).toEqual(expect.arrayContaining([b.linkedMenu, b.unlinkedMenu, again.linkedId, again.unlinkedId]))
  })

  it('never takes down the menus of a run that started after it (two runs at once)', async () => {
    const org = await lineOrg()
    let later: string | null = null
    await withLine(
      async (input, init) => {
        // While this run looks for what to take down, another run has just made its menu and not stored it yet
        if (later === null && String(input).endsWith('/v2/bot/richmenu/list')) later = await menuNamed(`bcs:${org.channelKey}:LINKED:${Date.now() + MS_PER_MINUTE}`)
        return fetch(input, init)
      },
      async () => {
        ok(await replaceLineRichMenus(org.adminCtx, images, key()))
      },
    )
    expect(later).not.toBeNull()
    expect(atLine(later)).toBeDefined()
    expect(atLine(org.linkedMenu)).toBeUndefined()
  })

  it('refuses before anything is made at LINE: without admin.channels, a picture LINE would refuse, no channel, or no LIFF ID', async () => {
    const org = await lineOrg({ menus: false })
    const member = await person(org.orgId)
    const count = line.fake.richMenus().length
    expect(await replaceLineRichMenus(member.ctx(), images, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await replaceLineRichMenus(systemCtx(org.orgId, new Date()), images, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    const picture = (field: string, reason: string) => ({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field, reason } } })
    expect(await replaceLineRichMenus(org.adminCtx, { ...images, LINKED: pngHeader(2500, 1686) }, key())).toMatchObject(picture('images.LINKED', 'SIZE'))
    expect(await replaceLineRichMenus(org.adminCtx, { ...images, UNLINKED: new TextEncoder().encode('GIF89a not a png') }, key())).toMatchObject(picture('images.UNLINKED', 'FORMAT'))
    // LINE's "1 MB" read the strict way: one byte over 1,000,000 is refused (1,000,000 itself passes the size check)
    expect(await replaceLineRichMenus(org.adminCtx, { ...images, UNLINKED: new Uint8Array(1_000_001) }, key())).toMatchObject(picture('images.UNLINKED', 'TOO_LARGE'))
    expect(richMenuImageProblem(new Uint8Array(1_000_000))).toBe('FORMAT')
    const bare = await createOrg()
    const bareAdmin = await person(bare.id, ['ORG_ADMIN'])
    expect(await replaceLineRichMenus(bareAdmin.ctx(), images, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'channel', reason: 'NOT_CONFIGURED' } } })
    const noLiff = await lineOrg({ menus: false, liff: false })
    expect(await replaceLineRichMenus(noLiff.adminCtx, images, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'liffId', reason: 'REQUIRED' } } })
    expect(line.fake.richMenus()).toHaveLength(count)
    expect(await config(org.orgId)).toMatchObject({ richMenuLinkedId: null, richMenuUnlinkedId: null })
  })

  it('takes down what it made when LINE fails half way, and stores nothing (EXTERNAL_SERVICE_ERROR)', async () => {
    const org = await lineOrg({ menus: false })
    const before = line.fake.richMenus().map((m) => m.richMenuId)
    let uploads = 0
    await withLine(
      failing((url) => url.endsWith('/content') && ++uploads === 2),
      async () => {
        expect(await replaceLineRichMenus(org.adminCtx, images, key())).toMatchObject({
          ok: false,
          error: { code: 'EXTERNAL_SERVICE_ERROR', details: { service: 'LINE', operation: 'uploadRichMenuImage', reason: 'SERVER_ERROR', status: 500 } },
        })
      },
    )
    expect(line.fake.richMenus().map((m) => m.richMenuId)).toEqual(before)
    expect(await config(org.orgId)).toMatchObject({ richMenuLinkedId: null, richMenuUnlinkedId: null })
  })

  it('lets a save of the channel made meanwhile win: CONFLICT_VERSION, and the new menus are taken down', async () => {
    const org = await lineOrg({ menus: false })
    let saved = false
    await withLine(
      async (input, init) => {
        if (!saved && String(input).endsWith('/v2/bot/richmenu') && init?.method === 'POST') {
          saved = true
          const { version } = await config(org.orgId)
          ok(await saveLineChannelSettings(org.adminCtx, { ...CHANNEL, channelSecret: '', channelAccessToken: '', active: false, expectedVersion: version }, key()))
        }
        return fetch(input, init)
      },
      async () => {
        expect(await replaceLineRichMenus(org.adminCtx, images, key())).toMatchObject({ ok: false, error: { code: 'CONFLICT_VERSION' } })
      },
    )
    expect(saved).toBe(true)
    expect(line.fake.richMenus().filter((m) => String(m.menu.name).startsWith(`bcs:${org.channelKey}:`))).toEqual([])
    expect(await config(org.orgId)).toMatchObject({ richMenuLinkedId: null, richMenuUnlinkedId: null, active: false })
  })
})

describe('[FR-LINE-004/AC1] a linked member sees the LINKED menu again after LINE dropped it: blocking and unblocking the account, or linking before adding it', () => {
  it('sets it again when a linked member follows the account after blocking it, and welcomes them back', async () => {
    const org = await lineOrg()
    const member = await person(org.orgId)
    const { lineUserId } = await linkVia(member)
    expect(line.fake.userRichMenu(lineUserId)).toBe(org.linkedMenu)
    const t = Date.now()
    const unfollow = lineEvents.unfollow({ userId: lineUserId, timestamp: t - 2 * MS_PER_SECOND })
    expect(await deliver(org.channelKey, [unfollow])).toBe(200)
    expect(await eventually(() => webhookRow(org.orgId, unfollow), (r) => r.status !== 'RECEIVED')).toMatchObject({ status: 'PROCESSED' })
    await lineDropsMenuOf(lineUserId)
    // Linked, but LINE would show the default (UNLINKED) now
    expect(line.fake.userRichMenu(lineUserId)).toBeNull()
    const follow = lineEvents.follow({ userId: lineUserId, unblocked: true, timestamp: t - MS_PER_SECOND })
    expect(await deliver(org.channelKey, [follow])).toBe(200)
    expect(await eventually(async () => line.fake.userRichMenu(lineUserId), (menu) => menu !== null)).toBe(org.linkedMenu)
    expect(await webhookRow(org.orgId, follow)).toMatchObject({ status: 'PROCESSED' })
    expect(JSON.stringify(repliesTo(follow)[0]?.messages)).toContain('ยินดีต้อนรับกลับสู่ BCS')
    expect((await prisma.member.findUniqueOrThrow({ where: { id: member.memberId } })).lineReachable).toBe(true)
  })

  it('gives it with their follow to someone who linked in LIFF before adding the account, when LINE did not take the menu then; a follow of someone not linked sets no menu of their own', async () => {
    const org = await lineOrg()
    const member = await person(org.orgId)
    const lineUserId = newLineUserId()
    // LINE refuses (for good) to link a menu to this user while they are not a friend
    await withLine(failing(linksMenuTo(lineUserId), 400), async () => {
      await linkVia(member, lineUserId)
    })
    expect(line.fake.userRichMenu(lineUserId)).toBeNull()
    expect(await deliver(org.channelKey, [lineEvents.follow({ userId: lineUserId })])).toBe(200)
    expect(await eventually(async () => line.fake.userRichMenu(lineUserId), (menu) => menu !== null)).toBe(org.linkedMenu)

    const stranger = newLineUserId()
    const strangerFollow = lineEvents.follow({ userId: stranger })
    expect(await deliver(org.channelKey, [strangerFollow])).toBe(200)
    expect(await eventually(() => webhookRow(org.orgId, strangerFollow), (r) => r.status !== 'RECEIVED')).toMatchObject({ status: 'PROCESSED' })
    expect(line.fake.userRichMenu(stranger)).toBeNull()
    expect(line.fake.defaultRichMenu()).toBe(org.unlinkedMenu)
  })

  it('hands a follow whose menu LINE could not set for a while to the line-webhook job, which sets it; the member is answered at once all the same', async () => {
    const org = await lineOrg()
    const member = await person(org.orgId)
    const { lineUserId } = await linkVia(member)
    await lineDropsMenuOf(lineUserId)
    const follow = lineEvents.follow({ userId: lineUserId, unblocked: true })
    await withLine(failing(linksMenuTo(lineUserId), 500), async () => {
      expect(await deliver(org.channelKey, [follow])).toBe(200)
    })
    const row = await webhookRow(org.orgId, follow)
    expect(row.status).toBe('QUEUED')
    expect(line.fake.userRichMenu(lineUserId)).toBeNull()
    expect(repliesTo(follow)).toHaveLength(1)
    // LINE is back: the job's run sets it (and runs the follow again safely: the reply token was used already)
    expect(await processQueuedLineWebhookEvents(org.orgId, [row.id], new Date())).toMatchObject({ processed: 1, failed: 0 })
    expect(line.fake.userRichMenu(lineUserId)).toBe(org.linkedMenu)
    expect(repliesTo(follow)).toHaveLength(1)
  })

  it('leaves the menu alone when LINE sent a later unfollow: the follow is superseded and nothing is set', async () => {
    const org = await lineOrg()
    const member = await person(org.orgId)
    const { lineUserId } = await linkVia(member)
    await lineDropsMenuOf(lineUserId)
    const t = Date.now()
    const later = lineEvents.unfollow({ userId: lineUserId, timestamp: t })
    expect(await deliver(org.channelKey, [later])).toBe(200)
    const earlier = lineEvents.follow({ userId: lineUserId, unblocked: true, timestamp: t - MS_PER_SECOND })
    expect(await deliver(org.channelKey, [earlier])).toBe(200)
    expect(await eventually(() => webhookRow(org.orgId, earlier), (r) => r.status !== 'RECEIVED')).toMatchObject({ status: 'PROCESSED', error: 'SUPERSEDED' })
    expect(line.fake.userRichMenu(lineUserId)).toBeNull()
  })
})

describe('[FR-LINE-004/AC1] making the menus again while members link or unlink leaves everyone on the right menu', () => {
  it('moves a member whose link landed on the old LINKED menu after the replace had moved them, before the old one is taken down', async () => {
    const org = await lineOrg()
    const member = await person(org.orgId)
    const lineUserId = newLineUserId()
    const code = ok(await issueLineLinkCode(member.ctx()))
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    let held = false
    let linking: Promise<number> | null = null
    const report = await withLine(
      async (input, init) => {
        const url = String(input)
        // The link's own switch to the old LINKED menu reaches LINE late…
        if (!held && init?.method === 'POST' && url.endsWith(`/v2/bot/user/${lineUserId}/richmenu/${org.linkedMenu}`)) {
          held = true
          await released
        }
        // …after the replace stored the new pair and moved the member, just before it takes the old menus down
        if (url.endsWith('/v2/bot/richmenu/list') && linking) {
          release()
          await linking
        }
        return fetch(input, init)
      },
      async () => {
        linking = postLink({ code: code.code, idToken: idTokenFor(lineUserId) })
        await eventually(async () => held, (h) => h)
        const made = ok(await replaceLineRichMenus(org.adminCtx, images, key()))
        expect(await linking).toBe(200)
        return made
      },
    )
    expect(report).toMatchObject({ relinked: 1, relinkRefused: 0, relinkFailed: 0, removed: 9 })
    // The link read the stored menu again after LINE answered, and moved the member to the new one
    expect(line.fake.userRichMenu(lineUserId)).toBe(report.linkedId)
    expect(atLine(org.linkedMenu)).toBeUndefined()
  })

  it('ends an unlink made while the replace moves that member with the UNLINKED default, whichever reaches LINE last', async () => {
    const org = await lineOrg()
    const member = await person(org.orgId)
    const { lineUserId } = await linkVia(member)
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    let held = false
    const report = await withLine(
      async (input, init) => {
        const url = String(input)
        // The replace's move of this member to the new LINKED menu reaches LINE after the member unlinked
        if (!held && linksMenuTo(lineUserId)(url, init) && !url.endsWith(`/richmenu/${org.linkedMenu}`)) {
          held = true
          await released
        }
        return fetch(input, init)
      },
      async () => {
        const replacing = replaceLineRichMenus(org.adminCtx, images, key())
        await eventually(async () => held, (h) => h)
        ok(await unlinkMyLine(member.ctx(), {}, key()))
        expect(line.fake.userRichMenu(lineUserId)).toBeNull()
        release()
        return ok(await replacing)
      },
    )
    // The replace read the link again after LINE answered and took the menu back off
    expect(report).toMatchObject({ relinked: 0, relinkRefused: 0, relinkFailed: 0, removed: 9 })
    expect(line.fake.userRichMenu(lineUserId)).toBeNull()
    expect(line.fake.defaultRichMenu()).toBe(report.unlinkedId)
  })

  it('takes the old menus down although LINE refuses a member for good (e.g. one who blocked the account), and keeps them while LINE fails for a while', async () => {
    const org = await lineOrg()
    const [refused, fine] = [await person(org.orgId), await person(org.orgId)]
    const refusedLink = await linkVia(refused)
    const fineLink = await linkVia(fine)
    const forGood = await withLine(failing(linksMenuTo(refusedLink.lineUserId), 400), async () => ok(await replaceLineRichMenus(org.adminCtx, images, key())))
    expect(forGood).toMatchObject({ relinked: 1, relinkRefused: 1, relinkFailed: 0, removed: 9, removeFailed: 0 })
    expect(line.fake.userRichMenu(fineLink.lineUserId)).toBe(forGood.linkedId)
    expect(atLine(org.linkedMenu)).toBeUndefined()
    expect(describeLineRichMenuRun({ ok: true, organizationCode: org.code, report: forGood }).join('\n')).toContain('LINE ไม่รับ 1 คน')

    const forAWhile = await withLine(failing(linksMenuTo(refusedLink.lineUserId), 500), async () => ok(await replaceLineRichMenus(org.adminCtx, images, key())))
    expect(forAWhile).toMatchObject({ relinked: 1, relinkRefused: 0, relinkFailed: 1, removed: 0 })
    // The menus of the run before stay, so nobody falls back to UNLINKED meanwhile; the next run finishes the job
    expect(atLine(forGood.linkedId)).toBeDefined()
    expect(describeLineRichMenuRun({ ok: true, organizationCode: org.code, report: forAWhile }).join('\n')).toContain('รันอีกครั้ง')
    const after = ok(await replaceLineRichMenus(org.adminCtx, images, key()))
    expect(after).toMatchObject({ relinked: 2, relinkRefused: 0, relinkFailed: 0, removed: 18 })
    expect(line.fake.userRichMenu(refusedLink.lineUserId)).toBe(after.linkedId)
  })
})

describe('[FR-LINE-004/AC1] pnpm line:richmenu runs the same command for an organization’s channel (D-02), here against the fake LINE server', () => {
  it('makes the menus of the organization named by --org as its first active ORG_ADMIN, on channel SYSTEM, and prints no secret', async () => {
    const org = await lineOrg({ menus: false })
    const run = await runLineRichMenu({ org: org.code, appEnv: 'local', images })
    expect(run).toMatchObject({ ok: true, organizationCode: org.code, report: { replaced: false, defaultSet: true } })
    if (!run.ok) return
    expect(await config(org.orgId)).toMatchObject({ richMenuLinkedId: run.report.linkedId, richMenuUnlinkedId: run.report.unlinkedId })
    expect(line.fake.defaultRichMenu()).toBe(run.report.unlinkedId)
    expect(await lastSettingsEvent(org.orgId)).toMatchObject({ channel: 'SYSTEM', actorMemberId: org.admin.memberId, data: { section: 'lineRichMenu', replaced: false } })
    const printed = describeLineRichMenuRun(run).join('\n')
    expect(printed).toContain(org.code)
    expect(printed).toContain(run.report.linkedId)
    expect(printed).not.toContain(TEST_ACCESS_TOKEN)
    expect(printed).not.toContain(TEST_CHANNEL_SECRET)
  })

  it('runs on this machine only: outside APP_ENV=local it is refused before anything is read or made, and points to the button on /admin/line', async () => {
    const org = await lineOrg({ menus: false })
    const count = line.fake.richMenus().length
    for (const appEnv of ['staging', 'production']) {
      expect(await runLineRichMenu({ org: org.code, appEnv, images })).toEqual({ ok: false, problem: expect.stringContaining('/admin/line') })
    }
    expect(line.fake.richMenus()).toHaveLength(count)
    expect(await config(org.orgId)).toMatchObject({ richMenuLinkedId: null, richMenuUnlinkedId: null })
    expect(await lastSettingsEvent(org.orgId)).toMatchObject({ data: { section: 'lineChannel' } })
  })

  it('needs --org when several organizations have LINE, and an organization with LINE and an active ORG_ADMIN', async () => {
    const org = await lineOrg({ menus: false })
    const noAdmin = await lineOrg({ menus: false })
    await prisma.roleAssignment.updateMany({ where: { organizationId: noAdmin.orgId, role: 'ORG_ADMIN' }, data: { revokedAt: new Date() } })
    expect(await runLineRichMenu({ org: null, appEnv: 'local', images })).toEqual({ ok: false, problem: expect.stringContaining('--org') })
    expect(await runLineRichMenu({ org: `NONE-${randomUUID().slice(0, 8)}`, appEnv: 'local', images })).toMatchObject({ ok: false })
    expect(await runLineRichMenu({ org: noAdmin.code, appEnv: 'local', images })).toEqual({ ok: false, problem: expect.stringContaining('ORG_ADMIN') })
    expect(await config(org.orgId)).toMatchObject({ richMenuLinkedId: null })
  })
})

describe('[FR-LINE-004/AC3] the menu changes within a minute of a link or an unlink', () => {
  it('switches in the link and the unlink requests themselves, well within a minute', async () => {
    const org = await lineOrg()
    const member = await person(org.orgId)
    const lineUserId = newLineUserId()
    const code = ok(await issueLineLinkCode(member.ctx()))
    const linkStarted = performance.now()
    expect(await postLink({ code: code.code, idToken: idTokenFor(lineUserId) })).toBe(200)
    expect(line.fake.userRichMenu(lineUserId)).toBe(org.linkedMenu)
    expect(performance.now() - linkStarted).toBeLessThan(MS_PER_MINUTE)
    const unlinkStarted = performance.now()
    ok(await unlinkMyLine(member.ctx(), {}, key()))
    expect(line.fake.userRichMenu(lineUserId)).toBeNull()
    expect(performance.now() - unlinkStarted).toBeLessThan(MS_PER_MINUTE)
  })

  it('when LINE fails at that moment, job line-rich-menu switches it: the outbox hands it line.linked at once, and a failure LINE may get over is thrown for Inngest to retry', async () => {
    const org = await lineOrg()
    const member = await person(org.orgId)
    const lineUserId = newLineUserId()
    const code = ok(await issueLineLinkCode(member.ctx()))
    const sentBefore = toInngest.length
    const message = await withLine(
      failing((url, init) => init?.method === 'POST' && /\/v2\/bot\/user\/U[^/]+\/richmenu\/richmenu-/.test(url)),
      async () => {
        expect(await postLink({ code: code.code, idToken: idTokenFor(lineUserId) })).toBe(200)
        expect(line.fake.userRichMenu(lineUserId)).toBeNull()
        const identity = await prisma.channelIdentity.findFirstOrThrow({ where: { memberId: member.memberId, unlinkedAt: null } })
        // Handed to Inngest during the request, right after the commit
        const handed = toInngest.slice(sentBefore).find((m) => m.name === 'bcs/line.linked' && (m.data as { aggregateId?: string }).aggregateId === identity.id)
        expect(handed).toBeDefined()
        await expect(lineRichMenuRun({ data: handed!.data }, jobStep)).rejects.toThrow(/linkRichMenu/)
        return handed!
      },
    )
    // LINE is back: Inngest's retry switches it
    expect(await lineRichMenuRun({ data: message.data }, jobStep)).toEqual({ status: 'APPLIED', menu: 'LINKED', variant: 'LINKED' })
    expect(line.fake.userRichMenu(lineUserId)).toBe(org.linkedMenu)
    expect(await lineRichMenuRun({ data: { something: 'else' } }, jobStep)).toEqual({ ignored: 'NOT_A_MENU_EVENT' })
  })

  it('a late run never undoes a later change: it sets the menu of the link as it is now', async () => {
    const org = await lineOrg()
    const member = await person(org.orgId)
    const { lineUserId, identityId } = await linkVia(member)
    const linked = toInngest.find((m) => m.name === 'bcs/line.linked' && (m.data as { aggregateId?: string }).aggregateId === identityId)
    ok(await unlinkMyLine(member.ctx(), {}, key()))
    expect(await lineRichMenuRun({ data: linked!.data }, jobStep)).toEqual({ status: 'APPLIED', menu: 'UNLINKED', variant: 'UNLINKED' })
    expect(line.fake.userRichMenu(lineUserId)).toBeNull()
  })

  it('two switches racing for one user end with the menu of the last state', async () => {
    const org = await lineOrg()
    const member = await person(org.orgId)
    const { lineUserId, identityId } = await linkVia(member)
    ok(await unlinkMyLine(member.ctx(), {}, key()))
    // Linked again; a switch to LINKED reaches LINE only after the unlink below and its own switch are over
    const relinked = await linkVia(member, lineUserId)
    let open!: () => void
    const opened = new Promise<void>((resolve) => (open = resolve))
    let held = false
    await withLine(
      async (input, init) => {
        if (!held && init?.method === 'POST' && /\/v2\/bot\/user\/U[^/]+\/richmenu\/richmenu-/.test(String(input))) {
          held = true
          await opened
        }
        return fetch(input, init)
      },
      async () => {
        const racing = runLineRichMenuSync(org.orgId, relinked.identityId)
        await eventually(async () => held, (h) => h)
        ok(await unlinkMyLine(member.ctx(), {}, key()))
        expect(line.fake.userRichMenu(lineUserId)).toBeNull()
        open()
        // Its LINKED landed after the unlink; it reads the link again and puts UNLINKED back
        expect(await racing).toEqual({ status: 'APPLIED', menu: 'UNLINKED', variant: 'UNLINKED' })
      },
    )
    expect(line.fake.userRichMenu(lineUserId)).toBeNull()
    expect(identityId).not.toBe(relinked.identityId)
  })

  it('skips a link under another provider and a channel without menus yet; LINE refusing for good ends the run without a retry', async () => {
    const org = await lineOrg()
    const member = await person(org.orgId)
    const old = await prisma.channelIdentity.create({
      data: { organizationId: org.orgId, memberId: member.memberId, channel: 'LINE', providerKey: 'provider-before', externalUserId: newLineUserId(), linkedAt: new Date(), unlinkedAt: new Date() },
    })
    expect(await runLineRichMenuSync(org.orgId, old.id)).toEqual({ status: 'SKIPPED', reason: 'OTHER_PROVIDER' })
    expect(await runLineRichMenuSync(org.orgId, randomUUID())).toEqual({ status: 'SKIPPED', reason: 'NO_IDENTITY' })
    // No menus yet: the link works, and the switch waits for pnpm line:richmenu
    const bare = await lineOrg({ menus: false })
    const early = await linkVia(await person(bare.orgId))
    expect(await runLineRichMenuSync(bare.orgId, early.identityId)).toEqual({ status: 'SKIPPED', reason: 'NO_LINKED_MENU' })
    // LINE refuses for good (400): FAILED, not thrown
    await withLine(
      failing((url) => url.includes('/v2/bot/user/U'), 400),
      async () => {
        const linked = await linkVia(member)
        expect(await runLineRichMenuSync(org.orgId, linked.identityId)).toEqual({ status: 'FAILED', reason: 'BAD_REQUEST' })
      },
    )
  })
})
