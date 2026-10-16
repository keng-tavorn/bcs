import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { chatIntakeSettingsFor, chatIntakeSettingsOf, CHAT_INTAKE_DEFAULTS } from '@/lib/s17-settings'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { loadOrgSettingsYaml, parseDemoOrgInput, seedDemoOrganization } from '@/server/seed/demo-org'
import { INPUT_WORKBOOKS, loadInputWorkbook } from '@/server/seed/workbook'
import { createSandbox } from '@/server/services/platform/sandbox'
import { appPushEnabled, StoredNotificationPrefsSchema } from '@/server/services/self/notification-prefs'
import { createMember, createOrg } from '../support/factory'

// S17-01 (docs/sub-specs/S17.md "Entity และ migration"): the database keeps a chat draft within 2000 code points and
// 10 images, a draft names its request and only a draft does, a text message fetches nothing and an image names its
// file exactly when stored, only text waits in LineInboundMessage, a push token is one sha256 per device in use, and a
// menu set is one per organization. References into another organization are refused by the generated tenant test
// (tests/generated/tenant-isolation.test.ts); the settings themselves are in tests/unit/s17-settings.test.ts.

let orgId: string
let memberId: string
const at = new Date('2026-11-02T03:00:00Z')

beforeAll(async () => {
  orgId = (await createOrg()).id
  memberId = (await createMember(orgId)).id
})

const intakeData = (over: Record<string, unknown> = {}) => ({ organizationId: orgId, memberId, openedAt: at, lastMessageAt: at, expiresAt: new Date(at.getTime() + 86_400_000), ...over })

describe('[BR-LINE-10] ChatIntake keeps at most 2000 code points of text and 10 images', () => {
  it('accepts 2000 code points, even when they are 4000 UTF-16 code units', async () => {
    await expect(prisma.chatIntake.create({ data: intakeData({ text: 'ก'.repeat(2000), imageCount: 10, messageCount: 12 }) })).resolves.toBeTruthy()
    await expect(prisma.chatIntake.create({ data: intakeData({ text: '🧱'.repeat(2000) }) })).resolves.toBeTruthy()
  })

  it.each([
    ['2001 code points', { text: 'ก'.repeat(2001) }],
    ['11 images', { imageCount: 11 }],
    ['negative images', { imageCount: -1 }],
    ['negative messages', { messageCount: -1 }],
    ['a draft without its request', { status: 'DRAFTED' }],
  ])('refuses %s', async (_label, over) => {
    await expect(prisma.chatIntake.create({ data: intakeData(over) })).rejects.toThrow()
  })
})

describe('[BR-LINE-14] ChatIntakeItem: one row per LINE message, a file only for a stored image', () => {
  let intakeId: string
  beforeAll(async () => {
    intakeId = (await prisma.chatIntake.create({ data: intakeData() })).id
  })
  const item = (over: Record<string, unknown>) =>
    prisma.chatIntakeItem.create({ data: { organizationId: orgId, intakeId, seq: 1, kind: 'TEXT' as const, lineMessageId: randomUUID(), receivedAt: at, ...over } })

  it('accepts a text message and an image waiting, failed or stored with its file', async () => {
    const file = await prisma.fileObject.create({ data: { organizationId: orgId, storageKey: `test/${randomUUID()}.jpg`, fileName: 'q.jpg', mimeType: 'image/jpeg', sizeBytes: 1, status: 'AVAILABLE', uploadedById: memberId } })
    await expect(item({ seq: 1 })).resolves.toBeTruthy()
    await expect(item({ seq: 2, kind: 'IMAGE', fetchStatus: 'PENDING' })).resolves.toBeTruthy()
    await expect(item({ seq: 3, kind: 'IMAGE', fetchStatus: 'FAILED', fetchError: 'GONE' })).resolves.toBeTruthy()
    await expect(item({ seq: 4, kind: 'IMAGE', fetchStatus: 'STORED', fileId: file.id })).resolves.toBeTruthy()
  })

  it.each([
    ['seq 0', { seq: 0 }],
    ['a text message waiting for a fetch', { seq: 10, fetchStatus: 'PENDING' }],
    ['an image with nothing to fetch', { seq: 11, kind: 'IMAGE' }],
    ['a stored image without its file', { seq: 12, kind: 'IMAGE', fetchStatus: 'STORED' }],
  ])('refuses %s', async (_label, over) => {
    await expect(item(over)).rejects.toThrow()
  })

  it('takes a LINE message once, and one row per seq', async () => {
    const lineMessageId = randomUUID()
    await item({ seq: 20, lineMessageId })
    await expect(item({ seq: 21, lineMessageId })).rejects.toThrow()
    await expect(item({ seq: 20 })).rejects.toThrow()
  })
})

describe('[BR-LINE-11] LineInboundMessage: only text waits, one row per webhook event', () => {
  it('keeps the text of one message event and refuses a second row or text on an image', async () => {
    const event = await prisma.lineWebhookEvent.create({ data: { organizationId: orgId, webhookEventId: randomUUID(), channelKey: 'k', type: 'message', receivedAt: at } })
    const message = (over: Record<string, unknown>) => prisma.lineInboundMessage.create({ data: { organizationId: orgId, lineWebhookEventId: event.id, lineMessageId: randomUUID(), kind: 'TEXT' as const, text: 'ขอซื้อ', receivedAt: at, ...over } })
    await expect(message({ kind: 'IMAGE' })).rejects.toThrow()
    await expect(message({})).resolves.toBeTruthy()
    await expect(message({})).rejects.toThrow()
  })
})

describe('[BR-APP-12] PushDevice: a sha256 per token, one device in use per token', () => {
  const hash = () => randomUUID().replaceAll('-', '').repeat(2)
  const device = (over: Record<string, unknown>) =>
    prisma.pushDevice.create({ data: { organizationId: orgId, memberId, platform: 'ANDROID' as const, tokenEnc: 'k1:sealed', tokenHash: hash(), appVersion: '1.0.0', registeredAt: at, lastSeenAt: at, ...over } })

  it('refuses a second device in use with the same token, and takes it again once the first is revoked', async () => {
    const tokenHash = hash()
    const first = await device({ tokenHash })
    await expect(device({ tokenHash })).rejects.toThrow()
    await prisma.pushDevice.update({ where: { id: first.id }, data: { revokedAt: at, revokeReason: 'REPLACED' } })
    await expect(device({ tokenHash })).resolves.toBeTruthy()
  })

  it.each([
    ['a hash that is not 64 lower-case hex', { tokenHash: 'A'.repeat(64) }],
    ['a label over 60 characters', { deviceLabel: 'ก'.repeat(61) }],
    ['revoked without a reason', { revokedAt: at }],
    ['a reason without being revoked', { revokeReason: 'USER' }],
  ])('refuses %s', async (_label, over) => {
    await expect(device(over)).rejects.toThrow()
  })
})

describe('[BR-LINE-16] LineRichMenuVariant: one menu per set of buttons in an organization', () => {
  it('refuses the same variantKey twice', async () => {
    const config = await prisma.lineChannelConfig.create({ data: { organizationId: orgId, channelKey: `s17-${randomUUID()}`, providerId: 'p', messagingChannelId: 'm', channelSecretEnc: 'x', channelAccessTokenEnc: 'x' } })
    const variant = { organizationId: orgId, channelConfigId: config.id, variantKey: 'LINKED:APPROVER', richMenuId: 'richmenu-1', madeAt: at }
    await prisma.lineRichMenuVariant.create({ data: variant })
    await expect(prisma.lineRichMenuVariant.create({ data: { ...variant, richMenuId: 'richmenu-2' } })).rejects.toThrow()
  })
})

describe('[FR-PLT-001/AC2] the seed: the demo organization keeps the chat off, SIMEC turns it on', () => {
  it('reads sheet Settings of each workbook into Organization.settings', async () => {
    const demo = parseDemoOrgInput(await loadInputWorkbook(INPUT_WORKBOOKS.demo), loadOrgSettingsYaml())
    expect(demo.settings.chatIntake).toBeUndefined()
    expect(chatIntakeSettingsOf(demo.settings).enabled).toBe(false)
    const p1 = parseDemoOrgInput(await loadInputWorkbook(INPUT_WORKBOOKS.p1), loadOrgSettingsYaml())
    expect(p1.org.code).toBe('SIMEC')
    expect(chatIntakeSettingsOf(p1.settings)).toEqual({ ...CHAT_INTAKE_DEFAULTS, enabled: true })
    expect(p1.settings.bcsGo).toEqual({ offlineRetentionDays: 7, maxPreparedPos: 50 })
  })

  it('the seeded demo organization has asking through the chat off', async () => {
    const input = parseDemoOrgInput(await loadInputWorkbook(INPUT_WORKBOOKS.demo), loadOrgSettingsYaml())
    const tag = randomUUID().slice(0, 6)
    const own = { ...input, org: { ...input.org, code: `S17${tag.toUpperCase()}` }, users: input.users.map((u) => ({ ...u, email: `s17-${tag}-${u.email}` })) }
    const { organizationId } = await seedDemoOrganization(own, { password: 'chat-intake-test-password-0001', now: at })
    const stored = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { settings: true } })
    expect((stored.settings as Record<string, unknown>).chatIntake).toBeUndefined()
    expect(chatIntakeSettingsOf(stored.settings).enabled).toBe(false)
  })
})

describe('[BR-LINE-10] a UAT sandbox of S6 copies the S17 settings with the chat off (BR-UAT-01 · ADR-174)', () => {
  it('the sandbox command copies the chatIntake and bcsGo of production, turns the chat and LINE off, and the chat reads it as off', async () => {
    const p1 = parseDemoOrgInput(await loadInputWorkbook(INPUT_WORKBOOKS.p1), loadOrgSettingsYaml())
    expect(chatIntakeSettingsOf(p1.settings).enabled).toBe(true)
    const production = await createOrg()
    await prisma.organization.update({ where: { id: production.id }, data: { settings: p1.settings as object } })
    const admin = await prisma.platformAdmin.create({ data: { displayName: 'ทีม BCS', active: true } })
    const ctx = makeCtx({ organizationId: production.id, actor: { type: 'PLATFORM_ADMIN', platformAdminId: admin.id }, channel: 'WEB', now: at })
    const code = `UAT-${randomUUID().slice(0, 6).toUpperCase()}`
    const made = await createSandbox(ctx, { code, contractRef: 'CT-2026-001', reason: 'ลูกค้าขอระบบทดลองตามสัญญา' }, { idempotencyKey: randomUUID(), sender: null })
    if (!made.ok) throw new Error(JSON.stringify(made.error))
    const sandbox = await prisma.organization.findUniqueOrThrow({ where: { id: made.data.sandboxOrganizationId }, select: { kind: true, settings: true } })
    const stored = sandbox.settings as { chatIntake?: unknown; bcsGo?: unknown; features: { lineChannel: boolean } }
    expect(stored.chatIntake).toEqual({ ...p1.settings.chatIntake, enabled: false })
    expect(stored.bcsGo).toEqual(p1.settings.bcsGo)
    expect(stored.features.lineChannel).toBe(false)
    expect(chatIntakeSettingsFor(sandbox).enabled).toBe(false)
    // Production keeps its own
    const kept = await prisma.organization.findUniqueOrThrow({ where: { id: production.id }, select: { kind: true, settings: true } })
    expect(chatIntakeSettingsFor(kept).enabled).toBe(true)
  })
})

describe('Member.notificationPrefs.appPush (OQ-165)', () => {
  it('push in the app is off unless the member turned it on, whatever another key holds', () => {
    expect(appPushEnabled({})).toBe(false)
    expect(appPushEnabled(null)).toBe(false)
    expect(appPushEnabled({ digest: false })).toBe(false)
    expect(appPushEnabled({ appPush: 'yes' })).toBe(false)
    expect(appPushEnabled({ appPush: false })).toBe(false)
    expect(appPushEnabled({ digest: true, appPush: true })).toBe(true)
    expect(appPushEnabled({ digest: 'broken', appPush: true })).toBe(true)
  })

  it('the stored preferences take appPush as a boolean only', () => {
    expect(StoredNotificationPrefsSchema.safeParse({}).success).toBe(true)
    expect(StoredNotificationPrefsSchema.safeParse({ digest: false, appPush: true }).success).toBe(true)
    expect(StoredNotificationPrefsSchema.safeParse({ appPush: 'yes' }).success).toBe(false)
  })
})
