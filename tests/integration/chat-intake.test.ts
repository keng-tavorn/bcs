import { randomUUID } from 'node:crypto'
import { Writable } from 'node:stream'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { headObject } from '@/integrations/storage'
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE } from '@/lib/constants'
import { createLogger, logger } from '@/lib/logger'
import { makeCtx, systemCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { getDefaultOutboxSender, setDefaultOutboxSender, type OutboxMessage, type OutboxSender } from '@/server/events/outbox'
import { chatIntakeImageRun } from '@/server/jobs/chat-intake-image'
import { processQueuedLineWebhookEvents, receiveLineWebhook } from '@/server/jobs/line-webhook'
import { runCommand } from '@/server/services/_pipeline'
import { chatSweepOrganizationIds, expireChatIntakesCommand, fetchChatImage, giveUpChatImages, purgeChatIntakesCommand, receiveChatMessage, runChatIntakeSweep, storeChatImageCommand } from '@/server/services/chat-intake'
import { saveLineChannelSettings } from '@/server/services/line-channel'
import { buildLineWebhook, lineEvents, newLineUserId, redelivered, signLineWebhook, type LineWebhookEventJson } from '../../scripts/line-simulate'
import { createMember, createOrg } from '../support/factory'
import { TEST_ACCESS_TOKEN, TEST_CHANNEL_SECRET, withFakeLine } from '../support/fake-line'

// S17-06 · asking through the LINE chat, the chat side (FR-LINE-301 AC1 AC2 AC3 AC7 · BR-LINE-10, BR-LINE-11, BR-LINE-14,
// BR-LINE-15 · golden chat-intake for the routing itself). Messages come as LINE signs them (pnpm line:simulate's builders)
// through the webhook's own entry; LINE is the fake LINE server of the repo, which also holds the content of the images.
// The database and the bucket are real.

const NOW = new Date('2026-10-20T02:00:00Z')
const at = (ms: number) => new Date(NOW.getTime() + ms)
const PROVIDER = '1650000001'
const LIFF_ID = '1650000003-AbCdEfGh'
const CHANNEL = { providerId: PROVIDER, messagingChannelId: '1650000002', channelSecret: TEST_CHANNEL_SECRET, channelAccessToken: TEST_ACCESS_TOKEN, liffId: LIFF_ID, liffChannelId: '1650000003' }
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, 4])
const GIF = new TextEncoder().encode('GIF89a-not-a-photo-we-take')
const step = { run: <T,>(_id: string, fn: () => Promise<T>) => fn() }

const line = withFakeLine()

const toInngest: OutboxMessage[] = []
let inngestBefore: OutboxSender | null = null
beforeAll(() => {
  inngestBefore = getDefaultOutboxSender()
  setDefaultOutboxSender(async (messages) => {
    toInngest.push(...messages)
  })
})
afterAll(() => setDefaultOutboxSender(inngestBefore))
afterEach(() => vi.restoreAllMocks())

interface ChatOrg {
  readonly orgId: string
  readonly channelKey: string
}

/** An organization with its LINE channel, asking through the chat with these settings (enabled unless said otherwise) */
async function chatOrg(chatIntake: Record<string, unknown> = {}, kind: 'PRODUCTION' | 'SANDBOX' = 'PRODUCTION'): Promise<ChatOrg> {
  const org = await createOrg()
  const admin = await createMember(org.id, 'ผู้ดูแล')
  await prisma.roleAssignment.create({ data: { organizationId: org.id, memberId: admin.id, role: 'ORG_ADMIN', grantedAt: NOW } })
  const ctx = makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId: admin.id }, channel: 'WEB', now: NOW })
  const saved = await saveLineChannelSettings(ctx, { ...CHANNEL, active: true }, { idempotencyKey: randomUUID(), sender: null })
  if (!saved.ok) throw new Error(`channel not saved: ${saved.error.code}`)
  const sandboxOf = kind === 'SANDBOX' ? { sandboxOfOrganizationId: (await createOrg()).id } : {}
  await prisma.organization.update({ where: { id: org.id }, data: { kind, ...sandboxOf, settings: { chatIntake: { enabled: true, ...chatIntake } } } })
  return { orgId: org.id, channelKey: saved.data.channelKey }
}

async function linkedMember(orgId: string) {
  const member = await createMember(orgId, 'ผู้ขอทดสอบ')
  const lineUserId = newLineUserId()
  await prisma.channelIdentity.create({ data: { organizationId: orgId, memberId: member.id, channel: 'LINE', providerKey: PROVIDER, externalUserId: lineUserId, linkedAt: NOW } })
  return { memberId: member.id, lineUserId }
}

/** The event as LINE delivers it, processed inline (budgetMs 0: recorded now, processed by the job at `jobAt`) */
async function send(org: ChatOrg, event: LineWebhookEventJson, when: Date, options: { readonly jobAt?: Date } = {}) {
  const { body } = buildLineWebhook([event])
  const answer = await receiveLineWebhook(
    { channelKey: org.channelKey, rawBody: new TextEncoder().encode(body), signature: signLineWebhook(TEST_CHANNEL_SECRET, body) },
    { now: when, budgetMs: options.jobAt ? 0 : 30_000, sender: null },
  )
  const row = await prisma.lineWebhookEvent.findUniqueOrThrow({ where: { organizationId_webhookEventId: { organizationId: org.orgId, webhookEventId: event.webhookEventId } } })
  if (options.jobAt) await processQueuedLineWebhookEvents(org.orgId, [row.id], options.jobAt)
  const after = await prisma.lineWebhookEvent.findUniqueOrThrow({ where: { id: row.id } })
  const replies = line.fake.messages().filter((m) => m.kind === 'reply' && m.replyToken === event.replyToken)
  const pushes = line.fake.messages().filter((m) => m.kind === 'push' && m.retryKey === row.id)
  return { answer, row: after, replies, pushes }
}

const text = (lineUserId: string, words: string, when: Date, extra: Partial<Parameters<typeof lineEvents.message>[0]> = {}) => lineEvents.message({ userId: lineUserId, text: words, timestamp: when.getTime(), ...extra })
const intakesOf = (orgId: string, memberId: string) => prisma.chatIntake.findMany({ where: { organizationId: orgId, memberId }, orderBy: { openedAt: 'asc' }, include: { items: { orderBy: { seq: 'asc' } } } })
const eventsOf = (orgId: string, type: string) => prisma.event.findMany({ where: { organizationId: orgId, type }, orderBy: { seq: 'asc' } })
const uriOf = (message: Record<string, unknown>) => ((message.template as { actions?: Array<{ uri?: string }> } | undefined)?.actions ?? [])[0]?.uri
const intakeLink = (intakeId: string) => `https://liff.line.me/${LIFF_ID}/requests/new?intake=${intakeId}`

describe('[FR-LINE-301/AC1] a linked member writes: a draft from the chat, answered by reply with the button that opens LIFF', () => {
  it('a text opens a draft and keeps the text there only; the reply has the button and none of what was typed', async () => {
    const org = await chatOrg()
    const m = await linkedMember(org.orgId)
    const typed = 'ขอซื้อกระดาษ A4 จำนวน 5 รีม\nส่งที่ฝ่ายบัญชี'
    const sent = await send(org, text(m.lineUserId, typed, NOW), NOW)

    const [intake] = await intakesOf(org.orgId, m.memberId)
    expect(intake).toMatchObject({ status: 'OPEN', text: typed, textTruncated: false, messageCount: 1, imageCount: 0 })
    expect(intake!.linkSentAt).not.toBeNull()
    expect(intake!.items).toMatchObject([{ seq: 1, kind: 'TEXT', fetchStatus: 'NOT_NEEDED', fileId: null }])
    // BR-LINE-11: the text waited in LineInboundMessage only until it was taken, and never in the webhook event
    expect(await prisma.lineInboundMessage.count({ where: { organizationId: org.orgId } })).toBe(0)
    expect(JSON.stringify(sent.row.payload)).not.toContain('กระดาษ')
    expect(sent.row.status).toBe('PROCESSED')

    expect(sent.replies).toHaveLength(1)
    const [reply] = sent.replies[0]!.messages
    expect(uriOf(reply!)).toBe(intakeLink(intake!.id))
    expect(JSON.stringify(sent.replies[0]!.messages)).not.toMatch(/กระดาษ|รีม|บัญชี/)
    expect((await eventsOf(org.orgId, 'chat_intake.opened')).map((e) => ({ aggregateId: e.aggregateId, data: e.data, channel: e.channel, actorMemberId: e.actorMemberId }))).toEqual([
      { aggregateId: intake!.id, data: { kind: 'TEXT' }, channel: 'LINE_CHAT', actorMemberId: m.memberId },
    ])
  })

  it('a message within windowMinutes joins the same draft, on a new line, and the reply says it was added', async () => {
    const org = await chatOrg()
    const m = await linkedMember(org.orgId)
    await send(org, text(m.lineUserId, 'กระดาษ A4', NOW), NOW)
    const second = await send(org, text(m.lineUserId, 'อีก 2 กล่อง', at(5 * MS_PER_MINUTE)), at(5 * MS_PER_MINUTE))
    const intakes = await intakesOf(org.orgId, m.memberId)
    expect(intakes).toHaveLength(1)
    expect(intakes[0]).toMatchObject({ text: 'กระดาษ A4\nอีก 2 กล่อง', messageCount: 2 })
    expect(intakes[0]!.items.map((i) => i.seq)).toEqual([1, 2])
    expect(JSON.stringify(second.replies[0]!.messages)).toContain('เพิ่มในคำขอที่กำลังร่างแล้ว')
    expect(uriOf(second.replies[0]!.messages[0]!)).toBe(intakeLink(intakes[0]!.id))
    expect((await eventsOf(org.orgId, 'chat_intake.message_added')).map((e) => e.data)).toEqual([{ seq: 2, kind: 'TEXT' }])
  })

  it('the reply token expired before the job ran: the button is pushed once per draft, never again for that draft', async () => {
    const org = await chatOrg()
    const m = await linkedMember(org.orgId)
    const late = await send(org, text(m.lineUserId, 'เก้าอี้สำนักงาน', NOW), NOW, { jobAt: at(2 * MS_PER_MINUTE) })
    const [intake] = await intakesOf(org.orgId, m.memberId)
    expect(late.replies).toHaveLength(0)
    expect(late.pushes).toHaveLength(1)
    expect(late.pushes[0]).toMatchObject({ to: m.lineUserId, retryKey: late.row.id })
    expect(uriOf(late.pushes[0]!.messages[0]!)).toBe(intakeLink(intake!.id))

    // The same draft: its button went out already, so a second late message is not pushed (BR-LINE-15)
    const again = await send(org, text(m.lineUserId, 'อีก 1 ตัว', at(3 * MS_PER_MINUTE)), at(3 * MS_PER_MINUTE), { jobAt: at(5 * MS_PER_MINUTE) })
    expect(again.pushes).toHaveLength(0)
    expect(again.replies).toHaveLength(0)
    expect(again.row).toMatchObject({ status: 'PROCESSED', error: null })
    expect(await intakesOf(org.orgId, m.memberId)).toHaveLength(1)

    // A sticker late: hints are never pushed
    const sticker = await send(org, lineEvents.sticker({ userId: m.lineUserId, timestamp: at(6 * MS_PER_MINUTE).getTime() }), at(6 * MS_PER_MINUTE), { jobAt: at(9 * MS_PER_MINUTE) })
    expect(sticker.pushes).toHaveLength(0)
  })

  it('a reply LINE refuses: the button of a draft that never had it is pushed instead', async () => {
    const org = await chatOrg()
    const m = await linkedMember(org.orgId)
    const refused = await send(org, text(m.lineUserId, 'หมึกพิมพ์', NOW, { replyToken: `expired${randomUUID().replace(/-/g, '')}` }), NOW)
    expect(refused.replies).toHaveLength(0)
    expect(refused.pushes).toHaveLength(1)
    expect(refused.row).toMatchObject({ status: 'PROCESSED', error: 'PUSHED' })
  })
})

describe('[FR-LINE-301/AC2] the window, the limits, other types, unlinked users, groups and standby follow golden chat-intake; a redelivered webhook adds nothing', () => {
  it('LINE delivers the same event again: one message, one item, one answer (BR-LINE-04, INV-PLT-01)', async () => {
    const org = await chatOrg()
    const m = await linkedMember(org.orgId)
    const event = text(m.lineUserId, 'ปากกา', NOW)
    const first = await send(org, event, NOW)
    await send(org, redelivered(event), at(MS_PER_MINUTE))
    const intakes = await intakesOf(org.orgId, m.memberId)
    expect(intakes).toHaveLength(1)
    expect(intakes[0]).toMatchObject({ messageCount: 1, text: 'ปากกา' })
    expect(intakes[0]!.items).toHaveLength(1)
    expect(first.replies).toHaveLength(1)
    expect(await prisma.lineWebhookEvent.count({ where: { organizationId: org.orgId } })).toBe(1)

    // The command run again for the event (the line-webhook job's retry) replays its answer and adds nothing
    const ctx = makeCtx({ organizationId: org.orgId, actor: { type: 'USER', memberId: m.memberId }, channel: 'LINE_CHAT', now: at(2 * MS_PER_MINUTE) })
    const replay = await receiveChatMessage(ctx, { lineWebhookEventId: first.row.id }, { idempotencyKey: `line-message:${event.webhookEventId}` })
    expect(replay).toMatchObject({ ok: true, data: { action: 'OPEN_NEW', intakeId: intakes[0]!.id } })
    expect(await prisma.chatIntakeItem.count({ where: { organizationId: org.orgId } })).toBe(1)
  })

  it('after windowMinutes a message opens a new draft; the old one stays open until it expires', async () => {
    const org = await chatOrg()
    const m = await linkedMember(org.orgId)
    await send(org, text(m.lineUserId, 'ครั้งแรก', NOW), NOW)
    await send(org, text(m.lineUserId, 'ครั้งที่สอง', at(30 * MS_PER_MINUTE)), at(30 * MS_PER_MINUTE))
    const intakes = await intakesOf(org.orgId, m.memberId)
    expect(intakes.map((i) => [i.status, i.text])).toEqual([
      ['OPEN', 'ครั้งแรก'],
      ['OPEN', 'ครั้งที่สอง'],
    ])
  })

  it('another type gets the hint; an unlinked user is asked to link and nothing they wrote is kept; a group and standby get nothing', async () => {
    const org = await chatOrg()
    const m = await linkedMember(org.orgId)
    const sticker = await send(org, lineEvents.sticker({ userId: m.lineUserId, timestamp: NOW.getTime() }), NOW)
    expect(JSON.stringify(sticker.replies[0]!.messages)).toContain('ข้อความหรือรูปถ่าย')
    expect((await eventsOf(org.orgId, 'chat_intake.message_refused')).map((e) => [e.aggregateId, e.data])).toEqual([[m.memberId, { reason: 'UNSUPPORTED', notified: true }]])
    expect(await intakesOf(org.orgId, m.memberId)).toHaveLength(0)

    const stranger = newLineUserId()
    const unlinked = await send(org, text(stranger, 'ขอซื้อโต๊ะ', NOW), NOW)
    expect(unlinked.row).toMatchObject({ status: 'PROCESSED', error: 'NOT_LINKED' })
    expect(uriOf(unlinked.replies[0]!.messages[0]!)).toBe(`https://liff.line.me/${LIFF_ID}/link`)
    expect(await prisma.lineInboundMessage.count({ where: { organizationId: org.orgId } })).toBe(0)
    expect(await prisma.chatIntake.count({ where: { organizationId: org.orgId } })).toBe(0)

    const group = await send(org, text(m.lineUserId, 'ในกลุ่ม', NOW, { groupId: `C${'1'.repeat(32)}` }), NOW)
    const standby = await send(org, text(m.lineUserId, 'standby', NOW, { mode: 'standby' }), NOW)
    for (const quiet of [group, standby]) {
      expect(quiet.row.status).toBe('SKIPPED')
      expect(quiet.replies).toHaveLength(0)
    }
    expect(await prisma.lineInboundMessage.count({ where: { organizationId: org.orgId } })).toBe(0)
    expect(await intakesOf(org.orgId, m.memberId)).toHaveLength(0)
  })

  it('more than hourlyLimit messages an hour: the next ones are not taken, and the notice goes once', async () => {
    const org = await chatOrg({ hourlyLimit: 2 })
    const m = await linkedMember(org.orgId)
    for (let i = 0; i < 2; i++) await send(org, text(m.lineUserId, `ข้อ ${i}`, at(i * MS_PER_MINUTE)), at(i * MS_PER_MINUTE))
    const third = await send(org, text(m.lineUserId, 'ข้อ 2', at(2 * MS_PER_MINUTE)), at(2 * MS_PER_MINUTE))
    const fourth = await send(org, text(m.lineUserId, 'ข้อ 3', at(3 * MS_PER_MINUTE)), at(3 * MS_PER_MINUTE))
    expect(JSON.stringify(third.replies[0]!.messages)).toContain('ส่งข้อความถี่เกินไป')
    expect(fourth.replies).toHaveLength(0)
    expect((await intakesOf(org.orgId, m.memberId))[0]).toMatchObject({ messageCount: 2, text: 'ข้อ 0\nข้อ 1' })
    expect((await eventsOf(org.orgId, 'chat_intake.message_refused')).map((e) => e.data)).toEqual([
      { reason: 'RATE_LIMITED', notified: true },
      { reason: 'RATE_LIMITED', notified: false },
    ])
    expect(await prisma.lineInboundMessage.count({ where: { organizationId: org.orgId } })).toBe(0)
  })

  it('an image over maxImages is not added and the member is told to attach it in LIFF; text over maxTextChars is cut at a whole character', async () => {
    const org = await chatOrg({ maxImages: 1, maxTextChars: 11 })
    const m = await linkedMember(org.orgId)
    await send(org, lineEvents.image({ userId: m.lineUserId, timestamp: NOW.getTime() }), NOW)
    const extra = await send(org, lineEvents.image({ userId: m.lineUserId, timestamp: at(MS_PER_MINUTE).getTime() }), at(MS_PER_MINUTE))
    const [intake] = await intakesOf(org.orgId, m.memberId)
    expect(intake).toMatchObject({ imageCount: 1, messageCount: 1 })
    expect(JSON.stringify(extra.replies[0]!.messages)).toContain('แนบรูปเพิ่มได้ในหน้าคำขอ')
    expect(uriOf(extra.replies[0]!.messages[0]!)).toBe(intakeLink(intake!.id))

    // 11 code points: "น้ำดื่ม " is 8 and "น้ำ" 3 more; the next character would be the 12th
    await send(org, text(m.lineUserId, 'น้ำดื่ม น้ำแข็ง น้ำมัน', at(2 * MS_PER_MINUTE)), at(2 * MS_PER_MINUTE))
    const [cut] = await intakesOf(org.orgId, m.memberId)
    expect(cut).toMatchObject({ text: 'น้ำดื่ม น้ำ', textTruncated: true, messageCount: 2 })
  })

  it('an organization that does not ask through the chat (or a UAT sandbox) skips messages as before S17 and keeps no text', async () => {
    for (const org of [await chatOrg({ enabled: false }), await chatOrg({}, 'SANDBOX')]) {
      const m = await linkedMember(org.orgId)
      const sent = await send(org, text(m.lineUserId, 'ไม่ควรถูกเก็บ', NOW), NOW)
      expect(sent.row).toMatchObject({ status: 'SKIPPED', error: 'NOT_HANDLED' })
      expect(sent.replies).toHaveLength(0)
      expect(await prisma.lineInboundMessage.count({ where: { organizationId: org.orgId } })).toBe(0)
      expect(await prisma.chatIntake.count({ where: { organizationId: org.orgId } })).toBe(0)
    }
  })
})

describe('[FR-LINE-301/AC3] a photo is fetched from LINE in the job, checked and kept as the sender’s file; one that cannot be is FAILED and the draft goes on', () => {
  it('a PNG is stored under the draft as a file of the sender', async () => {
    const org = await chatOrg()
    const m = await linkedMember(org.orgId)
    const image = lineEvents.image({ userId: m.lineUserId, timestamp: NOW.getTime() })
    line.fake.putContent((image.message as { id: string }).id, 'image/png', PNG)
    await send(org, image, NOW)
    const [intake] = await intakesOf(org.orgId, m.memberId)
    expect(intake!.items[0]).toMatchObject({ kind: 'IMAGE', fetchStatus: 'PENDING' })
    // The webhook fetched nothing: the job does (the outbox handed it chat_intake.opened with kind IMAGE)
    expect(toInngest.some((e) => e.name === 'bcs/chat_intake.opened' && (e.data as { aggregateId: string }).aggregateId === intake!.id)).toBe(true)

    const run = await chatIntakeImageRun({ data: { organizationId: org.orgId, aggregateId: intake!.id } }, step)
    expect(run).toMatchObject({ images: [{ status: 'STORED' }] })
    const item = await prisma.chatIntakeItem.findFirstOrThrow({ where: { intakeId: intake!.id }, include: { file: true } })
    expect(item).toMatchObject({ fetchStatus: 'STORED', fetchError: null })
    expect(item.file).toMatchObject({ uploadedById: m.memberId, mimeType: 'image/png', sizeBytes: PNG.length, status: 'AVAILABLE', fileName: 'chat-1.png' })
    expect(item.file!.storageKey.startsWith(`org/${org.orgId}/chat-intake/${intake!.id}/`)).toBe(true)
    expect(await headObject(item.file!.storageKey)).toMatchObject({ sizeBytes: PNG.length })
    expect((await eventsOf(org.orgId, 'chat_intake.image_fetched')).map((e) => e.data)).toEqual([{ seq: 1, status: 'STORED', fileId: item.fileId }])
    // A second run finds nothing to fetch
    expect(await chatIntakeImageRun({ data: { organizationId: org.orgId, aggregateId: intake!.id } }, step)).toEqual({ images: [] })
  })

  it('gone from LINE (404) is FAILED GONE, another type is FAILED TYPE_NOT_ALLOWED, and the draft still takes text', async () => {
    const org = await chatOrg()
    const m = await linkedMember(org.orgId)
    await send(org, lineEvents.image({ userId: m.lineUserId, timestamp: NOW.getTime() }), NOW)
    const gif = lineEvents.image({ userId: m.lineUserId, timestamp: at(MS_PER_MINUTE).getTime() })
    line.fake.putContent((gif.message as { id: string }).id, 'image/gif', GIF)
    await send(org, gif, at(MS_PER_MINUTE))
    const [intake] = await intakesOf(org.orgId, m.memberId)
    await chatIntakeImageRun({ data: { organizationId: org.orgId, aggregateId: intake!.id } }, step)
    const items = await prisma.chatIntakeItem.findMany({ where: { intakeId: intake!.id }, orderBy: { seq: 'asc' } })
    expect(items.map((i) => [i.fetchStatus, i.fetchError, i.fileId])).toEqual([
      ['FAILED', 'GONE', null],
      ['FAILED', 'TYPE_NOT_ALLOWED', null],
    ])
    expect(await prisma.fileObject.count({ where: { organizationId: org.orgId, storageKey: { startsWith: `org/${org.orgId}/chat-intake/` } } })).toBe(0)
    await send(org, text(m.lineUserId, 'รูปไม่ขึ้น พิมพ์แทน', at(2 * MS_PER_MINUTE)), at(2 * MS_PER_MINUTE))
    expect((await intakesOf(org.orgId, m.memberId))[0]).toMatchObject({ status: 'OPEN', messageCount: 3, imageCount: 2, text: 'รูปไม่ขึ้น พิมพ์แทน' })
  })

  it('a photo nobody could fetch (the job gave up) becomes FAILED TIMEOUT in the sweep; only the system records images', async () => {
    const org = await chatOrg()
    const m = await linkedMember(org.orgId)
    await send(org, lineEvents.image({ userId: m.lineUserId, timestamp: NOW.getTime() }), NOW)
    const [intake] = await intakesOf(org.orgId, m.memberId)
    const itemId = intake!.items[0]!.id
    const asMember = makeCtx({ organizationId: org.orgId, actor: { type: 'USER', memberId: m.memberId }, channel: 'LIFF', now: NOW })
    expect(await runCommand(asMember, storeChatImageCommand, { itemId, status: 'FAILED', code: 'GONE' }, { idempotencyKey: randomUUID() })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await giveUpChatImages(org.orgId, at(5 * MS_PER_HOUR))).toBe(0)
    expect(await giveUpChatImages(org.orgId, at(7 * MS_PER_HOUR))).toBe(1)
    expect(await prisma.chatIntakeItem.findUniqueOrThrow({ where: { id: itemId } })).toMatchObject({ fetchStatus: 'FAILED', fetchError: 'TIMEOUT' })
  })
})

/** The JSON lines the app logs while `run` runs (the app's serializers and redaction) */
async function logsOf(run: () => Promise<unknown>): Promise<string> {
  const lines: string[] = []
  const sink = createLogger(new Writable({ write: (chunk, _e, done) => (lines.push(String(chunk)), done()) }), 'trace')
  vi.spyOn(logger, 'child').mockImplementation(((b, o) => sink.child(b, o)) as typeof logger.child)
  for (const level of ['info', 'warn', 'error', 'debug'] as const) vi.spyOn(logger, level).mockImplementation(((...a: unknown[]) => (sink[level] as (...x: unknown[]) => void)(...a)) as never)
  logger.info({ probe: true }, 'log capture probe')
  await run()
  vi.restoreAllMocks()
  return lines.join('\n')
}

describe('[FR-LINE-301/AC7] a draft nobody used expires, its text and unused photos are cleared after the retention, only its owner’s messages reach it, and logs never carry what was typed', () => {
  it('expireHours idle → EXPIRED; textRetentionDays after it opened → text and unused photos cleared; text nobody processed goes after 24 hours', async () => {
    const org = await chatOrg()
    const m = await linkedMember(org.orgId)
    const image = lineEvents.image({ userId: m.lineUserId, timestamp: NOW.getTime() })
    line.fake.putContent((image.message as { id: string }).id, 'image/png', PNG)
    await send(org, image, NOW)
    await send(org, text(m.lineUserId, 'ขอซื้อโน้ตบุ๊ก', at(MS_PER_MINUTE)), at(MS_PER_MINUTE))
    const [intake] = await intakesOf(org.orgId, m.memberId)
    await chatIntakeImageRun({ data: { organizationId: org.orgId, aggregateId: intake!.id } }, step)
    const file = (await prisma.chatIntakeItem.findFirstOrThrow({ where: { intakeId: intake!.id, kind: 'IMAGE' }, include: { file: true } })).file!
    // Text of a message nobody processed (BR-LINE-11): kept at most 24 hours
    const orphan = await prisma.lineWebhookEvent.create({ data: { organizationId: org.orgId, webhookEventId: `01TEST${randomUUID()}`, channelKey: org.channelKey, type: 'message', receivedAt: NOW } })
    await prisma.lineInboundMessage.create({ data: { organizationId: org.orgId, lineWebhookEventId: orphan.id, lineMessageId: '1234', kind: 'TEXT', text: 'ค้างอยู่', receivedAt: NOW } })

    const lastMessage = at(MS_PER_MINUTE)
    expect(await runChatIntakeSweep(org.orgId, new Date(lastMessage.getTime() + 24 * MS_PER_HOUR - 1))).toMatchObject({ expired: 0, textsDeleted: 1 })
    expect(await prisma.lineInboundMessage.count({ where: { organizationId: org.orgId } })).toBe(0)
    expect(await runChatIntakeSweep(org.orgId, new Date(lastMessage.getTime() + 24 * MS_PER_HOUR))).toMatchObject({ expired: 1, purged: 0, textsDeleted: 0 })
    expect(await prisma.chatIntake.findUniqueOrThrow({ where: { id: intake!.id } })).toMatchObject({ status: 'EXPIRED', text: 'ขอซื้อโน้ตบุ๊ก', purgedAt: null })
    expect((await eventsOf(org.orgId, 'chat_intake.expired')).map((e) => [e.aggregateId, e.data, e.channel])).toEqual([[intake!.id, { reason: 'IDLE' }, 'SYSTEM']])

    expect(await runChatIntakeSweep(org.orgId, at(7 * MS_PER_DAY))).toMatchObject({ purged: 1 })
    expect(await prisma.chatIntake.findUniqueOrThrow({ where: { id: intake!.id } })).toMatchObject({ status: 'EXPIRED', text: null, messageCount: 2, imageCount: 1 })
    expect(await prisma.fileObject.findUniqueOrThrow({ where: { id: file.id } })).toMatchObject({ status: 'REJECTED' })
    expect(await headObject(file.storageKey)).toBeNull()
    expect((await eventsOf(org.orgId, 'chat_intake.purged')).map((e) => e.data)).toEqual([{ textRemoved: true, filesRemoved: 1, fileIds: [file.id] }])
    // The same hour again repeats nothing
    expect(await runChatIntakeSweep(org.orgId, at(7 * MS_PER_DAY))).toMatchObject({ expired: 0, purged: 1 })
    expect(await eventsOf(org.orgId, 'chat_intake.purged')).toHaveLength(1)
  })

  it('the command takes a message only from the member its LINE user is linked to; expiring and clearing are the system’s', async () => {
    const org = await chatOrg()
    const owner = await linkedMember(org.orgId)
    const other = await linkedMember(org.orgId)
    const event = text(owner.lineUserId, 'ของเจ้าของ', NOW)
    const { row } = await send(org, event, NOW)
    const asOther = makeCtx({ organizationId: org.orgId, actor: { type: 'USER', memberId: other.memberId }, channel: 'LINE_CHAT', now: NOW })
    expect(await receiveChatMessage(asOther, { lineWebhookEventId: row.id }, { idempotencyKey: randomUUID() })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await receiveChatMessage(systemCtx(org.orgId, NOW, 'x'), { lineWebhookEventId: row.id }, { idempotencyKey: randomUUID() })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await runCommand(asOther, expireChatIntakesCommand, {}, { idempotencyKey: randomUUID() })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await runCommand(asOther, purgeChatIntakesCommand, {}, { idempotencyKey: randomUUID() })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await intakesOf(org.orgId, other.memberId)).toHaveLength(0)
  })

  it('a suspended organization is swept too; a photo still waiting when its closed draft was cleared is never stored', async () => {
    const org = await chatOrg()
    const m = await linkedMember(org.orgId)
    const image = lineEvents.image({ userId: m.lineUserId, timestamp: NOW.getTime() })
    line.fake.putContent((image.message as { id: string }).id, 'image/png', PNG)
    await send(org, image, NOW)
    const [intake] = await intakesOf(org.orgId, m.memberId)
    await prisma.organization.update({ where: { id: org.orgId }, data: { status: 'SUSPENDED' } })
    expect(await chatSweepOrganizationIds()).toContain(org.orgId)
    // Expired after a day and cleared after the retention with its photo still PENDING (the job never ran)
    expect(await runChatIntakeSweep(org.orgId, at(25 * MS_PER_HOUR))).toMatchObject({ expired: 1 })
    expect(await runChatIntakeSweep(org.orgId, at(7 * MS_PER_DAY))).toMatchObject({ purged: 1 })
    const itemId = intake!.items[0]!.id
    expect(await fetchChatImage(org.orgId, itemId, at(7 * MS_PER_DAY))).toEqual({ itemId, status: 'SKIPPED' })
    const asSystem = systemCtx(org.orgId, at(7 * MS_PER_DAY), 'chat-intake-image')
    expect(await runCommand(asSystem, storeChatImageCommand, { itemId, status: 'FAILED', code: 'GONE' }, { idempotencyKey: randomUUID() })).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
    expect(await prisma.fileObject.count({ where: { organizationId: org.orgId, storageKey: { startsWith: `org/${org.orgId}/chat-intake/` } } })).toBe(0)
  })

  it('logs of taking, answering, refusing and clearing carry no typed text, LINE user id or reply token (NFR-SEC-09)', async () => {
    const org = await chatOrg({ hourlyLimit: 1 })
    const m = await linkedMember(org.orgId)
    const secret = 'ข้อความลับห้ามลงล็อก-7731'
    const events = [
      text(m.lineUserId, secret, NOW, { replyToken: `expired${randomUUID().replace(/-/g, '')}` }),
      text(m.lineUserId, `${secret} ซ้ำ`, at(MS_PER_MINUTE)),
      text(newLineUserId(), secret, at(2 * MS_PER_MINUTE)),
    ]
    const logged = await logsOf(async () => {
      for (const [i, event] of events.entries()) await send(org, event, at(i * MS_PER_MINUTE))
      await runChatIntakeSweep(org.orgId, at(30 * MS_PER_DAY))
    })
    expect(logged).toContain('log capture probe')
    expect(logged).toContain('LINE did not take the reply to a chat message')
    expect(logged).not.toContain('ข้อความลับ')
    expect(logged).not.toContain(m.lineUserId)
    for (const event of events) expect(logged).not.toContain(event.replyToken!)
  })
})
