// S17-05 (FR-LINE-303 AC5, OQ-171, NEW-64): when a PO goes out, the RECEIVER of the department hears it at once — by
// push in the BCS Go app, LINE or e-mail — with the link to the receiving page (/liff/gr/<poId> in LINE), and nothing of
// the lines or prices; the requester still hears it in the daily summary.
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { getDefaultOutboxSender, setDefaultOutboxSender, type OutboxSender } from '@/server/events/outbox'
import { deliverNotification } from '@/server/notifications/deliver'
import { openLineChannel, saveLineChannelSettings } from '@/server/services/line-channel'
import { sendPurchaseOrder } from '@/server/services/purchase-orders/send'
import { registerPushDevice } from '@/server/services/push-devices'
import { updateNotificationPrefs } from '@/server/services/self/notification-prefs'
import { newLineUserId } from '../../scripts/line-simulate'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { TEST_ACCESS_TOKEN, TEST_CHANNEL_SECRET, withFakeLine } from '../support/fake-line'
import { fakePushToken, withFakePush } from '../support/fake-push'
import { p2p } from '../support/p2p'

const NOW = new Date('2026-10-06T02:00:00Z')
const PROVIDER = '1650000201'
const LIFF_ID = '1650000203-PoSentRc'
const CHANNEL = { providerId: PROVIDER, messagingChannelId: '1650000202', channelSecret: TEST_CHANNEL_SECRET, channelAccessToken: TEST_ACCESS_TOKEN, liffId: LIFF_ID, liffChannelId: '1650000203' }
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

const line = withFakeLine()
withFakePush(line)
let inngestBefore: OutboxSender | null = null
let org: DoaOrg
let kit: ReturnType<typeof p2p>

beforeAll(async () => {
  inngestBefore = getDefaultOutboxSender()
  setDefaultOutboxSender(async () => {})
  org = await createDoaOrg()
  kit = p2p(org, NOW)
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.receiver_con!, role: 'RECEIVER', scopeDepartmentId: org.department.CON!, grantedAt: NOW } })
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
  ok(await saveLineChannelSettings(org.ctxOf('admin', NOW), { ...CHANNEL, active: true }, key()))
})
afterAll(() => setDefaultOutboxSender(inngestBefore))

let branch = 0
/** A PO of 10 × 1,250.00 approved and sent to its supplier by e-mail */
async function sentPo() {
  const supplier = await prisma.supplier.create({ data: { organizationId: org.organizationId, code: `S-${randomUUID().slice(0, 8)}`, nameTh: 'บริษัท ผู้ขายวัสดุ จำกัด', taxId: '0999999000012', branchCode: String(++branch).padStart(5, '0'), email: `po-${randomUUID().slice(0, 8)}@supplier.test` } })
  const budget = await kit.fundedLine(500_000n)
  const pr = await kit.approvedRequest(budget, [{ quantity: '10', unitPrice: '1250.00', description: 'ปูนซีเมนต์ปอร์ตแลนด์ประเภทหนึ่ง' }])
  const po = await kit.approvedPo([pr.lines[0]!.id], supplier.id)
  ok(await sendPurchaseOrder(org.ctxOf('proc_officer', NOW), { poId: po.id }, key()))
  return { po, requesterId: pr.requesterMemberId }
}

async function linkLine(code: string) {
  const lineUserId = newLineUserId()
  await prisma.channelIdentity.create({ data: { organizationId: org.organizationId, memberId: org.member[code]!, channel: 'LINE', providerKey: PROVIDER, externalUserId: lineUserId, linkedAt: NOW } })
  await prisma.member.update({ where: { id: org.member[code]! }, data: { lineReachable: true } })
  return lineUserId
}

const receiverNotice = (poId: string) => prisma.notification.findFirstOrThrow({ where: { templateKey: 'po.sent_receiver', subjectId: poId, recipientMemberId: org.member.receiver_con } })

describe('[FR-LINE-303/AC5] the RECEIVER hears at once that the PO went out, with the receiving page (OQ-171)', () => {
  it('LINE: a message linking to /liff/gr/<poId>, no line or price; the requester still waits for the daily summary', async () => {
    const lineUserId = await linkLine('receiver_con')
    const { po, requesterId } = await sentPo()
    const notice = await receiverNotice(po.id)
    expect(notice).toMatchObject({ urgency: 'IMMEDIATE', data: { poId: po.id, number: po.number } })
    expect(await prisma.notification.findFirstOrThrow({ where: { templateKey: 'po.sent', subjectId: po.id, recipientMemberId: requesterId } })).toMatchObject({ urgency: 'DIGEST' })
    expect(await prisma.notification.count({ where: { templateKey: 'po.sent', subjectId: po.id, recipientMemberId: org.member.receiver_con } })).toBe(0)

    expect(await deliverNotification(org.organizationId, notice.id, NOW, { openChannel: openLineChannel })).toEqual({ status: 'SENT', channel: 'LINE' })
    const [message] = line.fake.messages().filter((m) => m.kind === 'push' && m.to === lineUserId)
    const text = JSON.stringify(message)
    expect(text).toContain(`https://liff.line.me/${LIFF_ID}/gr/${po.id}`)
    expect(text).toContain(po.number!)
    for (const word of ['1,250', '1250', '12,500', '12500', 'ปูนซีเมนต์']) expect(text, word).not.toContain(word)
  })

  it('in the BCS Go app it comes by push first, opening the receiving page there', async () => {
    await prisma.orgModule.create({ data: { organizationId: org.organizationId, module: 'BCS_GO', enabled: true, enabledAt: NOW, contractRef: 'TEST-S17', reason: 'ทดสอบแอป BCS Go' } })
    const token = fakePushToken()
    ok(await registerPushDevice(org.ctxOf('receiver_con', NOW, 'APP'), { token, platform: 'ANDROID', appVersion: '0.1.0' }, key()))
    ok(await updateNotificationPrefs(org.ctxOf('receiver_con', NOW, 'APP'), { appPush: true }, key()))
    const { po } = await sentPo()
    const notice = await receiverNotice(po.id)
    expect(await deliverNotification(org.organizationId, notice.id, NOW, { openChannel: openLineChannel })).toEqual({ status: 'SENT', channel: 'PUSH' })
    const [push] = line.fake.fcm.pushes().filter((p) => p.token === token)
    expect(push).toMatchObject({ title: 'มีใบสั่งซื้อรอตรวจรับ', body: po.number, data: { notificationId: notice.id, path: `/receiving/${po.id}` } })
  })
})
