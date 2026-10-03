import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { POST } from '@/app/api/webhooks/line/[channelKey]/route'
import { MS_PER_HOUR, MS_PER_MINUTE } from '@/lib/constants'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { getDefaultOutboxSender, setDefaultOutboxSender, type OutboxMessage, type OutboxSender } from '@/server/events/outbox'
import { processQueuedLineWebhookEvents, receiveLineWebhook } from '@/server/jobs/line-webhook'
import { linePostbackActions } from '@/server/line/webhook'
import { deliverNotification } from '@/server/notifications/deliver'
import { decideByActionLink } from '@/server/services/approvals/action-link'
import { decideTask, requestInfo } from '@/server/services/approvals/decide'
import { decideByLinePostback } from '@/server/services/approvals/line-postback'
import { createDelegation } from '@/server/services/delegations'
import { openLineChannel, saveLineChannelSettings } from '@/server/services/line-channel'
import { cancelRequest, createDraft, submitRequest } from '@/server/services/requests'
import { escalateTask, startDelegationWindow } from '@/server/services/sla'
import { emailLinkSecret } from '@/server/tokens/action-tokens'
import { buildLineWebhook, lineEvents, newLineUserId, signLineWebhook } from '../../scripts/line-simulate'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { TEST_ACCESS_TOKEN, TEST_CHANNEL_SECRET, withFakeLine } from '../support/fake-line'
import { p2p } from '../support/p2p'

// S5-05 · deciding from the approval card in the chat (spec §9.3, BR-TOK-01 to BR-TOK-05, INV-TOK-01, FR-LINE-002 AC2
// AC3, FR-LINE-007 AC2). The card reaches the approver through delivery, the postback comes back as a webhook signed
// as LINE signs it (pnpm line:simulate's builders) through the webhook's own entry, and LINE is the fake LINE server of
// the repo: what the app replied or pushed is read back from it. The database is real.

const NOW = new Date('2026-10-06T02:00:00Z')
const LATER = new Date(NOW.getTime() + MS_PER_MINUTE)
/** Thursday 8 Oct 2026 09:00 Thai time: past the escalation time of a task assigned at NOW, before its buttons expire */
const THU_0900 = new Date('2026-10-08T02:00:00Z')
const HOURS_72 = 72 * MS_PER_HOUR
const PROVIDER = '1650000001'
const LIFF_ID = '1650000003-AbCdEfGh'
const LIFF = `https://liff.line.me/${LIFF_ID}`
const CHANNEL = { providerId: PROVIDER, messagingChannelId: '1650000002', channelSecret: TEST_CHANNEL_SECRET, channelAccessToken: TEST_ACCESS_TOKEN, liffId: LIFF_ID, liffChannelId: '1650000003' }

const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

const line = withFakeLine()

/** What the commands handed to Inngest: kept here instead (the default outbox sender is replaced for this file) */
const toInngest: OutboxMessage[] = []
let inngestBefore: OutboxSender | null = null

let org: DoaOrg
let channelKey: string
let budgetLineId: string
/** The LINE user id each member is linked to (a live ChannelIdentity, as the link of S5-04 makes) */
const lineUserOf: Record<string, string> = {}

async function link(code: string, lineUserId = newLineUserId()) {
  await prisma.channelIdentity.create({ data: { organizationId: org.organizationId, memberId: org.member[code]!, channel: 'LINE', providerKey: PROVIDER, externalUserId: lineUserId, linkedAt: NOW } })
  lineUserOf[code] = lineUserId
}

beforeAll(async () => {
  inngestBefore = getDefaultOutboxSender()
  setDefaultOutboxSender(async (messages) => {
    toInngest.push(...messages)
  })
  org = await createDoaOrg()
  budgetLineId = await p2p(org, NOW).fundedLine(5_000_000n)
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
  channelKey = ok(await saveLineChannelSettings(org.ctxOf('admin', NOW), { ...CHANNEL, active: true }, key())).channelKey
  for (const code of ['dm_con', 'vp_ops', 'ceo']) await link(code)
})
afterAll(() => setDefaultOutboxSender(inngestBefore))

/** A submitted request of `net` baht before VAT (quotations as ATT-QUOTES asks above 100,000), its open task and tokens */
async function submitted(net = '10000.00') {
  const draft = ok(await createDraft(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'วัสดุสำนักงาน', budgetLineId, lines: [{ description: 'กระดาษถ่ายเอกสาร A4', quantity: '1', uom: 'รีม', unitPrice: net }] }, key()))
  for (let i = 0; i < 3; i++) {
    const file = await prisma.fileObject.create({ data: { organizationId: org.organizationId, storageKey: `test/${randomUUID()}.pdf`, fileName: 'ใบเสนอราคา.pdf', mimeType: 'application/pdf', sizeBytes: 1, status: 'AVAILABLE', uploadedById: org.member.req_con! } })
    await prisma.fileLink.create({ data: { organizationId: org.organizationId, fileId: file.id, subjectType: 'Request', subjectId: draft.requestId, kind: 'QUOTATION' } })
  }
  ok(await submitRequest(org.ctxOf('req_con', NOW), { requestId: draft.requestId }, key()))
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: draft.requestId } } } })
  const lineToken = await prisma.actionToken.findFirst({ where: { taskId: task.id, channel: 'LINE' } })
  const request = await prisma.request.findUniqueOrThrow({ where: { id: draft.requestId } })
  return { requestId: draft.requestId, number: request.number!, task, lineToken }
}

const approveData = (tokenId: string) => `v=1&a=approve&k=${tokenId}`

/**
 * A postback of this LINE user as LINE delivers it to the webhook (of this file's organization, or of `target`),
 * processed inline; what LINE got back from the app
 */
async function tap(lineUserId: string, data: string, at: Date = LATER, replyToken?: string, target: { readonly organizationId: string; readonly channelKey: string } = { organizationId: org.organizationId, channelKey }) {
  const event = lineEvents.postback({ userId: lineUserId, data, timestamp: at.getTime(), ...(replyToken ? { replyToken } : {}) })
  const { body } = buildLineWebhook([event])
  const answer = await receiveLineWebhook({ channelKey: target.channelKey, rawBody: new TextEncoder().encode(body), signature: signLineWebhook(TEST_CHANNEL_SECRET, body) }, { now: at, budgetMs: 30_000, sender: null })
  const row = await prisma.lineWebhookEvent.findUniqueOrThrow({ where: { organizationId_webhookEventId: { organizationId: target.organizationId, webhookEventId: event.webhookEventId } } })
  const replies = line.fake.messages().filter((m) => m.kind === 'reply' && m.replyToken === event.replyToken)
  const pushes = line.fake.messages().filter((m) => m.kind === 'push' && m.retryKey === row.id)
  return { event, answer, row, replies, pushes }
}

/** The text of a text message, or every text of a Flex card */
function textOf(message: Record<string, unknown>): string {
  if (message.type === 'text') return message.text as string
  const out: string[] = []
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk)
    else if (value && typeof value === 'object') {
      const node = value as Record<string, unknown>
      if (node.type === 'text' && typeof node.text === 'string') out.push(node.text)
      Object.values(node).forEach(walk)
    }
  }
  walk(message.contents)
  return out.join('\n')
}

const decidedEvents = (taskId: string) => prisma.event.findMany({ where: { type: 'approval_task.decided', aggregateId: taskId } })
const misuse = (tokenId: string) => prisma.event.findMany({ where: { type: 'security.token_misuse', aggregateId: tokenId } })

describe('[FR-LINE-002/AC2] an approver linked to LINE gets a LINE token with the task, beside the e-mail token (BR-TOK-01, BR-TOK-02)', () => {
  it('issues one LINE token for 72 hours that can only approve and holds no secret, beside the e-mail token', async () => {
    const { task, lineToken } = await submitted()
    expect(task.assigneeMemberId).toBe(org.member.dm_con)
    expect(lineToken).toMatchObject({ memberId: org.member.dm_con, channel: 'LINE', allowedActions: ['APPROVE'], secretHash: null, usedAt: null, revokedAt: null })
    expect(lineToken!.expiresAt.getTime() - NOW.getTime()).toBe(HOURS_72)
    expect(await prisma.actionToken.count({ where: { taskId: task.id, channel: 'EMAIL' } })).toBe(1)
    expect(await prisma.actionToken.count({ where: { taskId: task.id } })).toBe(2)
  })

  it('a decision anywhere revokes the LINE token with the task, and the action registry knows `approve`', async () => {
    const { task, lineToken } = await submitted()
    ok(await decideTask(org.ctxOf('dm_con', NOW), { taskId: task.id, decision: 'APPROVE' }, key()))
    expect(await prisma.actionToken.findUniqueOrThrow({ where: { id: lineToken!.id } })).toMatchObject({ revokedAt: NOW, usedAt: null })
    expect(linePostbackActions()).toContain('approve')
  })

  it('issues the e-mail token only for a link made under another provider, and while the organization\'s channel is switched off', async () => {
    const other = await createDoaOrg()
    const otherLine = await p2p(other, NOW).fundedLine(1_000_000n)
    await prisma.roleAssignment.create({ data: { organizationId: other.organizationId, memberId: other.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
    ok(await saveLineChannelSettings(other.ctxOf('admin', NOW), { ...CHANNEL, active: true }, key()))
    const submitOther = async () => {
      const draft = ok(await createDraft(other.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'วัสดุ', budgetLineId: otherLine, lines: [{ description: 'ปากกา', quantity: '1', uom: 'กล่อง', unitPrice: '1000.00' }] }, key()))
      ok(await submitRequest(other.ctxOf('req_con', NOW), { requestId: draft.requestId }, key()))
      const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: draft.requestId } } } })
      expect(task.assigneeMemberId).toBe(other.member.dm_con)
      return prisma.actionToken.findMany({ where: { taskId: task.id }, select: { channel: true } })
    }
    // LINE user ids differ per provider (§9.2): a link under another provider is not a link of this channel
    const elsewhere = await prisma.channelIdentity.create({ data: { organizationId: other.organizationId, memberId: other.member.dm_con!, channel: 'LINE', providerKey: 'another-provider', externalUserId: newLineUserId(), linkedAt: NOW } })
    expect(await submitOther()).toEqual([{ channel: 'EMAIL' }])
    // Linked under the channel's provider, but LINE is switched off in the organization
    await prisma.channelIdentity.update({ where: { id: elsewhere.id }, data: { unlinkedAt: NOW } })
    await prisma.channelIdentity.create({ data: { organizationId: other.organizationId, memberId: other.member.dm_con!, channel: 'LINE', providerKey: PROVIDER, externalUserId: newLineUserId(), linkedAt: NOW } })
    await prisma.lineChannelConfig.updateMany({ where: { organizationId: other.organizationId }, data: { active: false } })
    expect(await submitOther()).toEqual([{ channel: 'EMAIL' }])
    // Switched on again: the LINE token comes back with the next task
    await prisma.lineChannelConfig.updateMany({ where: { organizationId: other.organizationId }, data: { active: true } })
    expect((await submitOther()).map((t) => t.channel).sort()).toEqual(['EMAIL', 'LINE'])
  })
})

describe('[FR-LINE-002/AC2] tapping "อนุมัติ" on the card decides the task below stepUpThreshold, with a confirmation card and channel LINE_CHAT', () => {
  it('the card delivered to the approver approves in the chat: decided on LINE_CHAT, answered by the reply token with the DOA reference', async () => {
    const { requestId, number, task, lineToken } = await submitted()
    const notice = await prisma.notification.findFirstOrThrow({ where: { templateKey: 'task.assigned', recipientMemberId: org.member.dm_con, data: { path: ['taskId'], equals: task.id } } })
    expect(await deliverNotification(org.organizationId, notice.id, NOW, { openChannel: openLineChannel })).toEqual({ status: 'SENT', channel: 'LINE' })
    // The button of the card that LINE shows the approver
    const card = line.fake.messages().find((m) => m.kind === 'push' && m.retryKey === notice.id)!
    const buttons = JSON.stringify(card.messages[0])
    expect(buttons).toContain(`"data":"${approveData(lineToken!.id)}"`)
    expect(buttons).toContain(`"displayText":"อนุมัติ ${number}"`)

    const { answer, row, replies, pushes } = await tap(lineUserOf.dm_con!, approveData(lineToken!.id))
    expect(answer).toMatchObject({ status: 200, inline: 1, queued: 0 })
    expect(row).toMatchObject({ status: 'PROCESSED', error: null })
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'APPROVED', decision: 'APPROVE', channel: 'LINE_CHAT', decidedByMemberId: org.member.dm_con })
    expect(await prisma.request.findUniqueOrThrow({ where: { id: requestId } })).toMatchObject({ status: 'APPROVED' })
    // Used at the moment of the tap (the webhook's clock started at LATER and runs on)
    const usedAt = (await prisma.actionToken.findUniqueOrThrow({ where: { id: lineToken!.id } })).usedAt!
    expect(usedAt.getTime() - LATER.getTime()).toBeGreaterThanOrEqual(0)
    expect(usedAt.getTime() - LATER.getTime()).toBeLessThan(MS_PER_MINUTE)
    const [decided, ...more] = await decidedEvents(task.id)
    expect(more).toEqual([])
    expect(decided).toMatchObject({ channel: 'LINE_CHAT', actorType: 'USER', actorMemberId: org.member.dm_con, doaRuleCode: 'PR-01', data: expect.objectContaining({ channel: 'LINE_CHAT', decision: 'APPROVE' }) })

    // FR-LINE-007 AC2: answered with the reply token (free), nothing pushed
    expect(pushes).toEqual([])
    expect(replies).toHaveLength(1)
    const confirmation = replies[0]!.messages[0]!
    expect(confirmation.type).toBe('flex')
    expect(textOf(confirmation)).toBe(['อนุมัติแล้ว', `ซื้อของ ${number}`, 'อนุมัติภายใต้ DOA-DEMO ฉบับ 1 ข้อ PR-01', 'เมื่อ 6 ต.ค. 2569 09:01 น.', 'อนุมัติครบทุกขั้นแล้ว'].join('\n'))
    expect(JSON.stringify(confirmation)).toContain(`${LIFF}/requests/${requestId}`)
  })
})

describe('[FR-LINE-002/AC2] the tap reaches the decision through the webhook route itself, as LINE delivers it', () => {
  it('a postback POSTed to /api/webhooks/line/<channelKey> with LINE\'s signature approves on LINE_CHAT and is answered by reply', async () => {
    const { task, lineToken } = await submitted()
    // The route runs on real time: the button is given 72 hours from now
    await prisma.actionToken.update({ where: { id: lineToken!.id }, data: { expiresAt: new Date(Date.now() + HOURS_72) } })
    const event = lineEvents.postback({ userId: lineUserOf.dm_con!, data: approveData(lineToken!.id) })
    const { body } = buildLineWebhook([event])
    const response = await POST(
      new Request(`http://localhost:3000/api/webhooks/line/${channelKey}`, { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8', 'x-line-signature': signLineWebhook(TEST_CHANNEL_SECRET, body) }, body }),
      { params: Promise.resolve({ channelKey }) },
    )
    expect(response.status).toBe(200)
    // Processed inline, or right after the answer when the machine is slow
    let row = await prisma.lineWebhookEvent.findUniqueOrThrow({ where: { organizationId_webhookEventId: { organizationId: org.organizationId, webhookEventId: event.webhookEventId } } })
    for (let i = 0; i < 100 && row.status !== 'PROCESSED'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      row = await prisma.lineWebhookEvent.findUniqueOrThrow({ where: { id: row.id } })
    }
    expect(row).toMatchObject({ status: 'PROCESSED', error: null })
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'APPROVED', channel: 'LINE_CHAT' })
    expect(line.fake.messages().filter((m) => m.kind === 'reply' && m.replyToken === event.replyToken).map((m) => textOf(m.messages[0]!).split('\n')[0])).toEqual(['อนุมัติแล้ว'])
  })
})

describe('[FR-DOA-005/AC1] the decision made in the chat names its DOA version and rule, the channel, the actor and whom they act for', () => {
  it('records approval_task.decided with doaVersionId, doaRuleCode, LINE_CHAT, the actor and no onBehalfOf', async () => {
    // 30,000.00 before VAT is 32,100.00 on the DOA's GROSS basis: rule PR-02, the VP of the requester's line
    const { task, lineToken } = await submitted('30000.00')
    expect(task.assigneeMemberId).toBe(org.member.vp_ops)
    expect(lineToken?.memberId).toBe(org.member.vp_ops)
    await tap(lineUserOf.vp_ops!, approveData(lineToken!.id))
    const route = await prisma.approvalRoute.findFirstOrThrow({ where: { steps: { some: { id: task.stepId } } } })
    const [event] = await decidedEvents(task.id)
    expect(event).toMatchObject({ doaVersionId: route.doaVersionId, doaRuleCode: 'PR-02', channel: 'LINE_CHAT', actorMemberId: org.member.vp_ops, onBehalfOfMemberId: null })
    expect(event!.data).toMatchObject({ doaVersionId: route.doaVersionId, doaRuleCode: 'PR-02', channel: 'LINE_CHAT', actorMemberId: org.member.vp_ops, onBehalfOfMemberId: null })
  })

  it('a delegate approving from their card: the delegate is the actor and the delegator is onBehalfOf, and the card said "รักษาการแทน" (BR-DLG-04)', async () => {
    // An organization of its own: a running delegation sends every new task of the DM to the delegate
    const other = await createDoaOrg()
    await prisma.roleAssignment.create({ data: { organizationId: other.organizationId, memberId: other.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
    const otherKey = ok(await saveLineChannelSettings(other.ctxOf('admin', NOW), { ...CHANNEL, active: true }, key())).channelKey
    const delegate = newLineUserId()
    await prisma.channelIdentity.create({ data: { organizationId: other.organizationId, memberId: other.member.asst_con!, channel: 'LINE', providerKey: PROVIDER, externalUserId: delegate, linkedAt: NOW } })
    ok(await createDelegation(other.ctxOf('dm_con', NOW), { delegateMemberId: other.member.asst_con!, startsAt: '2026-10-05T00:00:00+07:00', endsAt: '2026-10-10T00:00:00+07:00', reason: 'ลาพักร้อน' }, key()))
    const otherLine = await p2p(other, NOW).fundedLine(1_000_000n)
    const draft = ok(await createDraft(other.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'วัสดุ', budgetLineId: otherLine, lines: [{ description: 'ปากกา', quantity: '1', uom: 'กล่อง', unitPrice: '1000.00' }] }, key()))
    ok(await submitRequest(other.ctxOf('req_con', NOW), { requestId: draft.requestId }, key()))
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: draft.requestId } } }, include: { step: { include: { route: true } } } })
    expect(task).toMatchObject({ assigneeMemberId: other.member.asst_con, principalMemberId: other.member.dm_con })
    // The delegate holds the task, so the LINE button is theirs (BR-TOK-01)
    const lineToken = await prisma.actionToken.findFirstOrThrow({ where: { taskId: task.id, channel: 'LINE' } })
    expect(lineToken.memberId).toBe(other.member.asst_con)
    const notice = await prisma.notification.findFirstOrThrow({ where: { templateKey: 'task.assigned', recipientMemberId: other.member.asst_con, data: { path: ['taskId'], equals: task.id } } })
    expect(await deliverNotification(other.organizationId, notice.id, NOW, { openChannel: openLineChannel })).toEqual({ status: 'SENT', channel: 'LINE' })
    const card = line.fake.messages().find((m) => m.kind === 'push' && m.retryKey === notice.id)!
    expect(card.to).toBe(delegate)
    expect(textOf(card.messages[0]!).split('\n').slice(0, 2)).toEqual(['โปรดพิจารณาอนุมัติ', 'รักษาการแทน'])

    const { row, replies } = await tap(delegate, approveData(lineToken.id), LATER, undefined, { organizationId: other.organizationId, channelKey: otherKey })
    expect(row).toMatchObject({ status: 'PROCESSED', error: null })
    expect(textOf(replies[0]!.messages[0]!).split('\n')[0]).toBe('อนุมัติแล้ว')
    const [event, ...more] = await decidedEvents(task.id)
    expect(more).toEqual([])
    const doa = { doaVersionId: task.step.route.doaVersionId, doaRuleCode: 'PR-01' }
    expect(event).toMatchObject({ ...doa, channel: 'LINE_CHAT', actorType: 'USER', actorMemberId: other.member.asst_con, onBehalfOfMemberId: other.member.dm_con })
    expect(event!.data).toMatchObject({ ...doa, channel: 'LINE_CHAT', decision: 'APPROVE', actorMemberId: other.member.asst_con, onBehalfOfMemberId: other.member.dm_con })
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'APPROVED', channel: 'LINE_CHAT', decidedByMemberId: other.member.asst_con })
  })
})

describe('[FR-LINE-002/AC3] tapping again, after the button expired or from another account is answered TOKEN_USED, TOKEN_EXPIRED or FORBIDDEN, and decides nothing again (INV-TOK-01)', () => {
  it('a second tap of the same button says who decided and when; there is still one decision', async () => {
    const { task, lineToken } = await submitted()
    await tap(lineUserOf.dm_con!, approveData(lineToken!.id))
    const again = await tap(lineUserOf.dm_con!, approveData(lineToken!.id), new Date(LATER.getTime() + MS_PER_MINUTE))
    expect(again.row).toMatchObject({ status: 'PROCESSED', error: 'TOKEN_USED' })
    expect(again.replies.map((r) => textOf(r.messages[0]!))).toEqual([`รายการนี้ดำเนินการแล้วโดย ผู้ใช้ dm_con เมื่อ 6 ต.ค. 2569 09:01 น.\n${LIFF}/tasks/${task.id}`])
    expect(await decidedEvents(task.id)).toHaveLength(1)
  })

  it('a task decided in the workspace first: the button answers who decided it there and when', async () => {
    const { task, lineToken } = await submitted()
    ok(await decideTask(org.ctxOf('dm_con', NOW), { taskId: task.id, decision: 'APPROVE' }, key()))
    const { row, replies } = await tap(lineUserOf.dm_con!, approveData(lineToken!.id))
    expect(row).toMatchObject({ status: 'PROCESSED', error: 'TOKEN_USED' })
    expect(textOf(replies[0]!.messages[0]!)).toBe(`รายการนี้ดำเนินการแล้วโดย ผู้ใช้ dm_con เมื่อ 6 ต.ค. 2569 09:00 น.\n${LIFF}/tasks/${task.id}`)
    expect(await decidedEvents(task.id)).toHaveLength(1)
  })

  it('two taps at once decide once: one is decided, the other refused TOKEN_USED', async () => {
    const { task, lineToken } = await submitted()
    const ctx = makeCtx({ organizationId: org.organizationId, actor: { type: 'USER', memberId: org.member.dm_con! }, channel: 'LINE_CHAT', now: LATER })
    const results = await Promise.all([decideByLinePostback(ctx, { tokenId: lineToken!.id }, key()), decideByLinePostback(ctx, { tokenId: lineToken!.id }, key())])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.find((r) => !r.ok)).toMatchObject({ ok: false, error: { code: 'TOKEN_USED' } })
    expect(await decidedEvents(task.id)).toHaveLength(1)
  })

  it('a tap and the e-mail link POSTed at the same moment decide once; when the two deadlock, Postgres breaks it and the loser is run again', async () => {
    // The e-mail link uses its token before it locks the task, the tap locks the task first: they can deadlock
    for (let round = 0; round < 3; round++) {
      const { task, lineToken } = await submitted()
      const emailToken = await prisma.actionToken.findFirstOrThrow({ where: { taskId: task.id, channel: 'EMAIL' } })
      const lineCtx = makeCtx({ organizationId: org.organizationId, actor: { type: 'USER', memberId: org.member.dm_con! }, channel: 'LINE_CHAT', now: LATER })
      const results = await Promise.all([
        decideByLinePostback(lineCtx, { tokenId: lineToken!.id }, key()),
        decideByActionLink(org.ctxOf('dm_con', LATER, 'EMAIL'), { link: `${emailToken.id}.${emailLinkSecret(emailToken.id)}`, decision: 'APPROVE' }, key()),
      ])
      expect(results.filter((r) => r.ok)).toHaveLength(1)
      // The tap that lost finds the task decided (TOKEN_USED); the link that lost finds its token revoked with it
      expect(results.find((r) => !r.ok)).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^TOKEN_(USED|INVALID)$/) } })
      expect(await decidedEvents(task.id)).toHaveLength(1)
      expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'APPROVED' })
    }
  })

  it('the co-assignee\'s button, once the first approver has decided, says who decided and when (BR-SLA-04: whoever decides first decides)', async () => {
    const { task, lineToken } = await submitted()
    // Past escalateAt the approver of the band above joins the step, with a LINE button of their own (BR-TOK-01)
    const escalated = await escalateTask(org.organizationId, task.id, THU_0900)
    expect(escalated).toMatchObject({ done: true, outcome: 'CO_ASSIGNED' })
    const coTask = await prisma.approvalTask.findUniqueOrThrow({ where: { id: escalated.coAssigneeTaskId! } })
    expect(coTask.assigneeMemberId).toBe(org.member.vp_ops)
    const coToken = await prisma.actionToken.findFirstOrThrow({ where: { taskId: coTask.id, channel: 'LINE' } })
    expect(coToken.memberId).toBe(org.member.vp_ops)

    // The first approver decides from their own card: the co-assignee's task is cancelled and its button revoked
    const first = await tap(lineUserOf.dm_con!, approveData(lineToken!.id), new Date(THU_0900.getTime() + 5 * MS_PER_MINUTE))
    expect(first.row).toMatchObject({ status: 'PROCESSED', error: null })
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: coTask.id } })).toMatchObject({ status: 'CANCELLED', decidedAt: null })
    expect((await prisma.actionToken.findUniqueOrThrow({ where: { id: coToken.id } })).revokedAt).not.toBeNull()

    const { row, replies } = await tap(lineUserOf.vp_ops!, approveData(coToken.id), new Date(THU_0900.getTime() + 10 * MS_PER_MINUTE))
    expect(row).toMatchObject({ status: 'PROCESSED', error: 'TOKEN_USED' })
    expect(replies.map((r) => textOf(r.messages[0]!))).toEqual([`รายการนี้ดำเนินการแล้วโดย ผู้ใช้ dm_con เมื่อ 8 ต.ค. 2569 09:05 น.\n${LIFF}/tasks/${coTask.id}`])
    expect(await decidedEvents(task.id)).toHaveLength(1)
    expect(await decidedEvents(coTask.id)).toEqual([])
  })

  it('the delegator\'s old button, once the task moved to the delegate who decided it, says who decided and when', async () => {
    // An organization of its own: the delegation moves the DM's open tasks when it starts
    const other = await createDoaOrg()
    await prisma.roleAssignment.create({ data: { organizationId: other.organizationId, memberId: other.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
    const target = { organizationId: other.organizationId, channelKey: ok(await saveLineChannelSettings(other.ctxOf('admin', NOW), { ...CHANNEL, active: true }, key())).channelKey }
    const delegator = newLineUserId()
    await prisma.channelIdentity.create({ data: { organizationId: other.organizationId, memberId: other.member.dm_con!, channel: 'LINE', providerKey: PROVIDER, externalUserId: delegator, linkedAt: NOW } })
    const otherLine = await p2p(other, NOW).fundedLine(1_000_000n)
    const draft = ok(await createDraft(other.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'วัสดุ', budgetLineId: otherLine, lines: [{ description: 'ปากกา', quantity: '1', uom: 'กล่อง', unitPrice: '1000.00' }] }, key()))
    ok(await submitRequest(other.ctxOf('req_con', NOW), { requestId: draft.requestId }, key()))
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: draft.requestId } } } })
    expect(task.assigneeMemberId).toBe(other.member.dm_con)
    const lineToken = await prisma.actionToken.findFirstOrThrow({ where: { taskId: task.id, channel: 'LINE' } })
    // The delegation starts half an hour later: the open task moves to the delegate (REASSIGNED), who decides it
    const startsAt = new Date(NOW.getTime() + 30 * MS_PER_MINUTE)
    const { delegationId } = ok(await createDelegation(other.ctxOf('dm_con', NOW), { delegateMemberId: other.member.asst_con!, startsAt: startsAt.toISOString(), endsAt: '2026-10-10T00:00:00+07:00', reason: 'ประชุมต่างจังหวัด' }, key()))
    expect(await startDelegationWindow(other.organizationId, delegationId, startsAt)).toEqual({ done: true, movedTasks: 1 })
    const moved = await prisma.approvalTask.findFirstOrThrow({ where: { reassignedFromTaskId: task.id } })
    expect(moved).toMatchObject({ status: 'OPEN', assigneeMemberId: other.member.asst_con, principalMemberId: other.member.dm_con })
    ok(await decideTask(other.ctxOf('asst_con', new Date(NOW.getTime() + 40 * MS_PER_MINUTE)), { taskId: moved.id, decision: 'APPROVE' }, key()))

    const { row, replies } = await tap(delegator, approveData(lineToken.id), new Date(NOW.getTime() + 50 * MS_PER_MINUTE), undefined, target)
    expect(row).toMatchObject({ status: 'PROCESSED', error: 'TOKEN_USED' })
    expect(replies.map((r) => textOf(r.messages[0]!))).toEqual([`รายการนี้ดำเนินการแล้วโดย ผู้ใช้ asst_con เมื่อ 6 ต.ค. 2569 09:40 น.\n${LIFF}/tasks/${task.id}`])
    expect(await decidedEvents(task.id)).toEqual([])
    expect(await decidedEvents(moved.id)).toHaveLength(1)
  })

  it('a co-assignee whose step was returned hears TOKEN_USED too; a button whose request was cancelled, with nothing decided, answers TOKEN_INVALID', async () => {
    const returned = await submitted()
    const escalated = await escalateTask(org.organizationId, returned.task.id, THU_0900)
    const coToken = await prisma.actionToken.findFirstOrThrow({ where: { taskId: escalated.coAssigneeTaskId!, channel: 'LINE' } })
    // A return decides the step too: the co-assignee's button has nothing left to do
    ok(await decideTask(org.ctxOf('dm_con', new Date(THU_0900.getTime() + 5 * MS_PER_MINUTE)), { taskId: returned.task.id, decision: 'RETURN', reason: 'ขอใบเสนอราคาใหม่' }, key()))
    const afterReturn = await tap(lineUserOf.vp_ops!, approveData(coToken.id), new Date(THU_0900.getTime() + 10 * MS_PER_MINUTE))
    expect(afterReturn.row).toMatchObject({ status: 'PROCESSED', error: 'TOKEN_USED' })
    expect(textOf(afterReturn.replies[0]!.messages[0]!).split('\n')[0]).toBe('รายการนี้ดำเนินการแล้วโดย ผู้ใช้ dm_con เมื่อ 8 ต.ค. 2569 09:05 น.')
    expect(await decidedEvents(escalated.coAssigneeTaskId!)).toEqual([])

    // The requester cancels a request: its task is cancelled and nothing on the step was decided
    const cancelled = await submitted()
    ok(await cancelRequest(org.ctxOf('req_con', NOW), { requestId: cancelled.requestId }, key()))
    const { row, replies } = await tap(lineUserOf.dm_con!, approveData(cancelled.lineToken!.id))
    expect(row).toMatchObject({ status: 'PROCESSED', error: 'TOKEN_INVALID' })
    expect(textOf(replies[0]!.messages[0]!)).toBe(`ปุ่มนี้ใช้ไม่ได้แล้ว งานนี้อาจย้ายไปผู้อื่นหรือถูกยกเลิก\n${LIFF}/tasks`)
    expect(await decidedEvents(cancelled.task.id)).toEqual([])
  })

  it('after 72 hours the button has expired: TOKEN_EXPIRED with the link to decide in LIFF, and the task stays open', async () => {
    const { task, lineToken } = await submitted()
    const { row, replies } = await tap(lineUserOf.dm_con!, approveData(lineToken!.id), new Date(NOW.getTime() + HOURS_72))
    expect(row).toMatchObject({ status: 'PROCESSED', error: 'TOKEN_EXPIRED' })
    expect(textOf(replies[0]!.messages[0]!)).toBe(`ปุ่มนี้หมดอายุแล้ว โปรดเปิดรายการเพื่อพิจารณา\n${LIFF}/tasks/${task.id}`)
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'OPEN' })
    expect(await prisma.actionToken.findUniqueOrThrow({ where: { id: lineToken!.id } })).toMatchObject({ usedAt: null })
  })

  it('another linked member tapping the card is refused FORBIDDEN and kept as security.token_misuse (BR-TOK-02)', async () => {
    const { task, lineToken } = await submitted()
    const { row, replies } = await tap(lineUserOf.vp_ops!, approveData(lineToken!.id))
    expect(row).toMatchObject({ status: 'PROCESSED', error: 'FORBIDDEN' })
    // The answer names nothing of the task: the tapper is not the person it was sent to
    expect(textOf(replies[0]!.messages[0]!)).toBe(`ปุ่มนี้ใช้ได้เฉพาะผู้ที่ได้รับงาน จากบัญชี LINE ที่ผูกไว้\n${LIFF}/tasks`)
    expect(await misuse(lineToken!.id)).toEqual([expect.objectContaining({ actorType: 'USER', actorMemberId: org.member.vp_ops, channel: 'LINE_CHAT', data: { tokenId: lineToken!.id, channel: 'LINE', taskId: task.id, actorMemberId: org.member.vp_ops } })])
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'OPEN' })
    expect(await prisma.actionToken.findUniqueOrThrow({ where: { id: lineToken!.id } })).toMatchObject({ usedAt: null })
  })

  it('a LINE user linked to nobody is refused FORBIDDEN by reply only, kept as security.token_misuse without a member', async () => {
    const { task, lineToken } = await submitted()
    const stranger = newLineUserId()
    const { row, replies } = await tap(stranger, approveData(lineToken!.id))
    expect(row).toMatchObject({ status: 'PROCESSED', error: 'FORBIDDEN' })
    expect(textOf(replies[0]!.messages[0]!)).toBe(`ปุ่มนี้ใช้ได้เฉพาะผู้ที่ได้รับงาน จากบัญชี LINE ที่ผูกไว้\n${LIFF}/link`)
    expect(await misuse(lineToken!.id)).toEqual([expect.objectContaining({ actorType: 'SYSTEM', actorMemberId: null, data: expect.objectContaining({ actorMemberId: null, channel: 'LINE' }) })])
    expect(await decidedEvents(task.id)).toEqual([])
    // Past the reply token's minute nobody is pushed to: a stranger gets no answer that counts against the quota
    const queued = await receiveLater(stranger, approveData(lineToken!.id))
    expect(queued.row).toMatchObject({ status: 'PROCESSED', error: 'FORBIDDEN,NOT_ANSWERED' })
    expect(queued.pushes).toEqual([])
    expect(line.fake.messages().filter((m) => m.to === stranger)).toEqual([])
  })

  it('data that is not exactly v=1&a=approve&k=<tokenId>, an e-mail token\'s id or an unknown id decides nothing', async () => {
    const { task, lineToken } = await submitted()
    const email = await prisma.actionToken.findFirstOrThrow({ where: { taskId: task.id, channel: 'EMAIL' } })
    for (const data of [`v=1&a=approve&k=${lineToken!.id}&n=1`, 'v=1&a=approve', 'v=1&a=approve&k=not-a-token']) {
      expect((await tap(lineUserOf.dm_con!, data)).row).toMatchObject({ status: 'SKIPPED', error: 'POSTBACK_INVALID' })
    }
    for (const tokenId of [email.id, randomUUID()]) {
      const { row, replies } = await tap(lineUserOf.dm_con!, approveData(tokenId))
      expect(row).toMatchObject({ status: 'PROCESSED', error: 'TOKEN_INVALID' })
      expect(textOf(replies[0]!.messages[0]!)).toBe(`ปุ่มนี้ใช้ไม่ได้แล้ว งานนี้อาจย้ายไปผู้อื่นหรือถูกยกเลิก\n${LIFF}/tasks`)
    }
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'OPEN' })
    expect(await prisma.actionToken.findUniqueOrThrow({ where: { id: email.id } })).toMatchObject({ usedAt: null })
  })

  it('a task waiting for the requester\'s answer is not approved from the chat, and the button stays usable afterwards', async () => {
    const { task, lineToken } = await submitted()
    ok(await requestInfo(org.ctxOf('dm_con', NOW), { taskId: task.id, question: 'ขอใบเสนอราคาเพิ่ม' }, key()))
    const { row, replies } = await tap(lineUserOf.dm_con!, approveData(lineToken!.id))
    expect(row).toMatchObject({ status: 'PROCESSED', error: 'INVALID_STATE_TRANSITION' })
    expect(textOf(replies[0]!.messages[0]!)).toBe(`รายการนี้ไม่อยู่ในสถานะที่อนุมัติได้แล้ว\n${LIFF}/tasks/${task.id}`)
    // The refusal rolled the token's use back with it
    expect(await prisma.actionToken.findUniqueOrThrow({ where: { id: lineToken!.id } })).toMatchObject({ usedAt: null, revokedAt: null })
    expect(await decidedEvents(task.id)).toEqual([])
  })

  it('a LINE token that may not approve decides nothing and stays as it was', async () => {
    const { task, lineToken } = await submitted()
    await prisma.actionToken.update({ where: { id: lineToken!.id }, data: { allowedActions: [] } })
    const { row, replies } = await tap(lineUserOf.dm_con!, approveData(lineToken!.id))
    expect(row).toMatchObject({ status: 'PROCESSED', error: 'VALIDATION_FAILED' })
    expect(textOf(replies[0]!.messages[0]!)).toBe(`ตัดสินรายการนี้ในแชทไม่ได้ โปรดเปิดรายการเพื่อดูรายละเอียด\n${LIFF}/tasks/${task.id}`)
    expect(await prisma.actionToken.findUniqueOrThrow({ where: { id: lineToken!.id } })).toMatchObject({ usedAt: null })
    expect(await decidedEvents(task.id)).toEqual([])
  })

  it('a decision through the LINE command must be on the LINE_CHAT channel', async () => {
    const { lineToken } = await submitted()
    expect(await decideByLinePostback(org.ctxOf('dm_con', LATER), { tokenId: lineToken!.id }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'channel' } } })
  })
})

describe('[FR-LINE-002/AC2] at or above stepUpThreshold, and for every policy task, the chat does not approve: the server refuses again (BR-TOK-05)', () => {
  it('a postback for a task of 107,000.00 baht is refused STEP_UP_REQUIRED with the LIFF page to approve with the PIN', async () => {
    const { task, lineToken } = await submitted('100000.00')
    expect(task.assigneeMemberId).toBe(org.member.ceo)
    // The card the CEO gets has no button that approves in the chat
    const notice = await prisma.notification.findFirstOrThrow({ where: { templateKey: 'task.assigned', data: { path: ['taskId'], equals: task.id } } })
    expect(await deliverNotification(org.organizationId, notice.id, NOW, { openChannel: openLineChannel })).toEqual({ status: 'SENT', channel: 'LINE' })
    const card = JSON.stringify(line.fake.messages().find((m) => m.retryKey === notice.id)!.messages)
    expect(card).not.toContain('"type":"postback"')
    expect(card).toContain(`"label":"อนุมัติ (ยืนยัน PIN)","uri":"${LIFF}/tasks/${task.id}?action=approve"`)
    // Someone who knows the token id sends the postback anyway
    const { row, replies } = await tap(lineUserOf.ceo!, approveData(lineToken!.id))
    expect(row).toMatchObject({ status: 'PROCESSED', error: 'STEP_UP_REQUIRED' })
    expect(textOf(replies[0]!.messages[0]!)).toBe(`รายการนี้ต้องยืนยันด้วย PIN โปรดเปิดรายการเพื่อยืนยัน\n${LIFF}/tasks/${task.id}?action=approve`)
    expect(await prisma.actionToken.findUniqueOrThrow({ where: { id: lineToken!.id } })).toMatchObject({ usedAt: null })
    expect(await decidedEvents(task.id)).toEqual([])
  })

  it('a DOA version task is refused STEP_UP_REQUIRED whatever its amount', async () => {
    const version = await prisma.doaVersion.findFirstOrThrow({ where: { organizationId: org.organizationId } })
    const route = await prisma.approvalRoute.create({
      data: { organizationId: org.organizationId, subjectType: 'DOA_VERSION', subjectId: version.id, routeNo: 99, doaVersionId: version.id, ruleCode: 'DOA-CHG-01', amountBasis: 'GROSS', amountSatang: null, explanationTh: 'ทดสอบ' },
    })
    const step = await prisma.approvalStep.create({ data: { organizationId: org.organizationId, routeId: route.id, stepNo: 1, slaBusinessMinutes: 480, status: 'ACTIVE' } })
    const task = await prisma.approvalTask.create({ data: { organizationId: org.organizationId, stepId: step.id, assigneeMemberId: org.member.ceo!, resolvedFrom: 'POSITION:CEO@HQ', assignedAt: NOW, dueAt: new Date(NOW.getTime() + 8 * MS_PER_HOUR) } })
    const token = await prisma.actionToken.create({ data: { organizationId: org.organizationId, memberId: org.member.ceo!, taskId: task.id, allowedActions: ['APPROVE'], channel: 'LINE', expiresAt: new Date(NOW.getTime() + HOURS_72) } })
    const { row } = await tap(lineUserOf.ceo!, approveData(token.id))
    expect(row).toMatchObject({ status: 'PROCESSED', error: 'STEP_UP_REQUIRED' })
    expect(await prisma.actionToken.findUniqueOrThrow({ where: { id: token.id } })).toMatchObject({ usedAt: null })
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'OPEN' })
  })
})

/** The same postback recorded now, but processed by the line-webhook job two minutes later (its reply token has expired) */
async function receiveLater(lineUserId: string, data: string, replyToken?: string) {
  const at = new Date(NOW.getTime() + 10 * MS_PER_MINUTE)
  const event = lineEvents.postback({ userId: lineUserId, data, timestamp: at.getTime(), ...(replyToken ? { replyToken } : {}) })
  const { body } = buildLineWebhook([event])
  const answer = await receiveLineWebhook({ channelKey, rawBody: new TextEncoder().encode(body), signature: signLineWebhook(TEST_CHANNEL_SECRET, body) }, { now: at, budgetMs: 0, sender: null })
  expect(answer).toMatchObject({ status: 200, inline: 0, queued: 1 })
  const row = await prisma.lineWebhookEvent.findUniqueOrThrow({ where: { organizationId_webhookEventId: { organizationId: org.organizationId, webhookEventId: event.webhookEventId } } })
  const job = await processQueuedLineWebhookEvents(org.organizationId, [row.id], new Date(at.getTime() + 2 * MS_PER_MINUTE))
  const after = await prisma.lineWebhookEvent.findUniqueOrThrow({ where: { id: row.id } })
  return {
    event,
    job,
    row: after,
    replies: line.fake.messages().filter((m) => m.kind === 'reply' && m.replyToken === event.replyToken),
    pushes: line.fake.messages().filter((m) => m.kind === 'push' && m.retryKey === row.id),
  }
}

describe('[FR-LINE-007/AC2] the answer goes by the reply token while it works, by a push only after (BR-LINE-07)', () => {
  it('processed by the job after the reply token\'s minute: the answer is pushed to the member once, with the event as retry key', async () => {
    const { task, lineToken } = await submitted()
    const { job, row, replies, pushes } = await receiveLater(lineUserOf.dm_con!, approveData(lineToken!.id))
    expect(job).toMatchObject({ processed: 1 })
    expect(row).toMatchObject({ status: 'PROCESSED', error: 'PUSHED' })
    expect(replies).toEqual([])
    expect(pushes).toHaveLength(1)
    expect(pushes[0]).toMatchObject({ to: lineUserOf.dm_con, retryKey: row.id })
    expect(textOf(pushes[0]!.messages[0]!)).toContain('อนุมัติแล้ว')
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'APPROVED', channel: 'LINE_CHAT' })
  })

  it('the same event run again pushes nothing new: the decision replays and LINE keeps the retry key\'s one message', async () => {
    const { lineToken, task } = await submitted()
    const first = await receiveLater(lineUserOf.dm_con!, approveData(lineToken!.id))
    // A run of the job that started before the first one finished takes the event again
    await prisma.lineWebhookEvent.update({ where: { id: first.row.id }, data: { status: 'QUEUED', processedAt: null } })
    await processQueuedLineWebhookEvents(org.organizationId, [first.row.id], new Date(NOW.getTime() + 13 * MS_PER_MINUTE))
    expect(line.fake.messages().filter((m) => m.kind === 'push' && m.retryKey === first.row.id)).toHaveLength(1)
    expect(await decidedEvents(task.id)).toHaveLength(1)
    expect(await prisma.lineWebhookEvent.findUniqueOrThrow({ where: { id: first.row.id } })).toMatchObject({ status: 'PROCESSED', error: 'PUSHED' })
  })

  it('a reply LINE refuses (a used or expired reply token) is pushed instead', async () => {
    const { lineToken } = await submitted()
    const { row, replies, pushes } = await tap(lineUserOf.dm_con!, approveData(lineToken!.id), LATER, `expired${randomUUID().replace(/-/g, '')}`)
    expect(row).toMatchObject({ status: 'PROCESSED', error: 'PUSHED' })
    expect(replies).toEqual([])
    expect(pushes).toHaveLength(1)
  })
})
