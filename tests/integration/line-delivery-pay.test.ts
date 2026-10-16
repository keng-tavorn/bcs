import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { getDefaultOutboxSender, setDefaultOutboxSender, type OutboxSender } from '@/server/events/outbox'
import { deliverNotification, LINE_TEMPLATES } from '@/server/notifications/deliver'
import { renderNotification } from '@/server/notifications/templates'
import { openLineChannel, saveLineChannelSettings } from '@/server/services/line-channel'
import { newLineUserId } from '../../scripts/line-simulate'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { TEST_ACCESS_TOKEN, TEST_CHANNEL_SECRET, withFakeLine } from '../support/fake-line'

// The notices of lane 2 whose §10.1 row sends them by LINE (S9-18, ADR-135): po_change.decided (S8-10, "ในระบบ · LINE")
// and bank_account_change.decided (S9-04, "LINE → อีเมล") go to a linked member by LINE as a short text with the
// link back to the document (BR-NOTI-02), as the S5 notices do; the list lives in templates/payments.ts.

const NOW = new Date('2026-10-12T03:00:00Z')
const PROVIDER = '1650000101'
const CHANNEL = { providerId: PROVIDER, messagingChannelId: '1650000102', channelSecret: TEST_CHANNEL_SECRET, channelAccessToken: TEST_ACCESS_TOKEN, liffId: null, liffChannelId: null }
const key = () => ({ idempotencyKey: randomUUID(), sender: null })

const line = withFakeLine()
let inngestBefore: OutboxSender | null = null
let org: DoaOrg

beforeAll(async () => {
  inngestBefore = getDefaultOutboxSender()
  setDefaultOutboxSender(async () => {})
  org = await createDoaOrg()
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
  const saved = await saveLineChannelSettings(org.ctxOf('admin', NOW), { ...CHANNEL, active: true }, key())
  if (!saved.ok) throw new Error(JSON.stringify(saved.error))
})
afterAll(() => setDefaultOutboxSender(inngestBefore))

/** Links the member to a new LINE user, as S5-04's link makes it */
async function linkTo(code: string) {
  const lineUserId = newLineUserId()
  const memberId = org.member[code]!
  await prisma.channelIdentity.create({ data: { organizationId: org.organizationId, memberId, channel: 'LINE', providerKey: PROVIDER, externalUserId: lineUserId, linkedAt: NOW } })
  await prisma.member.update({ where: { id: memberId }, data: { lineReachable: true } })
  return lineUserId
}

const pushesTo = (lineUserId: string, notificationId: string) => line.fake.messages().filter((m) => m.kind === 'push' && m.to === lineUserId && m.retryKey === notificationId)

describe('[S9-18] the decisions of lane 2’s changes reach their proposer by LINE (§10.1)', () => {
  it.each([
    ['po_change.decided', 'proc_officer', { poChangeId: randomUUID(), poId: randomUUID(), changeNo: 1, outcome: 'APPROVED' }, 'PO_CHANGE'],
    ['bank_account_change.decided', 'fin_officer', { changeId: randomUUID(), number: 'BAC-2569-00001', kind: 'REPLACE', supplierCode: 'SP0056', outcome: 'RETURNED' }, 'BANK_ACCOUNT_CHANGE'],
  ] as const)('%s goes to the linked proposer as text with the link back', async (templateKey, code, data, subjectType) => {
    expect(LINE_TEMPLATES.has(templateKey)).toBe(true)
    const to = await linkTo(code)
    const notice = await prisma.notification.create({
      data: { organizationId: org.organizationId, recipientMemberId: org.member[code]!, templateKey, urgency: 'IMMEDIATE', dedupeKey: `${templateKey}:${randomUUID()}`, data, subjectType, subjectId: randomUUID() },
    })
    expect(await deliverNotification(org.organizationId, notice.id, NOW, { openChannel: openLineChannel })).toEqual({ status: 'SENT', channel: 'LINE' })
    const rendered = renderNotification(notice, 'th')
    const [push] = pushesTo(to, notice.id)
    expect(push!.messages).toEqual([{ type: 'text', text: expect.stringContaining(rendered.title) }])
    expect((push!.messages[0] as { text: string }).text).toContain(rendered.href!)
  })
})
