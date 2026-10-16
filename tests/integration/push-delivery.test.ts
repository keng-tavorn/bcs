// S17-10 (FR-PLT-301 AC1 AC2 AC10, BR-NOTI-05 to BR-NOTI-08, BR-APP-12, BR-APP-13, BR-AUTH-12): push in the BCS Go app.
// A member registers their own phone from inside the app; an approval task then reaches it by push first, through
// FCM HTTP v1 (the fake FCM of the fake LINE server), saying the document's number and nothing else; a device FCM no
// longer knows is revoked and LINE then e-mail follow; a refusal of BCS's own key is an alert and LINE goes at once; a
// transient failure is tried again and the e-mail still arrives within 5 minutes of the first try. Deactivating a
// member or signing out in the app revokes the phone; a phone moves with its token, to one person at a time.
import { createHash, randomUUID } from 'node:crypto'
import { Writable } from 'node:stream'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ManualClock } from '@/lib/clock'
import { MS_PER_MINUTE } from '@/lib/constants'
import { createLogger, logger } from '@/lib/logger'
import { prisma } from '@/server/db/client'
import { getDefaultOutboxSender, setDefaultOutboxSender, type OutboxSender } from '@/server/events/outbox'
import { nextTryOptions, notificationDeliverRun, type DeliveryStep } from '@/server/jobs/notification-deliver'
import { deliverNotification, LINE_FALLBACK_WITHIN_MS, PUSH_DELIVERY_GIVE_UP_MS } from '@/server/notifications/deliver'
import { openLineChannel, saveLineChannelSettings } from '@/server/services/line-channel'
import { deactivateMember } from '@/server/services/members'
import { listMyPushDevices, registerPushDevice, revokePushDevice } from '@/server/services/push-devices'
import { getMyNotificationPrefs, updateNotificationPrefs } from '@/server/services/self/notification-prefs'
import { newLineUserId } from '../../scripts/line-simulate'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { TEST_ACCESS_TOKEN, TEST_CHANNEL_SECRET, withFakeLine } from '../support/fake-line'
import { fakePushToken, withFakePush } from '../support/fake-push'
import { p2p } from '../support/p2p'
import { createDraft, submitRequest } from '../support/requests'

const NOW = new Date('2026-10-06T02:00:00Z')
const PROVIDER = '1650000101'
const CHANNEL = { providerId: PROVIDER, messagingChannelId: '1650000102', channelSecret: TEST_CHANNEL_SECRET, channelAccessToken: TEST_ACCESS_TOKEN, liffId: '1650000103-AbCdEfGh', liffChannelId: '1650000103' }
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(`expected ok: ${JSON.stringify(r.error)}`)
  return r.data
}

const line = withFakeLine()
withFakePush(line)
let inngestBefore: OutboxSender | null = null
let org: DoaOrg
let budgetLineId: string

async function enableBcsGo(organizationId: string) {
  await prisma.orgModule.create({ data: { organizationId, module: 'BCS_GO', enabled: true, enabledAt: NOW, contractRef: 'TEST-S17', reason: 'ทดสอบแอป BCS Go' } })
}

beforeAll(async () => {
  inngestBefore = getDefaultOutboxSender()
  setDefaultOutboxSender(async () => {})
  org = await createDoaOrg()
  await enableBcsGo(org.organizationId)
  budgetLineId = await p2p(org, NOW).fundedLine(5_000_000n)
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
  ok(await saveLineChannelSettings(org.ctxOf('admin', NOW), { ...CHANNEL, active: true }, key()))
})
afterAll(() => setDefaultOutboxSender(inngestBefore))
afterEach(() => vi.restoreAllMocks())

const inApp = (code: string, at = NOW, o: DoaOrg = org) => o.ctxOf(code, at, 'APP')

/** The member's other phones end first: each test sees the answers of its own phone only */
async function onlyPhoneOf(code: string): Promise<{ token: string; deviceId: string }> {
  await prisma.pushDevice.updateMany({ where: { organizationId: org.organizationId, memberId: org.member[code]!, revokedAt: null }, data: { revokedAt: NOW, revokeReason: 'USER' } })
  return phoneOf(code)
}

/** The member registers this phone in the app and turns notifications in the app on (FR-PLT-301 AC1) */
async function phoneOf(code: string, token = fakePushToken(), o: DoaOrg = org): Promise<{ token: string; deviceId: string }> {
  const { deviceId } = ok(await registerPushDevice(inApp(code, NOW, o), { token, platform: 'ANDROID', appVersion: '0.1.0' }, key()))
  const prefs = await updateNotificationPrefs(inApp(code, NOW, o), { appPush: true }, key())
  if (!prefs.ok && prefs.error.details?.reason !== 'NO_CHANGE') throw new Error('appPush not set')
  return { token, deviceId }
}

async function linkLine(code: string) {
  const memberId = org.member[code]!
  await prisma.channelIdentity.updateMany({ where: { organizationId: org.organizationId, memberId, unlinkedAt: null }, data: { unlinkedAt: NOW } })
  const lineUserId = newLineUserId()
  await prisma.channelIdentity.create({ data: { organizationId: org.organizationId, memberId, channel: 'LINE', providerKey: PROVIDER, externalUserId: lineUserId, linkedAt: NOW } })
  await prisma.member.update({ where: { id: memberId }, data: { lineReachable: true } })
  return lineUserId
}

/** A submitted request for 10,000 (DM of construction approves) and its task.assigned notice */
async function submitted(title = 'วัสดุสำนักงาน') {
  const draft = ok(await createDraft(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title, budgetLineId, lines: [{ description: 'กระดาษถ่ายเอกสาร A4', quantity: '1', uom: 'รีม', unitPrice: '10000.00' }] }, key()))
  ok(await submitRequest(org.ctxOf('req_con', NOW), { requestId: draft.requestId }, key()))
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: draft.requestId } } } })
  const notice = await prisma.notification.findFirstOrThrow({ where: { templateKey: 'task.assigned', data: { path: ['taskId'], equals: task.id } } })
  const request = await prisma.request.findUniqueOrThrow({ where: { id: draft.requestId } })
  return { task, notice, number: request.number!, assignee: task.assigneeMemberId }
}

const codeOf = (memberId: string) => Object.entries(org.member).find(([, id]) => id === memberId)![0]
const pushesTo = (token: string) => line.fake.fcm.pushes().filter((p) => p.token === token)
const withLine = { openChannel: openLineChannel }

/** The JSON lines the app logs while `run` runs (the app's serializers and redaction) */
async function logsOf(run: () => Promise<unknown>): Promise<string> {
  const lines: string[] = []
  const sink = createLogger(new Writable({ write: (chunk, _e, done) => (lines.push(String(chunk)), done()) }), 'trace')
  const spies = [vi.spyOn(logger, 'child').mockImplementation(((b, o) => sink.child(b, o)) as typeof logger.child)]
  for (const level of ['info', 'warn', 'error', 'debug'] as const) spies.push(vi.spyOn(logger, level).mockImplementation(((...a: unknown[]) => (sink[level] as (...x: unknown[]) => void)(...a)) as never) as never)
  try {
    logger.info({ probe: true }, 'log capture probe')
    await run()
  } finally {
    spies.forEach((s) => s.mockRestore())
  }
  return lines.join('\n')
}

describe('[FR-PLT-301/AC1] a member registers their own phone in the app (BR-APP-12)', () => {
  it('seals the token, keeps its sha256, records push_device.registered and tells the owner by e-mail', async () => {
    const token = fakePushToken()
    const { deviceId } = ok(await registerPushDevice(inApp('req_con'), { token, platform: 'ANDROID', appVersion: '0.1.0', deviceLabel: 'มือถือฝ่ายจัดซื้อ' }, key()))
    const row = await prisma.pushDevice.findUniqueOrThrow({ where: { id: deviceId } })
    expect(row).toMatchObject({ memberId: org.member.req_con, platform: 'ANDROID', appVersion: '0.1.0', revokedAt: null, tokenHash: createHash('sha256').update(token).digest('hex') })
    expect(row.tokenEnc).not.toContain(token)
    expect(row.tokenEnc).toMatch(/^v1\./)
    const event = await prisma.event.findFirstOrThrow({ where: { aggregateId: deviceId, type: 'push_device.registered' } })
    expect(event).toMatchObject({ channel: 'APP', data: { platform: 'ANDROID', appVersion: '0.1.0' } })
    expect(JSON.stringify(event.data)).not.toContain('มือถือ')
    expect(await prisma.notification.findFirst({ where: { recipientMemberId: org.member.req_con, templateKey: 'security.notice', data: { path: ['kind'], equals: 'PUSH_DEVICE_REGISTERED' } } })).not.toBeNull()
    // The command's record holds the device, never the token
    const logged = await prisma.commandLog.findMany({ where: { organizationId: org.organizationId, commandName: 'push_device.register' } })
    expect(JSON.stringify(logged)).not.toContain(token)
  })

  it('the same phone again refreshes its row; the list shows the member their own devices only', async () => {
    const token = fakePushToken()
    const first = ok(await registerPushDevice(inApp('fin_officer'), { token, platform: 'ANDROID', appVersion: '0.1.0' }, key()))
    const again = ok(await registerPushDevice(inApp('fin_officer', new Date(NOW.getTime() + MS_PER_MINUTE)), { token, platform: 'ANDROID', appVersion: '0.1.1' }, key()))
    expect(again).toEqual({ deviceId: first.deviceId, registered: false })
    const mine = ok(await listMyPushDevices(org.ctxOf('fin_officer', NOW)))
    expect(mine.map((d) => [d.id, d.appVersion])).toEqual([[first.deviceId, '0.1.1']])
    expect(ok(await listMyPushDevices(org.ctxOf('req_con', NOW))).some((d) => d.id === first.deviceId)).toBe(false)
  })

  it('a sixth phone in use makes the one seen longest ago go (REPLACED)', async () => {
    const ids: string[] = []
    for (let i = 0; i < 6; i++) {
      ids.push(ok(await registerPushDevice(inApp('dm_it', new Date(NOW.getTime() + i * MS_PER_MINUTE)), { token: fakePushToken(), platform: 'ANDROID', appVersion: '0.1.0' }, key())).deviceId)
    }
    expect(await prisma.pushDevice.findUniqueOrThrow({ where: { id: ids[0]! } })).toMatchObject({ revokeReason: 'REPLACED' })
    expect(await prisma.pushDevice.count({ where: { memberId: org.member.dm_it, revokedAt: null } })).toBe(5)
  })

  it('a phone receives one person: its token registered by another member, or in another organization, moves and the old row ends (BR-AUTH-12)', async () => {
    const token = fakePushToken()
    const before = ok(await registerPushDevice(inApp('proc_officer'), { token, platform: 'ANDROID', appVersion: '0.1.0' }, key()))
    const other = await createDoaOrg()
    await enableBcsGo(other.organizationId)
    const elsewhere = ok(await registerPushDevice(inApp('proc_officer', NOW, other), { token, platform: 'ANDROID', appVersion: '0.1.0' }, key()))
    expect(await prisma.pushDevice.findUniqueOrThrow({ where: { id: before.deviceId } })).toMatchObject({ revokeReason: 'REPLACED' })
    // The losing organization's audit says so, written by the system
    expect(await prisma.event.findFirstOrThrow({ where: { organizationId: org.organizationId, aggregateId: before.deviceId, type: 'push_device.revoked' } })).toMatchObject({ actorType: 'SYSTEM', data: { reason: 'REPLACED' } })
    // Back in the first organization, by someone else: the other organization's row ends too
    const moved = ok(await registerPushDevice(inApp('req_con'), { token, platform: 'ANDROID', appVersion: '0.1.0' }, key()))
    expect(await prisma.pushDevice.findUniqueOrThrow({ where: { id: elsewhere.deviceId } })).toMatchObject({ revokeReason: 'REPLACED' })
    expect(await prisma.pushDevice.count({ where: { tokenHash: createHash('sha256').update(token).digest('hex'), revokedAt: null } })).toBe(1)
    expect(moved.registered).toBe(true)
  })
})

describe('[FR-PLT-301/AC1] an approval task arrives by push first, with the number only (BR-NOTI-05, BR-NOTI-06)', () => {
  it('pushes the task to every phone of the approver in use; the lock screen shows the number, never the amount, title or requester', async () => {
    const { task, notice, number, assignee } = await submitted('งานถนนแอสฟัลต์ 9,500 ตร.ม.')
    const code = codeOf(assignee)
    const phone = await onlyPhoneOf(code)
    expect(await deliverNotification(org.organizationId, notice.id, NOW, withLine)).toEqual({ status: 'SENT', channel: 'PUSH' })
    const [push] = pushesTo(phone.token)
    expect(push).toMatchObject({ title: 'มีงานรออนุมัติ', body: number, data: { notificationId: notice.id, path: `/tasks/${task.id}` }, collapseKey: notice.id })
    const requester = await prisma.member.findUniqueOrThrow({ where: { id: org.member.req_con! } })
    const text = JSON.stringify(push)
    for (const word of ['10,000', '10000', '10700', 'งานถนน', 'กระดาษ', requester.displayNameTh]) expect(text, word).not.toContain(word)
    expect(await prisma.notification.findUniqueOrThrow({ where: { id: notice.id } })).toMatchObject({ status: 'SENT', sentChannel: 'PUSH' })
    // Delivered once: a second run of the same notification sends nothing more
    expect(await deliverNotification(org.organizationId, notice.id, NOW, withLine)).toEqual({ status: 'SKIPPED', why: 'SENT' })
    expect(pushesTo(phone.token)).toHaveLength(1)
  })

  it('notifications in the app off: the old way, LINE then e-mail, nothing by push (BR-NOTI-08)', async () => {
    const { notice, assignee } = await submitted()
    const code = codeOf(assignee)
    const phone = await onlyPhoneOf(code)
    ok(await updateNotificationPrefs(inApp(code), { appPush: false }, key()))
    expect(ok(await getMyNotificationPrefs(inApp(code)))).toMatchObject({ appPush: false })
    await linkLine(code)
    expect(await deliverNotification(org.organizationId, notice.id, NOW, withLine)).toEqual({ status: 'SENT', channel: 'LINE' })
    expect(pushesTo(phone.token)).toHaveLength(0)
  })
})

describe('[FR-PLT-301/AC2] push that cannot be sent: revoke, alert or try again, and LINE then e-mail in time (BR-NOTI-07)', () => {
  it('a phone FCM no longer knows is revoked (UNREGISTERED) and LINE takes the task at once', async () => {
    const { notice, assignee } = await submitted()
    const code = codeOf(assignee)
    const phone = await onlyPhoneOf(code)
    line.fake.fcm.setPushAnswer(phone.token, 'UNREGISTERED')
    await linkLine(code)
    expect(await deliverNotification(org.organizationId, notice.id, NOW, withLine)).toEqual({ status: 'SENT', channel: 'LINE', pushFailed: 'NO_DEVICE_LEFT' })
    expect(await prisma.pushDevice.findUniqueOrThrow({ where: { id: phone.deviceId } })).toMatchObject({ revokeReason: 'UNREGISTERED' })
    expect(await prisma.event.findFirstOrThrow({ where: { aggregateId: phone.deviceId, type: 'push_device.revoked' } })).toMatchObject({ actorType: 'SYSTEM', data: { reason: 'UNREGISTERED' } })
    expect(await prisma.notification.findUniqueOrThrow({ where: { id: notice.id } })).toMatchObject({ sentChannel: 'LINE', error: 'PUSH_NO_DEVICE_LEFT' })
  })

  it("FCM refusing BCS's own credentials is an alert, and the next channel goes at once, no retry", async () => {
    const { notice, assignee } = await submitted()
    const code = codeOf(assignee)
    const phone = await onlyPhoneOf(code)
    line.fake.fcm.setPushAnswer(phone.token, 'UNAUTHENTICATED')
    await prisma.channelIdentity.updateMany({ where: { memberId: assignee, unlinkedAt: null }, data: { unlinkedAt: NOW } })
    const errors = vi.spyOn(logger, 'error')
    expect(await deliverNotification(org.organizationId, notice.id, NOW, withLine)).toEqual({ status: 'SENT', channel: 'EMAIL' })
    expect(errors.mock.calls.some(([o]) => (o as { alert?: boolean }).alert === true)).toBe(true)
    // The phone stays: the trouble is BCS's, not the member's
    expect(await prisma.pushDevice.findUniqueOrThrow({ where: { id: phone.deviceId } })).toMatchObject({ revokedAt: null })
    line.fake.fcm.setPushAnswer(phone.token, null)
  })

  it('FCM unavailable is tried again; after push gives up at 2 minutes the e-mail still arrives within 5 minutes of the first try', async () => {
    const { notice, assignee } = await submitted()
    const code = codeOf(assignee)
    const phone = await onlyPhoneOf(code)
    line.fake.fcm.setPushAnswer(phone.token, 'UNAVAILABLE')
    await prisma.channelIdentity.updateMany({ where: { memberId: assignee, unlinkedAt: null }, data: { unlinkedAt: NOW } })
    const first = await deliverNotification(org.organizationId, notice.id, NOW, withLine)
    expect(first).toMatchObject({ status: 'RETRY', channel: 'PUSH', reason: 'SERVER_503', tries: 1, firstTryAt: NOW.toISOString() })
    if (first.status !== 'RETRY') return
    expect(nextTryOptions(first, openLineChannel)).toMatchObject({ pushTry: 2, firstTryAt: NOW })

    const clock = new ManualClock(NOW)
    const sleeps: string[] = []
    const step: DeliveryStep = { run: (_id, fn) => fn(), sleepUntil: async (_id, at) => (sleeps.push(at), clock.set(new Date(at))) }
    const outcome = await notificationDeliverRun(clock, { openChannel: openLineChannel })({ data: { organizationId: org.organizationId, notificationId: notice.id } }, step)
    expect(outcome).toEqual({ status: 'SENT', channel: 'EMAIL' })
    const last = new Date(sleeps.at(-1)!).getTime()
    expect(last - NOW.getTime()).toBeLessThanOrEqual(PUSH_DELIVERY_GIVE_UP_MS)
    expect(clock.now().getTime() - NOW.getTime()).toBeLessThanOrEqual(LINE_FALLBACK_WITHIN_MS)
    expect(await prisma.notification.findUniqueOrThrow({ where: { id: notice.id } })).toMatchObject({ status: 'SENT', sentChannel: 'EMAIL', error: 'PUSH_SERVER_503' })
    line.fake.fcm.setPushAnswer(phone.token, null)
  })

  it('deactivating a member revokes every phone of theirs in the same transaction (BR-AUTH-12 with BR-AUTH-06)', async () => {
    const a = await phoneOf('dm_fin')
    const b = await phoneOf('dm_fin')
    const done = await deactivateMember(org.ctxOf('admin', NOW), { memberId: org.member.dm_fin!, reason: 'ลาออก' }, key())
    expect(done.ok).toBe(true)
    for (const id of [a.deviceId, b.deviceId]) expect(await prisma.pushDevice.findUniqueOrThrow({ where: { id } })).toMatchObject({ revokeReason: 'DEACTIVATED' })
    const deactivated = await prisma.event.findFirstOrThrow({ where: { aggregateId: org.member.dm_fin!, type: 'member.deactivated' } })
    expect(deactivated.data).toMatchObject({ revoked: { pushDevices: 2 } })
    expect(deactivated.correlationId).toBe((await prisma.event.findFirstOrThrow({ where: { aggregateId: a.deviceId, type: 'push_device.revoked' } })).correlationId)
  })

  it('signing out in the app revokes that phone (LOGOUT); the member may end their own phone (USER)', async () => {
    const out = await phoneOf('vp_ops')
    ok(await revokePushDevice(inApp('vp_ops'), { deviceId: out.deviceId, reason: 'LOGOUT' }, key()))
    expect(await prisma.pushDevice.findUniqueOrThrow({ where: { id: out.deviceId } })).toMatchObject({ revokeReason: 'LOGOUT' })
    const mine = await phoneOf('vp_ops')
    ok(await revokePushDevice(org.ctxOf('vp_ops', NOW), { deviceId: mine.deviceId, reason: 'USER' }, key()))
    expect(await revokePushDevice(org.ctxOf('vp_ops', NOW), { deviceId: mine.deviceId, reason: 'USER' }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
  })
})

describe('[FR-PLT-301/AC10] module BCS_GO off: no push and no registration; refusals (BR-APP-12, BR-APP-13)', () => {
  it('refuses registering outside the app, ending somebody else’s phone (ORG_ADMIN too), and a token that is not one', async () => {
    expect(await registerPushDevice(org.ctxOf('req_con', NOW, 'WEB'), { token: fakePushToken(), platform: 'ANDROID', appVersion: '0.1.0' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', details: { reason: 'CHANNEL' } } })
    const phone = await phoneOf('dm_proc')
    for (const who of ['req_con', 'admin']) {
      expect(await revokePushDevice(org.ctxOf(who, NOW), { deviceId: phone.deviceId, reason: 'USER' }, key()), who).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    }
    expect(await prisma.pushDevice.findUniqueOrThrow({ where: { id: phone.deviceId } })).toMatchObject({ revokedAt: null })
    expect(await registerPushDevice(inApp('req_con'), { token: 'short', platform: 'ANDROID', appVersion: '0.1.0' }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'PUSH_TOKEN' } } })
  })

  it('with BCS_GO off, registering is MODULE_DISABLED and a registered phone gets no push (LINE and e-mail as before)', async () => {
    const off = await createDoaOrg()
    const token = fakePushToken()
    expect(await registerPushDevice(inApp('dm_con', NOW, off), { token, platform: 'ANDROID', appVersion: '0.1.0' }, key())).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
    // A phone from when the module was on stays registered but gets nothing until it is on again
    await enableBcsGo(off.organizationId)
    await phoneOf('dm_con', token, off)
    await prisma.orgModule.updateMany({ where: { organizationId: off.organizationId, module: 'BCS_GO' }, data: { enabled: false } })
    const notice = await prisma.notification.create({ data: { organizationId: off.organizationId, recipientMemberId: off.member.dm_con!, templateKey: 'request.approved', data: { number: 'PR-2569-09999', requestId: randomUUID() }, urgency: 'IMMEDIATE', dedupeKey: `test:${randomUUID()}` } })
    expect(await deliverNotification(off.organizationId, notice.id, NOW, withLine)).toEqual({ status: 'SENT', channel: 'EMAIL' })
    expect(pushesTo(token)).toHaveLength(0)
  })

  it('a UAT sandbox never pushes (BR-UAT-01, ADR-174)', async () => {
    const sandbox = await createDoaOrg()
    await enableBcsGo(sandbox.organizationId)
    const phone = await phoneOf('dm_con', fakePushToken(), sandbox)
    await prisma.organization.update({ where: { id: sandbox.organizationId }, data: { kind: 'SANDBOX', sandboxOfOrganizationId: org.organizationId } })
    const notice = await prisma.notification.create({ data: { organizationId: sandbox.organizationId, recipientMemberId: sandbox.member.dm_con!, templateKey: 'request.approved', data: { number: 'PR-2569-09998', requestId: randomUUID() }, urgency: 'IMMEDIATE', dedupeKey: `test:${randomUUID()}` } })
    expect(await deliverNotification(sandbox.organizationId, notice.id, NOW, withLine)).toEqual({ status: 'SENT', channel: 'EMAIL' })
    expect(pushesTo(phone.token)).toHaveLength(0)
  })
})

describe('[FR-PLT-301/AC2] no push token in the logs (NFR-SEC-09, BR-APP-12)', () => {
  it('registering, pushing, a refused phone and a revoked one log no token', async () => {
    const tokens: string[] = []
    const logged = await logsOf(async () => {
      const { notice, assignee } = await submitted()
      const code = codeOf(assignee)
      const sent = await phoneOf(code)
      const gone = await phoneOf(code)
      tokens.push(sent.token, gone.token)
      line.fake.fcm.setPushAnswer(gone.token, 'UNREGISTERED')
      await deliverNotification(org.organizationId, notice.id, NOW, withLine)
      await revokePushDevice(inApp(code), { deviceId: sent.deviceId, reason: 'LOGOUT' }, key())
    })
    expect(logged).toContain('log capture probe')
    for (const token of tokens) expect(logged).not.toContain(token)
  })
})
